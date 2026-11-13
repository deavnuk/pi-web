// Route tests for /api/user/password (FR-2.3 self-service password change).
import assert from "node:assert/strict";
import test from "node:test";
import { json, setupUsers } from "../../__tests__/route-test-helpers.mjs";

const ACCOUNTS = [{ username: "alice", password: "alicepass123", role: "user" }];

test("/api/user/password: rejects a wrong current password with 403", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { POST } = await ctx.load("app/api/user/password/route.ts");
    const res = await POST(ctx.request("/api/user/password", {
      method: "POST", auth: ctx.basic("alice", "alicepass123"),
      body: { currentPassword: "wrong", newPassword: "newpass123" },
    }));
    assert.equal(res.status, 403);
  } finally {
    ctx.cleanup();
  }
});

test("/api/user/password: rejects a too-short new password with 400", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { POST } = await ctx.load("app/api/user/password/route.ts");
    const res = await POST(ctx.request("/api/user/password", {
      method: "POST", auth: ctx.basic("alice", "alicepass123"),
      body: { currentPassword: "alicepass123", newPassword: "short" },
    }));
    assert.equal(res.status, 400);
  } finally {
    ctx.cleanup();
  }
});

test("/api/user/password: a valid change takes effect for the next request", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { POST } = await ctx.load("app/api/user/password/route.ts");
    const { GET } = await ctx.load("app/api/user/me/route.ts");
    const res = await POST(ctx.request("/api/user/password", {
      method: "POST", auth: ctx.basic("alice", "alicepass123"),
      body: { currentPassword: "alicepass123", newPassword: "brandnew123" },
    }));
    assert.equal(res.status, 200);
    assert.equal((await json(res)).success, true);

    // The auth cache must be invalidated so the new password works immediately.
    assert.equal((await GET(ctx.request("/api/user/me", { auth: ctx.basic("alice", "brandnew123") }))).status, 200);
  } finally {
    ctx.cleanup();
  }
});

test("/api/user/password: requires authentication", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { POST } = await ctx.load("app/api/user/password/route.ts");
    const res = await POST(ctx.request("/api/user/password", {
      method: "POST", body: { currentPassword: "a", newPassword: "brandnew123" },
    }));
    assert.equal(res.status, 401);
  } finally {
    ctx.cleanup();
  }
});
