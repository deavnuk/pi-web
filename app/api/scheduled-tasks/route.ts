import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/user-auth";
import {
  createScheduledTask,
  listScheduledTasks,
  toTaskView,
  MAX_TASKS_PER_USER,
  ScheduleValidationError,
} from "@/lib/scheduled-tasks";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * GET /api/scheduled-tasks
 *
 * The caller's OWN tasks. There is deliberately no user parameter: tasks live
 * inside each user's agentDir, so scoping is structural rather than a filter
 * someone can forget (FR-7.2).
 */
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;


  const tasks = listScheduledTasks(user.agentDir)
    .map(toTaskView)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return NextResponse.json(
    { tasks, perUser: true, maxTasks: MAX_TASKS_PER_USER },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * POST /api/scheduled-tasks
 * body: { title, prompt, schedule: {kind, time?, weekday?, day?, at?, timezone?}, cwd? }
 */
export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;

  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 400 });
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const task = await createScheduledTask(user.agentDir, {
      title: body.title,
      prompt: body.prompt,
      schedule: body.schedule,
      cwd: body.cwd,
      createdBy: user.username,
    });
    return NextResponse.json({ task: toTaskView(task) }, { status: 201 });
  } catch (error) {
    const status = error instanceof ScheduleValidationError ? 400 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}
