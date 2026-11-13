import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/user-auth";
import {
  getScheduledTask,
  removeScheduledTask,
  toTaskView,
  updateScheduledTask,
  ScheduleValidationError,
} from "@/lib/scheduled-tasks";
import { isScheduledTaskRunning, runScheduledTask } from "@/lib/schedule-runner";
import { buildSchedulerDependencies } from "@/lib/schedule-runtime";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * Resolve a task by id **within the caller's own store**.
 *
 * Deliberately not a global lookup plus an ownership check: the store is keyed
 * by agentDir, so a task belonging to someone else is simply not found here.
 */
async function resolveOwnedTask(req: Request, id: string) {
  const auth = await requireAuth(req);
  if ("response" in auth) return { response: auth.response };
  const user = auth.user;
  const task = getScheduledTask(user.agentDir, id);
  if (!task) {
    return { response: NextResponse.json({ error: "Scheduled task not found" }, { status: 404 }) };
  }
  return { user, task };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolved = await resolveOwnedTask(req, id);
  if ("response" in resolved) return resolved.response;
  return NextResponse.json(
    { task: toTaskView(resolved.task) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * PATCH /api/scheduled-tasks/[id]
 * body: { title?, prompt?, schedule?, cwd?, enabled? }
 *
 * Also the enable/disable switch — `{ enabled: false }` is the pause button.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolved = await resolveOwnedTask(req, id);
  if ("response" in resolved) return resolved.response;
  const { user } = resolved;

  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 400 });
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const task = await updateScheduledTask(user.agentDir, id, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
      ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    });
    return NextResponse.json({ task: toTaskView(task) });
  } catch (error) {
    const status = error instanceof ScheduleValidationError ? 400 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolved = await resolveOwnedTask(req, id);
  if ("response" in resolved) return resolved.response;
  await removeScheduledTask(resolved.user.agentDir, id);
  return NextResponse.json({ ok: true, id });
}

/**
 * POST /api/scheduled-tasks/[id] — "run now".
 *
 * A run can take many minutes, well past any sane request timeout, so this
 * returns as soon as the run is *accepted* and the caller polls the task for
 * the new history entry. It deliberately goes through the same runner the
 * timer uses, so a manual run behaves identically (same cwd checks, same
 * session-per-run, same owner-scoped notification).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolved = await resolveOwnedTask(req, id);
  if ("response" in resolved) return resolved.response;
  const { user, task } = resolved;

  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!task.enabled) {
    return NextResponse.json(
      { error: "Task is disabled; enable it before running" },
      { status: 409 },
    );
  }
  // One run per task at a time (FR-7.6): refuse rather than spawn a second
  // session that would duplicate the work and the history entry. The runner
  // guards this too, but answering 409 here gives the button immediate feedback.
  if (isScheduledTaskRunning(user.agentDir, id)) {
    return NextResponse.json(
      { error: "Task is already running" },
      { status: 409 },
    );
  }

  const deps = await buildSchedulerDependencies();
  // Fire and forget: the outcome is recorded on the task, which is where the
  // UI reads it from. Awaiting here would hold the request open for the whole
  // run and then lose it anyway on a client disconnect.
  void runScheduledTask(task, user, deps).catch((error) => {
    console.warn(
      `[schedule] manual run of ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return NextResponse.json({ ok: true, accepted: true, id }, { status: 202 });
}
