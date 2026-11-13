// Admin session catalogue (view-only): user → cwd → session grouping.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });

function sessionLine(id, session, overrides = {}) {
  return { type: "session", version: 3, id, timestamp: "2026-10-12T08:00:00.000Z", cwd: session.cwd, ...overrides };
}

/**
 * Write one session jsonl under <agentDir>/sessions/<project>/ .
 *
 * A subagent child is identified by the `pi-web:subagent` custom entry (not by
 * a `parentSession` header), matching how the real scanner classifies it.
 */
function writeSession(agentDir, id, { cwd, name, first = "hello", modified, subagentOf } = {}) {
  const dir = join(agentDir, "sessions", "proj");
  mkdirSync(dir, { recursive: true });
  const timestamp = modified ?? "2026-10-12T08:00:00.000Z";
  const lines = [
    // The scanner classifies a subagent from the header's parentSession plus the
    // pi-web:subagent custom entry; both are required.
    sessionLine(id, { cwd }, {
      timestamp,
      ...(subagentOf
        ? { parentSession: join(dir, `${(subagentOf.modified ?? timestamp).replace(/[:.]/g, "-")}_${subagentOf.id}.jsonl`) }
        : {}),
    }),
    ...(subagentOf
      ? [{
          type: "custom",
          id: "meta",
          parentId: null,
          timestamp,
          customType: "pi-web:subagent",
          data: {
            version: 1,
            parentSessionId: subagentOf.id,
            parentSessionPath: join(dir, `${(subagentOf.modified ?? timestamp).replace(/[:.]/g, "-")}_${subagentOf.id}.jsonl`),
            profile: "default",
            description: "child",
            status: "done",
          },
        }]
      : []),
    ...(name ? [{ type: "session_info", id: "name", parentId: subagentOf ? "meta" : null, timestamp, name }] : []),
    { type: "message", id: "u1", parentId: name ? "name" : (subagentOf ? "meta" : null), timestamp, message: { role: "user", content: first } },
  ];
  writeFileSync(join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function setup(accounts) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-admin-sessions-"));
  const prev = {
    data: process.env.PI_WEB_DATA_DIR,
    agent: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.PI_WEB_DATA_DIR = dataDir;
  process.env.PI_CODING_AGENT_DIR = join(dataDir, "global-agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  globalThis.__piUserStoreCache = undefined;
  globalThis.__piAuthCache?.clear();

  const store = await jiti.import("./user-store.ts");
  const users = {};
  for (const account of accounts) {
    users[account.username] = await store.createUser(account);
  }
  return {
    dataDir,
    store,
    users,
    agentDir: (username) => store.resolveUserAgentDir(username),
    cleanup() {
      globalThis.__piUserStoreCache = undefined;
      globalThis.__piAuthCache?.clear();
      for (const [key, value] of Object.entries({
        PI_WEB_DATA_DIR: prev.data,
        PI_CODING_AGENT_DIR: prev.agent,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("groups sessions by user then cwd, newest activity first", async () => {
  const ctx = await setup([
    { username: "alice", password: "alicepass123", role: "user", tenantId: "t_a" },
    { username: "bob", password: "bobpass123", role: "user", tenantId: "t_b" },
  ]);
  try {
    writeSession(ctx.agentDir("alice"), "s-alice-old", { cwd: "/work/a", name: "旧", modified: "2026-10-10T08:00:00.000Z" });
    writeSession(ctx.agentDir("alice"), "s-alice-new", { cwd: "/work/a", name: "新", modified: "2026-10-14T08:00:00.000Z" });
    writeSession(ctx.agentDir("alice"), "s-alice-other", { cwd: "/work/b", name: "别的目录", modified: "2026-10-12T08:00:00.000Z" });
    writeSession(ctx.agentDir("bob"), "s-bob", { cwd: "/work/bob", name: "Bob 的", modified: "2026-10-13T08:00:00.000Z" });

    const { collectAdminSessions } = await jiti.import("./admin-sessions.ts");
    const catalogue = await collectAdminSessions({ force: true });

    assert.equal(catalogue.scannedUsers, 2);
    const alice = catalogue.owners.find((o) => o.username === "alice");
    const bob = catalogue.owners.find((o) => o.username === "bob");
    assert.ok(alice && bob);

    // alice: two cwds; the busier/newer one first.
    assert.deepEqual(alice.groups.map((g) => g.cwd), ["/work/a", "/work/b"]);
    // Within a cwd: newest first.
    assert.deepEqual(alice.groups[0].sessions.map((s) => s.name), ["新", "旧"]);
    assert.deepEqual(alice.totals, { cwds: 2, sessions: 3 });

    // Each owner sees only their own sessions.
    assert.deepEqual(bob.groups.map((g) => g.cwd), ["/work/bob"]);
    assert.deepEqual(bob.totals, { cwds: 1, sessions: 1 });
  } finally {
    ctx.cleanup();
  }
});

test("subagent sessions fold into their parent row instead of listing separately", async () => {
  const ctx = await setup([{ username: "alice", password: "alicepass123", role: "user" }]);
  try {
    const dir = ctx.agentDir("alice");
    writeSession(dir, "s-root", { cwd: "/work/a", name: "主会话" });
    // A subagent child carries the pi-web:subagent custom entry.
    writeSession(dir, "s-child", { cwd: "/work/a", name: "子代理", subagentOf: { id: "s-root" } });

    const { collectAdminSessions } = await jiti.import("./admin-sessions.ts");
    const catalogue = await collectAdminSessions({ force: true });
    const alice = catalogue.owners.find((o) => o.username === "alice");
    assert.ok(alice);
    const rows = alice.groups[0].sessions;
    assert.equal(rows.length, 1, "subagent must not be its own row");
    assert.equal(rows[0].id, "s-root");
    assert.equal(rows[0].subagentCount, 1);
  } finally {
    ctx.cleanup();
  }
});

test("tenantId scopes the catalogue; users with no sessions still appear", async () => {
  const ctx = await setup([
    { username: "alice", password: "alicepass123", role: "user", tenantId: "t_a" },
    { username: "carol", password: "carolpass123", role: "user", tenantId: "t_b" },
    { username: "dave", password: "davepass123", role: "user", tenantId: "t_a" },
  ]);
  try {
    writeSession(ctx.agentDir("alice"), "s-a", { cwd: "/work/a", name: "A" });
    writeSession(ctx.agentDir("carol"), "s-c", { cwd: "/work/c", name: "C" });

    const { collectAdminSessions } = await jiti.import("./admin-sessions.ts");
    const scoped = await collectAdminSessions({ force: true, tenantId: "t_a" });
    assert.deepEqual(scoped.owners.map((o) => o.username).sort(), ["alice", "dave"]);
    assert.equal(scoped.tenantId, "t_a");
    // dave has nothing, but an admin still needs to see the account.
    assert.deepEqual(scoped.owners.find((o) => o.username === "dave").totals, { cwds: 0, sessions: 0 });

    const all = await collectAdminSessions({ force: true });
    assert.deepEqual(all.owners.map((o) => o.username).sort(), ["alice", "carol", "dave"]);
  } finally {
    ctx.cleanup();
  }
});

test("an unreadable user tree does not blank the whole catalogue", async () => {
  const ctx = await setup([
    { username: "alice", password: "alicepass123", role: "user" },
    { username: "bob", password: "bobpass123", role: "user" },
  ]);
  try {
    writeSession(ctx.agentDir("alice"), "s-a", { cwd: "/work/a", name: "A" });
    // bob's sessions dir is a FILE, so scanning it must fail rather than hang.
    const bobSessions = join(ctx.agentDir("bob"), "sessions");
    rmSync(bobSessions, { recursive: true, force: true });
    writeFileSync(bobSessions, "not a directory");

    const { collectAdminSessions } = await jiti.import("./admin-sessions.ts");
    const catalogue = await collectAdminSessions({ force: true });
    assert.equal(catalogue.owners.find((o) => o.username === "alice").totals.sessions, 1);
    assert.deepEqual(catalogue.owners.find((o) => o.username === "bob").totals, { cwds: 0, sessions: 0 });
  } finally {
    ctx.cleanup();
  }
});

test("admin excludes nothing: it reads every account's sessions (no self-filter)", async () => {
  const ctx = await setup([
    { username: "admin", password: "adminpass123", role: "admin" },
    { username: "alice", password: "alicepass123", role: "user" },
  ]);
  try {
    writeSession(ctx.agentDir("alice"), "s-a", { cwd: "/work/a", name: "A" });
    writeSession(ctx.agentDir("admin"), "s-admin", { cwd: "/work/admin", name: "Admin" });

    const { collectAdminSessions } = await jiti.import("./admin-sessions.ts");
    const catalogue = await collectAdminSessions({ force: true });
    const names = catalogue.owners.map((o) => o.username).sort();
    assert.deepEqual(names, ["admin", "alice"]);
    assert.equal(catalogue.owners.find((o) => o.username === "admin").totals.sessions, 1);
    assert.equal(catalogue.owners.find((o) => o.username === "alice").totals.sessions, 1);
  } finally {
    ctx.cleanup();
  }
});
