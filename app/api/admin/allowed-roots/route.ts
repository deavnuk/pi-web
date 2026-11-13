import { NextResponse } from "next/server";
import { realpathSync } from "node:fs";
import { requireAdmin } from "@/lib/user-auth";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import {
  getAllAdditionalAllowedRoots,
  getEnvAdditionalRoots,
  getFileAdditionalRoots,
  normalizeSlashes,
  setFileAdditionalRoots,
} from "@/lib/allowed-roots";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/allowed-roots — list shared additional roots.
 * Sources: env (PI_SMARTFICC_ADDITIONAL_ROOTS, read-only here), admin-persisted
 * file (<dataRoot>/additional-roots.json), and runtime-registered roots
 * (allowFileRoot calls from this process).
 */
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;

  const all = [...getAllAdditionalAllowedRoots()].sort();
  const env = [...getEnvAdditionalRoots()].sort();
  const persisted = [...getFileAdditionalRoots()].sort();
  return NextResponse.json(
    { roots: all, env, persisted },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * POST /api/admin/allowed-roots — replace the persisted shared roots list.
 * Body: { "roots": ["/abs/dir", ...] }. Directories must exist; they are
 * stored realpath-resolved (slash-normalized). Env-configured roots cannot be
 * changed here.
 */
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  }

  let body: { roots?: unknown };
  try {
    body = (await req.json()) as { roots?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.roots)) {
    return NextResponse.json({ error: "Body must be { roots: string[] }" }, { status: 400 });
  }

  const resolved: string[] = [];
  for (const raw of body.roots) {
    if (typeof raw !== "string" || !raw.trim()) {
      return NextResponse.json({ error: "roots must be non-empty strings" }, { status: 400 });
    }
    try {
      resolved.push(normalizeSlashes(realpathSync(raw.trim())));
    } catch {
      return NextResponse.json(
        { error: `Directory does not exist: ${raw}` },
        { status: 400 },
      );
    }
  }

  setFileAdditionalRoots(resolved);
  return NextResponse.json(
    { success: true, persisted: [...getFileAdditionalRoots()].sort() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
