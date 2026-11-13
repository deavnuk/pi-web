import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { ownsLiveSession } from "@/lib/session-ownership";
import { requireAuth } from "@/lib/user-auth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const user = auth.user;
  try {
    const rpc = getRpcSession(id);
    // Only expose a live session to its owner (multi-user isolation). A worker
    // proxy carries its owner's userId; a local wrapper is owned by the user
    // whose sessions root holds its file.
    if (rpc?.isAlive() && ownsLiveSession(rpc, user)) {
      const state = await rpc.send({ type: "get_state" });
      return NextResponse.json({ running: true, state });
    }

    if (!await resolveSessionPath(id, user?.agentDir)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
