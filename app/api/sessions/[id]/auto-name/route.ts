import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession, AgentSessionWrapper, isWorkerSessionProxy } from "@/lib/rpc-manager";
import { ownsLiveSession } from "@/lib/session-ownership";
import { requireAuth } from "@/lib/user-auth";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Names a session inside the caller's own tree: it resolves an id and writes
  // a title into the file, so both steps are scoped to their agentDir.
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;
  const { id } = await params;

  try {
    const filePath = await resolveSessionPath(id, user.agentDir);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const live = getRpcSession(id);
    const existing = live && ownsLiveSession(live, user) ? live : undefined;
    // Worker-proxied sessions (multi-user) live in another process: their
    // AgentSession, model config and credentials are worker-side, so title
    // generation cannot run here. The client treats this as a soft failure.
    // Structural check (not instanceof): this route bundle's class copy does
    // not recognize proxies registered by the instrumentation/scheduler bundle.
    if (isWorkerSessionProxy(existing)) {
      return NextResponse.json(
        { error: "Auto-naming is not available for this session" },
        { status: 501 },
      );
    }
    let session: AgentSessionWrapper;
    if (existing?.isAlive() && ownsLiveSession(existing, user)) {
      session = existing;
    } else {
      const started = await startRpcSession(id, filePath, undefined, { user });
      session = started.session as AgentSessionWrapper;
    }

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner as unknown as AgentSession);

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
