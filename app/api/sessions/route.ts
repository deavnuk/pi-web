import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  listSessionSummaries,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { startServerPerf } from "@/lib/perf";
import { requireAuth } from "@/lib/user-auth";
import { collectRunningIds, collectSessionInfos } from "@/lib/agent-worker-manager";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;

  const perf = startServerPerf("GET /api/sessions");
  try {
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";
    // `summary=1` serves header/stat metadata so the sidebar can paint without
    // waiting for every session transcript to be parsed.
    const summary = searchParams.get("summary") === "1";
    perf?.span("start");
    // Multi-user: only scan the user's own sessions dir; single-user keeps the
    // legacy global scan (undefined agentDir). Worker-hosted runtime sessions
    // are merged in from the user's worker process.
    const persistedSessionsPromise = summary
      ? listSessionSummaries(user ? { agentDir: user.agentDir } : {})
      : listAllSessions({ force, ...(user ? { agentDir: user.agentDir } : {}) });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions, workerInfos, workerRunning] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
      user ? collectSessionInfos(user) : Promise.resolve([]),
      user ? collectRunningIds(user) : Promise.resolve({ running: [], suppressed: [] }),
    ]);
    perf?.span("scan+projects");
    const workerRuntime = await attachSessionProjectInfo(workerInfos as never[]);
    const sessions = mergeSessionLists(
      mergeSessionLists(persistedSessions, workerRuntime),
      runtimeSessions,
    );
    const runningIds = new Set([
      ...getRunningRpcSessionIds(),
      ...workerRunning.running,
    ]);
    const suppressedIds = new Set([
      ...getCompletionNotificationSuppressedRpcSessionIds(),
      ...workerRunning.suppressed,
    ]);
    const payload = {
      sessions,
      sessionListVersion,
      runningSessionIds: [...runningIds],
      completionNotificationSuppressedSessionIds: [...suppressedIds],
    };
    return perf?.attach(jsonResponse(
      req,
      payload,
      { headers: { "Cache-Control": "no-store" } },
    )) ?? jsonResponse(
      req,
      payload,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
