// Route tests for /api/push/subscribe (FR-7.4 owner-scoped push).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { json, setupUsers } from "../../__tests__/route-test-helpers.mjs";

const ACCOUNTS = [
  { username: "alice", password: "alicepass123", role: "user" },
  { username: "bob", password: "bobpass123", role: "user" },
];

const sub = (endpoint) => ({
  endpoint,
  keys: { p256dh: "BAbcdefghijklmnop", auth: "authkey" },
});

test("/api/push/subscribe: a valid subscription is accepted and tagged with its owner", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { POST } = await ctx.load("app/api/push/subscribe/route.ts");
    const res = await POST(ctx.request("/api/push/subscribe", {
      method: "POST", auth: ctx.basic("alice", "alicepass123"),
      body: { subscription: sub("https://push.example.com/alice") },
    }));
    assert.equal(res.status, 200);
    assert.equal((await json(res)).ok, true);

    // The store records the owner's userId so delivery can be scoped.
    const store = join(ctx.dataDir, "web-push.json");
    assert.ok(existsSync(store), "push store written");
    const saved = JSON.parse(readFileSync(store, "utf8"));
    const aliceSub = saved.subscriptions.find((s) => s.endpoint === "https://push.example.com/alice");
    assert.ok(aliceSub, "subscription persisted");
    assert.equal(aliceSub.userId, ctx.users.alice.id);
  } finally {
    ctx.cleanup();
  }
});

test("/api/push/subscribe: rejects malformed subscriptions with 400", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { POST } = await ctx.load("app/api/push/subscribe/route.ts");
    const auth = ctx.basic("alice", "alicepass123");
    // http (not https) endpoint
    assert.equal((await POST(ctx.request("/api/push/subscribe", { method: "POST", auth, body: { subscription: sub("http://x.example/a") } }))).status, 400);
    // missing keys
    assert.equal((await POST(ctx.request("/api/push/subscribe", { method: "POST", auth, body: { subscription: { endpoint: "https://x.example/a" } } }))).status, 400);
    // empty keys
    assert.equal((await POST(ctx.request("/api/push/subscribe", { method: "POST", auth, body: { subscription: { endpoint: "https://x.example/a", keys: {} } } }))).status, 400);
  } finally {
    ctx.cleanup();
  }
});
