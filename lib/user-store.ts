import { randomBytes, randomUUID, scrypt as scryptCb } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * User account store for Pi Web 多用户版 multi-user pi-web.
 *
 * Accounts live in <dataRoot>/users.json. The file is the single source of
 * truth for credentials, roles, and skill assignments. Multi-user is the only
 * supported mode: there is no single-user deployment behind a flag any more, so
 * every request is authenticated and every worker is sandboxed.
 *
 * `isMultiUserEnabled()` survives only as "is the account store readable", for
 * UI hints and bootstrap. It is NOT a security switch — requireAuth() and the
 * sandbox never consult it to decide whether to enforce.
 */

export type UserRole = "admin" | "user";

export interface StoredUser {
  id: string;
  username: string;
  displayName?: string;
  role: UserRole;
  tenantId: string;
  passwordHash: string;
  status: "active" | "disabled";
  /** Assigned skills: "<name>@<version>" where version may be "latest". */
  skills: string[];
  /**
   * When true this account adopts the machine's legacy single-user agentDir
   * (`~/.pi/agent`) instead of `<dataRoot>/users/<username>`. Used by the
   * built-in admin so upgrading an existing single-user deployment keeps all
   * sessions/credentials/skills in place with no data migration (FR-6.1).
   */
  adoptGlobalAgentDir?: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * Last time this account authenticated (FR-1.4: 最近活跃时间). Updated on
   * successful credential verification, throttled so a busy user does not
   * rewrite users.json on every request. Absent for accounts that never logged
   * in since the field was introduced.
   */
  lastActiveAt?: string;
}

export interface UserStoreData {
  version: 1;
  users: StoredUser[];
}

export class UserStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserStoreError";
  }
}

export function getDataRoot(): string {
  return process.env.PI_WEB_DATA_DIR?.trim()
    || join(process.env.HOME || process.cwd(), ".pi-web-multiuser");
}

export function getUsersFilePath(): string {
  return join(getDataRoot(), "users.json");
}

export function resolveUserAgentDir(username: string, options: { adoptGlobal?: boolean } = {}): string {
  // An account that adopts the legacy global dir keeps its data where the
  // single-user product left it — no copy, no move (FR-6.1).
  if (options.adoptGlobal) return getAgentDir();
  // Directory names use the USERNAME (product decision: users never see or
  // type the internal id). Same charset as the username rule, so the path is
  // always a single safe segment.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/.test(username)) {
    throw new UserStoreError(`Invalid username: ${username}`);
  }
  return join(getDataRoot(), "users", username);
}

/** agentDir for a stored account, honoring the legacy-dir adoption flag. */
export function agentDirForUser(user: Pick<StoredUser, "username" | "adoptGlobalAgentDir">): string {
  return resolveUserAgentDir(user.username, { adoptGlobal: user.adoptGlobalAgentDir === true });
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, no external dependencies)
// ---------------------------------------------------------------------------

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLength: 32 };

function scrypt(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLength, { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_PARAMS.keyLength);
  return `$scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$").filter(Boolean);
  // Format: scrypt$N$r$p$saltB64$hashB64
  if (parts[0] !== "scrypt" || parts.length !== 6) return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  try {
    const salt = Buffer.from(parts[4]!, "base64");
    const expected = Buffer.from(parts[5]!, "base64");
    const actual = await new Promise<Buffer>((resolve, reject) => {
      scryptCb(password, salt, expected.length, { N, r, p }, (err, key) => {
        if (err) reject(err);
        else resolve(key);
      });
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Store read/write (locked, atomic)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeUser(raw: unknown): StoredUser | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  const username = typeof raw.username === "string" ? raw.username : "";
  const passwordHash = typeof raw.passwordHash === "string" ? raw.passwordHash : "";
  if (!id || !username || !passwordHash) return null;
  const role = raw.role === "admin" ? "admin" : "user";
  const status = raw.status === "disabled" ? "disabled" : "active";
  const skills = Array.isArray(raw.skills)
    ? raw.skills.filter((s): s is string => typeof s === "string")
    : [];
  return {
    id,
    username,
    ...(typeof raw.displayName === "string" && raw.displayName ? { displayName: raw.displayName } : {}),
    role,
    tenantId: typeof raw.tenantId === "string" && raw.tenantId ? raw.tenantId : "t_default",
    passwordHash,
    status,
    skills,
    ...(raw.adoptGlobalAgentDir === true ? { adoptGlobalAgentDir: true } : {}),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    ...(typeof raw.lastActiveAt === "string" && raw.lastActiveAt ? { lastActiveAt: raw.lastActiveAt } : {}),
  };
}

export function readUserStore(): UserStoreData {
  const path = getUsersFilePath();
  if (!existsSync(path)) return { version: 1, users: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Fail closed: an unreadable/corrupt store means no users can authenticate.
    return { version: 1, users: [] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.users)) return { version: 1, users: [] };
  return { version: 1, users: parsed.users.map(sanitizeUser).filter((u): u is StoredUser => u !== null) };
}

// Small helper: users.json is read frequently (every request); keep a short-TTL
// cache on globalThis to avoid re-reading + re-hashing per request.
declare global {
  var __piUserStoreCache: { data: UserStoreData; ts: number } | undefined;
}

const USER_STORE_TTL_MS = 5_000;

export function readUserStoreCached(): UserStoreData {
  const now = Date.now();
  const cached = globalThis.__piUserStoreCache;
  if (cached && now - cached.ts < USER_STORE_TTL_MS) return cached.data;
  const data = readUserStore();
  globalThis.__piUserStoreCache = { data, ts: now };
  return data;
}

export function invalidateUserStoreCache(): void {
  globalThis.__piUserStoreCache = undefined;
  // Any account mutation (disable, role change, password reset) must also drop the
  // per-request auth cache so it takes effect immediately, not after its TTL
  // (FR-1.3 / FR-2.2: disabled users are rejected on their very next request).
  // The cache lives on globalThis, so we clear it without importing user-auth
  // (which would create a circular dependency).
  (globalThis as { __piAuthCache?: Map<string, unknown> }).__piAuthCache?.clear();
}

async function updateUserStore(
  update: (data: UserStoreData) => { result: unknown; changed: boolean },
): Promise<unknown> {
  const path = getUsersFilePath();
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  // proper-lockfile resolves the target path and fails with ENOENT when the
  // store file does not exist yet; seed an empty store before locking.
  if (!existsSync(path)) writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, users: [] }, null, 2));

  const release = await lockfile.lock(path, {
    retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 5_000, randomize: true },
    stale: 30_000,
  });
  try {
    const data = readUserStore();
    const { result, changed } = update(data);
    if (changed) {
      writePrivateFileAtomicSync(path, JSON.stringify(data, null, 2));
    }
    invalidateUserStoreCache();
    return result;
  } finally {
    try { await release(); } catch { /* lock already released */ }
  }
}

// ---------------------------------------------------------------------------
// Public account operations
// ---------------------------------------------------------------------------

/**
 * Whether the account store currently holds any account.
 *
 * Advisory only (UI hints, bootstrap decisions). Never used to decide whether
 * to authenticate or sandbox — both are unconditional.
 */
export function isMultiUserEnabled(): boolean {
  return readUserStoreCached().users.length > 0;
}

export async function createUser(input: {
  username: string;
  password: string;
  role?: UserRole;
  displayName?: string;
  /**
   * Adopt the machine's legacy single-user agentDir (`~/.pi/agent`) as this
   * account's data home. Reserved for the built-in admin (FR-6.1).
   */
  adoptGlobalAgentDir?: boolean;
  /** Tenant this account belongs to (FR-4.3 tenant-wide assignment). */
  tenantId?: string;
}): Promise<StoredUser> {
  const username = input.username.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/.test(username)) {
    throw new UserStoreError("Username must be 2-32 chars: letters, digits, dot, dash, underscore");
  }
  if (input.password.length < 8) throw new UserStoreError("Password must be at least 8 characters");
  const role = input.role ?? "user";
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(input.password);
  const user: StoredUser = {
    id: `u_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    username,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    role,
    tenantId: input.tenantId?.trim() || "t_default",
    passwordHash,
    status: "active",
    skills: [],
    ...(input.adoptGlobalAgentDir ? { adoptGlobalAgentDir: true } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await updateUserStore((data) => {
    if (data.users.some((u) => u.username === username)) {
      throw new UserStoreError(`User already exists: ${username}`);
    }
    data.users.push(user);
    return { result: user, changed: true };
  });
  ensureUserDir(user.username, {
    displayName: input.displayName,
    username: user.username,
    tenantId: user.tenantId,
    adoptGlobalAgentDir: user.adoptGlobalAgentDir,
  });
  return user;
}

export function findUserByUsername(username: string): StoredUser | undefined {
  return readUserStoreCached().users.find((u) => u.username === username);
}

export function findUserById(id: string): StoredUser | undefined {
  return readUserStoreCached().users.find((u) => u.id === id);
}

export async function verifyUserCredentials(username: string, password: string): Promise<StoredUser | null> {
  const user = findUserByUsername(username);
  if (!user || user.status !== "active") return null;
  const ok = await verifyPasswordHash(password, user.passwordHash);
  return ok ? user : null;
}

export async function updatePassword(userId: string, newPassword: string): Promise<void> {
  if (newPassword.length < 8) throw new UserStoreError("Password must be at least 8 characters");
  const passwordHash = await hashPassword(newPassword);
  await updateUserStore((data) => {
    const user = data.users.find((u) => u.id === userId);
    if (!user) throw new UserStoreError("User not found");
    user.passwordHash = passwordHash;
    user.updatedAt = new Date().toISOString();
    return { result: undefined, changed: true };
  });
}

export async function setUserStatus(userId: string, status: "active" | "disabled"): Promise<void> {
  await updateUserStore((data) => {
    const user = data.users.find((u) => u.id === userId);
    if (!user) throw new UserStoreError("User not found");
    user.status = status;
    user.updatedAt = new Date().toISOString();
    return { result: undefined, changed: true };
  });
}

export async function setUserRole(userId: string, role: UserRole): Promise<void> {
  await updateUserStore((data) => {
    const user = data.users.find((u) => u.id === userId);
    if (!user) throw new UserStoreError("User not found");
    user.role = role;
    user.updatedAt = new Date().toISOString();
    return { result: undefined, changed: true };
  });
}

export async function setUserSkills(userId: string, skills: string[]): Promise<void> {
  for (const skill of skills) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9.]+$/.test(skill)) {
      throw new UserStoreError(`Invalid skill assignment format (expected name@version): ${skill}`);
    }
  }
  await updateUserStore((data) => {
    const user = data.users.find((u) => u.id === userId);
    if (!user) throw new UserStoreError("User not found");
    user.skills = [...skills];
    user.updatedAt = new Date().toISOString();
    return { result: undefined, changed: true };
  });
}

export function listUsers(): StoredUser[] {
  return readUserStoreCached().users;
}

// ---------------------------------------------------------------------------
// Last-active tracking (FR-1.4)
// ---------------------------------------------------------------------------

/**
 * How long a verified login is allowed to suppress the next store write. The
 * list page only needs minute-level accuracy, and users.json is small but
 * contended; without this a chatty client would rewrite it continuously.
 */
const LAST_ACTIVE_THROTTLE_MS = 60_000;

declare global {
  var __piUserLastActiveTouched: Map<string, number> | undefined;
}

function lastActiveTouchedAt(): Map<string, number> {
  if (!globalThis.__piUserLastActiveTouched) globalThis.__piUserLastActiveTouched = new Map();
  return globalThis.__piUserLastActiveTouched;
}

/**
 * Record that an account just authenticated. Best-effort and throttled: callers
 * fire-and-forget (`void touchUserActivity(id)`), so a failed write must never
 * affect request handling. Tests await the returned promise.
 */
export async function touchUserActivity(userId: string, now = Date.now()): Promise<void> {
  const last = lastActiveTouchedAt().get(userId) ?? 0;
  if (now - last < LAST_ACTIVE_THROTTLE_MS) return;
  lastActiveTouchedAt().set(userId, now);
  try {
    await updateUserStore((data) => {
      const user = data.users.find((u) => u.id === userId);
      if (!user) return { result: undefined, changed: false };
      user.lastActiveAt = new Date(now).toISOString();
      // Activity is not a profile edit; leave updatedAt as the account-mutation
      // clock so "recently changed" semantics stay intact.
      return { result: undefined, changed: true };
    });
  } catch {
    // A concurrent write or a race with deletion must not surface as an auth
    // failure — the next successful login will try again.
  }
}

/** Test helper: forget throttle state so the next touch always writes. */
export function resetLastActiveThrottle(): void {
  globalThis.__piUserLastActiveTouched = undefined;
}

// ---------------------------------------------------------------------------
// Built-in admin bootstrap (FR-6.1 / FR-6.2)
// ---------------------------------------------------------------------------

/** Username of the account that owns the legacy single-user data. */
export const BUILTIN_ADMIN_USERNAME = "admin";
/** Optional env var supplying the built-in admin's initial password. */
export const BUILTIN_ADMIN_PASSWORD_ENV = "PI_SMARTFICC_ADMIN_PASSWORD";

export interface BootstrapAdminResult {
  created: boolean;
  user?: StoredUser;
  /** Present when created: the generated password (only if not env-provided). */
  generatedPassword?: string;
  reason?: string;
}

/**
 * Ensure the machine has a built-in admin when multi-user mode is on.
 *
 * FR-6.1: after upgrading a single-user deployment, the pre-existing data
 * under the global agentDir (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`) belongs
 * to this admin. We do that by making the admin *adopt* the global agentDir
 * (`adoptGlobalAgentDir`) rather than copying anything — sessions, provider
 * credentials, models, MCP config and skills stay exactly where they were, and
 * the admin sees the same data it saw before the upgrade.
 *
 * Idempotent: returns without doing anything once any admin exists.
 */
export async function bootstrapBuiltinAdmin(): Promise<BootstrapAdminResult> {
  const existing = readUserStore().users;
  if (existing.some((u) => u.role === "admin")) {
    return { created: false, reason: "an admin account already exists" };
  }
  if (existing.some((u) => u.username === BUILTIN_ADMIN_USERNAME)) {
    return { created: false, reason: `username "${BUILTIN_ADMIN_USERNAME}" is taken by a non-admin account` };
  }

  const envPassword = process.env[BUILTIN_ADMIN_PASSWORD_ENV]?.trim();
  const generatedPassword = envPassword ? undefined : randomBytes(18).toString("base64url");
  const user = await createUser({
    username: BUILTIN_ADMIN_USERNAME,
    password: envPassword || generatedPassword!,
    role: "admin",
    displayName: "管理员",
    adoptGlobalAgentDir: true,
  });

  console.log(
    `[bootstrap] created built-in admin "${BUILTIN_ADMIN_USERNAME}" adopting ${agentDirForUser(user)} (FR-6.1)`,
  );
  if (generatedPassword) {
    console.log(
      `[bootstrap] generated admin password (set it with ${BUILTIN_ADMIN_PASSWORD_ENV} to choose your own):\n` +
      `           ${generatedPassword}\n` +
      `           Change it after the first login (Settings → Account).`,
    );
  }
  return { created: true, user, ...(generatedPassword ? { generatedPassword } : {}) };
}

// ---------------------------------------------------------------------------
// Per-user directory bootstrap
// ---------------------------------------------------------------------------

/** Files copied from the seed dir into a new user's agentDir. */
const SEED_CONFIG_FILES = ["models.json", "auth.json", "settings.json"] as const;

function isEmptyJsonObject(filePath: string): boolean {
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return true;
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    // Unreadable/malformed → treat as absent so the user gets working defaults.
    return true;
  }
}

/** Best-effort seed of shared model config into a user agentDir (FR-3.7). */
function seedSharedUserConfig(agentDir: string): void {
  const seedDir = process.env.PI_SMARTFICC_USER_SEED_DIR?.trim() || getAgentDir();
  if (!existsSync(seedDir)) return;
  for (const name of SEED_CONFIG_FILES) {
    const source = join(seedDir, name);
    const target = join(agentDir, name);
    if (!existsSync(source)) continue;
    if (existsSync(target) && !isEmptyJsonObject(target)) continue;
    try {
      const contents = readFileSync(source);
      writeFileSync(target, contents, { mode: 0o600 });
    } catch {
      // Seeding is best-effort: a failure must not block user creation.
    }
  }
}

export function ensureUserDir(
  username: string,
  options: {
    displayName?: string;
    username?: string;
    tenantId?: string;
    adoptGlobalAgentDir?: boolean;
  } = {},
): string {
  const agentDir = resolveUserAgentDir(username, { adoptGlobal: options.adoptGlobalAgentDir === true });
  for (const sub of ["", "skills", "sessions"]) {
    const dir = sub ? join(agentDir, sub) : agentDir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // An account adopting the legacy global dir must keep that directory
  // byte-for-byte as the single-user product left it: no seeding, no injected
  // APPEND_SYSTEM.md — anything else would change pre-upgrade behavior, which
  // FR-6.1 forbids.
  if (options.adoptGlobalAgentDir) return agentDir;
  // Seed shared model/provider config so a freshly created user can start
  // chatting immediately (FR-3.7). Sources, in priority order:
  //   1. PI_SMARTFICC_USER_SEED_DIR (explicit admin-provided template dir)
  //   2. the host agentDir (~/.pi/agent) — the machine's configured defaults
  // Existing non-empty files always win (users may customize per account).
  seedSharedUserConfig(agentDir);

  // Seed the per-user APPEND_SYSTEM.md template (FR-3.6); never overwrite a
  // user-edited file. Deliberately IDENTITY-FREE: the current user's name,
  // role and tenant are injected fresh each turn by the persona extension, so
  // a snapshot here would drift (stale display name, old path layout, ...).
  const appendSystemPath = join(agentDir, "APPEND_SYSTEM.md");
  if (!existsSync(appendSystemPath)) {
    const template = [
      "# 个人偏好",
      "",
      "- (可自行补充:回复语言偏好、常用口径说明、关注的区域/行业等)",
      "",
    ].join("\n");
    writeFileSync(appendSystemPath, template, { encoding: "utf8", mode: 0o600 });
  }
  return agentDir;
}
