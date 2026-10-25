// The duck stage of the Duckling voice (plan §4.3.5, duck plan §3.1.2): it runs on the plain sinc pitch-up and
// before the loudness normaliser. In order: a 70 Hz amplitude modulation (the rasp), a nasal EQ (high-pass,
// a dip, two resonant peaks, four cascaded low-pass sections) and a peak-normalised cubic shaper. Pure: no DOM,
// no globals, no timers; Float32Array in and out. It allocates its output buffer (one per take, not a hot path)
// and the eight filter sections.

import { butterworthHighpass, butterworthLowpass, peaking } from './biquad.ts';

/** The duck stage's parameters (plan §4.3.5, Chosen chain). Frequencies in Hz, gains in dB. */
export interface DuckParams {
  /** AM rate. */
  amHz: number;
  /** AM depth m: the gain is 1 − m + m·sin(2π·amHz·i/fs). 0 = no AM. */
  amMix: number;
  /** Butterworth high-pass cutoff. */
  hpHz: number;
  /** The nasal dip: an RBJ peaking section (usually a cut). */
  dipHz: number;
  dipQ: number;
  dipDb: number;
  /** First resonant peak. */
  peak1Hz: number;
  peak1Q: number;
  peak1Db: number;
  /** Second resonant peak. */
  peak2Hz: number;
  peak2Q: number;
  peak2Db: number;
  /** Cutoff of each of the LP_SECTIONS cascaded Butterworth low-pass sections. */
  lpHz: number;
  /** Cubic shaper mix: 0 = no cubic, 1 = full. */
  shapeMix: number;
}

/** The frozen duck stage (plan §4.3.5). T119 may retune it within DUCK_TUNE_BOUNDS. */
export const DUCK: Readonly<DuckParams> = Object.freeze({
  amHz: 70,
  amMix: 0.35,
  hpHz: 320,
  dipHz: 700,
  dipQ: 1.4,
  dipDb: -9,
  peak1Hz: 1600,
  peak1Q: 3,
  peak1Db: 10,
  peak2Hz: 3100,
  peak2Q: 2.5,
  peak2Db: 6,
  lpHz: 5000,
  shapeMix: 1,
});

/**
 * The number of cascaded RBJ Butterworth low-pass sections at lpHz (each Q √½: −12 dB at lpHz, 48 dB/octave
 * above it; not an 8th-order Butterworth).
 */
export const LP_SECTIONS = 4;

/**
 * X-F4 fallback 1, "duckSoft" (plan §4.3.5, Fallback): amMix = max(0.05, d.amMix − 0.15),
 * peak1Db = max(2, d.peak1Db − 4), the rest of d. Returns a new frozen object.
 */
export function softenDuck(d: Readonly<DuckParams>): Readonly<DuckParams> {
  return Object.freeze({ ...d, amMix: Math.max(0.05, d.amMix - 0.15), peak1Db: Math.max(2, d.peak1Db - 4) });
}

/** Pre-tune bounds (T117 sliders; the T115 tests cover the corners): p 1.30–1.60, amHz 60–80, amMix 0.20–0.40, peak1Db 6–12. */
export const DUCK_TUNE_BOUNDS: Readonly<
  Record<'p' | 'amHz' | 'amMix' | 'peak1Db', readonly [number, number]>
> = Object.freeze({
  p: Object.freeze([1.3, 1.6] as const),
  amHz: Object.freeze([60, 80] as const),
  amMix: Object.freeze([0.2, 0.4] as const),
  peak1Db: Object.freeze([6, 12] as const),
});

/** The lowest sample rate the stage accepts: its 3.1 kHz peak and 5 kHz low-pass need fs/2 above them. */
const MIN_FS = 16000;

/**
 * The duck stage on y (at fs): returns a new buffer of y's length and never modifies y.
 *
 * 1. AM: z[i] = y[i]·(1 − amMix + amMix·sin(2π·amHz·i/fs)), i from 0 at the first sample.
 * 2. Nasal EQ in place: butterworthHighpass(fs, hpHz); peaking(fs, dipHz, dipDb, dipQ);
 *    peaking(fs, peak1Hz, peak1Db, peak1Q); peaking(fs, peak2Hz, peak2Db, peak2Q); butterworthLowpass(fs, lpHz)
 *    LP_SECTIONS times.
 * 3. Cubic shaper: with peak = max|z| (all-zero z is returned as it is), u = z[i]/peak,
 *    c = 1.5·peak·(u − u³/3), z[i] = clamp((1 − shapeMix)·z[i] + shapeMix·c, −peak, peak). So |output| ≤ peak.
 *
 * The output is finite for finite input up to ±1e30 (voice.ts SAMPLE_LIMIT, the bound hpfTrim gives the chain).
 *
 * Throws RangeError unless fs is finite and ≥ 16000, or (from biquad.ts) if a filter frequency is not in
 * (0, fs/2), a Q is not > 0 or a gain is not finite.
 */
export function duckStage(y: Float32Array, fs: number, d: Readonly<DuckParams> = DUCK): Float32Array {
  if (!(Number.isFinite(fs) && fs >= MIN_FS)) {
    throw new RangeError(`fs must be finite and >= ${MIN_FS} (fs = ${fs})`);
  }
  // Build every section first, so invalid parameters throw before any work.
  const sections = [
    butterworthHighpass(fs, d.hpHz),
    peaking(fs, d.dipHz, d.dipDb, d.dipQ),
    peaking(fs, d.peak1Hz, d.peak1Db, d.peak1Q),
    peaking(fs, d.peak2Hz, d.peak2Db, d.peak2Q),
  ];
  for (let k = 0; k < LP_SECTIONS; k++) sections.push(butterworthLowpass(fs, d.lpHz));

  const z = new Float32Array(y.length);
  const w = (2 * Math.PI * d.amHz) / fs;
  const dc = 1 - d.amMix;
  const mix = d.amMix;
  for (let i = 0; i < y.length; i++) z[i] = y[i]! * (dc + mix * Math.sin(w * i));

  for (let k = 0; k < sections.length; k++) sections[k]!.process(z, z);

  let peak = 0;
  for (let i = 0; i < z.length; i++) {
    const a = Math.abs(z[i]!);
    if (a > peak) peak = a;
  }
  if (peak === 0) return z;
  const shape = d.shapeMix;
  const dry = 1 - shape;
  for (let i = 0; i < z.length; i++) {
    const v = z[i]!;
    const u = v / peak;
    const c = 1.5 * peak * (u - (u * u * u) / 3);
    const o = dry * v + shape * c;
    z[i] = o > peak ? peak : o < -peak ? -peak : o;
  }
  return z;
}
