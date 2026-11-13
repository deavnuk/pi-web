import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const runner = await jiti.import("./schedule-runner.ts");
const sched = await jiti.import("./scheduled-tasks.ts");

const { runScheduledTask, runSchedulerTick, sessionKeyFor, isScheduledTaskRunning } = runner;

const CST = "Asia/Shanghai";
/** No real waiting: run-state polling is the thing under test, not setTimeout. */
const noSleep = async () => {};

function freshAgentDir() {
  return mkdtempSync(join(tmpdir(), "pi-schedule-runner-"));
}

function makeUser(agentDir, username = "zhangsan") {
  return {
    userId: `u_${username}`,
    username,
    role: "user",
    tenantId: "t_default",
    agentDir,
    allowedRoots: [agentDir],
    skills: [],
  };
}

/** A session whose run-state sequence we dictate, so settle logic is testable. */
function makeSession({ runningStates = [false], failPrompt = null, runError = null } = {}) {
  let index = 0;
  const session = {
    realSessionId: "sess-abc",
    prompts: [],
    isRunning() {
      const value = runningStates[Math.min(index, runningStates.length - 1)];
      index += 1;
      return value;
    },
    async send(command) {
      session.prompts.push(command);
      if (failPrompt) throw new Error(failPrompt);
      return null;
    },
    // Mirrors the worker: a provider failure does not throw, it just leaves an
    // error behind for whoever asks.
    async lastError() {
      return runError;
    },
  };
  return session;
}

function makeDeps(agentDir, overrides = {}) {
  const user = makeUser(agentDir);
  const session = overrides.session ?? makeSession();
  const notified = [];
  const logs = [];
  const warns = [];
  const deps = {
    listUsers: () => [{ username: user.username, status: "active" }],
    buildUserContext: () => user,
    startSession: async () => session,
    notify: async (sessionId, userId) => { notified.push({ sessionId, userId }); },
    defaultCwdFor: () => agentDir,
    isCwdAllowed: async () => true,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    sleep: noSleep,
    ...overrides,
  };
  return { user, session, notified, logs, warns, deps };
}

function seedTask(agentDir, overrides = {}) {
  return sched.createScheduledTask(agentDir, {
    title: "周五债券周报",
    prompt: "汇总本周信用债一级发行",
    schedule: { kind: "daily", time: "09:00", timezone: CST },
    createdBy: "zhangsan",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Completion detection
// C1: the prompt dispatch resolves on *acceptance*, so "send returned" is not
// "finished". The runner must poll run state instead.
// ---------------------------------------------------------------------------

test("runScheduledTask: sends the prompt and records ok once the run settles", async () => {
  const agentDir = freshAgentDir();
  const task = await seedTask(agentDir);
  const { deps, session, notified } = makeDeps(agentDir, {
    // Still running on the first two polls, then idle.
    session: makeSession({ runningStates: [true, true, false] }),
  });

  const outcome = await runScheduledTask(task, makeUser(agentDir), deps);

  assert.equal(outcome.status, "ok");
  assert.deepEqual(session.prompts, [{ type: "prompt", message: "汇总本周信用债一级发行" }]);
  assert.equal(outcome.sessionId, "sess-abc");
});

test("runScheduledTask: does not treat an immediately-idle session as a failure", async () => {
  const agentDir = freshAgentDir();
  const task = await seedTask(agentDir);
  // A fast run may already be settled by the time we first look.
  const { deps } = makeDeps(agentDir, { session: makeSession({ runningStates: [false] }) });

  const outcome = await runScheduledTask(task, makeUser(agentDir), deps);

  assert.equal(outcome.status, "ok");
});

test("runScheduledTask: a run that never settles times out and is aborted", async () => {
  const agentDir = freshAgentDir();
  const task = await seedTask(agentDir);
  const session = makeSession({ runningStates: [true] });
  const { deps } = makeDeps(agentDir, { session, runTimeoutMs: -1 });

  const outcome = await runScheduledTask(task, makeUser(agentDir), deps);

  assert.equal(outcome.status, "timeout");
  assert.match(outcome.error, /exceeded/);
  // The abort goes out over the same command channel the UI's stop button uses.
  assert.ok(
    session.prompts.some((c) => c.type === "abort"),
    "a stuck run must not be left running",
  );
});

test("runScheduledTask: a prompt-dispatch error is recorded as an error", async () => {
  const agentDir = freshAgentDir();
  const task = await seedTask(agentDir);
  const { deps } = makeDeps(agentDir, {
    session: makeSession({ failPrompt: "provider unreachable" }),
  });

  const outcome = await runScheduledTask(task, makeUser(agentDir), deps);

  assert.equal(outcome.status, "error");
  assert.match(outcome.error, /provider unreachable/);
});

test("runScheduledTask: a session that fails to start is recorded as an error", async () => {
  const agentDir = freshAgentDir();
  const task = await seedTask(agentDir);
  const { deps } = makeDeps(agentDir, {
    startSession: async () => { throw new Error("worker spawn failed"); },
  });

  const outcome = await runScheduledTask(task, makeUser(agentDir), deps);

  assert.equal(outcome.status, "error");
  assert.match(outcome.error, /worker spawn failed/);
});

// ---------------------------------------------------------------------------
// cwd safety — C7 in the design
// ---------------------------------------------------------------------------

test("runScheduledTask: refuses a cwd outside the user's allowed roots", async () => {
  const agentDir = freshAgentDir();
  const task = await seedTask(agentDir, { cwd: "/etc" });
  let started = false;
  const { deps } = makeDeps(agentDir, {
    isCwdAllowed: async () => false,
    startSession: async () => { started = true; return makeSession(); },
  });

  const outcome = await runScheduledTask(task, makeUser(agentDir), deps);

  assert.equal(outcome.status, "skipped");
  assert.equal(started, false, "must not spawn a session in a disallowed cwd");
});

// ---------------------------------------------------------------------------
// Notification targeting — "通知不要乱"
// ---------------------------------------------------------------------------

test("runScheduledTask: notifies the owner with their userId, and only once", async () => {
  const agentDir = freshAgentDir();
  const task = await seedTask(agentDir);
  const { deps, notified } = makeDeps(agentDir);

  await runScheduledTask(task, makeUser(agentDir), deps);

  assert.deepEqual(notified, [{ sessionId: "sess-abc", userId: "u_zhangsan" }]);
});

test("runScheduledTask: a notify failure does not fail the run", async () => {
  const agentDir = freshAgentDir();
  const task = await seedTask(agentDir);
  const { deps, warns } = makeDeps(agentDir, {
    notify: async () => { throw new Error("push service down"); },
  });

  const outcome = await runScheduledTask(task, makeUser(agentDir), deps);

  assert.equal(outcome.status, "ok");
  assert.ok(warns.some((w) => /notify failed/.test(w)));
});

// ---------------------------------------------------------------------------
// Single-run-per-task guard — design §14.5 "同任务已在跑 → skip" (FR-7.6).
// The scheduler's file lock serializes *ticks*; it must not stop a manual
// "run now" racing the timer, nor a double-click.
// ---------------------------------------------------------------------------

/** A session that stays running until `release()` is called. */
function gatedSession() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let running = true;
  return {
    realSessionId: "sess-gated",
    prompts: [],
    released: false,
    isRunning: () => running,
    async send(command) {
      this.prompts.push(command);
      if (command.type === "abort") { running = false; return null; }
      await gate;
      running = false;
      return null;
    },
    finish() { this.released = true; release(); },
  };
}

test("runScheduledTask: a second concurrent run of the same task is skipped", async () => {
  const agentDir = freshAgentDir();
  const task = await seedTask(agentDir);
  const user = makeUser(agentDir);
  const session = gatedSession();
  let starts = 0;
  const { deps } = makeDeps(agentDir, {
    startSession: async () => { starts += 1; return session; },
  });

  const first = runScheduledTask(task, user, deps);
  const second = runScheduledTask(task, user, deps);
  const skipped = await second;
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.error, /already running/);
  assert.equal(starts, 1, "only one session may start for the same task");
  assert.equal(isScheduledTaskRunning(agentDir, task.id), true);

  session.finish();
  const ok = await first;
  assert.equal(ok.status, "ok");
  assert.equal(isScheduledTaskRunning(agentDir, task.id), false, "the guard must be released");
});

test("runScheduledTask: the in-flight guard is released even when the run fails", async () => {
  const agentDir = freshAgentDir();
  const task = await seedTask(agentDir);
  const { deps } = makeDeps(agentDir, {
    session: makeSession({ failPrompt: "boom" }),
  });

  const outcome = await runScheduledTask(task, makeUser(agentDir), deps);
  assert.equal(outcome.status, "error");
  assert.equal(isScheduledTaskRunning(agentDir, task.id), false);
});

test("runSchedulerTick: does not enqueue a task that already has a run in flight", async () => {
  const agentDir = freshAgentDir();
  const dataRoot = freshAgentDir();
  const task = await seedTask(agentDir);
  const now = new Date(Date.parse(task.nextRunAt) + 60_000);

  // Simulate a manual "run now" holding the task, with the tick due to fire.
  const session = gatedSession();
  const { deps: manualDeps } = makeDeps(agentDir, {
    now: () => now,
    startSession: async () => session,
  });
  const manual = runScheduledTask(
    sched.getScheduledTask(agentDir, task.id),
    makeUser(agentDir),
    manualDeps,
  );

  const tick = makeDeps(agentDir, { now: () => now });
  let tickStarts = 0;
  tick.deps.startSession = async () => { tickStarts += 1; return makeSession(); };
  const result = await runSchedulerTick(tick.deps, dataRoot);

  assert.equal(result.started, 0, "the tick must not start a duplicate run");
  assert.equal(tickStarts, 0);
  assert.equal(result.skippedLock, false);

  session.finish();
  await manual;
});

// ---------------------------------------------------------------------------
// Session keys — one fresh session per occurrence (C4)
// ---------------------------------------------------------------------------

test("sessionKeyFor: same task on different days yields different sessions", () => {
  const a = sessionKeyFor("st_abc", new Date("2026-10-09T01:00:00Z"));
  const b = sessionKeyFor("st_abc", new Date("2026-10-16T01:00:00Z"));
  assert.notEqual(a, b, "each run must start fresh, not grow one transcript");
  assert.match(a, /^sched:st_abc:2026-10-09$/);
});

// ---------------------------------------------------------------------------
// Scheduling: run records advance nextRunAt, so a slow run cannot re-fire
// ---------------------------------------------------------------------------

test("runScheduledTask: a run advances nextRunAt and is recorded on the task", async () => {
  const agentDir = freshAgentDir();
  const task = await seedTask(agentDir);
  // Run it once its slot has arrived, as the scheduler would.
  const dueAt = new Date(Date.parse(task.nextRunAt) + 60_000);
  const { deps } = makeDeps(agentDir, { now: () => dueAt });

  const outcome = await runScheduledTask(task, makeUser(agentDir), deps);
  assert.equal(outcome.status, "ok");

  const after = sched.getScheduledTask(agentDir, task.id);
  assert.ok(after.lastRun, "the run should be recorded");
  assert.equal(after.lastRun.status, "ok");
  assert.equal(after.lastRun.sessionId, "sess-abc");
  assert.ok(
    Date.parse(after.nextRunAt) > dueAt.getTime(),
    "nextRunAt must move forward past the run",
  );
});

// ---------------------------------------------------------------------------
// Tick: due selection, grace window, lock, concurrency
// ---------------------------------------------------------------------------

test("runSchedulerTick: runs a task that is due and advances it", async () => {
  const agentDir = freshAgentDir();
  const dataRoot = freshAgentDir();
  await seedTask(agentDir);
  const now = new Date(Date.parse(sched.getScheduledTask(agentDir, (await sched.listScheduledTasks(agentDir))[0].id).nextRunAt) + 60_000);
  const { deps } = makeDeps(agentDir, { now: () => now });

  const result = await runSchedulerTick(deps, dataRoot);

  assert.equal(result.started, 1);
  assert.equal(result.outcomes[0].status, "ok");
});

test("runSchedulerTick: does nothing when the task is not yet due", async () => {
  const agentDir = freshAgentDir();
  const dataRoot = freshAgentDir();
  await seedTask(agentDir);
  const { deps } = makeDeps(agentDir, { now: () => new Date("2026-01-01T00:00:00Z") });

  const result = await runSchedulerTick(deps, dataRoot);

  assert.equal(result.started, 0);
  assert.deepEqual(result.outcomes, []);
});

test("runSchedulerTick: an outage longer than the grace window skips rather than replays", async () => {
  const agentDir = freshAgentDir();
  const dataRoot = freshAgentDir();
  const task = await seedTask(agentDir);
  // Pretend the server was down for a week: the due time is far in the past.
  const wayLater = new Date(Date.parse(task.nextRunAt) + 7 * 24 * 3_600_000);
  const { deps, warns } = makeDeps(agentDir, { now: () => wayLater });

  const result = await runSchedulerTick(deps, dataRoot);

  assert.equal(result.started, 0, "a stale backlog must not fire a week of reports");
  const after = sched.getScheduledTask(agentDir, task.id);
  assert.equal(after.lastRun.status, "skipped");
  assert.ok(Date.parse(after.nextRunAt) > wayLater.getTime(), "and it must reschedule forward");
  assert.ok(warns.some((w) => /overdue/.test(w)));
});

test("runSchedulerTick: a task due within the grace window is still caught up", async () => {
  const agentDir = freshAgentDir();
  const dataRoot = freshAgentDir();
  const task = await seedTask(agentDir);
  // Down for an hour, then back: this one should run.
  const anHourLater = new Date(Date.parse(task.nextRunAt) + 3_600_000);
  const { deps } = makeDeps(agentDir, { now: () => anHourLater });

  const result = await runSchedulerTick(deps, dataRoot);

  assert.equal(result.started, 1);
});

test("runSchedulerTick: a disabled task is never run", async () => {
  const agentDir = freshAgentDir();
  const dataRoot = freshAgentDir();
  const task = await seedTask(agentDir);
  await sched.updateScheduledTask(agentDir, task.id, { enabled: false });
  const after = new Date(Date.parse(task.nextRunAt) + 60_000);
  const { deps } = makeDeps(agentDir, { now: () => after });

  const result = await runSchedulerTick(deps, dataRoot);

  assert.equal(result.started, 0);
});

test("runSchedulerTick: another process holding the lock makes this tick a no-op", async () => {
  const agentDir = freshAgentDir();
  const dataRoot = freshAgentDir();
  const task = await seedTask(agentDir);
  const now = new Date(Date.parse(task.nextRunAt) + 60_000);
  const first = makeDeps(agentDir, { now: () => now });

  // Hold the lock the way a concurrent process would, then tick.
  const lockfile = (await import("proper-lockfile")).default;
  const lockPath = join(dataRoot, "locks", "scheduler");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(lockPath, { recursive: true });
  const release = await lockfile.lock(lockPath);

  try {
    const second = makeDeps(agentDir, { now: () => now });
    const result = await runSchedulerTick(second.deps, dataRoot);
    assert.equal(result.skippedLock, true);
    assert.equal(result.started, 0);
    assert.equal(second.session.prompts.length, 0);
  } finally {
    await release();
  }

  void first;
});

test("runSchedulerTick: one user's failure does not stop another user's task", async () => {
  const agentDirA = freshAgentDir();
  const agentDirB = freshAgentDir();
  const dataRoot = freshAgentDir();
  const taskA = await seedTask(agentDirA, { createdBy: "zhangsan" });
  const taskB = await seedTask(agentDirB, { createdBy: "lisi", title: "lisi 的报告" });
  const now = new Date(
    Math.max(Date.parse(taskA.nextRunAt), Date.parse(taskB.nextRunAt)) + 60_000,
  );

  const userA = makeUser(agentDirA, "zhangsan");
  const userB = makeUser(agentDirB, "lisi");
  const promptsFor = { zhangsan: [], lisi: [] };
  const deps = {
    listUsers: () => [
      { username: "zhangsan", status: "active" },
      { username: "lisi", status: "active" },
    ],
    buildUserContext: (u) => (u.username === "zhangsan" ? userA : userB),
    startSession: async ({ user }) => {
      if (user.username === "zhangsan") throw new Error("zhangsan worker down");
      const session = makeSession();
      const originalSend = session.send;
      session.send = async (cmd) => {
        promptsFor.lisi.push(cmd);
        return originalSend.call(session, cmd);
      };
      return session;
    },
    notify: async () => {},
    defaultCwdFor: (u) => u.agentDir,
    isCwdAllowed: async () => true,
    warn: () => {},
    log: () => {},
    sleep: noSleep,
    now: () => now,
  };

  const result = await runSchedulerTick(deps, dataRoot);

  const byUser = Object.fromEntries(result.outcomes.map((o) => [o.username, o.status]));
  assert.equal(byUser.zhangsan, "error");
  assert.equal(byUser.lisi, "ok");
  assert.equal(promptsFor.lisi.length, 1);
});

test("runSchedulerTick: an inactive user is skipped entirely", async () => {
  const agentDir = freshAgentDir();
  const dataRoot = freshAgentDir();
  const task = await seedTask(agentDir);
  const now = new Date(Date.parse(task.nextRunAt) + 60_000);
  const { deps } = makeDeps(agentDir, {
    now: () => now,
    listUsers: () => [{ username: "zhangsan", status: "suspended" }],
  });

  const result = await runSchedulerTick(deps, dataRoot);

  assert.equal(result.started, 0);
});

test("a run whose model call failed is recorded as an error, not as ok", async () => {
  // A provider that is unreachable does not throw: the run ends normally with an
  // assistant message carrying stopReason "error". Before this, such a task was
  // reported `ok` and the only trace was a transcript of empty replies.
  const agentDir = freshAgentDir();
  const task = await seedTask(agentDir);
  const { deps } = makeDeps(agentDir, {
    session: makeSession({ runningStates: [true, false], runError: "Connection error." }),
  });

  const outcome = await runScheduledTask(task, makeUser(agentDir), deps);
  assert.equal(outcome.status, "error");
  assert.equal(outcome.error, "Connection error.");

  const stored = sched.readScheduleStore(agentDir).tasks.find((t) => t.id === task.id);
  assert.equal(stored.runs[0].status, "error");
  assert.equal(stored.runs[0].error, "Connection error.");
});

test("a run that produced no error is still recorded as ok", async () => {
  const agentDir = freshAgentDir();
  const task = await seedTask(agentDir);
  const { deps } = makeDeps(agentDir, {
    session: makeSession({ runningStates: [true, false], runError: null }),
  });

  const outcome = await runScheduledTask(task, makeUser(agentDir), deps);
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.error, undefined);
});
