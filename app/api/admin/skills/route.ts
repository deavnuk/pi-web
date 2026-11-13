import { NextResponse } from "next/server";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { requireAdmin } from "@/lib/user-auth";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import {
  addSkillFromZip,
  addSkillFromGit,
  syncSkillsFromGitRepo,
  deleteSkillVersion,
  getRegistrySkill,
  listRegistrySkills,
  recordGitSyncSource,
  SkillRegistryError,
} from "@/lib/skill-registry";
import { listUsers } from "@/lib/user-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/skills — registry listing + per-user assignment summary.
 */
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;

  const skills = listRegistrySkills();
  const assignments: Record<string, string[]> = {};
  for (const u of listUsers()) assignments[u.id] = u.skills ?? [];
  return NextResponse.json(
    { skills, assignments },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * POST /api/admin/skills — add a skill version.
 * Content-Type multipart/form-data: file=<zip>, version, overrides...
 * Content-Type application/json: { repo, ref?, version, overrides... } (git import)
 */
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  const admin = auth.user;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const contentType = req.headers.get("content-type") ?? "";
    let skill: ReturnType<typeof getRegistrySkill>;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const version = String(form.get("version") ?? "").trim();
      if (!(file instanceof File) || file.size === 0) {
        return NextResponse.json({ error: "file (zip) required" }, { status: 400 });
      }
      if (!version) return NextResponse.json({ error: "version required" }, { status: 400 });
      const staged = join(tmpdir(), `pi-skill-upload-${randomUUID()}.zip`);
      writeFileSync(staged, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
      try {
        skill = addSkillFromZip({
          zipPath: staged,
          version,
          addedBy: admin.username,
          ...(form.get("displayName") ? { displayName: String(form.get("displayName")) } : {}),
          ...(form.get("description") ? { description: String(form.get("description")) } : {}),
          ...(form.get("requiredSecrets")
            ? { requiredSecrets: String(form.get("requiredSecrets")).split(/[,\s]+/).filter(Boolean) }
            : {}),
        });
      } finally {
        try { rmStaged(staged); } catch { /* ignore */ }
      }
    } else if (hasJsonContentType(req)) {
      const body = await req.json() as {
        repo?: unknown;
        ref?: unknown;
        subdir?: unknown;
        version?: unknown;
        mode?: unknown; // "repo-sync": whole-repo sync, version = git commit
        username?: unknown;
        password?: unknown;
        displayName?: unknown;
        description?: unknown;
        requiredSecrets?: unknown;
      };
      if (typeof body.repo !== "string" || !body.repo) {
        return NextResponse.json({ error: "repo required" }, { status: 400 });
      }
      const credentials = {
        ...(typeof body.username === "string" && body.username ? { username: body.username } : {}),
        ...(typeof body.password === "string" && body.password ? { password: body.password } : {}),
      };
      if (body.mode === "repo-sync") {
        const sync = syncSkillsFromGitRepo({
          repo: body.repo,
          ...(typeof body.ref === "string" && body.ref ? { ref: body.ref } : {}),
          ...credentials,
          addedBy: admin.username,
        });
        // Remember the source (no credentials) for the scheduled auto-update.
        recordGitSyncSource(body.repo, typeof body.ref === "string" && body.ref ? body.ref : undefined, admin.username);
        return NextResponse.json({ ok: true, sync });
      }
      if (typeof body.version !== "string" || !body.version) {
        return NextResponse.json({ error: "version required" }, { status: 400 });
      }
      skill = addSkillFromGit({
        repo: body.repo,
        ...(typeof body.ref === "string" && body.ref ? { ref: body.ref } : {}),
        ...(typeof body.subdir === "string" && body.subdir ? { subdir: body.subdir } : {}),
        version: body.version,
        ...credentials,
        addedBy: admin.username,
        ...(typeof body.displayName === "string" && body.displayName ? { displayName: body.displayName } : {}),
        ...(typeof body.description === "string" && body.description ? { description: body.description } : {}),
        ...(Array.isArray(body.requiredSecrets) ? { requiredSecrets: body.requiredSecrets.filter((s): s is string => typeof s === "string") } : {}),
      });
    } else {
      return NextResponse.json({ error: "Unsupported content type" }, { status: 400 });
    }

    return NextResponse.json({ ok: true, skill });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof SkillRegistryError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

function rmStaged(path: string): void {
  rmSync(path, { force: true });
}

/**
 * DELETE /api/admin/skills?name=<name>&version=<version>
 */
export async function DELETE(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  const admin = auth.user;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { searchParams } = new URL(req.url);
  const name = searchParams.get("name");
  const version = searchParams.get("version");
  if (!name || !version) {
    return NextResponse.json({ error: "name and version required" }, { status: 400 });
  }
  try {
    deleteSkillVersion(name, version, admin.username);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof SkillRegistryError ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
