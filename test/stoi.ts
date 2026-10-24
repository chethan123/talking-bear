// Test-only intelligibility proxy for the duck stage (duck plan T115, plan §4.3.5): STOI (Taal, Hendriks,
// Heusdens, Jensen 2011), simplified exactly as in the planning spike that set the duck thresholds:
// 10 kHz (production sinc resampler), 256-sample Hann frames, hop 128, 512-point FFT, 15 one-third-octave
// bands from 150 Hz, 30-frame (384 ms) segments, clipping at β = −15 dB. Deviation from the reference
// implementation: silent frames (clean frame energy ≤ max − 40 dB) are dropped in the STFT domain instead of
// being removed and overlap-added in the time domain. Not imported by the app, the worklet or the worker.

import { createRealFft } from '../src/dsp/fft.ts';
import { resampleOffline } from '../src/dsp/resample.ts';

const STOI_FS = 10000;
const FRAME = 256;
const HOP = 128;
const NFFT = 512;
const BANDS = 15;
const BAND_MIN_HZ = 150;
const SEGMENT = 30;
const SILENCE_RANGE_DB = 40;
const BETA_DB = -15;

/** [lo, hi) FFT-bin range of each one-third-octave band. */
function bandEdges(): Array<readonly [number, number]> {
  const bands: Array<readonly [number, number]> = [];
  for (let j = 0; j < BANDS; j++) {
    const cf = BAND_MIN_HZ * 2 ** (j / 3);
    const lo = Math.round((cf * 2 ** (-1 / 6) * NFFT) / STOI_FS);
    const hi = Math.round((cf * 2 ** (1 / 6) * NFFT) / STOI_FS);
    bands.push([lo, Math.min(hi, NFFT / 2)]);
  }
  return bands;
}

/** Pearson correlation of a and b (the 1e-12 keeps a constant vector at 0 instead of NaN). */
function corr(a: Float64Array, b: Float64Array): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return sab / (Math.sqrt(saa * sbb) + 1e-12);
}

/**
 * Simplified STOI of `proc` against the clean reference `clean`, both at fs and time-aligned: 1 = identical
 * envelopes, lower = less intelligible. Compares the first min(length) samples (after resampling to 10 kHz).
 * Returns NaN when fewer than 30 non-silent frames remain.
 */
export function stoi(clean: Float32Array, proc: Float32Array, fs: number): number {
  const x = resampleOffline(clean, STOI_FS / fs);
  const y = resampleOffline(proc, STOI_FS / fs);
  const n = Math.min(x.length, y.length);
  const fft = createRealFft(NFFT);
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (FRAME + 1));
  const bands = bandEdges();

  const starts: number[] = [];
  const energies: number[] = [];
  for (let s = 0; s + FRAME <= n; s += HOP) {
    let e = 0;
    for (let i = 0; i < FRAME; i++) e += (x[s + i]! * win[i]!) ** 2;
    energies.push(10 * Math.log10(e + 1e-20));
    starts.push(s);
  }
  let maxE = -Infinity;
  for (const e of energies) if (e > maxE) maxE = e;
  const keep = starts.filter((_, k) => energies[k]! > maxE - SILENCE_RANGE_DB);

  const buf = new Float32Array(NFFT);
  const re = new Float32Array(NFFT / 2 + 1);
  const im = new Float32Array(NFFT / 2 + 1);
  const pow = new Float64Array(NFFT / 2 + 1);
  /** Band magnitudes (√ of the band's power) of the frame of sig at start into out. */
  const bandsOf = (sig: Float32Array, start: number, out: Float64Array): void => {
    buf.fill(0);
    for (let i = 0; i < FRAME; i++) buf[i] = sig[start + i]! * win[i]!;
    fft.forward(buf, re, im);
    for (let k = 0; k <= NFFT / 2; k++) pow[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    for (let j = 0; j < BANDS; j++) {
      const [lo, hi] = bands[j]!;
      let s = 0;
      for (let k = lo; k < hi; k++) s += pow[k]!;
      out[j] = Math.sqrt(s);
    }
  };
  const X: Float64Array[] = [];
  const Y: Float64Array[] = [];
  for (const s of keep) {
    const bx = new Float64Array(BANDS);
    const by = new Float64Array(BANDS);
    bandsOf(x, s, bx);
    bandsOf(y, s, by);
    X.push(bx);
    Y.push(by);
  }

  const clip = 1 + 10 ** (BETA_DB / 20);
  const xs = new Float64Array(SEGMENT);
  const ys = new Float64Array(SEGMENT);
  let total = 0;
  let count = 0;
  for (let m = SEGMENT; m <= X.length; m++) {
    for (let j = 0; j < BANDS; j++) {
      for (let t = 0; t < SEGMENT; t++) {
        xs[t] = X[m - SEGMENT + t]![j]!;
        ys[t] = Y[m - SEGMENT + t]![j]!;
      }
      const nx = Math.hypot(...xs);
      const ny = Math.hypot(...ys) + 1e-12;
      for (let t = 0; t < SEGMENT; t++) ys[t] = Math.min((ys[t]! * nx) / ny, clip * xs[t]!);
      total += corr(xs, ys);
      count++;
    }
  }
  return count === 0 ? Number.NaN : total / count;
}
