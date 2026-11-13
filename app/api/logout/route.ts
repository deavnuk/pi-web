import { NextResponse } from "next/server";
import { PI_WEB_AUTH_CHALLENGE } from "@/lib/web-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/logout
 *
 * HTTP Basic auth has no server-side session to destroy — the browser caches
 * the credentials for the realm. Logging out means making the browser REPLACE
 * its cached credentials with deliberately invalid ones, after which the next
 * /api request gets a 401 and the native login prompt re-appears (letting the
 * user sign in as someone else or cancel out).
 *
 * The client first sends `GET /api/logout` WITH `Authorization: Basic
 * base64("logout:logout")` from JS; this endpoint must therefore respond 200
 * to those bogus credentials (so the browser stores them) while a bare
 * request still validates normally. Works in Chromium and Firefox; Safari
 * may require a full browser restart to drop cached Basic credentials.
 */
export async function GET(req: Request): Promise<Response> {
  const header = req.headers.get("authorization") ?? "";
  const [, encoded] = header.split(" ");
  const decoded = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
  if (decoded === "logout:logout") {
    // Browser now caches invalid credentials → next API call 401s.
    return NextResponse.json({ ok: true });
  }
  // Normal (bare) request: pretend this is a protected resource so the
  // browser-level flow behaves like a login prompt after invalidation.
  return new NextResponse(null, {
    status: 401,
    headers: {
      "WWW-Authenticate": PI_WEB_AUTH_CHALLENGE,
      "Cache-Control": "no-store",
    },
  });
}
