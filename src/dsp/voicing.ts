// Voicing score (plan §4.2.1 step 5): the peak normalised autocorrelation of a band-limited window over the
// lags of an F0 in [fminHz, fmaxHz]. The DSP worker calls it at every 10 ms hop on the most recent 512
// gate-filtered samples (32 ms at 16 kHz, `createGateFilter` output): the energy backend counts hops scoring
// above VOICED_THRESHOLD for its "≥ 60 ms voiced per utterance" rule, and the feature traces log the score.
//
// Pure: no DOM, no globals, no timers. The lag range is fixed at construction and score() does not allocate.

/** A window is voiced when its score is above this. */
export const VOICED_THRESHOLD = 0.5;

/** Default F0 search range of `createVoicing` (Hz). Exported so that src/vad-trace/config.ts can be checked
 *  against it. */
export const VOICING_FMIN_HZ = 70;
export const VOICING_FMAX_HZ = 600;

/** A window whose energy Σ x[n]² is below this scores 0. */
const MIN_WINDOW_ENERGY = 1e-10;
/** Regulariser inside the square root of the normalisation. */
const NORM_EPS = 1e-12;

export interface Voicing {
  /**
   * The voicing score of win, in [0, 1]. With N = win.length (512 on the 16 kHz gate path) and lags τ from
   * floor(fs / fmaxHz) to ceil(fs / fminHz) (26 … 229 by default):
   *
   *   r(τ) = Σ_{n=0}^{N−τ−1} x[n]·x[n+τ] / sqrt(Σ_{n=0}^{N−τ−1} x[n]² · Σ_{n=0}^{N−τ−1} x[n+τ]² + 1e-12)
   *
   * and the score is max_τ r(τ) clamped to [0, 1]. Lags ≥ N have no terms and are skipped. The score is 0 when
   * the window energy Σ_{n=0}^{N−1} x[n]² is below 1e-10, or is not finite (a NaN or ±Infinity sample).
   * Does not allocate.
   */
  score(win: Float32Array): number;
}

/**
 * A voicing scorer for windows at sample rate fs, searching F0 in [fminHz, fmaxHz]. Throws RangeError unless
 * fs is finite and positive and 0 < fminHz < fmaxHz <= fs / 2.
 */
export function createVoicing(fs = 16000, fminHz = VOICING_FMIN_HZ, fmaxHz = VOICING_FMAX_HZ): Voicing {
  if (!(Number.isFinite(fs) && fs > 0 && fminHz > 0 && fmaxHz > fminHz && fmaxHz <= fs / 2)) {
    throw new RangeError(
      `invalid voicing parameters: fs ${fs}, fminHz ${fminHz}, fmaxHz ${fmaxHz} (need 0 < fminHz < fmaxHz <= fs / 2)`,
    );
  }
  // fmaxHz <= fs / 2 makes minLag >= 2.
  const minLag = Math.floor(fs / fmaxHz);
  const maxLag = Math.ceil(fs / fminHz);

  return {
    score(win: Float32Array): number {
      const n = win.length;
      let energy = 0;
      for (let i = 0; i < n; i++) {
        const v = win[i]!;
        energy += v * v;
      }
      // `!(energy >= …)` also catches NaN; a ±Infinity sample makes the energy +Infinity.
      if (!(energy >= MIN_WINDOW_ENERGY) || energy === Number.POSITIVE_INFINITY) return 0;
      const hi = Math.min(maxLag, n - 1);
      if (hi < minLag) return 0;

      // The two energy sums of r(τ), for τ = hi: head = Σ_{n=0}^{N−τ−1} x[n]², tail = Σ_{n=τ}^{N−1} x[n]²
      // (= Σ_{n=0}^{N−τ−1} x[n+τ]²). Walking τ down by one, head gains x[N−τ−1] and tail gains x[τ] (at the new
      // τ), so both stay sums of non-negative terms over exactly the formula's index ranges.
      let head = 0;
      for (let i = 0; i < n - hi; i++) {
        const v = win[i]!;
        head += v * v;
      }
      let tail = 0;
      for (let i = hi; i < n; i++) {
        const v = win[i]!;
        tail += v * v;
      }

      // Starting at 0 clamps the maximum from below.
      let best = 0;
      for (let lag = hi; lag >= minLag; lag--) {
        if (lag < hi) {
          const a = win[n - lag - 1]!;
          head += a * a;
          const b = win[lag]!;
          tail += b * b;
        }
        const m = n - lag;
        let num = 0;
        for (let i = 0; i < m; i++) num += win[i]! * win[i + lag]!;
        const r = num / Math.sqrt(head * tail + NORM_EPS);
        if (r > best) best = r;
      }
      return best > 1 ? 1 : best;
    },
  };
}
