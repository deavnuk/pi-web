// Route tests for /api/user/append-system (FR-3.6 personal system prompt).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { json, setupUsers } from "../../__tests__/route-test-helpers.mjs";

const ACCOUNTS = [
  { username: "alice", password: "alicepass123", role: "user" },
  { username: "bob", password: "bobpass123", role: "user" },
];

test("/api/user/append-system: round-trips content into <agentDir>/APPEND_SYSTEM.md", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET, PUT } = await ctx.load("app/api/user/append-system/route.ts");
    const auth = ctx.basic("alice", "alicepass123");
    assert.equal((await PUT(ctx.request("/api/user/append-system", { method: "PUT", auth, body: { content: "# 偏好\n- 中文\n" } }))).status, 200);

    const body = await json(await GET(ctx.request("/api/user/append-system", { auth })));
    assert.match(body.content, /偏好/);
    assert.ok(body.updatedAt);

    // The SDK loads <agentDir>/APPEND_SYSTEM.md natively.
    const file = join(ctx.dataDir, "users", "alice", "APPEND_SYSTEM.md");
    assert.ok(existsSync(file));
    assert.match(readFileSync(file, "utf8"), /偏好/);
  } finally {
    ctx.cleanup();
  }
});

test("/api/user/append-system: per-user isolation (bob has an empty fragment)", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET, PUT } = await ctx.load("app/api/user/append-system/route.ts");
    await PUT(ctx.request("/api/user/append-system", {
      method: "PUT", auth: ctx.basic("alice", "alicepass123"), body: { content: "ALICE_MARKER" },
    }));
    const bob = await json(await GET(ctx.request("/api/user/append-system", { auth: ctx.basic("bob", "bobpass123") })));
    // Bob may have a seeded default template, but never alice's text.
    assert.equal(bob.content.includes("ALICE_MARKER"), false);
  } finally {
    ctx.cleanup();
  }
});

test("/api/user/append-system: rejects non-string and >64KB content", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { PUT } = await ctx.load("app/api/user/append-system/route.ts");
    const auth = ctx.basic("alice", "alicepass123");
    assert.equal((await PUT(ctx.request("/api/user/append-system", { method: "PUT", auth, body: { content: 5 } }))).status, 400);
    assert.equal((await PUT(ctx.request("/api/user/append-system", { method: "PUT", auth, body: { content: "x".repeat(70 * 1024) } }))).status, 413);
  } finally {
    ctx.cleanup();
  }
});

test("/api/user/append-system: requires authentication", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET } = await ctx.load("app/api/user/append-system/route.ts");
    assert.equal((await GET(ctx.request("/api/user/append-system"))).status, 401);
  } finally {
    ctx.cleanup();
  }
});
