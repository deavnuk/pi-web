import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const sched = await jiti.import("./scheduled-tasks.ts");

const {
  computeNextRun,
  parseScheduleSpec,
  describeSchedule,
  parseClockTime,
  isValidTimeZone,
  createScheduledTask,
  updateScheduledTask,
  removeScheduledTask,
  recordTaskRun,
  listScheduledTasks,
  listDueTasks,
  getScheduledTask,
  schedulesPath,
  ScheduleValidationError,
  DEFAULT_TIMEZONE,
} = sched;

function freshAgentDir() {
  return mkdtempSync(join(tmpdir(), "pi-scheduled-tasks-"));
}

const CST = "Asia/Shanghai";

// ---------------------------------------------------------------------------
// Timezone math — the highest-risk logic (no date library, see design §14.2 C6)
// ---------------------------------------------------------------------------

test("computeNextRun: weekly Friday 09:00 Asia/Shanghai resolves to the right UTC instant", () => {
  // 2026-10-01 is a Thursday; the next Friday 09:00 CST is 01:00Z.
  const from = new Date("2026-10-01T00:00:00Z");
  const next = computeNextRun({ kind: "weekly", weekday: 5, time: "09:00", timezone: CST }, from);
  assert.equal(next, "2026-10-02T01:00:00.000Z");
});

test("computeNextRun: weekly is strictly after `from` (same-day earlier time rolls a week)", () => {
  const fridayNine = new Date("2026-10-02T01:00:00Z"); // exactly 09:00 CST
  const next = computeNextRun({ kind: "weekly", weekday: 5, time: "09:00", timezone: CST }, fridayNine);
  assert.equal(next, "2026-10-09T01:00:00.000Z", "must not re-fire for the instant that already passed");
});

test("computeNextRun: weekly skips the correct number of days for every weekday", () => {
  // 2026-10-02 (Fri) 12:00 CST as the reference point.
  const from = new Date("2026-10-02T04:00:00Z");
  const expected = {
    5: "2026-10-09T01:00:00.000Z", // Friday  → next week
    6: "2026-10-03T01:00:00.000Z", // Saturday→ tomorrow
    0: "2026-10-04T01:00:00.000Z", // Sunday  → +2
    1: "2026-10-05T01:00:00.000Z", // Monday  → +3
    2: "2026-10-06T01:00:00.000Z", // Tuesday → +4
    3: "2026-10-07T01:00:00.000Z", // Wednesday → +5
    4: "2026-10-08T01:00:00.000Z", // Thursday  → +6
  };
  for (const [weekday, want] of Object.entries(expected)) {
    const next = computeNextRun(
      { kind: "weekly", weekday: Number(weekday), time: "09:00", timezone: CST },
      from,
    );
    assert.equal(next, want, `weekday=${weekday}`);
  }
});

test("computeNextRun: daily advances to tomorrow once today's time has passed", () => {
  const before = new Date("2026-10-02T00:30:00Z"); // 08:30 CST, before 09:00
  assert.equal(
    computeNextRun({ kind: "daily", time: "09:00", timezone: CST }, before),
    "2026-10-02T01:00:00.000Z",
  );
  const after = new Date("2026-10-02T02:00:00Z"); // 10:00 CST, after 09:00
  assert.equal(
    computeNextRun({ kind: "daily", time: "09:00", timezone: CST }, after),
    "2026-10-03T01:00:00.000Z",
  );
});

test("computeNextRun: monthly clamps day 31 to the last day of short months", () => {
  // From Jan 31 2027, the next month has no 31st → Feb 28.
  const next = computeNextRun(
    { kind: "monthly", day: 31, time: "09:00", timezone: CST },
    new Date("2027-01-31T05:00:00Z"),
  );
  assert.equal(next, "2027-02-28T01:00:00.000Z");
});

test("computeNextRun: monthly handles leap-year February", () => {
  const next = computeNextRun(
    { kind: "monthly", day: 31, time: "09:00", timezone: CST },
    new Date("2028-01-31T05:00:00Z"),
  );
  assert.equal(next, "2028-02-29T01:00:00.000Z", "2028 is a leap year → Feb 29");
});

test("computeNextRun: timezone actually changes the UTC instant", () => {
  const spec = { kind: "daily", time: "09:00" };
  const from = new Date("2026-10-02T00:00:00Z");
  const shanghai = computeNextRun({ ...spec, timezone: "Asia/Shanghai" }, from);
  const utc = computeNextRun({ ...spec, timezone: "UTC" }, from);
  assert.equal(shanghai, "2026-10-02T01:00:00.000Z");
  assert.equal(utc, "2026-10-02T09:00:00.000Z");
  assert.notEqual(shanghai, utc, "ignoring the timezone would fire 8 hours off");
});

test("computeNextRun: DST transition does not produce an off-by-one-hour run", () => {
  // US DST starts 2026-03-08; 09:00 local is 13:00Z the day before and 13:00Z after
  // (offset changes 5h → 4h, so the UTC hour shifts from 14:00Z to 13:00Z).
  const beforeDst = computeNextRun(
    { kind: "daily", time: "09:00", timezone: "America/New_York" },
    new Date("2026-03-07T00:00:00Z"),
  );
  const afterDst = computeNextRun(
    { kind: "daily", time: "09:00", timezone: "America/New_York" },
    new Date("2026-03-08T00:00:00Z"),
  );
  assert.equal(beforeDst, "2026-03-07T14:00:00.000Z", "EST = UTC-5");
  assert.equal(afterDst, "2026-03-08T13:00:00.000Z", "EDT = UTC-4");
});

test("computeNextRun: once returns the instant only when still in the future", () => {
  const from = new Date("2026-10-02T00:00:00Z");
  assert.equal(
    computeNextRun({ kind: "once", at: "2026-12-25T09:00:00Z", timezone: UTC_FALLBACK() }, from),
    "2026-12-25T09:00:00.000Z",
  );
  assert.equal(
    computeNextRun({ kind: "once", at: "2020-01-01T00:00:00Z", timezone: UTC_FALLBACK() }, from),
    null,
    "a consumed one-shot must not re-fire",
  );
});

function UTC_FALLBACK() {
  return "UTC";
}

test("computeNextRun: malformed spec yields null instead of throwing", () => {
  const from = new Date("2026-10-02T00:00:00Z");
  assert.equal(computeNextRun({ kind: "daily", time: "25:99", timezone: CST }, from), null);
  assert.equal(computeNextRun({ kind: "daily", time: "09:00", timezone: "Not/AZone" }, from), null);
  assert.equal(computeNextRun({ kind: "once", at: "not-a-date", timezone: "UTC" }, from), null);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("parseScheduleSpec: accepts each supported kind and normalizes the time", () => {
  assert.deepEqual(parseScheduleSpec({ kind: "daily", time: "9:05" }), {
    kind: "daily", time: "09:05", timezone: DEFAULT_TIMEZONE,
  });
  assert.deepEqual(parseScheduleSpec({ kind: "weekly", weekday: 5, time: "09:00", timezone: CST }), {
    kind: "weekly", weekday: 5, time: "09:00", timezone: CST,
  });
  assert.deepEqual(parseScheduleSpec({ kind: "monthly", day: 1, time: "00:00", timezone: CST }), {
    kind: "monthly", day: 1, time: "00:00", timezone: CST,
  });
});

test("parseScheduleSpec: rejects malformed input with actionable messages", () => {
  const cases = [
    [{ kind: "hourly", time: "09:00" }, /Unsupported schedule kind/],
    [{ kind: "weekly", time: "09:00" }, /weekday/],
    [{ kind: "weekly", weekday: 7, time: "09:00" }, /weekday/],
    [{ kind: "weekly", weekday: 5, time: "09:70" }, /Invalid time/],
    [{ kind: "monthly", day: 0, time: "09:00" }, /between 1 and 31/],
    [{ kind: "monthly", day: 32, time: "09:00" }, /between 1 and 31/],
    [{ kind: "daily", time: "09:00", timezone: "Mars/Olympus" }, /Unknown timezone/],
    [{ kind: "once" }, /ISO 8601/],
    [null, /must be an object/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => parseScheduleSpec(input), ScheduleValidationError, JSON.stringify(input));
    assert.throws(() => parseScheduleSpec(input), pattern, JSON.stringify(input));
  }
});

test("parseClockTime: validates the 24-hour HH:MM form", () => {
  assert.deepEqual(parseClockTime("00:00"), { hour: 0, minute: 0 });
  assert.deepEqual(parseClockTime("23:59"), { hour: 23, minute: 59 });
  assert.equal(parseClockTime("24:00"), null);
  assert.equal(parseClockTime("9:5"), null, "minutes must be two digits");
  assert.equal(parseClockTime("09:00:00"), null);
});

test("isValidTimeZone: accepts IANA zones and rejects junk", () => {
  assert.equal(isValidTimeZone("Asia/Shanghai"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Not/AZone"), false);
});

test("describeSchedule: renders a human-readable recurrence", () => {
  assert.equal(
    describeSchedule({ kind: "weekly", weekday: 5, time: "09:00", timezone: CST }),
    "Every Friday at 09:00 (Asia/Shanghai)",
  );
  assert.match(describeSchedule({ kind: "daily", time: "08:00", timezone: CST }), /Every day at 08:00/);
  assert.match(describeSchedule({ kind: "monthly", day: 31, time: "09:00", timezone: CST }), /Day 31/);
});

// ---------------------------------------------------------------------------
// Store: persistence, permissions, locking
// ---------------------------------------------------------------------------

test("createScheduledTask: persists to <agentDir>/schedules.json with 0600", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "周五债券周报",
    prompt: "汇总本周信用债一级发行，输出 Markdown 报告",
    schedule: { kind: "weekly", weekday: 5, time: "09:00", timezone: CST },
    createdBy: "zhangsan",
    now: new Date("2026-10-01T00:00:00Z"),
  });

  assert.match(task.id, /^st_[0-9a-f]{12}$/);
  assert.equal(task.enabled, true);
  assert.equal(task.nextRunAt, "2026-10-02T01:00:00.000Z");
  assert.equal(task.createdBy, "zhangsan");

  const path = schedulesPath(agentDir);
  assert.ok(existsSync(path));
  assert.equal(statSync(path).mode & 0o777, 0o600, "task prompts can contain secrets — must be private");

  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(onDisk.tasks.length, 1);
  assert.equal(onDisk.tasks[0].prompt, task.prompt);

  assert.deepEqual(listScheduledTasks(agentDir).map((t) => t.id), [task.id]);
});

test("createScheduledTask: rejects a schedule with no future occurrence", async () => {
  const agentDir = freshAgentDir();
  await assert.rejects(
    createScheduledTask(agentDir, {
      title: "past",
      prompt: "x",
      schedule: { kind: "once", at: "2020-01-01T00:00:00Z", timezone: "UTC" },
      createdBy: "u",
      now: new Date("2026-10-01T00:00:00Z"),
    }),
    /no future occurrence/,
  );
});

test("createScheduledTask: rejects empty/oversized fields and relative cwd", async () => {
  const agentDir = freshAgentDir();
  const base = { title: "t", prompt: "p", createdBy: "u", now: new Date("2026-10-01T00:00:00Z") };
  const schedule = { kind: "daily", time: "09:00", timezone: CST };

  await assert.rejects(createScheduledTask(agentDir, { ...base, title: "  ", schedule }), /title must not be empty/);
  await assert.rejects(createScheduledTask(agentDir, { ...base, prompt: "", schedule }), /prompt must not be empty/);
  await assert.rejects(
    createScheduledTask(agentDir, { ...base, schedule, cwd: "relative/path" }),
    /cwd must be an absolute path/,
  );
  await assert.rejects(
    createScheduledTask(agentDir, { ...base, schedule, title: "x".repeat(201) }),
    /at most 200 characters/,
  );
});

test("createScheduledTask: enforces the per-user cap", async () => {
  const agentDir = freshAgentDir();
  const schedule = { kind: "daily", time: "09:00", timezone: CST };
  for (let i = 0; i < sched.MAX_TASKS_PER_USER; i++) {
    await createScheduledTask(agentDir, { title: `t${i}`, prompt: "p", schedule, createdBy: "u" });
  }
  await assert.rejects(
    createScheduledTask(agentDir, { title: "overflow", prompt: "p", schedule, createdBy: "u" }),
    /Too many scheduled tasks/,
  );
});

test("updateScheduledTask: changing the schedule recomputes nextRunAt", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "t", prompt: "p",
    schedule: { kind: "weekly", weekday: 5, time: "09:00", timezone: CST },
    createdBy: "u", now: new Date("2026-10-01T00:00:00Z"),
  });
  const updated = await updateScheduledTask(agentDir, task.id, {
    schedule: { kind: "weekly", weekday: 1, time: "08:00", timezone: CST },
    now: new Date("2026-10-01T00:00:00Z"),
  });
  assert.equal(updated.schedule.weekday, 1);
  assert.equal(updated.nextRunAt, "2026-10-05T00:00:00.000Z", "Monday 08:00 CST");
});

test("updateScheduledTask: re-enabling a spent one-shot leaves it inert, not looping", async () => {
  const agentDir = freshAgentDir();
  const now = new Date("2026-10-01T00:00:00Z");
  const task = await createScheduledTask(agentDir, {
    title: "t", prompt: "p",
    schedule: { kind: "once", at: "2026-10-02T00:00:00Z", timezone: "UTC" },
    createdBy: "u", now,
  });
  // Simulate the run having fired and cleared nextRunAt.
  await recordTaskRun(agentDir, task.id, { status: "ok" }, new Date("2026-10-02T00:00:01Z"));
  assert.equal(getScheduledTask(agentDir, task.id).nextRunAt, null);

  // Re-enabled well after the one-shot's instant.
  const reEnabled = await updateScheduledTask(agentDir, task.id, {
    enabled: true,
    now: new Date("2026-10-03T00:00:00Z"),
  });
  assert.equal(reEnabled.enabled, true);
  assert.equal(
    reEnabled.nextRunAt, null,
    "a consumed one-shot has no future instant — it stays null rather than looping",
  );
});

test("updateScheduledTask: re-enabling a daily task refills a stale nextRunAt", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "t", prompt: "p",
    schedule: { kind: "weekly", weekday: 5, time: "09:00", timezone: CST },
    createdBy: "u", now: new Date("2026-10-01T00:00:00Z"),
  });
  await updateScheduledTask(agentDir, task.id, { enabled: false });
  const reEnabled = await updateScheduledTask(agentDir, task.id, {
    enabled: true,
    now: new Date("2026-10-20T00:00:00Z"),
  });
  assert.equal(
    reEnabled.nextRunAt, "2026-10-23T01:00:00.000Z",
    "a disabled recurring task must come back with a fresh future instant",
  );
});

test("updateScheduledTask: unknown id and enable/disable round-trip", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "t", prompt: "p",
    schedule: { kind: "daily", time: "09:00", timezone: CST },
    createdBy: "u",
  });
  const off = await updateScheduledTask(agentDir, task.id, { enabled: false });
  assert.equal(off.enabled, false);

  await assert.rejects(updateScheduledTask(agentDir, "st_missing", { enabled: true }), /not found/);
});

test("removeScheduledTask: deletes and reports whether anything was removed", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "t", prompt: "p",
    schedule: { kind: "daily", time: "09:00", timezone: CST },
    createdBy: "u",
  });
  assert.equal(await removeScheduledTask(agentDir, task.id), true);
  assert.deepEqual(listScheduledTasks(agentDir), []);
  assert.equal(await removeScheduledTask(agentDir, task.id), false);
});

// ---------------------------------------------------------------------------
// Due selection + run recording
// ---------------------------------------------------------------------------

test("listDueTasks: only enabled tasks at or before `now`, oldest first", async () => {
  const agentDir = freshAgentDir();
  // createScheduledTask refuses specs with no future occurrence, so each task is
  // created "before" its instant and evaluated against a later `now`.
  const createdAt = new Date("2026-10-02T00:00:00Z");
  const evaluatedAt = new Date("2026-10-02T01:00:00Z");

  const dueNow = await createScheduledTask(agentDir, {
    title: "due-now", prompt: "p",
    schedule: { kind: "once", at: "2026-10-02T00:30:00Z", timezone: "UTC" },
    createdBy: "u", now: createdAt,
  });
  await createScheduledTask(agentDir, {
    title: "due-later", prompt: "p",
    schedule: { kind: "once", at: "2026-10-03T00:00:00Z", timezone: "UTC" },
    createdBy: "u", now: createdAt,
  });
  const disabled = await createScheduledTask(agentDir, {
    title: "disabled", prompt: "p",
    schedule: { kind: "once", at: "2026-10-02T00:30:00Z", timezone: "UTC" },
    createdBy: "u", now: createdAt,
  });
  await updateScheduledTask(agentDir, disabled.id, { enabled: false });

  const due = listDueTasks(agentDir, evaluatedAt);
  assert.deepEqual(due.map((t) => t.id), [dueNow.id], "disabled tasks must never fire");
});

test("recordTaskRun: stores the outcome and advances nextRunAt past `now`", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "t", prompt: "p",
    schedule: { kind: "daily", time: "09:00", timezone: CST },
    createdBy: "u", now: new Date("2026-10-01T00:00:00Z"),
  });

  const runAt = new Date("2026-10-02T01:00:05Z");
  const after = await recordTaskRun(agentDir, task.id, { status: "ok", sessionId: "sess-1" }, runAt);
  assert.equal(after.lastRun.status, "ok");
  assert.equal(after.lastRun.sessionId, "sess-1");
  assert.equal(after.lastRun.at, "2026-10-02T01:00:05.000Z");
  // Recomputed from `now`, so the run that just happened cannot re-fire.
  assert.equal(after.nextRunAt, "2026-10-03T01:00:00.000Z");
  assert.deepEqual(listDueTasks(agentDir, new Date("2026-10-02T02:00:00Z")), []);
});

test("recordTaskRun: truncates long error text so the store cannot balloon", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "t", prompt: "p",
    schedule: { kind: "daily", time: "09:00", timezone: CST },
    createdBy: "u",
  });
  const after = await recordTaskRun(agentDir, task.id, { status: "error", error: "x".repeat(5000) });
  assert.equal(after.lastRun.error.length, 500);
});

test("recordTaskRun: concurrent writes do not lose tasks (file lock)", async () => {
  const agentDir = freshAgentDir();
  const schedule = { kind: "daily", time: "09:00", timezone: CST };
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      createScheduledTask(agentDir, { title: `t${i}`, prompt: "p", schedule, createdBy: "u" }),
    ),
  );
  assert.equal(listScheduledTasks(agentDir).length, 10, "read-modify-write must be serialized");
});

test("readScheduleStore: a corrupt store fails closed instead of throwing", async () => {
  const agentDir = freshAgentDir();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(schedulesPath(agentDir), "{ not json", { mode: 0o600 });
  assert.deepEqual(listScheduledTasks(agentDir), []);
});

test("readScheduleStore: one invalid task is dropped without disabling the others", async () => {
  const agentDir = freshAgentDir();
  await createScheduledTask(agentDir, {
    title: "good", prompt: "p",
    schedule: { kind: "daily", time: "09:00", timezone: CST },
    createdBy: "u",
  });
  const path = schedulesPath(agentDir);
  const store = JSON.parse(readFileSync(path, "utf8"));
  store.tasks.push({ id: "st_bad", title: "bad", prompt: "p", schedule: { kind: "nope" } });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, JSON.stringify(store), { mode: 0o600 });

  const tasks = listScheduledTasks(agentDir);
  assert.deepEqual(tasks.map((t) => t.title), ["good"]);
});

// ---------------------------------------------------------------------------
// Natural-language weekday input
// ---------------------------------------------------------------------------

test("parseWeekday: accepts numbers, English names and Chinese names", () => {
  assert.equal(sched.parseWeekday(5), 5);
  assert.equal(sched.parseWeekday(0), 0);
  assert.equal(sched.parseWeekday("Friday"), 5);
  assert.equal(sched.parseWeekday("friday"), 5);
  assert.equal(sched.parseWeekday("FRI"), 5);
  assert.equal(sched.parseWeekday("周五"), 5);
  assert.equal(sched.parseWeekday("星期五"), 5);
  assert.equal(sched.parseWeekday("周日"), 0);
  assert.equal(sched.parseWeekday("星期天"), 0);
});

test("parseWeekday: rejects out-of-range and unknown values", () => {
  assert.equal(sched.parseWeekday(7), null);
  assert.equal(sched.parseWeekday(-1), null);
  assert.equal(sched.parseWeekday(1.5), null);
  assert.equal(sched.parseWeekday("someday"), null);
  assert.equal(sched.parseWeekday(null), null);
});

test("parseScheduleSpec: a named weekday produces the same spec as its number", () => {
  const named = parseScheduleSpec({ kind: "weekly", weekday: "Friday", time: "09:00", timezone: CST });
  const numbered = parseScheduleSpec({ kind: "weekly", weekday: 5, time: "09:00", timezone: CST });
  assert.deepEqual(named, numbered);
  // And it computes the same next run.
  const from = new Date("2026-10-01T00:00:00Z");
  assert.equal(computeNextRun(named, from), computeNextRun(numbered, from));
  assert.equal(computeNextRun(named, from), "2026-10-02T01:00:00.000Z");
});

test("parseScheduleSpec: unknown weekday name is a validation error, not a silent default", () => {
  assert.throws(
    () => parseScheduleSpec({ kind: "weekly", weekday: "Funday", time: "09:00" }),
    /weekday/,
  );
});

// ---------------------------------------------------------------------------
// Run history (Settings → 定时任务 needs "what did each run do")
// ---------------------------------------------------------------------------

test("recordTaskRun: accumulates a bounded, newest-first history", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "t", prompt: "p",
    schedule: { kind: "daily", time: "09:00", timezone: CST },
    createdBy: "u",
  });

  for (let i = 0; i < 3; i += 1) {
    await recordTaskRun(
      agentDir,
      task.id,
      { status: "ok", sessionId: `sess-${i}` },
      new Date(`2026-10-0${i + 2}T01:00:00Z`),
    );
  }

  const after = getScheduledTask(agentDir, task.id);
  assert.equal(after.runs.length, 3);
  assert.equal(after.runs[0].sessionId, "sess-2", "newest first");
  assert.equal(after.runs[2].sessionId, "sess-0");
  // lastRun stays the cheap "latest" alias for older readers.
  assert.deepEqual(after.lastRun, after.runs[0]);
});

test("recordTaskRun: history is capped so a frequent task cannot grow the store forever", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "t", prompt: "p",
    schedule: { kind: "daily", time: "09:00", timezone: CST },
    createdBy: "u",
  });

  for (let i = 0; i < sched.MAX_RUN_HISTORY + 5; i += 1) {
    await recordTaskRun(
      agentDir,
      task.id,
      { status: "ok", sessionId: `sess-${i}` },
      new Date(Date.UTC(2026, 9, 1, 1, i)),
    );
  }

  const after = getScheduledTask(agentDir, task.id);
  assert.equal(after.runs.length, sched.MAX_RUN_HISTORY);
  assert.equal(after.runs[0].sessionId, `sess-${sched.MAX_RUN_HISTORY + 4}`, "keeps the newest");
  assert.equal(after.lastRun.sessionId, after.runs[0].sessionId);
});

test("history survives a reload from disk (it is persisted, not in-memory)", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "t", prompt: "p",
    schedule: { kind: "daily", time: "09:00", timezone: CST },
    createdBy: "u",
  });
  await recordTaskRun(agentDir, task.id, { status: "error", error: "boom" }, new Date("2026-10-02T01:00:00Z"));

  const reloaded = getScheduledTask(agentDir, task.id);
  assert.equal(reloaded.runs.length, 1);
  assert.equal(reloaded.runs[0].status, "error");
  assert.equal(reloaded.runs[0].error, "boom");
});

test("a corrupt runs[] is dropped without losing the task", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "t", prompt: "p",
    schedule: { kind: "daily", time: "09:00", timezone: CST },
    createdBy: "u",
  });
  const store = JSON.parse(readFileSync(schedulesPath(agentDir), "utf8"));
  store.tasks[0].runs = [{ nonsense: true }, "junk"];
  writeFileSync(schedulesPath(agentDir), JSON.stringify(store));

  const after = getScheduledTask(agentDir, task.id);
  assert.ok(after, "the task itself must survive");
  assert.equal(after.runs, undefined);
});

// ---------------------------------------------------------------------------
// toTaskView — the shape the settings UI consumes
// ---------------------------------------------------------------------------

test("toTaskView: passes the structured schedule through so the UI can localize it", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "周五报告", prompt: "汇总",
    schedule: { kind: "weekly", weekday: 5, time: "09:00", timezone: CST },
    createdBy: "u",
  });

  const view = sched.toTaskView(task);
  assert.equal(view.schedule.kind, "weekly");
  assert.equal(view.schedule.weekday, 5);
  assert.equal(view.schedule.time, "09:00");
  assert.equal(view.schedule.timezone, CST);
  assert.equal(view.describes, describeSchedule(task.schedule));
  assert.deepEqual(view.runs, [], "no runs yet");
});

test("toTaskView: falls back to lastRun when no runs[] exists yet", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "t", prompt: "p",
    schedule: { kind: "daily", time: "09:00", timezone: CST },
    createdBy: "u",
  });
  // Simulate a store written before history existed.
  const store = JSON.parse(readFileSync(schedulesPath(agentDir), "utf8"));
  store.tasks[0].lastRun = { at: "2026-10-01T01:00:00.000Z", status: "ok", sessionId: "old-1" };
  delete store.tasks[0].runs;
  writeFileSync(schedulesPath(agentDir), JSON.stringify(store));

  const view = sched.toTaskView(getScheduledTask(agentDir, task.id));
  assert.equal(view.runs.length, 1);
  assert.equal(view.runs[0].sessionId, "old-1");
});

test("toTaskView: carries sessionId so the UI can open each run's transcript", async () => {
  const agentDir = freshAgentDir();
  const task = await createScheduledTask(agentDir, {
    title: "t", prompt: "p",
    schedule: { kind: "daily", time: "09:00", timezone: CST },
    createdBy: "u",
  });
  await recordTaskRun(agentDir, task.id, { status: "ok", sessionId: "sess-xyz" }, new Date("2026-10-02T01:00:00Z"));

  const view = sched.toTaskView(getScheduledTask(agentDir, task.id));
  assert.equal(view.runs[0].sessionId, "sess-xyz");
});
