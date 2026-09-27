import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../test/dsp-helpers.ts';
import { applyFades } from './fades.ts';

function raisedCosine(i: number, len: number): number {
  return 0.5 - 0.5 * Math.cos((Math.PI * i) / len);
}

/** Checks the fade shape at both ends (within 1e-6) and that x[len, n − len) is bit-identical to the input. */
function expectFaded(x: Float32Array, input: Float32Array, len: number): void {
  const n = x.length;
  for (let i = 0; i < len; i++) {
    const g = raisedCosine(i, len);
    expect(Math.abs(x[i]! - input[i]! * g)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(x[n - 1 - i]! - input[n - 1 - i]! * g)).toBeLessThanOrEqual(1e-6);
  }
  for (let i = len; i < n - len; i++) expect(Object.is(x[i], input[i])).toBe(true);
}

describe('applyFades', () => {
  it('7: 8 ms at 48 kHz — ends ×0, raised-cosine shape within 1e-6, middle unchanged', () => {
    const input = new Float32Array(48_000).fill(0.7);
    const x = input.slice();
    applyFades(x, 48000);
    expect(x[0]).toBe(0);
    expect(x[x.length - 1]).toBe(0);
    expectFaded(x, input, 384);
    expect(x[383]).toBeLessThan(0.7);
    expect(x[384]).toBe(input[384]);
  });

  it('random input: first and last samples are zero, middle bit-identical', () => {
    const rand = mulberry32(7);
    const input = new Float32Array(10_000);
    for (let i = 0; i < input.length; i++) input[i] = 2 * rand() - 1;
    const x = input.slice();
    applyFades(x, 48000);
    expect(Math.abs(x[0]!)).toBe(0);
    expect(Math.abs(x[x.length - 1]!)).toBe(0);
    expectFaded(x, input, 384);
  });

  it('uses round(ms·fs/1000) samples: 10 ms at 44.1 kHz is 441', () => {
    const input = new Float32Array(4410).fill(-0.25);
    const x = input.slice();
    applyFades(x, 44100, 10);
    expectFaded(x, input, 441);
  });

  it('clips shorter than twice the fade: each fade covers half the clip', () => {
    const input = new Float32Array(101).fill(0.5);
    const x = input.slice();
    applyFades(x, 48000); // nominal 384 > floor(101/2) = 50
    expect(x[0]).toBe(0);
    expect(x[100]).toBe(0);
    expect(x[50]).toBe(0.5);
    expectFaded(x, input, 50);

    const two = new Float32Array([0.3, -0.3]);
    applyFades(two, 48000);
    expect(Math.abs(two[0]!)).toBe(0);
    expect(Math.abs(two[1]!)).toBe(0);
  });

  it('a 1-sample clip is left unchanged; an empty clip is a no-op', () => {
    const one = new Float32Array([0.7]);
    applyFades(one, 48000);
    expect(one[0]).toBe(new Float32Array([0.7])[0]);
    expect(() => applyFades(new Float32Array(0), 48000)).not.toThrow();
  });

  it('ms = 0 leaves x unchanged', () => {
    const input = new Float32Array(100).fill(0.9);
    const x = input.slice();
    applyFades(x, 48000, 0);
    expect(Array.from(x)).toEqual(Array.from(input));
  });

  it('rejects invalid fs and ms with RangeError', () => {
    const x = new Float32Array(10);
    for (const fs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => applyFades(x, fs)).toThrow(RangeError);
    }
    for (const ms of [-1, Number.NaN]) expect(() => applyFades(x, 48000, ms)).toThrow(RangeError);
  });
});
