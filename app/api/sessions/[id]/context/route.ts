import { NextResponse } from "next/server";
import { resolveSessionPath, openSessionManager, buildSessionContext } from "@/lib/session-reader";
import { getRpcSession, isWorkerSessionProxy } from "@/lib/rpc-manager";
import { ownsLiveSession } from "@/lib/session-ownership";
import { requireAuth } from "@/lib/user-auth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Multi-user: a session's transcript is its owner's alone. Without this the
  // route read any session by id (resolveSessionPath with no agentDir), which is
  // the same leak the detail route was fixed for.
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // `tail` caps the ancestor chain returned (default 50); `before` rewinds the
  // walk start to an older entry so the client can page upward without
  // re-fetching the whole active branch.
  const rawTail = Number(url.searchParams.get("tail"));
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
  const before = url.searchParams.get("before") ?? undefined;

  try {
    const rpc = getRpcSession(id);
    // Worker proxies have no in-process SessionManager; fall through to the
    // persisted file (the worker owns the live copy). A live wrapper is only
    // used when this account owns it.
    const liveRpc = rpc && !isWorkerSessionProxy(rpc) && rpc.isAlive() && ownsLiveSession(rpc, user)
      ? rpc
      : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id, user.agentDir);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(filePath!);
    // `before` is the oldest entry already on the client; fetch its ancestors
    // only (excludeLeaf) so prepending the page does not duplicate `before`.
    const context = buildSessionContext(sm.getEntries() as never, before ?? leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      excludeLeaf: Boolean(before),
      sessionId: id,
    });

    return NextResponse.json({ context, tail, before: before ?? null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
