import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/user-auth";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { resolveAssignment, SkillRegistryError, syncUserSkills, writeAudit } from "@/lib/skill-registry";
import { setUserSkills, findUserById, listUsers, agentDirForUser } from "@/lib/user-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/skills/assignments/batch — matrix assignment:
 * body: { skills: string[], users: string[] (userIds), version?: "latest" | "<ver>" }
 * Assigns every skill@version to every listed user in one call, then syncs.
 * Each user keeps their other assignments untouched.
 */
export async function POST(req: Request) {
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
    const body = await req.json() as { skills?: unknown; users?: unknown; version?: unknown };
    const skillNames = Array.isArray(body.skills) ? body.skills.filter((s): s is string => typeof s === "string") : [];
    const userIds = Array.isArray(body.users) ? body.users.filter((s): s is string => typeof s === "string") : [];
    if (skillNames.length === 0) return NextResponse.json({ error: "skills array required" }, { status: 400 });
    if (userIds.length === 0) return NextResponse.json({ error: "users array required" }, { status: 400 });
    const version = typeof body.version === "string" && body.version ? body.version : "latest";

    for (const name of skillNames) {
      if (!resolveAssignment(`${name}@${version}`)) {
        return NextResponse.json({ error: `Unknown skill/version: ${name}@${version}` }, { status: 400 });
      }
    }
    const targets = userIds
      .map((id) => findUserById(id))
      .filter((u): u is NonNullable<typeof u> => Boolean(u));
    if (targets.length === 0) return NextResponse.json({ error: "no matching users" }, { status: 400 });

    const results: Array<{ userId: string; skills: string[]; sync: ReturnType<typeof syncUserSkills> }> = [];
    const errors: Array<{ userId: string; error: string }> = [];
    for (const user of targets) {
      try {
        const existing = (user.skills ?? []).filter((s) => !skillNames.some((n) => s === n || s.startsWith(`${n}@`)));
        const nextSkills = [...existing, ...skillNames.map((n) => `${n}@${version}`)];
        await setUserSkills(user.id, nextSkills);
        const sync = syncUserSkills(agentDirForUser(user), nextSkills, {
          by: admin.username,
          userId: user.id,
        });
        results.push({ userId: user.id, skills: nextSkills, sync });
        writeAudit({
          action: "assign",
          by: admin.username,
          detail: { userId: user.id, skills: skillNames.map((n) => `${n}@${version}`), via: "batch-matrix" },
        });
      } catch (error) {
        errors.push({ userId: user.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return NextResponse.json({ ok: true, results, errors });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof SkillRegistryError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
