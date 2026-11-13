// Persona system prompt (FR-5.4): non-admin sessions get the department
// persona + fresh identity, admins keep pi's stock prompt, and the user's
// APPEND_SYSTEM.md text appears exactly once.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

/** Minimal UserContext stub. */
function user(overrides = {}) {
  return {
    userId: "u_1", username: "zhangsan", role: "user", tenantId: "t_default",
    agentDir: "/tmp/agent", allowedRoots: [], skills: [], ...overrides,
  };
}

test("persona applies to normal users only, never admins", async () => {
  const { personaAppliesTo } = await jiti.import("./persona-extension.ts");
  assert.equal(personaAppliesTo(user()), true);
  assert.equal(personaAppliesTo(user({ role: "admin" })), false);
  assert.equal(personaAppliesTo(undefined), false);
  assert.equal(personaAppliesTo(null), false);
});

test("buildPersonaSystemPrompt injects live identity and the user's append text once", async () => {
  const { buildPersonaSystemPrompt } = await jiti.import("./persona-extension.ts");
  const body = "# 研研\n\n我是信用投研助手。";
  const prompt = buildPersonaSystemPrompt(body, user({ displayName: "张三" }), {
    appendSystemPrompt: "## 个人偏好\n- 尽量用表格",
    selectedTools: ["read", "bash"],
    toolSnippets: { read: "Read a file", bash: "Run a command" },
    cwd: "/Users/x/projects/zhangsan/pi-cwd-1",
    contextFiles: [{ path: "/x/AGENTS.md", content: "project rules" }],
    skills: [{ name: "chengtou-region", description: "城投区域分析" }],
  });

  assert.ok(prompt.startsWith("# 研研"), "persona body leads");
  assert.match(prompt, /用户名:zhangsan/);
  assert.match(prompt, /称呼:张三/);
  assert.match(prompt, /角色:用户/);
  assert.match(prompt, /租户:t_default/);
  assert.match(prompt, /Available tools:\n- read: Read a file\n- bash: Run a command/);
  assert.match(prompt, /Project-specific instructions/);
  assert.match(prompt, /Available skills \(1\)/);
  assert.match(prompt, /Current working directory: \/Users\/x\/projects\/zhangsan\/pi-cwd-1/);

  // The user's own text must survive, and exactly once.
  const occurrences = prompt.split("## 个人偏好").length - 1;
  assert.equal(occurrences, 1, "APPEND_SYSTEM.md text appears exactly once");
});

test("identity block is standalone and reusable (admin path)", async () => {
  const { buildIdentityBlock } = await jiti.import("./persona-extension.ts");
  const block = buildIdentityBlock(user({ role: "admin", username: "admin" }));
  assert.match(block, /用户名:admin/);
  assert.match(block, /角色:管理员/);
  assert.ok(block.startsWith("## 当前会话用户"));
});

test("admin role is rendered explicitly and identity never leaks into the body", async () => {
  const { buildPersonaSystemPrompt } = await jiti.import("./persona-extension.ts");
  const body = "# Persona body without identity";
  const prompt = buildPersonaSystemPrompt(body, user({ role: "admin", username: "admin" }), { cwd: "/tmp" });
  assert.match(prompt, /角色:管理员/);
  // Identity lives in its own section, never inside the persona body itself.
  const [bodyOnly] = prompt.split("## 当前会话用户");
  assert.equal(bodyOnly.trim(), body);
});

test("buildPersonaSystemPrompt omits optional blocks when absent", async () => {
  const { buildPersonaSystemPrompt } = await jiti.import("./persona-extension.ts");
  const prompt = buildPersonaSystemPrompt("body", user(), { cwd: "/tmp" });
  assert.ok(!prompt.includes("Available tools:"));
  assert.ok(!prompt.includes("Available skills"));
  assert.ok(!prompt.includes("project_context"));
  assert.match(prompt, /Current working directory: \/tmp/);
});

test("readPersonaBody loads the shipped department persona asset", async () => {
  const { readPersonaBody, personaAssetPath } = await jiti.import("./persona-extension.ts");
  const webRoot = process.cwd();
  const body = readPersonaBody(webRoot);
  assert.ok(body, "persona asset exists");
  assert.match(body, /研研/);
  assert.match(body, /数据真实性/);
  assert.ok(!body.includes("APPEND_SYSTEM"), "persona is self-contained");
  assert.ok(personaAssetPath(webRoot).endsWith(join("lib", "personas", "researcher.md")));
});

test("readPersonaBody returns null when the asset is missing", async () => {
  const { readPersonaBody } = await jiti.import("./persona-extension.ts");
  const empty = mkdtempSync(join(tmpdir(), "pi-persona-"));
  try {
    mkdirSync(join(empty, "lib", "personas"), { recursive: true });
    assert.equal(readPersonaBody(empty), null, "missing asset → no override");
    writeFileSync(join(empty, "lib", "personas", "researcher.md"), "   \n");
    assert.equal(readPersonaBody(empty), null, "whitespace-only → no override");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
