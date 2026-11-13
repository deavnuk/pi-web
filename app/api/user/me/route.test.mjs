// Route tests for /api/user/me (FR-1 identity surface).
import assert from "node:assert/strict";
import test from "node:test";
import { json, setupUsers } from "../../__tests__/route-test-helpers.mjs";

const ACCOUNTS = [
  { username: "admin", password: "adminpass123", role: "admin" },
  { username: "alice", password: "alicepass123", role: "user", displayName: "爱丽丝" },
];

test("/api/user/me: 401 without credentials in multi-user mode", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET } = await ctx.load("app/api/user/me/route.ts");
    const res = await GET(ctx.request("/api/user/me"));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate")?.startsWith("Basic"), true);
  } finally {
    ctx.cleanup();
  }
});

test("/api/user/me: 401 for wrong password and unknown user", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET } = await ctx.load("app/api/user/me/route.ts");
    assert.equal((await GET(ctx.request("/api/user/me", { auth: ctx.basic("alice", "nope") }))).status, 401);
    assert.equal((await GET(ctx.request("/api/user/me", { auth: ctx.basic("ghost", "x") }))).status, 401);
  } finally {
    ctx.cleanup();
  }
});

test("/api/user/me: returns identity and a per-user agentDir under the data root", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET } = await ctx.load("app/api/user/me/route.ts");
    const admin = await json(await GET(ctx.request("/api/user/me", { auth: ctx.basic("admin", "adminpass123") })));
    assert.equal(admin.multiUser, true);
    assert.equal(admin.user.role, "admin");
    assert.equal(admin.user.agentDir, `${ctx.dataDir}/users/admin`);

    const alice = await json(await GET(ctx.request("/api/user/me", { auth: ctx.basic("alice", "alicepass123") })));
    assert.equal(alice.user.role, "user");
    assert.equal(alice.user.displayName, "爱丽丝");
    assert.equal(alice.user.agentDir, `${ctx.dataDir}/users/alice`);
    // Identity and agentDir are never allowed to leak another user's path.
    assert.notEqual(alice.user.agentDir, admin.user.agentDir);
  } finally {
    ctx.cleanup();
  }
});
