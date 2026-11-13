import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/user-auth";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  resolveAssignment,
  SkillRegistryError,
  syncUserSkills,
  writeAudit,
} from "@/lib/skill-registry";
import { setUserSkills, findUserById, listUsers, agentDirForUser } from "@/lib/user-store";

export const dynamic = "force-dynamic";

/**
 * PUT /api/admin/skills/assignments — batch assignment update (FR-4.3) with
 * immediate per-user sync (FR-4.4). body: { userId, skills: string[] }
 * or { tenantId, skills: string[] } for tenant-wide assignment.
 */
export async function PUT(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  const admin = auth.user;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 400 });
  }
  try {
    const body = await req.json() as { userId?: unknown; tenantId?: unknown; skills?: unknown };
    if (!Array.isArray(body.skills)) {
      return NextResponse.json({ error: "skills array required" }, { status: 400 });
    }
    const skills = body.skills.filter((s): s is string => typeof s === "string");
    // Pre-validate all assignments resolve in the registry
    for (const s of skills) {
      if (!resolveAssignment(s)) {
        return NextResponse.json({ error: `Unknown skill/version: ${s}` }, { status: 400 });
      }
    }

    const targets = typeof body.userId === "string"
      ? [findUserById(body.userId)]
      : typeof body.tenantId === "string"
        ? listUsers().filter((u) => u.tenantId === body.tenantId)
        : [];
    const valid = targets.filter((u): u is NonNullable<typeof u> => Boolean(u));
    if (valid.length === 0) {
      return NextResponse.json({ error: "userId or tenantId required" }, { status: 400 });
    }

    const results: Array<{ userId: string; sync: ReturnType<typeof syncUserSkills> }> = [];
    for (const user of valid) {
      await setUserSkills(user.id, skills);
      const sync = syncUserSkills(agentDirForUser(user), skills, {
        by: admin.username,
        userId: user.id,
      });
      results.push({ userId: user.id, sync });
      writeAudit({
        action: "assign",
        by: admin.username,
        detail: { userId: user.id, skills },
      });
    }
    return NextResponse.json({ ok: true, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof SkillRegistryError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
