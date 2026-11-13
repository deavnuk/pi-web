// FR-7.3 end-to-end: a scheduled task runs as its *owner* in a brand-new
// session, and the transcript lands in that owner's own session list.
//
// Everything below the API route is real: the same `buildSchedulerDependencies()`
// the timer and "run now" use, the same `startRpcSession({ user })` entry point,
// and — through the same per-user worker process the web app
// spawns. Only the model provider is faked, via an extension in the user's own
// agentDir that registers a scripted `fauxProvider`. That keeps the test offline
// while still driving the real ExtensionRunner → ResourceLoader → session path.
//
// This is the assertion the scheduled-task feature actually rests on: if the
// owner's identity ever stopped being threaded through `startRpcSession`, the
// run would still "succeed" but its transcript would appear in nobody's sidebar.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

/** Where the faux provider stashes the system prompt it was handed. */
const CAPTURED_PROMPT = "captured-system-prompt.txt";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Set before any pi-web module is imported: the worker-spawn decision, the data
// root and the global agentDir are all read at module load / call time from env.
const dataRoot = await mkdtemp(join(tmpdir(), "pi-web-schedule-e2e-"));
const globalAgentDir = join(dataRoot, "global-agent");
await mkdir(globalAgentDir, { recursive: true });

const previousEnv = {
  data: process.env.PI_WEB_DATA_DIR,
  agent: process.env.PI_CODING_AGENT_DIR,
  web: process.env.PI_SMARTFICC_WEB_DIR,
  worker: process.env.PI_SMARTFICC_WORKER,
};
process.env.PI_WEB_DATA_DIR = dataRoot;
process.env.PI_CODING_AGENT_DIR = globalAgentDir;
process.env.PI_SMARTFICC_WEB_DIR = root;
delete process.env.PI_SMARTFICC_WORKER;

const jiti = createJiti(import.meta.url, {
  alias: { "@": root },
  interopDefault: true,
  moduleCache: false,
});
const store = await jiti.import("./user-store.ts");
const { createScheduledTask, getScheduledTask } = await jiti.import("./scheduled-tasks.ts");
const { buildSchedulerDependencies } = await jiti.import("./schedule-runtime.ts");
const { runScheduledTask } = await jiti.import("./schedule-runner.ts");
const { listAllSessions } = await jiti.import("./session-reader.ts");
const { destroyAllWorkers } = await jiti.import("./agent-worker-manager.ts");

/** The one line the faux model answers with, asserted in the transcript. */
const ANSWER = "SCHEDULED_RUN_ANSWER";
const PROMPT = "整理今日智能日报";

/**
 * Register a scripted model provider from the user's OWN agentDir, plus the
 * settings that make a fresh session pick it. This is exactly how a department
 * would give a user a custom gateway — the run must reach it through the user's
 * own agentDir, not the global one.
 */
async function seedFauxProvider(agentDir) {
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "faux-provider.ts"),
    [
      `import { fauxProvider, fauxAssistantMessage, fauxText, getCurrentSystemPrompt } from "@earendil-works/pi-ai";`,
      `import { writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `const faux = fauxProvider({ models: [{ id: "faux-sched" }] });`,
      `faux.setResponses([(context) => {`,
      // The system prompt is composed from the run's UserContext; capturing it
      // here is how the test proves the run inherited the owner's identity.
      `  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, ${JSON.stringify(CAPTURED_PROMPT)}), getCurrentSystemPrompt(context.messages));`,
      `  return fauxAssistantMessage([fauxText(${JSON.stringify(ANSWER)})]);`,
      `}]);`,
      `export default function (pi) { pi.registerProvider(faux.provider); }`,
      "",
    ].join("\n"),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-sched" }, null, 2),
  );
}

after(async () => {
  await destroyAllWorkers().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true });
  for (const [key, value] of Object.entries({
    PI_WEB_DATA_DIR: previousEnv.data,
    PI_CODING_AGENT_DIR: previousEnv.agent,
    PI_SMARTFICC_WEB_DIR: previousEnv.web,
    PI_SMARTFICC_WORKER: previousEnv.worker,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("a scheduled run's transcript lands in the owner's session list, and only theirs", async () => {
  const alice = await store.createUser({
    username: "alice",
    password: "alicepass123",
    role: "user",
    displayName: "爱丽丝",
    tenantId: "t_acme",
  });
  const bob = await store.createUser({ username: "bob", password: "bobpass123", role: "user" });
  const aliceDir = store.resolveUserAgentDir("alice");
  const bobDir = store.resolveUserAgentDir("bob");
  const aliceUser = await store.findUserByUsername("alice");
  await seedFauxProvider(aliceDir);
  // A separate pre-existing session, so "landed in the list" means *added to*
  // the catalogue rather than "the catalogue had exactly one entry".
  await mkdir(join(aliceDir, "sessions", "e2e"), { recursive: true });
  const seededId = "01a12f11-0000-0000-cccc-1791791100";
  await writeFile(
    join(aliceDir, "sessions", "e2e", `2026-10-12T08-00-00-000Z_${seededId}.jsonl`),
    [
      { type: "session", version: 3, id: seededId, timestamp: "2026-10-12T08:00:00.000Z", cwd: aliceDir },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-10-12T08:00:00.000Z", message: { role: "user", content: "既有会话" } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n",
  );

  const task = await createScheduledTask(aliceDir, {
    title: "Alice 日报",
    prompt: PROMPT,
    schedule: { kind: "daily", time: "09:00", timezone: "Asia/Shanghai" },
    createdBy: "alice",
  });

  const deps = await buildSchedulerDependencies();
  // Exactly what the timer and the "run now" route pass in.
  const user = deps.buildUserContext({ username: "alice", id: aliceUser.id });
  assert.equal(user.userId, alice.id, "the run must be built from the stored owner record");
  assert.equal(user.agentDir, aliceDir);

  const outcome = await runScheduledTask(task, user, deps);
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.username, "alice");
  assert.ok(outcome.sessionId, "the run must report the real session id it produced");

  // The run recorded its own outcome on the task, pointing at the same session.
  const recorded = getScheduledTask(aliceDir, task.id);
  assert.equal(recorded.lastRun.status, "ok");
  assert.equal(recorded.lastRun.sessionId, outcome.sessionId);

  // The transcript exists under the owner's own sessions tree, not the global one.
  const ownerSessions = await listAllSessions({ agentDir: aliceDir, force: true });
  const runSession = ownerSessions.find((session) => session.id === outcome.sessionId);
  assert.ok(runSession, `owner's catalogue must contain ${outcome.sessionId}`);
  assert.ok(!existsSync(join(globalAgentDir, "sessions")), "the run must not touch the global agentDir");
  const transcript = await readFile(runSession.path, "utf8");
  assert.ok(transcript.includes(ANSWER), "the run's answer must be in the owner's transcript");
  assert.ok(transcript.includes(PROMPT), "the run's prompt must be in the owner's transcript");

  // Other users' catalogues are untouched: the run is owner-scoped (FR-5/FR-7.3).
  const bobSessions = await listAllSessions({ agentDir: bobDir, force: true });
  assert.deepEqual(bobSessions.map((session) => session.id), []);

  // FR-7.3 also promises the run inherits the owner's identity, not the
  // scheduler's or some ambient user's. The persona/identity block is injected
  // per turn from the run's UserContext.
  const systemPrompt = await readFile(join(aliceDir, CAPTURED_PROMPT), "utf8");
  assert.ok(systemPrompt.includes("用户名:alice"), "run must see the owner as the session user");
  assert.ok(systemPrompt.includes("爱丽丝"), "run must see the owner's display name");
  assert.ok(systemPrompt.includes("t_acme"), "run must see the owner's tenant");
  assert.ok(systemPrompt.includes("角色:用户"), "run must see the owner's role");

  // bob's account record is irrelevant to alice's run staying private.
  assert.equal(bob.username, "bob");
  assert.equal(store.findUserByUsername("bob").skills.length, 0);
});
