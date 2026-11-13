// Tests for lib/user-sandbox.ts (SB-1..SB-6).
//
// The argv builder is pure, so most of this asserts on the constructed bwrap
// command line. The isolation tests at the bottom actually execute bwrap and
// are skipped when bubblewrap cannot start here.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(here, { interopDefault: true });

const sandbox = await jiti.import("./user-sandbox.ts");
const {
  buildSandboxArgs,
  wrapWithSandbox,
  isSandboxAvailable,
  SandboxUnavailableError,
} = sandbox;

function indexOfFlag(args, flag) {
  return args.indexOf(flag);
}

test("home is masked before any bind — masking after a bind would hide it", () => {
  const args = buildSandboxArgs("node", ["x"], {
    writableRoots: ["/tmp"],
  }, { home: "/home/alice", execPath: "/usr/bin/node", webRoot: "/opt/pi-web" });

  const tmpfsHome = indexOfFlag(args, "--tmpfs");
  const firstBind = indexOfFlag(args, "--bind");

  assert.ok(tmpfsHome >= 0, "expected --tmpfs for the home directory");
  assert.equal(args[tmpfsHome + 1], "/home/alice");
  assert.ok(firstBind > tmpfsHome, `home tmpfs (${tmpfsHome}) must precede the first bind (${firstBind})`);
});

test("only the named writable roots are bound read-write", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-roots-"));
  const ownAgentDir = join(root, "users", "alice");
  const ownProjects = join(root, "projects", "alice");
  const shared = join(root, "shared");
  for (const dir of [ownAgentDir, ownProjects, shared]) mkdirSync(dir, { recursive: true });
  try {
    const args = buildSandboxArgs("node", [], {
      writableRoots: [ownAgentDir, ownProjects, shared],
    }, { home: "/home/alice", execPath: "/usr/bin/node", webRoot: "/opt/pi-web" });

    const binds = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--bind") binds.push(args[i + 1]);
    }
    assert.deepEqual(binds.filter((p) => p.startsWith(root)), [ownAgentDir, ownProjects, shared]);
    // The user's own home is never bound back in.
    assert.ok(!binds.includes("/home/alice"), "the real home must not be bound");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing writable root is dropped instead of failing the whole invocation", () => {
  const args = buildSandboxArgs("node", [], {
    writableRoots: ["/definitely/not/here", "/tmp"],
  }, { home: "/home/alice", execPath: "/usr/bin/node" });

  const binds = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--bind") binds.push(args[i + 1]);
  }
  assert.ok(!binds.includes("/definitely/not/here"));
});

test("a writable root under /tmp survives the private tmp", () => {
  // --tmpfs /tmp must precede the --bind or it buries the root again.
  const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-tmp-"));
  try {
    const args = buildSandboxArgs("node", [], { writableRoots: [dir] }, {
      home: "/home/alice",
      execPath: "/usr/bin/node",
    });
    const tmpfsIdx = args.indexOf("--tmpfs");
    const bindIdx = args.indexOf("--bind");
    assert.ok(tmpfsIdx >= 0 && bindIdx > tmpfsIdx, "the bind must come after the /tmp tmpfs");

    if (!isSandboxAvailable()) return;
    const out = execFileSync("bwrap", [...args.slice(0, -3), "--exec", "/bin/sh"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(typeof out, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--unshare-pid comes after the filesystem binds", () => {
  const args = buildSandboxArgs("node", [], { writableRoots: ["/tmp"] }, {
    home: "/home/alice",
    execPath: "/usr/bin/node",
  });
  const pidFlag = indexOfFlag(args, "--unshare-pid");
  const lastBind = args.lastIndexOf("--bind");
  assert.ok(pidFlag > lastBind, "nested bwrap needs the binds mounted before the pid namespace");
});

test("network is not unshared: MCP servers and model providers need it", () => {
  const args = buildSandboxArgs("node", [], { writableRoots: ["/tmp"] }, {
    home: "/home/alice",
    execPath: "/usr/bin/node",
  });
  assert.ok(!args.includes("--unshare-net"));
});

test("command is separated from bwrap options by --", () => {
  const args = buildSandboxArgs("node", ["--version"], { writableRoots: ["/tmp"] }, {
    home: "/home/alice",
    execPath: "/usr/bin/node",
  });
  const sep = indexOfFlag(args, "--");
  assert.ok(sep >= 0);
  assert.equal(args[sep + 1], "node");
  assert.equal(args[sep + 2], "--version");
});

test("wrapWithSandbox fail-closes when bwrap is unavailable", () => {
  assert.throws(
    () => wrapWithSandbox("node", [], { writableRoots: ["/tmp"] }, {
      env: { bwrapAvailable: () => false },
    }),
    SandboxUnavailableError,
  );
});

test("wrapWithSandbox returns the raw command when failClosed is off", () => {
  const result = wrapWithSandbox("node", ["--version"], { writableRoots: ["/tmp"] }, {
    failClosed: false,
    env: { bwrapAvailable: () => false },
  });
  assert.deepEqual(result, { command: "node", args: ["--version"], sandboxed: false });
});

test("active sandbox: another user's data is invisible and their secrets unreadable", async (t) => {
  if (!isSandboxAvailable()) {
    t.skip("bubblewrap cannot start on this host");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-iso-"));
  const alice = join(root, "users", "alice");
  const bob = join(root, "users", "bob");
  mkdirSync(alice, { recursive: true });
  mkdirSync(bob, { recursive: true });
  writeFileSync(join(alice, "own.txt"), "alice-data\n");
  writeFileSync(join(bob, "secrets.json"), '{"probe":"BOB_SECRET"}\n');

  try {
    const { command, args } = wrapWithSandbox(
      "/bin/sh",
      ["-c", `ls ${root}/users; echo '---'; cat ${bob}/secrets.json 2>&1 || true`],
      { writableRoots: [alice] },
      { env: { home: root } },
    );

    const out = execFileSync(command, args, { encoding: "utf8", timeout: 30_000 });
    assert.match(out, /alice/, "the owner's directory must be visible");
    assert.doesNotMatch(out, /^bob$/m, "another user's directory must not be visible");
    assert.doesNotMatch(out, /BOB_SECRET/, "another user's secrets must not be readable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npx runs the CLI inside the account's sandbox", async () => {
  const { runNpx } = await jiti.import("./npx.ts");
  const agentDir = mkdtempSync(join(tmpdir(), "pi-npx-sandbox-"));
  try {
    // `npx --version` prints the bundled npm version: the CLI itself must be
    // reachable read-only from inside bwrap, not just from the host.
    const { stdout } = await runNpx(["--version"], {
      timeout: 60_000,
      user: { userId: "u1", username: "alice", role: "user", tenantId: "t", agentDir, allowedRoots: [], skills: [] },
    });
    assert.match(stdout, /\d+\.\d+\.\d+/);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("npx refuses to run outside an account's sandbox", async () => {
  const { runNpx } = await jiti.import("./npx.ts");
  await assert.rejects(runNpx(["skills", "find", "pdf"]), /no account was given/);
});

test("the PTY spawns bwrap, so the terminal cannot read outside the user's roots", async () => {
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  // The spawn must go through the sandbox wrapper: a raw `spawn(shell, ...)`
  // here would be the whole point lost.
  assert.match(source, /wrapWithSandbox\(shell, shellArgs/, "the terminal shell must be wrapped");
  assert.match(source, /failClosed: true/, "an unsandboxable shell must not start");
  assert.match(source, /writableRoots: shellWritableRoots\(user, cwd\)/);
});

test("MCP stdio servers start inside the caller's sandbox", async () => {
  const source = readFileSync(new URL("./mcp-transport.ts", import.meta.url), "utf8");
  assert.match(source, /options\.user/, "the factory must take the owning account");
  assert.match(source, /sandboxCommandForUser\(/, "a sandboxed account's server must be wrapped");
});

test("`/etc` is bound per entry, so the service's own secrets stay out of the sandbox", async (t) => {
  if (!isSandboxAvailable()) {
    t.skip("bubblewrap cannot start on this host");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "pi-etc-mask-"));
  try {
    const { command, args } = wrapWithSandbox(
      "/bin/sh",
      ["-c", [
        // What a shell, node, git and npx actually need must still work.
        "node --version",
        "git --version",
        // What must NOT be reachable: the unit file holds PI_WEB_PASSWORD and
        // PI_SMARTFICC_ADMIN_PASSWORD, and shadow is readable to the sandbox uid.
        // `|| true` keeps the run going; the assertions below check the text.
        "cat /etc/shadow 2>&1 || true",
        "cat /etc/sudoers 2>&1 || true",
        "ls /etc/systemd/system 2>&1 || true",
      ].join("; echo ---; ")],
      { writableRoots: [dir] },
      { failClosed: true },
    );
    const out = execFileSync(command, args, { encoding: "utf8", timeout: 30_000 });
    assert.match(out, /^v\d+\./, "node must still run");
    assert.match(out, /git version/, "git must still run");
    // Only the *content* counts: the echoed command text repeats the paths.
    assert.doesNotMatch(out, /root:[^:]*:/, "shadow must be unreadable");
    assert.doesNotMatch(out, /^\s*root\s+ALL/m, "sudoers content must be absent");
    assert.doesNotMatch(out, /\.service$/m, "the service unit must be absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sandboxed process cannot signal a process outside its PID namespace", async (t) => {
  if (!isSandboxAvailable()) {
    t.skip("bubblewrap cannot start on this host");
    return;
  }
  if (process.platform === "win32") {
    t.skip("no POSIX signals");
    return;
  }

  // Every user's worker and terminal runs as the same service uid, so without
  // `--unshare-pid` one user could kill another user's agent by pid.
  const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const dir = mkdtempSync(join(tmpdir(), "pi-pidns-"));
  try {
    const { command, args } = wrapWithSandbox(
      "/bin/sh",
      ["-c", `kill -0 ${victim.pid} 2>/dev/null && echo SIGNALLABLE || echo ISOLATED`],
      { writableRoots: [dir] },
      { failClosed: true },
    );
    const out = execFileSync(command, args, { encoding: "utf8", timeout: 30_000 });
    assert.match(out, /ISOLATED/, "another user's process must not be signalable");
  } finally {
    victim.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
