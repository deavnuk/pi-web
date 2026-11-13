/**
 * Who owns a live, in-process session.
 *
 * On-disk sessions are scoped by `resolveSessionPath(id, user.agentDir)`, but a
 * live session may not have a JSONL file yet (nothing has been appended), so
 * the path resolver cannot find it. Routing by id alone would then hand one
 * user's running session to any caller who knows its id.
 *
 * Two shapes exist:
 *  - `WorkerSessionProxy` — the session runs in the owner's worker process and
 *    carries that owner's id.
 *  - `AgentSessionWrapper` — the session runs in this process. It has no owner
 *    field, so ownership is read from where its file lives: the user's own
 *    sessions root. That also covers a worker-hosted proxy's file.
 */

import { isWorkerSessionProxy } from "./agent-worker-manager";
import { isSessionPathForUser, type UserContext } from "./user-auth";

/** The parts of a live session this module reads. */
export interface LiveSessionLike {
  sessionFile?: string;
  isAlive?: () => boolean;
}

/**
 * Whether `session` belongs to `user`: a worker proxy by its recorded owner, a
 * local wrapper by its session file's location.
 */
export function ownsLiveSession(session: LiveSessionLike, user: UserContext | null): boolean {
  if (!user) return false;
  if (isWorkerSessionProxy(session)) return session.userId === user.userId;
  return isSessionPathForUser(session.sessionFile, user);
}
