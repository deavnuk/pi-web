// Shared fixture for route tests that were written against the old anonymous
// single-user mode.
//
// Multi-user is the only mode now, so every route requires a real account. A
// test that already points PI_CODING_AGENT_DIR at a scratch directory can get
// an authenticated identity whose agentDir is exactly that directory by using
// the same mechanism the built-in admin uses: `adoptGlobalAgentDir`.
//
//   const { auth, cleanup } = await installTestUser();
//   after(cleanup);
//   await GET(new Request(url, { headers: { authorization: auth } }));
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

export const TEST_USERNAME = "testuser";
export const TEST_PASSWORD = "testpass12345";

/**
 * Create `<tempDataRoot>/users.json` holding one admin account that adopts the
 * current PI_CODING_AGENT_DIR, and return the Basic authorization header that
 * authenticates as it.
 */
export async function installTestUser({ role = "admin" } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-route-auth-"));
  const prev = {
    dataDir: process.env.PI_WEB_DATA_DIR,
    password: process.env.PI_WEB_PASSWORD,
  };
  process.env.PI_WEB_DATA_DIR = dataDir;
  // The proxy layer's shared password is not part of these tests.
  delete process.env.PI_WEB_PASSWORD;
  globalThis.__piAuthCache?.clear();
  globalThis.__piUserStoreCache = undefined;

  const jiti = createJiti(import.meta.url, {
    alias: { "@": process.cwd() },
    interopDefault: true,
    moduleCache: false,
  });
  const store = await jiti.import("@/lib/user-store.ts");
  await store.createUser({
    username: TEST_USERNAME,
    password: TEST_PASSWORD,
    role,
    adoptGlobalAgentDir: true,
  });
  globalThis.__piUserStoreCache = undefined;

  const auth = "Basic " + Buffer.from(`${TEST_USERNAME}:${TEST_PASSWORD}`).toString("base64");

  // Resolve the identity once so fixtures can register browsable roots for it.
  const authMod = await jiti.import("@/lib/user-auth.ts");
  const rootsMod = await jiti.import("@/lib/allowed-roots.ts");
  const user = await authMod.resolveAuthUser(new Request("http://localhost/", { headers: { authorization: auth } }));

  return {
    auth,
    dataDir,
    /** The fixture account's context (userId, agentDir, ...). */
    user,
    /**
     * The fixture account's own sessions root (`<agentDir>/sessions`).
     *
     * Routes scope session access to this directory, so a fixture that seeds or
     * starts a session must place it here to be recognized as the user's own.
     * The account adopts the host agentDir, so this follows PI_CODING_AGENT_DIR
     * at call time.
     */
    sessionsRoot() {
      return join(user.agentDir, "sessions");
    },
    /**
     * Forget the resolved identity so the next request re-reads it.
     *
     * The fixture account adopts the host agentDir, whose value comes from
     * PI_CODING_AGENT_DIR at resolution time. A test that points that variable
     * at a fresh scratch directory mid-run must call this, or the 5s auth cache
     * keeps serving the previous agentDir.
     */
    retarget() {
      globalThis.__piAuthCache?.clear();
      globalThis.__piUserStoreCache = undefined;
    },
    /**
     * Make `root` browsable for the fixture account. Replaces the old
     * process-wide `allowFileRoot()`, which no longer governs request access.
     */
    allowRoot(root) {
      rootsMod.allowFileRootForUser(user.userId, root);
    },
    cleanup() {
      globalThis.__piAuthCache?.clear();
      globalThis.__piUserStoreCache = undefined;
      rmSync(dataDir, { recursive: true, force: true });
      if (prev.dataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
      else process.env.PI_WEB_DATA_DIR = prev.dataDir;
      if (prev.password !== undefined) process.env.PI_WEB_PASSWORD = prev.password;
    },
  };
}
