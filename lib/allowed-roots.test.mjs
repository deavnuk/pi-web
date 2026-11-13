// Per-user allowed roots (sandbox-design.md SB-6).
//
// The bug this guards against: `allowFileRoot()` registered a path for EVERY
// user until restart. Five call sites used it — a worktree, a new session's cwd,
// `/api/cwd/validate`, an approved directory link — so alice creating a session
// in /srv/finance made /srv/finance browsable to bob. The replacement,
// `allowFileRootForUser()`, keeps each registration to one account.
//
// These tests exercise the registry itself; the HTTP consequence (a foreign root
// answers 403) is covered by app/api/files/*-route.test.mjs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });

/** Fresh module state: the registry lives on globalThis, so tests must not share it. */
async function freshRoots() {
  const dataRoot = mkdtempSync(join(tmpdir(), "pi-allowed-roots-"));
  const prevDataRoot = process.env.PI_WEB_DATA_DIR;
  const prevEnvRoots = process.env.PI_SMARTFICC_ADDITIONAL_ROOTS;
  process.env.PI_WEB_DATA_DIR = dataRoot;
  delete process.env.PI_SMARTFICC_ADDITIONAL_ROOTS;
  globalThis.__piUserRuntimeRoots = undefined;
  globalThis.__piAdditionalAllowedRoots = undefined;
  globalThis.__piEnvAdditionalRoots = undefined;
  globalThis.__piFileAdditionalRoots = undefined;
  globalThis.__piAllowedRootsCache = undefined;
  globalThis.__piUserAllowedRootsCache = undefined;

  const mod = await jiti.import("./allowed-roots.ts");
  return {
    mod,
    dataRoot,
    cleanup() {
      globalThis.__piUserRuntimeRoots = undefined;
      globalThis.__piAdditionalAllowedRoots = undefined;
      globalThis.__piEnvAdditionalRoots = undefined;
      globalThis.__piFileAdditionalRoots = undefined;
      globalThis.__piAllowedRootsCache = undefined;
      globalThis.__piUserAllowedRootsCache = undefined;
      if (prevDataRoot === undefined) delete process.env.PI_WEB_DATA_DIR;
      else process.env.PI_WEB_DATA_DIR = prevDataRoot;
      if (prevEnvRoots === undefined) delete process.env.PI_SMARTFICC_ADDITIONAL_ROOTS;
      else process.env.PI_SMARTFICC_ADDITIONAL_ROOTS = prevEnvRoots;
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test("a root registered for one user is invisible to another", async (t) => {
  const ctx = await freshRoots();
  t.after(ctx.cleanup);
  const { allowFileRootForUser, getUserRuntimeRoots } = ctx.mod;

  allowFileRootForUser("u_alice", "/srv/finance-2024");

  assert.deepEqual([...getUserRuntimeRoots("u_alice")], ["/srv/finance-2024"]);
  assert.deepEqual([...getUserRuntimeRoots("u_bob")], [], "bob must not inherit alice's registration");
});

test("a per-user registration never reaches the global additional roots", async (t) => {
  const ctx = await freshRoots();
  t.after(ctx.cleanup);
  const { allowFileRootForUser, getAllAdditionalAllowedRoots } = ctx.mod;

  allowFileRootForUser("u_alice", "/srv/finance-2024");

  // The admin-declared set is the only global one; a user request must not add
  // to it (that was exactly the cross-user pollution).
  assert.deepEqual([...getAllAdditionalAllowedRoots()], []);
});

test("registering a root drops that user's cached root set so it is usable at once", async (t) => {
  const ctx = await freshRoots();
  t.after(ctx.cleanup);
  const { allowFileRootForUser } = ctx.mod;

  // `getUserAllowedRoots()` caches for 5s. Without invalidation a session whose
  // cwd was just registered would 403 until the cache expired.
  globalThis.__piUserAllowedRootsCache = new Map([
    ["u_alice", { roots: new Set(["/cached"]), expiresAt: Date.now() + 60_000 }],
  ]);
  allowFileRootForUser("u_alice", "/srv/finance-2024");
  assert.equal(
    globalThis.__piUserAllowedRootsCache.has("u_alice"),
    false,
    "the stale set must be dropped, not merely added to",
  );
});

test("invalidating one user leaves another user's cache alone", async (t) => {
  const ctx = await freshRoots();
  t.after(ctx.cleanup);
  const { allowFileRootForUser } = ctx.mod;

  const bobEntry = { roots: new Set(["/bob"]), expiresAt: Date.now() + 60_000 };
  globalThis.__piUserAllowedRootsCache = new Map([
    ["u_alice", { roots: new Set(["/alice"]), expiresAt: Date.now() + 60_000 }],
    ["u_bob", bobEntry],
  ]);
  allowFileRootForUser("u_alice", "/srv/finance-2024");
  assert.equal(globalThis.__piUserAllowedRootsCache.get("u_bob"), bobEntry);
});

test("clearing a user's roots forgets every registration for them", async (t) => {
  const ctx = await freshRoots();
  t.after(ctx.cleanup);
  const { allowFileRootForUser, clearUserRuntimeRoots, getUserRuntimeRoots } = ctx.mod;

  allowFileRootForUser("u_alice", "/a");
  allowFileRootForUser("u_alice", "/b");
  allowFileRootForUser("u_bob", "/c");
  assert.equal(getUserRuntimeRoots("u_alice").size, 2);

  clearUserRuntimeRoots("u_alice");
  assert.deepEqual([...getUserRuntimeRoots("u_alice")], []);
  assert.deepEqual([...getUserRuntimeRoots("u_bob")], ["/c"], "bob's roots are untouched");
});

test("the same root spelled differently still matches when checked", async (t) => {
  const ctx = await freshRoots();
  t.after(ctx.cleanup);
  const { allowFileRootForUser, getUserRuntimeRoots } = ctx.mod;
  const { isPathWithinRoots } = await jiti.import("./path-security.ts");

  // Normalization here is only string hygiene (backslashes to slashes): the
  // authorization check resolves both sides itself. What must hold is that a
  // registration is never missed because of how the path was spelled.
  allowFileRootForUser("u_alice", "/srv/finance-2024/");
  const roots = getUserRuntimeRoots("u_alice");
  assert.ok([...roots].every((root) => !root.includes("\\")), "no backslashes survive");
  assert.equal(isPathWithinRoots("/srv/finance-2024/report.csv", roots), true);
  assert.equal(isPathWithinRoots("/srv/finance-2025/report.csv", roots), false);
});

test("an admin-declared shared root still reaches every user", async (t) => {
  const ctx = await freshRoots();
  t.after(ctx.cleanup);
  const { getAllAdditionalAllowedRoots, setFileAdditionalRoots, getFileAdditionalRoots } = ctx.mod;

  mkdirSync(ctx.dataRoot, { recursive: true });
  writeFileSync(join(ctx.dataRoot, "additional-roots.json"), JSON.stringify({ roots: ["/shared/kb"] }));

  // This is the sanctioned way to share: admin writes the file, everyone sees it.
  assert.deepEqual([...getFileAdditionalRoots()], ["/shared/kb"]);
  setFileAdditionalRoots(["/shared/kb", "/shared/workspace"]);
  assert.deepEqual([...getAllAdditionalAllowedRoots()].sort(), ["/shared/kb", "/shared/workspace"]);
});

test("an environment-declared shared root is read once and shared", async (t) => {
  const ctx = await freshRoots();
  t.after(ctx.cleanup);
  process.env.PI_SMARTFICC_ADDITIONAL_ROOTS = "/env/kb";
  globalThis.__piEnvAdditionalRoots = undefined;
  const { getEnvAdditionalRoots } = ctx.mod;

  assert.deepEqual([...getEnvAdditionalRoots()], ["/env/kb"]);
});
