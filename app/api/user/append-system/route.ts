import { NextResponse } from "next/server";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { requireAuth } from "@/lib/user-auth";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const MAX_APPEND_SYSTEM_BYTES = 64 * 1024;

function appendSystemPath(agentDir: string): string {
  return join(agentDir, "APPEND_SYSTEM.md");
}

/**
 * GET /api/user/append-system — returns the user's personal system-prompt
 * fragment (FR-3.6). The SDK loads <agentDir>/APPEND_SYSTEM.md natively on
 * every session start, so persisting here is sufficient.
 */
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;

  try {
    const path = appendSystemPath(user.agentDir);
    const info = await stat(path);
    const content = await readFile(path, "utf8");
    return NextResponse.json(
      { content, updatedAt: info.mtime.toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ content: "", updatedAt: null });
  }
}

/** PUT /api/user/append-system — body: { content: string } */
export async function PUT(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const body = await req.json() as { content?: unknown };
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "content must be a string" }, { status: 400 });
    }
    if (Buffer.byteLength(body.content, "utf8") > MAX_APPEND_SYSTEM_BYTES) {
      return NextResponse.json({ error: "content too large (max 64KB)" }, { status: 413 });
    }
    // Reuse ensureUserDir's mode-0600 file if present, else write 0600.
    const path = appendSystemPath(user.agentDir);
    await writeFile(path, body.content, { encoding: "utf8", mode: 0o600 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
