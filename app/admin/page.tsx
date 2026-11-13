"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigDetailTitle,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSectionTitle,
  ConfigStatusDot,
  ConfigSwitch,
  ConfigSplitView,
} from "@/components/SettingsUi";
import { AdminSessionsPanel } from "@/components/AdminSessionsPanel";
import { I18nProvider } from "@/hooks/useI18n";

interface AdminUser {
  id: string;
  username: string;
  displayName?: string;
  role: "admin" | "user";
  tenantId: string;
  status: "active" | "disabled";
  skills: string[];
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
}

interface RegistryVersion {
  version: string;
  description?: string;
  requiredSecrets: string[];
  addedBy?: string;
  addedAt: string;
  files: number;
  source?: { repo: string; ref?: string; subdir?: string };
}

interface RegistrySkill {
  name: string;
  displayName?: string;
  description?: string;
  requiredSecrets: string[];
  versions: RegistryVersion[];
  current?: string;
  updatedAt?: string;
}

interface SyncEntry {
  at?: string;
  action: string;
  skill?: string;
  version?: string;
  by?: string;
  detail?: Record<string, unknown>;
}

const inputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  height: 34,
  padding: "0 9px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
};

const mutedStyle: CSSProperties = { color: "var(--text-muted)", fontSize: 12 };

/** Human-friendly "最近活跃" text (FR-1.4); plain locale-neutral formatting. */
function formatLastActive(iso: string | undefined): string {
  if (!iso) return "从未登录";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "从未登录";
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString();
}

function statusDotColor(user: AdminUser): string {
  return user.status === "active"
    ? "var(--color-positive, #2e9e5b)"
    : "var(--text-dim)";
}

export default function AdminPage() {
  // The session viewer renders MessageView, which needs the i18n context; the
  // admin route sits outside app/page.tsx's provider.
  return (
    <I18nProvider>
      <AdminConsole />
    </I18nProvider>
  );
}

function AdminConsole() {
  const [panel, setPanel] = useState<"users" | "skills" | "sessions" | "audit">("users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState<"user" | "admin">("user");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/users", { cache: "no-store" });
      if (res.status === 403) {
        setError("需要管理员权限(当前账号不是 admin)");
        return;
      }
      if (res.status === 401) {
        setError("未登录或凭证过期,请刷新页面重新认证");
        return;
      }
      const data = await res.json() as { users?: AdminUser[]; error?: string };
      if (data.error) {
        setError(data.error);
        return;
      }
      setUsers(data.users ?? []);
      setError(null);
      setSelectedId((prev) => prev ?? data.users?.[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = users.find((u) => u.id === selectedId) ?? null;

  const patchUser = async (userId: string, patch: Record<string, unknown>, okMessage: string) => {
    setStatus(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, ...patch }),
      });
      const data = await res.json() as { user?: AdminUser; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? `请求失败 (${res.status})`);
        return;
      }
      if (data.user) {
        setUsers((prev) => prev.map((u) => (u.id === userId ? data.user! : u)));
      }
      setStatus(okMessage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const createUser = async () => {
    setStatus(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newUsername.trim(),
          password: newPassword,
          role: newRole,
          ...(newDisplayName.trim() ? { displayName: newDisplayName.trim() } : {}),
        }),
      });
      const data = await res.json() as { user?: AdminUser; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? `创建失败 (${res.status})`);
        return;
      }
      setStatus(`用户 ${data.user?.username} 创建成功`);
      setCreating(false);
      setNewUsername("");
      setNewPassword("");
      setNewDisplayName("");
      setNewRole("user");
      await load();
      if (data.user) setSelectedId(data.user.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const assignSkills = async (userId: string, skills: string[]) => {
    setStatus(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/skills/assignments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, skills }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? `分配失败 (${res.status})`);
        return;
      }
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, skills } : u)));
      setStatus("技能分配已同步");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ConfigPanelShell
      embedded
      title="Pi Web 多用户版 管理"
      subtitle="用户 · 技能注册表与下发"
      closeLabel="返回"
      onClose={() => {
        window.location.href = "/";
      }}
    >
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigListAction
            active={panel === "users"}
            onClick={() => setPanel("users")}
          >
            用户管理({users.length})
          </ConfigListAction>
          <ConfigListAction
            active={panel === "skills"}
            onClick={() => setPanel("skills")}
          >
            技能注册表
          </ConfigListAction>
          <ConfigListAction
            active={panel === "sessions"}
            onClick={() => setPanel("sessions")}
          >
            全部会话
          </ConfigListAction>
          <ConfigListAction
            active={panel === "audit"}
            onClick={() => setPanel("audit")}
          >
            同步审计
          </ConfigListAction>

          {panel === "users" && (
            <>
              <ConfigSidebarGroupLabel>账号({users.length})</ConfigSidebarGroupLabel>
              <ConfigListAction
                onClick={() => {
                  setCreating(true);
                  setSelectedId(null);
                }}
                active={creating}
              >
                + 新建用户
              </ConfigListAction>
              <ConfigSidebarList>
                {loading && users.length === 0 && (
                  <ConfigSidebarText>加载中…</ConfigSidebarText>
                )}
                {users.map((user) => (
                  <ConfigSidebarItem
                    key={user.id}
                    active={!creating && user.id === selectedId}
                    onClick={() => {
                      setCreating(false);
                      setSelectedId(user.id);
                    }}
                  >
                    <ConfigStatusDot color={statusDotColor(user)} />
                    <ConfigSidebarText>
                      {user.displayName || user.username}
                      {user.role === "admin" ? " · 管理员" : ""}
                      {user.skills?.length ? ` · ${user.skills.length} 技能` : ""}
                    </ConfigSidebarText>
                  </ConfigSidebarItem>
                ))}
              </ConfigSidebarList>
            </>
          )}
        </ConfigSidebar>

        <ConfigDetail>
          {panel === "skills" ? (
            <SkillHubPanel />
          ) : panel === "sessions" ? (
            <AdminSessionsPanel />
          ) : panel === "audit" ? (
            <AuditPanel />
          ) : creating ? (
            <ConfigDetailStack>
              <ConfigDetailHeader>
                <ConfigDetailHeaderInfo>
                  <ConfigDetailTitle>新建用户</ConfigDetailTitle>
                </ConfigDetailHeaderInfo>
              </ConfigDetailHeader>
              <ConfigSectionTitle>账号信息</ConfigSectionTitle>
              <ConfigField label="用户名(2-32 位字母数字)">
                <input
                  style={inputStyle}
                  value={newUsername}
                  placeholder="zhangsan"
                  onChange={(e) => setNewUsername(e.target.value)}
                />
              </ConfigField>
              <ConfigField label="显示名(可选)">
                <input
                  style={inputStyle}
                  value={newDisplayName}
                  placeholder="张三"
                  onChange={(e) => setNewDisplayName(e.target.value)}
                />
              </ConfigField>
              <ConfigField label="初始密码(至少 8 位)">
                <input
                  style={inputStyle}
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </ConfigField>
              <ConfigField label="角色">
                <select
                  style={inputStyle}
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value === "admin" ? "admin" : "user")}
                >
                  <option value="user">user(普通用户)</option>
                  <option value="admin">admin(管理员)</option>
                </select>
              </ConfigField>
              <ConfigDetailActions>
                <ConfigButton variant="primary" onClick={() => void createUser()} disabled={!newUsername.trim() || newPassword.length < 8}>
                  创建
                </ConfigButton>
                <ConfigButton onClick={() => setCreating(false)}>取消</ConfigButton>
              </ConfigDetailActions>
            </ConfigDetailStack>
          ) : selected ? (
            <UserDetail
              key={selected.id}
              user={selected}
              skills={panel === "users" ? undefined : undefined}
              onPatch={patchUser}
              onAssignSkills={assignSkills}
            />
          ) : (
            <ConfigEmptyState>
              {error ?? (loading ? "加载中…" : "左侧选择一个用户,或新建用户")}
            </ConfigEmptyState>
          )}
        </ConfigDetail>
      </ConfigSplitView>

      <ConfigFooter status={
        <span>
          {error && <span style={{ color: "var(--color-danger, #c0392b)" }}>{error}</span>}
          {!error && status && <span>{status}</span>}
          {!error && !status && <span>数据目录由 PI_WEB_DATA_DIR 控制,默认 ~/.pi-web-multiuser</span>}
        </span>
      }>
        <ConfigButton size="small" onClick={() => void load()}>刷新</ConfigButton>
      </ConfigFooter>
    </ConfigPanelShell>
  );
}

function UserDetail({
  user,
  onPatch,
  onAssignSkills,
}: {
  user: AdminUser;
  skills?: undefined;
  onPatch: (userId: string, patch: Record<string, unknown>, okMessage: string) => Promise<void>;
  onAssignSkills: (userId: string, skills: string[]) => Promise<void>;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [resetting, setResetting] = useState(false);
  const [registry, setRegistry] = useState<RegistrySkill[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/skills", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json() as { skills?: RegistrySkill[] };
        if (!cancelled) setRegistry(data.skills ?? []);
      } catch { /* panel stays hidden */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const currentAssignment = (skill: RegistrySkill): string => {
    const existing = user.skills.find((s) => s === skill.name || s.startsWith(`${skill.name}@`));
    if (!existing) return "";
    const version = existing === skill.name || existing.endsWith("@latest") ? "latest" : existing.split("@")[1] ?? "latest";
    return version;
  };

  const toggleSkill = (skill: RegistrySkill, enable: boolean) => {
    const skills = enable
      ? [...user.skills.filter((s) => s !== skill.name && !s.startsWith(`${skill.name}@`)), `${skill.name}@latest`]
      : user.skills.filter((s) => s !== skill.name && !s.startsWith(`${skill.name}@`));
    void onAssignSkills(user.id, skills);
  };

  const setVersion = (skill: RegistrySkill, version: string) => {
    const skills = user.skills.filter((s) => s !== skill.name && !s.startsWith(`${skill.name}@`));
    skills.push(`${skill.name}@${version}`);
    void onAssignSkills(user.id, skills);
  };

  return (
    <ConfigDetailStack>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <ConfigDetailTitle>
            {user.displayName || user.username}
            <span style={{ color: "var(--text-muted)", fontSize: 12, marginLeft: 8 }}>
              @{user.username} · {user.role === "admin" ? "管理员" : "普通用户"}
            </span>
          </ConfigDetailTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <ConfigSwitch
            checked={user.status === "active"}
            label={user.status === "active" ? "已启用" : "已禁用"}
            onChange={(checked) => void onPatch(user.id, { status: checked ? "active" : "disabled" }, checked ? "已启用" : "已禁用")}
          />
        </ConfigDetailActions>
      </ConfigDetailHeader>

      <ConfigSectionTitle>基本信息</ConfigSectionTitle>
      <ConfigField label="角色">
        <span style={{ display: "flex", gap: 8 }}>
          <ConfigButton
            size="small"
            variant={user.role === "user" ? "primary" : "secondary"}
            onClick={() => void onPatch(user.id, { role: "user" }, "已设为普通用户")}
          >
            user
          </ConfigButton>
          <ConfigButton
            size="small"
            variant={user.role === "admin" ? "primary" : "secondary"}
            onClick={() => void onPatch(user.id, { role: "admin" }, "已设为管理员")}
          >
            admin
          </ConfigButton>
        </span>
      </ConfigField>
      <ConfigField label="状态">
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ConfigStatusDot color={statusDotColor(user)} />
          {user.status === "active" ? "active" : "disabled"}
        </span>
      </ConfigField>
      <ConfigField label="最近活跃">
        <span style={{ fontSize: 12, color: "var(--text-muted)" }} title={user.lastActiveAt}>{
          formatLastActive(user.lastActiveAt)
        }</span>
      </ConfigField>
      <ConfigField label="创建时间">
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{user.createdAt}</span>
      </ConfigField>

      <ConfigSectionTitle>重置密码</ConfigSectionTitle>
      {resetting ? (
        <ConfigField label="新密码(至少 8 位)">
          <span style={{ display: "flex", gap: 8 }}>
            <input
              style={inputStyle}
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <ConfigButton
              variant="primary"
              size="small"
              disabled={newPassword.length < 8}
              onClick={() => void onPatch(user.id, { password: newPassword }, "密码已重置").then(() => {
                setResetting(false);
                setNewPassword("");
              })}
            >
              保存
            </ConfigButton>
            <ConfigButton size="small" onClick={() => setResetting(false)}>取消</ConfigButton>
          </span>
        </ConfigField>
      ) : (
        <ConfigDetailActions>
          <ConfigButton size="small" onClick={() => setResetting(true)}>重置密码…</ConfigButton>
        </ConfigDetailActions>
      )}

      <ConfigSectionTitle>技能下发 — 打开开关即分配并立即同步到该用户目录;版本选 latest 跟随仓库更新</ConfigSectionTitle>
      {(registry ?? []).length === 0 ? (
        <ConfigEmptyState>注册表为空 — 先在「技能注册表」页上传技能包。</ConfigEmptyState>
      ) : (
        (registry ?? []).map((skill) => {
          const assigned = currentAssignment(skill);
          return (
            <ConfigField
              key={skill.name}
              label={
                <span>
                  {skill.displayName || skill.name}
                  <span style={{ ...mutedStyle, marginLeft: 8 }}>
                    {skill.versions.length} 个版本
                    {skill.requiredSecrets.length > 0 && ` · 密钥: ${skill.requiredSecrets.join(", ")}`}
                  </span>
                </span>
              }
            >
              <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <ConfigSwitch
                  checked={Boolean(assigned)}
                  label={assigned ? `已分配 @${assigned}` : "未分配"}
                  onChange={(checked) => toggleSkill(skill, checked)}
                />
                {assigned && (
                  <select
                    style={{ ...inputStyle, width: 130 }}
                    value={assigned}
                    onChange={(e) => setVersion(skill, e.target.value)}
                  >
                    <option value="latest">latest(自动更新)</option>
                    {skill.versions.map((v) => (
                      <option key={v.version} value={v.version}>{v.version}</option>
                    ))}
                  </select>
                )}
              </span>
            </ConfigField>
          );
        })
      )}
    </ConfigDetailStack>
  );
}

type HubUser = { id: string; username: string; displayName?: string; role: string; status: string; skills: string[] };

function SkillHubPanel() {
  const [skills, setSkills] = useState<RegistrySkill[]>([]);
  const [users, setUsers] = useState<HubUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [requiredSecrets, setRequiredSecrets] = useState("");
  const [gitRepo, setGitRepo] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitUsername, setGitUsername] = useState("");
  const [gitPassword, setGitPassword] = useState("");
  const [rememberGit, setRememberGit] = useState(false);
  const [importMode, setImportMode] = useState<"git" | "zip">("git");
  // Selected skill row → batch-assign drawer
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  // Matrix wizard: many skills × many users in one shot
  const [wizSkills, setWizSkills] = useState<Set<string>>(new Set());
  const [wizUsers, setWizUsers] = useState<Set<string>>(new Set());
  const [wizVersion, setWizVersion] = useState("latest");
  const [wizOpen, setWizOpen] = useState(false);
  // username → version ("latest" | pinned | "") draft for batch assignment
  const [batchDraft, setBatchDraft] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [skillsRes, usersRes] = await Promise.all([
        fetch("/api/admin/skills", { cache: "no-store" }),
        fetch("/api/admin/users", { cache: "no-store" }),
      ]);
      const skillsData = await skillsRes.json() as { skills?: RegistrySkill[]; error?: string };
      const usersData = await usersRes.json() as { users?: HubUser[]; error?: string };
      if (skillsData.error) setError(skillsData.error);
      setSkills(skillsData.skills ?? []);
      setUsers(usersData.users ?? []);
      setError(skillsData.error ?? usersData.error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("pi-admin-git");
      if (saved) {
        const { repo, username, password } = JSON.parse(saved) as { repo?: string; username?: string; password?: string };
        if (repo) setGitRepo(repo);
        if (username) setGitUsername(username);
        if (password) setGitPassword(password);
        if (repo) setRememberGit(true);
      }
    } catch { /* ignore */ }
  }, []);
  const persistGit = (repo: string, username: string, password: string) => {
    try {
      if (repo && rememberGit) localStorage.setItem("pi-admin-git", JSON.stringify({ repo, username, password }));
      else localStorage.removeItem("pi-admin-git");
    } catch { /* ignore */ }
  };

  /** usernames currently assigned to a skill (via users.json skills[]) */
  const assigneesOf = (skillName: string): HubUser[] =>
    users.filter((u) => u.skills.some((s) => s === skillName || s.startsWith(`${skillName}@`)));

  const assignedVersionOf = (user: HubUser, skillName: string): string | null => {
    const found = user.skills.find((s) => s === skillName || s.startsWith(`${skillName}@`));
    if (!found) return null;
    return found === skillName || found.endsWith("@latest") ? "latest" : found.split("@")[1] ?? "latest";
  };

  // ------------------------------------------------------------------ import
  const syncGitRepo = async () => {
    if (!gitRepo.trim()) return;
    setUploading(true); setError(null); setStatus(null);
    try {
      const res = await fetch("/api/admin/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: gitRepo.trim(),
          ...(gitRef.trim() ? { ref: gitRef.trim() } : {}),
          ...(gitUsername.trim() ? { username: gitUsername.trim() } : {}),
          ...(gitPassword ? { password: gitPassword } : {}),
          mode: "repo-sync",
        }),
      });
      const data = await res.json() as { ok?: boolean; error?: string; sync?: { commit: string; added: string[]; updated: string[]; unchanged: string[]; errors: Array<{ skill: string; error: string }> } };
      if (!res.ok || data.error) { setError(data.error ?? `同步失败 (${res.status})`); return; }
      const s = data.sync!;
      const parts = [
        `commit ${s.commit.slice(0, 8)}`,
        `新增 ${s.added.length}`,
        `更新 ${s.updated.length}`,
        `无变化 ${s.unchanged.length}`,
        ...(s.errors.length ? [`错误 ${s.errors.length}: ${s.errors.map((e) => `${e.skill}(${e.error.slice(0, 60)})`).join("; ")}`] : []),
      ];
      setStatus(`仓库同步完成 — ${parts.join(" · ")}`);
      persistGit(gitRepo.trim(), gitUsername, gitPassword);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const upload = async () => {
    if (!file || !version.trim()) return;
    setUploading(true); setError(null); setStatus(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("version", version.trim());
      if (displayName.trim()) form.append("displayName", displayName.trim());
      if (requiredSecrets.trim()) form.append("requiredSecrets", requiredSecrets.trim());
      const res = await fetch("/api/admin/skills", { method: "POST", body: form });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || data.error) { setError(data.error ?? `上传失败 (${res.status})`); return; }
      setStatus(`已入库 ${file.name} @ ${version.trim()}`);
      setFile(null); setVersion(""); setDisplayName(""); setRequiredSecrets("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const deleteVersion = async (name: string, ver: string) => {
    setError(null); setStatus(null);
    try {
      const res = await fetch(`/api/admin/skills?name=${encodeURIComponent(name)}&version=${encodeURIComponent(ver)}`, { method: "DELETE" });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || data.error) { setError(data.error ?? `删除失败 (${res.status})`); return; }
      setStatus(`已删除 ${name}@${ver}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ------------------------------------------------------------- assignments
  const applyAssignments = async (userId: string, skills: string[]) => {
    const res = await fetch("/api/admin/skills/assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, skills }),
    });
    const data = await res.json() as { ok?: boolean; error?: string; results?: Array<{ sync: { applied: string[]; removed: string[]; errors: string[] } }> };
    if (!res.ok || data.error) throw new Error(data.error ?? `分配失败 (${res.status})`);
    const sync = data.results?.[0]?.sync;
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, skills } : u)));
    return sync;
  };

  const batchAssign = async () => {
    const skill = selectedSkill;
    if (!skill) return;
    setBusy(true); setError(null); setStatus(null);
    const applied: string[] = [];
    const removed: string[] = [];
    const failures: string[] = [];
    try {
      for (const user of users) {
        const wanted = batchDraft[user.username];
        if (wanted === undefined) continue; // untouched row
        const current = assignedVersionOf(user, skill);
        if (wanted === "" && current === null) { setBatchDraft((d) => { const n = { ...d }; delete n[user.username]; return n; }); continue; }
        const nextSkills = user.skills.filter((s) => s !== skill && !s.startsWith(`${skill}@`));
        if (wanted !== "") nextSkills.push(`${skill}@${wanted}`);
        try {
          const sync = await applyAssignments(user.id, nextSkills);
          if (wanted !== "") applied.push(user.username);
          else removed.push(user.username);
          if (sync?.errors.length) failures.push(`${user.username}: ${sync.errors.join("; ")}`);
          setBatchDraft((d) => { const n = { ...d }; delete n[user.username]; return n; });
        } catch (e) {
          failures.push(`${user.username}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const parts = [
        applied.length ? `分配 ${applied.join(", ")}` : "",
        removed.length ? `移除 ${removed.join(", ")}` : "",
        ...(failures.length ? [`失败: ${failures.join("; ")}`] : []),
      ].filter(Boolean);
      if (parts.length) setStatus(`${skill} — ${parts.join(" · ")}`);
      else setStatus(` ${skill} — 没有变更`);
    } finally {
      setBusy(false);
    }
  };

  const toggleSet = (prev: Set<string>, key: string): Set<string> => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const runMatrixAssign = async () => {
    if (wizSkills.size === 0 || wizUsers.size === 0) return;
    setBusy(true); setError(null); setStatus(null);
    try {
      const res = await fetch("/api/admin/skills/assignments/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skills: [...wizSkills], users: [...wizUsers], version: wizVersion }),
      });
      const data = await res.json() as {
        ok?: boolean; error?: string;
        results?: Array<{ userId: string; skills: string[]; sync: { applied: string[]; removed: string[]; errors: string[] } }>;
        errors?: Array<{ userId: string; error: string }>;
      };
      if (!res.ok || data.error) { setError(data.error ?? `批量分配失败 (${res.status})`); return; }
      const applied = (data.results ?? []).reduce((n, r) => n + r.sync.applied.length, 0);
      const removed = (data.results ?? []).reduce((n, r) => n + r.sync.removed.length, 0);
      const userErrors = [
        ...(data.errors ?? []).map((e) => e.error),
        ...(data.results ?? []).flatMap((r) => r.sync.errors),
      ];
      // Refresh users' skill lists from the response
      setUsers((prev) => prev.map((u) => {
        const hit = (data.results ?? []).find((r) => r.userId === u.id);
        return hit ? { ...u, skills: hit.skills } : u;
      }));
      const parts = [
        `${wizSkills.size} 技能 → ${data.results?.length ?? 0} 用户`,
        `应用 ${applied}${removed ? ` · 移除 ${removed}` : ""}`,
        ...(userErrors.length ? [`错误: ${userErrors.slice(0, 3).join("; ")}${userErrors.length > 3 ? "…" : ""}`] : []),
      ];
      setStatus(`批量分配完成 — ${parts.join(" · ")}`);
      setWizSkills(new Set()); setWizUsers(new Set()); setWizOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------------------------ render
  const filtered = skills.filter((s) => !search.trim() || (s.name + (s.displayName ?? "")).toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <ConfigDetailStack>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <ConfigDetailTitle>SkillHub</ConfigDetailTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <input
            style={{ ...inputStyle, width: 180 }}
            placeholder="搜索技能…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ConfigButton size="small" variant={wizOpen ? "primary" : "secondary"} onClick={() => setWizOpen((v) => !v)}>
            批量分配
          </ConfigButton>
          <ConfigButton size="small" disabled={busy || uploading} onClick={() => void (async () => {
            setBusy(true); setError(null); setStatus(null);
            try {
              const res = await fetch("/api/admin/skills/sync", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ all: true }),
              });
              const data = await res.json() as { ok?: boolean; error?: string; results?: Array<{ userId: string; applied: string[]; removed: string[]; errors: string[] }> };
              if (!res.ok || data.error) { setError(data.error ?? `同步失败 (${res.status})`); return; }
              const applied = (data.results ?? []).reduce((n, r) => n + r.applied.length, 0);
              const removed = (data.results ?? []).reduce((n, r) => n + r.removed.length, 0);
              const errs = (data.results ?? []).reduce((n, r) => n + r.errors.length, 0);
              setStatus(`全量同步完成: 应用 ${applied} · 移除 ${removed}${errs ? ` · 错误 ${errs}` : ""}`);
              await load();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally { setBusy(false); }
          })()}>
            {busy ? "同步中…" : "全量同步到用户"}
          </ConfigButton>
        </ConfigDetailActions>
      </ConfigDetailHeader>

      {(error || status) && (
        <div
          role="status"
          style={{
            margin: "0 0 10px", padding: "8px 12px", borderRadius: 8, fontSize: 13,
            whiteSpace: "pre-wrap", wordBreak: "break-all",
            background: error
              ? "color-mix(in srgb, var(--color-danger, #c0392b) 10%, transparent)"
              : "color-mix(in srgb, #16a34a 10%, transparent)",
            color: error ? "var(--color-danger, #c0392b)" : "#15803d",
          }}
        >
          {error ?? status}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <ConfigButton size="small" variant={importMode === "git" ? "primary" : "secondary"} onClick={() => setImportMode("git")}>Git 同步</ConfigButton>
        <ConfigButton size="small" variant={importMode === "zip" ? "primary" : "secondary"} onClick={() => setImportMode("zip")}>上传 zip</ConfigButton>
      </div>

      {wizOpen && (
        <div style={{ border: "1px solid var(--accent, #6366f1)", borderRadius: 10, padding: 12, marginBottom: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
            批量分配 — 选一批技能 × 一批用户,一次下发
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 260px", minWidth: 240 }}>
              <div style={{ ...mutedStyle, marginBottom: 4 }}>
                技能({wizSkills.size}/{skills.length})
                <span
                  role="button" tabIndex={0}
                  onClick={() => setWizSkills(wizSkills.size === skills.length ? new Set() : new Set(skills.map((s) => s.name)))}
                  onKeyDown={(e) => { if (e.key === "Enter") setWizSkills(wizSkills.size === skills.length ? new Set() : new Set(skills.map((s) => s.name))); }}
                  style={{ marginLeft: 8, cursor: "pointer", color: "var(--accent, #6366f1)" }}
                >
                  {wizSkills.size === skills.length && skills.length > 0 ? "全不选" : "全选"}
                </span>
              </div>
              <div style={{ border: "1px solid var(--border)", borderRadius: 8, maxHeight: 180, overflowY: "auto" }}>
                {skills.map((s) => (
                  <label key={s.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={wizSkills.has(s.name)}
                      onChange={() => setWizSkills((prev) => toggleSet(prev, s.name))}
                    />
                    {s.displayName || s.name}
                  </label>
                ))}
              </div>
            </div>
            <div style={{ flex: "1 1 260px", minWidth: 240 }}>
              <div style={{ ...mutedStyle, marginBottom: 4 }}>
                用户({wizUsers.size}/{users.length})
                <span
                  role="button" tabIndex={0}
                  onClick={() => setWizUsers(wizUsers.size === users.length ? new Set() : new Set(users.map((u) => u.id)))}
                  onKeyDown={(e) => { if (e.key === "Enter") setWizUsers(wizUsers.size === users.length ? new Set() : new Set(users.map((u) => u.id))); }}
                  style={{ marginLeft: 8, cursor: "pointer", color: "var(--accent, #6366f1)" }}
                >
                  {wizUsers.size === users.length && users.length > 0 ? "全不选" : "全选"}
                </span>
              </div>
              <div style={{ border: "1px solid var(--border)", borderRadius: 8, maxHeight: 180, overflowY: "auto" }}>
                {users.map((u) => (
                  <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={wizUsers.has(u.id)}
                      onChange={() => setWizUsers((prev) => toggleSet(prev, u.id))}
                    />
                    {u.displayName || u.username}
                    {u.role === "admin" && <span style={mutedStyle}>· 管理员</span>}
                    {u.status !== "active" && <span style={{ color: "var(--text-dim)" }}>· 已禁用</span>}
                  </label>
                ))}
              </div>
            </div>
            <div style={{ flex: "0 0 170px", display: "flex", flexDirection: "column", gap: 8, justifyContent: "flex-start" }}>
              <div>
                <div style={{ ...mutedStyle, marginBottom: 4 }}>版本</div>
                <select style={{ ...inputStyle, width: "100%" }} value={wizVersion} onChange={(e) => setWizVersion(e.target.value)}>
                  <option value="latest">latest(跟随更新)</option>
                </select>
              </div>
              <div style={{ ...mutedStyle }}>
                将执行 {wizSkills.size} × {wizUsers.size} = {wizSkills.size * wizUsers.size} 项分配
              </div>
              <ConfigButton
                variant="primary"
                size="small"
                disabled={busy || wizSkills.size === 0 || wizUsers.size === 0}
                onClick={() => void runMatrixAssign()}
              >
                {busy ? "应用中…" : `下发给 ${wizUsers.size} 个用户`}
              </ConfigButton>
            </div>
          </div>
        </div>
      )}

      {importMode === "git" ? (
        <>
          <ConfigField label="仓库 URL(http/ssh)">
            <input style={inputStyle} value={gitRepo} placeholder="https://github.com/example/skills.git" onChange={(e) => setGitRepo(e.target.value)} />
          </ConfigField>
          <ConfigField label="分支/ref(可选)">
            <input style={inputStyle} value={gitRef} onChange={(e) => setGitRef(e.target.value)} />
          </ConfigField>
          <ConfigField label="访问凭据(私库必填;填访问令牌,不会写入服务器)">
            <span style={{ display: "flex", gap: 8 }}>
              <input style={{ ...inputStyle, flex: 1 }} value={gitUsername} placeholder="用户名或 token 名" onChange={(e) => setGitUsername(e.target.value)} autoComplete="off" />
              <input style={{ ...inputStyle, flex: 1 }} type="password" value={gitPassword} placeholder="密码或访问令牌" onChange={(e) => setGitPassword(e.target.value)} autoComplete="new-password" />
            </span>
          </ConfigField>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px", cursor: "pointer" }}>
            <input type="checkbox" checked={rememberGit} onChange={(e) => setRememberGit(e.target.checked)} />
            在本浏览器记住仓库与凭据(仅存本机浏览器)
          </label>
          <ConfigDetailActions>
            <ConfigButton variant="primary" size="small" disabled={!gitRepo.trim() || uploading} onClick={() => void syncGitRepo()}>
              {uploading ? "同步中…" : "同步/更新仓库"}
            </ConfigButton>
          </ConfigDetailActions>
        </>
      ) : (
        <>
          <ConfigField label="技能包(.zip,根目录含 SKILL.md)">
            <input
              style={{ ...inputStyle, paddingTop: 6 }}
              type="file"
              accept=".zip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </ConfigField>
          <ConfigField label="版本号(不可变,如 1.0.0)">
            <input style={inputStyle} value={version} placeholder="1.0.0" onChange={(e) => setVersion(e.target.value)} />
          </ConfigField>
          <ConfigField label="显示名(可选,缺省取 frontmatter)">
            <input style={inputStyle} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </ConfigField>
          <ConfigField label="所需密钥名(逗号分隔,可选)">
            <input style={inputStyle} value={requiredSecrets} placeholder="RY_TOKEN, SMARTFICC_API_KEY" onChange={(e) => setRequiredSecrets(e.target.value)} />
          </ConfigField>
          <ConfigDetailActions>
            <ConfigButton variant="primary" size="small" disabled={!file || !version.trim() || uploading} onClick={() => void upload()}>
              {uploading ? "上传中…" : "上传入库"}
            </ConfigButton>
          </ConfigDetailActions>
        </>
      )}

      <ConfigSectionTitle>技能({filtered.length})— 点开一行查看版本与分配</ConfigSectionTitle>
      {loading && skills.length === 0 && <ConfigEmptyState>加载中…</ConfigEmptyState>}
      {!loading && filtered.length === 0 && <ConfigEmptyState>{search ? "没有匹配的技能。" : "注册表为空 — 先同步 git 仓库或上传 zip。"}</ConfigEmptyState>}

      {filtered.map((skill) => {
        const assignees = assigneesOf(skill.name);
        const open = selectedSkill === skill.name;
        return (
          <div
            key={skill.name}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 10,
              marginBottom: 8,
              background: open ? "var(--bg-panel)" : "var(--bg)",
              overflow: "hidden",
            }}
          >
            <button
              type="button"
              onClick={() => {
                setSelectedSkill(open ? null : skill.name);
                setBatchDraft({});
              }}
              style={{
                display: "flex", width: "100%", alignItems: "center", gap: 10,
                padding: "10px 12px", background: "none", border: "none",
                color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 13,
              }}
            >
              <span style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", color: "var(--text-muted)" }}>▸</span>
              <strong>{skill.displayName || skill.name}</strong>
              <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{skill.current}</code>
              {skill.requiredSecrets.length > 0 && (
                <span style={{ ...mutedStyle, color: "#b45309" }}>🔑 {skill.requiredSecrets.join(", ")}</span>
              )}
              <span style={{ flex: 1 }} />
              <span style={{ ...mutedStyle }}>
                {skill.versions.length} 版本 · {assignees.length > 0 ? `已分配给 ${assignees.length} 人` : "未分配"}
              </span>
            </button>

            {open && (
              <div style={{ padding: "4px 12px 12px", borderTop: "1px solid var(--border)" }}>
                <div style={{ ...mutedStyle, margin: "8px 0 4px" }}>{skill.description}</div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
                  {skill.versions.map((v) => (
                    <span
                      key={v.version}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        fontSize: 11, padding: "2px 8px", borderRadius: 8,
                        border: `1px solid ${v.version === skill.current ? "var(--accent, #6366f1)" : "var(--border)"}`,
                        color: v.version === skill.current ? "var(--accent, #6366f1)" : "var(--text-muted)",
                      }}
                      title={`${v.files} 文件 · ${v.addedBy ?? "?"} · ${v.addedAt?.slice(0, 10)}${v.source?.repo ? ` · git:${v.source.ref || "HEAD"}${v.source.subdir ? `/${v.source.subdir}` : ""}` : ""}`}
                    >
                      {v.version}
                      {v.version === skill.current && <strong>latest</strong>}
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); void deleteVersion(skill.name, v.version); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); void deleteVersion(skill.name, v.version); } }}
                        style={{ cursor: "pointer", color: "var(--color-danger, #c0392b)", padding: "0 2px" }}
                        title="删除该版本"
                      >
                        ×
                      </span>
                    </span>
                  ))}
                </div>

                {assignees.length > 0 && (
                  <div style={{ ...mutedStyle, margin: "6px 0" }}>
                    已分配给: {assignees.map((u) => `${u.displayName || u.username}(@${assignedVersionOf(u, skill.name)})`).join("、 ")}
                  </div>
                )}

                <div style={{ margin: "10px 0 6px", fontWeight: 600, fontSize: 12 }}>批量分配给用户</div>
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, maxHeight: 260, overflowY: "auto" }}>
                  {users.map((user) => {
                    const current = assignedVersionOf(user, skill.name);
                    const draft = batchDraft[user.username] ?? current ?? "";
                    const changed = draft !== (current ?? "");
                    return (
                      <div
                        key={user.id}
                        style={{
                          display: "flex", alignItems: "center", gap: 10,
                          padding: "6px 10px", borderBottom: "1px solid var(--border)",
                          fontSize: 12,
                        }}
                      >
                        <span style={{ width: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {user.displayName || user.username}
                          {user.role === "admin" && <span style={{ ...mutedStyle }}> · 管理员</span>}
                          {user.status !== "active" && <span style={{ color: "var(--text-dim)" }}> · 已禁用</span>}
                        </span>
                        <span style={{ flex: 1 }} />
                        <select
                          style={{ ...inputStyle, width: 150, height: 28 }}
                          value={draft}
                          onChange={(e) => setBatchDraft((d) => ({ ...d, [user.username]: e.target.value }))}
                        >
                          <option value="">未分配</option>
                          <option value="latest">latest(跟随更新)</option>
                          {skill.versions.map((v) => (
                            <option key={v.version} value={v.version}>固定 {v.version}</option>
                          ))}
                        </select>
                        <span style={{ width: 90, ...mutedStyle }}>
                          {changed ? (draft === "" ? "将移除" : draft === "latest" ? "将分配 latest" : `将设为 ${draft}`) : current ? `@${current}` : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <ConfigDetailActions>
                  <ConfigButton
                    variant="primary"
                    size="small"
                    disabled={busy || Object.keys(batchDraft).length === 0}
                    onClick={() => void batchAssign()}
                  >
                    {busy ? "应用中…" : `应用变更(${Object.keys(batchDraft).length})`}
                  </ConfigButton>
                  <ConfigButton size="small" disabled={busy} onClick={() => setBatchDraft({})}>放弃修改</ConfigButton>
                </ConfigDetailActions>
              </div>
            )}
          </div>
        );
      })}
    </ConfigDetailStack>
  );
}

function AuditPanel() {
  const [entries, setEntries] = useState<SyncEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/skills/sync-log", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json() as { entries?: SyncEntry[] };
        if (!cancelled) setEntries(data.entries ?? []);
      } catch { /* ignore */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <ConfigDetailStack>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <ConfigDetailTitle>技能同步审计日志</ConfigDetailTitle>
        </ConfigDetailHeaderInfo>
      </ConfigDetailHeader>
      {loading && <ConfigEmptyState>加载中…</ConfigEmptyState>}
      {!loading && entries.length === 0 && <ConfigEmptyState>暂无记录。</ConfigEmptyState>}
      {entries.map((entry, i) => (
        <ConfigField key={`${entry.at}-${i}`} label={<span><code>{entry.action}</code>{entry.skill ? ` ${entry.skill}@${entry.version ?? ""}` : ""}</span>}>
          <span style={mutedStyle}>
            {entry.at} · {entry.by ?? "system"}
            {entry.detail ? ` · ${JSON.stringify(entry.detail).slice(0, 160)}` : ""}
          </span>
        </ConfigField>
      ))}
    </ConfigDetailStack>
  );
}
