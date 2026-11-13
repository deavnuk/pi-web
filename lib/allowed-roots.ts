import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { toSlashPath } from "./paths";

// In-memory roots that should be browsable in addition to roots derived from
// persisted sessions. Stored on globalThis so Next.js hot-reload keeps them.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAdditionalAllowedRoots: Set<string> | undefined;
  var __piEnvAdditionalRoots: Set<string> | undefined;
  var __piFileAdditionalRoots: { roots: Set<string>; loadedAt: number } | undefined;
  // Per-user runtime registrations (allowFileRootForUser). Keyed by userId so a
  // session started by one user can never widen another user's browsable roots.
  var __piUserRuntimeRoots: Map<string, Set<string>> | undefined;
}

/**
 * Allowed roots are internal bookkeeping keys that are never displayed, so they
 * are stored slash-normalized for consistent Set membership. Correctness does
 * not depend on it — isPathWithinRoots() re-normalizes whatever it is given.
 */
export function normalizeSlashes(filePath: string): string {
  return toSlashPath(filePath);
}

/** Data root (kept in sync with lib/user-store.getDataRoot without importing it,
 *  to avoid a circular dependency — user-store imports nothing from here, but
 *  keeping this module dependency-free is simplest). */
function dataRoot(): string {
  return process.env.PI_WEB_DATA_DIR?.trim()
    || join(process.env.HOME || process.cwd(), ".pi-web-multiuser");
}

function additionalRootsFilePath(): string {
  return join(dataRoot(), "additional-roots.json");
}

/**
 * Static additional roots from the environment:
 * PI_SMARTFICC_ADDITIONAL_ROOTS — PATH-style separator (":" on POSIX, ";" on
 * Windows) list of absolute directories shared with every user (e.g. the
 * shared 知识库 / 工作区 spaces). Evaluated once per process.
 */
export function getEnvAdditionalRoots(): Set<string> {
  if (globalThis.__piEnvAdditionalRoots) return globalThis.__piEnvAdditionalRoots;
  const raw = process.env.PI_SMARTFICC_ADDITIONAL_ROOTS?.trim() || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const roots = new Set<string>();
  for (const part of raw.split(sep)) {
    const trimmed = part.trim();
    if (trimmed) roots.add(normalizeSlashes(trimmed));
  }
  globalThis.__piEnvAdditionalRoots = roots;
  return roots;
}

/**
 * Admin-managed additional roots, persisted at <dataRoot>/additional-roots.json:
 * { "roots": ["/abs/path", ...] }. Cached for 5s so all workers pick up admin
 * changes promptly without restarts.
 */
const FILE_ROOTS_TTL_MS = 5_000;

export function getFileAdditionalRoots(): Set<string> {
  const now = Date.now();
  const cached = globalThis.__piFileAdditionalRoots;
  if (cached && cached.loadedAt + FILE_ROOTS_TTL_MS > now) return cached.roots;

  const roots = new Set<string>();
  const filePath = additionalRootsFilePath();
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as { roots?: unknown };
      if (Array.isArray(parsed.roots)) {
        for (const r of parsed.roots) {
          if (typeof r === "string" && r.trim()) roots.add(normalizeSlashes(r.trim()));
        }
      }
    }
  } catch {
    // Corrupt/unreadable file — treat as empty rather than blocking file access.
  }
  globalThis.__piFileAdditionalRoots = { roots, loadedAt: now };
  return roots;
}

export function setFileAdditionalRoots(roots: Iterable<string>): void {
  const normalized = new Set<string>();
  for (const r of roots) {
    if (r && r.trim()) normalized.add(normalizeSlashes(r.trim()));
  }
  const filePath = additionalRootsFilePath();
  mkdirSync(dataRoot(), { recursive: true });
  // Temp file must live on the same filesystem as the destination (rename is
  // not cross-device) — put it next to the target, not in the OS tmpdir.
  const tmp = filePath + `.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ roots: [...normalized] }, null, 2) + "\n");
  renameSync(tmp, filePath);
  globalThis.__piFileAdditionalRoots = { roots: normalized, loadedAt: Date.now() };
  // Also refresh the in-process view so new roots are usable immediately.
  const additional = getAdditionalAllowedRoots();
  for (const r of normalized) additional.add(r);
  globalThis.__piAllowedRootsCache?.roots.clear();
}

export function getAdditionalAllowedRoots(): Set<string> {
  if (!globalThis.__piAdditionalAllowedRoots) {
    globalThis.__piAdditionalAllowedRoots = new Set();
  }
  return globalThis.__piAdditionalAllowedRoots;
}

/**
 * Every additional root source merged: runtime-registered (allowFileRoot),
 * env-configured, and admin-persisted.
 */
export function getAllAdditionalAllowedRoots(): Set<string> {
  const merged = new Set<string>();
  for (const r of getAdditionalAllowedRoots()) merged.add(r);
  for (const r of getEnvAdditionalRoots()) merged.add(r);
  for (const r of getFileAdditionalRoots()) merged.add(r);
  return merged;
}

export function allowFileRoot(root: string): void {
  if (!root) return;
  const normalizedRoot = normalizeSlashes(root);
  getAdditionalAllowedRoots().add(normalizedRoot);
  globalThis.__piAllowedRootsCache?.roots.add(normalizedRoot);
}

function userRuntimeRoots(): Map<string, Set<string>> {
  if (!globalThis.__piUserRuntimeRoots) globalThis.__piUserRuntimeRoots = new Map();
  return globalThis.__piUserRuntimeRoots;
}

/**
 * Per-user allowed-roots cache, owned by lib/file-access.ts. Cleared through the
 * global so this module stays free of a circular import.
 */
declare global {
  var __piUserAllowedRootsCache: Map<string, { roots: Set<string>; expiresAt: number }> | undefined;
}

/**
 * Register a browsable root for ONE user only.
 *
 * Multi-user mode requires this: a path a session happens to use (its cwd, a
 * worktree it created, an approved directory link) must never become browsable
 * for every other user. `allowFileRoot()` keeps the legacy global behaviour and
 * is now only reachable from admin-scoped code.
 *
 * Drops that user's cached root set so the new root is usable immediately —
 * without this, a session whose cwd was just registered would still 403 for up
 * to the cache TTL.
 */
export function allowFileRootForUser(userId: string, root: string): void {
  if (!userId || !root) return;
  const normalizedRoot = normalizeSlashes(root);
  const map = userRuntimeRoots();
  const roots = map.get(userId) ?? new Set<string>();
  roots.add(normalizedRoot);
  map.set(userId, roots);
  globalThis.__piUserAllowedRootsCache?.delete(userId);
}

/** Roots registered at runtime by (or on behalf of) one user. */
export function getUserRuntimeRoots(userId: string): Set<string> {
  return globalThis.__piUserRuntimeRoots?.get(userId) ?? new Set<string>();
}

/** Drop every runtime registration for one user (user disabled / deleted). */
export function clearUserRuntimeRoots(userId: string): void {
  globalThis.__piUserRuntimeRoots?.delete(userId);
}
