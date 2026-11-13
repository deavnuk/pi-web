import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/user-auth";
import { isApiRequestAllowed } from "@/lib/request-security";
import { autoUpdateGitSkills, getLastGitSyncSource } from "@/lib/skill-registry";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/skills/auto-update — run the git auto-update now
 * (same code path as the scheduler). GET returns the remembered source
 * so the UI can show whether auto-update is configured.
 */
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const result = autoUpdateGitSkills();
  return NextResponse.json({ ok: true, result });
}

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  return NextResponse.json(
    {
      source: getLastGitSyncSource() ?? null,
      credentialsConfigured: Boolean(process.env.PI_SMARTFICC_GIT_USERNAME || process.env.PI_SMARTFICC_GIT_PASSWORD),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
