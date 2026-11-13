"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ScheduledTaskView, ScheduledTasksResponse } from "@/lib/api-types";
import {
  ConfigButton,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigField,
  ConfigPanelShell,
  ConfigSidebar,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
} from "./SettingsUi";

/**
 * Settings → Scheduled tasks (FR-7).
 *
 * Two things a user needs here: which tasks exist and when they next run, and
 * what each past run actually did. The second is why every run starts its own
 * session — the transcript *is* the answer, so the history list links straight
 * into it rather than summarising it.
 *
 * Tasks are per-user; the server scopes them to the caller's agentDir, so this
 * component never sends a user id.
 */

interface Props {
  embedded: boolean;
  onClose: () => void;
}

/** Format an instant for display, falling back to the raw string on a bad value. */
function formatInstant(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString(locale === "zh-CN" || locale === "zh-TW" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SchedulesConfig({ embedded, onClose }: Props) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<ScheduledTasksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/scheduled-tasks", { cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const next = await response.json() as ScheduledTasksResponse;
      setData(next);
      setError(null);
      // Keep a valid selection so the detail pane never goes blank after a
      // delete or a refresh.
      setSelectedId((current) => {
        if (current && next.tasks.some((task) => task.id === current)) return current;
        return next.tasks[0]?.id ?? null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  const patchTask = useCallback(async (id: string, patch: Record<string, unknown>) => {
    setBusyId(id);
    setNotice(null);
    try {
      const response = await fetch(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      await load();
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : String(patchError));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const removeTask = useCallback(async (id: string) => {
    setBusyId(id);
    setNotice(null);
    try {
      const response = await fetch(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const runNow = useCallback(async (id: string) => {
    setBusyId(id);
    setNotice(null);
    try {
      const response = await fetch(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      setNotice(t("schedules.runStarted"));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusyId(null);
    }
  }, [t]);

  /** Localized description of a structured schedule spec. */
  const describe = useCallback((task: ScheduledTaskView): string => {
    const spec = task.schedule;
    const weekdayNames = [
      t("schedules.weekday.0"), t("schedules.weekday.1"), t("schedules.weekday.2"),
      t("schedules.weekday.3"), t("schedules.weekday.4"), t("schedules.weekday.5"),
      t("schedules.weekday.6"),
    ];
    switch (spec.kind) {
      case "once":
        return t("schedules.kind.once", { at: formatInstant(spec.at ?? null, locale) ?? "" });
      case "daily":
        return t("schedules.kind.daily", { time: spec.time ?? "", timezone: spec.timezone });
      case "weekly":
        return t("schedules.kind.weekly", {
          weekday: weekdayNames[spec.weekday ?? 0] ?? String(spec.weekday),
          time: spec.time ?? "",
          timezone: spec.timezone,
        });
      case "monthly":
        return t("schedules.kind.monthly", {
          day: String(spec.day ?? 1),
          time: spec.time ?? "",
          timezone: spec.timezone,
        });
      default:
        return task.describes;
    }
  }, [t, locale]);

  const statusLabel = useCallback((status: string): string => {
    switch (status) {
      case "ok": return t("schedules.status.ok");
      case "error": return t("schedules.status.error");
      case "skipped": return t("schedules.status.skipped");
      case "timeout": return t("schedules.status.timeout");
      default: return status;
    }
  }, [t]);

  /** Opens the transcript of a run in the main chat view. */
  const openTranscript = useCallback((sessionId: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("session", sessionId);
    url.searchParams.delete("cwd");
    window.location.href = url.toString();
  }, []);

  const body = (
    <ConfigSplitView>
      <ConfigSidebar>
        {data && !data.perUser ? (
          <div className="config-sidebar-message">{t("schedules.multiUserOnly")}</div>
        ) : tasks.length === 0 ? (
          <div className="config-sidebar-message is-empty">{t("schedules.empty")}</div>
        ) : (
          <ConfigSidebarList>
            {tasks.map((task) => (
              <ConfigSidebarItem
                key={task.id}
                active={task.id === selectedId}
                onClick={() => setSelectedId(task.id)}
              >
                <ConfigStatusDot active={task.enabled} color={task.enabled ? "#34d399" : undefined} />
                <ConfigSidebarText className="is-grow">
                  <span className="schedules-sidebar-title">{task.title}</span>
                  <span className="schedules-sidebar-meta">{describe(task)}</span>
                </ConfigSidebarText>
              </ConfigSidebarItem>
            ))}
          </ConfigSidebarList>
        )}
        <div className="schedules-sidebar-hint">{t("schedules.createdInChat")}</div>
      </ConfigSidebar>

      <div className="config-detail">
        {error && <div className="config-sidebar-message is-error">{error}</div>}
        {notice && <div className="config-sidebar-message">{notice}</div>}
        {!selected ? (
          <ConfigEmptyState>
            {data && !data.perUser ? t("schedules.multiUserOnly") : t("schedules.selectHint")}
          </ConfigEmptyState>
        ) : (
          <ConfigDetailStack>
            <div className="config-detail-header">
              <div className="config-detail-header-info">
                <span className="config-detail-title">{selected.title}</span>
              </div>
              <div className="config-detail-actions">
                <ConfigSwitch
                  checked={selected.enabled}
                  loading={busyId === selected.id}
                  label={t("schedules.enabled")}
                  onChange={(checked) => void patchTask(selected.id, { enabled: checked })}
                />
                <ConfigButton
                  size="small"
                  disabled={busyId === selected.id || !selected.enabled}
                  onClick={() => void runNow(selected.id)}
                >
                  {t("schedules.runNow")}
                </ConfigButton>
                <ConfigButton
                  variant="danger"
                  size="small"
                  disabled={busyId === selected.id}
                  onClick={() => void removeTask(selected.id)}
                >
                  {t("schedules.delete")}
                </ConfigButton>
              </div>
            </div>

            <ConfigField label={t("schedules.schedule")}>{describe(selected)}</ConfigField>
            <ConfigField label={t("schedules.nextRun")}>
              {selected.enabled
                ? formatInstant(selected.nextRunAt, locale) ?? t("schedules.notScheduled")
                : t("schedules.paused")}
            </ConfigField>
            {selected.cwd && (
              <ConfigField label={t("schedules.workingDir")}>
                <code className="config-detail-path">{selected.cwd}</code>
              </ConfigField>
            )}
            <ConfigField label={t("schedules.prompt")}>
              <pre className="schedules-prompt">{selected.prompt}</pre>
            </ConfigField>

            <div className="schedules-history">
              <div className="schedules-history-title">{t("schedules.history")}</div>
              {selected.runs.length === 0 ? (
                <div className="config-sidebar-message is-empty">{t("schedules.noRuns")}</div>
              ) : (
                <ul className="schedules-run-list">
                  {selected.runs.map((run, index) => (
                    <li key={`${run.at}-${index}`} className="schedules-run-item">
                      <ConfigStatusDot
                        active={run.status === "ok"}
                        color={run.status === "ok" ? "#34d399" : "#f87171"}
                      />
                      <span className="schedules-run-time">{formatInstant(run.at, locale)}</span>
                      <span className={`schedules-run-status is-${run.status}`}>
                        {statusLabel(run.status)}
                      </span>
                      {run.sessionId ? (
                        <button
                          type="button"
                          className="schedules-run-link"
                          onClick={() => openTranscript(run.sessionId!)}
                          title={run.sessionId}
                        >
                          {t("schedules.viewConversation")}
                        </button>
                      ) : (
                        <span className="schedules-run-time dim">{t("schedules.noTranscript")}</span>
                      )}
                      {run.error && <span className="schedules-run-error">{run.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </ConfigDetailStack>
        )}
      </div>
    </ConfigSplitView>
  );

  if (!embedded) {
    return (
      <ConfigPanelShell
        embedded={false}
        title={t("schedules.title")}
        onClose={onClose}
        closeLabel={t("i18n.close")}
      >
        {body}
      </ConfigPanelShell>
    );
  }
  return <div className="schedules-embedded">{body}</div>;
}
