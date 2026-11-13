import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/user-auth";
import { readAudit } from "@/lib/skill-registry";

export const dynamic = "force-dynamic";

/** GET /api/admin/skills/sync-log?month=YYYY-MM&limit=200 */
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? undefined;
  const limit = Number(searchParams.get("limit") ?? "200");
  return NextResponse.json(
    { entries: readAudit(month, Number.isFinite(limit) ? limit : 200) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
