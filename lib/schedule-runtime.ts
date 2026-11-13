import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SchedulerDependencies } from "./schedule-runner";

/**
 * Real (non-test) dependencies for the scheduled-task runner.
 *
 * Lives outside instrumentation.ts so the "run now" API route can execute a
 * task through exactly the same path the timer uses — a second, hand-rolled
 * wiring is how the two drift and one of them quietly stops notifying.
 */
export async function buildSchedulerDependencies(): Promise<SchedulerDependencies> {
  const [userStore, userAuth, rpc, push, fileAccess, pathSecurity] = await Promise.all([
    import("./user-store"),
    import("./user-auth"),
    import("./rpc-manager"),
    import("./web-push"),
    import("./file-access"),
    import("./path-security"),
  ]);

  return {
    listUsers: () => userStore.listUsers(),
    buildUserContext: (stored) => {
      const full = userStore.findUserByUsername(stored.username);
      if (!full) throw new Error(`Unknown user: ${stored.username}`);
      return userAuth.buildUserContext(full);
    },
    startSession: async ({ cwd, sessionKey, user }) => {
      // The same entry point /api/agent/new uses: passing `user` routes through
      // the worker, which gives the run the owner's agentDir, secrets, persona
      // and allowedRoots for free.
      const { session, realSessionId } = await rpc.startRpcSession(sessionKey, "", cwd, { user });
      return {
        realSessionId,
        isRunning: () => session.isRunning(),
        send: (command) => session.send(command),
        /**
         * A failed model call leaves the session idle, so this is the only
         * signal that the run produced no answer. The worker is the authority
         * and reports it in `get_state`; asking it is one round trip, worth it
         * once per run.
         */
        lastError: async () => {
          try {
            const state = await session.send({ type: "get_state" }) as { lastError?: unknown };
            return typeof state?.lastError === "string" && state.lastError !== "" ? state.lastError : null;
          } catch {
            return null;
          }
        },
      };
    },
    notify: (sessionId, userId) => push.notifySessionComplete(sessionId, userId),
    defaultCwdFor: (user) => {
      const dir = join(userStore.getDataRoot(), "projects", user.username);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      return dir;
    },
    isCwdAllowed: async (cwd, user) => {
      const allowed = await fileAccess.getAllowedFileRoots(user);
      return pathSecurity.isPathWithinRoots(cwd, allowed);
    },
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
  };
}

export async function getSchedulerDataRoot(): Promise<string> {
  const userStore = await import("./user-store");
  return userStore.getDataRoot();
}
