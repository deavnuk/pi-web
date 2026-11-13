import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { requireAuth } from "@/lib/user-auth";
import { updatePassword, verifyUserCredentials } from "@/lib/user-store";

export const dynamic = "force-dynamic";

// POST /api/user/password  body: { currentPassword, newPassword }
// Multi-user self-service password change.
export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;

  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { currentPassword?: unknown; newPassword?: unknown };
    if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string") {
      return NextResponse.json({ error: "currentPassword and newPassword required" }, { status: 400 });
    }
    if (body.newPassword.length < 8) {
      return NextResponse.json({ error: "New password must be at least 8 characters" }, { status: 400 });
    }
    const account = await verifyUserCredentials(user.username, body.currentPassword);
    if (!account) {
      return NextResponse.json({ error: "Current password is incorrect" }, { status: 403 });
    }
    await updatePassword(user.userId, body.newPassword);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
