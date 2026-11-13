// Read-only transcript access for the admin session browser.
//
// Deliberately independent of `/api/sessions/[id]`: that route merges live RPC
// wrappers, worker proxies, eviction probes and perf spans, none of which apply
// to "show me another user's history". Reading straight from the JSONL keeps
// this path simple and guarantees the viewer can never mutate a live session.
//
// The response shape mirrors /api/sessions/[id] closely enough that the
// read-only viewer can reuse MessageView and the existing tree projection.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  attachSessionProjectInfo,
  buildSessionContext,
  openSessionManager,
  resolveSessionPath,
} from "./session-reader";
import { projectTreeForResponse, toSummaryTree } from "./project-tree";
import { computeSessionStats } from "./session-stats";
import { computeSessionTotalActiveMs } from "./session-timing";
import { readSessionToolSelection } from "./session-tool-selection";
import { readSubagentRun, readSubagentSessionResources } from "./subagents";
import type { SessionEntry, SessionInfo } from "./types";

export interface AdminSessionDetailOptions {
  /** Active branch tail to load; defaults to the last 50 messages like the app. */
  tail?: number;
  /** Skip thinking blocks (the viewer loads them on demand). */
  deferThinking?: boolean;
  /** Skip inline tool-result images. */
  deferToolResultImages?: boolean;
  /** Return a compact tree (the sidebar only needs names + counts). */
  summaryTree?: boolean;
  /**
   * The owner's agentDir. Required: this is what confines the lookup to one
   * user, and `resolveSessionPath` refuses paths outside it.
   */
  ownerAgentDir: string;
}

export interface AdminSessionDetail {
  sessionId: string;
  filePath: string;
  info: SessionInfo | null;
  leafId: string | null;
  tree: unknown;
  treeFormat?: "summary";
  context: ReturnType<typeof buildSessionContext>;
  stats: ReturnType<typeof computeSessionStats>;
  totalActiveMs: number;
  toolNames?: string[];
}

/**
 * Load one session transcript for an admin viewer, scoped to `ownerAgentDir`.
 *
 * Returns null when the session does not exist under that user's tree — the
 * caller must answer 404 without revealing whether the id exists elsewhere.
 */
export async function readAdminSessionDetail(
  sessionId: string,
  options: AdminSessionDetailOptions,
): Promise<AdminSessionDetail | null> {
  const filePath = await resolveSessionPath(sessionId, options.ownerAgentDir);
  if (!filePath || !existsSync(filePath)) return null;

  // Same-file check again: resolveSessionPath already enforces this, but a
  // mis-wired caller must not be able to widen the boundary silently.
  const sessionsRoot = join(options.ownerAgentDir, "sessions");
  if (!filePath.startsWith(sessionsRoot)) return null;

  const sm = openSessionManager(filePath);
  const entries = sm.getEntries();
  const leafId = sm.getLeafId();
  const tail = options.tail && options.tail > 0 ? Math.min(options.tail, 1000) : 50;

  const context = buildSessionContext(entries as never, leafId, {
    tail,
    ...(options.deferThinking ? { deferThinking: true } : {}),
    ...(options.deferToolResultImages ? { deferToolResultImages: true } : {}),
    sessionId,
  });
  const stats = computeSessionStats(entries as unknown as SessionEntry[]);
  const totalActiveMs = computeSessionTotalActiveMs(entries);
  const tree = options.summaryTree
    ? toSummaryTree(projectTreeForResponse(sm.getTree()))
    : projectTreeForResponse(sm.getTree());

  const header = sm.getHeader();
  const sessionName = sm.getSessionName();
  const firstUserEntry = entries.find(
    (entry) => entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "user",
  );
  const firstUserMessage = (firstUserEntry as { message?: { content: unknown } } | undefined)?.message;
  const firstMessageText = firstUserMessage
    ? (() => {
        const content = firstUserMessage.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          const text = content.find((block: { type: string }) => block.type === "text") as { text?: string } | undefined;
          return text?.text ?? "";
        }
        return "";
      })() || "(no messages)"
    : "(no messages)";

  const subagent = header ? readSubagentRun(entries as never, header.id, filePath) : null;
  const toolNames = readSubagentSessionResources(entries as never)?.tools
    ?? readSessionToolSelection(entries as never);

  let modified = header?.timestamp ?? new Date().toISOString();
  try { modified = statSync(filePath).mtime.toISOString(); } catch { /* keep header timestamp */ }

  const baseInfo: SessionInfo = {
    path: filePath,
    id: header?.id ?? sessionId,
    cwd: header?.cwd ?? "",
    ...(sessionName ? { name: sessionName } : {}),
    created: header?.timestamp ?? modified,
    modified,
    messageCount: stats.totalMessages,
    firstMessage: firstMessageText,
    ...(subagent
      ? {
          parentSessionId: subagent.parentSessionId,
          relation: {
            kind: "subagent" as const,
            parentSessionId: subagent.parentSessionId,
            profile: subagent.profile,
            description: subagent.description,
            status: subagent.status,
          },
        }
      : {}),
    transient: false,
  };
  const [info] = await attachSessionProjectInfo([baseInfo]);

  return {
    sessionId: header?.id ?? sessionId,
    filePath,
    info: info ?? null,
    leafId,
    tree,
    ...(options.summaryTree ? { treeFormat: "summary" as const } : {}),
    context,
    stats,
    totalActiveMs,
    ...(toolNames !== undefined ? { toolNames } : {}),
  };
}
