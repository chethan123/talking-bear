// Loudness safety for the voice chain (plan §4.3.4): ITU-R BS.1770 K-weighting and integrated loudness
// (400 ms blocks, 75 % overlap, absolute and relative gating), the plan's short-clip rule for clips shorter
// than one block, and the gain rule. Pure: no DOM, no globals; Float32Array in, numbers out.

import {
  cascade,
  highpassQ,
  highpassQCoefficients,
  highShelf,
  highShelfCoefficients,
  type Biquad,
  type BiquadCoefficients,
} from './biquad.ts';

export interface LoudnessOpts {
  targetLufs: number;
  maxMakeupDb: number;
  ceilingDbtp: number;
}

export const LOUDNESS: LoudnessOpts = { targetLufs: -20, maxMakeupDb: 12, ceilingDbtp: -3 };

// BS.1770 analog prototypes of the K-weighting stages, as in libebur128.
const SHELF_F0 = 1681.974450955533;
const SHELF_GAIN_DB = 3.999843853973347;
const SHELF_Q = 0.7071752369554196;
const RLB_F0 = 38.13547087602444;
const RLB_Q = 0.5003270373238773;

/** Block loudness offset: l = −0.691 + 10·log10(mean square of the K-weighted block). */
const LOUDNESS_OFFSET = -0.691;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
/** Gating block length in seconds (400 ms); blocks start every quarter block (75 % overlap). */
const BLOCK_SECONDS = 0.4;

/**
 * The two K-weighting stages at fs: [pre-filter high shelf, RLB high-pass], both by the bilinear transform
 * with K = tan(π·f0/fs) (libebur128's forms). Throws RangeError when fs ≤ 2·1681.97 Hz or is not finite.
 */
export function kWeightingCoefficients(fs: number): readonly [BiquadCoefficients, BiquadCoefficients] {
  return [
    highShelfCoefficients(fs, SHELF_F0, SHELF_GAIN_DB, SHELF_Q),
    highpassQCoefficients(fs, RLB_F0, RLB_Q),
  ];
}

/** K-weighting filter at fs: cascade(pre-filter shelf, RLB high-pass); see kWeightingCoefficients. */
export function kWeighting(fs: number): Biquad {
  return cascade(highShelf(fs, SHELF_F0, SHELF_GAIN_DB, SHELF_Q), highpassQ(fs, RLB_F0, RLB_Q));
}

function blockLoudness(meanSquare: number): number {
  return LOUDNESS_OFFSET + 10 * Math.log10(meanSquare);
}

/**
 * Integrated loudness of x in LUFS (ITU-R BS.1770). x is K-weighted first.
 * - x.length ≥ 0.4·fs: 400 ms blocks (B = floor(0.4·fs) samples) every H = round(B/4) samples; absolute gate
 *   at −70 LUFS, then a relative gate 10 LU below the mean of the blocks that passed it; returns the
 *   loudness of the mean square of the blocks that pass both (strict > comparisons, as in BS.1770-4).
 * - x.length < 0.4·fs (short-clip rule, plan §4.3.4): the ungated loudness of the whole K-weighted clip,
 *   without zero-padding.
 * Returns -Infinity for silence (including an empty clip, or no block above −70 LUFS). Throws RangeError for
 * an invalid fs (see kWeighting).
 */
export function integratedLoudness(x: Float32Array, fs: number): number {
  const k = kWeighting(fs);
  const n = x.length;
  if (n === 0) return -Infinity;
  const y = k.process(x);

  if (n < BLOCK_SECONDS * fs) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += y[i]! * y[i]!;
    const ms = sum / n;
    return ms > 0 ? blockLoudness(ms) : -Infinity;
  }

  const blockLen = Math.floor(BLOCK_SECONDS * fs);
  const hop = Math.max(1, Math.round(blockLen / 4));
  const count = Math.floor((n - blockLen) / hop) + 1;
  const z = new Float64Array(count);
  for (let j = 0; j < count; j++) {
    const start = j * hop;
    let sum = 0;
    for (let i = start; i < start + blockLen; i++) sum += y[i]! * y[i]!;
    z[j] = sum / blockLen;
  }

  // Gates compared in the mean-square domain: l_j > Γ ⟺ z_j > 10^((Γ − offset)/10).
  const zAbs = 10 ** ((ABSOLUTE_GATE_LUFS - LOUDNESS_OFFSET) / 10);
  let sumAbs = 0;
  let countAbs = 0;
  for (let j = 0; j < count; j++) {
    if (z[j]! > zAbs) {
      sumAbs += z[j]!;
      countAbs++;
    }
  }
  if (countAbs === 0) return -Infinity;
  const gammaR = blockLoudness(sumAbs / countAbs) + RELATIVE_GATE_LU;
  const zRel = 10 ** ((gammaR - LOUDNESS_OFFSET) / 10);
  let sumRel = 0;
  let countRel = 0;
  for (let j = 0; j < count; j++) {
    const v = z[j]!;
    if (v > zAbs && v > zRel) {
      sumRel += v;
      countRel++;
    }
  }
  return blockLoudness(sumRel / countRel);
}

// True-peak interpolation filter: ITU-R BS.1770-4, Annex 2, the table of polyphase FIR interpolating filter
// coefficients (4× oversampling, 48 taps as 4 phases × 12 taps), copied value for value (Prettier drops the
// printed trailing zeros). Every value is an exact multiple of 2^-13, and the table matches the independent
// transcription in vsariola/sointu tracker/detector.go. Phase-major: TRUE_PEAK_FIR[p·12 + k] is tap k of
// phase p.
const TP_TAPS = 12;
const TRUE_PEAK_FIR = new Float64Array([
  // Phase 0
  0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625,
  0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125,
  // Phase 1
  -0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625, 0.77978515625,
  -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375,
  // Phase 2
  -0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625,
  0.465087890625, -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875,
  // Phase 3
  -0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875,
  0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375,
]);

/**
 * True peak of x in dBTP (ITU-R BS.1770-4 Annex 2): 4× oversampling with the 48-tap interpolation FIR, run
 * as 4 polyphase branches of 12 taps, y_p[m] = Σ_k h_p[k]·x[m−k]; returns 20·log10(max |y| over all phases).
 * The whole zero-extended convolution is scanned (m = 0 … n + 10), including the filter's drain after the
 * last sample, because the clip plays followed by silence. Returns -Infinity for silent or empty input.
 * Does not allocate.
 */
export function truePeakDbtp(x: Float32Array): number {
  const n = x.length;
  const f = TRUE_PEAK_FIR;
  let peak = 0;
  for (let m = 0; m < n + TP_TAPS - 1; m++) {
    const kLo = m >= n ? m - n + 1 : 0;
    const kHi = m < TP_TAPS - 1 ? m : TP_TAPS - 1;
    let y0 = 0;
    let y1 = 0;
    let y2 = 0;
    let y3 = 0;
    for (let k = kLo; k <= kHi; k++) {
      const v = x[m - k]!;
      y0 += f[k]! * v;
      y1 += f[TP_TAPS + k]! * v;
      y2 += f[2 * TP_TAPS + k]! * v;
      y3 += f[3 * TP_TAPS + k]! * v;
    }
    const a = Math.max(Math.abs(y0), Math.abs(y1), Math.abs(y2), Math.abs(y3));
    if (a > peak) peak = a;
  }
  return 20 * Math.log10(peak);
}

/**
 * Gain in dB to apply to a processed voice clip (plan §4.3.4):
 * - loudGain = voiced ? min(target − L, maxMakeupDb) : min(0, target − L), with L = integratedLoudness(x, fs),
 *   and loudGain = 0 when L is -Infinity (silence);
 * - ceilGain = ceilingDbtp − truePeakDbtp(x) (+Infinity for silence);
 * - returns min(loudGain, ceilGain): loud input is only ever attenuated, unvoiced input is never amplified,
 *   the make-up gain is capped, and the result is finite for finite input.
 */
export function voiceGainDb(
  x: Float32Array,
  fs: number,
  voiced: boolean,
  o: LoudnessOpts = LOUDNESS,
): number {
  const l = integratedLoudness(x, fs);
  let loudGain = 0;
  if (l !== -Infinity) {
    loudGain = voiced ? Math.min(o.targetLufs - l, o.maxMakeupDb) : Math.min(0, o.targetLufs - l);
  }
  const ceilGain = o.ceilingDbtp - truePeakDbtp(x);
  return Math.min(loudGain, ceilGain);
}
