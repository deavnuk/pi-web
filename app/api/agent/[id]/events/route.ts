import { createAgentEventStream } from "@/lib/agent-event-stream";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { ownsLiveSession } from "@/lib/session-ownership";
import { requireAuth } from "@/lib/user-auth";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;

  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  // Fast path: already-running session, but only this account's own. The event
  // stream carries the agent's whole output, so a foreign live session must
  // fall through to the (scoped) disk lookup instead of being streamed.
  const live = getRpcSession(id);
  const session = live && ownsLiveSession(live, user) ? live : undefined;
  let sessionPromise;
  if (session?.isAlive()) {
    sessionPromise = Promise.resolve(session);
  } else {
    const filePath = await resolveSessionPath(id, user?.agentDir);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });
    sessionPromise = startRpcSession(id, filePath, undefined, user ? { user } : {}).then(
      (result) => result.session,
    );
  }

  const stream = createAgentEventStream(req, id, sessionPromise);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
