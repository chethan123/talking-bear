import { DUCK } from '../../src/dsp/duck.ts';
import { createRealFft } from '../../src/dsp/fft.ts';

// The duck voice's e2e marker (duck plan §3.1.2, T126 acceptance 4(d)): the AM line, the `DUCK.amHz` (70 Hz)
// component of the replay's amplitude envelope. YIN can't check the duck's pitch (the AM and the 320 Hz high-pass
// break the periodicity it looks for), so the Fenn loop asserts this line instead; a plain voice has none.
//
// The measure (the planning spike's `amcheck.mjs`, ported): |x| in blocks of round(rate / 1000) samples, the block
// means taken as a 1 kHz envelope; its mean subtracted; a Hann window over its first min(n, 4096) values, zero-padded
// to 4096; the power spectrum. The line is 10·log10 of the peak bin within amHz ± 1 Hz over the median bin within
// amHz ± 30 Hz, excluding amHz ± 3 Hz. Measured in the spike on 3 vowel fixtures at 44.1 and 48 kHz: duck 33.2–46.4
// dB, plain sinc −0.9 to 3.9 dB.

/** The envelope's rate (Hz) and FFT size: 1000 / 4096 ≈ 0.244 Hz per bin. */
export const AM_ENVELOPE_HZ = 1000;
export const AM_FFT_SIZE = 4096;
/** The duck replay's AM line is at least this (T126 acceptance 4(d)). */
export const AM_LINE_DUCK_MIN_DB = 20;
/** A plain (Juni) replay's AM line is at most this. */
export const AM_LINE_PLAIN_MAX_DB = 10;

/** The AM line of `samples` (the output tap's, at `rate` Hz) at `amHz`, in dB over its neighbourhood's median. */
export function amLineDb(samples: ArrayLike<number>, rate: number, amHz: number = DUCK.amHz): number {
  const block = Math.round(rate / AM_ENVELOPE_HZ);
  const n = Math.floor(samples.length / block);
  if (n < 2)
    throw new RangeError(`amLineDb: ${samples.length} samples at ${rate} Hz is under two envelope blocks`);
  const env = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < block; j++) sum += Math.abs(samples[i * block + j]!);
    env[i] = sum / block;
    mean += env[i]!;
  }
  mean /= n;
  const w = Math.min(n, AM_FFT_SIZE);
  const x = new Float32Array(AM_FFT_SIZE);
  for (let i = 0; i < w; i++) x[i] = (env[i]! - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / w));
  const bins = AM_FFT_SIZE / 2 + 1;
  const re = new Float32Array(bins);
  const im = new Float32Array(bins);
  createRealFft(AM_FFT_SIZE).forward(x, re, im);
  let peak = 0;
  const ref: number[] = [];
  for (let k = 0; k < bins; k++) {
    const hz = (k * AM_ENVELOPE_HZ) / AM_FFT_SIZE;
    const p = re[k]! * re[k]! + im[k]! * im[k]!;
    const d = Math.abs(hz - amHz);
    if (d <= 1) peak = Math.max(peak, p);
    if (d <= 30 && d > 3) ref.push(p);
  }
  ref.sort((a, b) => a - b);
  return 10 * Math.log10(peak / ref[ref.length >> 1]!);
}
