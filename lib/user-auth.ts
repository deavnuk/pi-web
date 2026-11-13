import { NextResponse } from "next/server";
import { getDataRoot, ensureUserDir, verifyUserCredentials, touchUserActivity } from "./user-store";
import { PI_WEB_AUTH_CHALLENGE } from "./web-auth";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Request authentication + user context resolution.
 *
 * Multi-user is the only mode: every /api route calls requireAuth(), requests
 * must carry Basic auth of a real account, and a request without one is
 * rejected. There is no anonymous path any more.
 */

export interface UserContext {
  userId: string;
  username: string;
  displayName?: string;
  role: "admin" | "user";
  tenantId: string;
  /** This user's isolated pi agentDir (settings/auth/skills/sessions root). */
  agentDir: string;
  /** Extra browsable file roots assigned to this user (projects). */
  allowedRoots: string[];
  /** Assigned skills: "<name>@<version>" entries from users.json. */
  skills: string[];
}

declare global {
  var __piAuthCache: Map<string, { user: UserContext | null; ts: number }> | undefined;
}

const AUTH_CACHE_TTL_MS = 5_000;

function authCache(): Map<string, { user: UserContext | null; ts: number }> {
  if (!globalThis.__piAuthCache) globalThis.__piAuthCache = new Map();
  return globalThis.__piAuthCache;
}

export function buildUserContext(user: {
  id: string;
  username: string;
  displayName?: string;
  role: string;
  tenantId: string;
  skills?: string[];
  adoptGlobalAgentDir?: boolean;
}): UserContext {
  return {
    userId: user.id,
    username: user.username,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    role: user.role === "admin" ? "admin" : "user",
    tenantId: user.tenantId,
    agentDir: ensureUserDir(user.username, user),
    // Per-user extra project roots: <dataRoot>/projects/<username>/ by default.
    allowedRoots: [join(getDataRoot(), "projects", user.username)],
    skills: user.skills ?? [],
  };
}

function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { error: "Authentication required" },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": PI_WEB_AUTH_CHALLENGE,
      },
    },
  );
}

/**
 * Resolve the authenticated user for a request.
 *
 * Multi-user is the only mode, so this always verifies credentials: a request
 * without a valid account yields null and the caller answers 401.
 */
export async function resolveAuthUser(req: Request): Promise<UserContext | null> {
  const authorization = req.headers.get("authorization") ?? "";
  const cached = authCache().get(authorization);
  const now = Date.now();
  if (cached && now - cached.ts < AUTH_CACHE_TTL_MS) return cached.user;

  let user: UserContext | null = null;
  const match = /^Basic\s+(\S+)$/i.exec(authorization);
  if (match) {
    try {
      const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep > 0) {
        const username = decoded.slice(0, sep);
        const password = decoded.slice(sep + 1);
        const account = await verifyUserCredentials(username, password);
        if (account) {
          user = buildUserContext(account);
          // FR-1.4: a verified request is the account being active. Fire and
          // forget — activity tracking must never gate the request (and the
          // store write is throttled internally).
          void touchUserActivity(account.id);
        }
      }
    } catch {
      user = null;
    }
  }
  authCache().set(authorization, { user, ts: now });
  return user;
}

export function respondUnauthorized(): NextResponse {
  return unauthorizedResponse();
}

/**
 * Standard guard for API routes. Answers 401 unless the request carries a real
 * account. Usage:
 *
 *   const auth = await requireAuth(req);
 *   if ("response" in auth) return auth.response;
 *   const user = auth.user;
 */
export async function requireAuth(
  req: Request,
): Promise<{ user: UserContext } | { response: NextResponse }> {
  const user = await resolveAuthUser(req);
  if (!user) return { response: respondUnauthorized() };
  return { user };
}

/** Guard for admin-only API routes. 403 when authenticated as a normal user. */
export async function requireAdmin(
  req: Request,
): Promise<{ user: UserContext } | { response: NextResponse }> {
  const result = await requireAuth(req);
  if ("response" in result) return result;
  if (result.user.role !== "admin") {
    return { response: NextResponse.json({ error: "Admin privilege required" }, { status: 403 }) };
  }
  return { user: result.user };
}

/** agentDir for the effective request context. */
export function effectiveAgentDir(user: UserContext): string {
  return user.agentDir;
}

/**
 * Verify a session file belongs to the user's agentDir. Used by session routes
 * to prevent cross-user access via forged session ids.
 *
 * Fails closed: there is no anonymous caller, so a null user owns nothing.
 */
export function isSessionFileForUser(filePath: string, user: UserContext | null): boolean {
  if (!user) return false;
  const normalized = filePath.replace(/\\/g, "/");
  const userSessions = `${user.agentDir.replace(/\\/g, "/")}/sessions/`;
  return normalized.startsWith(userSessions) && existsSync(filePath);
}

/** Parse a path within the user's data area, rejecting traversal attempts. */
export function isWithinUserAgentDir(target: string, user: UserContext): boolean {
  const normalized = target.replace(/\\/g, "/");
  return normalized.startsWith(`${user.agentDir.replace(/\\/g, "/")}/`);
}

/**
 * Whether `filePath` is inside the user's own sessions root, without requiring
 * it to exist yet.
 *
 * `isSessionFileForUser()` needs the file on disk; this answers the same
 * ownership question for a live, not-yet-persisted session so a route can
 * decide whether to serve it before its first JSONL write.
 */
export function isSessionPathForUser(filePath: string | undefined, user: UserContext | null): boolean {
  if (!user || !filePath) return false;
  const normalized = filePath.replace(/\\/g, "/");
  const userSessions = `${user.agentDir.replace(/\\/g, "/")}/sessions/`;
  return normalized.startsWith(userSessions);
}
