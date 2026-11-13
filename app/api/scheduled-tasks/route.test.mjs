// Route tests for /api/scheduled-tasks and /api/scheduled-tasks/[id] (FR-7).
import assert from "node:assert/strict";
import test from "node:test";
import { json, setupUsers } from "../__tests__/route-test-helpers.mjs";

const ACCOUNTS = [
  { username: "alice", password: "alicepass123", role: "user" },
  { username: "bob", password: "bobpass123", role: "user" },
];

const DAILY = { kind: "daily", time: "09:00", timezone: "Asia/Shanghai" };

test("/api/scheduled-tasks: requires authentication", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET } = await ctx.load("app/api/scheduled-tasks/route.ts");
    assert.equal((await GET(ctx.request("/api/scheduled-tasks"))).status, 401);
  } finally {
    ctx.cleanup();
  }
});

test("/api/scheduled-tasks: create returns 201 with a computed nextRunAt", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { POST } = await ctx.load("app/api/scheduled-tasks/route.ts");
    const res = await POST(ctx.request("/api/scheduled-tasks", {
      method: "POST", auth: ctx.basic("alice", "alicepass123"),
      body: { title: "日报", prompt: "跑一遍", schedule: DAILY },
    }));
    assert.equal(res.status, 201);
    const { task } = await json(res);
    assert.ok(task.id);
    assert.ok(task.nextRunAt, "nextRunAt computed");
    assert.equal(task.enabled, true);
  } finally {
    ctx.cleanup();
  }
});

test("/api/scheduled-tasks: invalid schedule is a 400", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { POST } = await ctx.load("app/api/scheduled-tasks/route.ts");
    const res = await POST(ctx.request("/api/scheduled-tasks", {
      method: "POST", auth: ctx.basic("alice", "alicepass123"),
      body: { title: "x", prompt: "y", schedule: { kind: "bogus" } },
    }));
    assert.equal(res.status, 400);
  } finally {
    ctx.cleanup();
  }
});

test("/api/scheduled-tasks: tasks are per-user isolated", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const list = await ctx.load("app/api/scheduled-tasks/route.ts");
    const detail = await ctx.load("app/api/scheduled-tasks/[id]/route.ts");
    const aliceAuth = ctx.basic("alice", "alicepass123");
    const bobAuth = ctx.basic("bob", "bobpass123");

    const created = await json(await list.POST(ctx.request("/api/scheduled-tasks", {
      method: "POST", auth: aliceAuth, body: { title: "alice 的", prompt: "p", schedule: DAILY },
    })));
    const id = created.task.id;

    const aliceTasks = await json(await list.GET(ctx.request("/api/scheduled-tasks", { auth: aliceAuth })));
    assert.ok(aliceTasks.tasks.some((t) => t.id === id));
    const bobTasks = await json(await list.GET(ctx.request("/api/scheduled-tasks", { auth: bobAuth })));
    assert.equal(bobTasks.tasks.some((t) => t.id === id), false);

    // bob cannot read/update/delete alice's task: the store is keyed by agentDir.
    const params = { params: Promise.resolve({ id }) };
    assert.equal((await detail.GET(ctx.request(`/api/scheduled-tasks/${id}`, { auth: bobAuth }), params)).status, 404);
    assert.equal((await detail.PATCH(ctx.request(`/api/scheduled-tasks/${id}`, { method: "PATCH", auth: bobAuth, body: { enabled: false } }), params)).status, 404);
    assert.equal((await detail.DELETE(ctx.request(`/api/scheduled-tasks/${id}`, { method: "DELETE", auth: bobAuth }), params)).status, 404);
  } finally {
    ctx.cleanup();
  }
});

test("/api/scheduled-tasks/[id]: owner enable/disable + run-now guard", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const list = await ctx.load("app/api/scheduled-tasks/route.ts");
    const detail = await ctx.load("app/api/scheduled-tasks/[id]/route.ts");
    const auth = ctx.basic("alice", "alicepass123");
    const { task } = await json(await list.POST(ctx.request("/api/scheduled-tasks", {
      method: "POST", auth, body: { title: "t", prompt: "p", schedule: DAILY },
    })));
    const params = { params: Promise.resolve({ id: task.id }) };

    const patched = await json(await detail.PATCH(ctx.request(`/api/scheduled-tasks/${task.id}`, {
      method: "PATCH", auth, body: { enabled: false },
    }), params));
    assert.equal(patched.task.enabled, false);

    // Running a disabled task is a conflict.
    assert.equal((await detail.POST(ctx.request(`/api/scheduled-tasks/${task.id}`, { method: "POST", auth }), params)).status, 409);
    // An invalid schedule on patch is a 400.
    assert.equal((await detail.PATCH(ctx.request(`/api/scheduled-tasks/${task.id}`, {
      method: "PATCH", auth, body: { schedule: { kind: "bogus" } },
    }), params)).status, 400);

    // Delete removes it for the owner.
    assert.equal((await detail.DELETE(ctx.request(`/api/scheduled-tasks/${task.id}`, { method: "DELETE", auth }), params)).status, 200);
    assert.equal((await detail.GET(ctx.request(`/api/scheduled-tasks/${task.id}`, { auth }), params)).status, 404);
  } finally {
    ctx.cleanup();
  }
});

test("/api/scheduled-tasks/[id]: run-now is 409 while the task already has a run in flight", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const list = await ctx.load("app/api/scheduled-tasks/route.ts");
    const detail = await ctx.load("app/api/scheduled-tasks/[id]/route.ts");
    const auth = ctx.basic("alice", "alicepass123");
    const { task } = await json(await list.POST(ctx.request("/api/scheduled-tasks", {
      method: "POST", auth, body: { title: "t", prompt: "p", schedule: DAILY },
    })));
    const params = { params: Promise.resolve({ id: task.id }) };

    // Simulate an in-flight run the way the runner claims one (FR-7.6). The
    // guard lives on globalThis, shared with the freshly-imported route module.
    const agentDir = ctx.users.alice.agentDir;
    const scope = globalThis;
    (scope.__piScheduledRuns ??= new Map()).set(`${agentDir}\0${task.id}`, true);
    try {
      const res = await detail.POST(
        ctx.request(`/api/scheduled-tasks/${task.id}`, { method: "POST", auth }),
        params,
      );
      assert.equal(res.status, 409);
      assert.match((await json(res)).error, /already running/);
    } finally {
      scope.__piScheduledRuns.delete(`${agentDir}\0${task.id}`);
    }
  } finally {
    ctx.cleanup();
  }
});
