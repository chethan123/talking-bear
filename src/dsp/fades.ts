// Raised-cosine fade-in and fade-out applied in place to the processed voice clip (plan §4.3.4: 8 ms fades on
// the exact buffer that plays). Pure: no DOM, no globals, no allocation.

/**
 * Applies, in place, a raised-cosine fade-in over the first L = round(ms·fs/1000) samples and a mirrored
 * fade-out over the last L: x[i] and x[n−1−i] are multiplied by 0.5 − 0.5·cos(π·i/L) for 0 ≤ i < L, so the
 * first and last samples become 0 and sample L is where the curve reaches 1. For clips shorter than 2·L,
 * each fade covers half the clip (L = floor(n/2)); for odd n the centre sample keeps gain 1, and a 1-sample
 * clip is left unchanged. Throws RangeError unless fs is finite and > 0 and ms is finite and ≥ 0.
 */
export function applyFades(x: Float32Array, fs: number, ms = 8): void {
  if (!(Number.isFinite(fs) && fs > 0)) throw new RangeError(`fs must be finite and > 0 (fs = ${fs})`);
  if (!(Number.isFinite(ms) && ms >= 0)) throw new RangeError(`ms must be finite and ≥ 0 (ms = ${ms})`);
  const n = x.length;
  const len = Math.min(Math.round((ms * fs) / 1000), Math.floor(n / 2));
  for (let i = 0; i < len; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / len);
    x[i] = x[i]! * g;
    const j = n - 1 - i;
    x[j] = x[j]! * g;
  }
}
