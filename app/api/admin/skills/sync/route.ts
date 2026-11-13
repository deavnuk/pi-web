import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/user-auth";
import { isApiRequestAllowed } from "@/lib/request-security";
import { syncUserSkills } from "@/lib/skill-registry";
import { findUserById, listUsers, agentDirForUser } from "@/lib/user-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/skills/sync — trigger sync (FR-4.7).
 * body: { userId?: string } | { all?: true }
 */
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  const admin = auth.user;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const body = await req.json().catch(() => ({})) as { userId?: unknown; all?: unknown };
    const targets = body.userId
      ? [findUserById(String(body.userId))].filter(Boolean)
      : body.all
        ? listUsers().filter((u) => u.status === "active")
        : [];
    if (targets.length === 0) {
      return NextResponse.json({ error: "userId or all required" }, { status: 400 });
    }
    const results = targets.map((u) => {
      const skills = u!.skills ?? [];
      const sync = syncUserSkills(agentDirForUser(u!), skills, {
        by: admin.username,
        userId: u!.id,
      });
      return { userId: u!.id, ...sync };
    });
    return NextResponse.json({ ok: true, results });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
