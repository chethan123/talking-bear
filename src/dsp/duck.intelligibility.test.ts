// Intelligibility regression floors for the duck stage (duck plan T115 acceptance 8 and 9, plan §4.3.5), on
// the committed espeak-ng sentence renders (synthetic, plan Q2). STOI against the plain sinc pitch-up at the
// same p is a proxy; X-F4 (a listening test) is the intelligibility gate.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stoi } from '../../test/stoi.ts';
import { readWav } from '../../test/wav.ts';
import { DUCK, DUCK_TUNE_BOUNDS, duckStage, type DuckParams } from './duck.ts';
import { resampleOffline } from './resample.ts';
import { DUCK_PITCH_RATIO } from './types.ts';
import { hpfTrim } from './voice.ts';

const CORPUS = fileURLToPath(new URL('../../test/corpus/speech/', import.meta.url));
const FS = 48_000;
const SENTENCES = ['00', '01', '02', '03', '04'].flatMap((k) =>
  ['r0', 'r1'].map((r) => `sentence-${k}-${r}`),
);

/** Each sentence render, upsampled to 48 kHz with the production sinc kernel. */
const inputs = new Map<string, Float32Array>();
function input(id: string): Float32Array {
  let x = inputs.get(id);
  if (!x) {
    const w = readWav(readFileSync(`${CORPUS}${id}.wav`));
    x = resampleOffline(w.channels[0]!, FS / w.sampleRate);
    inputs.set(id, x);
  }
  return x;
}

/** The chain's plain pitch-up at p (hpfTrim without trimming, then sinc 1/p), cached per (id, p). */
const plains = new Map<string, Float32Array>();
function plain(id: string, p: number): Float32Array {
  const key = `${id} ${p}`;
  let y = plains.get(key);
  if (!y) {
    y = resampleOffline(hpfTrim(input(id), FS, false), 1 / p);
    plains.set(key, y);
  }
  return y;
}

/** STOI(plain, duck) over the 10 sentences: mean, min and the worst sentence. */
function score(p: number, d: Readonly<DuckParams>): { mean: number; min: number; worst: string } {
  let sum = 0;
  let min = Infinity;
  let worst = '';
  for (const id of SENTENCES) {
    const ref = plain(id, p);
    const s = stoi(ref, duckStage(ref, FS, d), FS);
    sum += s;
    if (s < min) {
      min = s;
      worst = id;
    }
  }
  return { mean: sum / SENTENCES.length, min, worst };
}

describe('duck stage intelligibility (acceptance 8)', () => {
  it('DUCK at DUCK_PITCH_RATIO: STOI mean ≥ 0.93 and min ≥ 0.88 on the 10 sentence renders', () => {
    const { mean, min, worst } = score(DUCK_PITCH_RATIO, DUCK);
    const msg = `mean ${mean.toFixed(4)} min ${min.toFixed(4)} (${worst})`;
    expect(mean, msg).toBeGreaterThanOrEqual(0.93);
    expect(min, msg).toBeGreaterThanOrEqual(0.88);
  });

  const corners: Array<readonly [number, number, number]> = [];
  for (const p of DUCK_TUNE_BOUNDS.p)
    for (const amHz of DUCK_TUNE_BOUNDS.amHz)
      for (const peak1Db of DUCK_TUNE_BOUNDS.peak1Db) corners.push([p, amHz, peak1Db]);

  it.each(corners)(
    'corner p %d, amHz %d, peak1Db %d at amMix 0.40: mean ≥ 0.92 and min ≥ 0.87',
    (p, amHz, peak1Db) => {
      const amMix = DUCK_TUNE_BOUNDS.amMix[1];
      expect(amMix).toBe(0.4);
      const { mean, min, worst } = score(p, { ...DUCK, amHz, amMix, peak1Db });
      const msg = `mean ${mean.toFixed(4)} min ${min.toFixed(4)} (${worst})`;
      expect(mean, msg).toBeGreaterThanOrEqual(0.92);
      expect(min, msg).toBeGreaterThanOrEqual(0.87);
    },
  );
});

describe('test/stoi.ts port golden (acceptance 9)', () => {
  it('sentence-00-r0, plain = sinc p 1.45: stoi(plain, plain) = 1 ± 1e-6', () => {
    const y = plain('sentence-00-r0', DUCK_PITCH_RATIO);
    expect(Math.abs(stoi(y, y, FS) - 1)).toBeLessThanOrEqual(1e-6);
  });

  it('stoi(plain, plain·(0.5 + 0.5·sin(2π·90·i/fs))) = 0.9391 ± 1e-3', () => {
    const y = plain('sentence-00-r0', DUCK_PITCH_RATIO);
    const z = new Float32Array(y.length);
    for (let i = 0; i < y.length; i++) z[i] = y[i]! * (0.5 + 0.5 * Math.sin((2 * Math.PI * 90 * i) / FS));
    expect(Math.abs(stoi(y, z, FS) - 0.9391)).toBeLessThanOrEqual(1e-3);
  });

  it('is NaN when fewer than 30 non-silent frames remain, and low for the time-reversed signal', () => {
    const short = new Float32Array(4800).fill(0.1);
    expect(stoi(short, short, FS)).toBeNaN();
    const y = plain('sentence-00-r0', DUCK_PITCH_RATIO);
    const reversed = y.toReversed();
    expect(stoi(y, reversed, FS)).toBeLessThan(0.5);
  });
});
