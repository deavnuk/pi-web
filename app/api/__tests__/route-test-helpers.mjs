// Shared harness for route-level tests of the multi-user fork.
//
// Each test runs against a throwaway PI_WEB_DATA_DIR so accounts, agentDirs
// and stores are isolated per file. `loadRoute` imports a Next.js route handler
// through jiti (the same loader `npm test` uses for lib tests), which lets us
// exercise the real `requireAuth` / `requireAdmin` chain end-to-end instead of
// only asserting on source text.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

export function makeJiti(url = import.meta.url) {
  return createJiti(url, {
    alias: { "@": process.cwd() },
    interopDefault: true,
    moduleCache: false,
  });
}

/**
 * Spin up an isolated data root with the given accounts and hand back a small
 * context: `load(path)` imports a route module, `basic(user)` builds an auth
 * header, and `cleanup()` removes the temp dir.
 */
export async function setupUsers(accounts) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-fork-route-"));
  const prevDataDir = process.env.PI_WEB_DATA_DIR;
  const prevPassword = process.env.PI_WEB_PASSWORD;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  // The global agent dir (used by e.g. the push-subscription store) also points
  // into the temp root so tests can inspect on-disk state.
  process.env.PI_CODING_AGENT_DIR = dataDir;
  // The proxy-layer password gate is irrelevant to route tests; leave it off.
  delete process.env.PI_WEB_PASSWORD;

  // Drop any cached auth/store state carried over from a previous test file.
  globalThis.__piAuthCache?.clear();
  globalThis.__piUserStoreCache = undefined;

  const jiti = makeJiti();
  const store = await jiti.import("@/lib/user-store.ts");
  const users = {};
  for (const account of accounts) {
    const created = await store.createUser(account);
    // `createUser` returns the stored record (no agentDir); resolve it so tests
    // can reference the caller's own directory without re-deriving layout.
    users[account.username] = { ...created, agentDir: store.resolveUserAgentDir(account.username) };
  }

  return {
    dataDir,
    store,
    users,
    load: (path) => jiti.import(join(process.cwd(), path)),
    basic: (username, password) =>
      "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
    request(path, { method = "GET", auth, body, headers = {}, host = "localhost" } = {}) {
      const h = { host, ...headers };
      if (auth) h.authorization = auth;
      let payload;
      if (body !== undefined) {
        h["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
      return new Request(`http://${host}${path}`, { method, headers: h, body: payload });
    },
    cleanup() {
      globalThis.__piAuthCache?.clear();
      globalThis.__piUserStoreCache = undefined;
      rmSync(dataDir, { recursive: true, force: true });
      if (prevDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
      else process.env.PI_WEB_DATA_DIR = prevDataDir;
      if (prevPassword !== undefined) process.env.PI_WEB_PASSWORD = prevPassword;
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    },
  };
}

export async function json(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}
