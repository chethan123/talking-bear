import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mulberry32, sine } from '../../test/dsp-helpers.ts';
import { readWav } from '../../test/wav.ts';
import { yinF0 } from './yin.ts';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);

function fixture(name: string): { x: Float32Array; fs: number } {
  const wav = readWav(new Uint8Array(readFileSync(new URL(`${name}.wav`, FIXTURES))));
  const [x] = wav.channels;
  if (x === undefined) throw new Error(`${name}.wav has no channels`);
  return { x, fs: wav.sampleRate };
}

/** Relative error of `f` against `ref` (NaN stays NaN, so a NaN estimate fails every bound). */
function relErr(f: number, ref: number): number {
  return Math.abs(f / ref - 1);
}

function whiteNoise(seed: number, n: number, amp: number): Float32Array {
  const rng = mulberry32(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * (2 * rng() - 1);
  return x;
}

/** 1 s of a 224 Hz sine (amplitude 0.5, power 0.125) plus seeded uniform white noise at the given SNR. */
function noisySine(snr: number, seed: number): Float32Array {
  const a = Math.sqrt((3 * 0.125) / snr); // uniform noise on [−a, a] has power a²/3
  const rng = mulberry32(seed);
  return Float32Array.from(sine(224, 48000, 1), (v) => v + a * (2 * rng() - 1));
}

describe('yinF0', () => {
  it.each([100, 224, 480])('estimates a %d Hz sine at fs 48 000 within ±1 percent', (f) => {
    const est = yinF0(sine(f, 48000, 1), 48000);
    expect(relErr(est, f), `yinF0 = ${est} Hz`).toBeLessThanOrEqual(0.01);
  });

  it('resolves a non-integer period by parabolic interpolation: 480 Hz at fs 8000 (16.67 samples) within ±0.5 %', () => {
    // Without interpolation the period rounds to 17 samples: 470.6 Hz, −2 %.
    const est = yinF0(sine(480, 8000, 1), 8000);
    expect(relErr(est, 480), `yinF0 = ${est} Hz`).toBeLessThanOrEqual(0.005);
  });

  it.each([
    ['vowel_f0-140', 140],
    ['vowel_f0-300', 300],
  ] as const)('estimates the synthetic vowel %s within ±3 percent', (name, f0) => {
    const { x, fs } = fixture(name);
    expect(fs).toBe(48000);
    const est = yinF0(x, fs);
    expect(relErr(est, f0), `yinF0 = ${est} Hz`).toBeLessThanOrEqual(0.03);
  });

  it('returns NaN for white noise', () => {
    expect(yinF0(whiteNoise(0x5eed, 48000, 0.5), 48000)).toBeNaN();
    const { x, fs } = fixture('noise_white_-60dbfs_3s');
    expect(yinF0(x, fs)).toBeNaN();
  });

  it('returns NaN for silence and for input shorter than one window', () => {
    const { x, fs } = fixture('silence_2s');
    expect(yinF0(x, fs)).toBeNaN();
    expect(yinF0(new Float32Array(0), 48000)).toBeNaN();
    expect(yinF0(sine(224, 48000, 0.039), 48000)).toBeNaN();
  });

  it('needs at least 5 voiced windows (40 ms windows at a 10 ms hop)', () => {
    // 80 ms at 48 kHz = 3840 samples: windows start at 0, 480, …, 1920, so 5 windows. 70 ms gives 4.
    expect(relErr(yinF0(sine(224, 48000, 0.08), 48000), 224)).toBeLessThanOrEqual(0.01);
    expect(yinF0(sine(224, 48000, 0.07), 48000)).toBeNaN();
  });

  it('reports the median of the voiced windows: 0.5 s at 200 Hz then 0.2 s at 400 Hz gives 200 Hz within ±1 %', () => {
    // 45 windows at 200 Hz, about 16 at 400 Hz and a few straddling both: the mean would be about 257 Hz.
    const x = new Float32Array(33600);
    x.set(sine(200, 48000, 0.5));
    x.set(sine(400, 48000, 0.2), 24000);
    const est = yinF0(x, 48000);
    expect(relErr(est, 200), `yinF0 = ${est} Hz`).toBeLessThanOrEqual(0.01);
  });

  it('searches up to fmax = 800 Hz by default: a 700 Hz sine gives 700 Hz within ±1 %', () => {
    const est = yinF0(sine(700, 48000, 0.5), 48000);
    expect(relErr(est, 700), `yinF0 = ${est} Hz`).toBeLessThanOrEqual(0.01);
  });

  it('searches only lags within [fmin, fmax]', () => {
    expect(yinF0(sine(60, 48000, 0.5), 48000)).toBeNaN(); // below the default fmin of 70 Hz
    expect(relErr(yinF0(sine(60, 48000, 0.5), 48000, 50), 60)).toBeLessThanOrEqual(0.01);
    expect(relErr(yinF0(sine(900, 48000, 0.5), 48000, 70, 1000), 900)).toBeLessThanOrEqual(0.01);
  });

  it('uses threshold 0.15 by default: a 224 Hz sine in white noise is voiced at SNR 7 (d′ ≈ 0.125), not at SNR 4.7 (d′ ≈ 0.175)', () => {
    // YIN's d′ at the period of a sine in white noise is about 1 / (1 + SNR).
    const snr7 = noisySine(7, 1);
    const snr47 = noisySine(4.7, 2);
    expect(yinF0(snr7, 48000)).not.toBeNaN();
    expect(yinF0(snr7, 48000, 70, 800, 0.1)).toBeNaN();
    expect(yinF0(snr47, 48000)).toBeNaN();
    expect(yinF0(snr47, 48000, 70, 800, 0.2)).not.toBeNaN();
  });

  it('never reports an f0 outside [fmin, fmax]', () => {
    for (const f of [850, 900, 1000, 65]) {
      const est = yinF0(sine(f, 48000, 0.5), 48000);
      if (!Number.isNaN(est)) {
        expect(est, `${f} Hz → ${est} Hz`).toBeGreaterThanOrEqual(70);
        expect(est, `${f} Hz → ${est} Hz`).toBeLessThanOrEqual(800);
      }
    }
  });

  it('throws RangeError on invalid parameters', () => {
    const x = sine(224, 48000, 0.2);
    expect(() => yinF0(x, 0)).toThrow(RangeError);
    expect(() => yinF0(x, Number.NaN)).toThrow(RangeError);
    expect(() => yinF0(x, 48000, 800, 70)).toThrow(RangeError);
    expect(() => yinF0(x, 48000, 0, 800)).toThrow(RangeError);
    expect(() => yinF0(x, 48000, 70, 800, 0)).toThrow(RangeError);
    expect(() => yinF0(x, 48000, 70, 800, 1.01)).toThrow(RangeError); // silence has d′ = 1
    expect(() => yinF0(x, 48000, 20, 800)).toThrow(RangeError); // a 50 ms lag doesn't fit a 40 ms window
  });
});
