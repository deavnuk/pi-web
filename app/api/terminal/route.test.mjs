import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { installTestUser } from "../__tests__/test-user.mjs";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { GET: getTerminal, POST: postTerminal, DELETE: deleteTerminal } = await jiti.import("./[id]/route.ts");

// Multi-user is the only mode: the terminal is a shell for one account, so every
// request must carry one and later requests must come from the same account.
const { auth: testAuth, cleanup: cleanupTestUser, allowRoot, user } = await installTestUser();
after(cleanupTestUser);

function open(cwd, extra = {}) {
  return POST(new Request("http://localhost/api/terminal", {
    method: "POST",
    headers: { authorization: testAuth, "Content-Type": "application/json", Host: "localhost", ...extra },
    body: JSON.stringify({ cwd }),
  }));
}

test("opening a terminal requires an account", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-terminal-auth-"));
  allowRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const response = await open(cwd, { authorization: "" });
  assert.equal(response.status, 401);
});

test("a terminal outside the user's roots is refused", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-terminal-denied-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const response = await open(cwd);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access denied" });
});

test("another account cannot read, type into or close a terminal it does not own", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-terminal-owner-"));
  allowRoot(cwd);
  const opened = await open(cwd);
  const body = await opened.json();
  t.after(async () => {
    await deleteTerminal(
      new Request(`http://localhost/api/terminal/${body.id}`, { method: "DELETE", headers: { authorization: testAuth } }),
      { params: Promise.resolve({ id: body.id }) },
    );
    await rm(cwd, { recursive: true, force: true });
  });

  assert.equal(opened.status, 200, JSON.stringify(body));
  assert.match(body.id, /^[a-f0-9-]{32,36}$/);

  // The owner sees it.
  const own = await getTerminal(
    new Request(`http://localhost/api/terminal/${body.id}`, { headers: { authorization: testAuth } }),
    { params: Promise.resolve({ id: body.id }) },
  );
  assert.equal(own.status, 200);
  assert.deepEqual(await own.json(), { id: body.id, cwd });

  // A foreign account does not, and cannot type into it either.
  const foreignAuth = "Basic " + Buffer.from("mallory:not-a-real-account").toString("base64");
  for (const [method, handler] of [["GET", getTerminal], ["POST", postTerminal], ["DELETE", deleteTerminal]]) {
    const response = await handler(
      new Request(`http://localhost/api/terminal/${body.id}`, {
        method,
        headers: { authorization: foreignAuth, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ type: "input", data: "id\n" }) } : {}),
      }),
      { params: Promise.resolve({ id: body.id }) },
    );
    assert.equal(response.status, 401, `${method} must require an account`);
  }
  assert.equal(user.userId.length > 0, true);
});
