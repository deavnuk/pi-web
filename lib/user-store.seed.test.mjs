// ensureUserDir seeds shared model config (models.json/auth.json/settings.json)
// so a newly created user can chat immediately (FR-3.7). Seeds must not
// clobber a user's existing customized files, and empty {} placeholders are
// treated as unconfigured.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

async function setup() {
  const seedDir = mkdtempSync(join(tmpdir(), "pi-seed-src-"));
  const dataDir = mkdtempSync(join(tmpdir(), "pi-seed-data-"));
  writeFileSync(join(seedDir, "models.json"), JSON.stringify({ providers: { example: { baseUrl: "http://x", api: "openai-completions", models: [{ id: "M" }] } } }));
  writeFileSync(join(seedDir, "auth.json"), JSON.stringify({ example: { type: "api_key", key: "shared-key" } }));
  writeFileSync(join(seedDir, "settings.json"), JSON.stringify({ defaultProvider: "example", defaultModel: "M" }));
  process.env.PI_SMARTFICC_USER_SEED_DIR = seedDir;
  process.env.PI_WEB_DATA_DIR = dataDir;
  return { seedDir, dataDir };
}

test("ensureUserDir seeds models/auth/settings into a new user dir", async () => {
  const { seedDir, dataDir } = await setup();
  try {
    const store = await jiti.import("./user-store.ts");
    const user = await store.createUser({ username: "newbie", password: "newbie-pass-123" });
    const dir = store.resolveUserAgentDir(user.username);
    for (const f of ["models.json", "auth.json", "settings.json"]) {
      assert.ok(existsSync(join(dir, f)), `${f} seeded`);
    }
    const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    assert.equal(auth.example.key, "shared-key");
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.equal(settings.defaultModel, "M");
  } finally {
    delete process.env.PI_SMARTFICC_USER_SEED_DIR;
    rmSync(seedDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("seeding replaces empty {} placeholders but never clobbers user config", async () => {
  const { seedDir, dataDir } = await setup();
  try {
    const store = await jiti.import("./user-store.ts");
    const user = await store.createUser({ username: "existing", password: "existing-pass-123" });
    const dir = store.resolveUserAgentDir(user.username);
    // Simulate the state of a user created before seeding existed.
    writeFileSync(join(dir, "auth.json"), "{}");
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { mine: {} } }));
    // Re-bootstrap.
    store.ensureUserDir(user.username, { username: user.username });
    const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    assert.equal(auth.example.key, "shared-key", "empty placeholder refilled");
    const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
    assert.ok(models.providers.mine, "existing models.json preserved");
    assert.equal(models.providers.example, undefined);
  } finally {
    delete process.env.PI_SMARTFICC_USER_SEED_DIR;
    rmSync(seedDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
