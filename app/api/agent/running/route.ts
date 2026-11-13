import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSession,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { requireAuth } from "@/lib/user-auth";
import { collectRunningIds } from "@/lib/agent-worker-manager";
import { getSessionUiStatePath, getSessionUiStateRevision } from "@/lib/session-ui-state";
import { ownsLiveSession } from "@/lib/session-ownership";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// sessionUiStateRevision (null when unreadable) tells the sidebar its pins and
// archive changed elsewhere; it costs one stat while the file is unchanged.
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;

  // Multi-user: merge main-registry ids with the user's worker-side ids, and
  // keep only the sessions this account owns. The registry is process-wide, so
  // an unfiltered list would tell one user which sessions another is running.
  const workerIds = user
    ? await collectRunningIds(user)
    : { running: [], suppressed: [] };
  const mine = (id: string) => ownsLiveSession(getRpcSession(id) ?? {}, user);
  const running = new Set([...getRunningRpcSessionIds().filter(mine), ...workerIds.running]);
  const suppressed = new Set([
    ...getCompletionNotificationSuppressedRpcSessionIds().filter(mine),
    ...workerIds.suppressed,
  ]);
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: [...running],
      completionNotificationSuppressedSessionIds: [...suppressed],
      // Per-user file: the revision tells THIS user's sidebar its pins changed.
      sessionUiStateRevision: getSessionUiStateRevision(getSessionUiStatePath(user.agentDir)),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
