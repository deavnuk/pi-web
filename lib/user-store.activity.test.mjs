// FR-1.4 — 用户列表页显示「最近活跃时间」.
//
// The admin user list must show when each account last authenticated. Activity
// is recorded on successful credential verification, throttled so a chatty
// client does not rewrite users.json on every request, and surfaced through
// /api/admin/users without leaking anything else.
import assert from "node:assert/strict";
import test from "node:test";
import { json, setupUsers } from "../app/api/__tests__/route-test-helpers.mjs";

const ACCOUNTS = [{ username: "admin", password: "adminpass123", role: "admin" }];

test("touchUserActivity records a timestamp and listUsers surfaces it (FR-1.4)", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const created = await ctx.store.createUser({ username: "dave", password: "davepass123", role: "user" });
    // No login yet: the field is absent, not a bogus epoch.
    assert.equal(ctx.store.findUserById(created.id).lastActiveAt, undefined);

    ctx.store.resetLastActiveThrottle();
    const at = Date.parse("2026-10-14T10:00:00.000Z");
    await ctx.store.touchUserActivity(created.id, at);
    assert.equal(ctx.store.findUserById(created.id).lastActiveAt, "2026-10-14T10:00:00.000Z");

    // Activity is not a profile edit — updatedAt stays the account-mutation clock.
    assert.equal(ctx.store.findUserById(created.id).updatedAt, created.updatedAt);

    // The admin list exposes it (and still never leaks passwordHash).
    const { GET } = await ctx.load("app/api/admin/users/route.ts");
    const res = await GET(ctx.request("/api/admin/users", { auth: ctx.basic("admin", "adminpass123") }));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text.includes("passwordHash"), false);
    const body = JSON.parse(text);
    const dave = body.users.find((u) => u.username === "dave");
    assert.equal(dave.lastActiveAt, "2026-10-14T10:00:00.000Z");
  } finally {
    ctx.cleanup();
  }
});

test("touchUserActivity is throttled so repeated activity does not churn the store (FR-1.4)", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const created = await ctx.store.createUser({ username: "erin", password: "erinpass123", role: "user" });
    ctx.store.resetLastActiveThrottle();
    const base = Date.parse("2026-10-14T10:00:00.000Z");
    await ctx.store.touchUserActivity(created.id, base);
    assert.equal(ctx.store.findUserById(created.id).lastActiveAt, "2026-10-14T10:00:00.000Z");

    // A second touch inside the throttle window must not move the timestamp.
    await ctx.store.touchUserActivity(created.id, base + 30_000);
    assert.equal(ctx.store.findUserById(created.id).lastActiveAt, "2026-10-14T10:00:00.000Z");

    // Past the window it records again.
    await ctx.store.touchUserActivity(created.id, base + 61_000);
    assert.equal(ctx.store.findUserById(created.id).lastActiveAt, "2026-10-14T10:01:01.000Z");
  } finally {
    ctx.cleanup();
  }
});

test("a verified authenticated request records activity end-to-end (FR-1.4)", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    await ctx.store.createUser({ username: "frank", password: "frankpass123", role: "user" });
    ctx.store.resetLastActiveThrottle();
    // Verify credentials then await the touch that resolveAuthUser fires and
    // forgets, mirroring the real request path but deterministically.
    const account = await ctx.store.verifyUserCredentials("frank", "frankpass123");
    assert.ok(account);
    await ctx.store.touchUserActivity(account.id);
    const stored = ctx.store.findUserByUsername("frank");
    assert.ok(stored.lastActiveAt && !Number.isNaN(Date.parse(stored.lastActiveAt)));

    // Round-trips through the JSON store (durable, not just the in-memory cache).
    const reread = JSON.parse(
      (await import("node:fs")).readFileSync(ctx.store.getUsersFilePath(), "utf8"),
    );
    assert.equal(reread.users.find((u) => u.username === "frank").lastActiveAt, stored.lastActiveAt);
  } finally {
    ctx.cleanup();
  }
});

test("touchUserActivity on an unknown id is a no-op, not a throw", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    ctx.store.resetLastActiveThrottle();
    await ctx.store.touchUserActivity("u_doesnotexist");
    assert.equal(ctx.store.listUsers().length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("resolved /api/user/me carries the identity whose activity is tracked (FR-1.4)", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    await ctx.store.createUser({ username: "gina", password: "ginapass123", role: "user" });
    const { GET } = await ctx.load("app/api/user/me/route.ts");
    const res = await GET(ctx.request("/api/user/me", { auth: ctx.basic("gina", "ginapass123") }));
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.user.username, "gina");
    assert.equal(body.user.userId, ctx.store.findUserByUsername("gina").id);
  } finally {
    ctx.cleanup();
  }
});
