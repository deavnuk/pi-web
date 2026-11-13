// Route tests for /api/user/skills (FR-4.6): a user's own view of the skills
// assigned to them, plus the per-user temporary disable toggle. The toggle must
// change only this user's sessions — never the admin-distributed files.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { json, setupUsers } from "../../__tests__/route-test-helpers.mjs";

const ACCOUNTS = [
  { username: "admin", password: "adminpass123", role: "admin" },
  { username: "alice", password: "alicepass123", role: "user" },
  { username: "bob", password: "bobpass123", role: "user" },
];

function hasBinary(name) {
  try {
    execFileSync(name, ["-v"], { stdio: "ignore" });
    return true;
  } catch (error) {
    return error?.status === 0;
  }
}
const skipNoZip = hasBinary("zip") && hasBinary("unzip") ? false : "requires the `zip` and `unzip` binaries";

function makeZip(dest, { name, description = "A test skill" }) {
  const staging = mkdtempSync(join(tmpdir(), "pi-skill-pref-src-"));
  const root = join(staging, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), ["---", `name: ${name}`, `description: ${description}`, "---", "", "# body"].join("\n"), "utf8");
  execFileSync("zip", ["-qr", dest, "."], { cwd: root });
  rmSync(staging, { recursive: true, force: true });
}

/** Import a skill into the registry and assign it to a user. */
async function seedAssignment(ctx, zip, { name, version, userId }) {
  const { POST } = await ctx.load("app/api/admin/skills/route.ts");
  const { PUT } = await ctx.load("app/api/admin/skills/assignments/route.ts");
  const auth = ctx.basic("admin", "adminpass123");
  const form = new FormData();
  form.set("file", new File([await import("node:fs").then((fs) => fs.readFileSync(zip))], `${name}.zip`, { type: "application/zip" }));
  form.set("version", version);
  const imported = await POST(new Request("http://localhost/api/admin/skills", { method: "POST", headers: { host: "localhost", authorization: auth }, body: form }));
  assert.equal(imported.status, 200, await imported.clone().text());
  const assigned = await PUT(ctx.request("/api/admin/skills/assignments", { method: "PUT", auth, body: { userId, skills: [`${name}@${version}`] } }));
  assert.equal(assigned.status, 200, await assigned.clone().text());
}

test("/api/user/skills: requires authentication; normal users see only their own", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET } = await ctx.load("app/api/user/skills/route.ts");
    assert.equal((await GET(ctx.request("/api/user/skills"))).status, 401);
    const empty = await json(await GET(ctx.request("/api/user/skills", { auth: ctx.basic("alice", "alicepass123") })));
    assert.deepEqual(empty.skills, []);
  } finally {
    ctx.cleanup();
  }
});

test("/api/user/skills: lists assignment + effective version and toggles disable (FR-4.6)", { skip: skipNoZip }, async () => {
  const ctx = await setupUsers(ACCOUNTS);
  const zip = join(tmpdir(), `pi-skill-pref-${Math.random().toString(36).slice(2)}.zip`);
  try {
    makeZip(zip, { name: "ruiyan", description: "RY helper" });
    await seedAssignment(ctx, zip, { name: "ruiyan", version: "1.3.0", userId: ctx.users.alice.id });

    const { GET, PATCH } = await ctx.load("app/api/user/skills/route.ts");
    const alice = ctx.basic("alice", "alicepass123");

    const list = await json(await GET(ctx.request("/api/user/skills", { auth: alice })));
    assert.equal(list.skills.length, 1);
    assert.equal(list.skills[0].name, "ruiyan");
    assert.equal(list.skills[0].assignedVersion, "1.3.0");
    assert.equal(list.skills[0].effectiveVersion, "1.3.0");
    assert.equal(list.skills[0].disabled, false);

    // Disable for alice only.
    const off = await PATCH(ctx.request("/api/user/skills", { method: "PATCH", auth: alice, body: { name: "ruiyan", disabled: true } }));
    assert.equal(off.status, 200, await off.clone().text());
    assert.equal((await json(off)).skill.disabled, true);

    const afterOff = await json(await GET(ctx.request("/api/user/skills", { auth: alice })));
    assert.equal(afterOff.skills[0].disabled, true);
    // On-disk preference + the admin's distributed SKILL.md is untouched.
    const prefs = join(ctx.users.alice.agentDir, "skill-prefs.json");
    assert.ok(existsSync(prefs));
    assert.match(readFileSync(prefs, "utf8"), /ruiyan/);
    const skillMd = join(ctx.users.alice.agentDir, "skills", "ruiyan", "SKILL.md");
    assert.equal(readFileSync(skillMd, "utf8").includes("disable-model-invocation"), false);

    // bob has no such assignment → his list stays empty, toggling it is forbidden.
    const bob = ctx.basic("bob", "bobpass123");
    assert.deepEqual((await json(await GET(ctx.request("/api/user/skills", { auth: bob })))).skills, []);
    assert.equal((await PATCH(ctx.request("/api/user/skills", { method: "PATCH", auth: bob, body: { name: "ruiyan", disabled: true } }))).status, 403);

    // Re-enable clears the preference.
    await PATCH(ctx.request("/api/user/skills", { method: "PATCH", auth: alice, body: { name: "ruiyan", disabled: false } }));
    assert.deepEqual((await json(await GET(ctx.request("/api/user/skills", { auth: alice })))).skills[0].disabled, false);
  } finally {
    rmSync(zip, { force: true });
    ctx.cleanup();
  }
});

test("/api/user/skills: PATCH validation + cross-origin rejection", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { PATCH } = await ctx.load("app/api/user/skills/route.ts");
    const alice = ctx.basic("alice", "alicepass123");
    assert.equal((await PATCH(ctx.request("/api/user/skills", { method: "PATCH", auth: alice, body: { disabled: true } }))).status, 400);
    assert.equal((await PATCH(ctx.request("/api/user/skills", { method: "PATCH", auth: alice, body: { name: "x", disabled: "yes" } }))).status, 400);
    assert.equal((await PATCH(ctx.request("/api/user/skills", { method: "PATCH", auth: alice, headers: { origin: "http://evil.example.com" }, body: { name: "x", disabled: true } }))).status, 403);
  } finally {
    ctx.cleanup();
  }
});
