import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/user-auth";
import { getRegistrySkill, readUserSkillsManifest, resolveAssignment } from "@/lib/skill-registry";
import { readDisabledSkillNames, setSkillDisabled } from "@/lib/user-skill-prefs";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * FR-4.6 — the skills *assigned to me*, with the version actually synced into
 * my agentDir and whether I have temporarily disabled each for my own sessions.
 * Values are read from users.json (assignments) + the per-user applied manifest,
 * so a user can never see another user's skills or the registry internals.
 */

interface AssignedSkill {
  name: string;
  assignedVersion: string;
  effectiveVersion?: string;
  displayName?: string;
  description?: string;
  requiredSecrets: string[];
  disabled: boolean;
}

function describeAssignments(agentDir: string, assignments: string[]): AssignedSkill[] {
  const manifest = readUserSkillsManifest(agentDir);
  const disabled = readDisabledSkillNames(agentDir);
  const out: AssignedSkill[] = [];
  for (const assignment of assignments) {
    const resolved = resolveAssignment(assignment);
    if (!resolved) {
      out.push({
        name: assignment.split("@")[0] ?? assignment,
        assignedVersion: assignment,
        requiredSecrets: [],
        disabled: false,
      });
      continue;
    }
    const skill = getRegistrySkill(resolved.name);
    const applied = manifest.skills[resolved.name];
    out.push({
      name: resolved.name,
      assignedVersion: resolved.version,
      ...(applied?.version ? { effectiveVersion: applied.version } : {}),
      ...(skill?.displayName ? { displayName: skill.displayName } : {}),
      ...(skill?.description ? { description: skill.description } : {}),
      requiredSecrets: skill?.requiredSecrets ?? [],
      disabled: disabled.has(resolved.name),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// GET /api/user/skills — assigned skills + effective version + disabled flag.
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;

  return NextResponse.json(
    { skills: describeAssignments(user.agentDir, user.skills ?? []) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// PATCH /api/user/skills  body: { name: string, disabled: boolean }
// Toggles a per-user temporary disable; the distributed content is untouched.
export async function PATCH(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;

  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 400 });
  }

  try {
    const body = await req.json() as { name?: unknown; disabled?: unknown };
    if (typeof body.name !== "string" || !body.name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (typeof body.disabled !== "boolean") {
      return NextResponse.json({ error: "disabled must be a boolean" }, { status: 400 });
    }
    // Only skills actually assigned to this user may be toggled.
    const assigned = new Set(
      (user.skills ?? [])
        .map((assignment) => resolveAssignment(assignment)?.name)
        .filter((name): name is string => Boolean(name)),
    );
    if (!assigned.has(body.name)) {
      return NextResponse.json({ error: "Skill is not assigned to you" }, { status: 403 });
    }
    const status = await setSkillDisabled(user.agentDir, body.name, body.disabled);
    return NextResponse.json({ ok: true, skill: status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
