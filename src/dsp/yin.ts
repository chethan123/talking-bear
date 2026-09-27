// YIN fundamental-frequency estimator (de Cheveigné & Kawahara 2002), used offline by tests and e2e specs to
// check the f0 of recorded or replayed audio (plan §4.9.3: "YIN f0(out) ≈ f0(in) · p within ±3 %"). Pure: no
// DOM, no globals, no timers. Not a hot path: it allocates its scratch buffers once per call.

/** Analysis window length and hop, in seconds. */
const WINDOW_SEC = 0.04;
const HOP_SEC = 0.01;
/** Fewer voiced windows than this and the result is NaN. */
const MIN_VOICED = 5;

/**
 * The period, in samples, of the window x[start, start + len + tauMax + 1) by the standard YIN steps, or NaN
 * when it is unvoiced (no lag in [tauMin, tauMax] dips below `threshold`):
 *
 * 1. difference function d(τ) = Σ_{j=0}^{len−1} (x[start+j] − x[start+j+τ])², for τ = 1 … tauMax + 1;
 * 2. cumulative mean normalised difference d'(τ) = d(τ) · τ / Σ_{k=1}^{τ} d(k), with d'(τ) = 1 while that
 *    sum is 0;
 * 3. absolute threshold: the first τ in [tauMin, tauMax] with d'(τ) < threshold, then followed downhill to
 *    the local minimum (at most tauMax);
 * 4. parabolic interpolation of d' through τ − 1, τ, τ + 1.
 */
function windowPeriod(
  x: Float32Array,
  start: number,
  len: number,
  tauMin: number,
  tauMax: number,
  threshold: number,
  d: Float64Array,
): number {
  // 1. Difference function.
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let sum = 0;
    for (let j = start; j < start + len; j++) {
      const diff = x[j]! - x[j + tau]!;
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  // 2. Cumulative mean normalisation, in place (d'(0) = 1 is never read).
  let running = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    running += d[tau]!;
    d[tau] = running > 0 ? (d[tau]! * tau) / running : 1;
  }
  // 3. Absolute threshold, then down to the local minimum.
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d[tau]! >= threshold) continue;
    while (tau + 1 <= tauMax && d[tau + 1]! < d[tau]!) tau++;
    // 4. Parabolic interpolation (tau − 1 ≥ tauMin − 1 ≥ 1 and tau + 1 ≤ tauMax + 1 are both computed).
    const a = d[tau - 1]!;
    const b = d[tau]!;
    const c = d[tau + 1]!;
    const den = a - 2 * b + c;
    return den > 0 ? tau + (a - c) / (2 * den) : tau;
  }
  return Number.NaN;
}

/**
 * The median f0 in Hz of `x` (sample rate `fs`) over 40 ms windows at a 10 ms hop (round(0.04·fs) and
 * round(0.01·fs) samples; windows that don't fit entirely in x are skipped), searching f0 in [fmin, fmax]:
 * lags τ from max(2, floor(fs/fmax)) to ceil(fs/fmin), each window's difference function integrating over
 * its first round(0.04·fs) − ceil(fs/fmin) − 1 samples. A window is voiced when its normalised difference dips
 * below `threshold`. Returns NaN if fewer than 5 windows are voiced (for even counts the median is the mean of
 * the middle two).
 *
 * Throws RangeError unless fs, fmin, fmax and threshold are finite, fs > 0, 0 < fmin < fmax, threshold > 0,
 * and the window is longer than the longest lag plus one sample.
 */
export function yinF0(x: Float32Array, fs: number, fmin = 70, fmax = 800, threshold = 0.15): number {
  if (!(Number.isFinite(fs) && fs > 0)) throw new RangeError(`fs must be finite and > 0 (fs = ${fs})`);
  if (!(Number.isFinite(fmin) && Number.isFinite(fmax) && fmin > 0 && fmin < fmax)) {
    throw new RangeError(`need finite 0 < fmin < fmax (fmin = ${fmin}, fmax = ${fmax})`);
  }
  if (!(Number.isFinite(threshold) && threshold > 0)) {
    throw new RangeError(`threshold must be finite and > 0 (threshold = ${threshold})`);
  }
  const win = Math.round(WINDOW_SEC * fs);
  const hop = Math.round(HOP_SEC * fs);
  const tauMin = Math.max(2, Math.floor(fs / fmax));
  const tauMax = Math.ceil(fs / fmin);
  const len = win - tauMax - 1;
  if (hop < 1 || len < 1 || tauMin >= tauMax) {
    throw new RangeError(
      `fs = ${fs}, fmin = ${fmin}, fmax = ${fmax}: a ${WINDOW_SEC * 1000} ms window must exceed the longest lag ${tauMax} + 1 samples, with max(2, floor(fs/fmax)) < ceil(fs/fmin)`,
    );
  }
  const d = new Float64Array(tauMax + 2);
  const f0s: number[] = [];
  for (let start = 0; start + win <= x.length; start += hop) {
    const period = windowPeriod(x, start, len, tauMin, tauMax, threshold, d);
    if (!Number.isNaN(period)) f0s.push(fs / period);
  }
  if (f0s.length < MIN_VOICED) return Number.NaN;
  const sorted = f0s.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
