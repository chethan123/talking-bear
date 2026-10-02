// Size budgets (plan §4.10; issue #105). `pnpm size-limit` runs after `pnpm build` and check-dist and before
// precompression (plan §9), so it measures exactly the dist that ships. With @size-limit/file each file is
// compressed on its own with brotli (quality 11, size-limit's default) and the sizes are summed. size-limit
// reads "KB" and "MB" as SI units: 1 KB = 1000 B ("KiB" would be 1024 B).
//
// Hashed file names change on every build, so the entries are computed from dist when this file loads:
//   initial JS      every <script src> and <link rel="modulepreload"> in dist/index.html (the entry chunk and
//                   its preloads), plus every chunk they statically import, transitively
//   initial CSS     every <link rel="stylesheet"> in dist/index.html
//   total precache  every URL that scripts/precache-list.mjs prints for dist/sw.js (it exits 1 on a URL with
//                   no file in dist, so a missing file is never skipped or counted as 0 bytes)
// A reference with no file in dist, an entry with no files, or a file name that size-limit would read as a
// glob pattern throws here, so size-limit exits 1 instead of measuring less than ships.

const { spawnSync } = require('node:child_process');
const { readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const DIST = 'dist';
/** A stand-in origin for resolving index.html's root-relative URLs and the chunks' relative imports. */
const ORIGIN = 'https://dist.invalid';
/** An HTML comment; `[!]` keeps the pattern from reading as markup. */
const COMMENT = /<[!]--[\s\S]*?-->/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
/**
 * A static import in a built chunk, at a statement start (the start of the file, or after `;`, `}`, a
 * comment's closing `/` or a line break): `import{a as b}from"./x.js"`, `import"./x.js"`,
 * `export*from"./x.js"`. A dynamic `import("./x.js")` has a parenthesis and doesn't match. A false match
 * inside a string literal can only add a file, or throw if it names none. Every quoted specifier is followed,
 * so an unexpected one (absolute, bare, off-site) is counted or fails here instead of being skipped.
 * Arbitrary-name imports (import{"a-b" as c}from…) are not matched; Vite chunks export identifier names only.
 */
const STATIC_IMPORT = /(?:^|[;}/\n])[ \t]*(?:import|export)\s*(?:[\w$\s{},*]*?from\s*)?["']([^"']+)["']/g;
/** Characters that size-limit's glob (node:fs/promises glob) reads as pattern syntax. */
const GLOB_MAGIC = /[*?[\]{}()!+@\\]/;

/**
 * Throws unless the dist-relative `path` names a regular file that size-limit can take literally; returns it
 * relative to this file's directory, which size-limit resolves paths against.
 * @param {string} path
 * @param {string} what
 */
function distFile(path, what) {
  if (GLOB_MAGIC.test(path)) throw new Error(`${what} ${path}: size-limit would read this name as a glob`);
  let isFile = false;
  try {
    isFile = statSync(join(__dirname, DIST, path)).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new Error(`${what} ${path} has no file in ${DIST}`);
  return `${DIST}/${path}`;
}

/**
 * The dist-relative path that `ref`, found in the dist file `from`, points to. Throws for another origin.
 * @param {string} ref
 * @param {string} from
 */
function resolveRef(ref, from) {
  const url = new URL(ref, `${ORIGIN}/${from}`);
  if (url.origin !== ORIGIN) throw new Error(`${from} references ${ref}, which is not in ${DIST}`);
  return decodeURIComponent(url.pathname).slice(1);
}

/**
 * The attributes of every `<name>` tag in `html` (comments removed), as maps from lower-case names to values.
 * @param {string} html
 * @param {string} name
 */
function tags(html, name) {
  const text = html.replace(COMMENT, '');
  return Array.from(text.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi')), ([, attrs = '']) => {
    /** @type {Map<string, string>} */
    const map = new Map();
    for (const m of attrs.matchAll(ATTR)) map.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
    return map;
  });
}

/**
 * @param {Map<string, string>} attrs
 * @param {string} rel
 */
function hasRel(attrs, rel) {
  return (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes(rel);
}

/**
 * The size-limit paths of one entry; throws if there are none.
 * @param {string} name
 * @param {string[]} paths
 */
function nonEmpty(name, paths) {
  if (paths.length === 0) throw new Error(`${name}: no files found in ${DIST}`);
  return paths;
}

function initialEntries() {
  const html = readFileSync(join(__dirname, DIST, 'index.html'), 'utf8');
  const links = tags(html, 'link');
  const roots = [
    ...tags(html, 'script').map((attrs) => attrs.get('src')),
    ...links.filter((attrs) => hasRel(attrs, 'modulepreload')).map((attrs) => attrs.get('href')),
  ]
    .filter((ref) => ref !== undefined)
    .map((ref) => resolveRef(ref, 'index.html'));
  // Breadth-first over the static import graph, each chunk once; a chunk is checked before it is read.
  const chunks = [...new Set(roots)];
  const js = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] ?? '';
    const file = distFile(chunk, 'initial JS');
    js.push(file);
    for (const [, spec = ''] of readFileSync(join(__dirname, file), 'utf8').matchAll(STATIC_IMPORT)) {
      const dep = resolveRef(spec, chunk);
      if (!chunks.includes(dep)) chunks.push(dep);
    }
  }
  const css = links
    .filter((attrs) => hasRel(attrs, 'stylesheet'))
    .map((attrs) => attrs.get('href'))
    .filter((ref) => ref !== undefined)
    .map((ref) => distFile(resolveRef(ref, 'index.html'), 'initial CSS'));
  return { js: nonEmpty('initial JS', js), css: nonEmpty('initial CSS', css) };
}

function precacheEntry() {
  const run = spawnSync(process.execPath, ['scripts/precache-list.mjs', DIST], {
    cwd: __dirname,
    encoding: 'utf8',
  });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) {
    throw new Error(`scripts/precache-list.mjs failed (${run.status ?? run.signal}):\n${run.stderr.trim()}`);
  }
  const urls = run.stdout.split('\n').filter((line) => line !== '');
  return nonEmpty(
    'total precache',
    urls.map((url) => distFile(url, 'precache URL')),
  );
}

const initial = initialEntries();

module.exports = [
  { name: 'initial JS', path: initial.js, limit: '60 KB' },
  { name: 'initial CSS', path: initial.css, limit: '10 KB' },
  { name: 'total precache', path: precacheEntry(), limit: '1 MB' },
];
