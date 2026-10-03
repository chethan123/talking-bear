// The installability spec's negative control (plan §4.9.3, issue #100): a copy of the e2e build whose manifest has
// no `purpose: "any"` icon, so Chrome's installability check must report an error for it.
//
//   node e2e/fixtures/bad-manifest/make.mjs
//
// Copies dist-e2e/ to dist-e2e-badmanifest/ (both at the repo root; the copy is replaced on every run, so it is
// idempotent) and rewrites the copy's manifest.webmanifest without its `any` icons (an icon without `purpose` is
// `any` too). With the app's manifest only the maskable icon stays, and Chrome needs an `any` icon of at least
// 144 px to install. The rest of the copy, the service worker included, is left as built: the spec only reads the
// installability errors. playwright.config.ts runs this script before serving the copy with `vite preview` on
// port 4175.
//
// Exit 1, without leaving a copy behind, if dist-e2e/ or its manifest is missing (run `pnpm build:e2e` first), if
// the manifest has no icons array or an icon that isn't an object, or if it has no `any` icon to remove: a copy
// identical to the real build would make the control vacuous.
// Plain Node ESM with no dependencies.

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root: this file is e2e/fixtures/bad-manifest/make.mjs. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = 'dist-e2e';
const DST = 'dist-e2e-badmanifest';
const MANIFEST = 'manifest.webmanifest';

/**
 * True for an icon the browser may use as `any`: its space-separated `purpose` includes "any" (in any letter
 * case, as Chrome lower-cases it), or it has none.
 * @param {object} icon
 * @returns {boolean}
 */
function isAnyIcon(icon) {
  const purpose = 'purpose' in icon ? icon.purpose : undefined;
  if (purpose === undefined) return true;
  return typeof purpose === 'string' && purpose.toLowerCase().split(/\s+/).includes('any');
}

/**
 * Prints `message` and exits with status 1.
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`bad-manifest: ${message}`);
  process.exit(1);
}

const src = join(ROOT, SRC);
const dst = join(ROOT, DST);
rmSync(dst, { recursive: true, force: true }); // a failed run leaves no stale copy for vite preview to serve
if (!existsSync(join(src, MANIFEST))) fail(`${SRC}/${MANIFEST} not found: run \`pnpm build:e2e\` first`);

/** @type {unknown} */
const manifest = JSON.parse(readFileSync(join(src, MANIFEST), 'utf8'));
if (
  typeof manifest !== 'object' ||
  manifest === null ||
  !('icons' in manifest) ||
  !Array.isArray(manifest.icons)
) {
  fail(`${SRC}/${MANIFEST} has no icons array`);
}
const notObject = manifest.icons.findIndex((icon) => typeof icon !== 'object' || icon === null);
if (notObject !== -1) {
  fail(
    `${SRC}/${MANIFEST}: icons[${notObject}] is not an object: ${JSON.stringify(manifest.icons[notObject])}`,
  );
}
const removed = manifest.icons.filter(isAnyIcon);
const kept = manifest.icons.filter((icon) => !isAnyIcon(icon));
if (removed.length === 0) fail(`${SRC}/${MANIFEST} has no purpose "any" icon to remove`);

cpSync(src, dst, { recursive: true });
// The copy's precompressed manifests, if a build ever ships them, would still be the real one.
for (const ext of ['.br', '.gz']) rmSync(join(dst, MANIFEST + ext), { force: true });
writeFileSync(join(dst, MANIFEST), JSON.stringify({ ...manifest, icons: kept }));
console.log(
  `bad-manifest: copied ${SRC}/ to ${DST}/; removed ${removed.length} purpose "any" icon(s) ` +
    `(${removed.map((icon) => icon.src).join(', ')}), kept ${kept.length}`,
);
