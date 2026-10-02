// Mouth envelope analysis (plan §4.6.2): jaw, width, round and teeth tracks at a 10 ms hop, computed from the
// processed (pitch-shifted) buffer that actually plays. Pure: no DOM, no globals, no timers. Each call
// allocates only its four output tracks and one scratch set (window, frame, FFT and its bins, per-frame dB and
// sibilance, and a sorted copy of the dB track for the percentiles).

import { createRealFft } from './fft.ts';
import type { Envelope } from './types.ts';

/** Hop and window durations (plan §4.6.2). */
const HOP_SEC = 0.01;
const WIN_SEC = 0.025;
/** Minimum FFT size; a larger power of two is used when the window is longer (fs > 81.9 kHz). */
const MIN_FFT = 2048;
/** Level normalisation: floor = P20 + 6 dB, ceiling = P95. */
const FLOOR_PCT = 0.2;
const FLOOR_OFFSET_DB = 6;
const CEIL_PCT = 0.95;
const MIN_RANGE_DB = 1e-6;
/** dB value of a frame whose mean square is ≤ 1e-20 (including exact digital silence). */
const SILENT_DB = -200;
const MIN_MEAN_SQUARE = 1e-20;
/** One-pole smoothing time constants and the jaw exponent. */
const ATTACK_SEC = 0.015;
const RELEASE_SEC = 0.07;
const JAW_EXPONENT = 0.7;
/** The mouth is forced shut after this much time of consecutive n = 0 frames. */
const CLOSE_SEC = 0.12;
/**
 * Band edges in Hz at pitch ratio 1; by default they scale with p (the top band's upper edge is 0.95·fs/2 either
 * way). `scaleBandsWithP: false` keeps them at p = 1 (lab/envelope, X-A3).
 */
const LO_BAND: readonly [number, number] = [150, 900];
const HI_BAND: readonly [number, number] = [1500, 4500];
const TOP_LOW_HZ = 5000;
const TOP_HIGH_FRACTION = 0.95;
const BAND_EPS = 1e-12;
/** Teeth: sibilance share above 0.4 at a level below 0.5, scaled to full at 0.8. */
const SIB_THRESHOLD = 0.4;
const SIB_SPAN = 0.4;
const TEETH_MAX_LEVEL = 0.5;
/** Tolerance for mapping band edges to bin indices (absorbs floating-point error in edge·nfft/fs). */
const BIN_EPS = 1e-9;
/** Tolerance when converting CLOSE_SEC to a whole number of hops (0.12 / 0.01 must give 12, not 13). */
const FRAME_EPS = 1e-9;

/** Linear-interpolation percentile (numpy's default) of an ascending-sorted array of length ≥ 1. */
function percentileSorted(sorted: Float64Array, q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const frac = pos - lo;
  return sorted[lo]! + frac * (sorted[hi]! - sorted[lo]!);
}

/** Inclusive bin range [first, last] of the closed band [loHz, hiHz]; first > last means the band is empty. */
function bandBins(loHz: number, hiHz: number, fs: number, nfft: number): [number, number] {
  const first = Math.max(0, Math.ceil((loHz * nfft) / fs - BIN_EPS));
  const last = Math.min(nfft >> 1, Math.floor((hiHz * nfft) / fs + BIN_EPS));
  return [first, last];
}

/** Σ (re² + im²) over bins first…last inclusive (0 when first > last). */
function bandEnergy(re: Float32Array, im: Float32Array, first: number, last: number): number {
  let e = 0;
  for (let k = first; k <= last; k++) {
    const r = re[k]!;
    const i = im[k]!;
    e += r * r + i * i;
  }
  return e;
}

/** Options of analyzeEnvelope. */
export interface EnvelopeOpts {
  /**
   * Whether the band edges scale with the pitch ratio (plan §4.6.2): E_lo 150–900 Hz × p, E_hi 1.5–4.5 kHz × p,
   * the top band from 5 kHz × p. Default true, the app's behaviour. false uses the fixed edges of p = 1, so the
   * tracks equal analyzeEnvelope(x, fs, 1); lab/envelope (X-A3) compares the two. pitchRatio is validated either
   * way.
   */
  readonly scaleBandsWithP?: boolean;
}

/**
 * Mouth-shape tracks of `x` (sample rate `fs`, pitch ratio `pitchRatio`) at a hop of H = round(0.010·fs)
 * samples: one frame per hop, ceil(x.length / H) frames, frame i a Hann window of round(0.025·fs) samples
 * centred on sample i·H with zero padding outside x. Silence gives all-zero tracks.
 *
 * Frame i is centred at i·H/fs seconds, which is exactly i·10 ms (the `hopMs: 10` consumers index by) only
 * when 0.01·fs is an integer, as at 44.1 and 48 kHz; at other rates (22.05 kHz: H = 221) the true hop
 * differs slightly from 10 ms.
 *
 * Precondition: `x` must contain only finite samples (processVoice guarantees this upstream); non-finite samples
 * give NaN tracks.
 *
 * `opts.scaleBandsWithP` (default true) chooses band edges that scale with p or the fixed edges of p = 1.
 *
 * Throws RangeError when fs is not finite or gives a hop below one sample (fs below 50), or when pitchRatio is
 * not a positive finite number.
 */
export function analyzeEnvelope(
  x: Float32Array,
  fs: number,
  pitchRatio: number,
  opts: EnvelopeOpts = {},
): Envelope {
  const hop = Math.round(HOP_SEC * fs);
  if (!(Number.isFinite(fs) && hop >= 1)) {
    throw new RangeError(`fs must be finite and give a hop of at least one sample (fs = ${fs})`);
  }
  if (!(Number.isFinite(pitchRatio) && pitchRatio > 0)) {
    throw new RangeError(`pitchRatio must be a positive finite number (pitchRatio = ${pitchRatio})`);
  }
  const len = x.length;
  const frames = Math.ceil(len / hop);
  const jaw = new Float32Array(frames);
  const width = new Float32Array(frames);
  const round = new Float32Array(frames);
  const teeth = new Float32Array(frames);
  if (frames === 0) return { hopMs: 10, jaw, width, round, teeth };

  // Scratch set, allocated once per call.
  const win = Math.round(WIN_SEC * fs);
  const half = win >> 1;
  let nfft = MIN_FFT;
  while (nfft < win) nfft <<= 1;
  const fft = createRealFft(nfft);
  const frame = new Float32Array(nfft);
  const re = new Float32Array((nfft >> 1) + 1);
  const im = new Float32Array((nfft >> 1) + 1);
  const hann = new Float64Array(win);
  const db = new Float64Array(frames);
  const sib = new Float64Array(frames);
  const sorted = new Float64Array(frames);

  // Hann window centred on the hop: w(d) = 0.5 + 0.5·cos(2π·d/W), d = k − floor(W/2).
  let windowPower = 0;
  for (let k = 0; k < win; k++) {
    const w = 0.5 + 0.5 * Math.cos((2 * Math.PI * (k - half)) / win);
    hann[k] = w;
    windowPower += w * w;
  }

  // The band edges' pitch factor: p by default, 1 for the fixed edges (opts.scaleBandsWithP false).
  const p = (opts.scaleBandsWithP ?? true) ? pitchRatio : 1;
  const [loFirst, loLast] = bandBins(LO_BAND[0] * p, LO_BAND[1] * p, fs, nfft);
  const [hiFirst, hiLast] = bandBins(HI_BAND[0] * p, HI_BAND[1] * p, fs, nfft);
  const topLowHz = TOP_LOW_HZ * p;
  const topHighHz = (TOP_HIGH_FRACTION * fs) / 2;
  const [topFirst, topLast] = topLowHz >= topHighHz ? [1, 0] : bandBins(topLowHz, topHighHz, fs, nfft);

  // Pass 1: per-frame level (dB) and spectral shape (width, and sib for teeth).
  for (let i = 0; i < frames; i++) {
    // Window samples start…start+W−1; those outside x are zero padding. frame[W…nfft−1] stays zero.
    const start = i * hop - half;
    const kFrom = Math.max(0, -start);
    const kTo = Math.min(win, len - start);
    frame.fill(0, 0, kFrom);
    frame.fill(0, kTo, win);
    let sumSq = 0;
    for (let k = kFrom; k < kTo; k++) {
      const v = hann[k]! * x[start + k]!;
      frame[k] = v;
      sumSq += v * v;
    }
    const meanSquare = sumSq / windowPower;
    db[i] = meanSquare > MIN_MEAN_SQUARE ? 10 * Math.log10(meanSquare) : SILENT_DB;
    // An all-zero frame has an all-zero spectrum: width = sib = 0 (the arrays start at 0), so skip the FFT.
    if (sumSq === 0) continue;
    fft.forward(frame, re, im);
    const eLo = bandEnergy(re, im, loFirst, loLast);
    const eHi = bandEnergy(re, im, hiFirst, hiLast);
    const eTop = bandEnergy(re, im, topFirst, topLast);
    width[i] = eHi / (eLo + eHi + BAND_EPS);
    sib[i] = eTop / (eLo + eHi + eTop + BAND_EPS);
  }

  // Normalisation: floor = P20 + 6 dB, ceiling = P95 (linear-interpolated percentiles).
  sorted.set(db);
  sorted.sort();
  const floorDb = percentileSorted(sorted, FLOOR_PCT) + FLOOR_OFFSET_DB;
  const ceilDb = percentileSorted(sorted, CEIL_PCT);
  const range = Math.max(ceilDb - floorDb, MIN_RANGE_DB);

  // Pass 2: normalise, smooth, shape the jaw, close the mouth, and derive round and teeth.
  const hopSec = hop / fs;
  const attack = 1 - Math.exp(-hopSec / ATTACK_SEC);
  const release = 1 - Math.exp(-hopSec / RELEASE_SEC);
  const closeFrames = Math.ceil(CLOSE_SEC / hopSec - FRAME_EPS);
  let smooth = 0;
  let zeroRun = 0;
  for (let i = 0; i < frames; i++) {
    const n = Math.min(1, Math.max(0, (db[i]! - floorDb) / range));
    smooth += (n > smooth ? attack : release) * (n - smooth);
    zeroRun = n === 0 ? zeroRun + 1 : 0;
    const j = zeroRun >= closeFrames ? 0 : smooth ** JAW_EXPONENT;
    jaw[i] = j;
    round[i] = j * (1 - width[i]!);
    const s = sib[i]!;
    teeth[i] = s > SIB_THRESHOLD && n < TEETH_MAX_LEVEL ? Math.min(1, (s - SIB_THRESHOLD) / SIB_SPAN) : 0;
  }
  return { hopMs: 10, jaw, width, round, teeth };
}
