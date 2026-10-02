// Precompression for the image (plan §4.8.2, issue #104). It writes a brotli `.br` and a gzip `.gz` sibling next to
// every compressible file of a built dist dir, using only Node's zlib:
//
//   node scripts/precompress.mjs <distDir>
//
// Exit 0 after printing a table (file, raw, br, gz: sizes in bytes, `-` where no variant was written) and a summary
// line. Exit 1 on a usage error or when the dir or a file can't be read or written.
// Plain Node ESM without package dependencies (it reuses listFiles from check-dist.mjs): the Dockerfile's web stage
// (plan §4.8.2, #106) runs it as the last step on the dist it embeds (build → check-dist → size-limit → precompress,
// plan §9), so check-dist and size-limit see the uncompressed bytes. main() runs only when this file is executed
// directly; the tests import the helpers.
//
// Rules:
//   1. Only files whose last extension is html, js, css, json, webmanifest, svg or bin, in any letter case (the Go
//      server looks up MIME types the same way, server/headers.go). Everything else, `.wav` above all (plan §4.8.3:
//      never precompressed), is never read, written or removed, and neither are its siblings. `.br` and `.gz` are
//      not in the list, so a re-run never compresses a variant.
//   2. Files under MIN_BYTES (1 KB) get no variants.
//   3. Brotli quality 11, lgwin 24 (a 16 MB window), with the file size as the size hint; gzip level 9.
//   4. br and gz are judged separately: a variant is kept only if it saves at least 5 % of the raw size.
//   5. Idempotent. Each variant is removed first and written again only if it qualifies, so a re-run overwrites
//      every variant with byte-identical output (zlib's gzip header carries MTIME 0), and a variant that no longer
//      qualifies does not survive. That removal is defensive: server/handler.go serves any `<file>.br`/`<file>.gz`
//      sibling verbatim, so a stale one would serve old bytes. In normal use precompress follows a fresh
//      `vite build`, which empties dist, so a stale variant only appears when a built file is edited in place and
//      precompress runs again. Orphans (`x.js.br` without `x.js`) are no output of this run and are left alone.
//      Removing before writing also means a symlink at a variant's path is replaced, never followed.

import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { listFiles } from './check-dist.mjs';

/** File extensions that get .br/.gz siblings (plan §4.8.2). Never wav. */
export const EXTENSIONS = ['html', 'js', 'css', 'json', 'webmanifest', 'svg', 'bin'];
/** Files smaller than this many bytes get no variants. */
export const MIN_BYTES = 1024;
/** A variant must save at least raw / SAVING_DIVISOR bytes (5 %). Integer arithmetic: no rounding at the edge. */
const SAVING_DIVISOR = 20;

/**
 * @typedef {object} Row
 * @property {string} file dist-relative POSIX path
 * @property {number} raw size in bytes
 * @property {number | null} br size of the written .br, or null when none was written
 * @property {number | null} gz size of the written .gz, or null when none was written
 */

/**
 * Whether `path` has one of the EXTENSIONS (its last extension, in any letter case).
 * @param {string} path
 * @returns {boolean}
 */
export function isEligible(path) {
  return EXTENSIONS.includes(extname(path).slice(1).toLowerCase());
}

/**
 * Whether a variant of `compressed` bytes saves at least 5 % of `raw` bytes.
 * @param {number} raw
 * @param {number} compressed
 * @returns {boolean}
 */
export function keepVariant(raw, compressed) {
  return (raw - compressed) * SAVING_DIVISOR >= raw;
}

/**
 * The brotli options for a file of `size` bytes: quality 11, lgwin 24, and the size as the hint.
 * @param {number} size
 * @returns {{ params: Record<number, number> }}
 */
export function brotliOptions(size) {
  return {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: size,
    },
  };
}

/**
 * @param {Uint8Array} data
 * @returns {Buffer}
 */
export function brotli(data) {
  return brotliCompressSync(data, brotliOptions(data.length));
}

/**
 * @param {Uint8Array} data
 * @returns {Buffer}
 */
export function gzip(data) {
  return gzipSync(data, { level: 9 });
}

/**
 * Removes `path`, then writes `compressed` there if it qualifies (rule 5).
 * @param {string} path
 * @param {number} raw
 * @param {Uint8Array | null} compressed null for a file under MIN_BYTES
 * @returns {number | null} the size written, or null when no variant was written
 */
function writeVariant(path, raw, compressed) {
  rmSync(path, { force: true });
  if (compressed === null || !keepVariant(raw, compressed.length)) return null;
  writeFileSync(path, compressed);
  return compressed.length;
}

/**
 * Writes or removes the .br and .gz siblings of every eligible file under `distDir`. Throws if a file can't be read
 * or written.
 * @param {string} distDir
 * @returns {Row[]} one row per eligible file, sorted by path
 */
export function precompress(distDir) {
  /** @type {Row[]} */
  const rows = [];
  // The list is taken once, before any write, and .br/.gz are not eligible: variants are never compressed again.
  for (const file of listFiles(distDir).filter(isEligible)) {
    const path = join(distDir, file);
    const data = readFileSync(path);
    const big = data.length >= MIN_BYTES;
    rows.push({
      file,
      raw: data.length,
      br: writeVariant(`${path}.br`, data.length, big ? brotli(data) : null),
      gz: writeVariant(`${path}.gz`, data.length, big ? gzip(data) : null),
    });
  }
  return rows;
}

/** @param {number | null} n */
function sizeCell(n) {
  return n === null ? '-' : String(n);
}

/**
 * The summary table: a header and one line per row; the file column left-aligned, the sizes right-aligned.
 * @param {readonly Row[]} rows
 * @returns {string}
 */
export function formatTable(rows) {
  const cells = [
    ['file', 'raw', 'br', 'gz'],
    ...rows.map((r) => [r.file, String(r.raw), sizeCell(r.br), sizeCell(r.gz)]),
  ];
  const widths = [0, 1, 2, 3].map((i) => Math.max(...cells.map((c) => c[i].length)));
  return cells
    .map((c) => c.map((s, i) => (i === 0 ? s.padEnd(widths[i]) : s.padStart(widths[i]))).join('  '))
    .join('\n');
}

/** @param {unknown} err */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}

function main() {
  const args = process.argv.slice(2);
  const [dist] = args;
  if (args.length !== 1 || dist === undefined || dist === '') {
    console.error('usage: node scripts/precompress.mjs <distDir>');
    process.exitCode = 1;
    return;
  }
  /** @type {Row[]} */
  let rows;
  try {
    rows = precompress(dist);
  } catch (err) {
    console.error(`precompress: ${dist}: ${message(err)}`);
    process.exitCode = 1;
    return;
  }
  /** @param {'br' | 'gz'} key */
  const count = (key) => rows.filter((r) => r[key] !== null).length;
  console.log(formatTable(rows));
  console.log(
    `precompress: ${dist}: ${rows.length} eligible files, ${count('br')} .br and ${count('gz')} .gz written`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main();
