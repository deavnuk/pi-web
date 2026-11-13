import { NextResponse } from "next/server";
import type { McpErrorResponse, McpRefusalReason, ToolSettingsResponse } from "@/lib/api-types";
import {
  CODEMODE_INLINE_BUDGET_MAX,
  isCodemodeInlineBudget,
  isCodemodeMode,
  isCodemodePreference,
  readCodemodePreference,
  readCodemodeSettings,
  writeCodemodeInlineBudget,
  writeCodemodeMode,
  writeCodemodePreference,
} from "@/lib/codemode-settings";
import { join } from "node:path";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { requireAuth } from "@/lib/user-auth";
import {
  readPowerShellToolEnabled,
  writePowerShellToolEnabled,
} from "@/lib/powershell-settings";

export const dynamic = "force-dynamic";

// The only writer of the global `defaultTools` key: the PowerShell switch
// (Windows) and the Code mode choice (ADR 0006, chosen in Settings › MCP) both
// edit it, under the lock pi's SettingsManager takes on the same file. Settings
// › MCP saves the global `codemode.mode` and `codemode.inlineBudget` here too,
// under the same lock.
// Every refusal carries a `reason` code the panel translates, beside the
// English `error` it shows only as the diagnostic of an `internal` failure.

const CHANGES = ["enabled", "codemode", "codemodeMode", "codemodeInlineBudget"] as const;

function refusal(status: number, reason: McpRefusalReason, error: string) {
  return NextResponse.json({ error, reason } satisfies McpErrorResponse, { status });
}

function errorResponse(error: unknown) {
  return refusal(500, "internal", error instanceof Error ? error.message : String(error));
}

// Multi-user: each account has its own settings.json in its agentDir, so these
// choices (Code mode, PowerShell, default tools) are per-user rather than
// installationside. They used to read and write the host `agentDir` for
// everybody, so one user changed every other user's tool set.
async function readToolSettings(agentDir: string): Promise<ToolSettingsResponse> {
  const settingsPath = join(agentDir, "settings.json");
  // One after the other: each takes the file lock, and a reader that finds it
  // held backs off for about a second.
  const powerShellEnabled = await readPowerShellToolEnabled(settingsPath);
  const codemode = await readCodemodePreference(settingsPath);
  const { mode: codemodeMode, inlineBudget: codemodeInlineBudget } = await readCodemodeSettings(settingsPath);
  return { isWindows: process.platform === "win32", powerShellEnabled, codemode, codemodeMode, codemodeInlineBudget };
}

export async function GET(req: Request) {
  // Reads the installation-wide tool settings, so it needs at least an account.
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  try {
    return NextResponse.json(await readToolSettings(auth.user.agentDir));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const settingsPath = join(auth.user.agentDir, "settings.json");
  if (!isApiRequestAllowed(req)) {
    return refusal(403, "request-denied", "Untrusted API request");
  }
  if (!hasJsonContentType(req)) {
    return refusal(415, "content-type", "Content-Type must be application/json");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "invalid-request", "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refusal(400, "invalid-request", "Expected a JSON object");
  }
  const changes = body as { enabled?: unknown; codemode?: unknown; codemodeMode?: unknown; codemodeInlineBudget?: unknown };
  if (CHANGES.filter((key) => key in changes).length !== 1) {
    return refusal(400, "invalid-request", "Send one of enabled (PowerShell), codemode, codemodeMode or codemodeInlineBudget");
  }

  if ("codemodeMode" in changes) {
    // "on" removes the key: it is pi's default.
    if (!isCodemodeMode(changes.codemodeMode)) {
      return refusal(400, "invalid-request", "codemodeMode must be \"on\" or \"only\"");
    }
    try {
      await writeCodemodeMode(changes.codemodeMode, settingsPath);
      return NextResponse.json(await readToolSettings(auth.user.agentDir));
    } catch (error) {
      return errorResponse(error);
    }
  }

  if ("codemodeInlineBudget" in changes) {
    // null removes the key, which gives sessions pi's default.
    const budget = changes.codemodeInlineBudget;
    if (budget !== null && !isCodemodeInlineBudget(budget)) {
      return refusal(400, "invalid-request", `codemodeInlineBudget must be a whole number from 0 to ${CODEMODE_INLINE_BUDGET_MAX}, or null`);
    }
    try {
      await writeCodemodeInlineBudget(budget ?? undefined, settingsPath);
      return NextResponse.json(await readToolSettings(auth.user.agentDir));
    } catch (error) {
      return errorResponse(error);
    }
  }

  if ("codemode" in changes) {
    if (!isCodemodePreference(changes.codemode)) {
      return refusal(400, "invalid-request", "codemode must be \"automatic\" or \"always\"");
    }
    try {
      await writeCodemodePreference(changes.codemode, settingsPath);
      return NextResponse.json(await readToolSettings(auth.user.agentDir));
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (process.platform !== "win32") {
    return refusal(404, "invalid-request", "PowerShell tool settings are only available on Windows");
  }
  if (typeof changes.enabled !== "boolean") {
    return refusal(400, "invalid-request", "enabled must be a boolean");
  }
  try {
    await writePowerShellToolEnabled(changes.enabled, settingsPath);
    return NextResponse.json(await readToolSettings(auth.user.agentDir));
  } catch (error) {
    return errorResponse(error);
  }
}
