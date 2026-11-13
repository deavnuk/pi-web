import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { defaultCwdPath, localDateStamp } from "@/lib/default-cwd";
import { requireAuth } from "@/lib/user-auth";
import { getDataRoot } from "@/lib/user-store";

// POST /api/default-cwd
// Single-user: creates ~/pi-cwd-<YYYYMMDD> if it doesn't exist and returns the path.
// Multi-user: creates <dataRoot>/projects/<username>/pi-cwd-<YYYYMMDD> so users
// never share (or even see) each other's scratch directories.
// The client then selects the returned directory through /api/cwd/validate.
export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;

  try {
    const dir = user
      ? join(getDataRoot(), "projects", user.username, `pi-cwd-${localDateStamp()}`)
      : defaultCwdPath();
    mkdirSync(dir, { recursive: true });
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
