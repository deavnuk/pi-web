// Route tests for /api/user/secrets (NFR-2 / FR-3.5): per-user secret vault.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { json, setupUsers } from "../../__tests__/route-test-helpers.mjs";

const ACCOUNTS = [
  { username: "alice", password: "alicepass123", role: "user" },
  { username: "bob", password: "bobpass123", role: "user" },
];

test("/api/user/secrets: requires authentication", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET } = await ctx.load("app/api/user/secrets/route.ts");
    assert.equal((await GET(ctx.request("/api/user/secrets"))).status, 401);
  } finally {
    ctx.cleanup();
  }
});

test("/api/user/secrets: PUT stores only in the caller's agentDir; value never echoed", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET, PUT } = await ctx.load("app/api/user/secrets/route.ts");
    const value = "super-secret-token-value";
    const putRes = await PUT(ctx.request("/api/user/secrets", {
      method: "PUT", auth: ctx.basic("alice", "alicepass123"), body: { name: "RY_TOKEN", value },
    }));
    assert.equal(putRes.status, 200);

    const aliceGet = await GET(ctx.request("/api/user/secrets", { auth: ctx.basic("alice", "alicepass123") }));
    const aliceText = await aliceGet.clone().text();
    const alice = await json(aliceGet);
    assert.equal(alice.secrets.find((s) => s.name === "RY_TOKEN")?.configured, true);
    // NFR-2: the plaintext value must never be returned by the API.
    assert.equal(aliceText.includes(value), false);

    // Isolation: bob's view does not contain alice's secret at all.
    const bob = await json(await GET(ctx.request("/api/user/secrets", { auth: ctx.basic("bob", "bobpass123") })));
    assert.equal(bob.secrets.some((s) => s.name === "RY_TOKEN"), false);

    // On-disk: the secret lives under alice's dir, not bob's.
    const aliceFile = join(ctx.dataDir, "users", "alice", "secrets.json");
    assert.ok(existsSync(aliceFile));
    assert.match(readFileSync(aliceFile, "utf8"), /RY_TOKEN/);
    const bobFile = join(ctx.dataDir, "users", "bob", "secrets.json");
    if (existsSync(bobFile)) assert.equal(readFileSync(bobFile, "utf8").includes("RY_TOKEN"), false);
  } finally {
    ctx.cleanup();
  }
});

test("/api/user/secrets: null value removes the secret; bad name rejected", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET, PUT } = await ctx.load("app/api/user/secrets/route.ts");
    const auth = ctx.basic("alice", "alicepass123");
    await PUT(ctx.request("/api/user/secrets", { method: "PUT", auth, body: { name: "TMP", value: "x" } }));
    assert.equal((await PUT(ctx.request("/api/user/secrets", { method: "PUT", auth, body: { name: "TMP", value: null } }))).status, 200);
    const after = await json(await GET(ctx.request("/api/user/secrets", { auth })));
    assert.equal(after.secrets.some((s) => s.name === "TMP" && s.configured), false);

    assert.equal((await PUT(ctx.request("/api/user/secrets", { method: "PUT", auth, body: { name: "", value: "x" } }))).status, 400);
    assert.equal((await PUT(ctx.request("/api/user/secrets", { method: "PUT", auth, body: { name: "X", value: 5 } }))).status, 400);
  } finally {
    ctx.cleanup();
  }
});

test("/api/user/secrets: cross-origin PUT is rejected (CSRF guard)", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { PUT } = await ctx.load("app/api/user/secrets/route.ts");
    const res = await PUT(ctx.request("/api/user/secrets", {
      method: "PUT",
      auth: ctx.basic("alice", "alicepass123"),
      headers: { origin: "http://evil.example.com" },
      body: { name: "X", value: "y" },
    }));
    assert.equal(res.status, 403);
  } finally {
    ctx.cleanup();
  }
});
