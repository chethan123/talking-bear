// The build gate (plan §4.7 "Build check", §9 "The shipped bytes are the checked bytes"; issue #99). It runs on a
// freshly built dist dir, before precompression, and subsumes the M1 worklet and no-hooks checks:
//
//   node scripts/check-dist.mjs <distDir> <production|e2e>
//
// Exit 0 when every rule passes. Exit 1 on a usage error or on any violation, after listing every violation.
// Plain Node ESM with no dependencies, so the Dockerfile's web stage can run it on the dist it embeds. #105 imports
// the helpers (precacheUrls, listFiles, …); main() runs only when this file is executed directly.
//
// Rules:
//   1. Precache completeness: every file under dist is in sw.js's precache list, except sw.js itself (Workbox never
//      precaches it), screenshots/** (installer only), *.br, *.gz, *.map, and a root workbox-*.js (the Workbox
//      runtime, if it is ever un-inlined; generateSW writes it next to sw.js). The exemption is anchored to the
//      root so the app's own assets/workbox-window.prod.es5-*.js stays checked.
//   2. No dist/**/*.js contains `data:text/javascript`, in any letter case.
//   3. production: no file (of any type) contains a test-hook needle (`__bearTest`, `setVadBackend`, #223).
//      e2e (positive control): each needle appears in at least one file. Requiring each needle, not just one, keeps
//      the production list honest: if a hook is renamed or removed, this fails in the same change, which is where
//      HOOK_NEEDLES must be updated.
//   4. Exactly one assets/capture.worklet-*.js, with no `import` (which covers `import.meta`), `document` or bare
//      `self`: an AudioWorkletGlobalScope has neither, and addModule() would resolve imports on the render thread.
//   5. dist/lab does not exist: lab pages, with their trace and download flows, never ship.
//   6. If any *.bin (the Silero weights) ships, licenses.txt exists and contains "Silero Team".
//   7. manifest.webmanifest parses as a JSON object with name "Talking Bear", and every icons[].src and
//      screenshots[].src names a file in dist (`/icons/…`; `//host/…` and absolute URLs fail).
//   8. The main JS chunk (the dist-relative src of index.html's `<script type="module" src>`) keeps the director's
//      hidden-class templates (#281, src/anim/director.ts: CLIP_TEMPLATE, REACTION_TEMPLATE, CUT_CLIP_TEMPLATE):
//      each is declared as an object literal with exactly its property list, in order, and some function returns a
//      spread of that declaration's variable (`return{...t,` or `=>({...t,`). A factory that returns a plain
//      literal with the same keys gets the same hidden class in V8 and passes every unbundled test, but lets the
//      bundler drop the template, and the shipped rAF frame allocates 2–3.5 KB again (#294).
//
// The observed sw.js (vite-plugin-pwa 1.3.0, generateSW, inlineWorkboxRuntime; checked on main 8034412) is one
// minified file without importScripts. precacheAndRoute is inlined and renamed, and its keys are unquoted:
//
//   …,function(t){O().precache(t)}([{url:"manifest.webmanifest",revision:"9c0c…"},{url:"licenses.txt",
//   revision:"cfe8…"},…,{url:"assets/index-CbmZyTFq.js",revision:null},…,{url:"manifest.webmanifest",
//   revision:"9c0c…"}]),…
//
// URLs are dist-relative; hashed assets have revision null. So PRECACHE_URL is a whole-file regex, not anchored to
// any call. The runtime's own `url` properties (`({url:e})`, `url:t.href`, …) have no quote after the colon, so
// it matches the precache entries and nothing else.
//
// manifest.webmanifest: 1.3.0 injects it into the precache itself (vite-plugin-pwa/dist/index.js:130-143 pushes
// {url: manifestFilename, revision} into workbox.additionalManifestEntries), and the `webmanifest` glob lists it
// again, so it appears twice with the same revision. Both are ordinary entries that PRECACHE_URL matches, so it
// needs no exemption and is checked like any other file. precacheUrls() returns each URL once.
//
// Oversize files: with 1.3.0 an asset over maximumFileSizeToCacheInBytes already fails `vite build` (the plugin
// turns Workbox's warning into an error by default), after writing an sw.js without it. Rule 1 is the second line
// of defence there, and the main guard against files outside workbox.globPatterns (e.g. wasm/onnx, plan §7 M2)
// and against plugin regressions.
//
// Rule 8 on main 83e9162 (rolldown's minifier; the same in the e2e build): the templates and their factories are
//
//   var rs={name:``,start:NaN},is={r:Wn.tuftBoing,clip:``,start:NaN,last:NaN,runStart:NaN,sfxAt:NaN,release:null,
//   region:null,gesture:null},as={name:``,start:NaN,cutAt:NaN,release:null};function os(e,t){return{...rs,name:e,
//   start:t}}…function cs(e,t,n,r){return{...as,name:e,start:t,cutAt:n,release:r}}
//
// So the rule matches property lists, never minified names: keys and their order are exact (the order is the
// hidden class), an empty string may use any quote style, a time is `NaN` or `Number.NaN`, whitespace is optional,
// and REACTION_TEMPLATE's `r` is any expression without `,{}()` (today `Wn.tuftBoing`). The variable a literal is
// declared as is captured only to look for its spread. "Inside a function body" is `return{...t` or `=>({...t`:
// both are only legal in a function, and they are the factory shapes; telling a module-level `{...t}` from one in a
// function would need a JS parser, and this script has no dependencies. A minifier that inlines a factory into
// another expression, uses Object.assign, or lowers the target to `_objectSpread` fails this rule, and that change
// then updates it. With today's bundler an unspread template is dropped, so the literal check fires; the spread
// check is defence in depth for a bundler that keeps it. Known gap: the spread check accepts `return{...t` anywhere
// in the chunk, so if a template were ever minified to the same name as a common local (`e`), an unrelated
// `return{...e,` would satisfy it; that only matters when a template survives without its spread.

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The two build modes: `pnpm build` (production) and `pnpm build:e2e` (e2e, with the test hooks). */
export const MODES = ['production', 'e2e'];
/** Strings that only the e2e test hooks put into a build. */
export const HOOK_NEEDLES = ['__bearTest', 'setVadBackend'];

const PRECACHE_URL = /["']?url["']?\s*:\s*["']([^"']+)["']/g;
const WORKLET_CHUNK = /^assets\/capture\.worklet-[^/]*\.js$/;
const WORKLET_FORBIDDEN = [/\bimport\b/, /\bdocument\b/, /(?:^|[^.\w$])self\b/];
const DATA_JS = 'data:text/javascript';
/** URI schemes and media types are case-insensitive. Not global, so `.test()` keeps no lastIndex state. */
const DATA_JS_RE = /data:text\/javascript/i;
const LICENCE_MARK = 'Silero Team';
const MANIFEST_NAME = 'Talking Bear';
/** Characters of context printed on each side of a forbidden worklet match. */
const CONTEXT = 60;

// Rule 8 regex fragments (strings, spliced into RegExp sources).
const IDENT = '[A-Za-z_$][\\w$]*';
/** Not preceded by an identifier character or a dot. */
const NOT_AFTER = '(?<![\\w$.])';
/** Not followed by an identifier character. */
const NOT_IDENT_NEXT = '(?![\\w$])';
const EMPTY_STRING = '(?:""|\'\'|``)';
const NAN = '(?:NaN|Number\\.NaN)';
/** REACTION_TEMPLATE.r is `REACTIONS['tuftBoing']`: any expression without a comma, brace or parenthesis. */
const EXPRESSION = '[^,{}()]+';
/** index.html's module script with a src; group 1 is the src. */
const MODULE_SCRIPT = /<script\b(?=[^>]*\btype\s*=\s*["']?module\b)[^>]*\bsrc\s*=\s*["']([^"']+)["']/i;
const TEMPLATES_SEE = 'src/anim/director.ts, #281';

/**
 * The director's hidden-class templates (#281): each one's property list in declaration order, as
 * [key, value regex source] pairs, and the shape printed when it is missing.
 * @type {readonly {name: string, factory: string, shape: string, props: readonly [string, string][]}[]}
 */
export const DIRECTOR_TEMPLATES = [
  {
    name: 'CLIP_TEMPLATE',
    factory: 'clipAt',
    shape: '{name:"",start:NaN}',
    props: [
      ['name', EMPTY_STRING],
      ['start', NAN],
    ],
  },
  {
    name: 'REACTION_TEMPLATE',
    factory: 'activeReaction',
    shape:
      '{r:REACTIONS.tuftBoing,clip:"",start:NaN,last:NaN,runStart:NaN,sfxAt:NaN,release:null,region:null,gesture:null}',
    props: [
      ['r', EXPRESSION],
      ['clip', EMPTY_STRING],
      ['start', NAN],
      ['last', NAN],
      ['runStart', NAN],
      ['sfxAt', NAN],
      ['release', 'null'],
      ['region', 'null'],
      ['gesture', 'null'],
    ],
  },
  {
    name: 'CUT_CLIP_TEMPLATE',
    factory: 'cutClip',
    shape: '{name:"",start:NaN,cutAt:NaN,release:null}',
    props: [
      ['name', EMPTY_STRING],
      ['start', NAN],
      ['cutAt', NAN],
      ['release', 'null'],
    ],
  },
];

/**
 * The precache URLs listed in an sw.js, each once, in order of first appearance.
 * @param {string} swSource
 * @returns {string[]}
 */
export function precacheUrls(swSource) {
  return [...new Set(Array.from(swSource.matchAll(PRECACHE_URL), (m) => m[1]))];
}

/**
 * Every file under `dir` (recursively, symlinked files included) as a sorted dist-relative POSIX path.
 * Throws if `dir` can't be read.
 * @param {string} dir
 * @returns {string[]}
 */
export function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((d) => ({ d, path: join(d.parentPath, d.name) }))
    .filter(({ d, path }) => d.isFile() || (d.isSymbolicLink() && statSync(path).isFile()))
    .map(({ path }) => relative(dir, path).split(sep).join('/'))
    .toSorted();
}

/**
 * Whether rule 1 lets this dist-relative path stay out of the precache.
 * @param {string} path
 * @returns {boolean}
 */
export function isPrecacheExempt(path) {
  return (
    path === 'sw.js' ||
    path.startsWith('screenshots/') ||
    /\.(?:br|gz|map)$/.test(path) ||
    /^workbox-[^/]*\.js$/.test(path)
  );
}

/** @param {unknown} err */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {string} text
 * @param {number} index
 * @param {number} length
 */
function snippet(text, index, length) {
  const from = Math.max(0, index - CONTEXT);
  const to = Math.min(text.length, index + length + CONTEXT);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

/**
 * @param {string[]} files
 * @param {Map<string, Buffer>} contents
 */
function checkPrecache(files, contents) {
  const sw = contents.get('sw.js');
  if (sw === undefined) return ['sw.js not found'];
  const urls = new Set(precacheUrls(sw.toString('utf8')));
  return files
    .filter((f) => !isPrecacheExempt(f) && !urls.has(f))
    .map(
      (f) =>
        `${f} is not in the sw.js precache list (outside workbox.globPatterns, or over maximumFileSizeToCacheInBytes)`,
    );
}

/**
 * @param {string[]} files
 * @param {Map<string, Buffer>} contents
 */
function checkNoDataJs(files, contents) {
  return files
    .filter((f) => f.endsWith('.js') && DATA_JS_RE.test(contents.get(f)?.toString('latin1') ?? ''))
    .map((f) => `${f} contains ${DATA_JS}`);
}

/**
 * @param {string[]} files
 * @param {Map<string, Buffer>} contents
 * @param {string} mode
 */
function checkHooks(files, contents, mode) {
  const hasNeedle = (f, needle) => contents.get(f)?.includes(needle) === true;
  if (mode === 'production') {
    return files.flatMap((f) =>
      HOOK_NEEDLES.filter((needle) => hasNeedle(f, needle)).map(
        (needle) => `${f} contains ${needle} (test hooks must not ship)`,
      ),
    );
  }
  return HOOK_NEEDLES.filter((needle) => !files.some((f) => hasNeedle(f, needle))).map(
    (needle) => `no file contains ${needle} (positive control: the e2e build must ship the test hooks)`,
  );
}

/**
 * @param {string[]} files
 * @param {Map<string, Buffer>} contents
 */
function checkWorklet(files, contents) {
  const chunks = files.filter((f) => WORKLET_CHUNK.test(f));
  const [chunk] = chunks;
  if (chunks.length !== 1 || chunk === undefined) {
    return [
      `expected exactly one assets/capture.worklet-*.js, found ${chunks.length}: ${JSON.stringify(chunks)}`,
    ];
  }
  const text = contents.get(chunk)?.toString('utf8') ?? '';
  return WORKLET_FORBIDDEN.flatMap((re) => {
    const m = re.exec(text);
    return m === null ? [] : [`${chunk} matches ${String(re)}: ${snippet(text, m.index, m[0].length)}`];
  });
}

/**
 * `<ident> = {k: v, …}` with exactly this property list: a declaration (or a plain assignment), not a property
 * assignment. Group 1 is the variable.
 * @param {readonly [string, string][]} props
 */
function templateRe(props) {
  const body = props.map(([key, value]) => `${key}\\s*:\\s*${value}`).join('\\s*,\\s*');
  return new RegExp(`${NOT_AFTER}(${IDENT})\\s*=\\s*\\{\\s*${body}\\s*\\}`, 'g');
}

/**
 * A function returning a copy of `ident`: `return{...ident` or `=>({...ident` (`=>{...` would be a block).
 * @param {string} ident
 */
function spreadRe(ident) {
  return new RegExp(
    `(?:${NOT_AFTER}return|=>\\s*\\()\\s*\\{\\s*\\.\\.\\.${ident.replaceAll('$', '\\$')}${NOT_IDENT_NEXT}`,
  );
}

/** @param {Map<string, Buffer>} contents */
function checkTemplates(contents) {
  const html = contents.get('index.html');
  if (html === undefined) return ['index.html not found'];
  const src = MODULE_SCRIPT.exec(html.toString('utf8'))?.[1];
  if (src === undefined) return ['index.html has no <script type="module" src> (the main JS chunk)'];
  const chunk = src.replace(/^\.?\//, '');
  const text = contents.get(chunk)?.toString('utf8');
  if (text === undefined) return [`main JS chunk ${chunk} (from index.html) not found`];
  return DIRECTOR_TEMPLATES.flatMap(({ name, factory, shape, props }) => {
    const idents = [...new Set(Array.from(text.matchAll(templateRe(props)), (m) => m[1]))];
    if (idents.length === 0) {
      return [
        `${chunk} has no ${name} literal ${shape} (${TEMPLATES_SEE}: the template's property list changed, or ` +
          `${factory} no longer copies it, so the bundler drops it and the shipped frame allocates again)`,
      ];
    }
    return idents.some((id) => spreadRe(id).test(text))
      ? []
      : [
          `${chunk} has ${name} (as ${idents.join(', ')}) but no function returns a spread of it ` +
            `(${TEMPLATES_SEE}: ${factory} must return { ...${name}, … })`,
        ];
  });
}

/** @param {string} distDir */
function checkNoLab(distDir) {
  return lstatSync(join(distDir, 'lab'), { throwIfNoEntry: false }) === undefined
    ? []
    : ['lab exists (lab pages must never ship)'];
}

/**
 * @param {string[]} files
 * @param {Map<string, Buffer>} contents
 */
function checkLicences(files, contents) {
  const bins = files.filter((f) => f.endsWith('.bin'));
  if (bins.length === 0) return [];
  const licences = contents.get('licenses.txt');
  if (licences === undefined) return [`licenses.txt is missing although weights ship: ${bins.join(', ')}`];
  return licences.includes(LICENCE_MARK) ? [] : [`licenses.txt does not contain "${LICENCE_MARK}"`];
}

/**
 * @param {string} distDir
 * @param {string[]} files
 * @param {Map<string, Buffer>} contents
 */
function checkManifest(distDir, files, contents) {
  const raw = contents.get('manifest.webmanifest');
  if (raw === undefined) return ['manifest.webmanifest not found'];
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return [`manifest.webmanifest is not valid JSON: ${message(err)}`];
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return ['manifest.webmanifest is not a JSON object'];
  }
  const out = [];
  if (manifest.name !== MANIFEST_NAME) {
    out.push(`name is ${JSON.stringify(manifest.name)}, expected "${MANIFEST_NAME}"`);
  }
  for (const key of ['icons', 'screenshots']) {
    const list = manifest[key];
    if (!Array.isArray(list)) {
      out.push(`${key} is not an array`);
      continue;
    }
    list.forEach((entry, i) => {
      // A src is site-root-relative (`/icons/…`) and must name a file in this dist's file list. Only one leading
      // slash is stripped: a protocol-relative `//host/…` or an absolute URL points off-site and fails.
      const src = typeof entry === 'object' && entry !== null ? entry.src : undefined;
      if (typeof src !== 'string') out.push(`${key}[${i}].src is not a string`);
      else if (!files.includes(src.replace(/^\//, ''))) {
        out.push(`${key}[${i}].src ${src} does not exist in ${distDir}`);
      }
    });
  }
  return out;
}

/**
 * Every rule violation in `distDir` for `mode`, each prefixed `rule <n> (<name>): `; empty when the build passes.
 * @param {string} distDir
 * @param {string} mode `production` or `e2e`
 * @returns {string[]}
 */
export function checkDist(distDir, mode) {
  if (!MODES.includes(mode)) return [`mode must be production or e2e, got ${JSON.stringify(mode)}`];
  /** @type {string[]} */
  let files;
  /** @type {Map<string, Buffer>} */
  let contents;
  try {
    files = listFiles(distDir);
    // Every file is read once here, so an unreadable one (EACCES, …) is a violation, not a stack trace.
    contents = new Map(files.map((f) => [f, readFileSync(join(distDir, f))]));
  } catch (err) {
    return [`cannot read ${distDir}: ${message(err)}`];
  }
  if (files.length === 0) return [`${distDir} contains no files (build first)`];
  /** @type {[string, string[]][]} */
  const rules = [
    ['1 (precache)', checkPrecache(files, contents)],
    ['2 (data-js)', checkNoDataJs(files, contents)],
    ['3 (hooks)', checkHooks(files, contents, mode)],
    ['4 (worklet)', checkWorklet(files, contents)],
    ['5 (lab)', checkNoLab(distDir)],
    ['6 (licences)', checkLicences(files, contents)],
    ['7 (manifest)', checkManifest(distDir, files, contents)],
    ['8 (templates)', checkTemplates(contents)],
  ];
  return rules.flatMap(([rule, violations]) => violations.map((v) => `rule ${rule}: ${v}`));
}

function main() {
  const args = process.argv.slice(2);
  const [dist, mode] = args;
  if (args.length !== 2 || dist === undefined || dist === '' || mode === undefined || !MODES.includes(mode)) {
    console.error('usage: node scripts/check-dist.mjs <distDir> <production|e2e>');
    process.exitCode = 1;
    return;
  }
  const violations = checkDist(dist, mode);
  if (violations.length > 0) {
    console.error(`check-dist: ${dist} (${mode}): ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v}`);
    process.exitCode = 1;
    return;
  }
  const files = listFiles(dist).length;
  const urls = precacheUrls(readFileSync(join(dist, 'sw.js'), 'utf8')).length;
  console.log(`check-dist: ${dist} (${mode}): all 8 rules pass (${files} files, ${urls} precache URLs)`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main();
