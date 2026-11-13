import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * Per-user skill preferences (FR-4.6).
 *
 * A user may *temporarily* disable an assigned skill without touching the
 * distributed content: the admin's skill registry and the synced files stay
 * exactly as dispatched, and only this user's own sessions stop offering the
 * skill to the model. This is deliberately separate from the project-level
 * `disable-model-invocation` frontmatter (which edits SKILL.md and is a
 * machine-wide / repo-level switch) — user preferences must never leak into
 * the shared files the admin manages.
 *
 * Stored at <agentDir>/skill-prefs.json with 0600 permissions, mirroring
 * secrets.json / the schedules store.
 */

const PREFS_VERSION = 1;
const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/;

interface SkillPrefsFile {
  version: number;
  /** Skill names the user turned off for themselves. */
  disabled: string[];
}

export function userSkillPrefsPath(agentDir: string): string {
  return join(agentDir, "skill-prefs.json");
}

function parsePrefs(raw: unknown): SkillPrefsFile {
  if (!raw || typeof raw !== "object") return { version: PREFS_VERSION, disabled: [] };
  const parsed = raw as { disabled?: unknown };
  const disabled = Array.isArray(parsed.disabled)
    ? parsed.disabled.filter((name): name is string => typeof name === "string" && SKILL_NAME_RE.test(name))
    : [];
  return { version: PREFS_VERSION, disabled };
}

function readPrefsFile(agentDir: string): SkillPrefsFile {
  const path = userSkillPrefsPath(agentDir);
  if (!existsSync(path)) return { version: PREFS_VERSION, disabled: [] };
  try {
    return parsePrefs(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // Fail open: an unreadable prefs file disables nothing.
    return { version: PREFS_VERSION, disabled: [] };
  }
}

/** Skill names this user has temporarily disabled. */
export function readDisabledSkillNames(agentDir: string): Set<string> {
  return new Set(readPrefsFile(agentDir).disabled);
}

export interface SkillPrefStatus {
  name: string;
  disabled: boolean;
}

export async function setSkillDisabled(
  agentDir: string,
  name: string,
  disabled: boolean,
): Promise<SkillPrefStatus> {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`Invalid skill name: ${name}`);
  if (!existsSync(agentDir)) throw new Error(`Agent directory does not exist: ${agentDir}`);
  const path = userSkillPrefsPath(agentDir);
  // proper-lockfile needs the target to exist before locking.
  if (!existsSync(path)) {
    writePrivateFileAtomicSync(path, JSON.stringify({ version: PREFS_VERSION, disabled: [] }, null, 2));
  }
  const release = await lockfile.lock(path, {
    retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 5_000, randomize: true },
    stale: 30_000,
  });
  try {
    const data = readPrefsFile(agentDir);
    const set = new Set(data.disabled);
    if (disabled) set.add(name);
    else set.delete(name);
    data.disabled = [...set].sort();
    writePrivateFileAtomicSync(path, JSON.stringify(data, null, 2));
    return { name, disabled: set.has(name) };
  } finally {
    try { await release(); } catch { /* lock already released */ }
  }
}
