// Plan §4.7 check-dist rule "no `__bearTest` in production" (issue #36; the full check-dist comes in M6): the
// e2e test hooks sit behind `if (import.meta.env.VITE_BEAR_TEST_HOOKS === '1')`, so a production build must not
// contain the string anywhere.
//
//   node scripts/check-no-hooks.ts <distDir>
//
// Exit 0 when <distDir> holds at least one file and no file under it (recursively, any type) contains
// `__bearTest`; exit 1 otherwise, listing every file that does.
//
// Run by Node with type stripping: erasable TypeScript syntax only.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NEEDLE = '__bearTest';

function main(args: readonly string[]): number {
  const dist = args[0];
  if (dist === undefined || dist === '') {
    console.error('usage: node scripts/check-no-hooks.ts <distDir>');
    return 1;
  }
  let files: string[];
  try {
    files = readdirSync(dist, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name))
      .toSorted();
  } catch (err) {
    console.error(`check-no-hooks: cannot read ${dist}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (files.length === 0) {
    console.error(`check-no-hooks: ${dist} contains no files (build first)`);
    return 1;
  }
  const hits = files.filter((f) => readFileSync(f).includes(NEEDLE));
  if (hits.length > 0) {
    console.error(`check-no-hooks: ${hits.length} file(s) under ${dist} contain ${NEEDLE}:`);
    for (const f of hits) console.error(`  ${f}`);
    return 1;
  }
  console.log(`check-no-hooks: ${files.length} files under ${dist}, none contains ${NEEDLE}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
