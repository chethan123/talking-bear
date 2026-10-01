// Silero VAD parity (plan §4.2.3, §4.9.1 "Silero parity"; #44): the TypeScript port in
// src/dsp/silero/model.ts against onnxruntime-web 1.30.0 (wasm, 1 thread), a dev-only oracle that never
// ships. It runs every WAV under test/fixtures/ and test/corpus/speech/ (resampled to 16 kHz, cut into
// 512-sample frames, every model reset between files) through ORT and through two TS models:
//   Tier 1: fp32 weights read straight from the pinned ONNX: max|Δp| < 1e-4 and no flip at 0.5 or 0.35.
//   Tier 2: the shipped weights.bin (fp16 or fp32 per tensor, per WEIGHTS_LAYOUT): max|Δp| < 5e-3 and no
//           flip at 0.5 or 0.35, except on frames whose ORT p is within 5e-3 of that threshold (listed, not
//           failed).
// It also checks that src/dsp/silero/golden.json, the ORT p of vowel_f0-140.wav that model.test.ts compares
// against without ORT, is up to date.
//
// Usage:
//   pnpm parity                              fetches the ONNX into .cache/silero/ if needed, then runs this
//   node scripts/silero-parity.ts [--swap-gates] [--write-golden]
//     --swap-gates    negative control: permutes the LSTM gate blocks from i, f, g, o to i, g, o, f in both
//                     tiers, which must fail Tier 1
//     --write-golden  writes golden.json from the ORT probabilities (rounded to 6 decimals), then checks
//                     Tier 1 and Tier 2 as usual
// Exit codes: 0 every criterion passed; 1 a criterion failed, or an error; 2 bad arguments.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

import * as ort from 'onnxruntime-web';
import { format, resolveConfig } from 'prettier';

import { resampleOffline } from '../src/dsp/resample.ts';
import { SILERO_CONTEXT, SILERO_FRAME, createSilero, type SileroModel } from '../src/dsp/silero/model.ts';
import { WEIGHTS_LAYOUT, decodeWeights, type SileroWeights } from '../src/dsp/silero/weights.ts';
import { readWav } from '../test/wav.ts';
import { REPO_ROOT, ensureSileroOnnx, errorMessage } from './fetch-silero-onnx.ts';
import { readOnnxInitializers, type OnnxTensor } from './onnx-reader.ts';

const RATE = 16_000;
/** Decision thresholds; a frame is speech at θ when p >= θ (as in src/dsp/segmenter.ts). */
const THRESHOLDS = [0.5, 0.35] as const;
const TIER1_MAX_DP = 1e-4;
const TIER2_MAX_DP = 5e-3;
/** Tier 2 frames whose ORT p is within this distance of a threshold are listed, not counted as flips. */
const NEAR = 5e-3;
const INPUT_DIRS = ['test/fixtures', 'test/corpus/speech'] as const;
const GOLDEN_INPUT = 'test/fixtures/vowel_f0-140.wav';
const GOLDEN_PATH = join(REPO_ROOT, 'src', 'dsp', 'silero', 'golden.json');
/** golden.json must equal the current ORT p, rounded to 6 decimals, within this. */
const GOLDEN_TOLERANCE = 1e-5;
const WEIGHTS_BIN = join(REPO_ROOT, 'src', 'dsp', 'silero', 'weights.bin');
/** The ONNX model's recurrent state: [2 (h, c), batch 1, 128]. */
const STATE_DIMS: readonly number[] = [2, 1, 128];
/** How many counted flips are printed per tier and threshold. */
const FLIPS_SHOWN = 20;

const USAGE = 'usage: node scripts/silero-parity.ts [--swap-gates] [--write-golden]';

const LSTM_KEYS: ReadonlySet<keyof SileroWeights> = new Set(['lstmWih', 'lstmWhh', 'lstmBih', 'lstmBhh']);

/** A SileroWeights whose every tensor comes from `get`. */
function weightsFrom(get: (key: keyof SileroWeights) => Float32Array): SileroWeights {
  return {
    conv1W: get('conv1W'),
    conv1B: get('conv1B'),
    conv2W: get('conv2W'),
    conv2B: get('conv2B'),
    conv3W: get('conv3W'),
    conv3B: get('conv3B'),
    conv4W: get('conv4W'),
    conv4B: get('conv4B'),
    lstmWih: get('lstmWih'),
    lstmWhh: get('lstmWhh'),
    lstmBih: get('lstmBih'),
    lstmBhh: get('lstmBhh'),
    finalW: get('finalW'),
    finalB: get('finalB'),
  };
}

/** Tier 1: the fp32 weights, straight from the ONNX initializers (names and dims checked). */
function fp32Weights(inits: Map<string, OnnxTensor>): SileroWeights {
  const byKey = new Map<keyof SileroWeights, Float32Array>();
  for (const { key, onnxName, dims } of WEIGHTS_LAYOUT) {
    const t = inits.get(onnxName);
    if (t === undefined) throw new Error(`ONNX initializer ${onnxName} is missing`);
    if (t.dims.join(',') !== dims.join(',')) {
      throw new Error(
        `ONNX initializer ${onnxName}: dims [${t.dims.join(', ')}], expected [${dims.join(', ')}]`,
      );
    }
    byKey.set(key, t.data);
  }
  return weightsFrom((key) => byKey.get(key)!);
}

/** Tier 2: the shipped weights.bin, decoded as the app decodes it. */
function shippedWeights(): SileroWeights {
  const bytes = readFileSync(WEIGHTS_BIN);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return decodeWeights(buf);
}

/** A copy of `a` (4 gate blocks i, f, g, o) with its blocks in the order i, g, o, f. */
function permuteGates(a: Float32Array): Float32Array {
  const n = a.length / 4;
  const out = new Float32Array(a.length);
  // Source block of each destination block: i ← i, f ← g, g ← o, o ← f.
  [0, 2, 3, 1].forEach((src, dst) => out.set(a.subarray(src * n, (src + 1) * n), dst * n));
  return out;
}

/** The --swap-gates negative control (the spike's `reorder`): every LSTM tensor's gate blocks permuted. */
function swapGates(w: SileroWeights): SileroWeights {
  return weightsFrom((key) => (LSTM_KEYS.has(key) ? permuteGates(w[key]) : w[key]));
}

interface OrtSilero {
  reset(): void;
  process(frame: Float32Array): Promise<number>;
  release(): Promise<void>;
}

/**
 * The ONNX model in onnxruntime-web, fed like the spike's makeOrtSilero: `input` [1, 576] = the 64-sample
 * context + the 512-sample frame, `state` [2, 1, 128] (zeros after a reset), and `sr` = 16000 if the model
 * has that input.
 */
async function createOrtSilero(onnx: Uint8Array): Promise<OrtSilero> {
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(onnx, { executionProviders: ['wasm'] });
  for (const name of ['input', 'state']) {
    if (!session.inputNames.includes(name)) {
      throw new Error(`ONNX model has no input "${name}" (inputs: ${session.inputNames.join(', ')})`);
    }
  }
  for (const name of ['output', 'stateN']) {
    if (!session.outputNames.includes(name)) {
      throw new Error(`ONNX model has no output "${name}" (outputs: ${session.outputNames.join(', ')})`);
    }
  }
  const hasSr = session.inputNames.includes('sr');
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(RATE)]), []);
  const stateSize = STATE_DIMS.reduce((a, b) => a * b, 1);
  const zeroState = (): ort.Tensor => new ort.Tensor('float32', new Float32Array(stateSize), [...STATE_DIMS]);
  let state = zeroState();
  const context = new Float32Array(SILERO_CONTEXT);
  return {
    reset(): void {
      state = zeroState();
      context.fill(0);
    },
    async process(frame: Float32Array): Promise<number> {
      const input = new Float32Array(SILERO_CONTEXT + SILERO_FRAME);
      input.set(context, 0);
      input.set(frame, SILERO_CONTEXT);
      const feeds: Record<string, ort.Tensor> = {
        input: new ort.Tensor('float32', input, [1, input.length]),
        state,
      };
      if (hasSr) feeds['sr'] = sr;
      const out = await session.run(feeds);
      const p = out['output'];
      const next = out['stateN'];
      if (p === undefined || next === undefined) throw new Error('ORT returned no output or stateN');
      if (!(p.data instanceof Float32Array)) throw new Error(`ORT output is ${p.type}, expected float32`);
      state = next;
      context.set(frame.subarray(SILERO_FRAME - SILERO_CONTEXT));
      return p.data[0]!;
    },
    release: () => session.release(),
  };
}

/** Repo-relative path with forward slashes. */
function repoPath(abs: string): string {
  return relative(REPO_ROOT, abs).split(sep).join('/');
}

/** Every *.wav (any case) under INPUT_DIRS, recursive, sorted within each directory. */
function listInputs(): string[] {
  const files: string[] = [];
  for (const dir of INPUT_DIRS) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) {
      console.log(`${dir}: not present, skipped`);
      continue;
    }
    const names = readdirSync(abs, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.toLowerCase().endsWith('.wav') && statSync(join(abs, name)).isFile())
      .toSorted();
    for (const name of names) files.push(join(abs, name));
  }
  return files;
}

/**
 * The file's 512-sample frames at 16 kHz: mono (channel 0, or the mean of all channels), resampled with
 * resampleOffline unless it is 16 kHz already; the trailing partial frame is dropped.
 */
function loadFrames(path: string): Float32Array[] {
  const wav = readWav(readFileSync(path));
  let x = wav.channels[0]!;
  if (wav.channels.length > 1) {
    x = new Float32Array(x.length);
    for (const ch of wav.channels)
      for (let i = 0; i < x.length; i++) x[i] = x[i]! + ch[i]! / wav.channels.length;
  }
  if (wav.sampleRate !== RATE) x = resampleOffline(x, RATE / wav.sampleRate);
  const frames: Float32Array[] = [];
  for (let i = 0; i + SILERO_FRAME <= x.length; i += SILERO_FRAME)
    frames.push(x.subarray(i, i + SILERO_FRAME));
  return frames;
}

interface TierStats {
  maxDp: number;
  /** Counted flips per threshold, in THRESHOLDS order. */
  flips: number[];
}

interface FileRow {
  file: string;
  frames: number;
  tier1: TierStats;
  tier2: TierStats;
  near: number;
}

interface FrameNote {
  file: string;
  frame: number;
  threshold: number;
  pOrt: number;
  p: number;
}

const newStats = (): TierStats => ({ maxDp: 0, flips: THRESHOLDS.map(() => 0) });
const exp = (x: number): string => x.toExponential(2);
const p6 = (x: number): string => x.toFixed(6);
const round6 = (p: number): number => Math.round(p * 1e6) / 1e6;

interface Golden {
  file: string;
  p: number[];
}

function isGolden(value: unknown): value is Golden {
  if (typeof value !== 'object' || value === null) return false;
  const file: unknown = Reflect.get(value, 'file');
  const p: unknown = Reflect.get(value, 'p');
  return typeof file === 'string' && Array.isArray(p) && p.every((v) => typeof v === 'number');
}

/** Why golden.json doesn't match the current ORT p (`ortP`, unrounded), or null if it is up to date. */
function goldenProblem(ortP: readonly number[]): string | null {
  const fix = 'run node scripts/silero-parity.ts --write-golden';
  if (!existsSync(GOLDEN_PATH)) return `${repoPath(GOLDEN_PATH)} is missing; ${fix}`;
  const golden: unknown = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  if (!isGolden(golden)) return `${repoPath(GOLDEN_PATH)} is not { file: string, p: number[] }; ${fix}`;
  if (golden.file !== basename(GOLDEN_INPUT)) {
    return `golden.json is for ${golden.file}, expected ${basename(GOLDEN_INPUT)}; ${fix}`;
  }
  if (golden.p.length !== ortP.length) {
    return `golden.json has ${golden.p.length} frames, ${GOLDEN_INPUT} has ${ortP.length}; ${fix}`;
  }
  let worst = 0;
  for (let i = 1; i < ortP.length; i++) {
    if (Math.abs(golden.p[i]! - round6(ortP[i]!)) > Math.abs(golden.p[worst]! - round6(ortP[worst]!)))
      worst = i;
  }
  const d = ortP.length === 0 ? 0 : Math.abs(golden.p[worst]! - round6(ortP[worst]!));
  if (d > GOLDEN_TOLERANCE) {
    return `golden.json frame ${worst} is ${golden.p[worst]}, ORT gives ${p6(ortP[worst]!)} (|Δ| ${exp(d)}); ${fix}`;
  }
  return null;
}

async function writeGolden(ortP: readonly number[]): Promise<void> {
  const golden: Golden = { file: basename(GOLDEN_INPUT), p: ortP.map(round6) };
  const config = (await resolveConfig(GOLDEN_PATH)) ?? {};
  writeFileSync(GOLDEN_PATH, await format(JSON.stringify(golden), { ...config, filepath: GOLDEN_PATH }));
  console.log(`wrote ${repoPath(GOLDEN_PATH)} (${golden.p.length} frames)`);
}

function printFlips(tier: string, flips: readonly FrameNote[][]): void {
  THRESHOLDS.forEach((threshold, ti) => {
    const list = flips[ti]!;
    console.log(`${tier} counted flips @${threshold}: ${list.length === 0 ? '(none)' : ''}`);
    for (const f of list.slice(0, FLIPS_SHOWN)) {
      console.log(`  ${f.file} frame ${f.frame}: ORT ${p6(f.pOrt)}, TS ${p6(f.p)}`);
    }
    if (list.length > FLIPS_SHOWN) console.log(`  … ${list.length - FLIPS_SHOWN} more`);
  });
}

async function run(swap: boolean, writeGoldenFile: boolean): Promise<number> {
  const onnx = await ensureSileroOnnx();
  let w1 = fp32Weights(readOnnxInitializers(onnx));
  let w2 = shippedWeights();
  if (swap) {
    console.log(
      'NEGATIVE CONTROL (--swap-gates): LSTM gate blocks permuted from i, f, g, o to i, g, o, f in both tiers; ' +
        'Tier 1 must FAIL.',
    );
    w1 = swapGates(w1);
    w2 = swapGates(w2);
  }
  const tier1: SileroModel = createSilero(w1);
  const tier2: SileroModel = createSilero(w2);
  const reference = await createOrtSilero(onnx);
  try {
    const files = listInputs();
    if (files.length === 0) throw new Error(`no WAV file under ${INPUT_DIRS.join(' or ')}`);

    const rows: FileRow[] = [];
    const near: (FrameNote & { flipped: boolean })[] = [];
    const flips1: FrameNote[][] = THRESHOLDS.map(() => []);
    const flips2: FrameNote[][] = THRESHOLDS.map(() => []);
    const goldenP: number[] = [];
    let msOrt = 0;
    let ms1 = 0;
    let ms2 = 0;

    for (const path of files) {
      const file = repoPath(path);
      const frames = loadFrames(path);
      tier1.reset();
      tier2.reset();
      reference.reset();
      const row: FileRow = { file, frames: frames.length, tier1: newStats(), tier2: newStats(), near: 0 };
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i]!;
        let t0 = performance.now();
        const pOrt = await reference.process(frame);
        msOrt += performance.now() - t0;
        t0 = performance.now();
        const p1 = tier1.process(frame);
        ms1 += performance.now() - t0;
        t0 = performance.now();
        const p2 = tier2.process(frame);
        ms2 += performance.now() - t0;
        if (file === GOLDEN_INPUT) goldenP.push(pOrt);

        row.tier1.maxDp = Math.max(row.tier1.maxDp, Math.abs(p1 - pOrt));
        row.tier2.maxDp = Math.max(row.tier2.maxDp, Math.abs(p2 - pOrt));
        THRESHOLDS.forEach((threshold, ti) => {
          const ref = pOrt >= threshold;
          if (p1 >= threshold !== ref) {
            row.tier1.flips[ti]!++;
            flips1[ti]!.push({ file, frame: i, threshold, pOrt, p: p1 });
          }
          const flipped = p2 >= threshold !== ref;
          if (Math.abs(pOrt - threshold) <= NEAR) {
            row.near++;
            near.push({ file, frame: i, threshold, pOrt, p: p2, flipped });
          } else if (flipped) {
            row.tier2.flips[ti]!++;
            flips2[ti]!.push({ file, frame: i, threshold, pOrt, p: p2 });
          }
        });
      }
      rows.push(row);
    }

    const total: FileRow = { file: 'TOTAL', frames: 0, tier1: newStats(), tier2: newStats(), near: 0 };
    for (const row of rows) {
      total.frames += row.frames;
      total.near += row.near;
      for (const tier of ['tier1', 'tier2'] as const) {
        total[tier].maxDp = Math.max(total[tier].maxDp, row[tier].maxDp);
        row[tier].flips.forEach((n, ti) => (total[tier].flips[ti]! += n));
      }
    }

    // Report.
    const width = Math.max(...rows.map((r) => r.file.length), 'file'.length);
    const flipsAt = THRESHOLDS.map((t) => `@${t}`).join('/');
    console.log(
      `${'file'.padEnd(width)}  frames  T1 max|Δp|  T1 flips ${flipsAt}  T2 max|Δp|  T2 flips ${flipsAt}  near`,
    );
    for (const r of [...rows, total]) {
      console.log(
        `${r.file.padEnd(width)}  ${String(r.frames).padStart(6)}  ${exp(r.tier1.maxDp).padStart(10)}  ` +
          `${r.tier1.flips.join('/').padStart(8 + flipsAt.length)}  ${exp(r.tier2.maxDp).padStart(10)}  ` +
          `${r.tier2.flips.join('/').padStart(8 + flipsAt.length)}  ${String(r.near).padStart(4)}`,
      );
    }
    const n = Math.max(total.frames, 1);
    console.log(
      `ms/frame: TS fp32 ${(ms1 / n).toFixed(3)} · TS shipped ${(ms2 / n).toFixed(3)} · ORT ${(msOrt / n).toFixed(3)}`,
    );
    console.log(`Tier 2 near-threshold frames (|ORT p − θ| ≤ ${NEAR}; listed, not failed):`);
    if (near.length === 0) console.log('  (none)');
    for (const f of near) {
      console.log(
        `  ${f.file} frame ${f.frame}: θ ${f.threshold}, ORT ${p6(f.pOrt)}, TS shipped ${p6(f.p)}, ` +
          (f.flipped ? 'flipped' : 'not flipped'),
      );
    }
    printFlips('Tier 1', flips1);
    printFlips('Tier 2', flips2);

    // Criteria.
    const results: [ok: boolean, text: string][] = [
      [total.tier1.maxDp < TIER1_MAX_DP, `Tier 1 max|Δp| ${exp(total.tier1.maxDp)} < ${TIER1_MAX_DP}`],
      ...THRESHOLDS.map((t, ti): [boolean, string] => [
        total.tier1.flips[ti] === 0,
        `Tier 1 flips @${t}: ${total.tier1.flips[ti]} (must be 0)`,
      ]),
      [total.tier2.maxDp < TIER2_MAX_DP, `Tier 2 max|Δp| ${exp(total.tier2.maxDp)} < ${TIER2_MAX_DP}`],
      ...THRESHOLDS.map((t, ti): [boolean, string] => [
        total.tier2.flips[ti] === 0,
        `Tier 2 flips @${t} outside ±${NEAR}: ${total.tier2.flips[ti]} (must be 0)`,
      ]),
    ];
    if (goldenP.length === 0) {
      results.push([false, `${GOLDEN_INPUT} was not among the inputs`]);
    } else if (writeGoldenFile) {
      await writeGolden(goldenP);
      console.log('SKIP golden.json up to date (--write-golden)');
    } else {
      const problem = goldenProblem(goldenP);
      results.push([
        problem === null,
        problem ?? `golden.json up to date (${goldenP.length} frames, within ${GOLDEN_TOLERANCE})`,
      ]);
    }
    for (const [ok, text] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
    const pass = results.every(([ok]) => ok);
    console.log(`parity: ${pass ? 'PASS' : 'FAIL'}`);
    return pass ? 0 : 1;
  } finally {
    await reference.release();
  }
}

async function main(args: readonly string[]): Promise<number> {
  const unknown = args.filter((a) => a !== '--swap-gates' && a !== '--write-golden');
  if (unknown.length > 0) {
    console.error(`silero-parity: unknown argument ${unknown.join(' ')}\n${USAGE}`);
    return 2;
  }
  try {
    return await run(args.includes('--swap-gates'), args.includes('--write-golden'));
  } catch (err) {
    console.error(`silero-parity: ${errorMessage(err)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
