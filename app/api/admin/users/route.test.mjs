// Route tests for /api/admin/users (FR-1 user management + RBAC).
import assert from "node:assert/strict";
import test from "node:test";
import { json, setupUsers } from "../../__tests__/route-test-helpers.mjs";

const ACCOUNTS = [
  { username: "admin", password: "adminpass123", role: "admin" },
  { username: "alice", password: "alicepass123", role: "user" },
];

test("/api/admin/users: normal users (and anonymous) are forbidden", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET, POST } = await ctx.load("app/api/admin/users/route.ts");
    assert.equal((await GET(ctx.request("/api/admin/users"))).status, 401);
    assert.equal((await GET(ctx.request("/api/admin/users", { auth: ctx.basic("alice", "alicepass123") }))).status, 403);
    assert.equal((await POST(ctx.request("/api/admin/users", {
      method: "POST", auth: ctx.basic("alice", "alicepass123"), body: { username: "x1", password: "xxxxxxxx" },
    }))).status, 403);
  } finally {
    ctx.cleanup();
  }
});

test("/api/admin/users: admin lists users with no passwordHash leaked", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET } = await ctx.load("app/api/admin/users/route.ts");
    const res = await GET(ctx.request("/api/admin/users", { auth: ctx.basic("admin", "adminpass123") }));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text.includes("passwordHash"), false);
    const body = JSON.parse(text);
    assert.equal(body.users.length, 2);
    assert.equal(body.users.find((u) => u.username === "admin").role, "admin");
  } finally {
    ctx.cleanup();
  }
});

test("/api/admin/users: create provisions an agentDir; duplicate is rejected", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { POST } = await ctx.load("app/api/admin/users/route.ts");
    const auth = ctx.basic("admin", "adminpass123");
    const created = await POST(ctx.request("/api/admin/users", {
      method: "POST", auth, body: { username: "carol", password: "carolpass123", role: "user", displayName: "卡罗" },
    }));
    assert.equal(created.status, 200);
    const { user } = await json(created);
    assert.match(user.id, /^u_[0-9a-f]{12}$/);
    assert.equal(user.displayName, "卡罗");
    assert.equal(user.status, "active");
    assert.ok(ctx.store.resolveUserAgentDir("carol").startsWith(ctx.dataDir));

    const dup = await POST(ctx.request("/api/admin/users", {
      method: "POST", auth, body: { username: "carol", password: "carolpass123" },
    }));
    assert.ok([400, 409].includes(dup.status), `got ${dup.status}`);
  } finally {
    ctx.cleanup();
  }
});

test("/api/admin/users: disabled users are rejected on the very next request", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { PATCH } = await ctx.load("app/api/admin/users/route.ts");
    const { GET } = await ctx.load("app/api/user/me/route.ts");
    const aliceId = ctx.users.alice.id;

    // Alice can authenticate while active.
    assert.equal((await GET(ctx.request("/api/user/me", { auth: ctx.basic("alice", "alicepass123") }))).status, 200);
    // Prime the auth cache with a successful lookup.
    await GET(ctx.request("/api/user/me", { auth: ctx.basic("alice", "alicepass123") }));

    const patch = await PATCH(ctx.request("/api/admin/users", {
      method: "PATCH", auth: ctx.basic("admin", "adminpass123"), body: { userId: aliceId, status: "disabled" },
    }));
    assert.equal(patch.status, 200);

    // FR-1.3: no 5s cache window — the disabled account is refused immediately.
    assert.equal((await GET(ctx.request("/api/user/me", { auth: ctx.basic("alice", "alicepass123") }))).status, 401);
  } finally {
    ctx.cleanup();
  }
});

test("/api/admin/users: an admin cannot demote or disable their own account", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { PATCH } = await ctx.load("app/api/admin/users/route.ts");
    const auth = ctx.basic("admin", "adminpass123");
    const adminId = ctx.users.admin.id;
    assert.equal((await PATCH(ctx.request("/api/admin/users", { method: "PATCH", auth, body: { userId: adminId, status: "disabled" } }))).status, 409);
    assert.equal((await PATCH(ctx.request("/api/admin/users", { method: "PATCH", auth, body: { userId: adminId, role: "user" } }))).status, 409);
  } finally {
    ctx.cleanup();
  }
});

test("/api/admin/users: validates role/status/password inputs", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { PATCH } = await ctx.load("app/api/admin/users/route.ts");
    const auth = ctx.basic("admin", "adminpass123");
    const aliceId = ctx.users.alice.id;
    assert.equal((await PATCH(ctx.request("/api/admin/users", { method: "PATCH", auth, body: { role: "nope" } }))).status, 400);
    assert.equal((await PATCH(ctx.request("/api/admin/users", { method: "PATCH", auth, body: { userId: aliceId, role: "superuser" } }))).status, 400);
    assert.equal((await PATCH(ctx.request("/api/admin/users", { method: "PATCH", auth, body: { userId: aliceId, status: "zombie" } }))).status, 400);
    assert.equal((await PATCH(ctx.request("/api/admin/users", { method: "PATCH", auth, body: { userId: aliceId, password: "short" } }))).status, 400);
  } finally {
    ctx.cleanup();
  }
});
