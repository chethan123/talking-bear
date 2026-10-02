// Prints the precache manifest URLs of a built dist dir's sw.js, one per line, each once, in order of first
// appearance (plan §4.10 "Total precache"; issue #105). `.size-limit.cjs` measures the total precache budget
// over this list.
//
//   node scripts/precache-list.mjs [distDir]      (distDir defaults to dist)
//
// Exit 0 after printing the list. Exit 1, printing no URL, on a usage error, when sw.js can't be read or
// lists no URL, or when a URL has no file in distDir: a 404 in the precache makes the service worker install
// fail, which breaks offline use, so such a URL is never skipped or counted as 0 bytes. A URL matches a file
// when it equals the file's dist-relative POSIX path: the comparison that check-dist.mjs rule 1 makes in the
// other direction.

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listFiles, precacheUrls } from './check-dist.mjs';

/**
 * The precache URLs of `<distDir>/sw.js`. Throws if sw.js can't be read or lists no URL, or if a URL has no
 * file in distDir; the message names every such URL, one per line.
 * @param {string} distDir
 * @returns {string[]}
 */
export function precacheList(distDir) {
  const urls = precacheUrls(readFileSync(join(distDir, 'sw.js'), 'utf8'));
  if (urls.length === 0) throw new Error(`${distDir}/sw.js lists no precache URLs`);
  const files = new Set(listFiles(distDir));
  const missing = urls.filter((url) => !files.has(url));
  if (missing.length > 0) {
    throw new Error(
      missing
        .map((url) => `precache URL ${url} has no file in ${distDir} (the service worker install would fail)`)
        .join('\n'),
    );
  }
  return urls;
}

function main() {
  const args = process.argv.slice(2);
  const [dist = 'dist'] = args;
  if (args.length > 1 || dist === '') {
    console.error('usage: node scripts/precache-list.mjs [distDir]');
    process.exitCode = 1;
    return;
  }
  let urls;
  try {
    urls = precacheList(dist);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    for (const line of text.split('\n')) console.error(`precache-list: ${line}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${urls.join('\n')}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main();
