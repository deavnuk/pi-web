// Sandbox roots for one user (lib/user-sandbox-roots.ts).
//
// This module decides WHAT a user's sandbox can see. Getting it wrong is either
// a leak (too wide: another user's data or the host home) or a broken product
// (too narrow: the shared 知识库 root, the user's own projects, a workspace they
// just picked). The two directions are tested separately below.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });

async function fresh(dataRoot) {
  // The data root and the shared-root registry both live in module state.
  process.env.PI_WEB_DATA_DIR = dataRoot;
  delete process.env.PI_SMARTFICC_ADDITIONAL_ROOTS;
  globalThis.__piUserRuntimeRoots = undefined;
  globalThis.__piAdditionalAllowedRoots = undefined;
  globalThis.__piEnvAdditionalRoots = undefined;
  globalThis.__piFileAdditionalRoots = undefined;
  const roots = await jiti.import("./user-sandbox-roots.ts");
  const allowed = await jiti.import("./allowed-roots.ts");
  return { roots, allowed };
}

function makeUser(dataRoot, username, extra = {}) {
  return {
    userId: `u_${username}`,
    username,
    role: "user",
    tenantId: "t_default",
    agentDir: join(dataRoot, "users", username),
    allowedRoots: [join(dataRoot, "projects", username)],
    skills: [],
    ...extra,
  };
}

function withDataRoot(t) {
  const dataRoot = mkdtempSync(join(tmpdir(), "pi-sandbox-roots-"));
  t.after(() => {
    globalThis.__piUserRuntimeRoots = undefined;
    globalThis.__piAdditionalAllowedRoots = undefined;
    globalThis.__piEnvAdditionalRoots = undefined;
    globalThis.__piFileAdditionalRoots = undefined;
    delete process.env.PI_WEB_DATA_DIR;
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return dataRoot;
}

test("a user's own agentDir and projects root are the baseline", async (t) => {
  const dataRoot = withDataRoot(t);
  const { roots } = await fresh(dataRoot);
  const user = makeUser(dataRoot, "alice");

  const got = roots.writableRootsForUser(user).sort();
  assert.deepEqual(got, [user.agentDir, join(dataRoot, "projects", "alice")].sort());
});

test("directories are created if missing, so bwrap never sees a missing source", async (t) => {
  const dataRoot = withDataRoot(t);
  const { roots } = await fresh(dataRoot);
  const user = makeUser(dataRoot, "alice");

  // A user created before this module existed has no projects dir; bwrap fails
  // the whole invocation on a missing --bind source.
  assert.doesNotThrow(() => roots.writableRootsForUser(user));
  assert.deepEqual(roots.writableRootsForUser(user).length, 2);
  // Both are usable now.
  const again = roots.writableRootsForUser(user);
  assert.equal(again.length, 2);
});

test("the data root itself and other users are never mounted", async (t) => {
  const dataRoot = withDataRoot(t);
  const { roots } = await fresh(dataRoot);
  const alice = makeUser(dataRoot, "alice");
  const bob = makeUser(dataRoot, "bob");
  mkdirSync(bob.agentDir, { recursive: true });
  writeFileSync(join(bob.agentDir, "secrets.json"), '{"probe":"BOB"}\n');

  const got = roots.writableRootsForUser(alice);
  assert.equal(got.includes(dataRoot), false, "the data root would expose every user");
  assert.equal(got.includes(bob.agentDir), false, "bob's agentDir is not alice's to see");
});

test("admin-declared shared roots are mounted read-write for everyone", async (t) => {
  const dataRoot = withDataRoot(t);
  const { roots, allowed } = await fresh(dataRoot);
  const shared = join(dataRoot, "..", "shared-kb");
  mkdirSync(shared, { recursive: true });
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  allowed.setFileAdditionalRoots([shared]);

  const alice = roots.writableRootsForUser(makeUser(dataRoot, "alice"));
  const bob = roots.writableRootsForUser(makeUser(dataRoot, "bob"));

  // SB-3: the shared root is policy, not a side effect, and both users get it.
  assert.ok(alice.includes(shared), "alice sees the shared root");
  assert.ok(bob.includes(shared), "bob sees the shared root");
});

test("a root this user picked at runtime is mounted for them, and only them", async (t) => {
  const dataRoot = withDataRoot(t);
  const { roots, allowed } = await fresh(dataRoot);
  const workspace = join(dataRoot, "workspace-alice");
  mkdirSync(workspace, { recursive: true });

  allowed.allowFileRootForUser("u_alice", workspace);

  const alice = roots.writableRootsForUser(makeUser(dataRoot, "alice"));
  const bob = roots.writableRootsForUser(makeUser(dataRoot, "bob"));
  assert.ok(alice.includes(workspace), "a session started there must keep its cwd");
  assert.equal(bob.includes(workspace), false, "bob must not gain alice's workspace");
});

test("a registered root that no longer exists is dropped instead of failing bwrap", async (t) => {
  const dataRoot = withDataRoot(t);
  const { roots, allowed } = await fresh(dataRoot);
  const gone = join(dataRoot, "deleted-workspace");

  allowed.allowFileRootForUser("u_alice", gone);
  assert.doesNotThrow(() => roots.writableRootsForUser(makeUser(dataRoot, "alice")));
  assert.equal(roots.writableRootsForUser(makeUser(dataRoot, "alice")).includes(gone), false);
});

test("a command for a user is wrapped with that user's roots plus the folder it needs", async (t) => {
  const dataRoot = withDataRoot(t);
  const { roots } = await fresh(dataRoot);
  const user = makeUser(dataRoot, "alice");
  const project = join(dataRoot, "projects", "alice", "repo");
  mkdirSync(project, { recursive: true });

  const { command, args } = roots.sandboxCommandForUser(user, "node", ["server.mjs"], [project]);
  assert.equal(command, "bwrap", "the command must be wrapped, not run directly");
  assert.ok(args.includes("--bind"));
  assert.ok(args.includes(project), "the install/server folder must be visible");
  assert.ok(args.includes(user.agentDir), "the user's own data must be visible");
  assert.deepEqual(args.slice(-2), ["node", "server.mjs"], "the wrapped command keeps its argv");

  // An MCP server's cwd defaults to the home directory; a caller passing that
  // through must not re-bind it past the tmpfs that masks it.
  const withHome = roots.sandboxCommandForUser(user, "node", ["x"], [project, homedir()]).args;
  const bindsAfterTmpfs = withHome.slice(withHome.indexOf("--tmpfs") + 2);
  assert.equal(bindsAfterTmpfs.filter((a) => a === homedir()).length, 0, "home must never be a bind source");
  assert.ok(withHome.includes(project));
});

test("wrapping fails closed when bubblewrap cannot start", async (t) => {
  const dataRoot = withDataRoot(t);
  const { roots } = await fresh(dataRoot);
  const { SandboxUnavailableError, wrapWithSandbox, resetSandboxAvailabilityCache } = await jiti.import("./user-sandbox.ts");
  const user = makeUser(dataRoot, "alice");

  t.after(resetSandboxAvailabilityCache);
  // No safe fallback: an install or an MCP server must not run unisolated.
  assert.throws(
    () => wrapWithSandbox("node", ["x"], { writableRoots: [] }, { failClosed: true, env: { bwrapAvailable: () => false } }),
    (error) => error instanceof SandboxUnavailableError,
  );
  // With bwrap available on this host the same call wraps instead of throwing.
  resetSandboxAvailabilityCache();
  assert.doesNotThrow(() => roots.sandboxCommandForUser(user, "true", []));
});

test("a root that would undo the home mask is refused, whoever registered it", async (t) => {
  const dataRoot = withDataRoot(t);
  const { roots, allowed } = await fresh(dataRoot);
  const user = makeUser(dataRoot, "alice");

  // A user can register their own roots (`/api/cwd/validate`, a worktree, an
  // approved link), and an admin declares shared ones. None of those paths is
  // trusted: `~` or `/` here would bind the host home — or everything — back
  // over the tmpfs that masks it, which is the entire isolation boundary.
  for (const unsafe of [homedir(), "/", dataRoot]) {
    allowed.allowFileRootForUser(user.userId, unsafe);
  }
  allowed.setFileAdditionalRoots([homedir(), "/"]);

  t.after(() => allowed.setFileAdditionalRoots([]));
  const got = roots.writableRootsForUser(user);

  assert.equal(got.includes(homedir()), false, "the host home must never be mounted");
  assert.equal(got.includes("/"), false, "the filesystem root must never be mounted");
  assert.equal(got.includes(dataRoot), false, "the data root holds every user");
  // The user's own roots are still there; the screen is not a blanket refusal.
  assert.ok(got.includes(user.agentDir));
});

test("an MCP server's default cwd (the home directory) is not mounted", async (t) => {
  const dataRoot = withDataRoot(t);
  const { roots } = await fresh(dataRoot);
  const user = makeUser(dataRoot, "alice");

  // A global `mcp.json` stdio server with no project starts in `homedir()`.
  // Passing that as an extra root must not re-expose the masked home.
  const { command, args } = roots.sandboxCommandForUser(user, "node", ["server.mjs"], [homedir()]);
  assert.equal(command, "bwrap");
  const homeBinds = args.filter((arg, index) => args[index - 1] === "--bind" && arg === homedir());
  assert.deepEqual(homeBinds, [], "binding $HOME after `--tmpfs $HOME` unmasks it");
  assert.ok(args.includes(user.agentDir), "the user's own data is still mounted");
});

test("a project folder is still mounted for a project-scoped MCP server", async (t) => {
  const dataRoot = withDataRoot(t);
  const { roots } = await fresh(dataRoot);
  const user = makeUser(dataRoot, "alice");
  const project = join(dataRoot, "projects", "alice", "repo");
  mkdirSync(project, { recursive: true });

  const { args } = roots.sandboxCommandForUser(user, "node", ["server.mjs"], [project]);
  assert.ok(args.includes(project), "the screening must not break the legitimate case");
});

test("a symlinked root is refused: bwrap resolves a bind source through it", async (t) => {
  const dataRoot = withDataRoot(t);
  const { roots } = await fresh(dataRoot);
  const user = makeUser(dataRoot, "alice");
  const victim = join(dataRoot, "users", "bob");
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, "secrets.json"), '{"probe":"BOB"}\n');
  mkdirSync(user.agentDir, { recursive: true });

  // A link the user can create inside their own writable directory, then name
  // as a root. bwrap mounts what the link points AT, so this would hand them
  // another account's tree without any other mistake being needed.
  const link = join(user.agentDir, "boblink");
  symlinkSync(victim, link);

  const args = roots.sandboxCommandForUser(user, "true", []).args;
  assert.equal(args.includes(link), false, "a symbolic link must never be a bind source");
  assert.equal(args.includes(realpathSync(victim)), false, "nor may its target be bound on its behalf");
});
