// Ownership of a live, in-process session (lib/session-ownership.ts).
//
// On-disk sessions are scoped by `resolveSessionPath(id, user.agentDir)`, but a
// live session may not have a JSONL file yet. Routing by id alone would hand
// one user's running session to any caller who knows its id, so the state route
// asks this module instead. Both shapes must be recognized:
//  - a worker proxy, by the owner id it carries;
//  - a local wrapper, by the sessions root its file lives in.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { ownsLiveSession } = await jiti.import("./session-ownership.ts");

function user(agentDir, extra = {}) {
  return { userId: "u_alice", username: "alice", role: "user", tenantId: "t", agentDir, allowedRoots: [], skills: [], ...extra };
}

/** A session file path inside `agentDir`'s sessions root. */
function sessionFileIn(agentDir, name = "s.jsonl") {
  const dir = join(agentDir, "sessions", "--project--");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "{}\n");
  return file;
}

test("a local wrapper is owned by whoever's sessions root holds its file", (t) => {
  const base = mkdtempSync(join(tmpdir(), "pi-ownership-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const alice = join(base, "users", "alice");
  const bob = join(base, "users", "bob");
  const aliceFile = sessionFileIn(alice);
  const bobFile = sessionFileIn(bob);

  const aliceUser = user(alice);
  const bobUser = user(bob, { userId: "u_bob", username: "bob" });

  assert.equal(ownsLiveSession({ sessionFile: aliceFile }, aliceUser), true);
  assert.equal(ownsLiveSession({ sessionFile: aliceFile }, bobUser), false, "bob must not own alice's live session");
  assert.equal(ownsLiveSession({ sessionFile: bobFile }, aliceUser), false);
});

test("ownership is by location, so the file need not exist yet", (t) => {
  const base = mkdtempSync(join(tmpdir(), "pi-ownership-ghost-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const alice = join(base, "users", "alice");

  // A live session that has appended nothing has no file on disk. Looking it up
  // through the path resolver would therefore find nothing and answer 404.
  const ghost = join(alice, "sessions", "--project--", "not-written-yet.jsonl");
  assert.equal(ownsLiveSession({ sessionFile: ghost }, user(alice)), true);
});

test("a worker proxy is owned by the id it carries, not by its path", (t) => {
  const base = mkdtempSync(join(tmpdir(), "pi-ownership-proxy-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const alice = join(base, "users", "alice");
  const aliceFile = sessionFileIn(alice);

  // Structural shape across webpack bundles: the tag plus a userId string.
  const proxy = { __piWorkerSessionProxy: true, userId: "u_alice", sessionFile: aliceFile };
  assert.equal(ownsLiveSession(proxy, user(alice)), true);
  assert.equal(ownsLiveSession(proxy, user(alice, { userId: "u_bob" })), false);

  // A proxy whose owner id disagrees with the file's location follows the id:
  // the worker is authoritative about who is running the session.
  const bob = join(base, "users", "bob");
  const bobFile = sessionFileIn(bob);
  assert.equal(
    ownsLiveSession({ __piWorkerSessionProxy: true, userId: "u_bob", sessionFile: bobFile }, user(alice, { userId: "u_bob" })),
    true,
  );
});

test("no user owns a live session (there is no anonymous caller)", (t) => {
  const base = mkdtempSync(join(tmpdir(), "pi-ownership-anon-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const alice = join(base, "users", "alice");
  const aliceFile = sessionFileIn(alice);

  assert.equal(ownsLiveSession({ sessionFile: aliceFile }, null), false);
  assert.equal(ownsLiveSession({ __piWorkerSessionProxy: true, userId: "u_alice" }, null), false);
});

test("a session with no file at all is owned by nobody", () => {
  const alice = user("/tmp/does-not-matter");
  assert.equal(ownsLiveSession({}, alice), false);
  assert.equal(ownsLiveSession({ sessionFile: undefined }, alice), false);
  assert.equal(ownsLiveSession({ sessionFile: "" }, alice), false);
});
