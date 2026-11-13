"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageView } from "./MessageView";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";

/**
 * Read-only transcript viewer for the admin session browser.
 *
 * Deliberately NOT ChatWindow: that component binds to a live RPC session
 * (sending prompts, streaming, forks, compaction). Here the transcript is a
 * frozen read of another user's JSONL, and there is no composer at all — the
 * only affordance is scrolling.
 *
 * Reuses `MessageView`, so user/assistant/tool rendering (markdown, diffs,
 * images, thinking blocks) looks exactly like the real chat.
 */

interface TranscriptContext {
  messages?: AgentMessage[];
  entryIds?: string[];
}

interface SessionDetail {
  sessionId: string;
  info?: { name?: string; cwd?: string; modified?: string; messageCount?: number } | null;
  context?: TranscriptContext;
  owner?: { userId: string; username: string; displayName?: string };
  readOnly?: boolean;
  error?: string;
}

interface Props {
  sessionId: string;
  ownerUserId: string;
  onBack: () => void;
}

export function SessionTranscriptViewer({ sessionId, ownerUserId, onBack }: Props) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(
          `/api/admin/sessions/${encodeURIComponent(sessionId)}?owner=${encodeURIComponent(ownerUserId)}`,
          { cache: "no-store" },
        );
        const data = await response.json() as SessionDetail;
        if (cancelled) return;
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setDetail(data);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, ownerUserId]);

  // Tool results are addressed by toolCallId; MessageView expects them pre-indexed.
  const { messages, entryIds, toolResults } = useMemo(() => {
    const list = detail?.context?.messages ?? [];
    const results = new Map<string, ToolResultMessage>();
    for (const message of list) {
      if (message.role === "toolResult") {
        const id = (message as ToolResultMessage & { toolCallId?: string }).toolCallId;
        if (id) results.set(id, message as ToolResultMessage);
      }
    }
    return { messages: list, entryIds: detail?.context?.entryIds ?? [], toolResults: results };
  }, [detail]);

  const handleOpenSession = useCallback((id: string) => {
    // Subagent/fork links inside a transcript open in this same read-only view
    // (the id belongs to the same owner by construction).
    window.location.href = `/admin/sessions/${encodeURIComponent(id)}?owner=${encodeURIComponent(ownerUserId)}`;
  }, [ownerUserId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
          borderBottom: "1px solid var(--border)", flexShrink: 0, flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            height: 28, padding: "0 10px", borderRadius: 6, cursor: "pointer",
            border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12,
          }}
        >
          ← 返回列表
        </button>
        <strong style={{ fontSize: 13 }}>
          {detail?.info?.name || detail?.sessionId || sessionId}
        </strong>
        {detail?.owner && (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {detail.owner.displayName || detail.owner.username}(@{detail.owner.username})
          </span>
        )}
        <span
          role="status"
          style={{
            fontSize: 11, padding: "2px 8px", borderRadius: 999,
            background: "color-mix(in srgb, #f59e0b 18%, transparent)", color: "#b45309",
          }}
        >
          只读 · 管理员查看
        </span>
        {detail?.info?.cwd && (
          <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{detail.info.cwd}</code>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 0" }}>
        {loading && (
          <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }} role="status">加载中…</div>
        )}
        {error && (
          <div style={{ padding: 24, color: "var(--color-danger, #c0392b)", fontSize: 13 }} role="alert">
            无法打开该会话:{error}
          </div>
        )}
        {!loading && !error && messages.length === 0 && (
          <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>该会话没有可显示的消息。</div>
        )}
        {!loading && !error && messages.map((message, index) => (
          <MessageView
            key={entryIds[index] ?? index}
            message={message}
            toolResults={toolResults}
            cwd={detail?.info?.cwd}
            entryId={entryIds[index]}
            sessionId={sessionId}
            onOpenSession={handleOpenSession}
            showTimestamp={message.role === "assistant"}
          />
        ))}
      </div>
    </div>
  );
}
