// Unit tests for lib/user-auth.ts — the per-route authentication boundary of
// the multi-user fork. These cover the pure decision surface (context
// building, the auth cache and its invalidation, the admin guard, and the
// path-containment helpers) without needing a running Next.js server.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });

async function withDataRoot(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-user-auth-"));
  const prevData = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  globalThis.__piAuthCache?.clear();
  globalThis.__piUserStoreCache = undefined;
  try {
    const store = await jiti.import("@/lib/user-store.ts");
    const auth = await jiti.import("@/lib/user-auth.ts");
    return await fn({ dataDir, store, auth });
  } finally {
    globalThis.__piAuthCache?.clear();
    globalThis.__piUserStoreCache = undefined;
    if (prevData === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = prevData;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

test("buildUserContext: maps role, agentDir and default project root", async () => {
  await withDataRoot(async ({ dataDir, auth, store }) => {
    const ctx = auth.buildUserContext({
      id: "u_123", username: "alice", role: "admin", tenantId: "t1", skills: ["s@1.0.0"],
    });
    assert.equal(ctx.userId, "u_123");
    assert.equal(ctx.username, "alice");
    assert.equal(ctx.role, "admin");
    assert.equal(ctx.skills[0], "s@1.0.0");
    assert.equal(ctx.agentDir, store.resolveUserAgentDir("alice"));
    assert.deepEqual(ctx.allowedRoots, [join(dataDir, "projects", "alice")]);
    // An unknown role is coerced to the least privilege.
    assert.equal(auth.buildUserContext({ id: "x", username: "bob", role: "superuser", tenantId: "t" }).role, "user");
  });
});

test("requireAuth: 401 anonymous in multi-user, verified user otherwise", async () => {
  await withDataRoot(async ({ auth, store }) => {
    await store.createUser({ username: "alice", password: "alicepass123", role: "user" });

    const anon = await auth.requireAuth(new Request("http://localhost/api/x"));
    assert.ok("response" in anon);
    assert.equal(anon.response.status, 401);
    assert.equal(anon.response.headers.get("www-authenticate")?.startsWith("Basic"), true);

    const ok = await auth.requireAuth(new Request("http://localhost/api/x", {
      headers: { authorization: basic("alice", "alicepass123") },
    }));
    assert.ok("user" in ok);
    assert.equal(ok.user.username, "alice");

    const bad = await auth.requireAuth(new Request("http://localhost/api/x", {
      headers: { authorization: basic("alice", "wrong") },
    }));
    assert.ok("response" in bad);
    assert.equal(bad.response.status, 401);
  });
});

test("requireAdmin: 403 for a normal user, admin passes", async () => {
  await withDataRoot(async ({ auth, store }) => {
    await store.createUser({ username: "admin", password: "adminpass123", role: "admin" });
    await store.createUser({ username: "alice", password: "alicepass123", role: "user" });

    const normal = await auth.requireAdmin(new Request("http://localhost/api/x", {
      headers: { authorization: basic("alice", "alicepass123") },
    }));
    assert.ok("response" in normal);
    assert.equal(normal.response.status, 403);

    const admin = await auth.requireAdmin(new Request("http://localhost/api/x", {
      headers: { authorization: basic("admin", "adminpass123") },
    }));
    assert.ok("user" in admin);
    assert.equal(admin.user.role, "admin");
  });
});

test("invalidateUserStoreCache drops the 5s auth cache (disabled user is refused at once)", async () => {
  await withDataRoot(async ({ auth, store }) => {
    const account = await store.createUser({ username: "alice", password: "alicepass123", role: "user" });
    const req = () => new Request("http://localhost/api/x", {
      headers: { authorization: basic("alice", "alicepass123") },
    });

    // Prime the cache with a successful lookup.
    assert.equal((await auth.resolveAuthUser(req()))?.username, "alice");

    // Disable the account; without the auth-cache drop the cached context
    // would keep authenticating for up to 5 seconds.
    await store.setUserStatus(account.id, "disabled");
    assert.equal(await auth.resolveAuthUser(req()), null);
  });
});

test("isSessionFileForUser / isWithinUserAgentDir: containment checks", async () => {
  await withDataRoot(async ({ auth, store, dataDir }) => {
    const ctx = auth.buildUserContext({ id: "u1", username: "alice", role: "user", tenantId: "t" });
    const sessionsRoot = join(ctx.agentDir, "sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    const own = join(sessionsRoot, "x.jsonl");
    writeFileSync(own, "{}\n");

    assert.equal(auth.isSessionFileForUser(own, ctx), true);
    // No anonymous caller exists any more: a null user owns nothing.
    assert.equal(auth.isSessionFileForUser(own, null), false, "a null user owns no session");
    // A file outside the user's sessions root is refused.
    const foreign = join(dataDir, "users", "bob", "sessions", "x.jsonl");
    assert.equal(auth.isSessionFileForUser(foreign, ctx), false);
    // A non-existent path under the root is refused (must exist).
    assert.equal(auth.isSessionFileForUser(join(sessionsRoot, "missing.jsonl"), ctx), false);

    assert.equal(auth.isWithinUserAgentDir(join(ctx.agentDir, "a", "b"), ctx), true);
    assert.equal(auth.isWithinUserAgentDir(foreign, ctx), false);
    assert.equal(auth.isWithinUserAgentDir(ctx.agentDir, ctx), false, "the dir itself is not within itself");
    void store;
  });
});

test("effectiveAgentDir is the requesting user's own agentDir", async () => {
  const auth = await jiti.import("@/lib/user-auth.ts");
  assert.equal(auth.effectiveAgentDir({ agentDir: "/tmp/pi-user-dir" }), "/tmp/pi-user-dir");
});
