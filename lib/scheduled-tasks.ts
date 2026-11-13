import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { ScheduledTaskView } from "./api-types";

/**
 * Per-user scheduled tasks ("run this every Friday at 09:00").
 *
 * Stored at <agentDir>/schedules.json with 0600 permissions, mirroring
 * secrets.json: the file lives inside the owner's agentDir, so isolation is
 * structural rather than enforced by a query filter. Mutations go through
 * proper-lockfile + atomic writes; reads are lock-free.
 *
 * The scheduler that *runs* these lives in the main process (instrumentation.ts)
 * — see docs/multiuser/technical-design.md §14.
 */

export const SCHEDULE_STORE_VERSION = 1;

/** Product default: the deployment serves a China-based desk. */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** Per-task execution history kept on disk (newest first). */
export const MAX_RUN_HISTORY = 20;

export const MAX_TITLE_LENGTH = 200;
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_TASKS_PER_USER = 50;

/** Bound the day-by-day search so a malformed spec can never spin forever. */
const MAX_DAILY_SCAN_DAYS = 366;
const MAX_MONTHLY_SCAN_MONTHS = 24;

export type ScheduleKind = "once" | "daily" | "weekly" | "monthly";

export interface OnceSchedule {
  kind: "once";
  /** Absolute instant (ISO 8601, UTC). `timezone` is informational only. */
  at: string;
  timezone: string;
}

export interface DailySchedule {
  kind: "daily";
  /** Local wall-clock time, "HH:MM". */
  time: string;
  timezone: string;
}

export interface WeeklySchedule {
  kind: "weekly";
  /** 0 = Sunday … 6 = Saturday (matches Date#getUTCDay). */
  weekday: number;
  time: string;
  timezone: string;
}

export interface MonthlySchedule {
  kind: "monthly";
  /** 1-31. Clamped to the month's last day when the day does not exist. */
  day: number;
  time: string;
  timezone: string;
}

export type ScheduleSpec = OnceSchedule | DailySchedule | WeeklySchedule | MonthlySchedule;

export type RunStatus = "ok" | "error" | "skipped" | "timeout";

export interface TaskRunRecord {
  at: string;
  status: RunStatus;
  sessionId?: string;
  error?: string;
}

/**
 * A run as surfaced to the UI.
 *
 * `sessionId` is the transcript of that execution: scheduled runs start a
 * fresh session each time, so the history doubles as a list of conversations
 * to open.
 */
export interface TaskRunView extends TaskRunRecord {
  /** Resolves the transcript in the UI (`/?session=<id>`). */
  sessionId?: string;
}

export interface ScheduledTask {
  id: string;
  title: string;
  /** The prompt sent to a fresh session each time the task fires. */
  prompt: string;
  schedule: ScheduleSpec;
  /** Working directory for the run. Defaults to the user's project root. */
  cwd?: string;
  enabled: boolean;
  /** ISO instant of the next due run, or null when nothing is pending. */
  nextRunAt: string | null;
  lastRun?: TaskRunRecord;
  /**
   * Recent executions, newest first, capped at MAX_RUN_HISTORY. `lastRun`
   * duplicates `runs[0]` for the common "what happened most recently" case and
   * for readers that predate this field.
   */
  runs?: TaskRunRecord[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface ScheduleStore {
  version: number;
  tasks: ScheduledTask[];
}

/** Thrown for anything the caller (tool or API route) should fix before retrying. */
export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export function schedulesPath(agentDir: string): string {
  return join(agentDir, "schedules.json");
}

// ---------------------------------------------------------------------------
// Timezone helpers (no external date library — see §14.2 C6)
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

interface CivilTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock reading of `date` in `timeZone`. */
function civilTimeInZone(date: Date, timeZone: string): CivilTime {
  const parts = formatterFor(timeZone).formatToParts(date);
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  // Some ICU versions report midnight as hour 24 under hour12:false.
  const hour = read("hour") === 24 ? 0 : read("hour");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour,
    minute: read("minute"),
    second: read("second"),
  };
}

/** Offset of `timeZone` at `date`, in ms (positive east of UTC). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const civil = civilTimeInZone(date, timeZone);
  const asUtc = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, civil.second);
  const flooredToSecond = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - flooredToSecond;
}

/**
 * Convert a wall-clock time in `timeZone` to an absolute instant.
 *
 * Two-pass offset resolution, then a round-trip check: a local time that does
 * not exist (the spring-forward gap) fails the check and yields null, and the
 * caller moves on to the next candidate day.
 */
function zonedTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date | null {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = utcGuess - zoneOffsetMs(new Date(utcGuess), timeZone);
  ts = utcGuess - zoneOffsetMs(new Date(ts), timeZone);

  const result = new Date(ts);
  const back = civilTimeInZone(result, timeZone);
  if (back.year !== year || back.month !== month || back.day !== day
    || back.hour !== hour || back.minute !== minute) {
    return null;
  }
  return result;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Pure civil-date arithmetic — UTC has no DST, so this is safe. */
function addCivilDays(year: number, month: number, day: number, delta: number): CivilTime {
  const shifted = new Date(Date.UTC(year, month - 1, day) + delta * 86_400_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

function civilWeekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** "HH:MM" → { hour, minute }, or null when malformed. */
export function parseClockTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Next instant this spec is due, strictly after `from`. Null when the spec has
 * no future occurrence (a `once` schedule already consumed).
 */
export function computeNextRun(spec: ScheduleSpec, from: Date = new Date()): string | null {
  switch (spec.kind) {
    case "once": {
      const at = Date.parse(spec.at);
      if (!Number.isFinite(at)) return null;
      return at > from.getTime() ? new Date(at).toISOString() : null;
    }
    case "daily":
    case "weekly":
    case "monthly":
      return nextRecurring(spec, from);
  }
}

function nextRecurring(
  spec: DailySchedule | WeeklySchedule | MonthlySchedule,
  from: Date,
): string | null {
  const clock = parseClockTime(spec.time);
  if (!clock || !isValidTimeZone(spec.timezone)) return null;

  const start = civilTimeInZone(from, spec.timezone);
  const fromMs = from.getTime();

  if (spec.kind === "monthly") {
    let year = start.year;
    let month = start.month;
    for (let i = 0; i < MAX_MONTHLY_SCAN_MONTHS; i++) {
      const day = Math.min(spec.day, daysInMonth(year, month));
      const candidate = zonedTimeToInstant(year, month, day, clock.hour, clock.minute, spec.timezone);
      if (candidate && candidate.getTime() > fromMs) return candidate.toISOString();
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return null;
  }

  // daily + weekly: scan day by day (≤8 days is enough, but keep it uniform).
  const limit = spec.kind === "weekly" ? 8 : MAX_DAILY_SCAN_DAYS;
  for (let i = 0; i < limit; i++) {
    const day = addCivilDays(start.year, start.month, start.day, i);
    if (spec.kind === "weekly" && civilWeekday(day.year, day.month, day.day) !== spec.weekday) {
      continue;
    }
    const candidate = zonedTimeToInstant(
      day.year,
      day.month,
      day.day,
      clock.hour,
      clock.minute,
      spec.timezone,
    );
    if (candidate && candidate.getTime() > fromMs) return candidate.toISOString();
  }
  return null;
}

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0, 周日: 0, 星期日: 0, 星期天: 0, 周天: 0,
  monday: 1, mon: 1, 周一: 1, 星期一: 1,
  tuesday: 2, tue: 2, tues: 2, 周二: 2, 星期二: 2,
  wednesday: 3, wed: 3, 周三: 3, 星期三: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, 周四: 4, 星期四: 4,
  friday: 5, fri: 5, 周五: 5, 星期五: 5,
  saturday: 6, sat: 6, 周六: 6, 星期六: 6,
};

/**
 * Accept a weekday as 0-6 or as a name ("Friday", "fri", "周五").
 * Natural-language input rarely arrives as a number, and a wrong day is a
 * silent, week-long failure — being liberal here is cheaper than being strict.
 * Returns null when unrecognised.
 */
export function parseWeekday(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 6 ? value : null;
  }
  if (typeof value === "string") {
    const key = value.trim().toLowerCase().replace(/[\s.\u3000]/g, "");
    return WEEKDAY_NAMES[key] ?? null;
  }
  return null;
}

/** Compact human-readable form for tool output and the settings UI. */
export function describeSchedule(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case "once":
      return `Once at ${spec.at}`;
    case "daily":
      return `Every day at ${spec.time} (${spec.timezone})`;
    case "weekly":
      return `Every ${WEEKDAY_LABELS[spec.weekday] ?? `weekday#${spec.weekday}`} at ${spec.time} (${spec.timezone})`;
    case "monthly": {
      // Show the clamp explicitly: "day 31" really means "last day" in short months.
      return `Day ${spec.day} of every month at ${spec.time} (${spec.timezone})`;
    }
  }
}

/**
 * Serialize a task for the settings UI.
 *
 * The structured schedule is passed through alongside a rendered description
 * so the client can localize it rather than displaying English prose.
 */
export function toTaskView(task: ScheduledTask): ScheduledTaskView {
  const schedule: ScheduledTaskView["schedule"] = {
    kind: task.schedule.kind,
    timezone: task.schedule.timezone,
    ...(task.schedule.kind === "once" ? { at: task.schedule.at } : {}),
    ...(task.schedule.kind === "daily" || task.schedule.kind === "weekly" || task.schedule.kind === "monthly"
      ? { time: task.schedule.time }
      : {}),
    ...(task.schedule.kind === "weekly" ? { weekday: task.schedule.weekday } : {}),
    ...(task.schedule.kind === "monthly" ? { day: task.schedule.day } : {}),
  };
  // `lastRun` predates `runs`; honour it so a store written by an older build
  // still shows its most recent execution.
  const runs = task.runs?.length ? task.runs : task.lastRun ? [task.lastRun] : [];
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    schedule,
    describes: describeSchedule(task.schedule),
    ...(task.cwd ? { cwd: task.cwd } : {}),
    enabled: task.enabled,
    nextRunAt: task.nextRunAt,
    runs,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new ScheduleValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new ScheduleValidationError(`${field} must not be empty`);
  if (trimmed.length > max) {
    throw new ScheduleValidationError(`${field} must be at most ${max} characters`);
  }
  return trimmed;
}

function requireTimezone(value: unknown): string {
  const timeZone = value === undefined || value === null || value === ""
    ? DEFAULT_TIMEZONE
    : requireString(value, "timezone", 64);
  if (!isValidTimeZone(timeZone)) {
    throw new ScheduleValidationError(`Unknown timezone: ${timeZone}`);
  }
  return timeZone;
}

/**
 * Validate an untrusted schedule object (tool params / HTTP body) into a spec.
 * Throws ScheduleValidationError with an actionable message.
 */
export function parseScheduleSpec(raw: unknown): ScheduleSpec {
  if (!raw || typeof raw !== "object") {
    throw new ScheduleValidationError("schedule must be an object");
  }
  const input = raw as Record<string, unknown>;
  const kind = input.kind;
  const timezone = requireTimezone(input.timezone);

  switch (kind) {
    case "once": {
      if (typeof input.at !== "string" || !Number.isFinite(Date.parse(input.at))) {
        throw new ScheduleValidationError("once schedule requires `at` as an ISO 8601 timestamp");
      }
      return { kind: "once", at: new Date(Date.parse(input.at)).toISOString(), timezone };
    }
    case "daily": {
      const time = requireClockTime(input.time);
      return { kind: "daily", time, timezone };
    }
    case "weekly": {
      const time = requireClockTime(input.time);
      const weekday = parseWeekday(input.weekday);
      if (weekday === null) {
        throw new ScheduleValidationError(
          "weekly schedule requires `weekday`: 0 (Sunday) … 6 (Saturday), or a name like Friday",
        );
      }
      return { kind: "weekly", weekday, time, timezone };
    }
    case "monthly": {
      const time = requireClockTime(input.time);
      const day = input.day;
      if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31) {
        throw new ScheduleValidationError("monthly schedule requires `day` between 1 and 31");
      }
      return { kind: "monthly", day, time, timezone };
    }
    default:
      throw new ScheduleValidationError(
        `Unsupported schedule kind: ${String(kind)} (expected once|daily|weekly|monthly)`,
      );
  }
}

function requireClockTime(value: unknown): string {
  if (typeof value !== "string") {
    throw new ScheduleValidationError("time must be a string in HH:MM form");
  }
  const parsed = parseClockTime(value);
  if (!parsed) throw new ScheduleValidationError(`Invalid time: ${value} (expected HH:MM, 24-hour)`);
  return `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
}

export interface CreateScheduledTaskInput {
  /** Validated by createScheduledTask; typed loosely so HTTP bodies are accepted. */
  title: unknown;
  prompt: unknown;
  schedule: unknown;
  cwd?: unknown;
  timezone?: unknown;
  createdBy: string;
  /** Reference instant for computing the first nextRunAt; injectable for tests. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Store read / write
// ---------------------------------------------------------------------------

function parseStore(raw: unknown): ScheduleStore {
  if (!raw || typeof raw !== "object") return { version: SCHEDULE_STORE_VERSION, tasks: [] };
  const tasks = (raw as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return { version: SCHEDULE_STORE_VERSION, tasks: [] };

  const parsed: ScheduledTask[] = [];
  for (const entry of tasks) {
    if (!entry || typeof entry !== "object") continue;
    const task = entry as Record<string, unknown>;
    if (typeof task.id !== "string" || typeof task.prompt !== "string") continue;
    // A schedule that no longer validates is dropped rather than crashing the
    // whole store — one bad task must not disable every other one.
    let schedule: ScheduleSpec;
    try {
      schedule = parseScheduleSpec(task.schedule);
    } catch {
      continue;
    }
    parsed.push({
      id: task.id,
      title: typeof task.title === "string" ? task.title : "Untitled task",
      prompt: task.prompt,
      schedule,
      ...(typeof task.cwd === "string" ? { cwd: task.cwd } : {}),
      enabled: task.enabled !== false,
      nextRunAt: typeof task.nextRunAt === "string" ? task.nextRunAt : null,
      ...(isRunRecord(task.lastRun) ? { lastRun: task.lastRun } : {}),
      ...(isRunList(task.runs) ? { runs: task.runs } : {}),
      createdAt: typeof task.createdAt === "string" ? task.createdAt : new Date(0).toISOString(),
      updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : new Date(0).toISOString(),
      createdBy: typeof task.createdBy === "string" ? task.createdBy : "",
    });
  }
  return { version: SCHEDULE_STORE_VERSION, tasks: parsed };
}

function isRunRecord(value: unknown): value is TaskRunRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.at === "string"
    && (record.status === "ok" || record.status === "error"
      || record.status === "skipped" || record.status === "timeout");
}

/** Keep only well-formed records; a corrupt entry must not sink the task. */
function isRunList(value: unknown): value is TaskRunRecord[] {
  return Array.isArray(value) && value.every(isRunRecord);
}

export function readScheduleStore(agentDir: string): ScheduleStore {
  const path = schedulesPath(agentDir);
  if (!existsSync(path)) return { version: SCHEDULE_STORE_VERSION, tasks: [] };
  try {
    return parseStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // Fail closed: an unreadable store means no tasks run.
    return { version: SCHEDULE_STORE_VERSION, tasks: [] };
  }
}

/** Locked read-modify-write. Creates the file (0600) and agentDir as needed. */
async function mutateStore<T>(
  agentDir: string,
  mutate: (store: ScheduleStore) => T | Promise<T>,
): Promise<T> {
  const path = schedulesPath(agentDir);
  if (!existsSync(path)) {
    writePrivateFileAtomicSync(
      path,
      JSON.stringify({ version: SCHEDULE_STORE_VERSION, tasks: [] }, null, 2),
    );
  }
  const release = await lockfile.lock(path, {
    retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 5_000, randomize: true },
    stale: 30_000,
  });
  try {
    const store = readScheduleStore(agentDir);
    const result = await mutate(store);
    writePrivateFileAtomicSync(path, JSON.stringify(store, null, 2));
    return result;
  } finally {
    try { await release(); } catch { /* already released */ }
  }
}

export function listScheduledTasks(agentDir: string): ScheduledTask[] {
  return readScheduleStore(agentDir).tasks;
}

export function getScheduledTask(agentDir: string, id: string): ScheduledTask | undefined {
  return readScheduleStore(agentDir).tasks.find((task) => task.id === id);
}

/** Tasks that are due at or before `now`, oldest first. */
export function listDueTasks(agentDir: string, now: Date = new Date()): ScheduledTask[] {
  return listScheduledTasks(agentDir)
    .filter((task) => task.enabled && task.nextRunAt !== null && Date.parse(task.nextRunAt) <= now.getTime())
    .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!));
}

export async function createScheduledTask(
  agentDir: string,
  input: CreateScheduledTaskInput,
): Promise<ScheduledTask> {
  const title = requireString(input.title, "title", MAX_TITLE_LENGTH);
  const prompt = requireString(input.prompt, "prompt", MAX_PROMPT_LENGTH);
  const schedule = parseScheduleSpec(
    input.timezone !== undefined && input.schedule && typeof input.schedule === "object"
      ? { ...(input.schedule as object), timezone: input.timezone }
      : input.schedule,
  );
  const cwd = normalizeCwd(input.cwd);
  const now = input.now ?? new Date();

  const nextRunAt = computeNextRun(schedule, now);
  if (nextRunAt === null) {
    throw new ScheduleValidationError("This schedule has no future occurrence; pick a future time");
  }

  const timestamp = now.toISOString();
  const task: ScheduledTask = {
    id: `st_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    title,
    prompt,
    schedule,
    ...(cwd ? { cwd } : {}),
    enabled: true,
    nextRunAt,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: input.createdBy,
  };

  return mutateStore(agentDir, (store) => {
    if (store.tasks.length >= MAX_TASKS_PER_USER) {
      throw new ScheduleValidationError(
        `Too many scheduled tasks (limit ${MAX_TASKS_PER_USER}); remove one first`,
      );
    }
    store.tasks.push(task);
    return task;
  });
}

export interface UpdateScheduledTaskInput {
  title?: unknown;
  prompt?: unknown;
  schedule?: unknown;
  cwd?: unknown;
  enabled?: unknown;
  now?: Date;
}

export async function updateScheduledTask(
  agentDir: string,
  id: string,
  patch: UpdateScheduledTaskInput,
): Promise<ScheduledTask> {
  const now = patch.now ?? new Date();
  return mutateStore(agentDir, (store) => {
    const task = store.tasks.find((entry) => entry.id === id);
    if (!task) throw new ScheduleValidationError(`Scheduled task not found: ${id}`);

    if (patch.title !== undefined) task.title = requireString(patch.title, "title", MAX_TITLE_LENGTH);
    if (patch.prompt !== undefined) task.prompt = requireString(patch.prompt, "prompt", MAX_PROMPT_LENGTH);
    if (patch.cwd !== undefined) {
      const cwd = normalizeCwd(patch.cwd);
      if (cwd) task.cwd = cwd;
      else delete task.cwd;
    }
    if (patch.enabled !== undefined) task.enabled = patch.enabled !== false;
    if (patch.schedule !== undefined) {
      task.schedule = parseScheduleSpec(patch.schedule);
      task.nextRunAt = computeNextRun(task.schedule, now);
      if (task.enabled && task.nextRunAt === null) {
        throw new ScheduleValidationError("This schedule has no future occurrence; pick a future time");
      }
    }
    // Re-enabling needs a fresh nextRunAt: a task that sat disabled for a while
    // still holds the instant it originally pointed at, which is now in the
    // past and would fire immediately on the next tick.
    if (task.enabled) {
      const stale = task.nextRunAt === null || Date.parse(task.nextRunAt) <= now.getTime();
      if (stale) task.nextRunAt = computeNextRun(task.schedule, now);
      if (task.nextRunAt === null && task.schedule.kind !== "once") {
        throw new ScheduleValidationError("This schedule has no future occurrence; pick a future time");
      }
    }
    task.updatedAt = now.toISOString();
    return { ...task };
  });
}

export async function removeScheduledTask(agentDir: string, id: string): Promise<boolean> {
  return mutateStore(agentDir, (store) => {
    const index = store.tasks.findIndex((task) => task.id === id);
    if (index === -1) return false;
    store.tasks.splice(index, 1);
    return true;
  });
}

/**
 * Record the outcome of a run and advance the schedule.
 *
 * `nextRunAt` is recomputed from `now` rather than from the slot that fired, so
 * a slow or catch-up run can never immediately re-fire on the next tick.
 */
export async function recordTaskRun(
  agentDir: string,
  id: string,
  result: { status: RunStatus; sessionId?: string; error?: string },
  now: Date = new Date(),
): Promise<ScheduledTask | undefined> {
  return mutateStore(agentDir, (store) => {
    const task = store.tasks.find((entry) => entry.id === id);
    if (!task) return undefined;
    const record: TaskRunRecord = {
      at: now.toISOString(),
      status: result.status,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.error ? { error: result.error.slice(0, 500) } : {}),
    };
    task.lastRun = record;
    // Newest first, bounded: the history is for "what did my task do", and an
    // unbounded list would grow the store forever on a per-minute task.
    task.runs = [record, ...(task.runs ?? [])].slice(0, MAX_RUN_HISTORY);
    task.nextRunAt = computeNextRun(task.schedule, now);
    task.updatedAt = now.toISOString();
    return { ...task };
  });
}

/** Advance nextRunAt without recording a run (used for catch-up skips). */
export async function advanceTaskSchedule(
  agentDir: string,
  id: string,
  now: Date = new Date(),
): Promise<string | null> {
  return mutateStore(agentDir, (store) => {
    const task = store.tasks.find((entry) => entry.id === id);
    if (!task) return null;
    task.nextRunAt = computeNextRun(task.schedule, now);
    task.updatedAt = now.toISOString();
    return task.nextRunAt;
  });
}

function normalizeCwd(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const cwd = requireString(value, "cwd", 4096);
  if (!isAbsolute(cwd)) {
    throw new ScheduleValidationError("cwd must be an absolute path");
  }
  return cwd;
}
