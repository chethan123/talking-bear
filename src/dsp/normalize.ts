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
/** Gating block length and step, in seconds (400 ms blocks, 75 % overlap). */
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
