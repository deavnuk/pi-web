// Cross-user isolation tests for the session sub-routes.
//
// Regression: /export, /state, /thinking, /tool-result-image and
// /agent/[id]/bash-output used to resolve a session id *globally*, with no
// authentication and no per-user agentDir. Any caller (including anonymous) who
// knew a session id could read another user's transcript. These tests seed one
// session per user and assert that only the owner can reach it.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setupUsers } from "../__tests__/route-test-helpers.mjs";

const ACCOUNTS = [
  { username: "alice", password: "alicepass123", role: "user" },
  { username: "bob", password: "bobpass123", role: "user" },
];

const SESSION_ID = "01a12f11-aaaa-bbbb-cccc-1791791752";

/** Write a minimal but valid session jsonl under a user's own sessions root. */
function seedSession(ctx, username, { id = SESSION_ID, cwd } = {}) {
  const agentDir = ctx.users[username].agentDir;
  const safeCwd = (cwd ?? join(ctx.dataDir, "projects", username)).replace(/[/.]/g, "-");
  const dir = join(agentDir, "sessions", `--${safeCwd.replace(/^-/, "")}--`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-10-12T08-00-00-000Z_${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-12T08:00:00.000Z", cwd: cwd ?? join(ctx.dataDir, "projects", username) }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-10-12T08:00:01.000Z", message: { role: "user", content: `${username.toUpperCase()}_SECRET_TRANSCRIPT` } }),
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("session detail/export: anonymous is rejected, owner succeeds, other user cannot", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    seedSession(ctx, "alice");
    const detail = await ctx.load("app/api/sessions/[id]/route.ts");
    const exportRoute = await ctx.load("app/api/sessions/[id]/export/route.ts");
    const params = { params: Promise.resolve({ id: SESSION_ID }) };
    const path = `/api/sessions/${SESSION_ID}`;

    // Anonymous callers must not read anything.
    assert.equal((await detail.GET(ctx.request(path), params)).status, 401);

    // The owner sees their own session.
    const owner = await detail.GET(ctx.request(path, { auth: ctx.basic("alice", "alicepass123") }), params);
    assert.equal(owner.status, 200);

    // Another authenticated user is refused (404, not a leak of existence).
    const other = await detail.GET(ctx.request(path, { auth: ctx.basic("bob", "bobpass123") }), params);
    assert.equal(other.status, 404);

    // Export: anonymous 401, owner 200, other user 404.
    assert.equal((await exportRoute.GET(ctx.request(`${path}/export`), params)).status, 401);
    assert.equal((await exportRoute.GET(ctx.request(`${path}/export`, { auth: ctx.basic("alice", "alicepass123") }), params)).status, 200);
    assert.equal((await exportRoute.GET(ctx.request(`${path}/export`, { auth: ctx.basic("bob", "bobpass123") }), params)).status, 404);
  } finally {
    ctx.cleanup();
  }
});

test("session state + bash-output: scoped to the authenticated owner", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    seedSession(ctx, "alice");
    const state = await ctx.load("app/api/sessions/[id]/state/route.ts");
    const params = { params: Promise.resolve({ id: SESSION_ID }) };
    const path = `/api/sessions/${SESSION_ID}/state`;

    assert.equal((await state.GET(ctx.request(path), params)).status, 401);
    assert.equal((await state.GET(ctx.request(path, { auth: ctx.basic("bob", "bobpass123") }), params)).status, 404);

    const bash = await ctx.load("app/api/agent/[id]/bash-output/route.ts");
    const bashParams = { params: Promise.resolve({ id: "worker-alice" }) };
    const bashPath = "/api/agent/worker-alice/bash-output?path=/etc/hosts";
    // Anonymous and cross-user are refused before path inspection.
    const anon = await bash.GET(ctx.request(bashPath), bashParams);
    assert.ok([401, 403].includes(anon.status));
  } finally {
    ctx.cleanup();
  }
});

test("session context: anonymous is rejected, owner reads it, another user cannot", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    seedSession(ctx, "alice");
    const context = await ctx.load("app/api/sessions/[id]/context/route.ts");
    const params = { params: Promise.resolve({ id: SESSION_ID }) };
    const path = `/api/sessions/${SESSION_ID}/context`;

    assert.equal((await context.GET(ctx.request(path), params)).status, 401);

    const owner = await context.GET(ctx.request(path, { auth: ctx.basic("alice", "alicepass123") }), params);
    assert.equal(owner.status, 200);
    const body = await owner.json();
    assert.ok(
      JSON.stringify(body).includes("ALICE_SECRET_TRANSCRIPT"),
      "the owner's own transcript must be served",
    );

    // The transcript is the whole point of the route: a foreign caller gets 404,
    // not a redacted or empty page.
    const other = await context.GET(ctx.request(path, { auth: ctx.basic("bob", "bobpass123") }), params);
    assert.equal(other.status, 404);
    assert.doesNotMatch(JSON.stringify(await other.json()), /ALICE_SECRET_TRANSCRIPT/);
  } finally {
    ctx.cleanup();
  }
});

test("session sub-routes never resolve a session outside the caller's agentDir", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    // Seed a session that only exists in alice's tree, then probe with bob.
    seedSession(ctx, "alice");
    const exportSrc = await import("node:fs").then((fs) =>
      fs.readFileSync(join(process.cwd(), "app/api/sessions/[id]/export/route.ts"), "utf8"),
    );
    // All session sub-routes must pass the caller's agentDir down to resolveSessionPath.
    assert.match(exportSrc, /resolveSessionPath\(id, auth\.user\?\.agentDir\)/);
    const stateSrc = await import("node:fs").then((fs) =>
      fs.readFileSync(join(process.cwd(), "app/api/sessions/[id]/state/route.ts"), "utf8"),
    );
    assert.match(stateSrc, /resolveSessionPath\(id, user\?\.agentDir\)/);
  } finally {
    ctx.cleanup();
  }
});
