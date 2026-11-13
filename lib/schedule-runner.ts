import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { UserContext } from "./user-auth";
import {
  getScheduledTask,
  listDueTasks,
  listScheduledTasks,
  recordTaskRun,
  type ScheduledTask,
} from "./scheduled-tasks";

/**
 * The scheduled-task runner (design §14.5).
 *
 * Runs in the **main process** (wired up from instrumentation.ts). Each due task
 * starts a fresh session as its owner and sends the task prompt. Because the
 * session is started through the normal `startRpcSession({ user })` path, the
 * run inherits the owner's agentDir, secrets, persona and allowedRoots for free
 * — and its transcript lands in the owner's own session list.
 *
 * Every side effect is injected so the logic is testable without spawning real
 * agents: see lib/schedule-runner.test.mjs.
 */

/** How often the scheduler looks for due tasks. */
export const TICK_INTERVAL_MS = 60_000;

/** A run still going after this long is aborted rather than left to pile up. */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;

/** How long a run may be before we stop waiting for it to settle. */
const SETTLE_POLL_INTERVAL_MS = 2_000;

/**
 * On boot, a task whose due time passed while the server was down is caught up
 * — but only within this window. Anything older is skipped and rescheduled, so
 * a long outage does not trigger a burst of runs for a weekly report nobody
 * wants anymore.
 */
export const CATCH_UP_GRACE_MS = 6 * 60 * 60_000;

/** Concurrent runs across all users. Keeps a battery of tasks from stampeding. */
export const MAX_CONCURRENT_RUNS = 3;

export interface ScheduledSession {
  /** Real pi session id (used for the completion notification). */
  realSessionId: string;
  isRunning(): boolean;
  send(command: Record<string, unknown>): Promise<unknown>;
  /**
   * Why the last run produced no answer (the provider was unreachable, the
   * credential was rejected), or null when it finished.
   *
   * A failed model call does not throw: the run ends like any other, so
   * "the session went idle" is not evidence that the task ran. Without this a
   * task whose provider was down was recorded as `ok`, with a session full of
   * empty assistant messages as the only trace.
   */
  lastError?(): Promise<string | null>;
}

/** Abort a run via the normal command channel (mirrors the UI's stop button). */
async function abortSession(session: ScheduledSession): Promise<void> {
  try {
    await session.send({ type: "abort" });
  } catch {
    // Best effort: the run may have finished between the timeout and the abort.
  }
}

export interface SchedulerDependencies {
  /** Active users to consider. */
  listUsers: () => Array<{ username: string; status: string }>;
  /** Build the owner context needed to start a run. */
  buildUserContext: (user: { username: string }) => UserContext;
  /** Start a session as that user. Mirrors /api/agent/new. */
  startSession: (options: {
    agentDir: string;
    cwd: string;
    sessionKey: string;
    user: UserContext;
  }) => Promise<ScheduledSession>;
  /** Notify the owner that a run finished. Scoped by userId (see web-push). */
  notify: (sessionId: string, userId?: string) => Promise<void>;
  /** Default working directory when the task has no explicit cwd. */
  defaultCwdFor: (user: UserContext) => string;
  /** Whether a cwd is safe to run in (inside the user's allowed roots). */
  isCwdAllowed: (cwd: string, user: UserContext) => Promise<boolean>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => Date;
  /** Overridable so tests do not wait real seconds between run-state polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Overridable for the same reason: the per-run timeout. */
  runTimeoutMs?: number;
}

export interface RunOutcome {
  taskId: string;
  username: string;
  status: "ok" | "error" | "skipped" | "timeout";
  sessionId?: string;
  error?: string;
}

export interface TickResult {
  considered: number;
  started: number;
  outcomes: RunOutcome[];
  skippedLock: boolean;
}

/**
 * Cross-process guard. The scheduler is started by instrumentation.ts, which
 * Next.js may run in more than one server process; without this every process
 * would fire the same task.
 */
async function withSchedulerLock<T>(
  dataRoot: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const lockDir = join(dataRoot, "locks");
  if (!existsSync(lockDir)) mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, "scheduler");
  if (!existsSync(lockPath)) mkdirSync(lockPath, { recursive: true });

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(lockPath, {
      stale: TICK_INTERVAL_MS,
      retries: 0,
    });
  } catch {
    // Another process is already ticking — not an error.
    return null;
  }
  try {
    return await fn();
  } finally {
    try { await release(); } catch { /* already released */ }
  }
}

/** Wait for the run to settle, polling run state (see design §14.2 C1/C2). */
async function waitForSettle(
  session: ScheduledSession,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<"settled" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  // The prompt POST returns on *acceptance*, not completion, so the first
  // observation may legitimately be idle — do not treat that as "finished".
  await sleep(SETTLE_POLL_INTERVAL_MS);
  let polls = 0;
  while (session.isRunning()) {
    polls += 1;
    if (Date.now() >= deadline) return "timeout";
    await sleep(SETTLE_POLL_INTERVAL_MS);
    // Guard against an injected clock that never advances (tests) so a stuck
    // session cannot spin forever.
    if (polls > 100_000) return "timeout";
  }
  return "settled";
}

/** Chat-entrypoint session key. Ties one run to one session. */
export function sessionKeyFor(taskId: string, at: Date): string {
  // Date-stamped so each occurrence produces a fresh session instead of
  // growing one unbounded transcript (design §14.7).
  return `sched:${taskId}:${at.toISOString().slice(0, 10)}`;
}

/**
 * Tasks with a run in flight right now.
 *
 * Design §14.5 requires "同任务已在跑 → skip" and single-task serialization
 * (FR-7.6). The scheduler's file lock only serializes *ticks*; it does not stop
 * a manual "run now" from racing the timer, nor two rapid clicks on the button.
 * Keyed by `agentDir + taskId` so it is per-owner and per-task, and kept on
 * `globalThis` so a hot reload in dev cannot drop a live run's guard.
 */
function getInFlightRuns(): Map<string, true> {
  const store = globalThis as { __piScheduledRuns?: Map<string, true> };
  return (store.__piScheduledRuns ??= new Map());
}

function inFlightKey(agentDir: string, taskId: string): string {
  return `${agentDir}\0${taskId}`;
}

/** Whether this task currently has a run in flight (manual or scheduled). */
export function isScheduledTaskRunning(agentDir: string, taskId: string): boolean {
  return getInFlightRuns().has(inFlightKey(agentDir, taskId));
}

/**
 * Run one task to completion. Returns early with `skipped` when the same task
 * is already running — the in-flight run will record its own outcome and
 * advance the schedule, so a duplicate trigger must record nothing.
 */
export async function runScheduledTask(
  task: ScheduledTask,
  user: UserContext,
  deps: SchedulerDependencies,
  signal: { cancelled?: boolean } = {},
): Promise<RunOutcome> {
  const now = deps.now?.() ?? new Date();
  const username = user.username;
  const log = deps.log ?? (() => {});

  // Claim the task synchronously (before the first await) so two back-to-back
  // triggers cannot both pass the check.
  const inFlight = getInFlightRuns();
  const claimKey = inFlightKey(user.agentDir, task.id);
  if (inFlight.has(claimKey)) {
    deps.warn?.(`[schedule] ${task.id} is already running; skipping duplicate trigger`);
    return { taskId: task.id, username, status: "skipped", error: "Task is already running" };
  }
  inFlight.set(claimKey, true);
  try {
    return await runScheduledTaskClaimed(task, user, deps, signal, now, log);
  } finally {
    inFlight.delete(claimKey);
  }
}

async function runScheduledTaskClaimed(
  task: ScheduledTask,
  user: UserContext,
  deps: SchedulerDependencies,
  signal: { cancelled?: boolean },
  now: Date,
  log: (message: string) => void,
): Promise<RunOutcome> {
  const username = user.username;

  const cwd = task.cwd ?? deps.defaultCwdFor(user);
  if (!await deps.isCwdAllowed(cwd, user)) {
    const error = `Working directory is not allowed for this user: ${cwd}`;
    deps.warn?.(`[schedule] ${task.id} skipped: ${error}`);
    await recordTaskRun(user.agentDir, task.id, { status: "skipped", error }, now);
    return { taskId: task.id, username, status: "skipped", error };
  }

  log(`[schedule] running ${task.id} "${task.title}" as ${username} in ${cwd}`);
  let session: ScheduledSession;
  try {
    session = await deps.startSession({
      agentDir: user.agentDir,
      cwd,
      sessionKey: sessionKeyFor(task.id, now),
      user,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.warn?.(`[schedule] ${task.id} failed to start: ${message}`);
    await recordTaskRun(user.agentDir, task.id, { status: "error", error: message }, now);
    return { taskId: task.id, username, status: "error", error: message };
  }

  const outcome: RunOutcome = {
    taskId: task.id,
    username,
    status: "ok",
    sessionId: session.realSessionId,
  };

  const timeoutMs = deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  try {
    await session.send({ type: "prompt", message: task.prompt });
    const settled = await waitForSettle(
      session,
      timeoutMs,
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    );
    if (settled === "timeout") {
      outcome.status = "timeout";
      outcome.error = `Run exceeded ${Math.round(timeoutMs / 60_000)} minutes`;
      deps.warn?.(`[schedule] ${task.id} timed out; aborting`);
      await abortSession(session);
    } else if (signal.cancelled) {
      outcome.status = "timeout";
      outcome.error = "Aborted during shutdown";
    } else {
      const failure = (await session.lastError?.()) ?? null;
      if (failure) {
        outcome.status = "error";
        outcome.error = failure;
        deps.warn?.(`[schedule] ${task.id} run failed: ${failure}`);
      }
    }
  } catch (error) {
    outcome.status = "error";
    outcome.error = error instanceof Error ? error.message : String(error);
    deps.warn?.(`[schedule] ${task.id} errored: ${outcome.error}`);
  }

  await recordTaskRun(
    user.agentDir,
    task.id,
    {
      status: outcome.status,
      ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    },
    deps.now?.() ?? new Date(),
  );

  // Notify the owner only — never the whole deployment (see lib/web-push.ts).
  try {
    await deps.notify(session.realSessionId, user.userId);
  } catch (error) {
    deps.warn?.(`[schedule] ${task.id} notify failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return outcome;
}

/**
 * One scheduler pass: find due tasks across all users and run them, bounded by
 * MAX_CONCURRENT_RUNS. Returns null when another process holds the lock.
 */
export async function runSchedulerTick(
  deps: SchedulerDependencies,
  dataRoot: string,
): Promise<TickResult | null> {
  const result = await withSchedulerLock(dataRoot, async () => {
    const now = deps.now?.() ?? new Date();
    const users = deps.listUsers().filter((u) => u.status === "active");
    const pending: Array<{ task: ScheduledTask; user: UserContext }> = [];

    for (const stored of users) {
      let user: UserContext;
      try {
        user = deps.buildUserContext(stored);
      } catch {
        continue;
      }
      let due: ScheduledTask[];
      try {
        due = listDueTasks(user.agentDir, now);
      } catch {
        continue;
      }
      for (const task of due) {
        // Already running (a manual "run now", or a slow prior tick): the
        // in-flight run owns this task's nextRunAt and history. Do not enqueue
        // a second instance — design §14.5 "同任务已在跑 → skip" (FR-7.6).
        if (isScheduledTaskRunning(user.agentDir, task.id)) {
          deps.warn?.(`[schedule] ${task.id} is already running; not enqueuing`);
          continue;
        }
        // A task overdue beyond the grace window is skipped, not replayed: a
        // long outage must not queue up a backlog of stale reports.
        const overdueMs = now.getTime() - Date.parse(task.nextRunAt!);
        if (overdueMs > CATCH_UP_GRACE_MS) {
          deps.warn?.(
            `[schedule] ${task.id} overdue by ${Math.round(overdueMs / 3_600_000)}h; advancing without running`,
          );
          await recordTaskRun(
            user.agentDir,
            task.id,
            { status: "skipped", error: "Missed while the server was down" },
            now,
          );
          continue;
        }
        pending.push({ task, user });
      }
    }

    if (pending.length === 0) {
      return { considered: users.length, started: 0, outcomes: [], skippedLock: false };
    }

    const outcomes: RunOutcome[] = [];
    let started = 0;
    for (let i = 0; i < pending.length; i += MAX_CONCURRENT_RUNS) {
      const batch = pending.slice(i, i + MAX_CONCURRENT_RUNS);
      started += batch.length;
      const settled = await Promise.all(
        batch.map(({ task, user }) =>
          runScheduledTask(task, user, deps).catch((error): RunOutcome => ({
            taskId: task.id,
            username: user.username,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          })),
        ),
      );
      outcomes.push(...settled);
    }

    return { considered: users.length, started, outcomes, skippedLock: false };
  });

  if (result === null) {
    return { considered: 0, started: 0, outcomes: [], skippedLock: true };
  }
  return result;
}

/** Count of tasks currently due and enabled, for diagnostics/tests. */
export function countDueTasks(agentDir: string, now: Date = new Date()): number {
  return listDueTasks(agentDir, now).length;
}

export { getScheduledTask, listScheduledTasks };
