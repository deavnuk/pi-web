/**
 * Per-user agent worker process manager (main-process side).
 *
 * One long-lived child process per user, spawned lazily on first agent
 * operation and reused for all of that user's sessions. The child runs
 * lib/agent-worker-host.ts with PI_CODING_AGENT_DIR pointed at the user's
 * isolated agentDir — environment-level isolation for auth.json, models.json,
 * skills, MCP config (pi's built-in MCP extension loads <agentDir>/mcp.json
 * via an explicit agentDir parameter).
 *
 * The manager exposes the same call surface lib/rpc-manager.ts exposes to
 * routes, so callers do not care whether a session lives in-process
 * (single-user mode) or in the user's worker (multi-user mode).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readUserSecretsEnv } from "./user-secrets";
import { wrapWithSandbox } from "./user-sandbox";
import { writableRootsForUser } from "./user-sandbox-roots";
import type { UserContext } from "./user-auth";
import type { RpcSessionStartOptions } from "./rpc-manager";

const WORKER_START_TIMEOUT_MS = 120_000;
const WORKER_REQUEST_TIMEOUT_MS = 600_000; // prompts can run long
const WORKER_IDLE_EXIT_MS = 30 * 60_000; // exit when no sessions for 30 min

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface WorkerHandle {
  proc: ChildProcess;
  events: EventEmitter; // emits "event:<sessionId>" with the raw event payload
  pending: Map<string, PendingRequest>;
  buffer: string;
  ready: Promise<void>;
  readyResolve?: () => void;
  readyReject?: (error: unknown) => void;
  alive: boolean;
  requestSeq: number;
  lastActivityAt: number;
  userId: string;
}

declare global {
  var __piAgentWorkers: Map<string, WorkerHandle> | undefined;
}

function workers(): Map<string, WorkerHandle> {
  if (!globalThis.__piAgentWorkers) globalThis.__piAgentWorkers = new Map();
  return globalThis.__piAgentWorkers;
}

function workerHostEntryPath(): string {
  // worker host is lib/agent-worker-host.ts, executed via jiti bootstrap
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "agent-worker-bootstrap.mjs");
}

function webRoot(): string {
  return path.dirname(fileURLToPath(import.meta.url)) + "/..";
}

/**
 * Worker process environment: inherits the host process env (minus host-only
 * vars) + per-user identity markers + the user's secret values (FR-5.3) so
 * MCP servers spawned by the built-in MCP extension resolve ${VAR} to this
 * user's credentials. In-memory only, never logged.
 */
export function buildWorkerEnvironment(user: UserContext, agentDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SMARTFICC_WEB_DIR: path.resolve(webRoot()),
    PI_SMARTFICC_USER_ID: user.userId,
    // Marks this process as an agent worker: nested startRpcSession calls
    // must run locally instead of spawning another worker (recursion guard).
    PI_SMARTFICC_WORKER: "1",
    PI_USER_NAME: user.username,
    // Keep startup telemetry quiet in workers; the main process handles it.
    PI_SKIP_VERSION_CHECK: "1",
    // Per-user secrets so MCP servers spawned by the built-in MCP extension
    // inside this worker resolve ${VAR} to THIS user's values — each user
    // effectively talks to shared MCP definitions with private credentials.
    // Changes take effect on next worker respawn (secrets route respawns when
    // idle).
    ...readUserSecretsEnv(agentDir),
  };
}

function spawnWorker(user: UserContext): WorkerHandle {
  const agentDir = user.agentDir;
  // Kernel-level isolation (sandbox-design.md): the worker sees only this
  // user's agentDir, their project roots and the admin-declared shared roots.
  // Everything else — other users' sessions and secrets, the host home — is
  // absent from its filesystem, so the agent's own bash/read/grep cannot reach
  // it no matter what the model asks for. failClosed: a worker that cannot be
  // sandboxed must not start at all.
  const sandboxed = wrapWithSandbox(
    process.execPath,
    [workerHostEntryPath()],
    {
      writableRoots: writableRootsForUser(user),
      // The worker loads lib/*.ts through jiti, so the pi-web checkout must be
      // readable. Passed explicitly: PI_SMARTFICC_WEB_DIR is only set for the
      // child, which does not exist yet at spawn time.
      readonlyRoots: [path.resolve(webRoot())],
    },
    { failClosed: true },
  );
  const proc: ChildProcess = spawn(sandboxed.command, sandboxed.args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: buildWorkerEnvironment(user, agentDir),
  });

  const handle: WorkerHandle = {
    proc,
    events: new EventEmitter(),
    pending: new Map(),
    buffer: "",
    ready: undefined as unknown as Promise<void>,
    alive: true,
    requestSeq: 0,
    lastActivityAt: Date.now(),
    userId: user.userId,
  };

  handle.ready = new Promise<void>((resolve, reject) => {
    handle.readyResolve = resolve;
    handle.readyReject = reject;
    setTimeout(
      () => reject(new Error(`agent worker start timeout (pid ${proc.pid})`)),
      WORKER_START_TIMEOUT_MS,
    ).unref?.();
  });

  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => onWorkerStdout(handle, chunk));

  // Readiness handshake: the host replies to ping once its protocol loop is up.
  (async () => {
    const id = "__ready__";
    const timer = setTimeout(() => {
      handle.readyReject?.(new Error(`agent worker handshake timeout (pid ${proc.pid})`));
    }, WORKER_START_TIMEOUT_MS);
    handle.pending.set(id, {
      resolve: () => { clearTimeout(timer); handle.readyResolve?.(); },
      reject: (error) => { clearTimeout(timer); handle.readyReject?.(error); },
      timer: null,
    });
    try {
      handle.proc.stdin!.write(`${JSON.stringify({ id, op: "ping" })}\n`);
    } catch (error) {
      handle.readyReject?.(error);
    }
  })();
  proc.on("error", (err) => {
    handle.alive = false;
    handle.readyReject?.(err);
    for (const pending of handle.pending.values()) {
      pending.timer && clearTimeout(pending.timer);
      pending.reject(new Error(`agent worker crashed: ${err.message}`));
    }
    handle.pending.clear();
    purgeWorkerProxies(user.userId);
    workers().delete(user.userId);
  });
  proc.on("exit", (code, signal) => {
    handle.alive = false;
    const err = new Error(`agent worker exited (code=${code}, signal=${signal})`);
    handle.readyReject?.(err);
    for (const pending of handle.pending.values()) {
      pending.timer && clearTimeout(pending.timer);
      pending.reject(err);
    }
    handle.pending.clear();
    handle.events.emit("exit");
    purgeWorkerProxies(user.userId);
    workers().delete(user.userId);
  });

  workers().set(user.userId, handle);
  return handle;
}

/**
 * Drop every main-process proxy owned by a dead worker.
 *
 * Without this, a respawned worker would make its predecessor's stale proxies
 * look alive again (isAlive() only checks that *a* worker exists for the
 * user), and routes would route commands at sessions that no longer exist.
 */
function purgeWorkerProxies(userId: string): void {
  const registry = (globalThis as {
    __piSessions?: Map<string, WorkerSessionProxy | unknown>;
  }).__piSessions;
  if (!registry) return;
  for (const [key, value] of registry) {
    if (isWorkerSessionProxy(value) && value.userId === userId) registry.delete(key);
  }
}

/**
 * Rate-limited worker log forwarding (NFR-5): repeated identical lines are
 * collapsed to first + count so chatty SDK diagnostics cannot flood the
 * server log under load.
 */
const workerLogDedupe = new Map<string, { count: number; lastAt: number }>();
function logWorkerLine(handle: WorkerHandle, message: string): void {
  const key = `${handle.userId}\u0000${message}`;
  const now = Date.now();
  const state = workerLogDedupe.get(key);
  if (state && now - state.lastAt < 60_000) {
    state.count += 1;
    return;
  }
  if (state && state.count > 1) {
    console.log(`[agent-worker:${handle.userId}] (repeated ${state.count}x) ${message}`);
  } else if (state) {
    console.log(`[agent-worker:${handle.userId}] ${message}`);
  } else {
    console.log(`[agent-worker:${handle.userId}] ${message}`);
  }
  workerLogDedupe.set(key, { count: 0, lastAt: now });
  // Bound the dedupe map
  if (workerLogDedupe.size > 512) {
    for (const [k, v] of workerLogDedupe) {
      if (now - v.lastAt > 120_000) workerLogDedupe.delete(k);
      if (workerLogDedupe.size <= 256) break;
    }
  }
}

function onWorkerStdout(handle: WorkerHandle, chunk: string): void {
  handle.buffer += chunk;
  let index: number;
  while ((index = handle.buffer.indexOf("\n")) >= 0) {
    const line = handle.buffer.slice(0, index).replace(/\r$/, "");
    handle.buffer = handle.buffer.slice(index + 1);
    if (!line.trim()) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // ignore non-JSON noise (should not happen; stderr is inherited)
    }
    handle.lastActivityAt = Date.now();

    if (typeof msg.id === "string" && (msg.ok !== undefined || msg.error !== undefined)) {
      const pending = handle.pending.get(msg.id as string);
      if (pending) {
        handle.pending.delete(msg.id as string);
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.ok === true) pending.resolve(msg);
        else pending.reject(new Error(String(msg.error ?? "worker request failed")));
      }
      continue;
    }
    if (msg.type === "session_event" && typeof msg.sessionId === "string") {
      handle.events.emit(`event:${msg.sessionId}`, msg.event);
      continue;
    }
    if (msg.type === "worker_log" && typeof msg.message === "string") {
      logWorkerLine(handle, msg.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isWorkerModeEnabled(): boolean {
  // Per-user workers are always used. Inside one, the mode is "already active":
  // nested startRpcSession calls run locally instead of spawning another worker.
  return process.env.PI_SMARTFICC_WORKER !== "1";
}

export interface WorkerRpcSessionInfo {
  realSessionId: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
}

/**
 * Structurally detect a worker-session proxy across webpack bundles.
 *
 * `value instanceof WorkerSessionProxy` only recognizes the copy bundled into
  * the same compilation. The scheduler runs from the instrumentation build and
 * registers its proxies in the same global registry the route handlers read,
 * so a session started by a scheduled task must be classified by shape, not
 * by class. The `__piWorkerSessionProxy` tag is the contract; `userId` guards
 * against coincidental matches on foreign registry entries.
 */
export function isWorkerSessionProxy(
  value: unknown,
): value is WorkerSessionProxy {
  return (
    typeof value === "object"
    && value !== null
    && (value as { __piWorkerSessionProxy?: unknown }).__piWorkerSessionProxy === true
    && typeof (value as { userId?: unknown }).userId === "string"
  );
}

/**
 * Proxy object with the surface routes use on AgentSessionWrapper.
 *
 * Unlike a local wrapper, the authoritative run state lives inside the worker
 * process, so this proxy mirrors it: lifecycle events forwarded over the
 * worker protocol flip the flags below, and every `get_state` round-trip
 * re-syncs them. Without this mirror the main process cannot answer
 * "is this session running?" for worker-hosted sessions, which silently
 * reported idle while the worker was mid-stream.
 */
export class WorkerSessionProxy {
  // Cross-bundle tag (see isWorkerSessionProxy below): this class gets bundled
  // into separate webpack compilations (the instrumentation/scheduler build and
  // the route server build), and the session registry on globalThis is shared
  // process-wide. instanceof against any single copy fails for sessions another
  // copy created, so identity checks must be structural, not instanceof.
  readonly __piWorkerSessionProxy = true;

  private observedRunning = false;
  private observedStreaming = false;
  private observing = false;

  constructor(
    private readonly user: UserContext,
    private readonly info: WorkerRpcSessionInfo,
  ) {}

  /** Adopt the run state observed by a previous proxy for the same session. */
  adoptObservedState(previous: WorkerSessionProxy): void {
    this.observedRunning = previous.observedRunning;
    this.observedStreaming = previous.observedStreaming;
  }

  /**
   * Subscribe to this session's worker-forwarded events so run state stays
   * accurate between state queries. Best effort: a not-yet-ready worker just
   * leaves the flags to the next `get_state` round-trip.
   */
  startObserving(): void {
    if (this.observing) return;
    this.observing = true;
    try {
      this.onEvent((event) => this.observeEvent(event));
    } catch {
      this.observing = false;
    }
  }

  /** Mirror worker lifecycle events onto the run-state flags. */
  observeEvent(event: { type: string; [key: string]: unknown }): void {
    switch (event.type) {
      case "agent_start":
        this.observedRunning = true;
        this.observedStreaming = true;
        break;
      case "agent_end":
        this.observedStreaming = false;
        break;
      case "agent_settled":
        this.observedRunning = false;
        this.observedStreaming = false;
        break;
      case "compaction_start":
      case "auto_compaction_start":
        this.observedRunning = true;
        break;
      case "bash_start":
        this.observedRunning = true;
        break;
      default:
        break;
    }
  }

  /** Re-sync the flags from an authoritative worker-side get_state payload. */
  private syncFromState(state: unknown): void {
    if (!state || typeof state !== "object") return;
    const s = state as {
      isStreaming?: unknown;
      isPromptRunning?: unknown;
      isBashRunning?: unknown;
      isCompacting?: unknown;
    };
    // A run that ended in a provider error looks idle; carry the reason over so
    // a caller polling isRunning() can tell it from a finished run.
    const streaming = s.isStreaming === true;
    const running = streaming
      || s.isPromptRunning === true
      || s.isBashRunning === true
      || s.isCompacting === true;
    this.observedStreaming = streaming;
    this.observedRunning = running;
  }

  get sessionId(): string { return this.info.sessionId; }
  get realSessionId(): string { return this.info.realSessionId; }
  get sessionFile(): string { return this.info.sessionFile; }
  get cwd(): string { return this.info.cwd; }
  get userId(): string { return this.user.userId; }

  /** Events streamed from the worker for this session. */
  onEvent(listener: (event: { type: string; [key: string]: unknown }) => void): () => void {
    const handle = getAliveWorkerOrThrow(this.user);
    handle.events.on(`event:${this.info.sessionId}`, listener);
    return () => {
      handle.events.off(`event:${this.info.sessionId}`, listener);
    };
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    if (command.type === "prompt" || command.type === "bash") {
      // Optimistic: the worker is busy from the moment the prompt/command is
      // dispatched, mirroring pendingPromptCount on the local wrapper. The
      // lifecycle events (or the next get_state) correct this afterwards.
      this.observedRunning = true;
    }
    const response = await request(this.user, {
      op: "send",
      sessionId: this.info.realSessionId,
      command,
    });
    if (command.type === "get_state") this.syncFromState(response.result);
    if (command.type === "abort") this.observedRunning = false;
    return response.result;
  }

  isAlive(): boolean {
    return workerFor(this.user.userId)?.alive === true;
  }

  /**
   * Mirrored because the worker owns the real state; the SSE `connected`
   * snapshot reads this to tell a reconnecting client whether a run is
   * already in flight.
   */
  get isStreaming(): boolean { return this.observedStreaming; }
  get streamingMessage(): unknown { return undefined; }

  /**
   * Mirrored run state. Defaults to idle until the worker reports otherwise,
   * so registry-wide scans cannot mistake every worker session for a live run.
   * Liveness is separate (see isAlive) and dead-worker proxies are purged from
   * the registry, so this must not re-check the worker.
   */
  isRunning(): boolean { return this.observedRunning; }

  /**
   * Why the last run produced no answer, as the worker reported it.
   *
   * The worker is authoritative; this mirrors the value from the last
   * `get_state`, which `send({ type: "prompt" })` performs as part of the run.
   */

  isChatOnly(): boolean { return false; }

  hasSuppressedCompletionNotifications(): boolean { return false; }

  /** Tool selection is persisted and applied inside the worker via setTools. */
  setActiveToolSelection(_toolNames: string[]): void {
    // No-op on the proxy; the worker's wrapper applies the selection in its
    // own setRpcSessionTools path. Kept for interface parity with the local
    // AgentSessionWrapper so callers can treat both uniformly.
  }

  async shutdown(): Promise<void> {
    try {
      await request(this.user, { op: "shutdownSession", sessionId: this.info.realSessionId }, 30_000);
    } catch {
      // worker may already be gone
    }
  }

  /** Interface parity with AgentSessionWrapper; no listeners held in the proxy. */
  destroy(): void {
    // No-op: registry cleanup only; worker-side cleanup goes through shutdown.
  }

  /** Interface parity with AgentSessionWrapper; proxy cleanup is registry-side only. */
  onDestroy(cb: () => void): void {
    // No-op: proxies leave the registry via explicit purge, not dispose callbacks.
    void cb;
  }

  /**
   * Parity stub: the proxy owns no in-memory JSONL index, so there is never a
   * disk-ahead condition to evict for (the route falls through to the file).
   * Routes must reach this via isWorkerSessionProxy() instead of instanceof:
   * scheduled-task sessions are registered by the instrumentation bundle's
   * class copy, which instanceof in the route bundle does not recognize.
   */
  evictIfDiskAhead(): boolean {
    return false;
  }

  /**
   * Interface parity with AgentSessionWrapper. The proxy has no local disposal
   * to await: shutdown() already round-trips to the worker with its own
   * timeout, so this resolves immediately as disposed.
   */
  async waitUntilDisposed(_timeoutMs: number): Promise<boolean> {
    return true;
  }
}

function getAliveWorkerOrThrow(user: UserContext): WorkerHandle {
  const handle = workers().get(user.userId);
  if (!handle || !handle.alive) throw new Error("agent worker not running");
  return handle;
}

function workerFor(userId: string): WorkerHandle | undefined {
  return workers().get(userId);
}

function request(
  user: UserContext,
  body: { op: WorkerRequestOp; [key: string]: unknown },
  timeoutMs = WORKER_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const handle = getAliveWorkerOrThrow(user);
  const id = `r${++handle.requestSeq}`;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      handle.pending.delete(id);
      reject(new Error(`agent worker request timeout: ${body.op}`));
    }, timeoutMs);
    handle.pending.set(id, { resolve, reject, timer });
    handle.proc.stdin!.write(`${JSON.stringify({ id, ...body })}\n`);
  });
}

type WorkerRequestOp =
  | "ping" | "start" | "send" | "getInfos" | "runningIds" | "hasBusyForCwd"
  | "destroyForCwd" | "setTools" | "shutdownSession" | "getSubagentRun"
  | "steerSubagent" | "abortSubagent" | "shutdown";

/** Ensure the user's worker is up and its session is started. */
export async function workerStartSession(
  user: UserContext,
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions = {},
): Promise<WorkerSessionProxy> {
  const handle = ensureWorker(user);
  await handle.ready;
  const response = await request(user, {
    op: "start",
    sessionId,
    sessionFile,
    cwd,
    // The worker-side startRpcSession needs the UserContext for the
    // whoami extension + secrets env injection (FR-5). UserContext is
    // plain serializable data.
    options: { ...options, user } as unknown as Record<string, unknown>,
  });
  const result = response.result as WorkerRpcSessionInfo;
  return new WorkerSessionProxy(user, result);
}

export async function workerRequest(
  user: UserContext,
  body: { op: WorkerRequestOp; [key: string]: unknown },
  timeoutMs?: number,
): Promise<unknown> {
  const handle = ensureWorker(user);
  await handle.ready;
  const response = await request(user, body, timeoutMs);
  return response.result;
}

function ensureWorker(user: UserContext): WorkerHandle {
  const existing = workers().get(user.userId);
  if (existing && existing.alive) return existing;
  return spawnWorker(user);
}

/** Kill a user's worker (user disabled / admin action). */
export async function destroyWorker(user: UserContext): Promise<void> {
  const handle = workers().get(user.userId);
  if (!handle) return;
  workers().delete(user.userId);
  handle.alive = false;
  await new Promise<void>((resolve) => {
    handle.proc.once("exit", () => resolve());
    try {
      handle.proc.stdin!.write(`${JSON.stringify({ id: "shutdown", op: "shutdown" })}\n`);
    } catch {
      handle.proc.kill("SIGTERM");
    }
    setTimeout(() => {
      try { handle.proc.kill("SIGKILL"); } catch { /* already dead */ }
      resolve();
    }, 5_000);
  });
}

/** Graceful shutdown of every live worker (server SIGTERM). Idempotent. */
let allWorkersShutdown: Promise<void> | null = null;
export function destroyAllWorkers(): Promise<void> {
  if (!allWorkersShutdown) {
    const handles = [...workers().values()];
    workers().clear();
    allWorkersShutdown = Promise.allSettled(
      handles.map((handle) => {
        handle.alive = false;
        return new Promise<void>((resolve) => {
          handle.proc.once("exit", () => resolve());
          try {
            handle.proc.stdin!.write(`${JSON.stringify({ id: "shutdown", op: "shutdown" })}\n`);
          } catch {
            handle.proc.kill("SIGTERM");
          }
          setTimeout(() => {
            try { handle.proc.kill("SIGKILL"); } catch { /* already dead */ }
            resolve();
          }, 5_000);
        });
      }),
    ).then(() => undefined);
  }
  return allWorkersShutdown;
}

/** Aggregate running-session ids across all workers (for /api/agent/running). */
export async function collectRunningIds(user: UserContext): Promise<{ running: string[]; suppressed: string[] }> {
  if (!workers().has(user.userId)) return { running: [], suppressed: [] };
  try {
    const result = await workerRequest(user, { op: "runningIds" }, 5_000) as {
      runningSessionIds: string[];
      completionNotificationSuppressedSessionIds: string[];
    };
    return { running: result.runningSessionIds ?? [], suppressed: result.completionNotificationSuppressedSessionIds ?? [] };
  } catch {
    return { running: [], suppressed: [] };
  }
}

/** Live session infos (persisted + transient) from the user's worker. */
export async function collectSessionInfos(user: UserContext): Promise<unknown[]> {
  if (!workers().has(user.userId)) return [];
  try {
    return await workerRequest(user, { op: "getInfos" }, 5_000) as unknown[];
  } catch {
    return [];
  }
}

export function workerIsRunningFor(user: UserContext): boolean {
  const handle = workers().get(user.userId);
  return Boolean(handle?.alive);
}

export function hasWorkerFor(userId: string): boolean {
  const handle = workers().get(userId);
  return Boolean(handle?.alive);
}

/** Wait until the worker's process exits (used in tests and shutdown). */
export function onWorkerExit(user: UserContext, listener: () => void): void {
  const handle = workers().get(user.userId);
  handle?.events.once("exit", listener);
}
