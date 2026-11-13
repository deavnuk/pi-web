import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { installTestUser } from "../../__tests__/test-user.mjs";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { projectIdentityKey } = await jiti.import("../../../../lib/project-identity.ts");

// Multi-user is the only mode: validation requires a real account.
const { auth: testAuth, cleanup: cleanupTestUser } = await installTestUser();
after(cleanupTestUser);

function validate(cwd, headers = { authorization: testAuth }) {
  return POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost", ...headers },
    body: JSON.stringify({ cwd }),
  }));
}

test("validated cwd responses include server-resolved project identity", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-web-cwd-validate-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const response = await validate(cwd);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    cwd,
    projectRoot: cwd,
    projectKey: projectIdentityKey(cwd),
  });
});

test("validating a cwd requires an account", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-web-cwd-validate-anon-"));
  try {
    const response = await validate(cwd, {});
    assert.equal(response.status, 401);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
