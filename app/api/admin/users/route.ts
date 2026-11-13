import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { requireAdmin, buildUserContext } from "@/lib/user-auth";
import {
  createUser,
  invalidateUserStoreCache,
  listUsers,
  setUserRole,
  setUserSkills,
  setUserStatus,
  updatePassword,
  UserStoreError,
} from "@/lib/user-store";
import { destroyWorker } from "@/lib/agent-worker-manager";

export const dynamic = "force-dynamic";

function publicUser(u: ReturnType<typeof listUsers>[number]) {
  return {
    id: u.id,
    username: u.username,
    ...(u.displayName ? { displayName: u.displayName } : {}),
    role: u.role,
    tenantId: u.tenantId,
    status: u.status,
    skills: u.skills,
    ...(u.adoptGlobalAgentDir ? { adoptGlobalAgentDir: true } : {}),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    ...(u.lastActiveAt ? { lastActiveAt: u.lastActiveAt } : {}),
    // Never expose passwordHash.
  };
}

// GET /api/admin/users — list users (admin only)
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  return NextResponse.json({ users: listUsers().map(publicUser) });
}

// POST /api/admin/users — create user
// body: { username, password, role?, displayName?, skills? }
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as {
      username?: unknown;
      password?: unknown;
      role?: unknown;
      displayName?: unknown;
      skills?: unknown;
    };
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      return NextResponse.json({ error: "username and password required" }, { status: 400 });
    }
    if (body.role !== undefined && body.role !== "user" && body.role !== "admin") {
      return NextResponse.json({ error: "role must be user or admin" }, { status: 400 });
    }
    const user = await createUser({
      username: body.username,
      password: body.password,
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(typeof body.displayName === "string" && body.displayName.trim()
        ? { displayName: body.displayName.trim() }
        : {}),
    });
    if (Array.isArray(body.skills)) {
      await setUserSkills(
        user.id,
        body.skills.filter((s): s is string => typeof s === "string"),
      );
    }
    invalidateUserStoreCache();
    return NextResponse.json({ user: publicUser(user) });
  } catch (error) {
    const status = error instanceof UserStoreError ? 400 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}

// PATCH /api/admin/users — update role/status/skills/password
// body: { userId, role?, status?, skills?, password? }
export async function PATCH(req: Request) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as {
      userId?: unknown;
      role?: unknown;
      status?: unknown;
      skills?: unknown;
      password?: unknown;
    };
    if (typeof body.userId !== "string") {
      return NextResponse.json({ error: "userId required" }, { status: 400 });
    }
    const userId = body.userId;

    // Guard: the acting admin cannot demote or disable themselves.
    const self = auth.user.userId === userId;
    if (self && (body.role === "user" || body.status === "disabled")) {
      return NextResponse.json(
        { error: "Admins cannot demote or disable their own account" },
        { status: 409 },
      );
    }

    if (body.role !== undefined) {
      if (body.role !== "user" && body.role !== "admin") {
        return NextResponse.json({ error: "role must be user or admin" }, { status: 400 });
      }
      await setUserRole(userId, body.role);
    }
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "disabled") {
        return NextResponse.json({ error: "status must be active or disabled" }, { status: 400 });
      }
      await setUserStatus(userId, body.status);
      // Disabled users lose their worker process immediately (P0 acceptance).
      if (body.status === "disabled") {
        const target = listUsers().find((u) => u.id === userId);
        if (target) {
          await destroyWorker(buildUserContext(target));
        }
      }
    }
    if (body.skills !== undefined) {
      if (!Array.isArray(body.skills)) {
        return NextResponse.json({ error: "skills must be an array" }, { status: 400 });
      }
      await setUserSkills(userId, body.skills.filter((s): s is string => typeof s === "string"));
    }
    if (body.password !== undefined) {
      if (typeof body.password !== "string" || body.password.length < 8) {
        return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
      }
      await updatePassword(userId, body.password);
    }

    invalidateUserStoreCache();
    const updated = listUsers().find((u) => u.id === userId);
    if (!updated) return NextResponse.json({ error: "User not found" }, { status: 404 });
    return NextResponse.json({ user: publicUser(updated) });
  } catch (error) {
    const status = error instanceof UserStoreError ? 400 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}
