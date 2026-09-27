import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../test/dsp-helpers.ts';
import { createRealFft } from './fft.ts';

/** Uniform white noise in [-1, 1) from a seeded PRNG. */
function noise(n: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 2 * rand() - 1;
  return x;
}

/** Naive O(n²) float64 DFT, bins 0…n/2. */
function naiveDft(x: Float32Array): { re: Float64Array; im: Float64Array } {
  const n = x.length;
  const re = new Float64Array(n / 2 + 1);
  const im = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const ph = (2 * Math.PI * ((k * t) % n)) / n;
      sr += x[t]! * Math.cos(ph);
      si -= x[t]! * Math.sin(ph);
    }
    re[k] = sr;
    im[k] = si;
  }
  return { re, im };
}

function runFft(x: Float32Array): { re: Float32Array; im: Float32Array } {
  const n = x.length;
  const re = new Float32Array(n / 2 + 1);
  const im = new Float32Array(n / 2 + 1);
  createRealFft(n).forward(x, re, im);
  return { re, im };
}

describe('createRealFft', () => {
  it.each([4, 8, 256, 1024, 2048, 4096])('1a: matches a naive DFT within 1e-4 of the peak (n = %i)', (n) => {
    const x = noise(n, 1000 + n);
    const { re, im } = runFft(x);
    const ref = naiveDft(x);
    let peak = 0;
    let err = 0;
    for (let k = 0; k <= n / 2; k++) {
      peak = Math.max(peak, Math.hypot(ref.re[k]!, ref.im[k]!));
      err = Math.max(err, Math.hypot(re[k]! - ref.re[k]!, im[k]! - ref.im[k]!));
    }
    expect(peak).toBeGreaterThan(0);
    expect(err / peak).toBeLessThanOrEqual(1e-4);
  });

  it('1b: a sine or cosine lands in its bin', () => {
    const n = 1024;
    for (const [bin, fn] of [
      [37, Math.sin],
      [100, Math.cos],
    ] as const) {
      const x = new Float32Array(n);
      for (let t = 0; t < n; t++) x[t] = fn((2 * Math.PI * bin * t) / n);
      const { re, im } = runFft(x);
      let argmax = -1;
      let max = -1;
      for (let k = 0; k <= n / 2; k++) {
        const mag = Math.hypot(re[k]!, im[k]!);
        if (mag > max) {
          max = mag;
          argmax = k;
        }
        if (k !== bin) expect(mag).toBeLessThan(1e-3 * n);
      }
      expect(argmax).toBe(bin);
      expect(Math.abs(max - n / 2)).toBeLessThan(1e-3 * n);
    }
  });

  it.each([256, 1024, 2048])('1c: Parseval holds within 1e-4 (n = %i)', (n) => {
    const x = noise(n, 2000 + n);
    const { re, im } = runFft(x);
    let timeEnergy = 0;
    for (let t = 0; t < n; t++) timeEnergy += x[t]! * x[t]!;
    const mag2 = (k: number): number => re[k]! * re[k]! + im[k]! * im[k]!;
    let freqEnergy = mag2(0) + mag2(n / 2);
    for (let k = 1; k < n / 2; k++) freqEnergy += 2 * mag2(k);
    freqEnergy /= n;
    expect(Math.abs(freqEnergy - timeEnergy) / timeEnergy).toBeLessThanOrEqual(1e-4);
  });

  it('DC and Nyquist inputs land in bins 0 and n/2; im[0] and im[n/2] are exactly 0', () => {
    const n = 512;
    const dc = new Float32Array(n).fill(1);
    const a = runFft(dc);
    expect(a.re[0]).toBe(n);
    for (let k = 1; k <= n / 2; k++) {
      expect(Math.abs(a.re[k]!)).toBeLessThanOrEqual(1e-9 * n);
      expect(Math.abs(a.im[k]!)).toBeLessThanOrEqual(1e-9 * n);
    }
    const alt = new Float32Array(n);
    for (let t = 0; t < n; t++) alt[t] = t % 2 === 0 ? 1 : -1;
    const b = runFft(alt);
    expect(b.re[n / 2]).toBe(n);
    expect(Math.abs(b.re[0]!)).toBeLessThanOrEqual(1e-9 * n);
    for (const r of [a, b]) {
      expect(r.im[0]).toBe(0);
      expect(r.im[n / 2]).toBe(0);
    }
  });

  it('an instance can be reused: the second result equals a fresh instance bit-exact', () => {
    const n = 2048;
    const fft = createRealFft(n);
    const re = new Float32Array(n / 2 + 1);
    const im = new Float32Array(n / 2 + 1);
    fft.forward(noise(n, 1), re, im);
    const x2 = noise(n, 2);
    fft.forward(x2, re, im);
    const fresh = runFft(x2);
    expect(Array.from(re)).toEqual(Array.from(fresh.re));
    expect(Array.from(im)).toEqual(Array.from(fresh.im));
  });

  it('writes only bins 0…n/2 into longer output arrays', () => {
    const n = 256;
    const re = new Float32Array(n).fill(7);
    const im = new Float32Array(n).fill(7);
    createRealFft(n).forward(noise(n, 3), re, im);
    for (let k = n / 2 + 1; k < n; k++) {
      expect(re[k]).toBe(7);
      expect(im[k]).toBe(7);
    }
    expect(re[n / 2]).not.toBe(7);
  });

  it('rejects invalid sizes and buffer lengths with RangeError', () => {
    for (const n of [0, 2, 3, 100, 1000, 131072, 1024.5, Number.NaN]) {
      expect(() => createRealFft(n)).toThrow(RangeError);
    }
    const n = 256;
    const fft = createRealFft(n);
    const ok = new Float32Array(n / 2 + 1);
    expect(() => fft.forward(new Float32Array(n - 1), ok, ok.slice())).toThrow(RangeError);
    expect(() => fft.forward(new Float32Array(n + 1), ok, ok.slice())).toThrow(RangeError);
    expect(() => fft.forward(new Float32Array(n), new Float32Array(n / 2), ok)).toThrow(RangeError);
    expect(() => fft.forward(new Float32Array(n), ok, new Float32Array(n / 2))).toThrow(RangeError);
  });
});
