import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.env.E2E_SERVER_MODE || "dev";
assert.ok(mode === "dev" || mode === "start", "E2E_SERVER_MODE must be dev or start");
assert.ok(mode !== "dev" || !existsSync(join(root, ".next/dev/lock")), "Use a checkout without an active dev server");

const artifacts = join(root, "test-results/e2e-multiuser");
mkdirSync(artifacts, { recursive: true });
const dataRoot = mkdtempSync(join(tmpdir(), "pi-web-multiuser-"));
const globalAgentDir = join(dataRoot, "global-agent");
const seedDir = join(dataRoot, "seed");
mkdirSync(globalAgentDir, { recursive: true });
mkdirSync(seedDir, { recursive: true });

const SHARED_PASSWORD = "shared-login-123";
const ACCOUNTS = [
  { username: "admin", password: "adminpass123", role: "admin", displayName: "管理员" },
  { username: "alice", password: "alicepass123", role: "user", displayName: "爱丽丝" },
  { username: "bob", password: "bobpass123", role: "user" },
];
const SESSION = {
  alice: "01a12f11-aaaa-1111-cccc-1791791101",
  bob: "01a12f11-bbbb-2222-cccc-1791791102",
};

// ---------------------------------------------------------------------------
// Fixtures: accounts + per-user sessions, written before the server starts.
// ---------------------------------------------------------------------------
process.env.PI_WEB_DATA_DIR = dataRoot;
process.env.PI_SMARTFICC_USER_SEED_DIR = seedDir;
delete process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { alias: { "@": root }, interopDefault: true, moduleCache: false });
const store = await jiti.import(join(root, "lib/user-store.ts"));
const users = {};
for (const account of ACCOUNTS) {
  await store.createUser(account);
  users[account.username] = { agentDir: store.resolveUserAgentDir(account.username), ...account };
}

/** A minimal but valid session jsonl under the user's own sessions root. */
function seedSession(username, id, title) {
  const cwd = join(dataRoot, "projects", username);
  const dir = join(users[username].agentDir, "sessions", "e2e");
  mkdirSync(dir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const timestamp = "2026-10-12T08:00:00.000Z";
  const lines = [
    { type: "session", version: 3, id, timestamp, cwd },
    { type: "session_info", id: "name", parentId: null, timestamp, name: title },
    { type: "message", id: "u1", parentId: "name", timestamp, message: { role: "user", content: `${title} 的第一条消息` } },
  ];
  writeFileSync(
    join(dir, `2026-10-12T08-00-00-000Z_${id}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
}
seedSession("alice", SESSION.alice, "Alice 独有会话");
seedSession("bob", SESSION.bob, "Bob 独有会话");

/**
 * Give alice an offline model so a scheduled "run now" produces a real
 * transcript. The extension lives in HER agentDir, so this also proves the
 * worker reaches the owner's own provider.
 */
const E2E_ANSWER = "E2E_SCHEDULED_ANSWER";
function seedFauxProvider(username) {
  const dir = join(users[username].agentDir, "extensions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "faux-provider.ts"), [
    `import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";`,
    `const faux = fauxProvider({ models: [{ id: "faux-e2e" }] });`,
    `faux.setResponses([() => fauxAssistantMessage([fauxText(${JSON.stringify(E2E_ANSWER)})])]);`,
    `export default function (pi) { pi.registerProvider(faux.provider); }`,
    "",
  ].join("\n"));
  writeFileSync(
    join(users[username].agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-e2e" }, null, 2),
  );
}
seedFauxProvider("alice");

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
const base = `http://127.0.0.1:${port}`;

const serverLog = createWriteStream(join(artifacts, "server.log"));
let serverError;
const server = spawn(
  process.execPath,
  [join(root, "node_modules/next/dist/bin/next"), mode, "-H", "127.0.0.1", "-p", String(port)],
  {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: globalAgentDir,
      PI_WEB_DATA_DIR: dataRoot,
      PI_SMARTFICC_USER_SEED_DIR: seedDir,
      PI_WEB_PASSWORD: SHARED_PASSWORD,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
server.once("error", (error) => { serverError = error; });
const serverExited = once(server, "exit");
server.stdout.pipe(serverLog, { end: false });
server.stderr.pipe(serverLog, { end: false });

const basic = (username, password) =>
  "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

/**
 * Complete the shared-password gate. The submit button is disabled until
 * React hydration picks up the typed value, so retry the fill until it enables.
 */
async function login(page) {
  if (new URL(page.url()).pathname !== "/login") {
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  }
  if (new URL(page.url()).pathname !== "/login") return;
  const submit = page.getByRole("button", { name: "Log in", exact: true });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await page.locator("#web-login-password").fill(SHARED_PASSWORD);
    if (await submit.isEnabled()) break;
    await delay(100);
  }
  await submit.click();
  await page.waitForURL((url) => url.pathname !== "/login");
}

async function request(path, { method = "GET", account, body } = {}) {
  const headers = {};
  if (account) headers.authorization = basic(account.username, account.password);
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json, headers: response.headers };
}

/** POST multipart/form-data (skill zip upload) with the admin's Basic auth. */
async function upload(path, { account, form }) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: basic(account.username, account.password) },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json, headers: response.headers };
}

/** Build a minimal skill zip (root dir contains SKILL.md) via the `zip` shim. */
function skillZip(name, { description = "E2E skill", secrets = [] } = {}) {
  const staging = mkdtempSync(join(tmpdir(), "pi-e2e-skill-"));
  const root = join(staging, name);
  mkdirSync(root, { recursive: true });
  const frontmatter = ["---", `name: ${name}`, `description: ${description}`];
  if (secrets.length) frontmatter.push(`requiredSecrets: ${secrets.join(", ")}`);
  frontmatter.push("---", "", `# ${name}`, "E2E fixture skill.");
  writeFileSync(join(root, "SKILL.md"), frontmatter.join("\n"), "utf8");
  const zipPath = join(staging, `${name}.zip`);
  // Nested folder so the importer sees the conventional single top-level dir.
  writeZip(zipPath, { [`${name}/SKILL.md`]: readFileSync(join(root, "SKILL.md")) });
  return zipPath;
}

/**
 * Write a minimal zip archive.
 *
 * The `zip` binary is not installed everywhere (it is absent on a minimal
 * Debian image), and a missing test fixture should not look like a product
 * failure. Stored (uncompressed) entries only: the importer reads the central
 * directory, it does not care about the compression method.
 */
function writeZip(path, files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [entryName, body] of Object.entries(files)) {
    const nameBuf = Buffer.from(entryName, "utf8");
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  writeFileSync(path, Buffer.concat([...locals, centralBuf, end]));
}

/** CRC-32, as the zip format stores it. */
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let browser;

try {
  const deadline = Date.now() + 120_000;
  while (true) {
    if (serverError) throw serverError;
    assert.equal(server.exitCode, null, "Server exited before readiness; see server.log");
    const response = await fetch(`${base}/api/user/me`, {
      headers: { authorization: basic("admin", "adminpass123") },
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (response?.ok) break;
    assert.ok(Date.now() < deadline, "Server readiness timed out; see server.log");
    await delay(250);
  }

  // =========================================================================
  // API: identity, isolation, admin, secrets, schedules, logout
  // =========================================================================
  {
    const anonymous = await request("/api/sessions");
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Basic realm="Pi Web"/);

    const me = await request("/api/user/me", { account: users.alice });
    assert.equal(me.status, 200);
    assert.equal(me.json.multiUser, true);
    assert.equal(me.json.user.username, "alice");
    assert.equal(me.json.user.role, "user");
    assert.equal(me.json.user.displayName, "爱丽丝");
    assert.equal(me.json.user.agentDir, `${dataRoot}/users/alice`);

    const aliceSessions = await request("/api/sessions", { account: users.alice });
    assert.deepEqual(aliceSessions.json.sessions.map((s) => s.id), [SESSION.alice]);
    const bobSessions = await request("/api/sessions", { account: users.bob });
    assert.deepEqual(bobSessions.json.sessions.map((s) => s.id), [SESSION.bob]);

    // Cross-user session access by known id is refused (404, no existence leak).
    assert.equal((await request(`/api/sessions/${SESSION.bob}`, { account: users.alice })).status, 404);
    assert.equal((await request(`/api/sessions/${SESSION.alice}`, { account: users.bob })).status, 404);
    assert.equal((await request(`/api/sessions/${SESSION.alice}/export`, { account: users.bob })).status, 404);
    assert.equal((await request(`/api/sessions/${SESSION.alice}`, { account: users.alice })).status, 200);

    // Admin surface is role-gated.
    assert.equal((await request("/api/admin/users", { account: users.alice })).status, 403);
    const adminUsers = await request("/api/admin/users", { account: users.admin });
    assert.equal(adminUsers.status, 200);
    assert.deepEqual(adminUsers.json.users.map((u) => u.username).sort(), ["admin", "alice", "bob"]);

    // Admin can create a user; the newcomer can authenticate and is isolated.
    const created = await request("/api/admin/users", {
      account: users.admin,
      method: "POST",
      body: { username: "carol", password: "carolpass123", role: "user", displayName: "卡罗尔" },
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.user.username, "carol");
    assert.equal(created.json.user.role, "user");
    const carol = { username: "carol", password: "carolpass123" };
    assert.equal((await request("/api/sessions", { account: carol })).status, 200);
    const carolSessions = await request("/api/sessions", { account: carol });
    assert.deepEqual(carolSessions.json.sessions, [], "a brand-new user starts with no sessions");

    // Safety rail: an admin cannot demote or disable their own account.
    const actingAdminId = adminUsers.json.users.find((u) => u.username === "admin").id;
    assert.equal((await request("/api/admin/users", {
      account: users.admin,
      method: "PATCH",
      body: { userId: actingAdminId, role: "user" },
    })).status, 409);
    assert.equal((await request("/api/admin/users", {
      account: users.admin,
      method: "PATCH",
      body: { userId: actingAdminId, status: "disabled" },
    })).status, 409);
    console.log("PASS: identity, 401 challenge, cross-user session isolation, admin gate + user creation");
  }

  // Secrets are write-only and per-user.
  {
    const put = await request("/api/user/secrets", {
      account: users.alice,
      method: "PUT",
      body: { name: "RY_TOKEN", value: "super-secret-value" },
    });
    assert.equal(put.status, 200);
    const aliceSecrets = await request("/api/user/secrets", { account: users.alice });
    assert.deepEqual(aliceSecrets.json.secrets, [
      { name: "RY_TOKEN", configured: true, updatedAt: aliceSecrets.json.secrets[0].updatedAt },
    ]);
    assert.equal(JSON.stringify(aliceSecrets.json).includes("super-secret-value"), false, "secret values must never be returned");
    const bobSecrets = await request("/api/user/secrets", { account: users.bob });
    assert.deepEqual(bobSecrets.json.secrets, []);
    console.log("PASS: per-user runtime secrets are write-only and isolated");
  }

  // Personal APPEND_SYSTEM.md is per-user.
  {
    const put = await request("/api/user/append-system", {
      account: users.alice,
      method: "PUT",
      body: { content: "ALICE_PERSONAL_PREFERENCE" },
    });
    assert.equal(put.status, 200);
    const alice = await request("/api/user/append-system", { account: users.alice });
    assert.equal(alice.json.content, "ALICE_PERSONAL_PREFERENCE");
    const bob = await request("/api/user/append-system", { account: users.bob });
    assert.equal(bob.json.content.includes("ALICE_PERSONAL_PREFERENCE"), false);
    console.log("PASS: personal APPEND_SYSTEM.md is per-user");
  }

  // Scheduled tasks are per-user.
  {
    const created = await request("/api/scheduled-tasks", {
      account: users.alice,
      method: "POST",
      body: { title: "Alice 日报", prompt: "跑一遍日报", schedule: { kind: "daily", time: "09:00", timezone: "Asia/Shanghai" } },
    });
    assert.equal(created.status, 201);
    assert.ok(created.json.task.nextRunAt);
    const aliceTasks = await request("/api/scheduled-tasks", { account: users.alice });
    assert.equal(aliceTasks.json.perUser, true);
    assert.deepEqual(aliceTasks.json.tasks.map((t) => t.title), ["Alice 日报"]);
    const bobTasks = await request("/api/scheduled-tasks", { account: users.bob });
    assert.deepEqual(bobTasks.json.tasks, []);
    assert.equal(
      (await request(`/api/scheduled-tasks/${created.json.task.id}`, { account: users.bob })).status,
      404,
    );

    // FR-7.3: "run now" runs as the owner and the transcript lands in the
    // owner's own session list — and nowhere else. The task was created above
    // for alice; drive it through the real route, then poll.
    const taskId = created.json.task.id;
    const run = await request(`/api/scheduled-tasks/${taskId}`, { account: users.alice, method: "POST" });
    assert.equal(run.status, 202, JSON.stringify(run.json));
    assert.equal(run.json.accepted, true);

    let runRecord = null;
    const runDeadline = Date.now() + 120_000;
    while (Date.now() < runDeadline) {
      const task = await request(`/api/scheduled-tasks/${taskId}`, { account: users.alice });
      runRecord = task.json.task.runs?.[0] ?? null;
      if (runRecord && runRecord.status !== "skipped") break;
      assert.equal(server.exitCode, null, "server died mid-run; see server.log");
      await delay(500);
    }
    assert.ok(runRecord, "the run must record a history entry");
    assert.equal(runRecord.status, "ok", `run failed: ${JSON.stringify(runRecord)}`);
    assert.ok(runRecord.sessionId, "the run must record its transcript session id");

    // The transcript is a *new* session in alice's own list, and only hers.
    const aliceAfter = await request("/api/sessions?force=1", { account: users.alice });
    const aliceIds = aliceAfter.json.sessions.map((s) => s.id);
    assert.ok(aliceIds.includes(runRecord.sessionId), `owner's list must contain ${runRecord.sessionId}`);
    assert.deepEqual(
      aliceAfter.json.sessions.filter((s) => s.id === SESSION.bob).map((s) => s.id),
      [],
      "another user's session must not leak into the list",
    );
    const bobAfter = await request("/api/sessions?force=1", { account: users.bob });
    assert.deepEqual(bobAfter.json.sessions.map((s) => s.id), [SESSION.bob], "bob must not see alice's run");

    // And the transcript itself is owner-readable, containing the faux answer.
    const transcript = await request(`/api/sessions/${runRecord.sessionId}`, { account: users.alice });
    assert.equal(transcript.status, 200);
    assert.equal(JSON.stringify(transcript.json).includes(E2E_ANSWER), true);
    console.log("PASS: scheduled run lands in the owner's session list (FR-7.3)");
  }

  // Persistent shared allowed-roots is admin-only.
  {
    assert.equal((await request("/api/admin/allowed-roots", { account: users.alice })).status, 403);
    const created = await request("/api/admin/allowed-roots", {
      account: users.admin,
      method: "POST",
      body: { roots: [globalAgentDir] },
    });
    assert.equal(created.status, 200);
    assert.deepEqual(created.json.persisted, [globalAgentDir]);
    assert.deepEqual(
      (await request("/api/admin/allowed-roots", { account: users.admin })).json.persisted,
      [globalAgentDir],
    );
    console.log("PASS: admin allowed-roots are persisted and admin-only");
  }

  // Logout sentinel semantics (Basic has no server session). A real logout
  // carries the shared-password session cookie, so the proxy lets the sentinel
  // Authorization header through to the route instead of treating it as a
  // failed password guess (which would also trip the auth throttle).
  {
    const webAuth = await fetch(`${base}/api/web-auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: SHARED_PASSWORD }),
    });
    assert.equal(webAuth.status, 200);
    const cookie = (webAuth.headers.get("set-cookie") ?? "").split(";", 1)[0];
    assert.match(cookie, /^pi_web_session=/);

    const bare = await fetch(`${base}/api/logout`, { headers: { cookie } });
    assert.equal(bare.status, 401);
    assert.match(bare.headers.get("www-authenticate") ?? "", /^Basic realm="Pi Web"/);

    const sentinel = await fetch(`${base}/api/logout`, {
      headers: { cookie, authorization: basic("logout", "logout") },
    });
    assert.equal(sentinel.status, 200);
    assert.deepEqual(await sentinel.json(), { ok: true });
    console.log("PASS: /api/logout invalidates cached Basic credentials");
  }

  // Admin skill delivery: upload a zip, assign it, sync it, then the user sees
  // it in /api/user/skills (FR-4.1/4.4/4.6).
  {
    const carol = { username: "carol", password: "carolpass123" };
    const zip = skillZip("e2e-tool", { description: "E2E delivery tool", secrets: ["E2E_TOKEN"] });
    try {
      const form = new FormData();
      form.set("file", new File([readFileSync(zip)], "e2e-tool.zip", { type: "application/zip" }));
      form.set("version", "1.0.0");
      const imported = await upload("/api/admin/skills", { account: users.admin, form });
      assert.equal(imported.status, 200, JSON.stringify(imported.json));

      const registry = await request("/api/admin/skills", { account: users.admin });
      assert.ok(registry.json.skills.some((s) => s.name === "e2e-tool"), "skill must appear in the registry");

      // A normal user cannot import or assign.
      assert.equal((await request("/api/admin/skills", { account: users.alice })).status, 403);

      // Assign to carol and sync into her agentDir.
      const carolId = (await request("/api/admin/users", { account: users.admin })).json.users
        .find((u) => u.username === "carol").id;
      const assigned = await request("/api/admin/skills/assignments", {
        account: users.admin,
        method: "PUT",
        body: { userId: carolId, skills: ["e2e-tool@1.0.0"] },
      });
      assert.equal(assigned.status, 200, JSON.stringify(assigned.json));

      // Carol sees exactly her skill, with the effective version and required secret.
      const mine = await request("/api/user/skills", { account: carol });
      assert.equal(mine.status, 200);
      assert.deepEqual(mine.json.skills.map((s) => s.name), ["e2e-tool"]);
      assert.equal(mine.json.skills[0].assignedVersion, "1.0.0");
      assert.deepEqual(mine.json.skills[0].requiredSecrets, ["E2E_TOKEN"]);
      assert.equal(mine.json.skills[0].disabled, false);

      // Alice got nothing — assignment is per-user.
      assert.deepEqual((await request("/api/user/skills", { account: users.alice })).json.skills, []);

      // FR-4.6: carol temporarily disables it for herself without touching the files.
      const patched = await request("/api/user/skills", {
        account: carol,
        method: "PATCH",
        body: { name: "e2e-tool", disabled: true },
      });
      assert.equal(patched.status, 200, JSON.stringify(patched.json));
      assert.equal((await request("/api/user/skills", { account: carol })).json.skills[0].disabled, true);
      // Disabling an unassigned skill is refused.
      assert.equal((await request("/api/user/skills", {
        account: users.alice, method: "PATCH", body: { name: "e2e-tool", disabled: true },
      })).status, 403);
      console.log("PASS: admin skill delivery, per-user assignment, and self-service disable (FR-4.1/4.6)");
    } finally {
      rmSync(dirname(zip), { recursive: true, force: true });
    }
  }

  // Self-service password change (FR-2.3): wrong current password is refused,
  // the right one rotates the credential, and the new password then works.
  {
    const dave = { username: "dave", password: "davepass123" };
    assert.equal((await request("/api/admin/users", {
      account: users.admin, method: "POST", body: { username: "dave", password: "davepass123", role: "user" },
    })).status, 200);

    assert.equal((await request("/api/user/password", {
      account: dave, method: "POST", body: { currentPassword: "wrongpass1", newPassword: "davenewpass1" },
    })).status, 403);
    assert.equal((await request("/api/user/password", {
      account: dave, method: "POST", body: { currentPassword: "davepass123", newPassword: "short" },
    })).status, 400);

    const changed = await request("/api/user/password", {
      account: dave, method: "POST", body: { currentPassword: "davepass123", newPassword: "davenewpass1" },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.equal(changed.json.success, true);

    // Old password no longer authenticates; the new one does.
    assert.equal((await request("/api/user/me", { account: dave })).status, 401);
    assert.equal((await request("/api/user/me", { account: { username: "dave", password: "davenewpass1" } })).status, 200);
    console.log("PASS: self-service password change rotates credentials (FR-2.3)");
  }

  // =========================================================================
  // Browser: two-credential login, isolation UI, Settings, admin console
  // =========================================================================
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    httpCredentials: { username: "alice", password: "alicepass123" },
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Resource-load console noise is expected (a non-admin's /admin visit gets
  // 403s from the admin APIs); real failures are caught by the 5xx listener.
  page.on("console", (event) => {
    if (event.type() === "error" && !/Failed to load resource/.test(event.text())) errors.push(event.text());
  });
  const serverErrors = [];
  page.on("response", (response) => {
    if (response.url().startsWith(base) && response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });

  try {
    // --- shared password gate -------------------------------------------------
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => url.pathname === "/login");
    await login(page);

    // The top bar shows the per-user identity resolved from the Basic credentials.
    await page.getByText("爱丽丝", { exact: true }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 1);

    // --- session isolation in the sidebar ------------------------------------
    const sessionsTab = page.getByRole("tab", { name: "Sessions", exact: true });
    if (await sessionsTab.count() && await sessionsTab.getAttribute("aria-selected") !== "true") {
      await sessionsTab.click();
    }
    await page.getByText("Alice 独有会话", { exact: true }).first().waitFor();
    assert.equal(await page.getByText("Bob 独有会话", { exact: true }).count(), 0, "another user's sessions must never appear");
    console.log("PASS: browser session sidebar is per-user");

    // --- Settings › General › 账号与密钥 --------------------------------------
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name: "General", exact: true }).click();
    await page.getByRole("heading", { name: "账号与密钥", exact: true }).waitFor();
    await page.getByText("RY_TOKEN", { exact: true }).waitFor();
    await page.getByText("已设置", { exact: true }).waitFor();

    // Add a new secret through the UI (write-only round trip).
    await page.getByPlaceholder("新密钥名(如 RY_TOKEN)").fill("UI_TOKEN");
    await page.getByPlaceholder("值").last().fill("ui-secret-value");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await page.getByText("UI_TOKEN", { exact: true }).waitFor();
    assert.equal(await page.getByText("ui-secret-value", { exact: true }).count(), 0, "secret values must never render");

    // --- Settings › 定时任务 ---------------------------------------------------
    await settings.getByRole("button", { name: "Scheduled tasks", exact: true }).click();
    await settings.getByText("Alice 日报", { exact: true }).first().waitFor();
    // The prompt appears in the Settings detail pane (the run also created a
    // sidebar session with the same title, so scope to the dialog).
    await settings.locator("pre.schedules-prompt", { hasText: "跑一遍日报" }).waitFor();

    // FR-7.3 UI: the run history links straight into the transcript.
    const viewConversation = settings.getByRole("button", { name: "View conversation", exact: true });
    await viewConversation.waitFor();
    await viewConversation.click();
    await page.waitForURL((url) => url.pathname === "/" && url.searchParams.has("session"));
    // The transcript view shows the faux answer the scheduled run produced.
    await page.getByText(E2E_ANSWER, { exact: false }).first().waitFor();
    console.log("PASS: browser Account secrets, Scheduled tasks, and View conversation");

    // --- i18n: switching the interface language takes effect live ------------
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "General", exact: true }).click();
    // The dialog's accessible name follows the locale (Settings → 设置 → 設定),
    // so re-scope by the freshly translated name after every switch.
    await page.getByRole("radio", { name: /zh-CN/ }).click();
    await page.getByRole("dialog", { name: "设置", exact: true }).getByRole("button", { name: "常规", exact: true }).waitFor();
    // The choice persists across reloads (localStorage) and drives <html lang>.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const i18nZh = page.getByRole("dialog", { name: "设置", exact: true });
    await i18nZh.getByRole("button", { name: "常规", exact: true }).click();
    await i18nZh.getByRole("radio", { name: /zh-TW/ }).click();
    await page.getByRole("dialog", { name: "設定", exact: true }).getByRole("button", { name: "一般", exact: true }).waitFor();
    // Back to English: all three locales have now rendered.
    await page.getByRole("radio", { name: "English" }).click();
    await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "General", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    console.log("PASS: i18n switches across en / zh-CN / zh-TW and persists");

    // --- A non-admin cannot use the admin console ----------------------------
    await page.goto(`${base}/admin`, { waitUntil: "domcontentloaded" });
    await page.getByText("需要管理员权限", { exact: false }).first().waitFor();
    console.log("PASS: /admin shows a permission error for non-admins");

    await page.screenshot({ path: join(artifacts, "alice.png"), fullPage: true });
    assert.deepEqual(serverErrors, [], "no 5xx responses");
    assert.deepEqual(errors, [], "no browser errors");
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.tracing.stop({ path: join(artifacts, "alice-trace.zip") }).catch(() => {});
    await context.close();
  }

  // --- Admin console ---------------------------------------------------------
  {
    const adminContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      httpCredentials: { username: "admin", password: "adminpass123" },
    });
    const adminPage = await adminContext.newPage();
    adminPage.setDefaultTimeout(30_000);
    const adminErrors = [];
    adminPage.on("pageerror", (error) => adminErrors.push(error.message));
    adminPage.on("console", (event) => {
      if (event.type() === "error" && !/Failed to load resource/.test(event.text())) adminErrors.push(event.text());
    });
    try {
      await login(adminPage);
      await adminPage.goto(`${base}/admin`, { waitUntil: "domcontentloaded" });
      // Rendered embedded, so the visible text lives in the sidebar panes.
      // Counts include every account created in the API phase (admin, alice,
      // bob, carol, dave, + the UI-created one below), so match the prefix.
      await adminPage.getByText(/^用户管理\(\d+\)$/).waitFor();
      await adminPage.getByText("爱丽丝", { exact: false }).first().waitFor();
      await adminPage.getByText("bob", { exact: true }).first().waitFor();

      // FR-1.4: the user detail pane shows 最近活跃时间. dave changed his
      // password in the API phase, so he has definitely been active.
      await adminPage.getByText("dave", { exact: true }).first().click();
      const daveDetail = adminPage.locator(".config-detail");
      await daveDetail.getByText("最近活跃", { exact: true }).waitFor();
      await daveDetail.getByText("角色", { exact: true }).waitFor();

      // Admin skill delivery UI (FR-4.1): the registry lists the uploaded
      // skill; open its row, then the matrix assignment wizard.
      await adminPage.getByRole("button", { name: "技能注册表", exact: true }).click();
      await adminPage.getByText("e2e-tool", { exact: true }).first().waitFor();
      await adminPage.getByRole("button", { name: /e2e-tool/ }).first().click();
      await adminPage.getByRole("button", { name: "批量分配", exact: true }).click();
      await adminPage.getByText(/批量分配 — 选一批技能/).waitFor();
      await adminPage.getByText(/将执行 \d+ × \d+ = \d+ 项分配/).waitFor();

      await adminPage.getByRole("button", { name: "同步审计", exact: true }).click();
      await adminPage.getByText("技能同步审计日志", { exact: true }).waitFor();

      // 全部会话 (view-only session browser): every user → cwd → session, and
      // an admin can open another user's transcript read-only (no composer).
      await adminPage.getByRole("button", { name: "全部会话", exact: true }).click();
      await adminPage.getByText(/个目录 · \d+ 个会话/).first().waitFor();
      // alice seeded "Alice 独有会话"; expand her row, then her cwd group
      // (the cwd is <dataRoot>/projects/alice), then open the session.
      await adminPage.getByRole("button", { name: /爱丽丝/ }).first().click();
      await adminPage.getByRole("button", { name: /projects\/alice/ }).first().click();
      await adminPage.getByRole("button", { name: /Alice 独有会话/ }).first().click();
      await adminPage.getByText("只读 · 管理员查看", { exact: true }).waitFor();
      // The transcript body renders through MessageView (markdown), so match on
      // a substring rather than the exact paragraph text.
      await adminPage.getByText(/Alice 独有会话 的第一条消息/).first().waitFor();
      // Read-only means no composer at all.
      assert.equal(await adminPage.locator("textarea").count(), 0, "the admin viewer must not offer a composer");
      await adminPage.getByRole("button", { name: "← 返回列表", exact: true }).click();
      await adminPage.getByText(/个目录 · \d+ 个会话/).first().waitFor();

      await adminPage.screenshot({ path: join(artifacts, "admin.png"), fullPage: true });
      assert.deepEqual(adminErrors, [], "no browser errors in admin console");
      console.log("PASS: admin console — users + 最近活跃, skills, all-sessions viewer (read-only), audit");
    } catch (error) {
      await adminPage.screenshot({ path: join(artifacts, "failure-admin.png"), fullPage: true }).catch(() => {});
      throw error;
    } finally {
      await adminContext.close();
    }
  }

  // --- Account UI flows: change password + sign out (FR-2.3) ---------------
  {
    // A throwaway account: rotating its password must not disturb other checks.
    assert.equal((await request("/api/admin/users", {
      account: users.admin,
      method: "POST",
      body: { username: "erin", password: "erinpass123", role: "user", displayName: "艾琳" },
    })).status, 200);
    const erinContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      httpCredentials: { username: "erin", password: "erinpass123" },
    });
    const erinPage = await erinContext.newPage();
    erinPage.setDefaultTimeout(30_000);
    const erinErrors = [];
    erinPage.on("pageerror", (error) => erinErrors.push(error.message));
    erinPage.on("console", (event) => {
      if (event.type() === "error" && !/Failed to load resource/.test(event.text())) erinErrors.push(event.text());
    });
    try {
      await login(erinPage);

      // Settings › General › change-password round trip through the UI.
      await erinPage.getByRole("button", { name: "Settings", exact: true }).click();
      const erinSettings = erinPage.getByRole("dialog", { name: "Settings", exact: true });
      await erinSettings.getByRole("button", { name: "General", exact: true }).click();
      await erinPage.getByRole("button", { name: "修改密码…", exact: true }).click();
      await erinPage.getByPlaceholder("当前密码").fill("erinpass123");
      await erinPage.getByPlaceholder("新密码(≥8位)").fill("erinnewpass1");
      await erinPage.getByRole("button", { name: "保存", exact: true }).click();
      await erinPage.getByText("密码已修改", { exact: true }).waitFor();

      // The rotated password is the one that now authenticates.
      assert.equal((await request("/api/user/me", { account: { username: "erin", password: "erinpass123" } })).status, 401);
      assert.equal((await request("/api/user/me", { account: { username: "erin", password: "erinnewpass1" } })).status, 200);
      console.log("PASS: change-password UI rotates the credential (FR-2.3)");

      // Sign out: confirm dialog → sentinel /api/logout → back on "/".
      await erinPage.keyboard.press("Escape");
      const logoutRequest = erinPage.waitForRequest((r) => r.url().includes("/api/logout"), { timeout: 15_000 });
      erinPage.once("dialog", (dialog) => {
        assert.match(dialog.message(), /Sign out/i);
        void dialog.accept();
      });
      await erinPage.getByRole("button", { name: "Sign out", exact: true }).click();
      const sent = await logoutRequest;
      assert.match(sent.headers()["authorization"] ?? "", /^Basic /, "logout must overwrite the cached Basic credentials");
      await erinPage.waitForURL((url) => url.pathname === "/");
      assert.deepEqual(erinErrors, [], "no browser errors in the account flows");
      console.log("PASS: sign-out UI calls /api/logout and returns to /");
    } catch (error) {
      await erinPage.screenshot({ path: join(artifacts, "failure-account.png"), fullPage: true }).catch(() => {});
      throw error;
    } finally {
      await erinContext.close();
    }
  }

  console.log("\nAll multi-user E2E checks passed");
} finally {
  await browser?.close().catch(() => {});
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    const forceKill = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await serverExited;
    clearTimeout(forceKill);
  }
  serverLog.end();
  rmSync(dataRoot, { recursive: true, force: true });
}
