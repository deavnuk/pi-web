import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * Per-user runtime secrets for skills and scripts (FR-3.5).
 *
 * Stored at <agentDir>/secrets.json with 0600 permissions. Values never leave
 * the server: the API reports only names + configured booleans, and the
 * user-secrets extension injects values into bash command environments
 * per-session (never process.env in the main process).
 */

const SECRETS_VERSION = 1;

export interface StoredSecret {
  value: string;
  updatedAt: string;
}

interface SecretsFile {
  version: number;
  secrets: Record<string, StoredSecret>;
}

export interface UserSecretStatus {
  name: string;
  configured: boolean;
  updatedAt?: string;
}

export function userSecretsPath(agentDir: string): string {
  return join(agentDir, "secrets.json");
}

function parseSecretsFile(raw: unknown): SecretsFile {
  if (!raw || typeof raw !== "object") return { version: SECRETS_VERSION, secrets: {} };
  const parsed = raw as { version?: unknown; secrets?: unknown };
  if (!parsed.secrets || typeof parsed.secrets !== "object") {
    return { version: SECRETS_VERSION, secrets: {} };
  }
  const secrets: Record<string, StoredSecret> = {};
  for (const [name, entry] of Object.entries(parsed.secrets as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { value, updatedAt } = entry as { value?: unknown; updatedAt?: unknown };
    if (typeof value !== "string") continue;
    secrets[name] = {
      value,
      updatedAt: typeof updatedAt === "string" ? updatedAt : new Date().toISOString(),
    };
  }
  return { version: SECRETS_VERSION, secrets };
}

function readSecretsFile(agentDir: string): SecretsFile {
  const path = userSecretsPath(agentDir);
  if (!existsSync(path)) return { version: SECRETS_VERSION, secrets: {} };
  try {
    return parseSecretsFile(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // Fail closed: an unreadable secrets file means no secrets are injected.
    return { version: SECRETS_VERSION, secrets: {} };
  }
}

function isValidSecretName(name: string): boolean {
  // Environment-variable-safe names only (injected into bash command env).
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 128;
}

/** Names + configured flags only — values never leave this module. */
export function listUserSecretStatuses(agentDir: string): UserSecretStatus[] {
  const { secrets } = readSecretsFile(agentDir);
  return Object.entries(secrets)
    .map(([name, entry]) => ({
      name,
      configured: Boolean(entry.value),
      ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Env form for per-command injection: { NAME: value }. */
export function readUserSecretsEnv(agentDir: string): Record<string, string> {
  const { secrets } = readSecretsFile(agentDir);
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(secrets)) {
    if (isValidSecretName(name) && entry.value) env[name] = entry.value;
  }
  return env;
}

export async function setUserSecret(
  agentDir: string,
  name: string,
  value: string | null,
): Promise<UserSecretStatus> {
  if (!isValidSecretName(name)) {
    throw new Error(`Invalid secret name: ${name}`);
  }
  const path = userSecretsPath(agentDir);
  if (!existsSync(agentDir)) {
    throw new Error(`Agent directory does not exist: ${agentDir}`);
  }
  // proper-lockfile resolves the target path and fails with ENOENT when the
  // secrets file does not exist yet; seed it before locking.
  if (!existsSync(path)) writePrivateFileAtomicSync(path, JSON.stringify({ version: SECRETS_VERSION, secrets: {} }, null, 2));
  const release = await lockfile.lock(path, {
    retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 5_000, randomize: true },
    stale: 30_000,
  });
  try {
    const data = readSecretsFile(agentDir);
    if (value === null || value === "") {
      delete data.secrets[name];
    } else {
      data.secrets[name] = { value, updatedAt: new Date().toISOString() };
    }
    writePrivateFileAtomicSync(path, JSON.stringify(data, null, 2));
    return { name, configured: Boolean(data.secrets[name]), ...(data.secrets[name]?.updatedAt ? { updatedAt: data.secrets[name]!.updatedAt } : {}) };
  } finally {
    try { await release(); } catch { /* lock already released */ }
  }
}
