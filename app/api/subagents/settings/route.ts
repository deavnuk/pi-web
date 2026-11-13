import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  getSubagentSettingsPath,
  readSubagentSettings,
  MAX_SUBAGENT_MAX_CONCURRENT,
  writeBuiltInSubagentsEnabled,
  writeSubagentMaxConcurrent,
} from "@/lib/subagent-settings";
import { requireAuth } from "@/lib/user-auth";

export const dynamic = "force-dynamic";

function settingsPathFor(user: { agentDir: string } | null | undefined): string | undefined {
  return user ? getSubagentSettingsPath(user.agentDir) : undefined;
}

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  try {
    const settings = readSubagentSettings(settingsPathFor(auth.user));
    return NextResponse.json({ enabled: settings.builtInEnabled, maxConcurrent: settings.maxConcurrent });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  try {
    const body = await req.json() as { enabled?: unknown; maxConcurrent?: unknown };
    if (body.enabled === undefined && body.maxConcurrent === undefined) {
      return NextResponse.json({ error: "enabled or maxConcurrent is required" }, { status: 400 });
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    if (body.maxConcurrent !== undefined && (
      typeof body.maxConcurrent !== "number"
      || !Number.isInteger(body.maxConcurrent)
      || body.maxConcurrent < 1
      || body.maxConcurrent > MAX_SUBAGENT_MAX_CONCURRENT
    )) {
      return NextResponse.json({ error: `maxConcurrent must be an integer between 1 and ${MAX_SUBAGENT_MAX_CONCURRENT}` }, { status: 400 });
    }
    let settings = readSubagentSettings(settingsPathFor(auth.user));
    if (body.enabled !== undefined) settings = writeBuiltInSubagentsEnabled(body.enabled, settingsPathFor(auth.user));
    if (body.maxConcurrent !== undefined) settings = writeSubagentMaxConcurrent(body.maxConcurrent, settingsPathFor(auth.user));
    return NextResponse.json({ enabled: settings.builtInEnabled, maxConcurrent: settings.maxConcurrent });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
