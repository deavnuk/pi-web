// Regression tests for worker-hosted session run state.
//
// Bug: in multi-user (worker) mode `startRpcSession()` returned a
// WorkerSessionProxy without registering it, so `getRpcSession(id)` was
// undefined for every live worker session. GET /api/agent/[id] and
// GET /api/sessions/[id]/state then answered "idle" while the worker was
// mid-stream. The client's 15s reconcile loop trusted that and tore down the
// UI mid-output; the next message was sent as a plain prompt and the worker
// rejected it with "Agent is already processing. Specify streamingBehavior…".
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(path.join(here, "agent-worker-manager.ts"), { interopDefault: true });
const { WorkerSessionProxy } = await jiti.import("./agent-worker-manager.ts");

const rpcManagerSource = await readFile(path.join(here, "rpc-manager.ts"), "utf8");
const workerManagerSource = await readFile(path.join(here, "agent-worker-manager.ts"), "utf8");

function makeUser(id = "u_proxy_test") {
  return {
    userId: id,
    username: "zhangsan",
    role: "user",
    tenantId: "t_default",
    agentDir: "/tmp/proxy-test-agentdir",
    allowedRoots: [],
    skills: [],
  };
}

function makeProxy() {
  return new WorkerSessionProxy(makeUser(), {
    realSessionId: "real-1",
    sessionId: "sess-1",
    sessionFile: "/tmp/sess-1.jsonl",
    cwd: "/tmp",
  });
}

test("fresh worker proxy reports idle, not running", () => {
  const proxy = makeProxy();
  // The old implementation hard-coded `isRunning() === true`, which made every
  // worker session look busy forever.
  assert.equal(proxy.isRunning(), false);
  assert.equal(proxy.isStreaming, false);
});

test("agent lifecycle events drive the mirrored run state", () => {
  const proxy = makeProxy();

  proxy.observeEvent({ type: "agent_start" });
  assert.equal(proxy.isRunning(), true);
  assert.equal(proxy.isStreaming, true);

  // agent_end stops streaming but the run is not settled yet.
  proxy.observeEvent({ type: "agent_end" });
  assert.equal(proxy.isStreaming, false);

  proxy.observeEvent({ type: "agent_settled" });
  assert.equal(proxy.isRunning(), false);
  assert.equal(proxy.isStreaming, false);
});

test("compaction and bash keep the session running", () => {
  const compacting = makeProxy();
  compacting.observeEvent({ type: "compaction_start" });
  assert.equal(compacting.isRunning(), true);

  const bash = makeProxy();
  bash.observeEvent({ type: "bash_start" });
  assert.equal(bash.isRunning(), true);
});

test("a re-created proxy inherits the previously observed run state", () => {
  const previous = makeProxy();
  previous.observeEvent({ type: "agent_start" });

  const replacement = makeProxy();
  assert.equal(replacement.isRunning(), false);
  replacement.adoptObservedState(previous);
  assert.equal(replacement.isRunning(), true);
  assert.equal(replacement.isStreaming, true);
});

test("startRpcSession registers the worker proxy in the main registry", () => {
  // The registration call is the actual bug fix: without it every route that
  // resolves sessions via getRpcSession() cannot see worker sessions.
  assert.match(rpcManagerSource, /function registerWorkerSessionProxy\(/);
  assert.match(rpcManagerSource, /registry\.set\(proxy\.sessionId, proxy\)/);
  assert.match(rpcManagerSource, /registerWorkerSessionProxy\(proxy\)/);
  const workerBranch = rpcManagerSource.indexOf("if (user && isWorkerModeEnabled()) {");
  assert.ok(workerBranch > 0, "worker branch present");
  assert.ok(
    rpcManagerSource.slice(workerBranch).includes("registerWorkerSessionProxy(proxy)"),
    "worker branch must register the proxy before returning it",
  );
});

test("dead workers purge their proxies so stale sessions cannot look alive", () => {
  assert.match(workerManagerSource, /function purgeWorkerProxies\(/);
  assert.match(workerManagerSource, /purgeWorkerProxies\(user\.userId\)/);
  // Must run on both crash and clean-exit paths.
  const calls = workerManagerSource.match(/purgeWorkerProxies\(user\.userId\)/g) ?? [];
  assert.ok(calls.length >= 2, `expected purge on proc error + exit, saw ${calls.length}`);
});
