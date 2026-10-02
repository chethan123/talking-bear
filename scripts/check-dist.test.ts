// scripts/check-dist.mjs (issue #99, plan §4.7 "Build check"): every rule runs on small fake dist trees written
// to a temp dir: a complete tree that passes, and per rule at least one mutation that must fail with exactly that
// rule's violation. The CLI cases spawn Node on the script itself.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// check-dist.mjs is plain JavaScript without type declarations (the Dockerfile's web stage runs it with bare
// Node), so a static import fails `tsc -b` with TS7016. A computed specifier keeps tsc from resolving it, and the
// guard types the two exports the tests use.
interface CheckDistModule {
  precacheUrls: (swSource: string) => string[];
  checkDist: (distDir: string, mode: string) => string[];
}

function isCheckDist(m: unknown): m is CheckDistModule {
  return (
    typeof m === 'object' &&
    m !== null &&
    'precacheUrls' in m &&
    typeof m.precacheUrls === 'function' &&
    'checkDist' in m &&
    typeof m.checkDist === 'function'
  );
}

const SCRIPT_URL = new URL('./check-dist.mjs', import.meta.url);
const SCRIPT = fileURLToPath(SCRIPT_URL);
const loaded: unknown = await import(SCRIPT_URL.href);
if (!isCheckDist(loaded)) throw new Error('scripts/check-dist.mjs must export precacheUrls and checkDist');
const { precacheUrls, checkDist } = loaded;

type Mode = 'production' | 'e2e';
/** Dist-relative POSIX path → file content. */
type Tree = Record<string, string>;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-dist-'));
  tempDirs.push(dir);
  return dir;
}

function writeTree(tree: Tree): string {
  const dir = tempDir();
  for (const [path, content] of Object.entries(tree)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

/**
 * The sw.js shape vite-plugin-pwa 1.3.0 emits: minified, `precacheAndRoute` inlined and renamed, unquoted keys,
 * and manifest.webmanifest listed a second time by the plugin itself.
 */
function swFor(urls: readonly string[]): string {
  const entries = [
    ...urls.map((u) => `{url:"${u}",revision:null}`),
    '{url:"manifest.webmanifest",revision:"9c0c"}',
  ];
  return (
    'try{self["workbox:core:7.4.0"]&&_()}catch(t){}const s=t=>t;' +
    'self.addEventListener("activate",()=>self.clients.claim()),' +
    `function(t){O().precache(t)}([${entries.join(',')}]);`
  );
}

function omit(tree: Tree, ...paths: string[]): Tree {
  return Object.fromEntries(Object.entries(tree).filter(([p]) => !paths.includes(p)));
}

/** Re-derives sw.js so it precaches every file except itself and screenshots/**, minus `unlisted`. */
function withSw(tree: Tree, ...unlisted: string[]): Tree {
  const rest = omit(tree, 'sw.js');
  const urls = Object.keys(rest).filter((p) => !p.startsWith('screenshots/') && !unlisted.includes(p));
  return { ...rest, 'sw.js': swFor(urls) };
}

const WORKLET =
  'class P extends AudioWorkletProcessor{process(){return true}}registerProcessor("capture",P);';

const MANIFEST = {
  name: 'Talking Bear',
  icons: [{ src: '/icons/icon-192.png' }],
  screenshots: [{ src: '/screenshots/phone-1.webp' }],
};

function goodTree(mode: Mode): Tree {
  const tree: Tree = {
    'index.html': '<html><head><script type="module" src="/assets/index-abc.js"></script></head></html>',
    'assets/index-abc.js': 'console.log("app");',
    'assets/capture.worklet--xyz.js': WORKLET,
    'assets/weights-abc.bin': 'weights',
    'assets/workbox-window.prod.es5-abc.js': 'var workbox;',
    'licenses.txt': 'Silero VAD\nCopyright (c) 2020-present Silero Team\nMIT License\n',
    'manifest.webmanifest': JSON.stringify(MANIFEST),
    'icons/icon-192.png': 'png',
    'screenshots/phone-1.webp': 'webp',
  };
  if (mode === 'e2e') {
    tree['assets/test-hooks-abc.js'] = 'globalThis.__bearTest={setVadBackend(b){}};';
    tree['assets/test-tap.worklet-abc.js'] =
      'registerProcessor("test-tap",class extends AudioWorkletProcessor{process(){return true}});';
  }
  return withSw(tree);
}

function ruleViolations(dir: string, mode: Mode, rule: number): string[] {
  return checkDist(dir, mode).filter((v) => v.startsWith(`rule ${rule} (`));
}

/** A complete production tree with this manifest.webmanifest text. */
function withManifest(text: string): string {
  return writeTree({ ...goodTree('production'), 'manifest.webmanifest': text });
}

/** Runs the script as a CLI (optionally through another path to it). */
function run(args: readonly string[], script = SCRIPT): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

describe('precacheUrls', () => {
  it('reads the minified vite-plugin-pwa 1.3.0 shape (unquoted url keys, renamed precache call), deduplicated', () => {
    const sw =
      'self.addEventListener("activate",()=>self.clients.claim()),j={},function(t){O().precache(t)}([' +
      '{url:"manifest.webmanifest",revision:"9c0c"},{url:"assets/index-CbmZyTFq.js",revision:null},' +
      '{url:"manifest.webmanifest",revision:"9c0c"}]),function(t){const e=O();c(new N(e,t))}(j);';
    expect(precacheUrls(sw)).toEqual(['manifest.webmanifest', 'assets/index-CbmZyTFq.js']);
  });

  it('reads quoted keys, single quotes and spaces around the colon', () => {
    const sw = `precacheAndRoute([{"url": "index.html", "revision": "1"}, {'url' : 'licenses.txt'}]);`;
    expect(precacheUrls(sw)).toEqual(['index.html', 'licenses.txt']);
  });

  it('ignores the runtime url properties (no quote after the colon)', () => {
    // The trailing string literal makes the test fail if the opening quote of the value ever becomes optional.
    expect(precacheUrls('const i=({url:e})=>e.href;n({url:t.href,request:t});const m="x";')).toEqual([]);
  });
});

describe('checkDist', () => {
  it('passes a complete production tree', () => {
    expect(checkDist(writeTree(goodTree('production')), 'production')).toEqual([]);
  });

  it('passes a complete e2e tree (test hooks and the test-tap worklet included)', () => {
    expect(checkDist(writeTree(goodTree('e2e')), 'e2e')).toEqual([]);
  });

  it('rejects an unknown mode', () => {
    expect(checkDist(writeTree(goodTree('production')), 'prod')).toEqual([
      'mode must be production or e2e, got "prod"',
    ]);
  });

  it('fails when the dist dir is missing or empty', () => {
    const missing = join(tempDir(), 'dist');
    expect(checkDist(missing, 'production')).toEqual([expect.stringMatching(/^cannot read .*dist: /)]);
    const empty = tempDir();
    expect(checkDist(empty, 'production')).toEqual([`${empty} contains no files (build first)`]);
  });

  describe('rule 1: precache completeness', () => {
    it('passes unlisted exempt files: screenshots/**, *.map, *.br, *.gz and a root workbox-*.js', () => {
      const dir = writeTree({
        ...goodTree('production'),
        'screenshots/phone-2.webp': 'webp',
        'assets/index-abc.js.map': '{}',
        'index.html.br': 'br',
        'index.html.gz': 'gz',
        'workbox-5f3e.js': 'var workboxRuntime;',
      });
      expect(checkDist(dir, 'production')).toEqual([]);
    });

    it('fails a file missing from the precache list (e.g. over maximumFileSizeToCacheInBytes)', () => {
      const dir = writeTree(withSw(goodTree('production'), 'assets/weights-abc.bin'));
      expect(checkDist(dir, 'production')).toEqual([
        'rule 1 (precache): assets/weights-abc.bin is not in the sw.js precache list ' +
          '(outside workbox.globPatterns, or over maximumFileSizeToCacheInBytes)',
      ]);
    });

    it('checks assets/workbox-window.prod.es5-*.js: the workbox-*.js exemption is anchored to the dist root', () => {
      const dir = writeTree(withSw(goodTree('production'), 'assets/workbox-window.prod.es5-abc.js'));
      expect(checkDist(dir, 'production')).toEqual([
        expect.stringMatching(/^rule 1 \(precache\): assets\/workbox-window\.prod\.es5-abc\.js is not in /),
      ]);
    });

    it('checks a nested workbox-*.js', () => {
      const dir = writeTree({ ...goodTree('production'), 'assets/workbox-abc.js': 'var w;' });
      expect(checkDist(dir, 'production')).toEqual([
        expect.stringMatching(/^rule 1 \(precache\): assets\/workbox-abc\.js is not in /),
      ]);
    });

    it('checks a symlinked file like any other file', () => {
      const target = join(tempDir(), 'extra.js');
      writeFileSync(target, 'var extra;');
      const dir = writeTree(goodTree('production'));
      symlinkSync(target, join(dir, 'assets/extra.js'), 'file');
      expect(checkDist(dir, 'production')).toEqual([
        expect.stringMatching(/^rule 1 \(precache\): assets\/extra\.js is not in /),
      ]);
    });

    it('fails without sw.js', () => {
      const dir = writeTree(omit(goodTree('production'), 'sw.js'));
      expect(checkDist(dir, 'production')).toEqual(['rule 1 (precache): sw.js not found']);
    });

    it('reports every non-exempt file when sw.js lists nothing', () => {
      const tree = { ...goodTree('production'), 'sw.js': 'self.addEventListener("install",()=>{});' };
      const violations = ruleViolations(writeTree(tree), 'production', 1);
      expect(violations).toHaveLength(8);
      expect(violations).toContainEqual(
        expect.stringContaining('rule 1 (precache): manifest.webmanifest is not'),
      );
      expect(violations).toContainEqual(expect.stringContaining('rule 1 (precache): index.html is not'));
    });
  });

  describe('rule 2: no data:text/javascript in *.js', () => {
    const DATA_IMPORT = 'import("data:text/javascript,export default 1");';

    it('fails a .js file that contains it', () => {
      const dir = writeTree({ ...goodTree('production'), 'assets/index-abc.js': DATA_IMPORT });
      expect(checkDist(dir, 'production')).toEqual([
        'rule 2 (data-js): assets/index-abc.js contains data:text/javascript',
      ]);
    });

    it('scans only *.js files', () => {
      const dir = writeTree({
        ...goodTree('production'),
        'index.html': `<html><body><script type="module">${DATA_IMPORT}</script></body></html>`,
      });
      expect(checkDist(dir, 'production')).toEqual([]);
    });

    it('matches case-insensitively (schemes and media types are)', () => {
      const dir = writeTree({
        ...goodTree('production'),
        'assets/index-abc.js': 'import("DATA:Text/JavaScript,1");',
      });
      expect(checkDist(dir, 'production')).toEqual([
        'rule 2 (data-js): assets/index-abc.js contains data:text/javascript',
      ]);
    });
  });

  describe('rule 3: test hooks', () => {
    it('fails a production build that contains __bearTest', () => {
      const dir = writeTree({
        ...goodTree('production'),
        'assets/index-abc.js': 'globalThis.__bearTest={};',
      });
      expect(checkDist(dir, 'production')).toEqual([
        'rule 3 (hooks): assets/index-abc.js contains __bearTest (test hooks must not ship)',
      ]);
    });

    it('fails a production build that contains only setVadBackend (#223)', () => {
      const dir = writeTree({ ...goodTree('production'), 'assets/index-abc.js': 'api.setVadBackend=b=>{};' });
      expect(checkDist(dir, 'production')).toEqual([
        'rule 3 (hooks): assets/index-abc.js contains setVadBackend (test hooks must not ship)',
      ]);
    });

    it('scans every file type, not only JavaScript', () => {
      const dir = writeTree({
        ...goodTree('production'),
        'licenses.txt': 'Copyright (c) 2020-present Silero Team\n__bearTest\n',
      });
      expect(checkDist(dir, 'production')).toEqual([
        'rule 3 (hooks): licenses.txt contains __bearTest (test hooks must not ship)',
      ]);
    });

    it('passes an e2e build that ships both needles', () => {
      expect(ruleViolations(writeTree(goodTree('e2e')), 'e2e', 3)).toEqual([]);
    });

    it('fails an e2e build without the test hooks (positive control)', () => {
      expect(checkDist(writeTree(goodTree('production')), 'e2e')).toEqual([
        'rule 3 (hooks): no file contains __bearTest (positive control: the e2e build must ship the test hooks)',
        'rule 3 (hooks): no file contains setVadBackend (positive control: the e2e build must ship the test hooks)',
      ]);
    });

    it('fails an e2e build that ships only one of the needles', () => {
      const dir = writeTree(
        withSw({ ...goodTree('production'), 'assets/test-hooks-abc.js': 'globalThis.__bearTest={};' }),
      );
      expect(checkDist(dir, 'e2e')).toEqual([
        'rule 3 (hooks): no file contains setVadBackend (positive control: the e2e build must ship the test hooks)',
      ]);
    });
  });

  describe('rule 4: self-contained capture worklet', () => {
    it('allows property accesses and identifiers that merely end in self', () => {
      const dir = writeTree({
        ...goodTree('production'),
        'assets/capture.worklet--xyz.js': `${WORKLET}const a=globalThis.self,$self=1,my_self=2;`,
      });
      expect(checkDist(dir, 'production')).toEqual([]);
    });

    it('fails without a capture worklet', () => {
      const dir = writeTree(withSw(omit(goodTree('production'), 'assets/capture.worklet--xyz.js')));
      expect(checkDist(dir, 'production')).toEqual([
        'rule 4 (worklet): expected exactly one assets/capture.worklet-*.js, found 0: []',
      ]);
    });

    it('fails with two capture worklets', () => {
      const dir = writeTree(withSw({ ...goodTree('production'), 'assets/capture.worklet-def.js': WORKLET }));
      expect(checkDist(dir, 'production')).toEqual([
        'rule 4 (worklet): expected exactly one assets/capture.worklet-*.js, found 2: ' +
          '["assets/capture.worklet--xyz.js","assets/capture.worklet-def.js"]',
      ]);
    });

    it.each([
      { name: 'import', code: 'import{x}from"./x.js";', pattern: String(/\bimport\b/) },
      { name: 'import.meta', code: 'const u = import.meta.url;', pattern: String(/\bimport\b/) },
      { name: 'document', code: 'document.title="x";', pattern: String(/\bdocument\b/) },
      { name: 'bare self', code: 'self.onmessage=null;', pattern: String(/(?:^|[^.\w$])self\b/) },
    ])('fails a worklet that uses $name', ({ code, pattern }) => {
      const dir = writeTree({
        ...goodTree('production'),
        'assets/capture.worklet--xyz.js': `${code}${WORKLET}`,
      });
      expect(checkDist(dir, 'production')).toEqual([
        expect.stringContaining(`rule 4 (worklet): assets/capture.worklet--xyz.js matches ${pattern}: `),
      ]);
    });
  });

  describe('rule 5: no dist/lab', () => {
    it('passes when only similarly named paths exist', () => {
      const dir = writeTree(
        withSw({ ...goodTree('production'), 'labels.json': '{}', 'assets/lab-abc.js': '' }),
      );
      expect(checkDist(dir, 'production')).toEqual([]);
    });

    it('fails when dist/lab exists', () => {
      const dir = writeTree(withSw({ ...goodTree('production'), 'lab/index.html': '<html></html>' }));
      expect(checkDist(dir, 'production')).toEqual(['rule 5 (lab): lab exists (lab pages must never ship)']);
    });

    it('fails on an empty dist/lab directory too', () => {
      const dir = writeTree(goodTree('production'));
      mkdirSync(join(dir, 'lab'));
      expect(checkDist(dir, 'production')).toEqual(['rule 5 (lab): lab exists (lab pages must never ship)']);
    });
  });

  describe('rule 6: licences ship with the weights', () => {
    it('needs no licenses.txt when no .bin ships', () => {
      const dir = writeTree(withSw(omit(goodTree('production'), 'licenses.txt', 'assets/weights-abc.bin')));
      expect(checkDist(dir, 'production')).toEqual([]);
    });

    it('fails when a .bin ships without licenses.txt', () => {
      const dir = writeTree(withSw(omit(goodTree('production'), 'licenses.txt')));
      expect(checkDist(dir, 'production')).toEqual([
        'rule 6 (licences): licenses.txt is missing although weights ship: assets/weights-abc.bin',
      ]);
    });

    it('fails when licenses.txt lacks "Silero Team"', () => {
      const dir = writeTree({ ...goodTree('production'), 'licenses.txt': 'MIT License\n' });
      expect(checkDist(dir, 'production')).toEqual([
        'rule 6 (licences): licenses.txt does not contain "Silero Team"',
      ]);
    });
  });

  describe('rule 7: manifest', () => {
    it('passes a manifest whose icons and screenshots all exist', () => {
      expect(ruleViolations(writeTree(goodTree('production')), 'production', 7)).toEqual([]);
    });

    it('fails without manifest.webmanifest', () => {
      const dir = writeTree(withSw(omit(goodTree('production'), 'manifest.webmanifest')));
      expect(checkDist(dir, 'production')).toEqual(['rule 7 (manifest): manifest.webmanifest not found']);
    });

    it('fails a manifest that is not valid JSON', () => {
      expect(checkDist(withManifest('{"name": '), 'production')).toEqual([
        expect.stringMatching(/^rule 7 \(manifest\): manifest\.webmanifest is not valid JSON: /),
      ]);
    });

    it('fails a manifest that is not a JSON object', () => {
      expect(checkDist(withManifest('[]'), 'production')).toEqual([
        'rule 7 (manifest): manifest.webmanifest is not a JSON object',
      ]);
    });

    it('fails a wrong name', () => {
      const dir = withManifest(JSON.stringify({ ...MANIFEST, name: 'Talking Bar' }));
      expect(checkDist(dir, 'production')).toEqual([
        'rule 7 (manifest): name is "Talking Bar", expected "Talking Bear"',
      ]);
    });

    it('fails an icon whose file is missing', () => {
      const dir = withManifest(JSON.stringify({ ...MANIFEST, icons: [{ src: '/icons/icon-512.png' }] }));
      expect(checkDist(dir, 'production')).toEqual([
        `rule 7 (manifest): icons[0].src /icons/icon-512.png does not exist in ${dir}`,
      ]);
    });

    it('fails a screenshot whose file is missing', () => {
      const screenshots = [{ src: '/screenshots/phone-1.webp' }, { src: '/screenshots/desktop-1.webp' }];
      const dir = withManifest(JSON.stringify({ ...MANIFEST, screenshots }));
      expect(checkDist(dir, 'production')).toEqual([
        `rule 7 (manifest): screenshots[1].src /screenshots/desktop-1.webp does not exist in ${dir}`,
      ]);
    });

    it.each(['//icons/icon-192.png', 'https://cdn.example/icons/icon-192.png'])(
      'fails an off-site icon src %s',
      (src) => {
        const dir = withManifest(JSON.stringify({ ...MANIFEST, icons: [{ src }] }));
        expect(checkDist(dir, 'production')).toEqual([
          `rule 7 (manifest): icons[0].src ${src} does not exist in ${dir}`,
        ]);
      },
    );

    it('fails icons that are not an array, and entries without a string src', () => {
      const dir = withManifest(
        JSON.stringify({ ...MANIFEST, icons: { src: '/icons/icon-192.png' }, screenshots: [{ url: 'x' }] }),
      );
      expect(checkDist(dir, 'production')).toEqual([
        'rule 7 (manifest): icons is not an array',
        'rule 7 (manifest): screenshots[0].src is not a string',
      ]);
    });
  });
});

describe('CLI', () => {
  it('exits 0 and prints a summary for a complete tree', () => {
    const dir = writeTree(goodTree('production'));
    const result = run([dir, 'production']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `check-dist: ${dir} (production): all 7 rules pass (10 files, 8 precache URLs)\n`,
    );
  });

  it('exits 1 and lists every violation', () => {
    const dir = writeTree(
      withSw({
        ...goodTree('production'),
        'assets/index-abc.js': 'import("data:text/javascript,export default 1");',
        'lab/index.html': '<html></html>',
      }),
    );
    const result = run([dir, 'production']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      `check-dist: ${dir} (production): 2 violation(s):\n` +
        '  rule 2 (data-js): assets/index-abc.js contains data:text/javascript\n' +
        '  rule 5 (lab): lab exists (lab pages must never ship)\n',
    );
  });

  it.each([{ args: [] }, { args: ['dist'] }, { args: ['dist', 'prod'] }, { args: ['dist', 'e2e', 'extra'] }])(
    'exits 1 with the usage line for arguments $args',
    ({ args }) => {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('usage: node scripts/check-dist.mjs <distDir> <production|e2e>\n');
    },
  );

  it('does not run the checks when imported', () => {
    const code = `await import(${JSON.stringify(SCRIPT_URL.href)}); console.log('imported');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('imported\n');
  });

  it('runs the checks when executed through a symlinked directory', () => {
    const link = join(tempDir(), 'link');
    symlinkSync(dirname(SCRIPT), link, 'dir');
    const dir = writeTree(goodTree('production'));
    const result = run([dir, 'production'], join(link, 'check-dist.mjs'));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('all 7 rules pass');
  });
});
