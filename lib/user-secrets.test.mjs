import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

function freshAgentDir() {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-user-secrets-"));
  mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

test("user-secrets: write/read/remove round-trip with 0600 file and no-value status list", async () => {
  const { setUserSecret, listUserSecretStatuses, readUserSecretsEnv, userSecretsPath } =
    await jiti.import("./user-secrets.ts");
  const agentDir = freshAgentDir();
  try {
    await setUserSecret(agentDir, "RY_TOKEN", "secret-value-1");
    await setUserSecret(agentDir, "SMARTFICC_API_KEY", "sk-2");

    // File permissions + content on disk
    const path = userSecretsPath(agentDir);
    assert.ok(existsSync(path));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(onDisk.secrets.RY_TOKEN.value, "secret-value-1");

    // Status list: names + configured only, values never exposed
    const statuses = listUserSecretStatuses(agentDir);
    assert.deepEqual(statuses.map((s) => s.name), ["RY_TOKEN", "SMARTFICC_API_KEY"].sort());
    for (const s of statuses) {
      assert.equal(s.configured, true);
      assert.equal("value" in s, false, "status must not carry the value");
    }

    // Env injection form
    const env = readUserSecretsEnv(agentDir);
    assert.equal(env.RY_TOKEN, "secret-value-1");
    assert.equal(env.SMARTFICC_API_KEY, "sk-2");

    // Removal
    await setUserSecret(agentDir, "RY_TOKEN", null);
    assert.deepEqual(listUserSecretStatuses(agentDir).map((s) => s.name), ["SMARTFICC_API_KEY"]);
    assert.equal(readUserSecretsEnv(agentDir).RY_TOKEN, undefined);

    // Empty value also removes
    await setUserSecret(agentDir, "SMARTFICC_API_KEY", "");
    assert.equal(listUserSecretStatuses(agentDir).length, 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("user-secrets: invalid names rejected; unreadable file fails closed", async () => {
  const { setUserSecret, readUserSecretsEnv, listUserSecretStatuses, userSecretsPath } =
    await jiti.import("./user-secrets.ts");
  const agentDir = freshAgentDir();
  try {
    await assert.rejects(
      () => setUserSecret(agentDir, "BAD NAME WITH SPACES", "x"),
      /Invalid secret name/,
    );
    await assert.rejects(
      () => setUserSecret(agentDir, "A-B-C", "x"),
      /Invalid secret name/,
    );

    // Corrupt store → no secrets injected (fail closed)
    const { writeFileSync } = await import("node:fs");
    writeFileSync(userSecretsPath(agentDir), "{not json", "utf8");
    assert.deepEqual(listUserSecretStatuses(agentDir), []);
    assert.deepEqual(readUserSecretsEnv(agentDir), {});
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("user-context-extension: whoami reports identity/skills/secret names, never values", async () => {
  const { createUserContextExtension, userCommandEnvironment } =
    await jiti.import("./user-context-extension.ts");
  const { setUserSecret } = await jiti.import("./user-secrets.ts");
  const agentDir = freshAgentDir();
  try {
    await setUserSecret(agentDir, "RY_TOKEN", "super-secret-value");

    const user = {
      userId: "u_abc",
      username: "alice",
      displayName: "Alice",
      role: "admin",
      tenantId: "t_default",
      agentDir,
      allowedRoots: [agentDir],
      skills: ["bond-analysis@1.0.0", "ry-query@latest"],
    };

    const extension = createUserContextExtension(user);
    assert.equal(extension.name, "pi-web-user-context");

    // Drive the factory with a minimal ExtensionAPI double.
    const registeredTools = [];
    const pi = {
      registerTool: (tool) => registeredTools.push(tool),
      on: () => {},
    };
    await extension.factory(pi);

    const whoami = registeredTools.find((t) => t.name === "whoami");
    assert.ok(whoami, "whoami tool registered");
    const result = await whoami.execute("call-1", {}, undefined, undefined, {});
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.user.id, "u_abc");
    assert.equal(payload.user.name, "alice");
    assert.equal(payload.user.role, "admin");
    assert.deepEqual(payload.skills, ["bond-analysis@1.0.0", "ry-query@latest"]);
    assert.deepEqual(payload.configuredSecrets, ["RY_TOKEN"]);
    assert.ok(!result.content[0].text.includes("super-secret-value"), "values never leak");

    // Command env carries the value for subprocess injection only
    const env = userCommandEnvironment(user);
    assert.equal(env.PI_USER_ID, "u_abc");
    assert.equal(env.PI_USER_NAME, "alice");
    assert.equal(env.RY_TOKEN, "super-secret-value");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("set_secret tool: writes own agentDir, never echoes value, syncs env", async () => {
  const { createUserContextExtension, userCommandEnvironment } =
    await jiti.import("./user-context-extension.ts");
  const { listUserSecretStatuses } = await jiti.import("./user-secrets.ts");
  const agentDir = freshAgentDir();
  const secretName = "PI_TEST_SET_SECRET_TOKEN";
  delete process.env[secretName];
  try {
    const user = {
      userId: "u_set", username: "bob", role: "user", tenantId: "t_default",
      agentDir, allowedRoots: [agentDir], skills: [],
    };
    const extension = createUserContextExtension(user);
    const registeredTools = [];
    await extension.factory({
      registerTool: (tool) => registeredTools.push(tool),
      on: () => {},
    });

    const setSecret = registeredTools.find((t) => t.name === "set_secret");
    assert.ok(setSecret, "set_secret tool registered");

    // Store: file is 0600 and the tool result must not carry the value.
    const value = "unit-test-secret-value";
    const written = await setSecret.execute("c1", { name: secretName, value }, undefined, undefined, {});
    assert.equal(written.isError, undefined);
    assert.ok(!written.content[0].text.includes(value), "tool must never echo the secret value");
    const payload = JSON.parse(written.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.name, secretName);
    assert.equal(payload.configured, true);
    assert.equal("value" in payload, false);

    const path = join(agentDir, "secrets.json");
    assert.equal(statSync(path).mode & 0o777, 0o600, "secrets stay 0600");
    assert.deepEqual(listUserSecretStatuses(agentDir).map((s) => s.name), [secretName]);

    // Bash injection picks it up, and the worker's own env is synced so MCP
    // ${VAR} resolution sees the new value without a respawn.
    assert.equal(userCommandEnvironment(user)[secretName], value);
    assert.equal(process.env[secretName], value);

    // Overwrite in place.
    await setSecret.execute("c2", { name: secretName, value: "v2" }, undefined, undefined, {});
    assert.equal(process.env[secretName], "v2");

    // Omitted value removes it.
    const removed = await setSecret.execute("c3", { name: secretName }, undefined, undefined, {});
    assert.equal(JSON.parse(removed.content[0].text).configured, false);
    assert.deepEqual(listUserSecretStatuses(agentDir), []);
    assert.equal(process.env[secretName], undefined);

    // Empty string also removes it.
    await setSecret.execute("c4", { name: secretName, value: "again" }, undefined, undefined, {});
    await setSecret.execute("c5", { name: secretName, value: "" }, undefined, undefined, {});
    assert.deepEqual(listUserSecretStatuses(agentDir), []);

    // Invalid names are rejected (env-var-safe charset enforced by user-secrets).
    const bad = await setSecret.execute("c6", { name: "bad name!", value: "x" }, undefined, undefined, {});
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Invalid secret name/);
  } finally {
    delete process.env[secretName];
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("set_secret tool: only ever targets its own owner's agentDir", async () => {
  const { createUserContextExtension } = await jiti.import("./user-context-extension.ts");
  // Two owners; a session built for `mallory` must not be able to name `alice`.
  const aliceDir = freshAgentDir();
  const malloryDir = freshAgentDir();
  const secretName = "PI_TEST_ISOLATION_TOKEN";
  try {
    const mallory = {
      userId: "u_m", username: "mallory", role: "user", tenantId: "t_default",
      agentDir: malloryDir, allowedRoots: [malloryDir], skills: [],
    };
    const extension = createUserContextExtension(mallory);
    const tools = [];
    await extension.factory({ registerTool: (t) => tools.push(t), on: () => {} });
    const setSecret = tools.find((t) => t.name === "set_secret");

    // No cross-user parameter exists, and any attempt to smuggle one is inert.
    await setSecret.execute("c1", {
      name: secretName, value: "mallorys", agentDir: aliceDir, username: "alice",
    }, undefined, undefined, {});

    const { listUserSecretStatuses } = await jiti.import("./user-secrets.ts");
    assert.deepEqual(listUserSecretStatuses(malloryDir).map((s) => s.name), [secretName]);
    assert.deepEqual(listUserSecretStatuses(aliceDir), [], "alice's store must be untouched");
  } finally {
    delete process.env[secretName];
    rmSync(aliceDir, { recursive: true, force: true });
    rmSync(malloryDir, { recursive: true, force: true });
  }
});
