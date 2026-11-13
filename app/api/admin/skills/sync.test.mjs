// Route tests for /api/admin/skills/{sync,sync-log,auto-update} (FR-4.7/4.8).
import assert from "node:assert/strict";
import test from "node:test";
import { json, setupUsers } from "../../__tests__/route-test-helpers.mjs";

const ACCOUNTS = [
  { username: "admin", password: "adminpass123", role: "admin" },
  { username: "alice", password: "alicepass123", role: "user" },
];

test("/api/admin/skills/sync: admin-only; requires a target", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { POST } = await ctx.load("app/api/admin/skills/sync/route.ts");
    assert.equal((await POST(ctx.request("/api/admin/skills/sync", { method: "POST", body: {} }))).status, 401);
    assert.equal((await POST(ctx.request("/api/admin/skills/sync", { method: "POST", auth: ctx.basic("alice", "alicepass123"), body: { all: true } }))).status, 403);

    const auth = ctx.basic("admin", "adminpass123");
    assert.equal((await POST(ctx.request("/api/admin/skills/sync", { method: "POST", auth, body: {} }))).status, 400);
    const all = await POST(ctx.request("/api/admin/skills/sync", { method: "POST", auth, body: { all: true } }));
    assert.equal(all.status, 200);
    assert.ok(Array.isArray((await json(all)).results));
    // Cross-origin rejected.
    assert.equal((await POST(ctx.request("/api/admin/skills/sync", { method: "POST", auth, headers: { origin: "http://evil.example.com" }, body: { all: true } }))).status, 403);
  } finally {
    ctx.cleanup();
  }
});

test("/api/admin/skills/sync-log: admin-only and returns entry array", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET } = await ctx.load("app/api/admin/skills/sync-log/route.ts");
    assert.equal((await GET(ctx.request("/api/admin/skills/sync-log"))).status, 401);
    assert.equal((await GET(ctx.request("/api/admin/skills/sync-log", { auth: ctx.basic("alice", "alicepass123") }))).status, 403);
    const body = await json(await GET(ctx.request("/api/admin/skills/sync-log?limit=10", { auth: ctx.basic("admin", "adminpass123") })));
    assert.ok(Array.isArray(body.entries));
  } finally {
    ctx.cleanup();
  }
});

test("/api/admin/skills/auto-update: admin-only; GET reports configured source", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET, POST } = await ctx.load("app/api/admin/skills/auto-update/route.ts");
    assert.equal((await GET(ctx.request("/api/admin/skills/auto-update"))).status, 401);
    assert.equal((await POST(ctx.request("/api/admin/skills/auto-update", { method: "POST" }))).status, 401);
    const auth = ctx.basic("admin", "adminpass123");
    const body = await json(await GET(ctx.request("/api/admin/skills/auto-update", { auth })));
    assert.equal(body.source, null);
    assert.equal(typeof body.credentialsConfigured, "boolean");
    // With no git source configured, a run is a no-op success.
    const run = await POST(ctx.request("/api/admin/skills/auto-update", { method: "POST", auth }));
    assert.equal(run.status, 200);
  } finally {
    ctx.cleanup();
  }
});
