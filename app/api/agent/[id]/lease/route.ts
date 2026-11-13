import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { renewSessionLivenessLeases } from "@/lib/session-liveness";
import { ownsLiveSession } from "@/lib/session-ownership";
import { requireAuth } from "@/lib/user-auth";

// POST /api/agent/[id]/lease - Renew selected-session SSE leases.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Renewing a lease keeps a session's runtime alive, so it is scoped to the
  // owner: otherwise anyone could pin another user's session open.
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const live = getRpcSession(id);
  if (live && !ownsLiveSession(live, auth.user)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  return NextResponse.json({
    success: true,
    renewed: renewSessionLivenessLeases(id),
  }, { headers: { "Cache-Control": "no-store" } });
}
