import { NextResponse } from "next/server";
import { getTerminalCwd, getTerminalUserId, killTerminal, resizeTerminal, writeTerminal } from "@/lib/terminal-manager";
import { requireAuth } from "@/lib/user-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Reject a terminal id this account does not own.
 *
 * The id is a random UUID, so guessing one is impractical; matching it against
 * the recorded owner is what makes that impossible rather than merely unlikely.
 */
function denyForeignTerminal(id: string, userId: string): boolean {
  const owner = getTerminalUserId(id);
  return owner !== userId;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const cwd = denyForeignTerminal(id, auth.user.userId) ? undefined : getTerminalCwd(id);
  return cwd
    ? NextResponse.json({ id, cwd })
    : NextResponse.json({ error: "Terminal expired or closed" }, { status: 404 });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  try {
    const { id } = await params;
    if (denyForeignTerminal(id, auth.user.userId)) {
      return NextResponse.json({ error: "Terminal not found" }, { status: 404 });
    }
    const body = await req.json() as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
    if (body.type === "input" && typeof body.data === "string" && body.data.length <= 64 * 1024) {
      return writeTerminal(id, body.data)
        ? NextResponse.json({ success: true })
        : NextResponse.json({ error: "Terminal not found" }, { status: 404 });
    }
    if (body.type === "resize" && Number.isInteger(body.cols) && Number.isInteger(body.rows)
      && (body.cols as number) >= 2 && (body.cols as number) <= 1000
      && (body.rows as number) >= 2 && (body.rows as number) <= 1000) {
      return resizeTerminal(id, body.cols as number, body.rows as number)
        ? NextResponse.json({ success: true })
        : NextResponse.json({ error: "Terminal not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Invalid terminal command" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const { id } = await params;
  if (denyForeignTerminal(id, auth.user.userId)) {
    return NextResponse.json({ error: "Terminal not found" }, { status: 404 });
  }
  killTerminal(id);
  return NextResponse.json({ success: true });
}
