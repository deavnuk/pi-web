/**
 * Kernel-level sandbox for per-user agent execution (SB-1..SB-6).
 *
 * Every place that runs *user-controlled* code — the agent worker, the PTY
 * terminal, MCP stdio servers, `npx` skill installs, skill registry extraction
 * — is wrapped in bubblewrap so that the process can only SEE the data that
 * belongs to the requesting user plus the admin-declared shared roots.
 *
 * Why a process boundary and not a tool guard: pi's own security docs state a
 * partial in-process sandbox "would be easy to misunderstand as a security
 * boundary" and that "real isolation needs to come from the operating system or
 * a virtualization/container boundary". `user.allowedRoots` is used by the HTTP
 * routes only; it has never been visible to the read/grep/bash tools, so the
 * model could always `grep -r ... /` over every other user's sessions.
 *
 * The model here is an ALLOW-LIST: nothing is mounted unless it is named.
 * `$HOME` is masked with a tmpfs first, then only the permitted roots are bound
 * back in. (@anthropic-ai/sandbox-runtime cannot be used for this: it starts
 * from `--ro-bind / /` and masks the paths it is told to deny, which inverts the
 * model and would leak every user added after the deny list was written.)
 */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/** Directories the runtime needs read-only. Missing entries are skipped. */
const READONLY_SYSTEM_ROOTS = ["/usr", "/lib", "/lib64", "/lib32", "/bin", "/sbin", "/opt"];

/**
 * `/etc` is mounted per-entry, not as a whole tree.
 *
 * Binding all of `/etc` handed every sandbox the host's secrets: the systemd
 * unit holds `PI_WEB_PASSWORD` and `PI_SMARTFICC_ADMIN_PASSWORD`, and
 * `/etc/shadow` is readable to the uid the sandbox runs as. The entries below
 * are what a shell, `node`, `git`, `npx` and DNS actually need; anything not
 * listed (systemd units, shadow, sudoers, cron, sshd config…) stays invisible.
 */
const READONLY_ETC_ENTRIES = [
  "/etc/alternatives",
  "/etc/bash.bashrc",
  "/etc/ca-certificates",
  "/etc/environment",
  "/etc/gitconfig",
  "/etc/group",
  "/etc/host.conf",
  "/etc/hostname",
  "/etc/hosts",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/localtime",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/profile",
  "/etc/profile.d",
  "/etc/protocols",
  "/etc/resolv.conf",
  "/etc/services",
  "/etc/ssl",
];

/** Directories created empty inside the sandbox so common tools can write. */
const HOME_WRITABLE_DIRS = [".cache", ".npm", ".config", ".local/state", ".local/share"];

export interface SandboxOptions {
  /** Roots mounted read-write: the user's own data + admin-declared shared roots. */
  writableRoots: Iterable<string>;
  /** Extra read-only mounts (the Node install prefix, the pi-web checkout). */
  readonlyRoots?: Iterable<string>;
  /** Mount `/tmp` as a private tmpfs. Defaults to true. */
  privateTmp?: boolean;
}

export interface SandboxCommand {
  command: string;
  args: string[];
  /** False when multi-user mode is off and the command was returned unwrapped. */
  sandboxed: boolean;
}

/** Overrides for tests; production callers use the defaults. */
export interface SandboxEnvironment {
  home?: string;
  execPath?: string;
  webRoot?: string;
  /** Overrides the cached `bwrap` probe (tests only). */
  bwrapAvailable?: () => boolean;
}

let cachedBwrapAvailable: boolean | undefined;

/** Whether `bwrap` exists on PATH and can actually create a namespace. */
export function isSandboxAvailable(): boolean {
  if (cachedBwrapAvailable !== undefined) return cachedBwrapAvailable;
  cachedBwrapAvailable = probeBwrap();
  return cachedBwrapAvailable;
}

/** Reset the cached probe result. Test-only. */
export function resetSandboxAvailabilityCache(): void {
  cachedBwrapAvailable = undefined;
}

function probeBwrap(): boolean {
  if (process.platform !== "linux") return false;
  try {
    // A version check alone is not enough: a host without unprivileged user
    // namespaces has the binary but cannot start a sandbox. The real probe runs
    // the smallest possible sandbox.
    execFileSync("bwrap", ["--unshare-user", "--dev-bind", "/", "/", "true"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the sandbox is required for this process.
 *
 * Multi-user only: the single-user mode this forked from no longer exists, so
 * sandboxing is unconditional. Callers still branch on `isSandboxRequired()` so
 * the unimplemented single-user path stays obvious.
 */
export function isSandboxRequired(): boolean {
  return true;
}

/** Node install prefix, so the sandbox can run `node` itself. */
function nodePrefix(execPath: string): string {
  // <prefix>/bin/node -> <prefix>
  return dirname(dirname(execPath));
}

function webRoot(env: SandboxEnvironment): string {
  // The pi-web checkout holds the worker/bootstrap sources a sandboxed process
  // may run. `PI_SMARTFICC_WEB_DIR` is set for workers; callers in the main
  // process (Settings › MCP's Test and sign-in) have no such variable, so fall
  // back to this module's own location — the checkout it was loaded from.
  return env.webRoot ?? process.env.PI_SMARTFICC_WEB_DIR ?? dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Resolve the paths bwrap will bind.
 *
 * `rejectSymlinks` is set for writable roots only. bwrap resolves a bind SOURCE
 * through symlinks, so a writable root that is itself a link mounts whatever it
 * points at — and a user can create such a link inside their own writable root,
 * which would let them nominate any directory on the host. Read-only system
 * roots are not screened: `/bin -> /usr/bin` and friends are ordinary on modern
 * distributions, and denying them breaks every command in the sandbox.
 */
function uniqueExisting(paths: Iterable<string>, options: { rejectSymlinks?: boolean; label?: string } = {}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    if (!raw || !raw.trim()) continue;
    const abs = resolve(raw);
    if (!isAbsolute(abs)) continue;
    // bwrap fails the whole invocation on a missing --bind source, so a stale
    // session cwd or a not-yet-created projects dir must be dropped here.
    if (!existsSync(abs)) continue;
    const real = realpathOrSelf(abs);
    if (options.rejectSymlinks && resolve(real) !== abs) {
      console.warn(`[sandbox] refusing to bind ${options.label ?? "root"} ${abs}: it is a symbolic link to ${real}`);
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(abs);
  }
  return out;
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Build the bwrap argv for `command args...`.
 *
 * Order is load-bearing:
 *  1. `--tmpfs $HOME` and `--tmpfs /tmp` MUST come before every bind. Mounting a
 *     bind first and masking the directory afterwards hides the bind again — and
 *     masking nothing leaves the real home (and every other user's data under it)
 *     visible.
 *  2. Namespace flags come after the mounts, and `--proc /proc` comes after
 *     `--unshare-pid` (the new PID namespace is what /proc is then rendering).
 */
export function buildSandboxArgs(
  command: string,
  args: string[],
  options: SandboxOptions,
  env: SandboxEnvironment = {},
): string[] {
  const home = env.home ?? process.env.HOME ?? "";
  const execPath = env.execPath ?? process.execPath;
  const resolvedWebRoot = webRoot(env);  const bwrapArgs: string[] = ["--new-session", "--die-with-parent", "--cap-drop", "ALL"];

  // (1) Mask the real home and /tmp BEFORE any bind. A tmpfs mounted after a
  // bind hides that bind again — and a writable root that happens to live under
  // /tmp (test fixtures, a projects dir) would silently disappear.
  if (home) bwrapArgs.push("--tmpfs", home);
  const privateTmp = options.privateTmp !== false;
  if (privateTmp) bwrapArgs.push("--tmpfs", "/tmp");

  // (2) Read-only runtime.
  for (const root of uniqueExisting([...READONLY_SYSTEM_ROOTS])) {
    bwrapArgs.push("--ro-bind", root, root);
  }
  // `/etc` per entry: see READONLY_ETC_ENTRIES for why the whole tree is unsafe.
  for (const entry of uniqueExisting(READONLY_ETC_ENTRIES)) {
    bwrapArgs.push("--ro-bind", entry, entry);
  }
  for (const root of uniqueExisting([nodePrefix(execPath), resolvedWebRoot, ...(options.readonlyRoots ?? [])])) {
    bwrapArgs.push("--ro-bind", root, root);
  }

  // (3) Read-write roots: the user's own data and the shared roots only.
  for (const root of uniqueExisting(options.writableRoots, { rejectSymlinks: true, label: "writable root" })) {
    bwrapArgs.push("--bind", root, root);
  }

  // (4) Writable scratch inside the masked home, so npx/rg/fd do not fail.
  for (const dir of HOME_WRITABLE_DIRS) {
    if (!home) break;
    bwrapArgs.push("--dir", join(home, dir));
  }

  // (5) Devices and proc.
  bwrapArgs.push("--dev", "/dev");

  // (6) Namespaces, after the mounts (see the doc comment).
  //
  // `--unshare-pid` is the one that carries real weight here: without it a
  // sandboxed process shares the host PID namespace and can `kill` any process
  // of the same uid — including the other users' workers and terminals, which
  // all run as this service's uid. Verified: with it a foreign pid is invisible
  // and unsignalable; without it the kill succeeds.
  //
  // `--unshare-user` is NOT added: bwrap already creates a user namespace of its
  // own (verified: the sandbox's `uid_map` is `1000 1000 1`, one mapped uid), and
  // it only does more when bwrap itself runs as root or is setuid — neither is
  // the case for a per-service install. Adding the flag would change nothing
  // while suggesting a boundary that is not there.
  bwrapArgs.push("--unshare-pid");
  bwrapArgs.push("--unshare-ipc", "--unshare-uts", "--unshare-cgroup");
  // Network is deliberately NOT unshared: MCP servers and model providers must
  // reach their endpoints. This is a recorded risk (sandbox-design.md §9).
  bwrapArgs.push("--proc", "/proc");
  bwrapArgs.push("--", command, ...args);
  return bwrapArgs;
}

/**
 * Wrap a command in the sandbox.
 *
 * `failClosed` (the default) throws when the sandbox cannot be applied, so a
 * user session never silently runs unsandboxed (SB-4).
 */
export function wrapWithSandbox(
  command: string,
  args: string[],
  options: SandboxOptions,
  config: { failClosed?: boolean; env?: SandboxEnvironment } = {},
): SandboxCommand {
  const failClosed = config.failClosed !== false;
  const available = config.env?.bwrapAvailable ? config.env.bwrapAvailable() : isSandboxAvailable();
  if (!available) {
    if (failClosed) {
      throw new SandboxUnavailableError(
        "bubblewrap (bwrap) is required for multi-user isolation but could not be started. "
          + "Install bubblewrap and ensure unprivileged user namespaces are enabled.",
      );
    }
    return { command, args, sandboxed: false };
  }
  return {
    command: "bwrap",
    args: buildSandboxArgs(command, args, options, config.env),
    sandboxed: true,
  };
}

export class SandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/**
 * Create a directory that a sandbox will bind, so bwrap never sees a missing
 * source. The user's projects root is created on demand by the default-cwd
 * endpoint, but the sandbox may be built before that happens.
 */
export function ensureSandboxDir(dir: string): string {
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // Another process may have created it, or the parent is read-only. bwrap
      // will drop the root in that case; there is nothing better to do here.
    }
  }
  return dir;
}
