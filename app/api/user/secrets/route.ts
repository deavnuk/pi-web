import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/user-auth";
import { setUserSecret, listUserSecretStatuses } from "@/lib/user-secrets";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { collectRunningIds, destroyWorker } from "@/lib/agent-worker-manager";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/secrets
 * Returns the configured secret NAMES + booleans only — values never leave
 * the server (NFR-2 / FR-3.5).
 */
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;

  return NextResponse.json(
    { secrets: listUserSecretStatuses(user.agentDir) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * PUT /api/user/secrets  body: { name: string, value: string | null }
 * value null/"" removes the secret.
 */
export async function PUT(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;

  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 400 });
  }

  try {
    const body = await req.json() as { name?: unknown; value?: unknown };
    if (typeof body.name !== "string" || !body.name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (body.value !== null && typeof body.value !== "string") {
      return NextResponse.json({ error: "value must be a string or null" }, { status: 400 });
    }
    const agentDir = user.agentDir ?? getAgentDir();
    const status = await setUserSecret(agentDir, body.name, body.value ?? null);
    // Per-user secrets are baked into the user's worker env (MCP servers
    // resolve ${VAR} from it). Respawn the worker so the new value takes
    // effect — but only when nothing is running, to not kill live sessions.
    try {
      const { running } = await collectRunningIds(user);
      if (running.length === 0) await destroyWorker(user);
    } catch {
      /* worker respawn is best-effort; next natural respawn picks it up */
    }
    return NextResponse.json({ ok: true, secret: status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
