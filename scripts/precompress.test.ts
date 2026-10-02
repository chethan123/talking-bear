// scripts/precompress.mjs (issue #104, plan §4.8.2): every case runs on small trees written to a fresh temp dir,
// never on the repo's dist/. Random bytes come from a seeded generator (mulberry32), so every compressed size is
// deterministic. The CLI cases spawn Node on the script itself.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

// precompress.mjs is plain JavaScript without type declarations (the Dockerfile's web stage runs it with bare
// Node), so a static import fails `tsc -b` with TS7016. A computed specifier keeps tsc from resolving it, and the
// guard types the exports the tests use.
interface Row {
  file: string;
  raw: number;
  br: number | null;
  gz: number | null;
}

interface PrecompressModule {
  EXTENSIONS: readonly string[];
  MIN_BYTES: number;
  isEligible: (path: string) => boolean;
  keepVariant: (raw: number, compressed: number) => boolean;
  brotliOptions: (size: number) => { params: Record<number, number> };
  brotli: (data: Uint8Array) => Buffer;
  gzip: (data: Uint8Array) => Buffer;
  precompress: (distDir: string) => Row[];
  formatTable: (rows: readonly Row[]) => string;
}

function isPrecompress(m: unknown): m is PrecompressModule {
  return (
    typeof m === 'object' &&
    m !== null &&
    'EXTENSIONS' in m &&
    Array.isArray(m.EXTENSIONS) &&
    'MIN_BYTES' in m &&
    typeof m.MIN_BYTES === 'number' &&
    'isEligible' in m &&
    typeof m.isEligible === 'function' &&
    'keepVariant' in m &&
    typeof m.keepVariant === 'function' &&
    'brotliOptions' in m &&
    typeof m.brotliOptions === 'function' &&
    'brotli' in m &&
    typeof m.brotli === 'function' &&
    'gzip' in m &&
    typeof m.gzip === 'function' &&
    'precompress' in m &&
    typeof m.precompress === 'function' &&
    'formatTable' in m &&
    typeof m.formatTable === 'function'
  );
}

const SCRIPT_URL = new URL('./precompress.mjs', import.meta.url);
const SCRIPT = fileURLToPath(SCRIPT_URL);
const loaded: unknown = await import(SCRIPT_URL.href);
if (!isPrecompress(loaded)) {
  throw new Error(
    'scripts/precompress.mjs must export EXTENSIONS, MIN_BYTES, isEligible, keepVariant, brotliOptions, brotli, ' +
      'gzip, precompress and formatTable',
  );
}
const {
  EXTENSIONS,
  MIN_BYTES,
  isEligible,
  keepVariant,
  brotliOptions,
  brotli,
  gzip,
  precompress,
  formatTable,
} = loaded;

const { BROTLI_PARAM_LGWIN, BROTLI_PARAM_QUALITY, BROTLI_PARAM_SIZE_HINT } = constants;

/** The extensions the issue names, in its order. */
const LISTED = ['html', 'js', 'css', 'json', 'webmanifest', 'svg', 'bin'];
/** Extensions a dist may hold that must never get variants. */
const UNLISTED = ['wav', 'png', 'webp', 'txt', 'map', 'mjs', 'woff2', 'ico'];
const KB10 = 10_240;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'precompress-'));
  tempDirs.push(dir);
  return dir;
}

function write(dir: string, rel: string, data: string | Uint8Array): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function exists(dir: string, rel: string): boolean {
  return existsSync(join(dir, rel));
}

function read(dir: string, rel: string): Buffer {
  return readFileSync(join(dir, rel));
}

const LINE = 'export const bear = { name: "Juni", ears: 2 };\n';

/** The first `n` bytes of LINE repeated: compresses to a tiny fraction. */
function repetitive(n: number): Buffer {
  return Buffer.from(LINE.repeat(Math.ceil(n / LINE.length))).subarray(0, n);
}

/** `n` bytes from mulberry32 seeded with `seed` (the low byte of each output): incompressible, deterministic. */
function seededBytes(n: number, seed: number): Buffer {
  const out = Buffer.alloc(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}

/** Every file under `dir` as dist-relative POSIX path → content. */
function tree(dir: string): Map<string, Buffer> {
  return new Map(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const path = join(d.parentPath, d.name);
        return [relative(dir, path).split(sep).join('/'), readFileSync(path)] as const;
      }),
  );
}

function run(...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('precompress', () => {
  it('gives a 10 KB repetitive .js both variants, which decompress to the original (V1)', () => {
    const dir = tempDir();
    const data = repetitive(KB10);
    write(dir, 'assets/app.js', data);
    const rows = precompress(dir);
    const br = read(dir, 'assets/app.js.br');
    const gz = read(dir, 'assets/app.js.gz');
    expect(brotliDecompressSync(br).equals(data)).toBe(true);
    expect(gunzipSync(gz).equals(data)).toBe(true);
    expect(rows).toEqual([{ file: 'assets/app.js', raw: KB10, br: br.length, gz: gz.length }]);
  });

  it('gives a 500-byte .js no variant (V2)', () => {
    const dir = tempDir();
    write(dir, 'small.js', repetitive(500));
    const rows = precompress(dir);
    expect([...tree(dir).keys()]).toEqual(['small.js']);
    expect(rows).toEqual([{ file: 'small.js', raw: 500, br: null, gz: null }]);
  });

  it('skips files under 1024 bytes and compresses files of exactly 1024 bytes', () => {
    expect(MIN_BYTES).toBe(1024);
    const dir = tempDir();
    write(dir, 'a.js', repetitive(1023));
    write(dir, 'b.js', repetitive(1024));
    const rows = precompress(dir);
    expect(exists(dir, 'a.js.br')).toBe(false);
    expect(exists(dir, 'a.js.gz')).toBe(false);
    expect(exists(dir, 'b.js.br')).toBe(true);
    expect(exists(dir, 'b.js.gz')).toBe(true);
    expect(rows.find((r) => r.file === 'a.js')).toEqual({ file: 'a.js', raw: 1023, br: null, gz: null });
  });

  it('gives a 10 KB random .bin no variant, since neither saves 5 % (V3)', () => {
    const dir = tempDir();
    const data = seededBytes(KB10, 93);
    write(dir, 'weights.bin', data);
    for (const compressed of [brotli(data), gzip(data)]) {
      expect((data.length - compressed.length) / data.length).toBeLessThan(0.05);
      expect(keepVariant(data.length, compressed.length)).toBe(false);
    }
    const rows = precompress(dir);
    expect([...tree(dir).keys()]).toEqual(['weights.bin']);
    expect(rows).toEqual([{ file: 'weights.bin', raw: KB10, br: null, gz: null }]);
  });

  it('never touches a .wav or its siblings, even a compressible one (V4)', () => {
    const dir = tempDir();
    const wav = repetitive(KB10);
    write(dir, 'voice.wav', wav);
    write(dir, 'voice.wav.br', 'stale');
    for (const f of ['voice.wav', 'voice.wav.br']) utimesSync(join(dir, f), 1e9, 1e9);
    const rows = precompress(dir);
    expect(read(dir, 'voice.wav').equals(wav)).toBe(true);
    expect(read(dir, 'voice.wav.br').toString('utf8')).toBe('stale');
    for (const f of ['voice.wav', 'voice.wav.br']) expect(statSync(join(dir, f)).mtimeMs).toBe(1e12);
    expect(exists(dir, 'voice.wav.gz')).toBe(false);
    expect(rows.some((r) => r.file.startsWith('voice.wav'))).toBe(false);
  });

  it('precompresses exactly html, js, css, json, webmanifest, svg and bin, in any letter case', () => {
    expect(EXTENSIONS).toEqual(LISTED);
    const dir = tempDir();
    const data = repetitive(KB10);
    for (const ext of [...LISTED, ...UNLISTED]) write(dir, `f.${ext}`, data);
    write(dir, 'APP.JS', data);
    const rows = precompress(dir);
    for (const name of [...LISTED.map((ext) => `f.${ext}`), 'APP.JS']) {
      expect(exists(dir, `${name}.br`), name).toBe(true);
      expect(exists(dir, `${name}.gz`), name).toBe(true);
    }
    for (const ext of UNLISTED) {
      expect(exists(dir, `f.${ext}.br`), ext).toBe(false);
      expect(exists(dir, `f.${ext}.gz`), ext).toBe(false);
      expect(rows.some((r) => r.file === `f.${ext}`)).toBe(false);
    }
    expect(rows.map((r) => r.file).toSorted()).toEqual(
      [...LISTED.map((ext) => `f.${ext}`), 'APP.JS'].toSorted(),
    );
    expect(isEligible('x.js.br')).toBe(false);
    expect(isEligible('x.js.gz')).toBe(false);
  });

  it('evaluates br and gz separately', () => {
    // A 40 KB random block written twice: brotli's 16 MB window (lgwin 24) finds the repeat and halves the file;
    // gzip's 32 KB window cannot reach it, so gzip saves nothing.
    const dir = tempDir();
    const block = seededBytes(40_960, 7);
    write(dir, 'twice.bin', Buffer.concat([block, block]));
    const [row] = precompress(dir);
    expect(exists(dir, 'twice.bin.br')).toBe(true);
    expect(exists(dir, 'twice.bin.gz')).toBe(false);
    expect(row?.br).toBe(read(dir, 'twice.bin.br').length);
    expect(row?.gz).toBeNull();
  });

  it('keeps a variant only when it saves at least 5 %', () => {
    expect(keepVariant(1000, 950)).toBe(true);
    expect(keepVariant(1000, 951)).toBe(false);
    expect(keepVariant(2000, 1900)).toBe(true);
    expect(keepVariant(2000, 1901)).toBe(false);
    expect(keepVariant(1024, 1024)).toBe(false);
    expect(keepVariant(1024, 2000)).toBe(false);
  });

  it('uses brotli quality 11, lgwin 24 and the size hint, and gzip level 9', () => {
    // The size hint does not change the output bytes for these inputs, so only the options themselves can show it.
    expect(brotliOptions(12_345)).toEqual({
      params: { [BROTLI_PARAM_QUALITY]: 11, [BROTLI_PARAM_LGWIN]: 24, [BROTLI_PARAM_SIZE_HINT]: 12_345 },
    });
    const data = repetitive(KB10);
    const br = brotli(data);
    const reference = brotliCompressSync(data, {
      params: { [BROTLI_PARAM_QUALITY]: 11, [BROTLI_PARAM_LGWIN]: 24, [BROTLI_PARAM_SIZE_HINT]: data.length },
    });
    expect(br.equals(reference)).toBe(true);
    // The stream header's WBITS: the low nibble 0b1111 encodes a 2^24-byte window.
    expect((br[0] ?? 0) & 0x0f).toBe(0x0f);
    const gz = gzip(data);
    expect(gz.equals(gzipSync(data, { level: 9 }))).toBe(true);
    // Header bytes 4–7: MTIME 0 (so runs are byte-identical); byte 8: XFL 2, maximum compression.
    expect([...gz.subarray(4, 9)]).toEqual([0, 0, 0, 0, 2]);
  });

  it('is idempotent: a second run rewrites byte-identical variants', () => {
    const dir = tempDir();
    write(dir, 'assets/a.js', repetitive(KB10));
    write(dir, 'assets/b.css', repetitive(KB10));
    write(dir, 'small.js', repetitive(500));
    write(dir, 'r.bin', seededBytes(KB10, 3));
    write(dir, 'voice.wav', repetitive(KB10));
    write(dir, 'assets/a.js.br', 'garbage');
    const first = precompress(dir);
    expect(brotliDecompressSync(read(dir, 'assets/a.js.br')).equals(repetitive(KB10))).toBe(true);
    const before = tree(dir);
    const second = precompress(dir);
    const after = tree(dir);
    expect(second).toEqual(first);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [path, content] of before) expect(after.get(path)?.equals(content), path).toBe(true);
    expect([...after.keys()].filter((p) => /\.(?:br|gz)\.(?:br|gz)$/.test(p))).toEqual([]);
  });

  it('removes a variant that no longer qualifies on a re-run, and leaves orphans alone', () => {
    const dir = tempDir();
    write(dir, 'a.js', repetitive(KB10));
    write(dir, 'b.js', repetitive(KB10));
    write(dir, 'gone.js.br', 'orphan');
    write(dir, 'voice.wav.gz', 'wav sibling');
    precompress(dir);
    for (const f of ['a.js.br', 'a.js.gz', 'b.js.br', 'b.js.gz']) expect(exists(dir, f), f).toBe(true);
    write(dir, 'a.js', repetitive(500));
    write(dir, 'b.js', seededBytes(KB10, 11));
    const rows = precompress(dir);
    for (const f of ['a.js.br', 'a.js.gz', 'b.js.br', 'b.js.gz']) expect(exists(dir, f), f).toBe(false);
    expect(read(dir, 'gone.js.br').toString('utf8')).toBe('orphan');
    expect(read(dir, 'voice.wav.gz').toString('utf8')).toBe('wav sibling');
    expect(rows).toEqual([
      { file: 'a.js', raw: 500, br: null, gz: null },
      { file: 'b.js', raw: KB10, br: null, gz: null },
    ]);
  });
});

describe('formatTable', () => {
  it('prints file, raw, br and gz in aligned columns, with - for a skipped variant', () => {
    const table = formatTable([
      { file: 'assets/app.js', raw: 10240, br: 51, gz: 94 },
      { file: 'index.html', raw: 800, br: null, gz: null },
    ]);
    expect(table).toBe(
      ['file             raw  br  gz', 'assets/app.js  10240  51  94', 'index.html       800   -   -'].join(
        '\n',
      ),
    );
  });

  it('prints the header alone for no rows', () => {
    expect(formatTable([])).toBe('file  raw  br  gz');
  });
});

describe('CLI', () => {
  it('writes the variants and prints the table and a summary', () => {
    const dir = tempDir();
    write(dir, 'assets/app.js', repetitive(KB10));
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^file +raw +br +gz$/m);
    expect(result.stdout).toMatch(/^assets\/app\.js +10240 +\d+ +\d+$/m);
    expect(result.stdout).toContain(`precompress: ${dir}: 1 eligible files, 1 .br and 1 .gz written`);
    expect(exists(dir, 'assets/app.js.br')).toBe(true);
    expect(exists(dir, 'assets/app.js.gz')).toBe(true);
  });

  it('succeeds on a dir without eligible files', () => {
    const dir = tempDir();
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `file  raw  br  gz\nprecompress: ${dir}: 0 eligible files, 0 .br and 0 .gz written\n`,
    );
  });

  it('fails with usage unless given exactly one argument', () => {
    const dir = tempDir();
    for (const args of [[], [dir, dir]]) {
      const result = run(...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('usage: node scripts/precompress.mjs <distDir>');
    }
  });

  it('fails on a missing dir', () => {
    const result = run(join(tempDir(), 'missing'));
    expect(result.status).toBe(1);
    expect(result.stderr.startsWith('precompress: ')).toBe(true);
    expect(result.stderr).toContain('ENOENT');
  });
});
