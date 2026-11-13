// Regression test: "TypeError: u?.evictIfDiskAhead is not a function" when
// opening a scheduled-task session.
//
// The scheduler runs inside the instrumentation webpack compilation, whose
// WorkerSessionProxy class copy differs from the route bundle's copy, while the
// session registry (globalThis.__piSessions) is shared process-wide. The detail
// route used `rpc instanceof WorkerSessionProxy`, which failed for scheduler
// proxies — so a live proxy was treated as a local wrapper and the route called
// evictIfDiskAhead() on it. Identity checks must be structural
// (isWorkerSessionProxy), and the proxy must carry evictIfDiskAhead() as a
// parity stub so a stale bundled route can never crash again.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { installTestUser } from "../../__tests__/test-user.mjs";

const routeSrc = await (await import("node:fs/promises")).readFile(new URL("./route.ts", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getSessionDetail } = await jiti.import("./route.ts");
const { WorkerSessionProxy, isWorkerSessionProxy } = await jiti.import("@/lib/rpc-manager");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("@/lib/session-reader");

// Multi-user is the only mode: the route requires a real account.
const { auth: testAuth, cleanup: cleanupTestUser, retarget } = await installTestUser();
after(cleanupTestUser);

test("detail route classifies worker proxies structurally, not by instanceof", () => {
  assert.match(routeSrc, /isWorkerSessionProxy\(rpc\)/);
  assert.doesNotMatch(routeSrc, /instanceof WorkerSessionProxy/);
});

// Mimics the instrumentation bundle's copy of the class: same shape (the tag
// field, userId, run-state surface), a different constructor, so
// `instanceof WorkerSessionProxy` is false — exactly how a scheduler-created
// proxy looks to a route handler.
class ForeignBundleProxy {
  __piWorkerSessionProxy = true;
  constructor(info, userId = "u_bob") {
    this.info = info;
    this.ownerId = userId;
  }
  get userId() { return this.ownerId; }
  isAlive() { return true; }
  isRunning() { return false; }
  isChatOnly() { return false; }
  evictIfDiskAhead() { return false; }
  send() { return Promise.resolve({}); }
  onEvent() { return () => {}; }
}

test("isWorkerSessionProxy accepts a foreign-bundle structural copy", () => {
  const foreign = new ForeignBundleProxy({
    sessionId: "s1", realSessionId: "s1", sessionFile: "/tmp/x.jsonl", cwd: "/tmp",
  });
  assert.equal(foreign instanceof WorkerSessionProxy, false, "fixture must differ from the route-bundle class");
  assert.equal(isWorkerSessionProxy(foreign), true);
  assert.equal(isWorkerSessionProxy(null), false);
  assert.equal(isWorkerSessionProxy(undefined), false);
  assert.equal(isWorkerSessionProxy({ __piWorkerSessionProxy: true }), false, "tag alone is not enough");
  assert.equal(isWorkerSessionProxy({ __piWorkerSessionProxy: true, userId: "u" }), true);
  // A local AgentSessionWrapper has no tag even if it had a userId property.
  assert.equal(isWorkerSessionProxy({ userId: "u" }), false);
});

test("GET ?force=1 on a scheduler-registered proxy session serves from disk instead of crashing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-cross-bundle-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  retarget();
  // Routes scope a session to <agentDir>/sessions/<project-dir>; the shared
  // scanner only walks project subdirectories, so the fixture writes into one.
  const sessionsDir = join(dir, "sessions", "--project--");
  await mkdir(sessionsDir, { recursive: true });
  let sessionId;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    retarget();
    invalidateSessionPathCache(sessionId);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });

  const manager = SessionManager.create(dir, sessionsDir);
  manager.appendMessage({ role: "user", content: "每日涨停股票汇总（15:30）", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: Date.now() });
  sessionId = manager.getSessionId();
  invalidateSessionListCache();

  // Register the session the way the scheduler's instrumentation-bundle copy
  // does: a proxy object in the shared global registry that this bundle's
  // instanceof would not recognize.
  const foreign = new ForeignBundleProxy({
    sessionId,
    realSessionId: sessionId,
    sessionFile: join(dir, `${sessionId}.jsonl`),
    cwd: dir,
  });
  const { getRpcSession } = await jiti.import("@/lib/rpc-manager");
  getRpcSession(sessionId); // materializes the global registry
  const registry = globalThis.__piSessions;
  assert.ok(registry, "session registry exists");
  registry.set(sessionId, foreign);
  t.after(() => {
    if (registry.get(sessionId) === foreign) registry.delete(sessionId);
  });

  const context = { params: Promise.resolve({ id: sessionId }) };
  const url = `http://localhost/api/sessions/${sessionId}?deferThinking=1&deferMedia=1&tree=summary&force=1`;
  // A wrapper misclassification would call evictIfDiskAhead() on the proxy and
  // throw; the structural check routes this to the on-disk session instead.
  const response = await getSessionDetail(
    new Request(url, { headers: { authorization: testAuth } }),
    context,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.error === undefined, `route error: ${body.error ?? ""}`);
  assert.equal(body.sessionId, sessionId, "served the requested session");
  assert.ok(body.context?.messages?.length >= 2, "messages served from the persisted session");
});
