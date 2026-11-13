/**
 * Pi Web 多用户版 per-user agent worker host.
 *
 * One process per user. Runs the full pi-web AgentSession stack in-process
 * (same lib/rpc-manager.ts code path as single-user mode), with
 * PI_CODING_AGENT_DIR pointing at the user's isolated agentDir. The pi-web
 * main process talks to this worker over a JSONL request/response protocol on
 * stdio:
 *
 *   → {"id":"1","op":"start","sessionId":"...","sessionFile":"...","cwd":"...","options":{...}}
 *   → {"id":"2","op":"send","sessionId":"...","command":{...}}
 *   ← {"id":"2","ok":true,"result":...}                     (response)
 *   ← {"type":"session_event","sessionId":"...","event":{…}} (session events)
 *   ← {"type":"worker_log","message":...}                    (worker diagnostics)
 *
 * All heavy lifting (AgentSessionWrapper, extension factories, session
 * registry, tool selection persistence) is lib/rpc-manager.ts exactly as in
 * single-user mode; this file only adapts it to the stdio protocol.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// Resolve jiti from pi-web's node_modules (bundled as a devDependency).
let jitiModule: { default?: unknown } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jitiModule = require("jiti") as { default?: unknown };
} catch {
  console.error("[agent-worker] jiti is required but not resolvable");
  process.exit(1);
}

const webRoot = process.env.PI_SMARTFICC_WEB_DIR
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// jiti instance that compiles lib/*.ts on the fly with relative imports intact.
type JitiInstance = (target: string) => unknown;
function createJiti(): JitiInstance {
  const mod = jitiModule as { createJiti?: unknown; default?: unknown };
  // jiti v2 exports createJiti(filename, options); older builds export the
  // factory directly with a default export.
  const factory = (mod.createJiti ?? mod.default ?? mod) as (
    filename: string | URL,
    options: unknown,
  ) => JitiInstance;
  return factory(import.meta.url, {
    interopDefault: true,
    moduleCache: true,
    // Resolve "@/..." aliases the same way Next.js does.
    alias: { "@": webRoot },
    // The SDK and its runtime modules (pi-mcp) must load as their native ESM
    // copies, not jiti-transpiled CJS: `lib/pi-sdk-internals.ts` verifies that
    // its transport classes are the SDK's own with `instanceof`, and a
    // transpiled second instance turns worker MCP support off with "resolved
    // to another copy". jiti only loads these packages natively when listed
    // in `nativeModules` (its default list is just typescript/jiti).
    nativeModules: [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-mcp",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-codemode",
      "@earendil-works/pi-telemetry",
      "@earendil-works/chord",
    ],
  });
}

type RpcManagerModule = typeof import("./rpc-manager");

let cached: RpcManagerModule | undefined;

function rpcManager(): RpcManagerModule {
  if (!cached) {
    const jiti = createJiti();
    const loaded = jiti(path.join(webRoot, "lib", "rpc-manager.ts")) as RpcManagerModule;
    cached = loaded;
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Stdio JSONL protocol (strict LF framing; matches pi rpc.md framing rules)
// ---------------------------------------------------------------------------

interface WorkerRequest {
  id: string;
  op:
    | "ping"
    | "start"
    | "send"
    | "getInfos"
    | "runningIds"
    | "hasBusyForCwd"
    | "destroyForCwd"
    | "setTools"
    | "shutdownSession"
    | "getSubagentRun"
    | "steerSubagent"
    | "abortSubagent"
    | "shutdown";
  sessionId?: string;
  sessionFile?: string;
  cwd?: string;
  options?: Record<string, unknown>;
  command?: Record<string, unknown>;
  message?: string;
}

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function workerLog(message: string): void {
  emit({ type: "worker_log", message });
}

async function handleRequest(req: WorkerRequest): Promise<Record<string, unknown>> {
  const m = rpcManager();
  switch (req.op) {
    case "ping":
      return { ok: true, result: { pong: true, agentDir: process.env.PI_CODING_AGENT_DIR ?? "" } };

    case "start": {
      if (!req.sessionId) throw new Error("start: sessionId required");
      const { session, realSessionId } = await m.startRpcSession(
        req.sessionId,
        req.sessionFile ?? "",
        req.cwd,
        (req.options ?? {}) as Parameters<typeof m.startRpcSession>[3],
      );
      tapSessionEvents(session);
      return {
        ok: true,
        result: {
          realSessionId,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile,
          cwd: session.cwd,
        },
      };
    }

    case "send": {
      if (!req.sessionId) throw new Error("send: sessionId required");
      const session = m.getRpcSession(req.sessionId);
      if (!session || !session.isAlive()) throw new Error(`Session not alive: ${req.sessionId}`);
      tapSessionEvents(session);
      const result = await session.send(req.command ?? {});
      return { ok: true, result };
    }

    case "getInfos": {
      tapAllSessionEvents();
      return { ok: true, result: m.getRpcSessionInfos() };
    }

    case "runningIds":
      return {
        ok: true,
        result: {
          runningSessionIds: m.getRunningRpcSessionIds(),
          completionNotificationSuppressedSessionIds: m.getCompletionNotificationSuppressedRpcSessionIds(),
        },
      };

    case "hasBusyForCwd":
      return { ok: true, result: m.hasBusyRpcSessionForCwd(req.cwd ?? "") };

    case "destroyForCwd": {
      const count = await m.destroyRpcSessionsForCwd(req.cwd ?? "");
      return { ok: true, result: count };
    }

    case "setTools": {
      const result = await m.setRpcSessionTools(
        req.sessionId!,
        req.sessionFile,
        (req.options as { toolNames?: unknown } | undefined)?.toolNames,
      );
      return { ok: true, result };
    }

    case "shutdownSession": {
      const session = req.sessionId ? m.getRpcSession(req.sessionId) : undefined;
      if (session) await session.shutdown();
      return { ok: true, result: null };
    }

    case "getSubagentRun":
      return { ok: true, result: m.getSubagentRun(req.sessionId!) };

    case "steerSubagent":
      await m.steerSubagent(req.sessionId!, req.message ?? "");
      return { ok: true, result: null };

    case "abortSubagent":
      await m.abortSubagent(req.sessionId!);
      return { ok: true, result: null };

    default:
      throw new Error(`Unknown op: ${String((req as { op?: string }).op)}`);
  }
}

let shuttingDown = false;

async function shutdownAll(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const registry = (globalThis as {
      __piSessions?: Map<string, { shutdown(): Promise<void> }>;
    }).__piSessions;
    const sessions = Array.from(registry?.values() ?? []);
    await Promise.allSettled(sessions.map((session) => session.shutdown()));
  } catch {
    // ignore — best-effort cleanup
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Event tap: forward every wrapper event to the main process.
// ---------------------------------------------------------------------------

const tapped = new Set<string>();

function tapSessionEvents(session: { sessionId: string; isAlive(): boolean; onEvent(l: (e: Record<string, unknown>) => void): () => void }): void {
  if (!session.isAlive() || tapped.has(session.sessionId)) return;
  tapped.add(session.sessionId);
  session.onEvent((event) => {
    emit({ type: "session_event", sessionId: session.sessionId, event });
  });
}

function tapAllSessionEvents(): void {
  const registry = (globalThis as {
    __piSessions?: Map<string, {
      sessionId: string;
      isAlive(): boolean;
      onEvent(l: (e: Record<string, unknown>) => void): () => void;
    }>;
  }).__piSessions;
  if (!registry) return;
  for (const session of registry.values()) {
    tapSessionEvents(session);
  }
}

// ---------------------------------------------------------------------------
// Input loop (strict LF framing; no readline — U+2028/9 are valid inside JSON)
// ---------------------------------------------------------------------------

let buffer = "";

function handleLine(line: string): void {
  let req: WorkerRequest;
  try {
    req = JSON.parse(line) as WorkerRequest;
  } catch {
    emit({ type: "worker_log", message: `unparseable line: ${line.slice(0, 80)}` });
    return;
  }
  if (req.op === "shutdown") {
    void shutdownAll();
    return;
  }
  handleRequest(req)
    .then((response) => emit({ id: req.id, ...response }))
    .catch((error) => {
      emit({
        id: req.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (line.trim()) handleLine(line);
  }
});
process.stdin.on("end", () => {
  void shutdownAll();
});
process.on("SIGTERM", () => { void shutdownAll(); });
process.on("SIGINT", () => { void shutdownAll(); });

// Route worker-side console output into the protocol as diagnostics so the
// main process log stays attributable per user.
const formatArgs = (args: unknown[]) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
console.log = (...args: unknown[]) => workerLog(formatArgs(args));
console.error = (...args: unknown[]) => workerLog(`ERROR ${formatArgs(args)}`);
console.warn = (...args: unknown[]) => workerLog(`WARN ${formatArgs(args)}`);

workerLog(`worker ready agentDir=${process.env.PI_CODING_AGENT_DIR ?? ""}`);
