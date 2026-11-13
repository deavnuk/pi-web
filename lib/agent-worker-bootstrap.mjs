/**
 * Bootstrap for the per-user agent worker process.
 *
 * The worker host is a TypeScript lib source with path aliases; jiti (already
 * a pi-web devDependency) transpiles it on the fly. Kept as a .mjs file so the
 * spawn command stays a plain node invocation.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const webRoot = process.env.PI_SMARTFICC_WEB_DIR
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let jitiFactory;
try {
  jitiFactory = require("jiti");
} catch (error) {
  console.error("[agent-worker] cannot load jiti:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const factory = jitiFactory.createJiti ?? jitiFactory.default ?? jitiFactory;
const jiti = factory(import.meta.url, {
  interopDefault: true,
  moduleCache: true,
  alias: { "@": webRoot },
});

const hostPath = path.join(webRoot, "lib", "agent-worker-host.ts");
try {
  jiti(hostPath);
} catch (error) {
  console.error("[agent-worker] failed to load host:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
