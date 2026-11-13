import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

// Skill import shells out to the system `zip`/`unzip` binaries. Skip those
// cases where the tooling is unavailable instead of failing on an
// environment gap.
function hasBinary(name) {
  try {
    execFileSync(name, ["-v"], { stdio: "ignore" });
    return true;
  } catch (error) {
    return error?.status === 0;
  }
}
const skipNoZip = hasBinary("zip") && hasBinary("unzip")
  ? false
  : "requires the `zip` and `unzip` binaries";

let dataDir;
let prevDataDir;

function skillMd(name, description, secrets = []) {
  const lines = ["---", `name: ${name}`, `description: ${description}`];
  if (secrets.length > 0) {
    lines.push(`requiredSecrets: ${secrets.join(", ")}`);
  }
  lines.push("---", "", `# ${name}`, "Do things.");
  return lines.join("\n");
}

function makeZip(dest, { name, description, secrets = [], nested = false }) {
  const staging = mkdtempSync(join(tmpdir(), "pi-skill-src-"));
  const root = join(staging, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), skillMd(name, description, secrets), "utf8");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "run.sh"), "#!/bin/sh\necho hi\n", "utf8");
  if (nested) {
    // zip containing a single top folder (typical)
    execFileSync("zip", ["-qr", dest, name], { cwd: staging });
  } else {
    execFileSync("zip", ["-qr", dest, "."], { cwd: root });
  }
  rmSync(staging, { recursive: true, force: true });
}

test.before(() => {
  prevDataDir = process.env.PI_WEB_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "pi-registry-"));
  process.env.PI_WEB_DATA_DIR = dataDir;
});

test.after(() => {
  if (prevDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
  else process.env.PI_WEB_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

test("parseSkillMd: scalar + yaml-list requiredSecrets, plain markdown", async () => {
  const { parseSkillMd } = await jiti.import("./skill-registry.ts");
  const scalar = parseSkillMd("---\nname: foo\ndescription: Bar baz\nrequiredSecrets: RY_TOKEN, SMARTFICC_API_KEY\n---\nbody");
  assert.equal(scalar.name, "foo");
  assert.equal(scalar.description, "Bar baz");
  assert.deepEqual(scalar.requiredSecrets, ["RY_TOKEN", "SMARTFICC_API_KEY"]);

  const listed = parseSkillMd("---\nname: foo\ndescription: x\nrequiredSecrets:\n  - A_TOKEN\n  - B_KEY\n---\nbody");
  assert.deepEqual(listed.requiredSecrets, ["A_TOKEN", "B_KEY"]);

  const plain = parseSkillMd("# no frontmatter");
  assert.deepEqual(plain.requiredSecrets, []);
  assert.equal(plain.name, undefined);
});

test("addSkillFromZip: upload → registry listing → immutable re-upload conflict", { skip: skipNoZip }, async () => {
  const { addSkillFromZip, listRegistrySkills, getRegistrySkill, SkillRegistryError } =
    await jiti.import("./skill-registry.ts");

  const zipA = join(tmpdir(), `pi-skill-${Math.random().toString(36).slice(2)}a.zip`);
  const zipB = join(tmpdir(), `pi-skill-${Math.random().toString(36).slice(2)}b.zip`);
  try {
    makeZip(zipA, { name: "ruiyan", description: "RY query helper", secrets: ["RY_TOKEN"] });
    const skill = addSkillFromZip({ zipPath: zipA, version: "1.0.0", addedBy: "admin" });
    assert.equal(skill.name, "ruiyan");
    assert.equal(skill.description, "RY query helper");
    assert.deepEqual(skill.requiredSecrets, ["RY_TOKEN"]);
    assert.equal(skill.current, "1.0.0");
    assert.ok(existsSync(join(dataDir, "registry", "skills", "ruiyan", "1.0.0", "SKILL.md")));

    // Same content re-upload → idempotent no-op
    const again = addSkillFromZip({ zipPath: zipA, version: "1.0.0", addedBy: "admin" });
    assert.equal(again.name, "ruiyan");

    // Different content, same version → immutable violation
    makeZip(zipB, { name: "ruiyan", description: "CHANGED CONTENT" });
    assert.throws(
      () => addSkillFromZip({ zipPath: zipB, version: "1.0.0" }),
      /versions are immutable/,
    );

    // New version
    makeZip(zipB, { name: "ruiyan", description: "RY query helper v2", secrets: ["RY_TOKEN", "SF_KEY"] });
    const v2 = addSkillFromZip({ zipPath: zipB, version: "1.1.0", addedBy: "admin" });
    assert.equal(v2.versions.length, 2);
    assert.equal(v2.current, "1.1.0");

    const listed = listRegistrySkills();
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].versions.map((v) => v.version).sort(), ["1.0.0", "1.1.0"]);
  } finally {
    rmSync(zipA, { force: true });
    rmSync(zipB, { force: true });
  }
});

test("resolveAssignment: latest pins to newest semver; unknown rejected", { skip: skipNoZip }, async () => {
  const { resolveAssignment, addSkillFromZip, SkillRegistryError } = await jiti.import("./skill-registry.ts");
  const zip = join(tmpdir(), `pi-skill-${Math.random().toString(36).slice(2)}c.zip`);
  try {
    makeZip(zip, { name: "bond-analysis", description: "Bond analytics" });
    addSkillFromZip({ zipPath: zip, version: "1.2.0" });
    addSkillFromZip({ zipPath: zip, version: "1.10.0" });

    assert.deepEqual(resolveAssignment("bond-analysis@latest"), { name: "bond-analysis", version: "1.10.0" });
    assert.deepEqual(resolveAssignment("bond-analysis@1.2.0"), { name: "bond-analysis", version: "1.2.0" });
    assert.equal(resolveAssignment("bond-analysis@9.9.9"), null);
    assert.equal(resolveAssignment("nope@1.0.0"), null);
  } finally {
    rmSync(zip, { force: true });
  }
});

test("syncUserSkills: idempotent differential copy, latest upgrade, revoke removal, audit log", { skip: skipNoZip }, async () => {
  const { addSkillFromZip, syncUserSkills, readUserSkillsManifest, readAudit, SkillRegistryError } =
    await jiti.import("./skill-registry.ts");
  const agentDir = mkdtempSync(join(tmpdir(), "pi-registry-user-"));
  mkdirSync(join(agentDir, "skills"), { recursive: true });
  const zip = join(tmpdir(), `pi-skill-${Math.random().toString(36).slice(2)}d.zip`);
  try {
    makeZip(zip, { name: "multiuser-data", description: "SFC data helper", secrets: ["SF_KEY"] });
    addSkillFromZip({ zipPath: zip, version: "1.0.0", addedBy: "admin" });

    // First sync: applies
    const r1 = syncUserSkills(agentDir, ["multiuser-data@1.0.0"], { by: "admin", userId: "u_x" });
    assert.deepEqual(r1.applied, ["multiuser-data@1.0.0"]);
    assert.ok(existsSync(join(agentDir, "skills", "multiuser-data", "SKILL.md")));
    let manifest = readUserSkillsManifest(agentDir);
    assert.equal(manifest.skills["multiuser-data"].version, "1.0.0");

    // Second sync: unchanged (idempotent)
    const r2 = syncUserSkills(agentDir, ["multiuser-data@1.0.0"], { by: "admin", userId: "u_x" });
    assert.deepEqual(r2.unchanged, ["multiuser-data@1.0.0"]);
    assert.equal(r2.applied.length, 0);

    // Publish new version + assignment@latest → upgrade on next sync
    addSkillFromZip({ zipPath: zip, version: "1.1.0", addedBy: "admin" });
    const r3 = syncUserSkills(agentDir, ["multiuser-data@latest"], { by: "admin", userId: "u_x" });
    assert.deepEqual(r3.applied, ["multiuser-data@1.1.0"]);
    manifest = readUserSkillsManifest(agentDir);
    assert.equal(manifest.skills["multiuser-data"].version, "1.1.0");
    assert.ok(readFileSync(join(agentDir, "skills", "multiuser-data", "SKILL.md"), "utf8").includes("SFC data helper"));

    // User preference edit survives sync (copy isolation): edit then re-sync same version → unchanged, edit intact
    writeFileSync(join(agentDir, "skills", "multiuser-data", "SKILL.md"), skillMd("multiuser-data", "SFC data helper") + "\n<!-- user edit -->", "utf8");
    const r4 = syncUserSkills(agentDir, ["multiuser-data@latest"], { by: "admin", userId: "u_x" });
    assert.deepEqual(r4.unchanged, ["multiuser-data@1.1.0"]);
    assert.ok(readFileSync(join(agentDir, "skills", "multiuser-data", "SKILL.md"), "utf8").includes("user edit"));

    // Revoke → removed on next sync
    const r5 = syncUserSkills(agentDir, [], { by: "admin", userId: "u_x" });
    assert.deepEqual(r5.removed, ["multiuser-data@1.1.0"]);
    assert.ok(!existsSync(join(agentDir, "skills", "multiuser-data")));
    manifest = readUserSkillsManifest(agentDir);
    assert.equal(manifest.skills["multiuser-data"], undefined);

    // Unknown assignment → error entry, no crash
    const r6 = syncUserSkills(agentDir, ["ghost@1.0.0"], { by: "admin", userId: "u_x" });
    assert.equal(r6.errors.length, 1);
    assert.ok(r6.errors[0].includes("ghost"));

    // Audit entries recorded
    const audit = readAudit(undefined, 50);
    assert.ok(audit.some((e) => e.action === "user_sync"));
    assert.ok(audit.some((e) => e.action === "registry_add"));
  } finally {
    rmSync(zip, { force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("deleteSkillVersion removes dir; user disable-edit flow intact", { skip: skipNoZip }, async () => {
  const { addSkillFromZip, deleteSkillVersion, getRegistrySkill } = await jiti.import("./skill-registry.ts");
  const zip = join(tmpdir(), `pi-skill-${Math.random().toString(36).slice(2)}e.zip`);
  try {
    makeZip(zip, { name: "temp-skill", description: "temp" });
    addSkillFromZip({ zipPath: zip, version: "0.1.0" });
    addSkillFromZip({ zipPath: zip, version: "0.2.0" });
    deleteSkillVersion("temp-skill", "0.2.0", "admin");
    const skill = getRegistrySkill("temp-skill");
    assert.equal(skill.versions.length, 1);
    assert.equal(skill.current, "0.1.0");
    assert.ok(!existsSync(join(dataDir, "registry", "skills", "temp-skill", "0.2.0")));
  } finally {
    rmSync(zip, { force: true });
  }
});

test("addSkillFromDirectory: multi-skill repo via subdir; helpful error without it", async () => {
  const { addSkillFromDirectory, SkillRegistryError } = await jiti.import("./skill-registry.ts");

  const staging = mkdtempSync(join(tmpdir(), "pi-skill-mono-"));
  try {
    // monorepo with two skills at top level
    for (const [name, desc] of [["alpha-skill", "Alpha helper"], ["beta-skill", "Beta helper"]]) {
      mkdirSync(join(staging, name), { recursive: true });
      writeFileSync(join(staging, name, "SKILL.md"), skillMd(name, desc), "utf8");
    }
    writeFileSync(join(staging, "README.md"), "# monorepo\n", "utf8");

    // Without subdir → helpful error listing candidates
    assert.throws(
      () => addSkillFromDirectory({ stagingDir: staging, version: "1.0.0" }),
      (err) => err instanceof SkillRegistryError
        && /Multi-skill repository/.test(err.message)
        && err.message.includes("alpha-skill")
        && err.message.includes("subdir"),
    );

    // With subdir → imports the chosen skill only
    const skill = addSkillFromDirectory({ stagingDir: staging, version: "1.0.0", subdir: "beta-skill" });
    assert.equal(skill.name, "beta-skill");
    assert.ok(existsSync(join(dataDir, "registry", "skills", "beta-skill", "1.0.0", "SKILL.md")));

    // subdir traversal rejected
    assert.throws(
      () => addSkillFromDirectory({ stagingDir: staging, version: "1.0.1", subdir: "../escape" }),
      /Invalid subdir/,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test("syncSkillsFromGitRepo: whole-repo sync, commit as version, idempotent re-sync, upgrade flow", async () => {
  const { syncSkillsFromGitRepo, getRegistrySkill } = await jiti.import("./skill-registry.ts");

  const repo = mkdtempSync(join(tmpdir(), "pi-skill-gitrepo-"));
  const run = (...args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  try {
    run("init", "-q");
    run("config", "user.email", "t@t");
    run("config", "user.name", "t");
    for (const [name, desc] of [["git-skill-a", "Skill A"], ["git-skill-b", "Skill B"]]) {
      mkdirSync(join(repo, name), { recursive: true });
      writeFileSync(join(repo, name, "SKILL.md"), skillMd(name, desc), "utf8");
    }
    writeFileSync(join(repo, "README.md"), "# repo\n", "utf8");
    run("add", "-A"); run("commit", "-qm", "c1");

    const repoUrl = `file://${repo}`;
    const first = syncSkillsFromGitRepo({ repo: repoUrl, addedBy: "tester" });
    assert.equal(first.added.sort().join(","), "git-skill-a,git-skill-b");
    assert.deepEqual(first.errors, []);
    const version1 = `g${first.commit}`;
    assert.ok(existsSync(join(dataDir, "registry", "skills", "git-skill-a", version1, "SKILL.md")));

    // same commit re-sync → unchanged, no new versions
    const again = syncSkillsFromGitRepo({ repo: repoUrl });
    assert.deepEqual(again.added, []);
    assert.equal(again.unchanged.length, 2);
    const listed = getRegistrySkill("git-skill-a");
    assert.equal(listed.versions.length, 1);

    // new commit → new version for changed skill
    writeFileSync(join(repo, "git-skill-a", "SKILL.md"), skillMd("git-skill-a", "Skill A v2"), "utf8");
    run("add", "-A"); run("commit", "-qm", "c2");
    const second = syncSkillsFromGitRepo({ repo: repoUrl });
    assert.deepEqual(second.updated, ["git-skill-a"]);
    assert.deepEqual(second.unchanged, ["git-skill-b"]);
    const aSkill = getRegistrySkill("git-skill-a");
    assert.equal(aSkill.versions.length, 2);
    assert.ok(aSkill.versions.every((v) => /^g[0-9a-f]{12}$/.test(v.version)));
    assert.ok(aSkill.versions[0].source?.repo.startsWith("file://"));
    assert.deepEqual(aSkill.versions[0].source?.subdir, "git-skill-a");
    // b's content did not change → no duplicate version stored; commit aliased
    const bSkill = getRegistrySkill("git-skill-b");
    assert.equal(bSkill.versions.length, 1);
    assert.equal(bSkill.current, version1);

    // resolveAssignment latest → newest commit wins
    const { resolveAssignment } = await jiti.import("./skill-registry.ts");
    assert.equal(resolveAssignment("git-skill-a@latest", getRegistrySkill("git-skill-a")).version, aSkill.current);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("buildCloneUrl via syncSkillsFromGitRepo: credentials reach git (auth-failed error, not username prompt)", async (t) => {
  const { syncSkillsFromGitRepo, SkillRegistryError } = await jiti.import("./skill-registry.ts");
  // Needs outbound git access; skip instead of failing when offline (CI/
  // sandboxed networks) — connect-failure errors are unrelated to credentials.
  const net = (await import("node:net")).default;
  const reachable = await new Promise((resolve) => {
    const socket = net.connect({ host: "github.com", port: 443, timeout: 4000 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
  if (!reachable) {
    t.skip("github.com unreachable — credential-flow assertion requires outbound git");
    return;
  }
  try {
    syncSkillsFromGitRepo({ repo: "https://github.com/anthropics/nonexistent-repo-xyz", username: "u", password: "p" });
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof SkillRegistryError);
    // Credentials were applied: git reports an auth failure instead of
    // asking for a username interactively.
    assert.match(err.message, /Authentication failed|Invalid username|not found/i);
    // Credentials must not appear in the error text.
    assert.ok(!err.message.includes(":p@"));
  }
});

test("recordGitSyncSource / getLastGitSyncSource round-trip", async () => {
  const { recordGitSyncSource, getLastGitSyncSource, registryRoot } = await jiti.import("./skill-registry.ts");
  rmSync(join(registryRoot(), ".meta.json"), { force: true });
  recordGitSyncSource("https://example.com/team-skills.git", "main", "tester");
  const src = getLastGitSyncSource();
  assert.equal(src.repo, "https://example.com/team-skills.git");
  assert.equal(src.ref, "main");
  assert.ok(src.at);
  assert.equal(src.by, "tester");
});

test("autoUpdateGitSkills: no-source skip", async () => {
  const { autoUpdateGitSkills, registryRoot } = await jiti.import("./skill-registry.ts");
  // Remove any meta left by earlier tests in this file
  rmSync(join(registryRoot(), ".meta.json"), { force: true });
  const result = autoUpdateGitSkills();
  assert.equal(result.skipped, "no-source");
});

test("autoUpdateGitSkills: same-commit replay skips user sync; upgrade triggers user sync", async () => {
  const { recordGitSyncSource, autoUpdateGitSkills, getRegistrySkill } = await jiti.import("./skill-registry.ts");

  const repo = mkdtempSync(join(tmpdir(), "pi-skill-gitrepo-"));
  const name = `auto-skill-${Date.now().toString(36)}`;
  const run = (...args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  try {
    run("init", "-q");
    run("config", "user.email", "t@t");
    run("config", "user.name", "t");
    mkdirSync(join(repo, name), { recursive: true });
    writeFileSync(join(repo, name, "SKILL.md"), skillMd(name, "Auto A"), "utf8");
    run("add", "-A"); run("commit", "-qm", "c1");

    recordGitSyncSource(`file://${repo}`, undefined, "tester");
    const first = autoUpdateGitSkills();
    assert.ok(first.commit, "first pull should land a commit");
    assert.ok(!first.skipped);
    assert.equal(first.added.join(","), name);

    const second = autoUpdateGitSkills();
    assert.equal(second.skipped, "same-commit");

    // New commit → registry changes → usersSynced reported
    writeFileSync(join(repo, name, "SKILL.md"), skillMd(name, "Auto A v2"), "utf8");
    run("add", "-A"); run("commit", "-qm", "c2");
    const third = autoUpdateGitSkills();
    assert.ok(!third.skipped);
    assert.deepEqual(third.updated, [name]);
    assert.equal(third.usersSynced ?? 0, 0, "no users assigned in this test dir");
    assert.equal(getRegistrySkill(name).versions.length, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
