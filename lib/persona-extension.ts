import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { UserContext } from "./user-auth";

/**
 * Per-user system prompt (FR-5.4).
 *
 * The department persona ("研研" credit-research assistant) lives in
 * `lib/personas/researcher.md` as a plain markdown asset — never executed,
 * admin-editable on disk.
 *
 * Replaces the whole system prompt for `role === "user"` sessions only;
 * admins keep pi's stock prompt (plus their APPEND_SYSTEM.md) so
 * administrative work behaves exactly as before.
 *
 * Identity (username / display name / tenant) is injected dynamically at
 * `before_agent_start` so it can never go stale the way a generated
 * APPEND_SYSTEM.md snapshot does.
 *
 * ## Precedence — no double-append
 *
 * `DefaultResourceLoader` composes the base append list as
 * `appendSystemPromptOverride?.(discovered) || discovered`, merged into
 * `systemPromptOptions.appendSystemPrompt`. Because `before_agent_start`
 * returns a *complete* replacement prompt, pi's own base prompt (which would
 * have contained the APPEND_SYSTEM.md text) is discarded — so the user's text
 * must be re-emitted here, and appears exactly once. Verified against
 * pi-coding-agent 0.84.x `runner.js emitBeforeAgentStart` + `system-prompt.ts`.
 */

const HOST_PERSONA_EXTENSION_NAME = "pi-web-persona";
const HOST_PERSONA_EXTENSION_PATH = `<inline:${HOST_PERSONA_EXTENSION_NAME}>`;

export const PERSONA_EXTENSION_NAME = HOST_PERSONA_EXTENSION_NAME;
export const PERSONA_EXTENSION_PATH = HOST_PERSONA_EXTENSION_PATH;

/** Path to the department persona asset, relative to this module. */
export function personaAssetPath(webRoot: string): string {
  return join(webRoot, "lib", "personas", "researcher.md");
}

/** Read the persona body; returns null when the asset is missing/empty. */
export function readPersonaBody(webRoot: string): string | null {
  try {
    const body = readFileSync(personaAssetPath(webRoot), "utf8").trim();
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

/** Only non-admin users get the persona; admins keep stock pi behavior. */
export function personaAppliesTo(user: UserContext | undefined | null): boolean {
  return Boolean(user) && user!.role !== "admin";
}

/**
 * Live identity block. Injected for EVERY user (admin included) so the
 * current name/role/tenant can never go stale — this is the replacement for
 * the identity line that used to be baked into APPEND_SYSTEM.md.
 */
export function buildIdentityBlock(user: UserContext): string {
  const displayName = user.displayName?.trim();
  return [
    "## 当前会话用户",
    "",
    `- 用户名:${user.username}`,
    ...(displayName && displayName !== user.username ? [`- 称呼:${displayName}`] : []),
    `- 角色:${user.role === "admin" ? "管理员" : "用户"}`,
    `- 租户:${user.tenantId}`,
    ...(user.skills?.length ? [`- 已分配技能(${user.skills.length}):${user.skills.join("、")}`] : []),
    "",
    "如需更多环境信息或已配置密钥名称,可调用 whoami 工具。",
    "用户要求配置/更新密钥(API key、token)时,用 set_secret 工具写入其本人密钥库;注意:",
    "- 只写用户明确提供的值,不要猜测或编造密钥;",
    "- 写入后**绝不要**在回复里重复密钥值,只回报名称与状态;",
    "- bash 命令立刻可用;已连接的 MCP server 需重连才能读到新值。",
    "用户用自然语言要求「定时/每周/每天执行某任务」时,用 schedule_task 工具创建;注意:",
    "- **先回读确认再创建**(如「每周五 09:00 Asia/Shanghai,确认吗?」),频率/时间猜错会静默失败很久;",
    "- 用户没明说星期或时间时,先问,不要替他选;",
    "- prompt 要写成**自包含**的指令——定时执行时是**全新会话**,没有本次对话的上下文。",
  ].join("\n");
}

interface PersonaPromptOptions {
  /** User's APPEND_SYSTEM.md text (already discovered by pi). */
  appendSystemPrompt?: string;
  /** Tools currently active, for the "Available tools" block. */
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  cwd: string;
  contextFiles?: Array<{ path: string; content: string }>;
  skills?: Array<{ name: string; description: string }>;
}

/**
 * Assemble the final system prompt: persona body + identity + tools +
 * user's own append text + project context + skills + cwd.
 *
 * Deliberately mirrors pi's native `customPrompt` branch so standard
 * sections (tools, skills, context files, cwd) keep their usual shape.
 */
export function buildPersonaSystemPrompt(
  body: string,
  user: UserContext,
  options: PersonaPromptOptions,
): string {
  const tools = options.selectedTools ?? [];
  const snippets = options.toolSnippets ?? {};
  const skills = options.skills ?? [];

  const parts: string[] = [body.trim()];

  // Dynamic identity — always current, unlike a generated APPEND_SYSTEM.md.
  parts.push(buildIdentityBlock(user));

  if (tools.length > 0) {
    const toolLines = tools.map((name) => (snippets[name] ? `- ${name}: ${snippets[name]}` : `- ${name}`));
    parts.push(`Available tools:\n${toolLines.join("\n")}`);
  }

  if (options.appendSystemPrompt?.trim()) {
    parts.push(options.appendSystemPrompt.trim());
  }

  const contextFiles = options.contextFiles ?? [];
  if (contextFiles.length > 0) {
    const ctxBlock = contextFiles
      .map((f) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`)
      .join("\n\n");
    parts.push(
      `<project_context>\n\nProject-specific instructions and guidelines:\n\n${ctxBlock}\n</project_context>`,
    );
  }

  const hasRead = tools.length === 0 || tools.includes("read");
  if (hasRead && skills.length > 0) {
    const skillLines = skills.map((s) => `- ${s.name}: ${s.description}`);
    parts.push(
      `Available skills (${skills.length}):\n\n${skillLines.join("\n")}\n\n`
        + "需要哪类数据或能力,先读对应 skill 的 SKILL.md 及其 references 再调用。",
    );
  }

  parts.push(`Current working directory: ${(options.cwd ?? "").replace(/\\/g, "/")}`);
  return parts.join("\n\n");
}

/**
 * Inline extension that shapes the system prompt for a signed-in user.
 *
 * - non-admin: full replacement built from the department persona asset
 *   (re-read each turn, so editing the asset needs no restart);
 * - admin: stock prompt kept as-is, with only the live identity block
 *   appended, so management work behaves exactly like single-user mode.
 */
export function createPersonaExtension(user: UserContext, webRoot: string): InlineExtension {
  return {
    name: HOST_PERSONA_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", async (event) => {
        if (!personaAppliesTo(user)) {
          // Admin: keep pi's prompt, just refresh the identity section.
          return { systemPrompt: `${event.systemPrompt}\n\n${buildIdentityBlock(user)}` };
        }
        const body = readPersonaBody(webRoot);
        if (!body) {
          // Asset missing/emptied → fall back to stock + identity.
          return { systemPrompt: `${event.systemPrompt}\n\n${buildIdentityBlock(user)}` };
        }
        return {
          systemPrompt: buildPersonaSystemPrompt(body, user, {
            appendSystemPrompt: event.systemPromptOptions?.appendSystemPrompt,
            selectedTools: event.systemPromptOptions?.selectedTools,
            toolSnippets: event.systemPromptOptions?.toolSnippets,
            cwd: event.systemPromptOptions?.cwd ?? "",
            contextFiles: event.systemPromptOptions?.contextFiles,
            skills: (event.systemPromptOptions?.skills ?? []).map((s) => ({
              name: s.name,
              description: s.description,
            })),
          }),
        };
      });
    },
  };
}

/** Extension-path filter matching the inline persona extension. */
export function isPersonaExtensionPath(path: string): boolean {
  return path === HOST_PERSONA_EXTENSION_PATH;
}
