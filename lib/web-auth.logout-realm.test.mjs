import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Sign-out works by making the browser cache *invalid* Basic credentials for
 * this origin. Browsers key that cache by (origin, realm), so a 401 that names
 * a different realm writes to a different slot and leaves the real credentials
 * in place — the logout request returns 200 and nothing appears to happen.
 *
 * These tests pin every challenge response to the single shared constant.
 */

const CHALLENGE_SOURCES = [
  "../app/api/logout/route.ts",
  "../proxy.ts",
  "../lib/user-auth.ts",
];

test("every Basic-auth challenge is built from the shared realm constant", async () => {
  for (const relative of CHALLENGE_SOURCES) {
    const source = await readFile(new URL(relative, import.meta.url), "utf-8");
    const importsConstant =
      /import\s*\{[^}]*PI_WEB_AUTH_CHALLENGE[^}]*\}\s*from/.test(source);
    assert.ok(
      importsConstant,
      `${relative} must import PI_WEB_AUTH_CHALLENGE so its realm cannot drift`,
    );
    assert.match(
      source,
      /"WWW-Authenticate":\s*PI_WEB_AUTH_CHALLENGE/,
      `${relative} must use PI_WEB_AUTH_CHALLENGE for WWW-Authenticate`,
    );
  }
});

test("the realm constant is defined once, and matches the login challenge", async () => {
  const source = await readFile(new URL("./web-auth.ts", import.meta.url), "utf-8");

  assert.match(source, /export const PI_WEB_AUTH_REALM = "Pi Web";/);
  assert.match(
    source,
    /export const PI_WEB_AUTH_CHALLENGE = `Basic realm="\$\{PI_WEB_AUTH_REALM\}", charset="UTF-8"`;/,
  );

  // Exactly one definition of each constant across the app sources.
  for (const name of ["PI_WEB_AUTH_REALM", "PI_WEB_AUTH_CHALLENGE"]) {
    assert.equal(
      source.match(new RegExp(`export const ${name}\\b`, "g"))?.length,
      1,
      `${name} must be defined exactly once`,
    );
  }
});

test("no source hardcodes a realm literal (the original logout bug)", async () => {
  // Any literal realm other than via the constant is a drift hazard. This is
  // what shipped as `Basic realm="pi-web"` while every other 401 said
  // `Basic realm="Pi Web"`, silently breaking sign-out.
  for (const relative of CHALLENGE_SOURCES) {
    const source = await readFile(new URL(relative, import.meta.url), "utf-8");
    assert.doesNotMatch(
      source,
      /Basic realm="/,
      `${relative} must not inline a realm literal; use PI_WEB_AUTH_CHALLENGE`,
    );
  }
});
