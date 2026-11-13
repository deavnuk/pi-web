// Admin-wide session catalogue (view-only).
//
// Lets an administrator see every user's sessions, grouped user → cwd →
// session. This is a *read* surface: nothing here starts a worker, touches a
// live RPC session, or writes to another user's agentDir.
//
// Design notes:
// - Sessions are scanned per user with the existing `listAllSessions()`
//   machinery (same 30s TTL cache + in-flight dedupe), so an admin view costs
//   one scan per user rather than a new index.
// - Subagent sessions are folded into their parent's family; otherwise a busy
//   user's tree turns into thousands of rows that mean nothing on their own.
// - `attachSessionProjectInfo()` is deliberately skipped: it shells out to git
//   once per cwd, and grouping here is by cwd, so projectRoot would be paid for
//   and never read.
// - No running-state probing: that lives in each user's worker process and
//   querying it would spawn workers just to answer a page render.
import { agentDirForUser, listUsers, type StoredUser, type UserRole } from "./user-store";
import { listAllSessions, listSessionSummaries } from "./session-reader";
import { listSessionFamilies } from "./session-family";
import type { SessionInfo } from "./types";

export interface AdminSessionRow {
  id: string;
  name?: string;
  firstMessage: string;
  created: string;
  modified: string;
  messageCount: number;
  /** Subagent sessions folded into this row. */
  subagentCount: number;
  /** Kind marker so the UI can show a fork/subagent origin without opening it. */
  origin?: "fork";
}

export interface AdminCwdGroup {
  cwd: string;
  /** Newest activity in this group, for ordering and display. */
  latestModified: string;
  sessions: AdminSessionRow[];
}

export interface AdminSessionOwner {
  userId: string;
  username: string;
  displayName?: string;
  role: UserRole;
  tenantId: string;
  status: "active" | "disabled";
  /** Last successful authentication (FR-1.4), when known. */
  lastActiveAt?: string;
  groups: AdminCwdGroup[];
  totals: { cwds: number; sessions: number };
}

export interface AdminSessionCatalogue {
  owners: AdminSessionOwner[];
  /** How many owners were scanned (including ones with no sessions). */
  scannedUsers: number;
  /** True when only header/stat metadata was read (summary mode). */
  summary: boolean;
  /** The tenant filter that was applied, if any. */
  tenantId?: string;
}

export interface CollectAdminSessionsOptions {
  /** Bypass the per-agentDir scan cache. */
  force?: boolean;
  /**
   * Limit the catalogue to one tenant. Omitted means every user, which is the
   * product decision for this deployment (a single-tenant install sees no
   * difference).
   */
  tenantId?: string;
  /** Serve cheap header/stat rows first; a later call hydrates the details. */
  summary?: boolean;
}

function rowOf(root: SessionInfo, subagentCount: number): AdminSessionRow {
  return {
    id: root.id,
    ...(root.name ? { name: root.name } : {}),
    firstMessage: root.firstMessage,
    created: root.created,
    modified: root.modified,
    messageCount: root.messageCount,
    subagentCount,
    ...(root.relation?.kind === "fork" ? { origin: "fork" as const } : {}),
  };
}

function timeOf(iso: string | undefined): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** Fold a flat session list into cwd → session groups, newest activity first. */
export function groupSessionsByCwd(sessions: readonly SessionInfo[]): AdminCwdGroup[] {
  // Families keep a subagent's transcript from becoming its own top-level row.
  const families = listSessionFamilies(sessions);
  const byCwd = new Map<string, AdminCwdGroup>();

  for (const family of families) {
    const cwd = family.root.cwd || "(unknown)";
    let group = byCwd.get(cwd);
    if (!group) {
      group = { cwd, latestModified: family.latestModified, sessions: [] };
      byCwd.set(cwd, group);
    }
    if (timeOf(family.latestModified) > timeOf(group.latestModified)) {
      group.latestModified = family.latestModified;
    }
    group.sessions.push(rowOf(family.root, family.subagents.length));
  }

  const groups = [...byCwd.values()];
  for (const group of groups) {
    group.sessions.sort((a, b) => timeOf(b.modified) - timeOf(a.modified) || a.id.localeCompare(b.id));
  }
  groups.sort((a, b) => timeOf(b.latestModified) - timeOf(a.latestModified) || a.cwd.localeCompare(b.cwd));
  return groups;
}

function ownerOf(user: StoredUser, groups: AdminCwdGroup[]): AdminSessionOwner {
  return {
    userId: user.id,
    username: user.username,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    role: user.role,
    tenantId: user.tenantId,
    status: user.status,
    ...(user.lastActiveAt ? { lastActiveAt: user.lastActiveAt } : {}),
    groups,
    totals: {
      cwds: groups.length,
      sessions: groups.reduce((n, group) => n + group.sessions.length, 0),
    },
  };
}

/**
 * Collect every (selected) user's sessions.
 *
 * Users are scanned concurrently; a single unreadable agentDir must not blank
 * the whole catalogue, so those users simply come back empty.
 */
export async function collectAdminSessions(
  options: CollectAdminSessionsOptions = {},
): Promise<AdminSessionCatalogue> {
  const users = listUsers().filter((user) => !options.tenantId || user.tenantId === options.tenantId);

  const perUser = await Promise.all(users.map(async (user) => {
    const agentDir = agentDirForUser(user);
    try {
      const sessions = options.summary
        ? await listSessionSummaries({ agentDir })
        : await listAllSessions({ ...(options.force ? { force: true } : {}), agentDir });
      return { user, groups: groupSessionsByCwd(sessions) };
    } catch {
      return { user, groups: [] as AdminCwdGroup[] };
    }
  }));

  const owners = perUser.map(({ user, groups }) => ownerOf(user, groups));
  // Everyone is listed (an admin needs to see the people with zero sessions
  // too), ordered by recent activity and then by username for stability.
  owners.sort((a, b) => timeOf(b.lastActiveAt) - timeOf(a.lastActiveAt) || a.username.localeCompare(b.username));

  return {
    owners,
    scannedUsers: users.length,
    summary: options.summary === true,
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
  };
}
