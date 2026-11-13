// Audit trail for admin access to other users' sessions.
//
// Reading a colleague's conversation is a privileged action in a regulated
// deployment, so every catalogue open and every transcript view is recorded.
// Kept separate from the skill audit log (skills.jsonl) so the two can be
// retained/reviewed independently.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataRoot } from "./user-store";

export interface SessionAccessAuditEntry {
  /** Admin who looked. */
  actor: string;
  /** Account whose sessions were accessed; absent for a whole-catalogue view. */
  target?: string;
  /** Session id, for a single transcript view. */
  sessionId?: string;
  /** "list" for the catalogue, "view" for one transcript. */
  action: "list" | "view";
  /** Tenant filter applied, when the listing was scoped. */
  tenantId?: string;
}

export function sessionAccessAuditPath(now = new Date()): string {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return join(getDataRoot(), "audit", month, "session-access.jsonl");
}

/**
 * Append one entry. Best-effort by design: an audit write must never make an
 * admin's read fail, but it is also never silently skipped when it can work.
 */
export function recordSessionAccess(entry: SessionAccessAuditEntry, now = new Date()): void {
  const path = sessionAccessAuditPath(now);
  try {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify({ ...entry, at: now.toISOString() })}\n`;
    writeFileSync(path, line, { encoding: "utf8", flag: "a", mode: 0o600 });
  } catch (error) {
    console.warn(
      `[audit] failed to record session access: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
