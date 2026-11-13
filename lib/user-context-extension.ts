import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { UserContext } from "./user-auth";
import { listUserSecretStatuses, readUserSecretsEnv, setUserSecret } from "./user-secrets";
import {
  createScheduledTask,
  describeSchedule,
  listScheduledTasks,
  removeScheduledTask,
  DEFAULT_TIMEZONE,
  type ScheduledTask,
} from "./scheduled-tasks";

/**
 * Per-session user identity extension (FR-5).
 *
 * One instance per session, built from the session owner's UserContext:
 * - `whoami` tool: read-only identity + assigned skills + configured secret
 *   NAMES (never values) — FR-5.2;
 * - `set_secret` tool: the user sets/removes their OWN runtime secret from
 *   inside the conversation (FR-5.5). Writes via the same `setUserSecret()`
 *   the HTTP route uses, so validation, 0600 perms and audit stay identical;
 *   there is deliberately no cross-user parameter — a session can only ever
 *   touch its own owner's agentDir.
 * - `schedule_task` / `list_scheduled_tasks` / `cancel_scheduled_task` tools:
 *   the user schedules a recurring prompt in plain language (FR-7). Same
 *   no-cross-user-parameter rule; the scheduler that executes these runs in
 *   the main process (see lib/scheduled-tasks.ts and design §14).
 * - exposes `userCommandEnvironment()` so the project command-env bash tool
 *   injects PI_USER_ID / PI_USER_NAME + the user's skill secrets into every
 *   command subprocess (FR-5.3) — bash values are merged into each command's
 *   env, never written to disk logs or the transcript.
 *
 * Secrets still never reach the model: `whoami` and `set_secret` both return
 * name + state only. A worker is one process per user, so `set_secret` may
 * safely update that worker's own `process.env` for MCP `${VAR}` resolution.
 */

const HOST_USER_CONTEXT_EXTENSION_NAME = "pi-web-user-context";
const HOST_USER_CONTEXT_EXTENSION_PATH = `<inline:${HOST_USER_CONTEXT_EXTENSION_NAME}>`;

export const USER_CONTEXT_EXTENSION_NAME = HOST_USER_CONTEXT_EXTENSION_NAME;
export const USER_CONTEXT_EXTENSION_PATH = HOST_USER_CONTEXT_EXTENSION_PATH;

/** Env injected into every bash command of sessions owned by this user. */
export function userCommandEnvironment(user: UserContext): Record<string, string> {
  return {
    PI_USER_ID: user.userId,
    PI_USER_NAME: user.username,
    ...readUserSecretsEnv(user.agentDir),
  };
}

/**
 * Mirror a secret into this worker's own `process.env`.
 *
 * A worker is one process per user, so this is per-user by construction. Bash
 * injection does not need it (`additionalEnv` re-reads secrets.json on every
 * command), but the built-in MCP extension resolves `${VAR}` from
 * `process.env` when it resolves a server definition — so this is what makes
 * a newly added key visible to MCP servers that have not connected yet.
 */
function syncWorkerSecretEnv(name: string, value: string | null): void {
  if (value === null || value === "") delete process.env[name];
  else process.env[name] = value;
}

export function createUserContextExtension(user: UserContext): InlineExtension {
  return {
    name: HOST_USER_CONTEXT_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.registerTool(
        defineTool({
          name: "set_secret",
          label: "Set secret",
          description:
            "Set or remove one of the current user's own runtime secrets (API keys, tokens) from the conversation. Writes to the caller's private secrets store; the value is never echoed back. Omit `value` (or pass an empty string) to remove the secret.",
          promptSnippet: "Store the current user's own runtime secret (never echo the value back)",
          promptGuidelines: [
            "Use set_secret only for secrets the current user explicitly asks to store; never invent or guess a secret value.",
            "Never print, echo, or repeat a secret value in your reply after calling set_secret.",
            "A secret becomes available to bash commands immediately; MCP servers that already connected need a reconnect to pick it up.",
          ],
          parameters: Type.Object({
            name: Type.String({
              description:
                "Environment-variable-safe secret name, e.g. RY_TOKEN or DM_MCP_APP_KEY.",
            }),
            value: Type.Optional(
              Type.String({
                description:
                  "Secret value. Omit or pass an empty string to remove the secret.",
              }),
            ),
          }),
          async execute(_toolCallId, params) {
            const remove = params.value === undefined || params.value === "";
            try {
              const status = await setUserSecret(
                user.agentDir,
                params.name,
                remove ? null : params.value!,
              );
              syncWorkerSecretEnv(params.name, remove ? null : params.value!);
              // Report the name + state only — mirroring whoami, the value
              // must never travel back into the transcript.
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    name: status.name,
                    configured: status.configured,
                    ...(status.updatedAt ? { updatedAt: status.updatedAt } : {}),
                  }),
                }],
                details: { userId: user.userId, secretName: status.name },
              };
            } catch (error) {
              return {
                content: [{
                  type: "text",
                  text: `Failed to set secret: ${error instanceof Error ? error.message : String(error)}`,
                }],
                details: { userId: user.userId, secretName: params.name },
                isError: true,
              };
            }
          },
        }),
      );

      pi.registerTool(
        defineTool({
          name: "schedule_task",
          label: "Schedule task",
          description:
            "Schedule a recurring or one-off task for the current user. The `prompt` is run in a fresh session at each occurrence, as if the user had typed it themselves. Supported kinds: once (needs `at`), daily, weekly (needs `weekday`), monthly (needs `day`) — the recurring kinds need `time` as HH:MM local wall-clock time.",
          promptSnippet: "Schedule a recurring or one-off task for the current user",
          promptGuidelines: [
            "Before calling schedule_task, read the schedule back to the user in plain language (e.g. 'every Friday at 09:00 Asia/Shanghai') and get confirmation. A wrong weekday or time is a silent failure that may not surface for a week.",
            "Never guess the recurrence: if the user's request is ambiguous about day or time, ask instead of picking a value.",
            "Write `prompt` as a self-contained instruction — the scheduled run starts a brand-new session with no memory of this conversation.",
            "Set `cwd` only when the task needs a specific directory; otherwise the user's default project root is used.",
          ],
          parameters: Type.Object({
            title: Type.String({ description: "Short human-readable name for the task." }),
            prompt: Type.String({
              description:
                "The instruction to run at each occurrence. Must be self-contained: the run has no context from this conversation.",
            }),
            kind: Type.Union(
              [
                Type.Literal("once"),
                Type.Literal("daily"),
                Type.Literal("weekly"),
                Type.Literal("monthly"),
              ],
              { description: "Recurrence type." },
            ),
            time: Type.Optional(
              Type.String({
                description:
                  "Local wall-clock time as HH:MM (24-hour), e.g. 09:00. Required for daily/weekly/monthly.",
              }),
            ),
            weekday: Type.Optional(
              Type.String({
                description:
                  "For kind=weekly: day of week as a name ('Friday', '周五') or 0-6 with 0=Sunday.",
              }),
            ),
            day: Type.Optional(
              Type.Number({
                description:
                  "For kind=monthly: day of month, 1-31. Values past a month's end clamp to its last day.",
              }),
            ),
            at: Type.Optional(
              Type.String({
                description: "For kind=once: ISO 8601 timestamp of the single run.",
              }),
            ),
            timezone: Type.Optional(
              Type.String({
                description: `IANA timezone, e.g. Asia/Shanghai. Defaults to ${DEFAULT_TIMEZONE}.`,
              }),
            ),
            cwd: Type.Optional(
              Type.String({ description: "Absolute working directory for the run." }),
            ),
          }),
          async execute(_toolCallId, params) {
            try {
              const timezone = params.timezone ?? DEFAULT_TIMEZONE;
              const task = await createScheduledTask(user.agentDir, {
                title: params.title,
                prompt: params.prompt,
                schedule: {
                  kind: params.kind,
                  ...(params.time !== undefined ? { time: params.time } : {}),
                  ...(params.weekday !== undefined ? { weekday: params.weekday } : {}),
                  ...(params.day !== undefined ? { day: params.day } : {}),
                  ...(params.at !== undefined ? { at: params.at } : {}),
                  timezone,
                },
                ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
                createdBy: user.username,
              });
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    id: task.id,
                    title: task.title,
                    schedule: describeSchedule(task.schedule),
                    nextRunAt: task.nextRunAt,
                    enabled: task.enabled,
                  }),
                }],
                details: { userId: user.userId, ...(task.id ? { taskId: task.id } : {}) },
              };
            } catch (error) {
              return {
                content: [{
                  type: "text",
                  text: `Failed to schedule task: ${error instanceof Error ? error.message : String(error)}`,
                }],
                details: { userId: user.userId },
                isError: true,
              };
            }
          },
        }),
      );

      pi.registerTool(
        defineTool({
          name: "list_scheduled_tasks",
          label: "List scheduled tasks",
          description:
            "List the current user's scheduled tasks with their recurrence, next run time and last run result.",
          parameters: Type.Object({}),
          promptSnippet: "List the current user's scheduled tasks.",
          async execute() {
            const tasks = listScheduledTasks(user.agentDir).map(summarizeTask);
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: true, tasks }) }],
              details: { userId: user.userId, count: tasks.length },
            };
          },
        }),
      );

      pi.registerTool(
        defineTool({
          name: "cancel_scheduled_task",
          label: "Cancel scheduled task",
          description:
            "Delete one of the current user's scheduled tasks by id. Use list_scheduled_tasks first if the id is unknown.",
          parameters: Type.Object({
            id: Type.String({ description: "Task id, e.g. st_0123456789ab." }),
          }),
          promptSnippet: "Cancel one of the current user's scheduled tasks by id",
          async execute(_toolCallId, params) {
            const removed = await removeScheduledTask(user.agentDir, params.id);
            if (!removed) {
              return {
                content: [{
                  type: "text",
                  text: `No scheduled task found with id ${params.id}. Use list_scheduled_tasks to see the current tasks.`,
                }],
                details: { userId: user.userId, taskId: params.id },
                isError: true,
              };
            }
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: true, id: params.id, removed: true }) }],
              details: { userId: user.userId, taskId: params.id },
            };
          },
        }),
      );

      pi.registerTool(
        defineTool({
          name: "whoami",
          label: "Whoami",
          description:
            "Get the current user's identity (id, name, display name, role, tenant), assigned skills, and the NAMES of configured runtime secrets (never values).",
          parameters: Type.Object({}),
          promptSnippet: "Query the current user's identity and environment metadata.",
          async execute() {
            const secrets = listUserSecretStatuses(user.agentDir);
            const payload = JSON.stringify({
              user: {
                id: user.userId,
                name: user.username,
                ...(user.displayName ? { displayName: user.displayName } : {}),
                role: user.role,
                tenantId: user.tenantId,
              },
              skills: user.skills ?? [],
              configuredSecrets: secrets.map((s) => s.name),
            });
            return {
              content: [{ type: "text", text: payload }],
              details: { userId: user.userId },
            };
          },
        }),
      );
    },
  };
}

/** Compact, model-readable view of a task (prompt omitted — the model just wrote it). */
function summarizeTask(task: ScheduledTask): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    schedule: describeSchedule(task.schedule),
    enabled: task.enabled,
    nextRunAt: task.nextRunAt,
    ...(task.cwd ? { cwd: task.cwd } : {}),
    ...(task.lastRun ? { lastRun: task.lastRun } : {}),
  };
}

/** Extension-path filter matching the inline user-context extension. */
export function isUserContextExtensionPath(path: string): boolean {
  return path === HOST_USER_CONTEXT_EXTENSION_PATH;
}
