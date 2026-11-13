import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("createUser persists a scrypt-hashed account; verifyUserCredentials round-trips; duplicates rejected", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-user-store-"));
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const store = await jiti.import("./user-store.ts");
    const user = await store.createUser({ username: "acceptance", password: "accept-pass-123", role: "admin" });
    assert.match(user.id, /^u_[0-9a-f]{12}$/);

    const raw = JSON.parse(readFileSync(store.getUsersFilePath(), "utf8"));
    assert.equal(raw.users.length, 1);
    assert.match(raw.users[0].passwordHash, /^\$scrypt\$16384\$8\$1\$/);

    assert.ok(existsSync(store.resolveUserAgentDir(user.username)), "agentDir keyed by username");
    assert.ok(existsSync(join(store.resolveUserAgentDir(user.username), "sessions")));

    const verified = await store.verifyUserCredentials("acceptance", "accept-pass-123");
    assert.ok(verified, "correct password verifies");
    assert.equal(await store.verifyUserCredentials("acceptance", "wrong-pass"), null);

    await assert.rejects(
      () => store.createUser({ username: "acceptance", password: "accept-pass-123" }),
      (error) => error instanceof store.UserStoreError && /already exists/.test(error.message),
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("first write auto-seeds users.json so proper-lockfile can lock a fresh data root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-user-store-"));
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const store = await jiti.import("./user-store.ts");
    // Regression: proper-lockfile fails with ENOENT when locking a store file
    // that does not exist yet; updateUserStore must seed it before locking.
    await store.createUser({ username: "first", password: "first-pass-123" });
    assert.ok(existsSync(store.getUsersFilePath()));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
