"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminSessionCatalogue, AdminSessionOwner } from "@/lib/admin-sessions";
import { SessionTranscriptViewer } from "./SessionTranscriptViewer";

/**
 * Admin session browser: every user → their cwds → their sessions.
 *
 * Read-only by construction: the only actions are expand/collapse, filter and
 * open a transcript. Nothing here can send, fork, rename or delete, and no
 * worker is started — the catalogue comes from scanning each user's own
 * sessions tree on disk.
 */

function formatWhen(iso: string | undefined): string {
  if (!iso) return "从未";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "从未";
  const diffMin = Math.floor((Date.now() - ms) / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString();
}

function shortCwd(cwd: string): string {
  // Show the trailing two segments: enough to recognise, short enough to scan.
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join("/")}`;
}

interface Props {
  /** Initial tenant scope; "" means every user. */
  tenantId?: string;
}

export function AdminSessionsPanel({ tenantId: initialTenant = "" }: Props) {
  const [catalogue, setCatalogue] = useState<AdminSessionCatalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tenant, setTenant] = useState(initialTenant);
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());
  const [expandedCwds, setExpandedCwds] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<{ sessionId: string; ownerUserId: string } | null>(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (force) params.set("force", "1");
      if (tenant.trim()) params.set("tenantId", tenant.trim());
      const response = await fetch(`/api/admin/sessions${params.size ? `?${params}` : ""}`, { cache: "no-store" });
      const data = await response.json() as AdminSessionCatalogue & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setCatalogue(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [tenant]);

  useEffect(() => { void load(); }, [load]);

  const visibleOwners = useMemo(() => {
    const owners = catalogue?.owners ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return owners;
    // Match the person (name/username) or any of their session names.
    return owners.filter((owner) => {
      if (owner.username.toLowerCase().includes(needle)) return true;
      if (owner.displayName?.toLowerCase().includes(needle)) return true;
      return owner.groups.some((group) =>
        group.sessions.some((session) =>
          (session.name ?? "").toLowerCase().includes(needle)
          || session.firstMessage.toLowerCase().includes(needle),
        ),
      );
    });
  }, [catalogue, search]);

  const toggleUser = (userId: string) => {
    setExpandedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  };

  const toggleCwd = (key: string) => {
    setExpandedCwds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  if (open) {
    return (
      <SessionTranscriptViewer
        sessionId={open.sessionId}
        ownerUserId={open.ownerUserId}
        onBack={() => setOpen(null)}
      />
    );
  }

  const expandAll = () => {
    setExpandedUsers(new Set(visibleOwners.map((o) => o.userId)));
    setExpandedCwds(new Set(visibleOwners.flatMap((o) =>
      o.groups.map((g) => `${o.userId}::${g.cwd}`))));
  };
  const collapseAll = () => {
    setExpandedUsers(new Set());
    setExpandedCwds(new Set());
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Toolbar */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", flexWrap: "wrap", borderBottom: "1px solid var(--border)" }}>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索用户或会话…"
          aria-label="搜索用户或会话"
          style={{
            flex: "1 1 180px", minWidth: 140, height: 30, padding: "0 9px",
            border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)",
            color: "var(--text)", fontSize: 12, outline: "none",
          }}
        />
        <input
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
          placeholder="租户(留空=全部)"
          aria-label="租户筛选"
          style={{
            width: 150, height: 30, padding: "0 9px", border: "1px solid var(--border)",
            borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
          }}
        />
        <button type="button" onClick={() => void load(true)} disabled={loading} style={buttonStyle}>
          {loading ? "扫描中…" : "刷新"}
        </button>
        <button type="button" onClick={expandAll} style={buttonStyle}>展开全部</button>
        <button type="button" onClick={collapseAll} style={buttonStyle}>收起全部</button>
      </div>

      {error && (
        <div role="alert" style={{ padding: "10px 12px", color: "var(--color-danger, #c0392b)", fontSize: 12 }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {loading && !catalogue && (
          <div role="status" style={{ padding: 20, fontSize: 12, color: "var(--text-muted)" }}>
            正在扫描所有用户的会话…
          </div>
        )}
        {!loading && visibleOwners.every((o) => o.totals.sessions === 0) && (
          <div style={{ padding: 20, fontSize: 12, color: "var(--text-muted)" }}>
            没有匹配的会话。
          </div>
        )}

        {visibleOwners.map((owner) => (
          <UserRow
            key={owner.userId}
            owner={owner}
            expanded={expandedUsers.has(owner.userId)}
            onToggle={() => toggleUser(owner.userId)}
            expandedCwds={expandedCwds}
            onToggleCwd={toggleCwd}
            onOpenSession={(sessionId) => setOpen({ sessionId, ownerUserId: owner.userId })}
            search={search}
          />
        ))}
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  height: 30, padding: "0 10px", borderRadius: 6, fontSize: 12, cursor: "pointer",
  border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)",
};

function UserRow({
  owner, expanded, onToggle, expandedCwds, onToggleCwd, onOpenSession, search,
}: {
  owner: AdminSessionOwner;
  expanded: boolean;
  onToggle: () => void;
  expandedCwds: Set<string>;
  onToggleCwd: (key: string) => void;
  onOpenSession: (sessionId: string) => void;
  search: string;
}) {
  const needle = search.trim().toLowerCase();
  return (
    <div style={{ marginBottom: 2 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: "flex", width: "100%", alignItems: "center", gap: 8,
          padding: "8px 14px", background: "none", border: "none",
          color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 13,
        }}
      >
        <span style={{ color: "var(--text-muted)", flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}>▸</span>
        <strong>{owner.displayName || owner.username}</strong>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>@{owner.username}</span>
        {owner.role === "admin" && <Tag color="#6366f1">管理员</Tag>}
        {owner.status === "disabled" && <Tag color="#c0392b">已禁用</Tag>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {owner.totals.cwds} 个目录 · {owner.totals.sessions} 个会话 · 活跃 {formatWhen(owner.lastActiveAt)}
        </span>
      </button>

      {expanded && (
        <div style={{ paddingLeft: 14 }}>
          {owner.groups.length === 0 && (
            <div style={{ padding: "4px 0 8px", fontSize: 12, color: "var(--text-muted)" }}>该用户还没有会话。</div>
          )}
          {owner.groups.map((group) => {
            const key = `${owner.userId}::${group.cwd}`;
            const cwdExpanded = expandedCwds.has(key);
            return (
              <div key={key}>
                <button
                  type="button"
                  onClick={() => onToggleCwd(key)}
                  aria-expanded={cwdExpanded}
                  title={group.cwd}
                  style={{
                    display: "flex", width: "100%", alignItems: "center", gap: 8,
                    padding: "5px 10px", background: "none", border: "none",
                    color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 12,
                  }}
                >
                  <span style={{ flexShrink: 0, transform: cwdExpanded ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}>▸</span>
                  <code style={{ fontSize: 12, color: "var(--text)" }}>{shortCwd(group.cwd)}</code>
                  <span style={{ flex: 1 }} />
                  <span>{group.sessions.length} 个会话</span>
                </button>
                {cwdExpanded && (
                  <div style={{ paddingLeft: 18 }}>
                    {group.sessions.map((session) => {
                      const title = session.name || session.firstMessage || session.id;
                      const hit = needle && title.toLowerCase().includes(needle);
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => onOpenSession(session.id)}
                          title={session.id}
                          style={{
                            display: "flex", width: "100%", alignItems: "center", gap: 8,
                            padding: "5px 10px", background: "none", border: "none",
                            color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12,
                            ...(hit ? { background: "color-mix(in srgb, var(--accent, #6366f1) 12%, transparent)" } : {}),
                          }}
                        >
                          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {title}
                          </span>
                          {session.origin === "fork" && <Tag color="#0ea5e9">分叉</Tag>}
                          {session.subagentCount > 0 && <Tag color="#8b5cf6">{session.subagentCount} 子代理</Tag>}
                          <span style={{ color: "var(--text-muted)", fontSize: 11, flexShrink: 0 }}>
                            {session.messageCount} 条 · {formatWhen(session.modified)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 10, padding: "1px 6px", borderRadius: 999, flexShrink: 0,
      background: `color-mix(in srgb, ${color} 16%, transparent)`, color,
    }}>
      {children}
    </span>
  );
}
