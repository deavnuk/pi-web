import { execFile } from "child_process";
import { promisify } from "util";
import { nodeCliInvocation } from "./node-cli";
import { sandboxCommandForUser } from "./user-sandbox-roots";
import type { UserContext } from "./user-auth";

const execFileAsync = promisify(execFile);

export interface RunNpxOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Run the install inside this account's sandbox.
   *
   * `npx` fetches and executes third-party code, so it must not run with the
   * host's filesystem in view (sandbox-design.md S5). `cwd` is mounted too: a
   * project install writes into it.
   */
  user?: UserContext | null;
}

export interface RunNpxResult {
  stdout: string;
  stderr: string;
}

/**
 * Cross-platform wrapper for invoking `npx <args>` without ever using a
 * shell, so user-controlled arguments are never interpreted as shell syntax.
 * See `lib/node-cli.ts` for why the bundled `npx-cli.js` is preferred over the
 * `npx` (or `npx.cmd`) on PATH.
 */
export async function runNpx(args: string[], opts: RunNpxOptions = {}): Promise<RunNpxResult> {
  const invocation = nodeCliInvocation("npx", args);
  // No user means a caller this fork does not have (an unauthenticated route);
  // running an unisolated npx there would be a hole, so it is refused loudly.
  if (!opts.user) {
    throw new Error("npx must run inside a user's sandbox: no account was given");
  }
  const sandboxed = sandboxCommandForUser(opts.user, invocation.command, invocation.args, opts.cwd ? [opts.cwd] : []);
  return execFileAsync(sandboxed.command, sandboxed.args, {
    timeout: opts.timeout,
    cwd: opts.cwd,
    env: opts.env,
  });
}
