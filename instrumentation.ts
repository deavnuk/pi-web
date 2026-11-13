export async function register(): Promise<void> {
  // Next builds this file for both the Node and the Edge instrumentation entry.
  // The Edge graph rejects Node APIs, so `process.on` and undici live in
  // ./instrumentation-node, reached only through this compile-time-eliminated
  // NEXT_RUNTIME branch. An early `return` instead of this `if` would leave the
  // Node calls in the Edge module.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeInstrumentation } = await import("./instrumentation-node");
    registerNodeInstrumentation();
    await bootstrapAdmin();
  }

  startScheduler();
}

/**
 * FR-6.1: on startup in multi-user mode, make sure a built-in admin exists and
 * adopts the machine's legacy single-user agentDir. Idempotent and a no-op in
 * single-user mode, so it never changes today's behavior (FR-6.2).
 */
async function bootstrapAdmin(): Promise<void> {
  try {
    const { bootstrapBuiltinAdmin } = await import("@/lib/user-store");
    await bootstrapBuiltinAdmin();
  } catch (error) {
    console.warn(`[bootstrap] built-in admin bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Scheduled tasks (design §14). Started here because instrumentation.ts is the
 * one place that runs exactly once per server process and can hold a timer.
 *
 * The actual work lives in lib/schedule-runner.ts so it can be tested without
 * booting Next.js; this function only supplies the real dependencies.
 */
function startScheduler(): void {
  const minutes = Number(process.env.PI_SMARTFICC_SCHEDULER_MINUTES ?? "1");
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log("[schedule] disabled (PI_SMARTFICC_SCHEDULER_MINUTES<=0)");
    return;
  }

  let running = false;
  const tick = async () => {
    if (running) return; // never let ticks overlap in-process
    running = true;
    try {
      const [runner, runtime] = await Promise.all([
        import("@/lib/schedule-runner"),
        import("@/lib/schedule-runtime"),
      ]);
      const result = await runner.runSchedulerTick(
        await runtime.buildSchedulerDependencies(),
        await runtime.getSchedulerDataRoot(),
      );

      if (result && result.started > 0) {
        console.log(`[schedule] tick: started ${result.started} run(s)`);
      }
    } catch (error) {
      console.warn(`[schedule] tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };

  // Short delay after boot so workers/registry are ready, then run promptly so
  // tasks missed while the server was down are caught up (C5 — the timer is
  // in-memory, so boot is the only chance to replay them).
  setTimeout(() => void tick(), 20_000).unref();
  setInterval(() => void tick(), minutes * 60_000).unref();
  console.log(`[schedule] scheduler started (every ${minutes}m)`);
}
