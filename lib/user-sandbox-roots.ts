/**
 * Sandbox roots for one user's worker.
 *
 * Kept in its own module so both the worker manager (which must build the
 * command before spawning) and the HTTP file routes can share one definition of
 * "what may this user touch". Everything here is synchronous on purpose: the
 * worker spawn path cannot await.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { getAllAdditionalAllowedRoots, getUserRuntimeRoots } from "./allowed-roots";
import { ensureSandboxDir, wrapWithSandbox } from "./user-sandbox";
import { getDataRoot } from "./user-store";
import type { UserContext } from "./user-auth";

/** Paths that must never be bound, because binding them undoes the mask. */
function isForbiddenRoot(root: string): boolean {
  const resolved = resolve(root);
  // `/` would re-expose everything the tmpfs masks, and every directory whose
  // path is short enough to be a container of user data is equally unsafe.
  const filesystemRoot = parse(resolved).root;
  if (resolved === filesystemRoot) return true;
  // The host home: `--tmpfs $HOME` is the whole point of the mask, and binding
  // it back (even as a subdirectory) exposes every user's dotfiles and keys.
  const home = resolve(homedir());
  if (resolved === home) return true;
  // The data root holds every account. Individual `users/<name>` dirs are fine;
  // the tree above them is not.
  const dataRoot = resolve(getDataRoot());
  if (resolved === dataRoot) return true;
  return false;
}

/**
 * Drop roots that would widen the sandbox past its boundary.
 *
 * A user can register their own runtime roots (`/api/cwd/validate`, worktrees,
 * approved directory links), and an admin can declare shared roots. Both are
 * paths someone chose, so neither is trusted to be safe as a bind source: a
 * single `~` or `/` there would bind the host home — or the whole filesystem —
 * straight back over the tmpfs that masks it.
 */
function safeRoots(roots: Iterable<string>): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (!root || !isAbsolute(root)) continue;
    if (isForbiddenRoot(root)) {
      console.warn(`[sandbox] refusing to mount ${root}: it would expose the host outside the sandbox`);
      continue;
    }
    if (!existsSync(root)) continue;
    out.push(root);
  }
  return out;
}

/**
 * Roots mounted read-write in this user's sandbox.
 *
 * - their own agentDir (settings, keys, skills, sessions)
 * - every root the request context already calls browsable (the per-user
 *   projects dir plus anything registered for them at runtime)
 * - the admin-declared shared roots, which every user may read and write
 *
 * Deliberately NOT included: the data root itself, other users' directories,
 * and the machine's home directory. Those stay outside the sandbox entirely.
 */
export function writableRootsForUser(user: UserContext): string[] {
  const roots = new Set<string>();

  // Own agentDir. createUser makes it, but a user created before this module
  // existed may lack the projects dir; ensure both so bwrap always finds them.
  roots.add(ensureSandboxDir(user.agentDir));
  roots.add(ensureSandboxDir(join(getDataRoot(), "projects", user.username)));

  for (const root of safeRoots(user.allowedRoots)) roots.add(root);

  for (const root of safeRoots(getAllAdditionalAllowedRoots())) roots.add(root);

  // Roots this user picked at runtime (a workspace validated through
  // /api/cwd/validate, a worktree they created, a directory link they
  // approved). Without these the sandbox would be narrower than the file
  // browser and a working session would lose its own cwd.
  for (const root of safeRoots(getUserRuntimeRoots(user.userId))) roots.add(root);

  return [...roots];
}

/** Extra read-only mounts this user's worker needs beyond the defaults. */
export function readonlyRootsForUser(): string[] {
  // The worker runs the pi-web sources directly (jiti), so the checkout has to
  // be readable. It is mounted by lib/user-sandbox.ts already; nothing extra.
  return [];
}

/**
 * Wrap a command a user caused to run outside their worker — an `npx` skill
 * install, an MCP stdio server started from Settings › MCP, a skill registry
 * extraction — in that user's sandbox.
 *
 * `extraRoots` names paths the command legitimately needs beyond the user's own
 * data: the project folder an install ran in, the folder an MCP server is told
 * to start from. They are added read-write, since the shared-root decision
 * (sandbox-design.md SB-3) draws no read-only/writeable line inside them.
 *
 * Throws `SandboxUnavailableError` when bubblewrap cannot start: every caller is
 * executing user-controlled code, so there is no safe un-sandboxed fallback.
 */
export function sandboxCommandForUser(
  user: UserContext,
  command: string,
  args: string[],
  extraRoots: Iterable<string> = [],
): { command: string; args: string[] } {
  const roots = new Set(writableRootsForUser(user));
  // Extra roots come from callers (a project folder, an MCP server's cwd), so
  // they get the same screen: `homedir()` is the default cwd of a global MCP
  // server and would otherwise re-expose the home the sandbox just masked.
  for (const root of safeRoots(extraRoots)) roots.add(root);
  return wrapWithSandbox(command, args, { writableRoots: roots }, { failClosed: true });
}
