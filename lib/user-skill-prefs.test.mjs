// FR-4.6 — per-user temporary skill disables: the prefs store and the
// in-memory skills override that hides disabled skills from the model prompt.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });

function tmpAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-skill-prefs-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const skill = (name, disableModelInvocation = false) => ({
  name,
  description: `${name} desc`,
  filePath: `/x/${name}/SKILL.md`,
  baseDir: `/x/${name}`,
  sourceInfo: {},
  disableModelInvocation,
});

test("setSkillDisabled persists 0600 and round-trips", async () => {
  const { dir, cleanup } = tmpAgentDir();
  try {
    const prefs = await jiti.import("@/lib/user-skill-prefs.ts");
    assert.equal(prefs.readDisabledSkillNames(dir).size, 0);
    await prefs.setSkillDisabled(dir, "ruiyan", true);
    await prefs.setSkillDisabled(dir, "bond", true);
    assert.deepEqual([...prefs.readDisabledSkillNames(dir)].sort(), ["bond", "ruiyan"]);
    assert.equal(statSync(prefs.userSkillPrefsPath(dir)).mode & 0o777, 0o600);
    assert.match(readFileSync(prefs.userSkillPrefsPath(dir), "utf8"), /ruiyan/);

    await prefs.setSkillDisabled(dir, "ruiyan", false);
    assert.deepEqual([...prefs.readDisabledSkillNames(dir)], ["bond"]);

    await assert.rejects(() => prefs.setSkillDisabled(dir, "bad name", true), /Invalid skill name/);
  } finally {
    cleanup();
  }
});

test("userSkillsOverride hides user-disabled skills from the prompt, in memory only", async () => {
  const { dir, cleanup } = tmpAgentDir();
  try {
    const prefs = await jiti.import("@/lib/user-skill-prefs.ts");
    const { userSkillsOverride } = await jiti.import("@/lib/user-skill-filter.ts");

    // No preference → undefined so the SDK loader keeps its default behavior.
    assert.equal(userSkillsOverride(dir), undefined);

    await prefs.setSkillDisabled(dir, "ruiyan", true);
    const override = userSkillsOverride(dir);
    assert.equal(typeof override, "function");

    const base = { skills: [skill("ruiyan"), skill("bond"), skill("off", true)], diagnostics: [] };
    const result = override(base);
    const byName = new Map(result.skills.map((s) => [s.name, s]));
    assert.equal(byName.get("ruiyan").disableModelInvocation, true, "user-disabled forced hidden");
    assert.equal(byName.get("bond").disableModelInvocation, false, "others untouched");
    assert.equal(byName.get("off").disableModelInvocation, true, "already-disabled stays");
    // The base array is not mutated.
    assert.equal(base.skills[0].disableModelInvocation, false);
  } finally {
    cleanup();
  }
});
