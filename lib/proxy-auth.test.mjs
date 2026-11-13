// Unit tests for lib/proxy-auth.ts — the edge-runtime fast path of the
// multi-user proxy. This is a UX gate (a full scrypt check happens per route
// in requireAuth), so it must be *conservative*: it accepts only a
// well-formed Basic header naming a known, active username, and never a
// malformed or unknown one.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });

const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

async function withStore(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-proxy-auth-"));
  const prevData = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  globalThis.__piUserStoreCache = undefined;
  try {
    const store = await jiti.import("@/lib/user-store.ts");
    const { verifyUserCredentialsSyncHint } = await jiti.import("@/lib/proxy-auth.ts");
    return await fn({ store, verifyUserCredentialsSyncHint });
  } finally {
    globalThis.__piUserStoreCache = undefined;
    if (prevData === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = prevData;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("proxy-auth: accepts a well-formed Basic header for a known active user", async () => {
  await withStore(async ({ store, verifyUserCredentialsSyncHint }) => {
    await store.createUser({ username: "alice", password: "alicepass123", role: "user" });
    assert.equal(verifyUserCredentialsSyncHint(basic("alice", "anything")), true);
  });
});

test("proxy-auth: rejects missing, malformed, unknown and disabled credentials", async () => {
  await withStore(async ({ store, verifyUserCredentialsSyncHint }) => {
    const account = await store.createUser({ username: "alice", password: "alicepass123", role: "user" });
    assert.equal(verifyUserCredentialsSyncHint(null), false);
    assert.equal(verifyUserCredentialsSyncHint(""), false);
    assert.equal(verifyUserCredentialsSyncHint("Bearer abc"), false);
    // Basic with no colon separator.
    assert.equal(verifyUserCredentialsSyncHint("Basic " + Buffer.from("nocolon").toString("base64")), false);
    assert.equal(verifyUserCredentialsSyncHint(basic("ghost", "x")), false);

    await store.setUserStatus(account.id, "disabled");
    assert.equal(verifyUserCredentialsSyncHint(basic("alice", "alicepass123")), false);
  });
});

test("proxy-auth: an unknown account returns false", async () => {
  await withStore(async ({ store, verifyUserCredentialsSyncHint }) => {
    await store.createUser({ username: "alice", password: "alicepass123", role: "user" });
    assert.equal(verifyUserCredentialsSyncHint(basic("nobody", "whatever")), false);
  });
});
