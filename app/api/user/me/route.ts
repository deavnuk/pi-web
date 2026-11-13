import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/user-auth";
import { listUserSecretStatuses } from "@/lib/user-secrets";
import { resolveAssignment } from "@/lib/skill-registry";

export const dynamic = "force-dynamic";

// GET /api/user/me — current identity for the UI header.
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;

  // Skill-required secret names (union over assigned skills) + what the user
  // already configured — names only, values never leave the server.
  const requiredSecrets = new Set<string>();
  for (const assignment of user.skills ?? []) {
    const resolved = resolveAssignment(assignment);
    if (!resolved) continue;
    const skill = await import("@/lib/skill-registry").then((m) => m.getRegistrySkill(resolved.name));
    for (const secret of skill?.requiredSecrets ?? []) requiredSecrets.add(secret);
  }
  const configured = new Set(listUserSecretStatuses(user.agentDir).filter((s) => s.configured).map((s) => s.name));

  return NextResponse.json({
    // Kept for the UI contract: accounts exist in every deployment now, so the
    // account surfaces are always available.
    multiUser: true,
    user: {
      userId: user.userId,
      username: user.username,
      ...(user.displayName ? { displayName: user.displayName } : {}),
      role: user.role,
      agentDir: user.agentDir,
    },
    ...(requiredSecrets.size > 0
      ? {
          requiredSecrets: [...requiredSecrets].sort().map((name) => ({
            name,
            configured: configured.has(name),
          })),
        }
      : {}),
  });
}
