"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Account & secrets management for multi-user mode (FR-3.5 / FR-6):
 * - change own password
 * - set/unset runtime secrets (names only ever come back; values are
 *   write-only) — skill-required secrets are listed with a hint and
 *   highlighted until configured.
 */

interface MeResponse {
  multiUser?: boolean;
  user?: { userId: string; username: string; displayName?: string; role: string };
  requiredSecrets?: Array<{ name: string; configured: boolean }>;
}

interface SecretStatus {
  name: string;
  configured: boolean;
  updatedAt?: string;
}

interface AssignedSkill {
  name: string;
  assignedVersion: string;
  effectiveVersion?: string;
  displayName?: string;
  description?: string;
  requiredSecrets: string[];
  disabled: boolean;
}

export function AccountConfig() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // password form
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNext, setPwNext] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

  // secret entry: name → draft value
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [savingSecret, setSavingSecret] = useState<string | null>(null);

  // FR-4.6: assigned skills + per-user temporary disable
  const [assignedSkills, setAssignedSkills] = useState<AssignedSkill[]>([]);
  const [togglingSkill, setTogglingSkill] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [meRes, secretsRes, skillsRes] = await Promise.all([
        fetch("/api/user/me", { cache: "no-store" }),
        fetch("/api/user/secrets", { cache: "no-store" }),
        fetch("/api/user/skills", { cache: "no-store" }),
      ]);
      const meData = await meRes.json() as MeResponse;
      const secretData = await secretsRes.json() as { secrets?: SecretStatus[] };
      const skillData = await skillsRes.json() as { skills?: AssignedSkill[] };
      setMe(meData);
      setSecrets(secretData.secrets ?? []);
      setAssignedSkills(skillData.skills ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loaded && me && me.multiUser === false) {
    // Single-user mode: no per-user accounts/secrets surface.
    return null;
  }

  const required = me?.requiredSecrets ?? [];
  const requiredByName = new Map(required.map((s) => [s.name, s.configured]));
  const allNames = [...new Set([...required.map((s) => s.name), ...secrets.map((s) => s.name)])].sort();
  const configuredSet = new Set(secrets.filter((s) => s.configured).map((s) => s.name));
  const missingRequired = required.filter((s) => !s.configured);

  const changePassword = async () => {
    setPwSaving(true); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/user/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: pwCurrent, newPassword: pwNext }),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNotice("密码已修改");
      setPwOpen(false); setPwCurrent(""); setPwNext("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPwSaving(false);
    }
  };

  const saveSecret = async (name: string, value: string) => {
    setSavingSecret(name); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/user/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, value: value || null }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNotice(value ? `密钥 ${name} 已保存` : `密钥 ${name} 已删除`);
      setDrafts((d) => { const n = { ...d }; delete n[name]; return n; });
      if (name === newSecretName) { setNewSecretName(""); setNewSecretValue(""); }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSecret(null);
    }
  };

  const toggleSkill = async (skill: AssignedSkill) => {
    const next = !skill.disabled;
    setTogglingSkill(skill.name); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/user/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: skill.name, disabled: next }),
      });
      const data = await res.json() as { ok?: boolean; skill?: { disabled: boolean }; error?: string };
      if (!res.ok || data.error || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAssignedSkills((prev) =>
        prev.map((s) => (s.name === skill.name ? { ...s, disabled: data.skill?.disabled ?? next } : s)),
      );
      setNotice(next ? `技能 ${skill.name} 已为你停用` : `技能 ${skill.name} 已重新启用`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTogglingSkill(null);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", minWidth: 0, height: 32, padding: "0 9px",
    border: "1px solid var(--border)", borderRadius: 5,
    background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
  };
  const buttonStyle: React.CSSProperties = {
    height: 30, padding: "0 12px", borderRadius: 6, fontSize: 12, cursor: "pointer",
    border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)",
  };
  const primaryStyle: React.CSSProperties = { ...buttonStyle, background: "var(--accent, #6366f1)", color: "#fff", borderColor: "transparent" };

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">账号与密钥</h3>
      <p className="settings-general-description">
        {me?.user ? `${me.user.displayName || me.user.username}(@${me.user.username})` : ""} — 密钥以环境变量形式注入你运行中的技能与命令,值保存在服务器上但不会再显示。
      </p>

      {notice && <p role="status" style={{ color: "#15803d", fontSize: 12, margin: "4px 0" }}>{notice}</p>}
      {error && <p role="alert" style={{ color: "var(--color-danger, #c0392b)", fontSize: 12, margin: "4px 0" }}>{error}</p>}

      <div style={{ margin: "8px 0" }}>
        {pwOpen ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input style={{ ...inputStyle, width: 150 }} type="password" placeholder="当前密码" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} autoComplete="current-password" />
            <input style={{ ...inputStyle, width: 150 }} type="password" placeholder="新密码(≥8位)" value={pwNext} onChange={(e) => setPwNext(e.target.value)} autoComplete="new-password" />
            <button type="button" style={primaryStyle} disabled={pwSaving || pwNext.length < 8} onClick={() => void changePassword()}>保存</button>
            <button type="button" style={buttonStyle} onClick={() => { setPwOpen(false); setPwCurrent(""); setPwNext(""); }}>取消</button>
          </div>
        ) : (
          <button type="button" style={buttonStyle} onClick={() => setPwOpen(true)}>修改密码…</button>
        )}
      </div>

      {missingRequired.length > 0 && (
        <p style={{ color: "#b45309", fontSize: 12, margin: "4px 0" }}>
          ⚠ 以下技能所需密钥尚未配置: {missingRequired.map((s) => s.name).join(", ")}
        </p>
      )}

      <div style={{ fontSize: 12, fontWeight: 600, margin: "10px 0 4px" }}>运行时密钥</div>
      {loaded && allNames.length === 0 && (
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "4px 0" }}>
          暂无密钥需求 — 分配的技能需要密钥时会出现在这里(如 RY_TOKEN)。
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {allNames.map((name) => {
          const configured = configuredSet.has(name);
          const requiredConfigured = requiredByName.get(name);
          const isDraft = Boolean(drafts[name]);
          return (
            <div key={name} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code style={{ fontSize: 12, width: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
                {name}
                {requiredConfigured !== undefined && (
                  <span style={{ marginLeft: 6, fontSize: 11, color: "#b45309" }}>(技能需要)</span>
                )}
              </code>
              <span style={{ fontSize: 11, color: configured ? "#15803d" : "var(--text-muted)", width: 56 }}>
                {configured ? "已设置" : "未设置"}
              </span>
              <input
                style={{ ...inputStyle, flex: "1 1 180px" }}
                type="password"
                placeholder={configured ? "留空保持不变" : "输入值"}
                value={drafts[name] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [name]: e.target.value }))}
                autoComplete="off"
              />
              <button
                type="button"
                style={primaryStyle}
                disabled={!isDraft || savingSecret === name}
                onClick={() => void saveSecret(name, drafts[name] ?? "")}
              >
                {savingSecret === name ? "…" : "保存"}
              </button>
              {configured && (
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={savingSecret === name}
                  onClick={() => void saveSecret(name, "")}
                  title="删除该密钥"
                >
                  删除
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
        <input style={{ ...inputStyle, width: 180 }} placeholder="新密钥名(如 RY_TOKEN)" value={newSecretName} onChange={(e) => setNewSecretName(e.target.value)} autoComplete="off" />
        <input style={{ ...inputStyle, flex: "1 1 180px" }} type="password" placeholder="值" value={newSecretValue} onChange={(e) => setNewSecretValue(e.target.value)} autoComplete="off" />
        <button
          type="button"
          style={primaryStyle}
          disabled={!newSecretName.trim() || !newSecretValue || savingSecret !== null}
          onClick={() => void saveSecret(newSecretName.trim(), newSecretValue)}
        >
          添加
        </button>
      </div>

      <div style={{ fontSize: 12, fontWeight: 600, margin: "16px 0 4px" }}>分配给我的技能</div>
      {loaded && assignedSkills.length === 0 && (
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "4px 0" }}>
          暂无分配给你的技能 — 管理员下发后会出现在这里。
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {assignedSkills.map((skill) => {
          const disabled = skill.disabled;
          const version = skill.effectiveVersion ?? skill.assignedVersion;
          return (
            <div key={skill.name} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <code style={{ fontSize: 12, width: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
                {skill.displayName || skill.name}
              </code>
              <span style={{ fontSize: 11, color: "var(--text-muted)", width: 110 }} title={skill.assignedVersion}>
                v{version.slice(0, 8)}
                {skill.effectiveVersion && skill.effectiveVersion !== skill.assignedVersion ? "(未同步)" : ""}
              </span>
              <span style={{ fontSize: 11, color: disabled ? "var(--text-muted)" : "#15803d", flex: "1 1 120px" }}>
                {disabled ? "已停用(仅对你)" : "已启用"}
              </span>
              <button
                type="button"
                style={buttonStyle}
                disabled={togglingSkill === skill.name}
                onClick={() => void toggleSkill(skill)}
                title={disabled ? "重新启用该技能" : "临时停用该技能(不影响分发内容)"}
              >
                {togglingSkill === skill.name ? "…" : disabled ? "启用" : "停用"}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
