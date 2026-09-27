import { describe, expect, it } from 'vitest';
import { mulberry32, sine } from '../../test/dsp-helpers.ts';
import type { BiquadCoefficients } from './biquad.ts';
import { integratedLoudness, kWeighting, kWeightingCoefficients } from './normalize.ts';

// BS.1770-4 Table 1 / Table 2 coefficients at 48 kHz, as pinned by the issue.
const PINNED_SHELF: BiquadCoefficients = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
};
const PINNED_RLB: BiquadCoefficients = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };

/** Float64 two-stage DF2T reference with the given coefficients. */
function referenceKWeighting(x: Float32Array, stages: readonly BiquadCoefficients[]): Float64Array {
  const y = Float64Array.from(x);
  for (const c of stages) {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < y.length; i++) {
      const xi = y[i]!;
      const yi = c.b0 * xi + s1;
      s1 = c.b1 * xi - c.a1 * yi + s2;
      s2 = c.b2 * xi - c.a2 * yi;
      y[i] = yi;
    }
  }
  return y;
}

function meanSquare(x: ArrayLike<number>, from = 0, to = x.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i]! * x[i]!;
  return sum / (to - from);
}

function noise(n: number, seed: number, amp = 1): Float32Array {
  const rand = mulberry32(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * (2 * rand() - 1);
  return x;
}

describe('kWeighting', () => {
  it('2: coefficients at 48 kHz match BS.1770-4 within 1e-6', () => {
    const [shelf, rlb] = kWeightingCoefficients(48000);
    for (const [got, want] of [
      [shelf, PINNED_SHELF],
      [rlb, PINNED_RLB],
    ] as const) {
      for (const key of ['b0', 'b1', 'b2', 'a1', 'a2'] as const) {
        expect(Math.abs(got[key] - want[key])).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it('the returned filter runs those stages: impulse response matches the pinned reference within 1e-6', () => {
    const x = new Float32Array(4096);
    x[0] = 1;
    const y = kWeighting(48000).process(x);
    const ref = referenceKWeighting(x, [PINNED_SHELF, PINNED_RLB]);
    let maxErr = 0;
    for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(y[i]! - ref[i]!));
    expect(maxErr).toBeLessThanOrEqual(1e-6);
  });

  it('rejects an invalid fs with RangeError', () => {
    for (const fs of [0, Number.NaN, 3000]) expect(() => kWeighting(fs)).toThrow(RangeError);
  });
});

describe('integratedLoudness', () => {
  it('2: full-scale 997 Hz sine, 10 s: −3.01 ± 0.05 LUFS at 48 kHz, ± 0.1 at 44.1 and 16 kHz', () => {
    expect(Math.abs(integratedLoudness(sine(997, 48000, 10, 1), 48000) - -3.01)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(integratedLoudness(sine(997, 44100, 10, 1), 44100) - -3.01)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(integratedLoudness(sine(997, 16000, 10, 1), 16000) - -3.01)).toBeLessThanOrEqual(0.1);
  });

  it('2: −23 dBFS-amplitude 1 kHz sine, 10 s at 48 kHz: −26.01 ± 0.05 LUFS', () => {
    const x = sine(1000, 48000, 10, 10 ** (-23 / 20));
    expect(Math.abs(integratedLoudness(x, 48000) - -26.01)).toBeLessThanOrEqual(0.05);
  });

  it('short-clip rule: a 200 ms full-scale sine reads −3.01 ± 0.1 (no zero-padding)', () => {
    const x = sine(997, 48000, 0.2, 1);
    expect(x.length).toBeLessThan(0.4 * 48000);
    expect(Math.abs(integratedLoudness(x, 48000) - -3.01)).toBeLessThanOrEqual(0.1);
  });

  it('short-clip rule: equals −0.691 + 10·log10(mean square of the whole K-weighted clip)', () => {
    const x = noise(4800, 11, 0.3);
    const expected = -0.691 + 10 * Math.log10(meanSquare(kWeighting(48000).process(x)));
    expect(Math.abs(integratedLoudness(x, 48000) - expected)).toBeLessThanOrEqual(1e-9);
  });

  it('short-clip rule is ungated: a ≈ −103 LUFS 100 ms clip is finite', () => {
    const l = integratedLoudness(sine(997, 48000, 0.1, 1e-5), 48000);
    expect(Number.isFinite(l)).toBe(true);
    expect(l).toBeLessThan(-90);
  });

  it('absolute gate: a 10 s clip at ≈ −78 LUFS is −Infinity; its 200 ms version is finite', () => {
    const amp = 10 ** (-75 / 20);
    expect(integratedLoudness(sine(997, 48000, 10, amp), 48000)).toBe(-Infinity);
    const short = integratedLoudness(sine(997, 48000, 0.2, amp), 48000);
    expect(Math.abs(short - -78.01)).toBeLessThanOrEqual(0.2);
  });

  it('relative gate: 5 s at full scale then 5 s at −20 dB reads −3.01 ± 0.2, above the ungated mean', () => {
    const fs = 48000;
    const x = sine(997, fs, 10, 1);
    for (let i = 5 * fs; i < x.length; i++) x[i] = x[i]! * 0.1;
    const gated = integratedLoudness(x, fs);
    expect(Math.abs(gated - -3.01)).toBeLessThanOrEqual(0.2);
    // Ungated all-blocks mean: every 400 ms block (B = 19200, H = 4800) of the K-weighted signal.
    const y = kWeighting(fs).process(x);
    const blockLen = 19200;
    const hop = 4800;
    let sum = 0;
    let count = 0;
    for (let start = 0; start + blockLen <= y.length; start += hop) {
      sum += meanSquare(y, start, start + blockLen);
      count++;
    }
    expect(count).toBe(Math.floor((x.length - blockLen) / hop) + 1);
    const ungated = -0.691 + 10 * Math.log10(sum / count);
    expect(gated).toBeGreaterThan(ungated);
  });

  it('silence and empty input are −Infinity', () => {
    expect(integratedLoudness(new Float32Array(480_000), 48000)).toBe(-Infinity);
    expect(integratedLoudness(new Float32Array(4800), 48000)).toBe(-Infinity);
    expect(integratedLoudness(new Float32Array(0), 48000)).toBe(-Infinity);
  });

  it('boundary: exactly 0.4·fs samples uses one gated block; one sample fewer uses the short-clip rule', () => {
    const block = sine(997, 48000, 0.4, 1);
    expect(block.length).toBe(19200);
    expect(Math.abs(integratedLoudness(block, 48000) - -3.01)).toBeLessThanOrEqual(0.1);
    const shorter = block.slice(0, 19199);
    expect(Math.abs(integratedLoudness(shorter, 48000) - -3.01)).toBeLessThanOrEqual(0.1);
    // One gated block of silence is gated out, while the short-clip rule is ungated.
    const quiet = sine(997, 48000, 0.4, 1e-5);
    expect(integratedLoudness(quiet, 48000)).toBe(-Infinity);
    expect(Number.isFinite(integratedLoudness(quiet.slice(0, 19199), 48000))).toBe(true);
  });

  it('rejects an invalid fs with RangeError', () => {
    const x = new Float32Array(100);
    for (const fs of [0, Number.NaN, 3000]) expect(() => integratedLoudness(x, fs)).toThrow(RangeError);
    expect(() => integratedLoudness(new Float32Array(0), 0)).toThrow(RangeError);
  });
});
