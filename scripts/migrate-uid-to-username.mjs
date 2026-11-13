#!/usr/bin/env node
// One-time migration: per-user directories keyed by internal user id
// (users/<uid>, projects/<uid>) → keyed by username (users/<username>,
// projects/<username>). Also rewrites session files so recorded cwd paths
// follow, and renames the per-cwd session subdirectories accordingly.
//
// Idempotent: already-migrated users are skipped. Run with the server STOPPED.
//
// Usage: PI_WEB_DATA_DIR=~/.pi-web-multiuser-prod node scripts/migrate-uid-to-username.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";

const jiti = (await import("jiti")).createJiti(import.meta.url);
const userStore = await jiti.import("../lib/user-store.ts");

const dataRoot = userStore.getDataRoot();
// Sessions record absolute cwd paths. When rehearsing the migration on a
// COPY placed at a different path, point PI_SMARTFICC_LEGACY_DATA_ROOT at
// the original root so recorded paths get rewritten too.
const legacyDataRoot = process.env.PI_SMARTFICC_LEGACY_DATA_ROOT?.trim() || dataRoot;
const users = userStore.listUsers();
console.log(`data root: ${dataRoot}; ${users.length} user(s)`);

function slugOf(cwd) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function rewriteSessions(agentDir, fromPath, toPath) {
  const sessionsRoot = `${agentDir}/sessions`;
  if (!existsSync(sessionsRoot)) return;
  for (const sub of readdirSync(sessionsRoot)) {
    const subdir = `${sessionsRoot}/${sub}`;
    let touched = false;
    let files = [];
    try {
      files = readdirSync(subdir).filter((f) => f.endsWith(".jsonl")).map((f) => `${subdir}/${f}`);
    } catch { /* not a directory */ }
    for (const file of files) {
      const raw = readFileSync(file, "utf8");
      if (raw.includes(fromPath)) {
        writeFileSync(file, raw.split(fromPath).join(toPath), "utf8");
        touched = true;
      }
    }
    // Rename the per-cwd subdirectory when its slug embeds the old path.
    if (sub.includes(fromPath.replace(/[/\\:]/g, "-"))) {
      const oldSlugSegment = sub; // slug form already
      const newSlug = oldSlugSegment.split(fromPath.replace(/[/\\:]/g, "-")).join(toPath.replace(/[/\\:]/g, "-"));
      const newSub = `${sessionsRoot}/${newSlug}`;
      if (!existsSync(newSub)) {
        renameSync(subdir, newSub);
        console.log(`  session dir: ${sub} → ${newSlug}`);
        touched = true;
      }
    }
    if (touched && files.length > 0) console.log(`  rewrote ${files.length} session file(s) under ${sub}`);
  }
}

let migrated = 0;
for (const user of users) {
  const uidDir = `${dataRoot}/users/${user.id}`;
  const usernameDir = `${dataRoot}/users/${user.username}`;
  const uidProjects = `${dataRoot}/projects/${user.id}`;
  const usernameProjects = `${dataRoot}/projects/${user.username}`;

  // Path form as recorded inside session files (may reference the legacy root).
  const recordedOld = `${legacyDataRoot}/projects/${user.id}`;
  const recordedNew = `${dataRoot}/projects/${user.username}`;

  if (existsSync(uidDir) && uidDir !== usernameDir) {
    if (existsSync(usernameDir)) {
      console.error(`!! ${user.username}: users/${user.username} already exists; skipping (manual merge needed)`);
      continue;
    }
    renameSync(uidDir, usernameDir);
    console.log(`users/${user.id} → users/${user.username}`);
  }
  if (existsSync(uidProjects) && uidProjects !== usernameProjects) {
    if (existsSync(usernameProjects)) {
      console.error(`!! ${user.username}: projects/${user.username} already exists; skipping (manual merge needed)`);
    } else {
      renameSync(uidProjects, usernameProjects);
      console.log(`projects/${user.id} → projects/${user.username}`);
    }
  }
  if (existsSync(usernameDir)) {
    rewriteSessions(usernameDir, recordedOld, recordedNew);
  }
  migrated++;
}
console.log(`done: ${migrated}/${users.length} user(s) processed`);
