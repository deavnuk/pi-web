import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();

  // Multi-user isolation is not optional: every user's agent worker, PTY
  // terminal, MCP stdio server and `npx` install runs inside bubblewrap. A host
  // that cannot start bwrap would silently serve sessions that can read each
  // other, so say so once at startup instead of failing per request (SB-4).
  void import("@/lib/user-sandbox")
    .then(({ isSandboxAvailable }) => {
      if (isSandboxAvailable()) return;
      console.error(
        "[sandbox] bubblewrap (bwrap) cannot start: user sessions, terminals and MCP "
        + "servers will be refused. Install bubblewrap and enable unprivileged user "
        + "namespaces (see docs/multiuser/production-runbook.md).",
      );
    })
    .catch(() => undefined);

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();

  // Graceful shutdown: tear down agent workers alongside the session
  // registry's own SIGINT/SIGTERM hooks (lib/rpc-manager.ts).
  const shutdownWorkers = async () => {
    try {
      const { destroyAllWorkers } = await import("@/lib/agent-worker-manager");
      void destroyAllWorkers();
    } catch {
      // workers may already be gone
    }
  };
  const shutdown = () => {
    shutdownStreams();
    void shutdownWorkers();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Scheduled SkillHub git auto-update: re-pull the last repo-sync source and
  // push new versions to @latest users. Interval via
  // PI_SMARTFICC_GIT_AUTOUPDATE_MINUTES (minutes; 0 disables, default 0).
  const minutes = Number(process.env.PI_SMARTFICC_GIT_AUTOUPDATE_MINUTES ?? "0");
  if (Number.isFinite(minutes) && minutes > 0) {
    void (async () => {
      try {
        const { autoUpdateGitSkills } = await import("@/lib/skill-registry");
        const tick = () => {
          try {
            const result = autoUpdateGitSkills();
            if (!result.skipped && (result.updated.length || result.added.length)) {
              console.log(
                `[skillhub] auto-update: commit ${result.commit} +${result.added.length} ~${result.updated.length} usersSynced=${result.usersSynced ?? 0}`,
              );
            } else if (result.errors?.length) {
              console.warn(`[skillhub] auto-update errors: ${JSON.stringify(result.errors).slice(0, 300)}`);
            }
          } catch (error) {
            console.warn(`[skillhub] auto-update failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        };
        // First tick shortly after boot, then on the interval.
        setTimeout(tick, 30_000).unref();
        setInterval(tick, minutes * 60_000).unref();
      } catch (error) {
        console.warn(`[skillhub] auto-update init failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }
}
