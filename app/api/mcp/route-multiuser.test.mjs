// Multi-user route tests for /api/mcp.
//
// The v0.11.0 upstream merge brought a newer MCP settings API (action: "add",
// refusal-shaped errors) that resolved everything through the *global*
// agentDir and called no auth guard, so on the multi-user fork:
//
//   * an anonymous caller could read/write MCP config; and
//   * a user's own servers were listed from / written to the global agentDir
//     instead of their per-user one.
//
// These tests assert the fork re-establishes the per-user boundary on top of
// the newer route: 401 anonymous, and each user's config lives under their
// own agentDir.
import assert from "node:assert/strict";
import test from "node:test";
import { json, setupUsers } from "../__tests__/route-test-helpers.mjs";

const ACCOUNTS = [
  { username: "alice", password: "alicepass123", role: "user" },
  { username: "bob", password: "bobpass123", role: "user" },
];

// A global-scope add that writes <agentDir>/mcp.json, so a per-user run lands
// inside the caller's own directory.
const GLOBAL_ADD = { action: "add", scope: "global", text: "npx -y @scope/alice-mcp" };

test("/api/mcp: anonymous callers are refused on GET and POST", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET, POST } = await ctx.load("app/api/mcp/route.ts");
    assert.equal((await GET(ctx.request("/api/mcp"))).status, 401);
    assert.equal((await POST(ctx.request("/api/mcp", {
      method: "POST", body: { action: "add", scope: "global", text: "npx -y x" },
    }))).status, 401);
  } finally {
    ctx.cleanup();
  }
});

test("/api/mcp: a cwd outside the caller's allowed roots is denied", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET } = await ctx.load("app/api/mcp/route.ts");
    const auth = ctx.basic("alice", "alicepass123");
    // /etc is not under alice's per-user roots.
    assert.equal((await GET(ctx.request("/api/mcp?cwd=/etc", { auth }))).status, 403);
  } finally {
    ctx.cleanup();
  }
});

test("/api/mcp: the caller's global config is their own <agentDir>/mcp.json", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { POST } = await ctx.load("app/api/mcp/route.ts");
    const auth = ctx.basic("alice", "alicepass123");
    const res = await POST(ctx.request("/api/mcp", { method: "POST", auth, body: GLOBAL_ADD }));
    assert.equal(res.status, 200, await res.clone().text());
    const body = await json(res);
    // The global file reported is the caller's own, not a shared machine file.
    const global = body.files.find((file) => file.scope === "global");
    assert.ok(global, "global file listed");
    assert.match(global.path, new RegExp(`^${ctx.users.alice.agentDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    ctx.cleanup();
  }
});

test("/api/mcp: per-user configs are isolated", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET, POST } = await ctx.load("app/api/mcp/route.ts");
    const aliceAuth = ctx.basic("alice", "alicepass123");
    const bobAuth = ctx.basic("bob", "bobpass123");

    const add = await POST(ctx.request("/api/mcp", { method: "POST", auth: aliceAuth, body: GLOBAL_ADD }));
    assert.equal(add.status, 200, await add.clone().text());
    const savedName = (await json(add)).added.name;
    assert.ok(savedName, "add reports the saved server name");

    const alice = await json(await GET(ctx.request("/api/mcp", { auth: aliceAuth })));
    assert.ok(alice.servers.some((s) => s.scope === "global" && s.name === savedName), "alice sees her server");

    const bob = await json(await GET(ctx.request("/api/mcp", { auth: bobAuth })));
    assert.equal(bob.servers.some((s) => s.name === savedName), false, "bob never sees alice's server");
  } finally {
    ctx.cleanup();
  }
});
