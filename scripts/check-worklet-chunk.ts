// X-T2 (plan §5): the built capture-worklet chunk must be self-contained. An AudioWorkletGlobalScope has no
// `document` and no `self`, and the chunk is loaded with `audioWorklet.addModule()`, so any `import` left by
// the bundler would be resolved on the render thread (or fail there).
//
//   node scripts/check-worklet-chunk.ts <distDir>
//
// Exit 0 when exactly one `assets/capture.worklet-*.js` exists and none of the forbidden patterns matches it;
// exit 1 otherwise, printing what was found. A match that turns out to be unavoidable bundler output must be
// reported on the task issue, never "fixed" by weakening a pattern.
//
// Run by Node with type stripping: erasable TypeScript syntax only.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CHUNK = /^capture\.worklet-.*\.js$/;
const FORBIDDEN: readonly RegExp[] = [/\bimport\b/, /\bdocument\b/, /(?:^|[^.\w$])self\b/];
/** Characters of context printed on each side of a forbidden match. */
const CONTEXT = 60;

function snippet(text: string, index: number, length: number): string {
  const from = Math.max(0, index - CONTEXT);
  const to = Math.min(text.length, index + length + CONTEXT);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

function main(args: readonly string[]): number {
  const dist = args[0];
  if (dist === undefined || dist === '') {
    console.error('usage: node scripts/check-worklet-chunk.ts <distDir>');
    return 1;
  }
  const assets = join(dist, 'assets');
  let names: string[];
  try {
    names = readdirSync(assets);
  } catch (err) {
    console.error(
      `check-worklet-chunk: cannot read ${assets}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const matches = names.filter((n) => CHUNK.test(n)).toSorted();
  const [chunk] = matches;
  if (matches.length !== 1 || chunk === undefined) {
    console.error(
      `check-worklet-chunk: expected exactly one assets/capture.worklet-*.js, found ${matches.length}: ${JSON.stringify(matches)}`,
    );
    return 1;
  }
  const file = join(assets, chunk);
  const text = readFileSync(file, 'utf8');
  let failed = false;
  for (const re of FORBIDDEN) {
    const m = re.exec(text);
    if (m !== null) {
      failed = true;
      console.error(
        `check-worklet-chunk: ${file} matches ${String(re)}: ${snippet(text, m.index, m[0].length)}`,
      );
    }
  }
  if (failed) return 1;
  console.log(`check-worklet-chunk: ${file}: self-contained (${Buffer.byteLength(text)} bytes)`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
