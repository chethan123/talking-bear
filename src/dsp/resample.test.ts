import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mulberry32, rmsDb, sine, toneLevelDb } from '../../test/dsp-helpers.ts';
import {
  CUTOFF_FACTOR,
  DEFAULT_BETA,
  DEFAULT_ZERO_CROSSINGS,
  PHASES,
  createResampler,
  resampleOffline,
  type Resampler,
} from './resample.ts';

/** Default cutoff c (fraction of the input Nyquist) for a ratio, exactly as the module computes it. */
function cutoffOf(ratio: number): number {
  return CUTOFF_FACTOR * Math.min(1, ratio);
}

/** L = ceil(H) = ceil(zc / c) for the default kernel. */
function halfOf(ratio: number): number {
  return Math.ceil(DEFAULT_ZERO_CROSSINGS / cutoffOf(ratio));
}

/** Steady-state middle of an output: [2·ceil(H), M − 2·ceil(H)). */
function middle(y: Float32Array, ratio: number): [number, number] {
  const edge = 2 * halfOf(ratio);
  return [edge, y.length - edge];
}

/** Uniform white noise in [-1, 1) from a seeded PRNG. */
function noise(n: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rand() * 2 - 1;
  return x;
}

function concat(parts: Float32Array[]): Float32Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const y = new Float32Array(n);
  let off = 0;
  for (const p of parts) {
    y.set(p, off);
    off += p.length;
  }
  return y;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  return worst;
}

/** Float32 bit patterns, so comparisons are bit-exact. */
function bits(a: Float32Array): Uint32Array {
  return new Uint32Array(a.buffer, a.byteOffset, a.length);
}

/** Streams x through rs in chunks of the given sizes (cycled), then flushes; returns all outputs. */
function streamAll(rs: Resampler, x: Float32Array, sizes: readonly number[]): Float32Array {
  const parts: Float32Array[] = [];
  let off = 0;
  for (let i = 0; off < x.length; i++) {
    const size = Math.min(sizes[i % sizes.length]!, x.length - off);
    parts.push(rs.process(x.subarray(off, off + size)));
    off += size;
  }
  parts.push(rs.flush());
  return concat(parts);
}

/** Test-local float64 reference of the issue's kernel formula (independent of the module's table). */
function besselI0Ref(x: number): number {
  let sum = 0;
  let fact = 1;
  for (let k = 0; k < 30; k++) {
    if (k > 0) fact *= k;
    const t = Math.pow(x / 2, k) / fact;
    sum += t * t;
  }
  return sum;
}

function hRef(t: number, c: number, zc: number, beta: number): number {
  const halfWidth = zc / c;
  const u = t / halfWidth;
  if (Math.abs(u) >= 1) return 0;
  const x = c * t;
  const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  return c * sinc * (besselI0Ref(beta * Math.sqrt(1 - u * u)) / besselI0Ref(beta));
}

/** Frequency in cycles per sample from linearly interpolated zero crossings of y[from, to). */
function zeroCrossingFrequency(y: Float32Array, from: number, to: number): number {
  let count = 0;
  let first = 0;
  let last = 0;
  for (let i = from; i < to - 1; i++) {
    const a = y[i]!;
    const b = y[i + 1]!;
    if (a < 0 !== b < 0) {
      const t = i + a / (a - b);
      if (count === 0) first = t;
      last = t;
      count++;
    }
  }
  return (count - 1) / (2 * (last - first));
}

const LENGTH_RATIOS = [1 / 3, 160 / 441, 1 / 1.6, 1 / 2, 1 / 2.2, 1 / 0.75, 1 / 0.7];

/** The ratios the VAD decimator and the default voice use, with their input rates. */
const CORE_CASES = [
  { name: '48k → 16k (1/3)', ratio: 1 / 3, fsIn: 48_000 },
  { name: '44.1k → 16k (160/441)', ratio: 160 / 441, fsIn: 44_100 },
  { name: 'voice ×1.6 (1/1.6)', ratio: 1 / 1.6, fsIn: 48_000 },
];

describe('resample constants', () => {
  it('exports the kernel defaults that other modules mirror (zc 8, β 6, cutoff factor 0.9, 1024 phases)', () => {
    expect(DEFAULT_ZERO_CROSSINGS).toBe(8);
    expect(DEFAULT_BETA).toBe(6);
    expect(CUTOFF_FACTOR).toBe(0.9);
    expect(PHASES).toBe(1024);
  });
});

describe('resampleOffline', () => {
  it('[1] output length is Math.round(n * ratio) for n in [0, 5000]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5000 }), fc.constantFrom(...LENGTH_RATIOS), (n, r) => {
        // The length depends only on n and r, so the content is left at zero.
        expect(resampleOffline(new Float32Array(n), r).length).toBe(Math.round(n * r));
      }),
    );
  });

  describe('[3] passband: 4 tones up to 0.8 × cutoff stay within ±0.5 dB', () => {
    for (const { name, ratio, fsIn } of CORE_CASES) {
      it(name, () => {
        const fMax = 0.8 * cutoffOf(ratio) * (fsIn / 2);
        for (let i = 1; i <= 4; i++) {
          const f = (i / 4) * fMax;
          const x = sine(f, fsIn, 1);
          const y = resampleOffline(x, ratio);
          const [from, to] = middle(y, ratio);
          const gain = toneLevelDb(y, f, fsIn * ratio, from, to) - toneLevelDb(x, f, fsIn);
          expect(Math.abs(gain), `${f.toFixed(1)} Hz: ${gain.toFixed(3)} dB`).toBeLessThanOrEqual(0.5);
        }
      });
    }
  });

  it('[4] pitch: 300 Hz at 48 kHz through ratio 1/1.6, played at 48 kHz, is 480 Hz ± 1 %', () => {
    const ratio = 1 / 1.6;
    const y = resampleOffline(sine(300, 48_000, 1), ratio);
    const [from, to] = middle(y, ratio);
    const f = zeroCrossingFrequency(y, from, to) * 48_000;
    expect(Math.abs(f - 480) / 480, `${f.toFixed(3)} Hz`).toBeLessThanOrEqual(0.01);
  });

  it('[5] alias (voice): 18 kHz at 48 kHz through ratio 0.5 is at most −60 dBFS', () => {
    const ratio = 0.5;
    const y = resampleOffline(sine(18_000, 48_000, 1), ratio);
    const [from, to] = middle(y, ratio);
    const level = rmsDb(y, from, to);
    expect(level, `${level.toFixed(1)} dBFS`).toBeLessThanOrEqual(-60);
  });

  it('[7] upsampling: 2 kHz through ratio 1/0.75 stays within ±0.5 dB', () => {
    const ratio = 1 / 0.75;
    const x = sine(2000, 48_000, 1);
    const y = resampleOffline(x, ratio);
    const [from, to] = middle(y, ratio);
    const gain = toneLevelDb(y, 2000, 48_000 * ratio, from, to) - toneLevelDb(x, 2000, 48_000);
    expect(Math.abs(gain), `${gain.toFixed(3)} dB`).toBeLessThanOrEqual(0.5);
  });

  it('timing contract: an impulse at i = 100 gives y[j] = h(100 − j / ratio)', () => {
    for (const ratio of [1 / 3, 160 / 441, 1 / 1.6, 1 / 0.75]) {
      const x = new Float32Array(300);
      x[100] = 1;
      const y = resampleOffline(x, ratio);
      const c = cutoffOf(ratio);
      let worst = 0;
      for (let j = 0; j < y.length; j++) {
        const err = Math.abs(y[j]! - hRef(100 - j / ratio, c, DEFAULT_ZERO_CROSSINGS, DEFAULT_BETA));
        if (err > worst) worst = err;
      }
      expect(worst, `ratio ${ratio}`).toBeLessThanOrEqual(1e-5);
    }
  });

  it('throws RangeError on a non-finite or non-positive ratio', () => {
    const x = new Float32Array(16);
    for (const r of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => resampleOffline(x, r), `ratio ${r}`).toThrow(RangeError);
    }
  });

  it('throws RangeError on invalid options', () => {
    const x = new Float32Array(16);
    const bad = [
      { zeroCrossings: 0 },
      { zeroCrossings: 2.5 },
      { zeroCrossings: Number.NaN },
      { beta: -1 },
      { beta: Number.NaN },
      { beta: Number.POSITIVE_INFINITY },
      { cutoff: 0 },
      { cutoff: -0.1 },
      { cutoff: 1.1 },
      { cutoff: Number.NaN },
    ];
    for (const opts of bad) {
      expect(() => resampleOffline(x, 0.5, opts), JSON.stringify(opts)).toThrow(RangeError);
    }
    expect(resampleOffline(x, 0.5, { zeroCrossings: 4, beta: 0, cutoff: 1 }).length).toBe(8);
  });
});

/** The three streaming configurations of Validation 2, with the exact ratio each must produce. */
const STREAM_CASES = [
  { name: '48k → 16k', inRate: 48_000, outRate: 16_000, ratio: 1 / 3 },
  { name: '44.1k → 16k', inRate: 44_100, outRate: 16_000, ratio: 160 / 441 },
  { name: '48k → 30k (voice ×1.6)', inRate: 48_000, outRate: 30_000, ratio: 1 / 1.6 },
];

describe('createResampler', () => {
  describe('[2] streaming (random chunkings 1–512, then flush) equals resampleOffline within 1e-6', () => {
    for (const { name, inRate, outRate, ratio } of STREAM_CASES) {
      it(name, () => {
        expect(createResampler(inRate, outRate).ratio).toBe(ratio);
        fc.assert(
          fc.property(
            fc.integer({ min: 0, max: 0x7fffffff }),
            fc.array(fc.integer({ min: 1, max: 512 }), { minLength: 1, maxLength: 64 }),
            (seed, sizes) => {
              const x = noise(3000, seed);
              const y = streamAll(createResampler(inRate, outRate), x, sizes);
              const ref = resampleOffline(x, ratio);
              expect(y.length).toBe(ref.length);
              expect(maxAbsDiff(y, ref)).toBeLessThanOrEqual(1e-6);
            },
          ),
        );
      });
    }
  });

  describe('[6] alias (decimator): 9 kHz streamed in 128-sample blocks is at most −60 dBFS', () => {
    for (const { name, inRate, blocks } of [
      { name: '48k → 16k', inRate: 48_000, blocks: 375 },
      { name: '44.1k → 16k', inRate: 44_100, blocks: 345 },
    ]) {
      it(name, () => {
        const rs = createResampler(inRate, 16_000);
        const x = sine(9000, inRate, (blocks * 128) / inRate);
        expect(x.length).toBe(blocks * 128);
        const out = new Float32Array(Math.ceil(128 * rs.ratio) + 2); // preallocated, like the worklet
        const y = new Float32Array(Math.ceil(x.length * rs.ratio) + 2);
        let count = 0;
        for (let b = 0; b < blocks; b++) {
          const n = rs.processInto(x.subarray(b * 128, (b + 1) * 128), out);
          y.set(out.subarray(0, n), count);
          count += n;
        }
        const edge = 2 * rs.groupDelayInputFrames;
        const level = rmsDb(y, edge, count - edge);
        expect(level, `${level.toFixed(1)} dBFS`).toBeLessThanOrEqual(-60);
      });
    }
  });

  it('groupDelayInputFrames is ceil(H): 27 for 48k → 16k, 25 for 44.1k → 16k', () => {
    expect(createResampler(48_000, 16_000).groupDelayInputFrames).toBe(27);
    expect(createResampler(44_100, 16_000).groupDelayInputFrames).toBe(25);
    expect(createResampler(48_000, 30_000).groupDelayInputFrames).toBe(halfOf(1 / 1.6));
  });

  describe('lookahead: output j is emitted once input floor(j/r) + L arrives, never after ceil(j/r + H)', () => {
    for (const { name, inRate, outRate } of [
      ...STREAM_CASES,
      { name: '48k → 64k (upsampling)', inRate: 48_000, outRate: 64_000 },
    ]) {
      it(name, () => {
        const rs = createResampler(inRate, outRate);
        const r = rs.ratio;
        const half = rs.groupDelayInputFrames;
        const halfWidth = DEFAULT_ZERO_CROSSINGS / cutoffOf(r);
        const one = new Float32Array(1);
        const out = new Float32Array(Math.ceil(r) + 2);
        const rand = mulberry32(7);
        let emitted = 0;
        const problems: string[] = [];
        for (let n = 1; n <= 3000; n++) {
          one[0] = rand() * 2 - 1;
          emitted += rs.processInto(one, out);
          // Outputs are emitted in order, so checking the last emitted and the next pending one suffices.
          const last = emitted - 1;
          if (last >= 0 && Math.floor(last / r) + half > n - 1) problems.push(`n=${n}: j=${last} too early`);
          const next = emitted;
          if (next < Math.round(n * r) && Math.floor(next / r) + half <= n - 1) {
            problems.push(`n=${n}: j=${next} computable but not emitted`);
          }
          if (next < Math.round(n * r) && Math.ceil(next / r + halfWidth) <= n - 1) {
            problems.push(`n=${n}: j=${next} later than the documented lookahead`);
          }
        }
        expect(problems.slice(0, 5)).toEqual([]);
      });
    }
  });

  it('flush() completes the stream to Math.round(totalIn * ratio) outputs and ends it', () => {
    const rs = createResampler(48_000, 16_000);
    expect(rs.flush().length).toBe(0); // nothing fed
    rs.reset();
    let total = rs.process(noise(1000, 1)).length;
    total += rs.flush().length;
    expect(total).toBe(Math.round(1000 / 3));
    expect(rs.flush().length).toBe(0);
    expect(() => rs.process(new Float32Array(4))).toThrow(Error);
    expect(() => rs.processInto(new Float32Array(4), new Float32Array(8))).toThrow(Error);
  });

  it('reset() reproduces a fresh resampler bit-exactly (mid-stream and after flush)', () => {
    const x = noise(2500, 11);
    const sizes = [128, 37, 500, 1];
    const fresh = streamAll(createResampler(44_100, 16_000), x, sizes);
    const rs = createResampler(44_100, 16_000);
    rs.process(noise(700, 12)); // mid-stream
    rs.reset();
    expect(bits(streamAll(rs, x, sizes))).toEqual(bits(fresh));
    rs.reset(); // after flush
    expect(bits(streamAll(rs, x, sizes))).toEqual(bits(fresh));
  });

  it('processInto rejects a short out with RangeError and accepts the documented minimum', () => {
    const rs = createResampler(48_000, 16_000);
    const input = new Float32Array(128);
    const min = Math.ceil(128 * rs.ratio) + 2;
    expect(() => rs.processInto(input, new Float32Array(min - 1))).toThrow(RangeError);
    expect(rs.processInto(input, new Float32Array(min))).toBeGreaterThanOrEqual(0);
    expect(rs.processInto(new Float32Array(0), new Float32Array(2))).toBe(0);
  });

  it('throws RangeError on non-finite or non-positive rates and on invalid options', () => {
    const bad: Array<[number, number]> = [
      [0, 16_000],
      [48_000, 0],
      [-48_000, 16_000],
      [48_000, -16_000],
      [Number.NaN, 16_000],
      [48_000, Number.NaN],
      [Number.POSITIVE_INFINITY, 16_000],
      [48_000, Number.POSITIVE_INFINITY],
      [1e300, 1e-300], // ratio underflows to 0
    ];
    for (const [inRate, outRate] of bad) {
      expect(() => createResampler(inRate, outRate), `${inRate} -> ${outRate}`).toThrow(RangeError);
    }
    expect(() => createResampler(48_000, 16_000, { zeroCrossings: 0 })).toThrow(RangeError);
    expect(() => createResampler(48_000, 16_000, { beta: -1 })).toThrow(RangeError);
    expect(() => createResampler(48_000, 16_000, { cutoff: 1.5 })).toThrow(RangeError);
  });

  it('keeps working after its table is evicted from the bounded module cache', () => {
    const opts = { cutoff: 0.55 };
    const x = noise(1500, 3);
    const rs = createResampler(48_000, 24_000, opts);
    for (let i = 0; i < 20; i++) resampleOffline(new Float32Array(8), 0.5, { cutoff: 0.6 + i * 0.01 });
    const y = streamAll(rs, x, [100]);
    expect(bits(y)).toEqual(bits(resampleOffline(x, 0.5, opts)));
  });
});

describe('[9] timing (informational, not a gate)', () => {
  it('logs the time to resampleOffline 5 s of 48 kHz noise at ratio 1/1.6', () => {
    const ratio = 1 / 1.6;
    const x = noise(5 * 48_000, 9);
    resampleOffline(x.subarray(0, 4800), ratio); // warm-up: JIT and the table cache
    const t0 = performance.now();
    const y = resampleOffline(x, ratio);
    const ms = performance.now() - t0;
    console.log(`[T10 timing] resampleOffline, 5 s of 48 kHz noise at ratio 1/1.6: ${ms.toFixed(1)} ms`);
    expect(y.length).toBe(Math.round(x.length * ratio)); // sanity only; the time is not asserted
  });
});
