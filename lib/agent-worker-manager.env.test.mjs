// Tests for buildWorkerEnvironment: worker env carries per-user identity +
// per-user secret values (so the built-in MCP extension's ${VAR} resolution
// is per-user).
// FR-5.3; values must exist in the worker env but never in logs/responses.
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(path.join(here, "agent-worker-manager.ts"));

function makeAgentDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-env-"));
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  return dir;
}

function makeUser(id, username) {
  return {
    userId: id,
    username,
    role: "user",
    tenantId: "t_default",
    agentDir: "",
    allowedRoots: [],
    skills: [],
  };
}

test("buildWorkerEnvironment injects per-user secrets into worker env", async () => {
  const { buildWorkerEnvironment } = await jiti.import("./agent-worker-manager.ts");
  const { setUserSecret } = await jiti.import("./user-secrets.ts");
  const dir = makeAgentDir();
  await setUserSecret(dir, "RY_TOKEN", "tok-user-a");
  const user = makeUser("u_env_a", "usera");
  user.agentDir = dir;

  const env = buildWorkerEnvironment(user, dir);
  assert.equal(env.PI_CODING_AGENT_DIR, dir);
  assert.equal(env.PI_SMARTFICC_USER_ID, "u_env_a");
  assert.equal(env.PI_USER_NAME, "usera");
  assert.equal(env.PI_SMARTFICC_WORKER, "1");
  assert.equal(env.RY_TOKEN, "tok-user-a");
  assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
});

test("buildWorkerEnvironment keeps users isolated: each worker sees only its own secrets", async () => {
  const { buildWorkerEnvironment } = await jiti.import("./agent-worker-manager.ts");
  const { setUserSecret } = await jiti.import("./user-secrets.ts");
  const dirA = makeAgentDir();
  const dirB = makeAgentDir();
  await setUserSecret(dirA, "RY_TOKEN", "tok-A");
  await setUserSecret(dirB, "RY_TOKEN", "tok-B");
  await setUserSecret(dirB, "EXTRA", "only-b");
  const userA = makeUser("u_env_a", "usera");
  userA.agentDir = dirA;
  const userB = makeUser("u_env_b", "userb");
  userB.agentDir = dirB;

  const envA = buildWorkerEnvironment(userA, dirA);
  const envB = buildWorkerEnvironment(userB, dirB);
  assert.equal(envA.RY_TOKEN, "tok-A");
  assert.equal(envB.RY_TOKEN, "tok-B");
  assert.equal(envA.EXTRA, undefined);
  assert.equal(envB.EXTRA, "only-b");
});

test("buildWorkerEnvironment ignores invalid secret names", async () => {
  const { buildWorkerEnvironment } = await jiti.import("./agent-worker-manager.ts");
  const { setUserSecret } = await jiti.import("./user-secrets.ts");
  const dir = makeAgentDir();
  // setUserSecret rejects invalid names; write file directly for PATH hack attempt.
  await setUserSecret(dir, "GOOD_NAME", "ok");
  fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({
    version: 1,
    secrets: {
      "bad name": { value: "x", updatedAt: new Date().toISOString() },
      "PATH": { value: "/hacked", updatedAt: new Date().toISOString() },
      "GOOD_NAME": { value: "ok", updatedAt: new Date().toISOString() },
    },
  }), { mode: 0o600 });
  const user = makeUser("u_env_c", "userc");
  user.agentDir = dir;
  const env = buildWorkerEnvironment(user, dir);
  assert.equal(env["bad name"], undefined);
  assert.equal(env.GOOD_NAME, "ok");
});
