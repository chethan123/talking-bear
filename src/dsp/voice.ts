// The voice effect chain (plan §4.3.4, §7 M3), run in the DSP worker on each take:
//   clip → clipping flag → HPF 80 Hz → trim → sinc resample (ratio 1/p) → voiced? → loudness gain and
//   true-peak ceiling → 8 ms fades → envelope analysis.
// Each step is an exported stage, collected in `voiceStages`, and processVoice is exactly their composition,
// so lab/bench (X-F3, #69) can time the stages one by one.
// Pure: no DOM, no globals, no timers. processVoice never modifies its input.

import { butterworthHighpass } from './biquad.ts';
import { analyzeEnvelope } from './envelope.ts';
import { applyFades } from './fades.ts';
import { voiceGainDb } from './normalize.ts';
import { resampleOffline } from './resample.ts';
import type { Envelope, VoicePreset, VoiceResult } from './types.ts';
import { createVoicing, VOICED_THRESHOLD } from './voicing.ts';

export type { VoiceResult } from './types.ts';

/** Clipping (plan §4.4): the input is clipped when at least 0.1 % of its samples have |x| > 0.99. */
export const CLIP_LEVEL = 0.99;
export const CLIP_FRACTION = 0.001;
/** High-pass corner in Hz (2nd-order Butterworth). */
export const HPF_HZ = 80;
/**
 * hpfTrim clamps finite samples to ±SAMPLE_LIMIT. Real PCM is within ±1; the bound only keeps finite input near
 * the float32 maximum (±3.4e38) from overflowing to ±Infinity in the high-pass or resampler overshoot.
 */
export const SAMPLE_LIMIT = 1e30;
/** Trim: RMS frame length, the absolute floor and the range below the loudest frame, and the kept margin. */
export const TRIM_FRAME_SEC = 0.01;
export const TRIM_FLOOR_DB = -60;
export const TRIM_RANGE_DB = 50;
export const TRIM_MARGIN_SEC = 0.05;
/** Voicing check: an 8 kHz copy, 256-sample windows every 20 ms, voiced from the third window above threshold. */
export const VOICING_FS = 8000;
export const VOICING_WINDOW = 256;
export const VOICING_HOP = 160;
export const VOICED_MIN_WINDOWS = 3;
/** Raised-cosine fade length in ms at each end. */
export const FADE_MS = 8;

/** Options of processVoice. */
export interface ProcessVoiceOpts {
  /** Test-only: skip the trim (the high-pass still runs). The app never sets it. */
  noTrim?: boolean;
}

/**
 * Stage 1, the clipping flag (plan §4.4, used by M8's "too loud" reaction): true when x is non-empty and
 * count(|x[i]| > 0.99) ≥ 0.001 · x.length. A ±Infinity sample counts as clipped; a NaN sample does not. No
 * float32 value equals 0.99 (Math.fround(0.99) = 0.9900000095… > 0.99), so `>` and `>=` agree on a
 * Float32Array.
 */
export function clipDetect(x: Float32Array): boolean {
  const n = x.length;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(x[i]!) > CLIP_LEVEL) count++;
  }
  return n > 0 && count >= CLIP_FRACTION * n;
}

/**
 * The span [start, end) of x that the trim keeps, at sample rate fs (finite and > 0; hpfTrim validates it):
 * - frames of F = round(0.010·fs) samples start at sample 0 (frame k is x[k·F, min((k+1)·F, n)); the last
 *   one may be shorter) and each gets its RMS level in dB, 10·log10(mean square) (−Infinity when all zero);
 * - thr = max(−60, peak frame dB − 50); the first and last frames at or above thr bound the kept span;
 * - a margin of M = round(0.050·fs) samples is kept on each side, clamped to [0, n]:
 *   start = max(0, first·F − M), end = min(n, (last + 1)·F + M);
 * - when no frame reaches thr (the whole clip is below −60 dB RMS in every frame, or x is empty), nothing is
 *   trimmed: { start: 0, end: n }.
 * The span is never shorter than min(n, M): it holds a passing frame's first sample plus a full margin on at
 * least one side unless it reaches both ends of x. So the trim never cuts a clip to under 50 ms.
 */
export function trimRange(x: Float32Array, fs: number): { start: number; end: number } {
  const n = x.length;
  const frameLen = Math.max(1, Math.round(TRIM_FRAME_SEC * fs));
  const margin = Math.round(TRIM_MARGIN_SEC * fs);
  const frames = Math.ceil(n / frameLen);
  const db = new Float64Array(frames);
  let peak = -Infinity;
  for (let k = 0; k < frames; k++) {
    const s = k * frameLen;
    const e = Math.min(s + frameLen, n);
    let sum = 0;
    for (let i = s; i < e; i++) {
      const v = x[i]!;
      sum += v * v;
    }
    const d = 10 * Math.log10(sum / (e - s));
    db[k] = d;
    if (d > peak) peak = d;
  }
  const thr = Math.max(TRIM_FLOOR_DB, peak - TRIM_RANGE_DB);
  let first = 0;
  while (first < frames && db[first]! < thr) first++;
  if (first === frames) return { start: 0, end: n };
  let last = frames - 1;
  while (db[last]! < thr) last--;
  return {
    start: Math.max(0, first * frameLen - margin),
    end: Math.min(n, (last + 1) * frameLen + margin),
  };
}

/**
 * Stages 2 and 3, high-pass and trim. Copies x into a new buffer, replacing every non-finite sample (NaN,
 * ±Infinity) with 0 and clamping finite samples to ±1e30 (SAMPLE_LIMIT), so every later stage sees finite,
 * bounded samples that cannot overflow float32; high-passes the copy in place with a fresh
 * 80 Hz 2nd-order Butterworth (butterworthHighpass(fs, 80)); then, when `trim` is true, returns the view of it
 * given by trimRange. Never returns x itself. Throws RangeError unless fs is finite and > 160.
 */
export function hpfTrim(x: Float32Array, fs: number, trim = true): Float32Array {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    y[i] = Number.isFinite(v) ? Math.min(SAMPLE_LIMIT, Math.max(-SAMPLE_LIMIT, v)) : 0;
  }
  butterworthHighpass(fs, HPF_HZ).process(y, y);
  if (!trim) return y;
  const { start, end } = trimRange(y, fs);
  return y.subarray(start, end);
}

/**
 * Stage 4, the pitch shift: resampleOffline(x, 1 / pitchRatio), a new buffer of round(n / p) samples that
 * plays at rate 1 (plan §3.3 ratio convention; the same kernel as the VAD decimator). Throws RangeError unless
 * pitchRatio is finite and > 0.
 */
export function resample(x: Float32Array, pitchRatio: number): Float32Array {
  return resampleOffline(x, 1 / pitchRatio);
}

/**
 * Stage 5: whether y (at fs) is voiced. Scores an 8 kHz copy, resampleOffline(y, 8000 / fs), with
 * createVoicing(8000) on 256-sample windows starting every 160 samples (20 ms) at 0, 160, 320, … that lie
 * wholly inside the copy, and returns true as soon as 3 windows score above VOICED_THRESHOLD. A copy shorter
 * than 256 samples has no window and is unvoiced.
 */
export function isVoiced(y: Float32Array, fs: number): boolean {
  const z = resampleOffline(y, VOICING_FS / fs);
  const voicing = createVoicing(VOICING_FS);
  let count = 0;
  for (let s = 0; s + VOICING_WINDOW <= z.length; s += VOICING_HOP) {
    if (voicing.score(z.subarray(s, s + VOICING_WINDOW)) > VOICED_THRESHOLD) {
      count++;
      if (count >= VOICED_MIN_WINDOWS) return true;
    }
  }
  return false;
}

/**
 * Stage 6, loudness and ceiling: g = voiceGainDb(y, fs, voiced) (−20 LUFS target, make-up ≤ +12 dB and only
 * when voiced, true peak ≤ −3 dBTP); multiplies y in place by 10^(g/20) and returns g in dB.
 */
export function applyGain(y: Float32Array, fs: number, voiced: boolean): number {
  const g = voiceGainDb(y, fs, voiced);
  const k = 10 ** (g / 20);
  for (let i = 0; i < y.length; i++) y[i] = y[i]! * k;
  return g;
}

/** Stage 7: 8 ms raised-cosine fade-in and fade-out, in place (applyFades(y, fs, 8)). */
export function fades(y: Float32Array, fs: number): void {
  applyFades(y, fs, FADE_MS);
}

/** Stage 8: the mouth envelope of exactly the buffer that plays (analyzeEnvelope(y, fs, pitchRatio)). */
export function envelope(y: Float32Array, fs: number, pitchRatio: number): Envelope {
  return analyzeEnvelope(y, fs, pitchRatio);
}

/** The stages of processVoice, in order, for benchmarks (#69). */
export const voiceStages = { clipDetect, hpfTrim, resample, isVoiced, applyGain, fades, envelope } as const;

/**
 * The voice effect (plan §4.3.4) on a take `pcm` at sample rate `fs`, exactly the composition of voiceStages:
 *   clipped = clipDetect(pcm); x = hpfTrim(pcm, fs, !opts?.noTrim); y = resample(x, p);
 *   voiced = isVoiced(y, fs); applyGain(y, fs, voiced); fades(y, fs); env = envelope(y, fs, p)
 * with p = preset.pitchRatio. Returns { pcm: y, envelope: env, durationSec: y.length / fs, clipped }: y plays
 * at rate 1, and its envelope is computed from exactly that buffer.
 *
 * Non-finite input samples (NaN, ±Infinity) are replaced by 0 and finite samples are clamped to ±1e30
 * (SAMPLE_LIMIT) before the high-pass (clipDetect still sees the raw input, so ±Infinity counts as clipped).
 * Every stage after clipDetect therefore sees finite, bounded samples, and the output and its envelope are
 * finite for every input.
 * `pcm` is never modified, and y is a new buffer. `opts.noTrim` is test-only.
 *
 * Throws RangeError (from the stages) unless fs is finite and above 2·1681.97 ≈ 3364 Hz (the BS.1770
 * K-weighting in applyGain is the binding bound; hpfTrim alone needs fs > 160) and preset.pitchRatio is finite
 * and > 0.
 */
export function processVoice(
  pcm: Float32Array,
  fs: number,
  preset: VoicePreset,
  opts?: ProcessVoiceOpts,
): VoiceResult {
  const p = preset.pitchRatio;
  const clipped = clipDetect(pcm);
  const x = hpfTrim(pcm, fs, opts?.noTrim !== true);
  const y = resample(x, p);
  const voiced = isVoiced(y, fs);
  applyGain(y, fs, voiced);
  fades(y, fs);
  const env = envelope(y, fs, p);
  return { pcm: y, envelope: env, durationSec: y.length / fs, clipped };
}
