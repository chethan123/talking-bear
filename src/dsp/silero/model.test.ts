import { readFileSync } from 'node:fs';
import { GCProfiler, getHeapSpaceStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { readWav } from '../../../test/wav.ts';
import { resampleOffline } from '../resample.ts';
import { SILERO_FRAME, createSilero, type SileroModel } from './model.ts';
import { decodeWeights, type SileroWeights } from './weights.ts';

// The shipped weights (weights.bin: fp16 or fp32 per tensor), as the app uses them. No ORT and no ONNX here:
// scripts/silero-parity.ts (pnpm parity) checks the port against onnxruntime-web and keeps golden.json, the
// ORT p of vowel_f0-140.wav, up to date. This file's golden test is the coarse, ORT-free guard; parity's
// Tier 1 (fp32 weights, max|Δp| < 1e-4) guards the fine details, such as the regenerated STFT basis.

function shippedWeights(): SileroWeights {
  const bytes = readFileSync(new URL('./weights.bin', import.meta.url));
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return decodeWeights(buf);
}

const W = shippedWeights();
const FIXTURES = new URL('../../../test/fixtures/', import.meta.url);

/**
 * The 16 kHz 512-sample frames of a 48 kHz fixture: resampleOffline(x, 1 / 3), the trailing partial frame
 * dropped, exactly as scripts/silero-parity.ts cuts them.
 */
function fixtureFrames(name: string): Float32Array[] {
  const wav = readWav(readFileSync(new URL(`${name}.wav`, FIXTURES)));
  if (wav.sampleRate !== 48_000 || wav.channels.length !== 1) {
    throw new Error(`${name}.wav: expected 48 kHz mono, got ${wav.sampleRate} Hz × ${wav.channels.length}`);
  }
  const x = resampleOffline(wav.channels[0]!, 1 / 3);
  const frames: Float32Array[] = [];
  for (let i = 0; i + SILERO_FRAME <= x.length; i += SILERO_FRAME)
    frames.push(x.subarray(i, i + SILERO_FRAME));
  return frames;
}

function runAll(model: SileroModel, frames: readonly Float32Array[]): number[] {
  return frames.map((frame) => model.process(frame));
}

interface Golden {
  file: string;
  p: number[];
}

function readGolden(): Golden {
  const value: unknown = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('golden.json is not an object');
  const file: unknown = Reflect.get(value, 'file');
  const p: unknown = Reflect.get(value, 'p');
  if (typeof file !== 'string' || !Array.isArray(p) || !p.every((v): v is number => typeof v === 'number')) {
    throw new Error('golden.json is not { file: string, p: number[] }');
  }
  return { file, p };
}

const vowel = fixtureFrames('vowel_f0-140');
/** long_12s's 415 frames, cut beforehand for the allocation tests. */
const long = fixtureFrames('long_12s');
/** Frame i of an allocation-test run: long[i % 415]. */
const frameAt = (i: number): Float32Array => long[i % long.length]!;

describe('createSilero on the shipped weights', () => {
  const golden = readGolden();
  const A = runAll(createSilero(W), vowel);

  it('matches golden.json (the ORT p) on vowel_f0-140.wav within 5e-3', () => {
    expect(golden.file).toBe('vowel_f0-140.wav');
    expect(vowel).toHaveLength(87);
    expect(golden.p).toHaveLength(vowel.length);
    let worst = 0;
    for (let i = 1; i < A.length; i++) {
      if (Math.abs(A[i]! - golden.p[i]!) > Math.abs(A[worst]! - golden.p[worst]!)) worst = i;
    }
    const d = Math.abs(A[worst]! - golden.p[worst]!);
    expect(d, `worst frame ${worst}: TS ${A[worst]}, golden ${golden.p[worst]}`).toBeLessThan(5e-3);
  });

  it('gives identical outputs after reset(), and the same as a fresh model', () => {
    const model = createSilero(W);
    expect(runAll(model, vowel)).toEqual(A);
    // Dirty h, c and the context, then reset.
    runAll(model, long.slice(0, 50));
    model.reset();
    expect(runAll(model, vowel)).toEqual(A);
    expect(runAll(createSilero(W), vowel)).toEqual(A);
  });

  it('keeps p < 0.1 on every frame of silence_2s', () => {
    const p = runAll(createSilero(W), fixtureFrames('silence_2s'));
    expect(p.length).toBeGreaterThan(0);
    const max = Math.max(...p);
    expect(max).toBeLessThan(0.1);
  });

  it('throws a RangeError for a frame of any length other than 512', () => {
    const model = createSilero(W);
    for (const n of [511, 513, 0])
      expect(() => model.process(new Float32Array(n)), String(n)).toThrow(RangeError);
  });

  it('rejects a tensor of the wrong length, naming it', () => {
    expect(() => createSilero({ ...W, lstmWhh: W.lstmWhh.subarray(1) })).toThrow(RangeError);
    expect(() => createSilero({ ...W, lstmWhh: W.lstmWhh.subarray(1) })).toThrow(/lstmWhh/);
  });

  it('keeps independent state per model (two models interleaved frame by frame)', () => {
    const m1 = createSilero(W);
    const m2 = createSilero(W);
    const p1: number[] = [];
    const p2: number[] = [];
    for (const frame of vowel) {
      p1.push(m1.process(frame));
      p2.push(m2.process(frame));
    }
    expect(p1).toEqual(A);
    expect(p2).toEqual(A);
  });
});

type Constructor = new (...args: never[]) => object;

/** Wraps `original` so that every `new` of it, including those inside its static `from` and `of`, calls `onNew`. */
function countingConstructor<C extends Constructor>(original: C, onNew: () => void): C {
  return new Proxy(original, {
    construct(target, args: never[], newTarget: Constructor): object {
      onNew();
      return Reflect.construct(target, args, newTarget);
    },
  });
}

/** `%TypedArray%.prototype`, which every typed array class inherits its methods from. */
const TYPED_ARRAY_PROTOTYPE = Reflect.getPrototypeOf(Float32Array.prototype) ?? Float32Array.prototype;
/** Its methods that return a new typed array. */
const TYPED_ARRAY_METHODS = ['slice', 'map', 'filter', 'subarray', 'toReversed', 'toSorted', 'with'] as const;

/**
 * Runs `fn` and counts the allocations it makes through the array globals (a copy of src/anim/clip.test.ts's
 * meter): every `new` of `Array`, `ArrayBuffer`, `Float32Array` or `Float64Array` (static `from` and `of`
 * included, and `new` through a typed array's `constructor`), and every call of an allocating
 * `%TypedArray%.prototype` method. Everything is restored afterwards.
 */
function countAllocations(fn: () => void): number {
  let count = 0;
  const onNew = (): void => {
    count++;
  };
  const saved: { obj: object; key: string; desc: PropertyDescriptor }[] = [];
  const patch = (obj: object, key: string, value: unknown): void => {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc === undefined) throw new Error(`nothing to patch at ${key}`);
    saved.push({ obj, key, desc });
    Object.defineProperty(obj, key, { ...desc, value });
  };
  const float32 = countingConstructor(Float32Array, onNew);
  const float64 = countingConstructor(Float64Array, onNew);
  patch(Float32Array.prototype, 'constructor', float32);
  patch(Float64Array.prototype, 'constructor', float64);
  patch(globalThis, 'Array', countingConstructor(Array, onNew));
  patch(globalThis, 'ArrayBuffer', countingConstructor(ArrayBuffer, onNew));
  patch(globalThis, 'Float32Array', float32);
  patch(globalThis, 'Float64Array', float64);
  for (const name of TYPED_ARRAY_METHODS) {
    const original: unknown = Reflect.get(TYPED_ARRAY_PROTOTYPE, name);
    if (typeof original !== 'function') throw new Error(`no %TypedArray%.prototype.${name}`);
    patch(TYPED_ARRAY_PROTOTYPE, name, function (this: unknown, ...args: unknown[]): unknown {
      count++;
      return Reflect.apply(original, this, args);
    });
  }
  try {
    fn();
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) {
      const { obj, key, desc } = saved[i]!;
      Object.defineProperty(obj, key, desc);
    }
  }
  return count;
}

/** The `gc` function, exposed once at runtime with Node built-ins only (no `--expose-gc` flag needed). */
let exposedGc: (() => void) | undefined;

/**
 * Runs two full garbage collections. After one, V8 can still be freeing what it found, concurrently: after a reading
 * with GCs, heapUsed then fell by up to 225 KB during the next reading, with no GC (#246). The second one finds almost
 * nothing to free.
 */
function forceGc(): void {
  if (exposedGc === undefined) {
    setFlagsFromString('--expose-gc');
    const gc: unknown = runInNewContext('gc');
    if (typeof gc !== 'function') throw new Error('gc() is not available');
    exposedGc = (): void => {
      gc();
    };
  }
  exposedGc();
  exposedGc();
}

/** `%GetOptimizationStatus`, exposed once at runtime the same way as `gc` (no `--allow-natives-syntax` flag needed). */
let exposedStatus: ((fn: unknown) => number) | undefined;

/**
 * V8's optimisation status bits of `model`'s process() closure (`%GetOptimizationStatus`; the bits are V8's
 * `OptimizationStatus`, src/runtime/runtime.h, checked on Node 24.21 and V8 13.6).
 */
function processStatus(model: SileroModel): number {
  if (exposedStatus === undefined) {
    setFlagsFromString('--allow-natives-syntax');
    const status: unknown = runInNewContext('(fn) => %GetOptimizationStatus(fn)');
    if (typeof status !== 'function') throw new Error('%GetOptimizationStatus is not available');
    exposedStatus = (fn: unknown): number => {
      const bits: unknown = status(fn);
      if (typeof bits !== 'number') throw new Error('%GetOptimizationStatus returned no number');
      return bits;
    };
  }
  // The closure itself, unbound: %GetOptimizationStatus reads its code and never calls it.
  return exposedStatus(Reflect.get(model, 'process'));
}

/** `OptimizationStatus` bits: the function runs TurboFan, Maglev, Sparkplug or Ignition code; a job is compiling it. */
const TURBOFANNED = 1 << 6;
const MAGLEVVED = 1 << 5;
const BASELINE = 1 << 15;
const INTERPRETED = 1 << 7;
const OPTIMIZING_CONCURRENTLY = 1 << 10;

/**
 * The tier of a function with optimisation status `bits`, as a report shows it. `status N` also appears for a function
 * whose only optimised code is OSR code.
 */
function tierName(bits: number): string {
  const tier =
    bits & TURBOFANNED
      ? 'TurboFan'
      : bits & MAGLEVVED
        ? 'Maglev'
        : bits & BASELINE
          ? 'Sparkplug'
          : bits & INTERPRETED
            ? 'Ignition'
            : `status ${bits}`;
  return bits & OPTIMIZING_CONCURRENTLY ? `${tier}, optimising concurrently` : tier;
}

/** `heapUsed` growth in bytes over `fn`, and whether any GC ran during it (a scavenge frees garbage it should count). */
function heapUsedOver(fn: () => void): { bytes: number; gc: boolean } {
  const profiler = new GCProfiler();
  profiler.start();
  const before = process.memoryUsage().heapUsed;
  fn();
  const bytes = process.memoryUsage().heapUsed - before;
  return { bytes, gc: profiler.stop().statistics.length > 0 };
}

/** Frames per warm-up chunk. */
const WARM_UP_CHUNK = 50;
/**
 * A warm-up chunk that grows the heap by less than this per frame with no GC shows process(), and the conv1d it calls
 * (which this file can't reach), running optimised code: TurboFan's steady state is about 20 B per frame, while below
 * TurboFan the loops box doubles, kilobytes per frame or more (#246).
 */
const STEADY_BYTES_PER_FRAME = 1024;
/**
 * The longest the warm-up waits for the steady state; idle, V8 reaches it within 150 frames. The bound plus one reading
 * of 1000 frames takes at most about 12 s idle and 23 s under v8 coverage (11.1 s and 21.8 s measured with the budget
 * forced to run out), under half the 60 s timeout. If the state isn't reached within the bound, the loop of up to 20
 * readings continues, as before #246: a late pass can take up to the timeout, and a failure takes about 55 s idle and
 * several minutes under coverage, and reports its assertion and readings.
 */
const WARM_UP_BUDGET_MS = 10_000;

/**
 * Whether a warm-up chunk shows the steady state: process() is TurboFan code (status `bits`), and the chunk grew the
 * heap by `bytes`, less than STEADY_BYTES_PER_FRAME per frame, with no GC and no fall.
 */
function steadyChunk(bits: number, bytes: number, gc: boolean): boolean {
  return (bits & TURBOFANNED) !== 0 && !gc && bytes >= 0 && bytes < WARM_UP_CHUNK * STEADY_BYTES_PER_FRAME;
}

/** What the warm-up did: frames run, time taken, whether it reached the optimised state, and the last chunk. */
interface WarmUp {
  frames: number;
  ms: number;
  optimised: boolean;
  last: string;
}

/**
 * Runs `model` in chunks of WARM_UP_CHUNK frames until V8 has optimised it: process() is TurboFan code and a chunk
 * grew the heap by less than STEADY_BYTES_PER_FRAME per frame with no GC, and heapUsed didn't fall. It stops after
 * WARM_UP_BUDGET_MS anyway. Under CPU load, V8's background compilers can take seconds longer to deliver TurboFan
 * code (#246), so a fixed warm-up can leave every reading below TurboFan, where each one has a GC.
 */
function warmUp(model: SileroModel): WarmUp {
  const start = performance.now();
  for (let frames = WARM_UP_CHUNK; ; frames += WARM_UP_CHUNK) {
    const { bytes, gc } = heapUsedOver(() => {
      for (let i = frames - WARM_UP_CHUNK; i < frames; i++) model.process(frameAt(i));
    });
    const bits = processStatus(model);
    const optimised = steadyChunk(bits, bytes, gc);
    const ms = Math.round(performance.now() - start);
    if (optimised || ms >= WARM_UP_BUDGET_MS) {
      return {
        frames,
        ms,
        optimised,
        last: `process() ${tierName(bits)}; last chunk ${bytes} B${gc ? ' (GC)' : ''}`,
      };
    }
  }
}

/** A heap space's name and used bytes, as v8.getHeapSpaceStatistics() lists them. */
interface SpaceUsed {
  space_name: string;
  space_used_size: number;
}

/**
 * The heap's growth in bytes from snapshot `before` to snapshot `after` of its spaces, summed over the spaces (heapUsed
 * is their sum), and the spaces that shrank, with how much ('' if none did).
 */
function spaceGrowth(
  before: readonly SpaceUsed[],
  after: readonly SpaceUsed[],
): { bytes: number; shrank: string } {
  let bytes = 0;
  const shrank: string[] = [];
  for (const { space_name: space, space_used_size: used } of after) {
    const grew = used - (before.find((s) => s.space_name === space)?.space_used_size ?? 0);
    bytes += grew;
    if (grew < 0) shrank.push(`${space} by ${-grew} B`);
  }
  return { bytes, shrank: shrank.join(', ') };
}

/**
 * spaceGrowth over `fn`: the heap's growth in bytes (heapUsed's growth, plus what the two snapshots themselves
 * allocate, a few KB) and the spaces that shrank, and whether any GC ran during it (a scavenge frees garbage it should
 * count).
 */
function heapSpacesOver(fn: () => void): { bytes: number; gc: boolean; shrank: string } {
  const profiler = new GCProfiler();
  profiler.start();
  const before = getHeapSpaceStatistics();
  fn();
  const after = getHeapSpaceStatistics();
  return { ...spaceGrowth(before, after), gc: profiler.stop().statistics.length > 0 };
}

/**
 * One 1000-frame reading: the heap's growth in bytes, whether a GC ran, the heap spaces that shrank (heapSpacesOver),
 * and process()'s tier after it.
 */
interface HeapReading {
  bytes: number;
  gc: boolean;
  shrank: string;
  tier: string;
}

/**
 * A reading counts only if no GC ran during it, and neither heapUsed nor any heap space shrank: process() never frees
 * memory, so a fall means the heap moved for a reason outside the run. heapUsed fell right after readings with GCs
 * (#246). And just after the forced GCs, V8 can still release code, trusted or old space, up to about a page, which
 * shaved readings of a real allocation of about 300 B per frame to under LIMIT while the allocation itself grew new
 * space (#262).
 */
function qualifies(r: HeapReading): boolean {
  return !r.gc && r.bytes >= 0 && r.shrank === '';
}

/** The smallest qualifying reading's bytes, or +Infinity if none qualified. */
function bestQualifying(readings: HeapReading[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const r of readings) if (qualifies(r)) best = Math.min(best, r.bytes);
  return best;
}

/** The steady state the warm-up waits for, as the report names it. */
const STEADY = `process() TurboFan and a GC-free chunk under ${STEADY_BYTES_PER_FRAME} B per frame`;

/** Why a GC-free reading doesn't qualify, as its report line ends ('' if it qualifies). */
function fallNote(r: HeapReading): string {
  if (r.shrank !== '') return `; shrank without a GC: ${r.shrank}`;
  return r.bytes < 0 ? '; heapUsed fell without a GC' : '';
}

/** The report of a measurement: the warm-up, every reading, and the outcome (bestQualifying of the readings). */
function heapReport(warm: WarmUp, readings: HeapReading[]): string {
  const best = bestQualifying(readings);
  const lines = [
    warm.optimised
      ? `warm-up: ${warm.frames} frames, ${warm.ms} ms, until steady: ${STEADY} (${warm.last})`
      : `warm-up: ${warm.frames} frames, ${warm.ms} ms, stopped at the ${WARM_UP_BUDGET_MS} ms budget before a steady chunk (${STEADY}) (${warm.last})`,
    ...readings.map(
      (r, i) =>
        `reading ${i + 1}: ${r.bytes} B${r.gc ? ' (GC)' : ''}, process() ${r.tier}${r.gc ? '' : fallNote(r)}`,
    ),
  ];
  if (Number.isFinite(best)) {
    lines.push(`best qualifying reading: ${best} B per 1000 frames`);
  } else {
    const gcs = readings.filter((r) => r.gc).length;
    lines.push(
      `no reading qualified: ${gcs} of ${readings.length} had a GC, ${readings.length - gcs} showed a heap space shrinking without one`,
    );
  }
  return lines.join('\n');
}

/** The smallest qualifying reading (+Infinity if none), and the report. */
interface Measurement {
  best: number;
  report: string;
}

/**
 * Warms `model` up, then takes up to 20 readings of `run` (1000 frames each), each from a freshly collected heap,
 * until `done(best)`, where `best` is the smallest qualifying reading so far (+Infinity before the first).
 */
function measure(model: SileroModel, run: () => void, done: (best: number) => boolean): Measurement {
  const warm = warmUp(model);
  const readings: HeapReading[] = [];
  let best = Number.POSITIVE_INFINITY;
  while (readings.length < 20 && !done(best)) {
    forceGc();
    const { bytes, gc, shrank } = heapSpacesOver(run);
    readings.push({ bytes, gc, shrank, tier: tierName(processStatus(model)) });
    best = bestQualifying(readings);
  }
  return { best, report: heapReport(warm, readings) };
}

describe('process() allocates nothing', () => {
  /** 64 B per frame over 1000 frames. */
  const LIMIT = 65_536;

  it('makes no array or typed-array allocation over 200 frames', () => {
    expect(long).toHaveLength(415);
    const model = createSilero(W);
    const allocations = countAllocations(() => {
      for (let i = 0; i < 200; i++) model.process(frameAt(i));
    });
    expect(allocations).toBe(0);
  });

  it('grows the heap by < 64 KB over 1000 frames, once V8 has optimised it', { timeout: 60_000 }, () => {
    const model = createSilero(W);
    const run = (): void => {
      for (let i = 0; i < 1000; i++) model.process(frameAt(i));
    };
    // The floor of about 20 B per frame is the HeapNumber that boxes the returned p, inherent to process(): number;
    // one subarray per frame adds about 130 B per frame. As in clip.test.ts, take the best of up to 20 readings.
    const { best, report } = measure(model, run, (b) => b < LIMIT);
    expect(best, report).toBeLessThan(LIMIT);
  });

  it('both meters have teeth (positive controls)', { timeout: 60_000 }, () => {
    const frame = frameAt(0);
    expect(countAllocations(() => void frame.subarray(1))).toBeGreaterThan(0);
    const model = createSilero(W);
    const kept = Array.from<Float32Array | undefined>({ length: 1000 });
    const run = (): void => {
      for (let i = 0; i < 1000; i++) {
        model.process(frameAt(i));
        kept[i] = frameAt(i).subarray(1);
      }
    };
    // Read until a reading qualifies: +Infinity alone would pass the bound without proving anything.
    const leak = measure(model, run, (b) => Number.isFinite(b));
    expect(kept.every((v) => v !== undefined)).toBe(true);
    expect(Number.isFinite(leak.best), leak.report).toBe(true);
    expect(leak.best, leak.report).toBeGreaterThanOrEqual(LIMIT);
  });

  it('lists the warm-up, every reading and why none qualified in its heap report', () => {
    // Readings recorded on #246: TurboFan disabled in the worker (the failure's shape), and a compile delay on main.
    const stalled: WarmUp = {
      frames: 3600,
      ms: 10_064,
      optimised: false,
      last: 'process() Maglev; last chunk -4547360 B (GC)',
    };
    const maglev: HeapReading[] = [
      { bytes: 2_317_208, gc: true, shrank: '', tier: 'Maglev' },
      { bytes: 2_315_696, gc: true, shrank: '', tier: 'Maglev' },
    ];
    expect(bestQualifying(maglev)).toBe(Number.POSITIVE_INFINITY);
    expect(heapReport(stalled, maglev).split('\n')).toEqual([
      'warm-up: 3600 frames, 10064 ms, stopped at the 10000 ms budget before a steady chunk (process() TurboFan and a GC-free chunk under 1024 B per frame) (process() Maglev; last chunk -4547360 B (GC))',
      'reading 1: 2317208 B (GC), process() Maglev',
      'reading 2: 2315696 B (GC), process() Maglev',
      'no reading qualified: 2 of 2 had a GC, 0 showed a heap space shrinking without one',
    ]);
    const warm: WarmUp = {
      frames: 100,
      ms: 110,
      optimised: true,
      last: 'process() TurboFan; last chunk 1040 B',
    };
    const fell: HeapReading = { bytes: -104_480, gc: false, shrank: '', tier: 'TurboFan' };
    const steady: HeapReading = { bytes: 29_488, gc: false, shrank: '', tier: 'TurboFan' };
    const larger: HeapReading = { bytes: 31_000, gc: false, shrank: '', tier: 'TurboFan' };
    expect(bestQualifying([fell, larger, steady])).toBe(29_488);
    expect(qualifies(fell)).toBe(false);
    expect(bestQualifying([fell, steady])).toBe(29_488);
    expect(heapReport(warm, [fell]).split('\n').at(-1)).toBe(
      'no reading qualified: 0 of 1 had a GC, 1 showed a heap space shrinking without one',
    );
    expect(heapReport(warm, [fell, steady]).split('\n')).toEqual([
      'warm-up: 100 frames, 110 ms, until steady: process() TurboFan and a GC-free chunk under 1024 B per frame (process() TurboFan; last chunk 1040 B)',
      'reading 1: -104480 B, process() TurboFan; heapUsed fell without a GC',
      'reading 2: 29488 B, process() TurboFan',
      'best qualifying reading: 29488 B per 1000 frames',
    ]);
    // The warm-up's exit test: status 81 is TurboFan, 49 Maglev (Node 24.21); 51 200 B is 1024 B × 50 frames.
    expect(steadyChunk(81, 1040, false)).toBe(true);
    expect(steadyChunk(49, 1040, false)).toBe(false);
    expect(steadyChunk(81, 1040, true)).toBe(false);
    expect(steadyChunk(81, -1, false)).toBe(false);
    expect(steadyChunk(81, 51_200, false)).toBe(false);
  });

  it('measures each V8 space, and rejects a reading in which one shrank', () => {
    // Readings recorded on #262, idle, with about 300 B per frame escaping from process() (a scratch
    // Array.from({ length: 4 }) per frame). The spaces' sizes before are a fresh worker's; the changes are recorded.
    const before: SpaceUsed[] = [
      { space_name: 'read_only_space', space_used_size: 0 },
      { space_name: 'new_space', space_used_size: 397_744 },
      { space_name: 'old_space', space_used_size: 2_942_792 },
      { space_name: 'code_space', space_used_size: 26_304 },
      { space_name: 'trusted_space', space_used_size: 989_384 },
    ];
    const grown = (changes: number[]): SpaceUsed[] =>
      before.map((s, i) => ({ ...s, space_used_size: s.space_used_size + (changes[i] ?? 0) }));
    // V8 released code and old space during the reading, and heapUsed grew by only 86 120 B.
    expect(spaceGrowth(before, grown([0, 298_856, -2904, -211_104, 1272]))).toEqual({
      bytes: 86_120,
      shrank: 'old_space by 2904 B, code_space by 211104 B',
    });
    expect(spaceGrowth(before, grown([0, 298_864, 32, 3456, 4664]))).toEqual({ bytes: 307_016, shrank: '' });
    // A reading shaved under LIMIT by such a release no longer qualifies, so the unshaved one decides.
    const shaved: HeapReading = {
      bytes: 57_000,
      gc: false,
      shrank: 'old_space by 16352 B, code_space by 210720 B',
      tier: 'TurboFan',
    };
    const unshaved: HeapReading = { bytes: 283_704, gc: false, shrank: '', tier: 'TurboFan' };
    expect(qualifies(shaved)).toBe(false);
    expect(bestQualifying([unshaved, shaved])).toBe(283_704);
    const warm: WarmUp = {
      frames: 100,
      ms: 120,
      optimised: true,
      last: 'process() TurboFan; last chunk 13440 B',
    };
    expect(heapReport(warm, [unshaved, shaved]).split('\n').slice(1)).toEqual([
      'reading 1: 283704 B, process() TurboFan',
      'reading 2: 57000 B, process() TurboFan; shrank without a GC: old_space by 16352 B, code_space by 210720 B',
      'best qualifying reading: 283704 B per 1000 frames',
    ]);
  });
});
