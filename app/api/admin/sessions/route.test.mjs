// Route tests for the admin session browser: RBAC, per-owner scoping, audit.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { json, setupUsers } from "../../__tests__/route-test-helpers.mjs";

const ACCOUNTS = [
  { username: "admin", password: "adminpass123", role: "admin" },
  { username: "alice", password: "alicepass123", role: "user" },
  { username: "bob", password: "bobpass123", role: "user" },
];

/** Minimal valid session jsonl in the given user's own sessions tree. */
function seedSession(agentDir, id, { name, first = "第一条消息" } = {}) {
  const dir = join(agentDir, "sessions", "proj");
  mkdirSync(dir, { recursive: true });
  const timestamp = "2026-10-12T08:00:00.000Z";
  const lines = [
    { type: "session", version: 3, id, timestamp, cwd: "/work/x" },
    ...(name ? [{ type: "session_info", id: "name", parentId: null, timestamp, name }] : []),
    { type: "message", id: "u1", parentId: name ? "name" : null, timestamp, message: { role: "user", content: first } },
    { type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", content: "回复内容" } },
  ];
  writeFileSync(join(dir, `2026-10-12T08-00-00-000Z_${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("/api/admin/sessions: normal users and anonymous are forbidden", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET } = await ctx.load("app/api/admin/sessions/route.ts");
    assert.equal((await GET(ctx.request("/api/admin/sessions"))).status, 401);
    assert.equal((await GET(ctx.request("/api/admin/sessions", { auth: ctx.basic("alice", "alicepass123") }))).status, 403);
  } finally {
    ctx.cleanup();
  }
});

test("/api/admin/sessions: admin sees every user's sessions grouped by cwd", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    seedSession(ctx.users.alice.agentDir, "s-alice", { name: "Alice 会话" });
    seedSession(ctx.users.bob.agentDir, "s-bob", { name: "Bob 会话" });

    const { GET } = await ctx.load("app/api/admin/sessions/route.ts");
    const res = await GET(ctx.request("/api/admin/sessions?force=1", { auth: ctx.basic("admin", "adminpass123") }));
    assert.equal(res.status, 200);
    const body = await json(res);

    const alice = body.owners.find((o) => o.username === "alice");
    const bob = body.owners.find((o) => o.username === "bob");
    assert.deepEqual(alice.groups.map((g) => g.cwd), ["/work/x"]);
    assert.deepEqual(alice.groups[0].sessions.map((s) => s.name), ["Alice 会话"]);
    assert.deepEqual(bob.groups[0].sessions.map((s) => s.name), ["Bob 会话"]);
    // Admin's own empty account is still listed (an admin must see every account).
    assert.ok(body.owners.some((o) => o.username === "admin"));
    // Never leak credentials or absolute agentDirs.
    assert.equal(JSON.stringify(body).includes("passwordHash"), false);
    assert.equal(JSON.stringify(body).includes("/users/alice"), false);
  } finally {
    ctx.cleanup();
  }
});

test("/api/admin/sessions/[id]: owner is required and must be a real user", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    seedSession(ctx.users.alice.agentDir, "s-alice", { name: "Alice 会话" });
    const { GET } = await ctx.load("app/api/admin/sessions/[id]/route.ts");
    const auth = ctx.basic("admin", "adminpass123");

    const noOwner = await GET(ctx.request("/api/admin/sessions/s-alice", { auth }), { params: Promise.resolve({ id: "s-alice" }) });
    assert.equal(noOwner.status, 400);

    const badOwner = await GET(ctx.request("/api/admin/sessions/s-alice?owner=u_nope", { auth }), { params: Promise.resolve({ id: "s-alice" }) });
    assert.equal(badOwner.status, 404);
  } finally {
    ctx.cleanup();
  }
});

test("/api/admin/sessions/[id]: an id outside the named owner's tree is 404", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    seedSession(ctx.users.alice.agentDir, "s-alice", { name: "Alice 会话" });
    seedSession(ctx.users.bob.agentDir, "s-bob", { name: "Bob 会话" });
    const { GET } = await ctx.load("app/api/admin/sessions/[id]/route.ts");
    const auth = ctx.basic("admin", "adminpass123");

    // Asking for alice's session but claiming bob as the owner must not resolve.
    const crossed = await GET(
      ctx.request(`/api/admin/sessions/s-alice?owner=${ctx.users.bob.id}`, { auth }),
      { params: Promise.resolve({ id: "s-alice" }) },
    );
    assert.equal(crossed.status, 404, "must not read across owner boundaries");

    const ok = await GET(
      ctx.request(`/api/admin/sessions/s-alice?owner=${ctx.users.alice.id}`, { auth }),
      { params: Promise.resolve({ id: "s-alice" }) },
    );
    assert.equal(ok.status, 200);
    const body = await json(ok);
    assert.equal(body.readOnly, true);
    assert.equal(body.owner.username, "alice");
    assert.ok(Array.isArray(body.context?.messages), "transcript messages are returned");
    assert.ok(body.context.messages.length >= 2);
    assert.match(JSON.stringify(body.context), /回复内容/);
  } finally {
    ctx.cleanup();
  }
});

test("/api/admin/sessions/[id]: non-admin cannot read another user's transcript", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    seedSession(ctx.users.alice.agentDir, "s-alice", { name: "Alice 会话" });
    const { GET } = await ctx.load("app/api/admin/sessions/[id]/route.ts");
    const res = await GET(
      ctx.request(`/api/admin/sessions/s-alice?owner=${ctx.users.alice.id}`, { auth: ctx.basic("bob", "bobpass123") }),
      { params: Promise.resolve({ id: "s-alice" }) },
    );
    assert.equal(res.status, 403);
  } finally {
    ctx.cleanup();
  }
});

test("either read is recorded in the session-access audit log", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    seedSession(ctx.users.alice.agentDir, "s-alice", { name: "Alice 会话" });
    const { GET: list } = await ctx.load("app/api/admin/sessions/route.ts");
    const { GET: view } = await ctx.load("app/api/admin/sessions/[id]/route.ts");
    const auth = ctx.basic("admin", "adminpass123");

    assert.equal((await list(ctx.request("/api/admin/sessions?force=1", { auth }))).status, 200);
    assert.equal((await view(
      ctx.request(`/api/admin/sessions/s-alice?owner=${ctx.users.alice.id}`, { auth }),
      { params: Promise.resolve({ id: "s-alice" }) },
    )).status, 200);

    const root = join(ctx.dataDir, "audit");
    assert.ok(existsSync(root), "audit directory was created");
    // Find the newest session-access.jsonl (month folder).
    const { readdirSync } = await import("node:fs");
    const months = readdirSync(root).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort();
    assert.ok(months.length > 0);
    const log = readFileSync(join(root, months[months.length - 1], "session-access.jsonl"), "utf8");
    const entries = log.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(entries.some((e) => e.action === "list" && e.actor === "admin"));
    const viewed = entries.find((e) => e.action === "view");
    assert.ok(viewed, "the transcript view is audited");
    assert.equal(viewed.actor, "admin");
    assert.equal(viewed.target, "alice");
    assert.equal(viewed.sessionId, "s-alice");
  } finally {
    ctx.cleanup();
  }
});
