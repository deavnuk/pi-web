import { readdirSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { getAllAdditionalAllowedRoots, getUserRuntimeRoots, normalizeSlashes } from "./allowed-roots";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { listAllSessions } from "./session-reader";
import type { UserContext } from "./user-auth";
export {
  allowFileRoot,
  allowFileRootForUser,
  clearUserRuntimeRoots,
  getUserRuntimeRoots,
  normalizeSlashes,
  getAllAdditionalAllowedRoots,
} from "./allowed-roots";
export { isWindowsAbsolutePath } from "./paths";

// Short-TTL cache for the allowed-roots set. Without this, every file list/read
// request re-scans every pi session on disk just to check access. 5s is short
// enough that newly-created cwds appear promptly; stored on globalThis so it
// survives Next.js hot-reload.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
}

const ALLOWED_ROOTS_TTL_MS = 5_000;

/**
 * Allowed file roots for a request.
 * - Single-user (user === null): legacy global roots, identical behavior.
 * - Multi-user: the user's own session cwds/project roots, their agentDir,
 *   their per-user projects root, plus admin-configured additional roots.
 *   The legacy global pi-cwd-* scan is admin/served from their own sessions only.
 */
export async function getAllowedFileRoots(user: UserContext | null = null): Promise<Set<string>> {
  if (user) return getUserAllowedRoots(user);

  const now = Date.now();
  const cached = globalThis.__piAllowedRootsCache;
  if (cached && cached.expiresAt > now) return cached.roots;

  const sessions = await listAllSessions();
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    // The project root (main repo shared by all worktrees) is browsable too —
    // the project dropdown lists it even when only worktrees have sessions.
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }

  for (const root of getAllAdditionalAllowedRoots()) roots.add(root);

  globalThis.__piAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS };
  return roots;
}

const USER_ROOTS_TTL_MS = 5_000;

declare global {
  var __piUserAllowedRootsCache: Map<string, { roots: Set<string>; expiresAt: number }> | undefined;
}

async function getUserAllowedRoots(user: UserContext): Promise<Set<string>> {
  const now = Date.now();
  if (!globalThis.__piUserAllowedRootsCache) globalThis.__piUserAllowedRootsCache = new Map();
  const cached = globalThis.__piUserAllowedRootsCache.get(user.userId);
  if (cached && cached.expiresAt > now) return cached.roots;

  const roots = new Set<string>();

  // The user's own agentDir (skills toggling, settings, sessions) is always
  // browsable — there is no single-user mode to guard against any more.
  roots.add(normalizeSlashes(user.agentDir));

  // Per-user projects root: <dataRoot>/projects/<username>[/...] — created on
  // demand by the default-cwd endpoint; browsable even before it exists.
  for (const root of user.allowedRoots) roots.add(normalizeSlashes(root));

  // Session cwds browsable per user: only the user's own sessions.
  const sessions = await listAllSessions({ agentDir: user.agentDir });
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }

  // User-scoped default cwd: <user agentDir sibling> pi-cwd-* under the user's
  // own data area only (never the global home).
  const userProjectsRoot = user.allowedRoots[0];
  if (userProjectsRoot) {
    try {
      for (const name of readdirSync(userProjectsRoot)) {
        if (/^pi-cwd-\d{8}$/.test(name)) {
          roots.add(normalizeSlashes(pathJoin(userProjectsRoot, name)));
        }
      }
    } catch {
      // projects root may not exist yet
    }
  }

  // Shared admin-configured roots stay available to every user.
  for (const root of getAllAdditionalAllowedRoots()) roots.add(root);

  // Roots this user registered at runtime (session cwds, approved worktrees and
  // directory links). Deliberately per-user: registering one here must never
  // widen anyone else's browsable set.
  for (const root of getUserRuntimeRoots(user.userId)) roots.add(root);

  globalThis.__piUserAllowedRootsCache!.set(user.userId, { roots, expiresAt: now + USER_ROOTS_TTL_MS });
  return roots;
}

export function invalidateUserAllowedRoots(userId: string): void {
  globalThis.__piUserAllowedRootsCache?.delete(userId);
}

/** Authorize a path lexically, without touching the filesystem. */
export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isPathWithinRoots(target, allowedRoots);
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isExistingPathWithinRoots(target, allowedRoots);
}
