// FR-6.1 / FR-6.2 — built-in admin bootstrap and legacy single-user data
// attribution.
//
// Upgrading a single-user deployment to multi-user must NOT move or copy any
// data: the pre-existing global agentDir (~/.pi/agent, PI_CODING_AGENT_DIR)
// becomes the built-in admin's data home in place, and single-user mode stays
// byte-for-byte unchanged.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });

/** Isolated dataRoot + a fake legacy global agentDir with pre-existing data. */
function setup({ password } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-bootstrap-"));
  const globalAgent = mkdtempSync(join(tmpdir(), "pi-legacy-agent-"));
  const prev = {
    dataDir: process.env.PI_WEB_DATA_DIR,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    password: process.env.PI_SMARTFICC_ADMIN_PASSWORD,
  };
  process.env.PI_WEB_DATA_DIR = dataDir;
  process.env.PI_CODING_AGENT_DIR = globalAgent;
  if (password) process.env.PI_SMARTFICC_ADMIN_PASSWORD = password;
  else delete process.env.PI_SMARTFICC_ADMIN_PASSWORD;
  globalThis.__piAuthCache?.clear();
  globalThis.__piUserStoreCache = undefined;

  return {
    dataDir,
    globalAgent,
    cleanup() {
      globalThis.__piAuthCache?.clear();
      globalThis.__piUserStoreCache = undefined;
      for (const [key, value] of Object.entries({
        PI_WEB_DATA_DIR: prev.dataDir,
        PI_CODING_AGENT_DIR: prev.agentDir,
        PI_SMARTFICC_ADMIN_PASSWORD: prev.password,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(globalAgent, { recursive: true, force: true });
    },
  };
}

test("bootstrapBuiltinAdmin: adopts the legacy global agentDir with no data move (FR-6.1)", async () => {
  const ctx = setup();
  try {
    // Pre-existing single-user data that must survive untouched.
    const sessions = join(ctx.globalAgent, "sessions", "proj");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "old.jsonl"), '{"type":"session"}\n');
    writeFileSync(join(ctx.globalAgent, "auth.json"), '{"anthropic":{"apiKey":"legacy-key"}}\n');

    const store = await jiti.import("@/lib/user-store.ts");
    const result = await store.bootstrapBuiltinAdmin();
    assert.equal(result.created, true);
    assert.equal(result.user.role, "admin");
    assert.equal(result.user.username, "admin");
    assert.equal(result.user.adoptGlobalAgentDir, true);

    // The admin's agentDir IS the legacy dir — nothing was copied.
    assert.equal(store.agentDirForUser(result.user), ctx.globalAgent);
    assert.ok(!existsSync(join(ctx.dataDir, "users", "admin")), "no per-user dir was created");
    assert.equal(existsSync(join(sessions, "old.jsonl")), true, "legacy sessions preserved");
    assert.match(
      await (await import("node:fs")).promises.readFile(join(ctx.globalAgent, "auth.json"), "utf8"),
      /legacy-key/,
      "legacy credentials preserved in place",
    );
    // Adoption must not inject an APPEND_SYSTEM.md into the legacy dir.
    assert.ok(!existsSync(join(ctx.globalAgent, "APPEND_SYSTEM.md")));
  } finally {
    ctx.cleanup();
  }
});

test("bootstrapBuiltinAdmin: idempotent and skips when an admin already exists", async () => {
  const ctx = setup();
  try {
    const store = await jiti.import("@/lib/user-store.ts");
    await store.createUser({ username: "boss", password: "bosspass123", role: "admin" });
    const result = await store.bootstrapBuiltinAdmin();
    assert.equal(result.created, false);
    assert.match(result.reason, /admin account already exists/);
    assert.equal(store.listUsers().length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("bootstrapBuiltinAdmin: honors PI_SMARTFICC_ADMIN_PASSWORD", async () => {
  const ctx = setup({ password: "chosen-admin-pass" });
  try {
    const store = await jiti.import("@/lib/user-store.ts");
    const result = await store.bootstrapBuiltinAdmin();
    assert.equal(result.created, true);
    assert.equal(result.generatedPassword, undefined);
    const verified = await store.verifyUserCredentials("admin", "chosen-admin-pass");
    assert.ok(verified, "the env-supplied password works");
  } finally {
    ctx.cleanup();
  }
});

test("bootstrapBuiltinAdmin: generated admin password round-trips", async () => {
  const ctx = setup();
  try {
    const store = await jiti.import("@/lib/user-store.ts");
    const result = await store.bootstrapBuiltinAdmin();
    assert.equal(typeof result.generatedPassword, "string");
    assert.ok(result.generatedPassword.length >= 16);
    assert.ok(await store.verifyUserCredentials("admin", result.generatedPassword));
  } finally {
    ctx.cleanup();
  }
});
