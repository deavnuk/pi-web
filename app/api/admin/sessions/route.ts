import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/user-auth";
import { collectAdminSessions } from "@/lib/admin-sessions";
import { recordSessionAccess } from "@/lib/session-access-audit";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/sessions — every user's sessions, grouped user → cwd → session.
 *
 * Admin only. Read-only: nothing here starts a worker or touches a live
 * session. `?summary=1` serves cheap header/stat rows for a first paint,
 * `?force=1` bypasses the per-user scan cache, `?tenantId=` scopes the view.
 */
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  const admin = auth.user;

  const searchParams = new URL(req.url).searchParams;
  const tenantId = searchParams.get("tenantId")?.trim() || undefined;

  try {
    const catalogue = await collectAdminSessions({
      force: searchParams.get("force") === "1",
      summary: searchParams.get("summary") === "1",
      ...(tenantId ? { tenantId } : {}),
    });
    recordSessionAccess({
      actor: admin.username,
      action: "list",
      ...(tenantId ? { tenantId } : {}),
    });
    return NextResponse.json(catalogue, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
