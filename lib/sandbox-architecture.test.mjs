// Architecture guard: every path that executes user-controlled code is sandboxed.
//
// The individual behaviours are tested where they live (lib/user-sandbox.test.mjs
// runs real bwrap; app/api/terminal/route.test.mjs checks ownership). This file
// guards the property that is easy to lose silently during a refactor: a new
// call site that spawns a process and forgets the wrapper. It reads the source
// rather than the behaviour because the failure mode is an *absence*.
//
// If this fails, do not relax it: put the call through
// `sandboxCommandForUser()` / `wrapWithSandbox()` first (sandbox-design.md S5).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

/** Every file allowed to create a child process, and how it is justified. */
const PROCESS_SPAWNERS = [
  // The sandbox itself: it is what builds every bwrap argv.
  { file: "./user-sandbox.ts", requiresSandbox: false },
  // The worker: wrapped in spawnWorker() before spawn().
  { file: "./agent-worker-manager.ts", requiresSandbox: true, marker: /wrapWithSandbox\(/ },
  // The PTY: wrapped in createTerminal() before the node-pty spawn.
  { file: "./terminal-manager.ts", requiresSandbox: true, marker: /wrapWithSandbox\(/ },
  // npx: wrapped in runNpx(), and refused outright without an account.
  { file: "./npx.ts", requiresSandbox: true, marker: /sandboxCommandForUser\(/ },
  // MCP stdio: the transport is wrapped when the caller names an account.
  { file: "./mcp-transport.ts", requiresSandbox: true, marker: /sandboxCommandForUser\(/ },
];

test("every module that spawns a process goes through the sandbox", () => {
  for (const entry of PROCESS_SPAWNERS) {
    const source = read(entry.file);
    const spawns = /child_process|node-pty/.test(source);
    if (!spawns) continue;
    if (!entry.requiresSandbox) continue;
    assert.match(
      source,
      entry.marker,
      `${entry.file} spawns a process but never wraps it: see sandbox-design.md S5`,
    );
  }
});

test("npx refuses to run without an account instead of running unisolated", () => {
  const source = read("./npx.ts");
  assert.match(source, /if \(!opts\.user\)/);
  assert.match(source, /no account was given/);
  // No fallback branch that runs the CLI bare when the user is missing.
  assert.doesNotMatch(source, /user\?:.+\n.+nodeCliInvocation/, "there must be no un-sandboxed path");
});

test("the sandbox is fail-closed at every call site", () => {
  for (const file of ["./agent-worker-manager.ts", "./terminal-manager.ts", "./user-sandbox-roots.ts"]) {
    assert.match(read(file), /failClosed: true/, `${file} must not degrade to an unisolated run`);
  }
});

test("a user's terminal is owned by the account that opened it", () => {
  const manager = read("./terminal-manager.ts");
  assert.match(manager, /userId: user\?\.userId/, "the record must keep its owner");
  assert.match(manager, /export function getTerminalUserId/);

  const route = read("../app/api/terminal/[id]/route.ts");
  assert.match(route, /requireAuth/);
  assert.match(route, /getTerminalUserId\(id\) !== userId|denyForeignTerminal/, "every handler checks the owner");

  const events = read("../app/api/terminal/[id]/events/route.ts");
  assert.match(events, /requireAuth/, "the SSE stream carries raw shell output");
  assert.match(events, /getTerminalUserId\(id\) !== auth\.user\.userId/);
});

test("session routes scope access to the caller's agentDir", () => {
  for (const file of [
    "../app/api/sessions/[id]/route.ts",
    "../app/api/sessions/[id]/state/route.ts",
    "../app/api/sessions/[id]/context/route.ts",
  ]) {
    const source = read(file);
    assert.match(source, /requireAuth/, `${file} must authenticate`);
  }
  // The list and detail routes must pass the user's agentDir into resolution,
  // never resolve by id alone (which would find any user's file).
  assert.match(read("../app/api/sessions/[id]/route.ts"), /resolveSessionPath\(id, user\?\.agentDir\)/);
  assert.match(read("../app/api/sessions/[id]/state/route.ts"), /resolveSessionPath\(id, user\?\.agentDir\)/);
});

test("no route registers a file root for every user", () => {
  // allowFileRoot() is the process-wide legacy path. It must not be reachable
  // from a request handler: that was the cross-user whitelist pollution (SB-6).
  const handlers = [
    "../app/api/cwd/validate/route.ts",
    "../app/api/agent/new/route.ts",
    "../app/api/worktrees/route.ts",
    "../app/api/files/[...path]/route.ts",
  ];
  for (const file of handlers) {
    // Strip comments first: prose mentioning the old call is fine, calling it is not.
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(
      source,
      /(?<![\w.])allowFileRoot\(\s*[^)]/,
      `${file} must use allowFileRootForUser(), not the process-wide allowFileRoot()`,
    );
  }
});
