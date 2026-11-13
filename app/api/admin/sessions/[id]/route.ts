import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/user-auth";
import { findUserById, agentDirForUser } from "@/lib/user-store";
import { readAdminSessionDetail } from "@/lib/admin-session-read";
import { recordSessionAccess } from "@/lib/session-access-audit";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/sessions/[id]?owner=<userId> — one user's transcript, read-only.
 *
 * `owner` is mandatory and must name a real account: the lookup is confined to
 * that account's agentDir, so an admin cannot read a session by id alone and
 * cannot point the reader at an arbitrary path.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  const admin = auth.user;
  const { id } = await params;

  const searchParams = new URL(req.url).searchParams;
  const ownerId = searchParams.get("owner")?.trim();
  if (!ownerId) {
    return NextResponse.json({ error: "owner (userId) is required" }, { status: 400 });
  }
  const owner = findUserById(ownerId);
  if (!owner) {
    return NextResponse.json({ error: "Owner not found" }, { status: 404 });
  }

  const rawTail = Number(searchParams.get("tail"));
  const detail = await readAdminSessionDetail(id, {
    ownerAgentDir: agentDirForUser(owner),
    ...(Number.isFinite(rawTail) && rawTail > 0 ? { tail: rawTail } : {}),
    deferThinking: searchParams.has("deferThinking"),
    deferToolResultImages: searchParams.has("deferMedia"),
    summaryTree: searchParams.get("tree") === "summary",
  });
  // Same answer whether the id is unknown or belongs to someone else: an admin
  // browsing one owner's tree must not learn about ids outside it.
  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  recordSessionAccess({
    actor: admin.username,
    target: owner.username,
    sessionId: detail.sessionId,
    action: "view",
  });
  return NextResponse.json(
    { ...detail, owner: { userId: owner.id, username: owner.username, ...(owner.displayName ? { displayName: owner.displayName } : {}) }, readOnly: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
