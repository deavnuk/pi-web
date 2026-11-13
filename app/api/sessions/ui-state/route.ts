import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  getSessionUiStatePath,
  readSessionUiState,
  SessionUiStateLockedError,
  updateSessionUiState,
} from "@/lib/session-ui-state";
import { requireAuth } from "@/lib/user-auth";
import {
  parseSessionUiStateRequest,
  type SessionUiStateErrorResponse,
  type SessionUiStateRefusalReason,
  type SessionUiStateResponse,
} from "@/lib/session-ui-state-shared";

export const dynamic = "force-dynamic";

// The sidebar's pins, archive and project order (lib/session-ui-state.ts).
// Ids and projectKeys are not checked against the session list: an entry for
// a session that is gone is harmless, and deleting a session removes its
// entry; a project no longer shown keeps its place in the order.

const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, reason: SessionUiStateRefusalReason, error: string) {
  return NextResponse.json({ error, reason } satisfies SessionUiStateErrorResponse, { status, headers: NO_STORE });
}

// GET /api/sessions/ui-state
//
// The state file holds this user's pinned/archived session ids, so it lives in
// their own agentDir and the route is scoped to them. It used to read the host
// `agentDir` for everybody: any caller could see every user's sidebar, and
// overwrite it.
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  return NextResponse.json(
    { state: readSessionUiState(getSessionUiStatePath(auth.user.agentDir)) } satisfies SessionUiStateResponse,
    { headers: NO_STORE },
  );
}

// POST /api/sessions/ui-state - one change; answers with the state after it.
export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;
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
  const parsed = parseSessionUiStateRequest(body);
  if (!parsed.ok) return refusal(400, "invalid-request", parsed.error);

  try {
    const state = await updateSessionUiState(parsed.request, getSessionUiStatePath(user.agentDir));
    return NextResponse.json({ state } satisfies SessionUiStateResponse, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof SessionUiStateLockedError) return refusal(409, "locked", error.message);
    return refusal(500, "internal", error instanceof Error ? error.message : String(error));
  }
}
