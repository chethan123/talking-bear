// The update spec's two builds (plan §4.9.3 `update`, issue #101): the e2e-mode app built twice, as v1 and v2.
//
//   node scripts/build-update-variants.mjs
//
// Runs `BEAR_BUILD_ID=<id> vite build --mode e2e --outDir dist-e2e-<id>` for v1, then v2 (both at the repo root;
// each build empties its own outDir, so it is idempotent). vite.config.ts puts the build id on <html> as
// `data-build`, so the two index.html files differ, and with them their precache revisions and sw.js: v2's
// sw.js is a new service worker for a page that v1's controls. e2e/update-proxy.mjs serves the two directories
// at one origin (port 4174); playwright.config.ts runs this script before starting it.
//
// Exit 1 if a build fails, or if the two builds' sw.js or index.html are identical: the spec's update would
// then never be found, so it would fail for the wrong reason.
// Plain Node ESM: it imports only node: modules, and runs the project's own Vite CLI with this Node.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root: this file is scripts/build-update-variants.mjs. */
const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** The build ids; each is built into dist-e2e-<id>. */
const VARIANTS = ['v1', 'v2'];
/** Vite's CLI, run with this Node, so the script doesn't depend on PATH. */
const VITE = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');

/**
 * Prints `message` and exits with status 1.
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`build-update-variants: ${message}`);
  process.exit(1);
}

for (const id of VARIANTS) {
  const outDir = `dist-e2e-${id}`;
  console.log(`build-update-variants: BEAR_BUILD_ID=${id} vite build --mode e2e --outDir ${outDir}`);
  const run = spawnSync(process.execPath, [VITE, 'build', '--mode', 'e2e', '--outDir', outDir], {
    cwd: ROOT,
    env: { ...process.env, BEAR_BUILD_ID: id },
    stdio: 'inherit',
  });
  if (run.error !== undefined) fail(`${id}: ${run.error.message}`);
  if (run.status !== 0) fail(`${id}: vite build exited with ${run.status ?? run.signal}`);
}

for (const file of ['sw.js', 'index.html']) {
  const [a, b] = VARIANTS.map((id) => readFileSync(join(ROOT, `dist-e2e-${id}`, file), 'utf8'));
  if (a === b) fail(`dist-e2e-v1/${file} and dist-e2e-v2/${file} are identical`);
}
console.log('build-update-variants: built dist-e2e-v1/ and dist-e2e-v2/; their sw.js and index.html differ');
