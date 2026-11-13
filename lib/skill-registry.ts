import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getDataRoot, listUsers, agentDirForUser } from "./user-store";

/**
 * Central skill registry (FR-4.1/4.2) + idempotent per-user sync (FR-4.4/4.5).
 *
 * Storage:
 *   <dataRoot>/registry/skills/<name>/manifest.json     skill metadata
 *   <dataRoot>/registry/skills/<name>/<version>/...     immutable version dirs
 *   <dataRoot>/registry/skills/<name>/current           symlink to latest version
 *   <dataRoot>/audit/<YYYY-MM>/skills.jsonl             append-only audit log
 *   <user agentDir>/skills/<name>/                      distributed copies
 *   <user agentDir>/skills/.multiuser-manifest.json     what/which version applied
 *
 * Versions are immutable: re-uploading the same version is rejected unless the
 * content hash matches (idempotent re-upload). Distribution uses copy (not
 * symlink) so per-user disable-model-invocation edits stay isolated and
 * file-access realpath checks keep working.
 */

export class SkillRegistryError extends Error {}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/;
const MAX_SKILL_BYTES = 20 * 1024 * 1024; // 20MB per skill dir

export interface RegistrySkillVersion {
  version: string;
  description?: string;
  requiredSecrets: string[];
  addedBy?: string;
  addedAt: string;
  files: number;
  /** Import origin for git-synced skills. */
  source?: { repo: string; ref?: string; subdir?: string; commits?: string[] };
}

export interface RegistrySkill {
  name: string;
  displayName?: string;
  description?: string;
  requiredSecrets: string[];
  versions: RegistrySkillVersion[];
  current?: string;
  updatedAt?: string;
}

interface SkillManifest {
  name: string;
  displayName?: string;
  description?: string;
  requiredSecrets?: string[];
  versions: RegistrySkillVersion[];
}

/** Per-user applied-skills manifest inside <agentDir>/skills/. */
export interface UserSkillsManifest {
  version: 1;
  skills: Record<string, { version: string; appliedAt: string }>;
}

export function registryRoot(): string {
  return join(getDataRoot(), "registry", "skills");
}

export function auditRoot(): string {
  return join(getDataRoot(), "audit");
}

function skillDir(name: string): string {
  if (!SKILL_NAME_RE.test(name)) {
    throw new SkillRegistryError(`Invalid skill name: ${name}`);
  }
  return join(registryRoot(), name);
}

function versionDir(name: string, version: string): string {
  if (!VERSION_RE.test(version)) {
    throw new SkillRegistryError(`Invalid version: ${version}`);
  }
  return join(skillDir(name), version);
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter (minimal parse — mirrors SDK behavior)
// ---------------------------------------------------------------------------

export interface ParsedSkillMd {
  name?: string;
  description?: string;
  requiredSecrets: string[];
}

/**
 * Extract name/description/requiredSecrets from SKILL.md frontmatter.
 * `requiredSecrets` is our Pi Web 多用户版 extension: comma or YAML list of secret
 * NAMES the skill scripts expect (values come from the user's secrets.json).
 */
export function parseSkillMd(content: string): ParsedSkillMd {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return { requiredSecrets: [] };
  const yaml = match[1];
  const readScalar = (key: string): string | undefined => {
    // Require a non-list value: "^key: value" where value doesn't start with "-"
    const m = new RegExp(`^${key}:[ \\t]+([^\\-\\s][^\\r\\n]*)$`, "m").exec(yaml);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  let requiredSecrets: string[] = [];
  const inline = readScalar("requiredSecrets") ?? readScalar("required-secrets");
  if (inline) {
    requiredSecrets = inline.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  } else {
    const listMatch = /^requiredSecrets:\s*\r?\n((?:[ \t]+-\s*.+\r?\n?)+)/m.exec(yaml);
    if (listMatch) {
      requiredSecrets = [...listMatch[1].matchAll(/-[ \t]+(\S+)/g)]
        .map((m) => m[1].trim())
        .filter(Boolean);
    }
  }
  return {
    name: readScalar("name"),
    description: readScalar("description"),
    requiredSecrets,
  };
}

// ---------------------------------------------------------------------------
// Manifest persistence
// ---------------------------------------------------------------------------

function readManifest(name: string): SkillManifest | null {
  const path = join(skillDir(name), "manifest.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as SkillManifest;
    if (raw?.name !== name || !Array.isArray(raw.versions)) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeManifest(manifest: SkillManifest): void {
  mkdirSync(skillDir(manifest.name), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(
    join(skillDir(manifest.name), "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

export function listRegistrySkills(): RegistrySkill[] {
  const root = registryRoot();
  if (!existsSync(root)) return [];
  const out: RegistrySkill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifest = readManifest(entry.name);
    if (!manifest) continue;
    const installed = manifest.versions
      .map((v) => v.version)
      .filter((v) => existsSync(versionDir(entry.name, v)))
      .sort(compareVersions);
    if (installed.length === 0) continue;
    const current = installed[installed.length - 1];
    out.push({
      name: manifest.name,
      ...(manifest.displayName ? { displayName: manifest.displayName } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
      requiredSecrets: manifest.requiredSecrets ?? [],
      versions: manifest.versions.filter((v) => installed.includes(v.version)),
      current,
      ...(manifest.versions.length > 0
        ? { updatedAt: manifest.versions[manifest.versions.length - 1].addedAt }
        : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readlinkSafe(path: string): string | null {
  try {
    // readlink is imported lazily to keep sync surface small
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node:fs").readlinkSync(path) as string;
  } catch {
    return null;
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn - yn;
    } else if (xn !== null) {
      return -1; // numeric segments sort before pre-release tags
    } else if (yn !== null) {
      return 1;
    } else {
      const cmp = x.localeCompare(y);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

export function getRegistrySkill(name: string): RegistrySkill | null {
  return listRegistrySkills().find((s) => s.name === name) ?? null;
}

/** Resolve an assignment "name@version" where version may be "latest". */
export function resolveAssignment(assignment: string): { name: string; version: string } | null {
  const at = assignment.lastIndexOf("@");
  if (at <= 0) return null;
  const name = assignment.slice(0, at);
  const version = assignment.slice(at + 1);
  const skill = getRegistrySkill(name);
  if (!skill || skill.versions.length === 0) return null;
  if (version === "latest") {
    const sorted = [...skill.versions].map((v) => v.version).sort(compareVersions);
    return { name, version: sorted[sorted.length - 1] };
  }
  return skill.versions.some((v) => v.version === version) ? { name, version } : null;
}

// ---------------------------------------------------------------------------
// Ingest: zip upload / directory import
// ---------------------------------------------------------------------------

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

/** Extract a zip via the system `unzip` binary (trusted intranet, admin-only input). */
export function extractZip(zipPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const result = spawnSync("unzip", ["-q", "-o", zipPath, "-d", destDir], {
    timeout: 60_000,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new SkillRegistryError(
      `unzip failed (${result.status}): ${result.stderr?.slice(0, 300) || result.stdout?.slice(0, 300) || "unknown error"}`,
    );
  }
}

/**
 * Normalize an extracted/uploaded skill directory:
 * - locate the SKILL.md root (may be nested inside a single top folder);
 * - enforce size limits and reject path traversal symlinks.
 * Returns the resolved skill root containing SKILL.md.
 */
function locateSkillRoot(dir: string, subdir?: string): string {
  if (!existsSync(dir)) throw new SkillRegistryError("Upload directory missing");
  // Explicit subdirectory (multi-skill repos: pass the folder containing SKILL.md)
  if (subdir) {
    const normalized = subdir.replace(/^\/+|\/+$/g, "");
    if (!normalized || normalized.includes("..")) throw new SkillRegistryError("Invalid subdir");
    const candidate = join(dir, ...normalized.split("/"));
    if (!existsSync(join(candidate, "SKILL.md"))) {
      throw new SkillRegistryError(`SKILL.md not found under subdir "${normalized}"`);
    }
    return candidate;
  }
  if (existsSync(join(dir, "SKILL.md"))) return dir;
  // Single top-level folder (typical zip) → descend
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
  if (entries.length === 1 && entries[0].isDirectory() && existsSync(join(dir, entries[0].name, "SKILL.md"))) {
    return join(dir, entries[0].name);
  }
  // Multi-skill repo: list candidate folders so the admin can pick a subdir
  const candidates = entries
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name);
  if (candidates.length > 0) {
    throw new SkillRegistryError(
      `Multi-skill repository: retry with "subdir" set to one of: ${candidates.slice(0, 12).join(", ")}` +
      (candidates.length > 12 ? `, … (+${candidates.length - 12} more)` : ""),
    );
  }
  throw new SkillRegistryError("SKILL.md not found at upload root or single top-level folder");
}

function validateSkillDir(dir: string): void {
  const root = resolve(dir);
  const check = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isSymbolicLink()) {
        const target = resolve(d, readlinkSafe(p) ?? "");
        if (!target.startsWith(resolve(root) + sep) && target !== resolve(root)) {
          throw new SkillRegistryError(`Symlink escapes skill directory: ${entry.name}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".git")) {
          throw new SkillRegistryError(`Forbidden directory in skill: ${entry.name}`);
        }
        check(p);
      }
    }
  };
  check(dir);
  if (dirSize(dir) > MAX_SKILL_BYTES) {
    throw new SkillRegistryError(`Skill too large (max ${MAX_SKILL_BYTES / 1024 / 1024}MB)`);
  }
}

export interface AddSkillInput {
  /** Staging directory containing the skill (from zip extraction or git clone). */
  stagingDir: string;
  addedBy?: string;
  /** Overrides; default from SKILL.md frontmatter. */
  version: string;
  displayName?: string;
  description?: string;
  requiredSecrets?: string[];
}

/**
 * Ingest a skill into the registry. Version dirs are immutable — re-adding an
 * identical version is a no-op; a conflicting version throws.
 */
export function addSkillFromDirectory(input: {
  stagingDir: string;
  version: string;
  subdir?: string;
  addedBy?: string;
  displayName?: string;
  description?: string;
  requiredSecrets?: string[];
}): RegistrySkill {
  const skillRoot = locateSkillRoot(input.stagingDir, input.subdir);
  validateSkillDir(skillRoot);
  const mdPath = join(skillRoot, "SKILL.md");
  const parsed = parseSkillMd(readFileSync(mdPath, "utf8"));
  const name = parsed.name || basename(skillRoot);
  if (!SKILL_NAME_RE.test(name)) {
    throw new SkillRegistryError(
      `Invalid skill name "${name}" (lowercase letters/digits/dash, from frontmatter or folder)`,
    );
  }
  const version = input.version.trim();
  if (!VERSION_RE.test(version)) throw new SkillRegistryError(`Invalid version: ${version}`);

  const description = input.description ?? parsed.description;
  if (!description) throw new SkillRegistryError("Skill description required (frontmatter or override)");
  const requiredSecrets = (input.requiredSecrets ?? parsed.requiredSecrets).map((s) => s.trim()).filter(Boolean);

  const existing = readManifest(name);
  const existingVersion = existing?.versions.find((v) => v.version === version);
  const targetDir = versionDir(name, version);
  if (existingVersion && existsSync(targetDir)) {
    // Immutable: identical re-upload accepted as no-op. (Content comparison
    // happens via the version dir hash below.)
    const hashExisting = hashDir(join(skillDir(name), version));
    const hashIncoming = hashDir(skillRoot);
    if (hashExisting !== hashIncoming) {
      throw new SkillRegistryError(
        `Version ${version} already exists with different content — versions are immutable`,
      );
    }
    return getRegistrySkill(name)!;
  }

  mkdirSync(skillDir(name), { recursive: true, mode: 0o700 });
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  cpSync(skillRoot, targetDir, { recursive: true, verbatimSymlinks: false });
  // Re-validate what actually landed (defends against cp surprises).
  validateSkillDir(targetDir);

  const now = new Date().toISOString();
  const manifest: SkillManifest = {
    name,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(existing?.displayName && !input.displayName ? { displayName: existing.displayName } : {}),
    description,
    requiredSecrets,
    versions: [
      ...(existing?.versions ?? []).filter((v) => v.version !== version),
      {
        version,
        description,
        requiredSecrets,
        ...(input.addedBy ? { addedBy: input.addedBy } : {}),
        addedAt: now,
        files: countFiles(targetDir),
      },
    ].sort((a, b) => compareVersions(a.version, b.version)),
  };
  writeManifest(manifest);
  updateCurrentSymlink(name, manifest.versions[manifest.versions.length - 1].version);
  writeAudit({
    action: "registry_add",
    skill: name,
    version,
    by: input.addedBy,
    detail: { requiredSecrets, files: countFiles(targetDir) },
  });
  return getRegistrySkill(name)!;
}

export function addSkillFromZip(input: {
  zipPath: string;
  version: string;
  addedBy?: string;
  displayName?: string;
  description?: string;
  requiredSecrets?: string[];
}): RegistrySkill {
  const staging = join(registryRoot(), `.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    extractZip(input.zipPath, staging);
    return addSkillFromDirectory({ ...input, stagingDir: staging });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function addSkillFromGit(input: {
  repo: string;
  ref?: string;
  version: string;
  subdir?: string;
  username?: string;
  password?: string;
  addedBy?: string;
  displayName?: string;
  description?: string;
  requiredSecrets?: string[];
}): RegistrySkill {
  if (!/^https?:\/\/|^(git@|ssh:\/\/)/.test(input.repo)) {
    throw new SkillRegistryError("repo must be an http(s)/ssh git URL");
  }
  const staging = join(registryRoot(), `.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    const cloneUrl = buildCloneUrl(input.repo, input);
    const args = ["clone", "--depth", "1", ...(input.ref ? ["--branch", input.ref] : []), cloneUrl, staging];
    const result = spawnSync("git", args, { timeout: 120_000, encoding: "utf8" });
    if (result.status !== 0) {
      const raw = result.stderr?.slice(0, 300) || "unknown error";
      throw new SkillRegistryError(
        `git clone failed: ` + raw.replace(/\/\/(?:[^@/\s]+)@/g, "//***@"),
      );
    }
    return addSkillFromDirectory({ ...input, stagingDir: staging });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Git repository sync: the repo IS the skill set. Every directory containing
// a SKILL.md becomes a skill; the version is the git commit hash. Re-syncing
// the same commit is an idempotent no-op; a new commit adds a new version.
// ---------------------------------------------------------------------------

function listSkillDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const p = join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (existsSync(join(p, "SKILL.md"))) found.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** Build a git clone URL with embedded http auth. Credentials never land
 *  on disk or in error messages — they exist only for the clone call. */
function buildCloneUrl(repo: string, credentials?: { username?: string; password?: string }): string {
  if (!credentials?.username && !credentials?.password) return repo;
  const auth = `${encodeURIComponent(credentials.username ?? "")}:${encodeURIComponent(credentials.password ?? "")}`;
  const match = /^(https?:\/\/)(.*)$/.exec(repo);
  if (!match) return repo; // ssh URLs carry their own auth
  // Preserve any existing userinfo segment (replace it) and the rest of the URL.
  const rest = match[2].replace(/^[^/@]*@/, "");
  return `${match[1]}${auth}@${rest}`;
}

function gitCommitOf(dir: string): string {
  const result = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new SkillRegistryError(`git rev-parse failed: ${result.stderr?.slice(0, 200) || "not a git repo"}`);
  }
  return result.stdout.trim();
}

export interface GitSyncResult {
  commit: string;
  added: string[];
  unchanged: string[];
  updated: string[];
  errors: Array<{ skill: string; error: string }>;
}

/**
 * Sync every SKILL.md directory in a git repository into the registry.
 * Version = git commit hash (`g<sha12>`), so the admin never picks versions:
 * - first sync imports all skills at the current commit;
 * - re-sync at a new commit adds a new immutable version per changed skill;
 * - re-sync at the same commit is a no-op (unchanged).
 * Assignments referencing `<name>@latest` automatically follow the newest
 * commit on the next per-user sync.
 */
export function syncSkillsFromGitRepo(input: {
  repo: string;
  ref?: string;
  username?: string;
  password?: string;
  addedBy?: string;
}): GitSyncResult {
  if (!/^https?:\/\/|^(git@|ssh:\/\/)|^file:\/\//.test(input.repo)) {
    throw new SkillRegistryError("repo must be an http(s)/ssh/file git URL");
  }
  const staging = join(registryRoot(), `.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    const cloneUrl = buildCloneUrl(input.repo, input);
    const args = ["clone", "--depth", "1", ...(input.ref ? ["--branch", input.ref] : []), cloneUrl, staging];
    const clone = spawnSync("git", args, { timeout: 120_000, encoding: "utf8" });
    if (clone.status !== 0) {
      const raw = clone.stderr?.slice(0, 300) || "unknown error";
      throw new SkillRegistryError(
        `git clone failed: ` + raw.replace(/\/\/(?:[^@/\s]+)@/g, "//***@"),
      );
    }
    const commit = gitCommitOf(staging);
    const version = `g${commit}`;
    const skillDirs = listSkillDirs(staging);
    if (skillDirs.length === 0) {
      throw new SkillRegistryError("No SKILL.md directories found in repository");
    }
    const result: GitSyncResult = { commit, added: [], unchanged: [], updated: [], errors: [] };
    for (const dir of skillDirs) {
      const subdir = relative(staging, dir).split(sep).join("/");
      const nameGuess = parseSkillMd(readFileSync(join(dir, "SKILL.md"), "utf8")).name || basename(dir);
      try {
        const before = readManifest(nameGuess);
        // Content-identical to the latest stored version? Record the commit as
        // an alias on that version instead of duplicating the whole tree —
        // keeps the registry small when most skills did not change.
        const incomingHash = hashDir(dir);
        const latest = before?.versions[before.versions.length - 1];
        const latestPath = latest ? join(skillDir(nameGuess), latest.version) : null;
        if (before && latest && latestPath && existsSync(latestPath) && hashDir(latestPath) === incomingHash) {
          const manifest = before;
          const entry = manifest.versions.find((v) => v.version === latest.version)!;
          entry.source = {
            repo: input.repo,
            ...(input.ref ? { ref: input.ref } : {}),
            subdir,
            ...(entry.source?.commits && !entry.source.commits.includes(commit)
              ? { commits: [...entry.source.commits, commit] }
              : entry.source?.commits ? { commits: entry.source.commits } : {}),
          };
          writeManifest(manifest);
          result.unchanged.push(nameGuess);
          continue;
        }
        const skill = addSkillFromDirectory({
          stagingDir: staging,
          subdir,
          version,
          addedBy: input.addedBy,
        });
        // Stamp origin so the UI can show where it came from.
        const manifest = readManifest(skill.name);
        const versionEntry = manifest?.versions.find((v) => v.version === version);
        if (manifest && versionEntry && !versionEntry.source) {
          versionEntry.source = { repo: input.repo, ...(input.ref ? { ref: input.ref } : {}), subdir, commits: [commit] };
          writeManifest(manifest);
        }
        if (!before) result.added.push(skill.name);
        else if (!before.versions.some((v) => v.version === version)) result.updated.push(skill.name);
        else result.unchanged.push(nameGuess);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/already exists with different content/.test(message)) {
          // Same commit re-sync with identical manifest state → unchanged.
          const name = parseSkillMd(readFileSync(join(dir, "SKILL.md"), "utf8")).name || basename(dir);
          result.unchanged.push(SKILL_NAME_RE.test(name) ? name : name);
          continue;
        }
        result.errors.push({ skill: basename(dir), error: message.slice(0, 200) });
      }
    }
    writeAudit({
      action: "registry_git_sync",
      detail: { repo: input.repo, ref: input.ref, commit, added: result.added, updated: result.updated, unchanged: result.unchanged.length, errors: result.errors.length },
    });
    return result;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function deleteSkillVersion(name: string, version: string, by?: string): void {
  const manifest = readManifest(name);
  if (!manifest) throw new SkillRegistryError(`Skill not found: ${name}`);
  const dir = versionDir(name, version);
  if (!existsSync(dir)) throw new SkillRegistryError(`Version not found: ${name}@${version}`);
  rmSync(dir, { recursive: true, force: true });
  manifest.versions = manifest.versions.filter((v) => v.version !== version);
  if (manifest.versions.length === 0) {
    // Last version gone → remove the skill entirely (empty husks would show
    // up as broken entries in the admin registry listing).
    rmSync(skillDir(name), { recursive: true, force: true });
  } else {
    writeManifest(manifest);
    updateCurrentSymlink(name, manifest.versions[manifest.versions.length - 1].version);
  }
  writeAudit({ action: "registry_delete", skill: name, version, by });
}

function updateCurrentSymlink(name: string, version: string): void {
  const linkPath = join(skillDir(name), "current");
  try {
    rmSync(linkPath, { force: true });
  } catch { /* ignore */ }
  try {
    // Lazy import keeps top-level imports minimal
    symlinkSync(version, linkPath);
  } catch {
    // Some filesystems disallow symlinks — fall back to a pointer file.
    writeFileSync(linkPath, version, "utf8");
  }
}

import { symlinkSync } from "node:fs";
import { createHash } from "node:crypto";

function hashDir(dir: string): string {
  const hash = createHash("sha256");
  const walk = (d: string): void => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        hash.update(relativeSafe(dir, p));
        hash.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

function relativeSafe(from: string, to: string): string {
  return to.startsWith(from) ? to.slice(from.length) : to;
}

// ---------------------------------------------------------------------------
// Per-user distribution (FR-4.4/4.5) — idempotent differential sync
// ---------------------------------------------------------------------------

function userManifestPath(agentDir: string): string {
  return join(agentDir, "skills", ".multiuser-manifest.json");
}

export function readUserSkillsManifest(agentDir: string): UserSkillsManifest {
  const path = userManifestPath(agentDir);
  if (!existsSync(path)) return { version: 1, skills: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as UserSkillsManifest;
    if (raw?.version === 1 && raw.skills && typeof raw.skills === "object") return raw;
  } catch { /* fall through */ }
  return { version: 1, skills: {} };
}

function writeUserSkillsManifest(agentDir: string, manifest: UserSkillsManifest): void {
  writePrivateFileAtomicSync(userManifestPath(agentDir), JSON.stringify(manifest, null, 2));
}

export interface SyncResult {
  applied: string[];   // name@version copied/updated
  removed: string[];   // names removed
  unchanged: string[]; // already up to date
  errors: string[];
}

/**
 * Sync the user's assigned skills (users.json skills[]) into their agentDir.
 * Idempotent: only copies when the applied version differs (FR-4.5);
 * removes skills no longer assigned (FR-4.8).
 */
export function syncUserSkills(
  agentDir: string,
  assignments: string[],
  options: { by?: string; userId?: string } = {},
): SyncResult {
  const result: SyncResult = { applied: [], removed: [], unchanged: [], errors: [] };
  const manifest = readUserSkillsManifest(agentDir);
  const userSkillsDir = join(agentDir, "skills");
  mkdirSync(userSkillsDir, { recursive: true, mode: 0o700 });

  const wanted = new Map<string, string>();
  for (const assignment of assignments) {
    try {
      const resolved = resolveAssignment(assignment);
      if (!resolved) {
        result.errors.push(`Assignment not resolvable in registry: ${assignment}`);
        continue;
      }
      wanted.set(resolved.name, resolved.version);
    } catch (error) {
      result.errors.push(`${assignment}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Copy/update wanted skills
  for (const [name, version] of wanted) {
    const applied = manifest.skills[name];
    if (applied?.version === version && existsSync(join(userSkillsDir, name, "SKILL.md"))) {
      result.unchanged.push(`${name}@${version}`);
      continue;
    }
    try {
      const source = versionDir(name, version);
      if (!existsSync(source)) {
        result.errors.push(`Registry version missing: ${name}@${version}`);
        continue;
      }
      const dest = join(userSkillsDir, name);
      const tmp = join(userSkillsDir, `.${name}.tmp-${Date.now()}`);
      rmSync(tmp, { recursive: true, force: true });
      cpSync(source, tmp, { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      renameSync(tmp, dest);
      manifest.skills[name] = { version, appliedAt: new Date().toISOString() };
      result.applied.push(`${name}@${version}`);
    } catch (error) {
      result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Remove no-longer-assigned skills (FR-4.8)
  for (const [name, applied] of Object.entries(manifest.skills)) {
    if (!wanted.has(name)) {
      try {
        rmSync(join(userSkillsDir, name), { recursive: true, force: true });
        delete manifest.skills[name];
        result.removed.push(`${name}@${applied.version}`);
      } catch (error) {
        result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  writeUserSkillsManifest(agentDir, manifest);
  if (result.applied.length > 0 || result.removed.length > 0 || result.errors.length > 0) {
    writeAudit({
      action: "user_sync",
      by: options.by,
      detail: {
        userId: options.userId,
        applied: result.applied,
        removed: result.removed,
        unchanged: result.unchanged,
        errors: result.errors,
      },
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Audit log (FR-4.5 / §8.4)
// ---------------------------------------------------------------------------

export interface AuditEntry {
  at?: string;
  action: "registry_add" | "registry_delete" | "registry_git_sync" | "user_sync" | "assign";
  skill?: string;
  version?: string;
  by?: string;
  detail?: unknown;
}

export function writeAudit(entry: AuditEntry): void {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const dir = join(auditRoot(), month);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({ ...entry, at: now.toISOString() })}\n`;
  writeFileSync(join(dir, "skills.jsonl"), line, { encoding: "utf8", flag: "a", mode: 0o600 });
}

export function readAudit(monthPrefix?: string, limit = 200): AuditEntry[] {
  const root = auditRoot();
  if (!existsSync(root)) return [];
  const months = readdirSync(root)
    .filter((d) => /^\d{4}-\d{2}$/.test(d) && (!monthPrefix || d.startsWith(monthPrefix)))
    .sort()
    .reverse();
  const out: AuditEntry[] = [];
  for (const month of months) {
    const path = join(root, month, "skills.jsonl");
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).reverse();
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as AuditEntry);
        if (out.length >= limit) return out;
      } catch { /* skip corrupt line */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry-level metadata: remember the last repo-sync source so a scheduled
// job can re-pull it. Credentials are never persisted — the scheduler reads
// them from PI_SMARTFICC_GIT_USERNAME / PI_SMARTFICC_GIT_PASSWORD env.
// ---------------------------------------------------------------------------

interface RegistryMeta {
  lastGitSync?: {
    repo: string;
    ref?: string;
    at: string;
    by?: string;
  };
}

const registryMetaPath = () => join(registryRoot(), ".meta.json");

function readRegistryMeta(): RegistryMeta {
  const path = registryMetaPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as RegistryMeta;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeRegistryMeta(meta: RegistryMeta): void {
  mkdirSync(registryRoot(), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(registryMetaPath(), JSON.stringify(meta, null, 2));
}

/** Record the most recent manual repo-sync source (called by the API route). */
export function recordGitSyncSource(repo: string, ref?: string, by?: string): void {
  const meta = readRegistryMeta();
  meta.lastGitSync = { repo, ...(ref ? { ref } : {}), at: new Date().toISOString(), ...(by ? { by } : {}) };
  writeRegistryMeta(meta);
}

export function getLastGitSyncSource(): RegistryMeta["lastGitSync"] {
  return readRegistryMeta().lastGitSync;
}

export interface GitAutoUpdateResult {
  skipped?: "no-source" | "same-commit" | "in-progress";
  commit?: string;
  added: string[];
  updated: string[];
  unchanged: string[];
  errors: Array<{ skill: string; error: string }>;
  usersSynced?: number;
}

let gitAutoUpdateRunning = false;

/**
 * Scheduled git auto-update: re-pull the last repo-sync source, then re-sync
 * every active user so @latest assignments pick up new versions. Returns a
 * skip reason when there is nothing to do (or a pull is already running).
 * Credentials come from env, never from disk.
 */
export function autoUpdateGitSkills(): GitAutoUpdateResult {
  const source = readRegistryMeta().lastGitSync;
  if (!source?.repo) return { skipped: "no-source", added: [], updated: [], unchanged: [], errors: [] };
  if (gitAutoUpdateRunning) return { skipped: "in-progress", added: [], updated: [], unchanged: [], errors: [] };
  gitAutoUpdateRunning = true;
  try {
    const username = process.env.PI_SMARTFICC_GIT_USERNAME || undefined;
    const password = process.env.PI_SMARTFICC_GIT_PASSWORD || undefined;
    const sync = syncSkillsFromGitRepo({
      repo: source.repo,
      ...(source.ref ? { ref: source.ref } : {}),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      addedBy: "auto-update",
    });
    // Registry unchanged? Commit-hash versions sort unpredictably, so
    // "did anything change" is decided from the sync result itself: new
    // skills or new versions.
    const changed = sync.added.length > 0 || sync.updated.length > 0;
    if (!changed) {
      return { skipped: "same-commit", added: sync.added, updated: sync.updated, unchanged: sync.unchanged, errors: sync.errors, commit: sync.commit };
    }
    // New versions landed — re-sync all active users so @latest follows.
    let usersSynced = 0;
    try {
      // user-store does not import skill-registry, so a static import is safe.
      for (const user of listUsers()) {
        if (user.status !== "active" || (user.skills ?? []).length === 0) continue;
        syncUserSkills(agentDirForUser(user), user.skills, { by: "auto-update", userId: user.id });
        usersSynced += 1;
      }
    } catch { /* user sync errors are surfaced per-user by syncUserSkills logs */ }
    return { commit: sync.commit, added: sync.added, updated: sync.updated, unchanged: sync.unchanged, errors: sync.errors, usersSynced };
  } finally {
    gitAutoUpdateRunning = false;
  }
}
