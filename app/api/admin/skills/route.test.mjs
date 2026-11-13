// Route tests for /api/admin/skills and its sub-routes (SkillHub FR-4).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { json, setupUsers } from "../../__tests__/route-test-helpers.mjs";

const ACCOUNTS = [
  { username: "admin", password: "adminpass123", role: "admin" },
  { username: "alice", password: "alicepass123", role: "user" },
];

// The zip-import cases need the system `zip`/`unzip` binaries the skill
// registry shells out to (lib/skill-registry.ts). Skip them where the tooling
// is absent rather than failing on an environment gap.
function hasBinary(name) {
  try {
    execFileSync(name, ["-v"], { stdio: "ignore" });
    return true;
  } catch (error) {
    return error?.status === 0;
  }
}
const zipAvailable = hasBinary("zip") && hasBinary("unzip");
const skipNoZip = zipAvailable ? false : "requires the `zip` and `unzip` binaries";

function makeZip(dest, { name, description = "A test skill", secrets = [] }) {
  const staging = mkdtempSync(join(tmpdir(), "pi-skill-zip-src-"));
  const root = join(staging, name);
  mkdirSync(root, { recursive: true });
  const lines = ["---", `name: ${name}`, `description: ${description}`];
  if (secrets.length) lines.push(`requiredSecrets: ${secrets.join(", ")}`);
  lines.push("---", "", `# ${name}`, "Does things.");
  writeFileSync(join(root, "SKILL.md"), lines.join("\n"), "utf8");
  execFileSync("zip", ["-qr", dest, "."], { cwd: root });
  rmSync(staging, { recursive: true, force: true });
}

test("/api/admin/skills: normal users and anonymous are forbidden", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { GET, DELETE } = await ctx.load("app/api/admin/skills/route.ts");
    assert.equal((await GET(ctx.request("/api/admin/skills"))).status, 401);
    assert.equal((await GET(ctx.request("/api/admin/skills", { auth: ctx.basic("alice", "alicepass123") }))).status, 403);
    assert.equal((await DELETE(ctx.request("/api/admin/skills?name=x&version=1.0.0", { method: "DELETE", auth: ctx.basic("alice", "alicepass123") }))).status, 403);
  } finally {
    ctx.cleanup();
  }
});

test("/api/admin/skills: zip import, list, and per-user assignment summary", { skip: skipNoZip }, async () => {
  const ctx = await setupUsers(ACCOUNTS);
  const zip = join(tmpdir(), `pi-skill-route-${Math.random().toString(36).slice(2)}.zip`);
  try {
    makeZip(zip, { name: "ruiyan", description: "RY query helper", secrets: ["RY_TOKEN"] });
    const { GET, POST } = await ctx.load("app/api/admin/skills/route.ts");
    const auth = ctx.basic("admin", "adminpass123");

    const form = new FormData();
    form.set("file", new File([await import("node:fs").then((fs) => fs.readFileSync(zip))], "ruiyan.zip", { type: "application/zip" }));
    form.set("version", "1.0.0");
    form.set("displayName", "瑞研");
    const importReq = new Request("http://localhost/api/admin/skills", { method: "POST", headers: { host: "localhost", authorization: auth }, body: form });
    const importRes = await POST(importReq);
    assert.equal(importRes.status, 200, await importRes.clone().text());
    assert.equal((await json(importRes)).skill.name, "ruiyan");

    const list = await json(await GET(ctx.request("/api/admin/skills", { auth })));
    assert.ok(list.skills.some((s) => s.name === "ruiyan"));
    assert.ok(list.assignments[ctx.users.alice.id], "assignment map keyed by userId");
  } finally {
    rmSync(zip, { force: true });
    ctx.cleanup();
  }
});

test("/api/admin/skills: POST validation errors", async () => {
  const ctx = await setupUsers(ACCOUNTS);
  try {
    const { POST } = await ctx.load("app/api/admin/skills/route.ts");
    const auth = ctx.basic("admin", "adminpass123");
    // Unsupported content type.
    assert.equal((await POST(ctx.request("/api/admin/skills", { method: "POST", auth, headers: { "content-type": "text/plain" }, body: undefined }))).status, 400);
    // JSON git import without repo.
    assert.equal((await POST(ctx.request("/api/admin/skills", { method: "POST", auth, body: {} }))).status, 400);
    // Cross-origin rejected.
    assert.equal((await POST(ctx.request("/api/admin/skills", { method: "POST", auth, headers: { origin: "http://evil.example.com", "content-type": "application/json" }, body: { repo: "x" } }))).status, 403);
  } finally {
    ctx.cleanup();
  }
});

test("/api/admin/skills/assignments: batch assignment syncs skills into the user's agentDir", { skip: skipNoZip }, async () => {
  const ctx = await setupUsers(ACCOUNTS);
  const zip = join(tmpdir(), `pi-skill-assign-${Math.random().toString(36).slice(2)}.zip`);
  try {
    makeZip(zip, { name: "bond-analysis", description: "Bond analytics" });
    const { POST } = await ctx.load("app/api/admin/skills/route.ts");
    const { PUT } = await ctx.load("app/api/admin/skills/assignments/route.ts");
    const auth = ctx.basic("admin", "adminpass123");

    const form = new FormData();
    form.set("file", new File([await import("node:fs").then((fs) => fs.readFileSync(zip))], "bond-analysis.zip", { type: "application/zip" }));
    form.set("version", "1.2.0");
    await POST(new Request("http://localhost/api/admin/skills", { method: "POST", headers: { host: "localhost", authorization: auth }, body: form }));

    const assignRes = await PUT(ctx.request("/api/admin/skills/assignments", {
      method: "PUT", auth, body: { userId: ctx.users.alice.id, skills: ["bond-analysis@1.2.0"] },
    }));
    assert.equal(assignRes.status, 200, await assignRes.clone().text());

    const alice = ctx.store.findUserById(ctx.users.alice.id);
    assert.ok(alice.skills.includes("bond-analysis@1.2.0"));

    // Unknown version is rejected.
    assert.equal((await PUT(ctx.request("/api/admin/skills/assignments", {
      method: "PUT", auth, body: { userId: ctx.users.alice.id, skills: ["bond-analysis@9.9.9"] },
    }))).status, 400);
  } finally {
    rmSync(zip, { force: true });
    ctx.cleanup();
  }
});

test("/api/admin/skills/assignments: tenant-wide assignment syncs every member (FR-4.3)", { skip: skipNoZip }, async () => {
  const accounts = [
    { username: "admin", password: "adminpass123", role: "admin" },
    { username: "alice", password: "alicepass123", role: "user", tenantId: "t_acme" },
    { username: "bob", password: "bobpass123", role: "user", tenantId: "t_acme" },
    { username: "carol", password: "carolpass123", role: "user", tenantId: "t_other" },
  ];
  const ctx = await setupUsers(accounts);
  const zip = join(tmpdir(), `pi-skill-tenant-${Math.random().toString(36).slice(2)}.zip`);
  try {
    makeZip(zip, { name: "tenant-tool", description: "Tenant tool" });
    const { POST: addSkill } = await ctx.load("app/api/admin/skills/route.ts");
    const { PUT } = await ctx.load("app/api/admin/skills/assignments/route.ts");
    const { readUserSkillsManifest } = await ctx.load("lib/skill-registry.ts");
    const auth = ctx.basic("admin", "adminpass123");

    const form = new FormData();
    form.set("file", new File([await import("node:fs").then((fs) => fs.readFileSync(zip))], "tenant-tool.zip", { type: "application/zip" }));
    form.set("version", "2.0.0");
    await addSkill(new Request("http://localhost/api/admin/skills", { method: "POST", headers: { host: "localhost", authorization: auth }, body: form }));

    const res = await PUT(ctx.request("/api/admin/skills/assignments", {
      method: "PUT", auth, body: { tenantId: "t_acme", skills: ["tenant-tool@2.0.0"] },
    }));
    assert.equal(res.status, 200, await res.clone().text());

    // Both members of t_acme received the assignment + a synced copy...
    for (const name of ["alice", "bob"]) {
      const user = ctx.users[name];
      assert.ok(ctx.store.findUserById(user.id).skills.includes("tenant-tool@2.0.0"), `${name} assigned`);
      assert.equal(readUserSkillsManifest(user.agentDir).skills["tenant-tool"]?.version, "2.0.0");
    }
    // ...while the other tenant's member did not.
    assert.equal(ctx.store.findUserById(ctx.users.carol.id).skills.length, 0);
    assert.equal(readUserSkillsManifest(ctx.users.carol.agentDir).skills["tenant-tool"], undefined);
  } finally {
    rmSync(zip, { force: true });
    ctx.cleanup();
  }
});

test("/api/admin/skills/assignments/batch: matrix assignment keeps unrelated skills", { skip: skipNoZip }, async () => {
  const ctx = await setupUsers(ACCOUNTS);
  const zipA = join(tmpdir(), `pi-batch-a-${Math.random().toString(36).slice(2)}.zip`);
  const zipB = join(tmpdir(), `pi-batch-b-${Math.random().toString(36).slice(2)}.zip`);
  try {
    makeZip(zipA, { name: "alpha" });
    makeZip(zipB, { name: "beta" });
    const { POST: addSkill } = await ctx.load("app/api/admin/skills/route.ts");
    const { PUT } = await ctx.load("app/api/admin/skills/assignments/route.ts");
    const { POST: batch } = await ctx.load("app/api/admin/skills/assignments/batch/route.ts");
    const auth = ctx.basic("admin", "adminpass123");

    for (const [zip, name] of [[zipA, "alpha"], [zipB, "beta"]]) {
      const form = new FormData();
      form.set("file", new File([await import("node:fs").then((fs) => fs.readFileSync(zip))], `${name}.zip`, { type: "application/zip" }));
      form.set("version", "1.0.0");
      await addSkill(new Request("http://localhost/api/admin/skills", { method: "POST", headers: { host: "localhost", authorization: auth }, body: form }));
    }
    // Alice already has alpha; batch-add beta only.
    await PUT(ctx.request("/api/admin/skills/assignments", { method: "PUT", auth, body: { userId: ctx.users.alice.id, skills: ["alpha@1.0.0"] } }));
    const res = await batch(ctx.request("/api/admin/skills/assignments/batch", {
      method: "POST", auth, body: { skills: ["beta"], users: [ctx.users.alice.id], version: "1.0.0" },
    }));
    assert.equal(res.status, 200, await res.clone().text());
    const skills = ctx.store.findUserById(ctx.users.alice.id).skills;
    assert.ok(skills.some((s) => s.startsWith("alpha@")), "alpha preserved");
    assert.ok(skills.some((s) => s.startsWith("beta@")), "beta added");

    // Unknown skill rejected.
    assert.equal((await batch(ctx.request("/api/admin/skills/assignments/batch", {
      method: "POST", auth, body: { skills: ["ghost"], users: [ctx.users.alice.id] },
    }))).status, 400);
  } finally {
    rmSync(zipA, { force: true });
    rmSync(zipB, { force: true });
    ctx.cleanup();
  }
});
