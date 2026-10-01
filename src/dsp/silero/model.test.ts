import { readFileSync } from 'node:fs';
import { GCProfiler, setFlagsFromString } from 'node:v8';
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

/** Runs a full garbage collection. */
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
}

/**
 * `heapUsed` growth in bytes over `fn`, measured from a freshly collected heap. If any GC ran during `fn`,
 * the reading is meaningless (a scavenge frees the garbage it should count), so it returns +Infinity.
 */
function heapGrowth(fn: () => void): number {
  forceGc();
  const profiler = new GCProfiler();
  profiler.start();
  const before = process.memoryUsage().heapUsed;
  fn();
  const growth = process.memoryUsage().heapUsed - before;
  return profiler.stop().statistics.length > 0 ? Number.POSITIVE_INFINITY : growth;
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
    // Warm up so V8's optimising compilers take over (until then every double is boxed). The floor of about
    // 20 B per frame is the HeapNumber that boxes the returned p, inherent to process(): number; one
    // subarray per frame adds about 130 B per frame. As in clip.test.ts, take the best of up to 20 runs, each
    // from a freshly collected heap; a run during which any GC ran counts as +Infinity.
    forceGc();
    for (let i = 0; i < 300; i++) model.process(frameAt(i));
    let best = heapGrowth(run);
    for (let trial = 1; trial < 20 && best >= LIMIT; trial++) best = Math.min(best, heapGrowth(run));
    expect(best).toBeLessThan(LIMIT);
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
    for (let i = 0; i < 300; i++) model.process(frameAt(i));
    // Retry until a run is GC-free: +Infinity alone would pass the bound without proving anything.
    let growth = heapGrowth(run);
    for (let trial = 1; trial < 20 && !Number.isFinite(growth); trial++) growth = heapGrowth(run);
    expect(kept.every((v) => v !== undefined)).toBe(true);
    expect(Number.isFinite(growth)).toBe(true);
    expect(growth).toBeGreaterThanOrEqual(LIMIT);
  });
});
