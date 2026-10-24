// Second-order IIR sections (biquads): RBJ Audio-EQ-Cookbook Butterworth high/low-pass, Direct Form II
// Transposed, plus a cascade. Used by the capture high-pass (80 Hz, plan §4.1.2) and the VAD gate band-limit
// (2x HPF 200 Hz + LPF 3.4 kHz at 16 kHz, plan §4.2.1). Pure: no DOM, no globals; Float32Array in and out,
// float64 coefficients and state.
// Also the ITU-R BS.1770 K-weighting forms (as in libebur128), plan §4.3.4: highShelf (pre-filter shelf)
// and highpassQ (RLB high-pass), and the RBJ peaking EQ of the duck stage (plan §4.3.5), each with its
// coefficient function.

/** Q of a second-order Butterworth section. */
const BUTTERWORTH_Q = Math.SQRT1_2;

export interface Biquad {
  /** Filters x into out (allocates out when omitted). out may be x itself (in place). out.length must equal x.length. */
  process(x: Float32Array, out?: Float32Array): Float32Array;
  reset(): void;
}

function checkLengths(x: Float32Array, out: Float32Array): void {
  if (out.length !== x.length) {
    throw new RangeError(`out.length (${out.length}) must equal x.length (${x.length})`);
  }
}

/** One biquad in Direct Form II Transposed; coefficients are normalised by a0. */
class Section implements Biquad {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private s1 = 0;
  private s2 = 0;

  constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
  }

  process(x: Float32Array, out?: Float32Array): Float32Array {
    const y = out ?? new Float32Array(x.length);
    checkLengths(x, y);
    const b0 = this.b0;
    const b1 = this.b1;
    const b2 = this.b2;
    const a1 = this.a1;
    const a2 = this.a2;
    let s1 = this.s1;
    let s2 = this.s2;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i]!; // read before y[i] is written, so out === x is safe
      const yi = b0 * xi + s1;
      s1 = b1 * xi - a1 * yi + s2;
      s2 = b2 * xi - a2 * yi;
      y[i] = yi;
    }
    this.s1 = s1;
    this.s2 = s2;
    return y;
  }

  reset(): void {
    this.s1 = 0;
    this.s2 = 0;
  }
}

function checkCutoff(fs: number, fc: number): void {
  if (!Number.isFinite(fs) || !(fc > 0 && fc < fs / 2)) {
    throw new RangeError(`cutoff must satisfy 0 < fc < fs/2 (fs = ${fs}, fc = ${fc})`);
  }
}

/**
 * Coefficients of the second-order Butterworth high-pass (RBJ cookbook, Q = √½; −3.01 dB at fc).
 * Throws RangeError unless 0 < fc < fs/2.
 */
export function butterworthHighpassCoefficients(fs: number, fc: number): BiquadCoefficients {
  checkCutoff(fs, fc);
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * BUTTERWORTH_Q);
  const a0 = 1 + alpha;
  const b0 = (1 + cosw) / 2 / a0;
  return { b0, b1: -(1 + cosw) / a0, b2: b0, a1: (-2 * cosw) / a0, a2: (1 - alpha) / a0 };
}

/**
 * Coefficients of the second-order Butterworth low-pass (RBJ cookbook, Q = √½; −3.01 dB at fc).
 * Throws RangeError unless 0 < fc < fs/2.
 */
export function butterworthLowpassCoefficients(fs: number, fc: number): BiquadCoefficients {
  checkCutoff(fs, fc);
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * BUTTERWORTH_Q);
  const a0 = 1 + alpha;
  const b0 = (1 - cosw) / 2 / a0;
  return { b0, b1: (1 - cosw) / a0, b2: b0, a1: (-2 * cosw) / a0, a2: (1 - alpha) / a0 };
}

function section(c: BiquadCoefficients): Biquad {
  return new Section(c.b0, c.b1, c.b2, c.a1, c.a2);
}

/** Second-order Butterworth high-pass (-3.01 dB at fc). Throws RangeError unless 0 < fc < fs/2. */
export function butterworthHighpass(fs: number, fc: number): Biquad {
  return section(butterworthHighpassCoefficients(fs, fc));
}

/** Second-order Butterworth low-pass (-3.01 dB at fc). Throws RangeError unless 0 < fc < fs/2. */
export function butterworthLowpass(fs: number, fc: number): Biquad {
  return section(butterworthLowpassCoefficients(fs, fc));
}

/** Runs stages in order; process() calls each stage in place on `out`. */
export function cascade(...stages: Biquad[]): Biquad {
  return {
    process(x: Float32Array, out?: Float32Array): Float32Array {
      const y = out ?? new Float32Array(x.length);
      checkLengths(x, y);
      if (y !== x) y.set(x);
      for (let k = 0; k < stages.length; k++) stages[k]!.process(y, y);
      return y;
    },
    reset(): void {
      for (let k = 0; k < stages.length; k++) stages[k]!.reset();
    },
  };
}

/** Normalised biquad coefficients (a0 = 1): H(z) = (b0 + b1·z^-1 + b2·z^-2) / (1 + a1·z^-1 + a2·z^-2). */
export interface BiquadCoefficients {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/** libebur128 / ITU-R BS.1770 shelf: Vb = Vh^SHELF_VB_EXPONENT (not the RBJ cookbook shelf). */
const SHELF_VB_EXPONENT = 0.4996667741545416;

function checkQ(q: number): void {
  if (!(Number.isFinite(q) && q > 0)) {
    throw new RangeError(`q must be finite and > 0 (q = ${q})`);
  }
}

/**
 * High-shelf coefficients in libebur128's BS.1770 form (bilinear transform, K = tan(π·f0/fs),
 * Vh = 10^(gainDb/20), Vb = Vh^0.4996667741545416). The DC gain is exactly 1 (0 dB) and the Nyquist gain
 * exactly Vh (gainDb). Throws RangeError unless 0 < f0 < fs/2, q > 0 and gainDb is finite.
 */
export function highShelfCoefficients(fs: number, f0: number, gainDb: number, q: number): BiquadCoefficients {
  checkCutoff(fs, f0);
  checkQ(q);
  if (!Number.isFinite(gainDb)) throw new RangeError(`gainDb must be finite (gainDb = ${gainDb})`);
  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (gainDb / 20);
  const Vb = Vh ** SHELF_VB_EXPONENT;
  const a0 = 1 + K / q + K * K;
  return {
    b0: (Vh + (Vb * K) / q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / q + K * K) / a0,
  };
}

/**
 * Second-order high-pass coefficients in the BS.1770 RLB form (as in libebur128 and BS.1770-4 Table 2):
 * bilinear transform with K = tan(π·f0/fs); the numerator is [1, −2, 1] and is not divided by a0, so DC is
 * blocked and the Nyquist gain is 1 + K/q + K² (+0.043 dB for the RLB stage at 48 kHz).
 * Throws RangeError unless 0 < f0 < fs/2 and q > 0.
 */
export function highpassQCoefficients(fs: number, f0: number, q: number): BiquadCoefficients {
  checkCutoff(fs, f0);
  checkQ(q);
  const K = Math.tan((Math.PI * f0) / fs);
  const a0 = 1 + K / q + K * K;
  return { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / q + K * K) / a0 };
}

/** High shelf in libebur128's BS.1770 form; see highShelfCoefficients. */
export function highShelf(fs: number, f0: number, gainDb: number, q: number): Biquad {
  return section(highShelfCoefficients(fs, f0, gainDb, q));
}

/** Second-order high-pass in the BS.1770 RLB form; see highpassQCoefficients. */
export function highpassQ(fs: number, f0: number, q: number): Biquad {
  return section(highpassQCoefficients(fs, f0, q));
}

/**
 * Peaking-EQ coefficients from the RBJ Audio-EQ-Cookbook (duck plan §3.1.2): A = 10^(gainDb/40),
 * w0 = 2π·f0/fs, α = sin(w0)/(2q); b = [1 + α·A, −2·cos w0, 1 − α·A], a = [1 + α/A, −2·cos w0, 1 − α/A],
 * normalised by a0. The gain at f0 is exactly gainDb, and DC and Nyquist are 0 dB. Arguments in
 * highShelfCoefficients' order. Throws RangeError unless 0 < f0 < fs/2, q > 0 and gainDb is finite.
 */
export function peakingCoefficients(fs: number, f0: number, gainDb: number, q: number): BiquadCoefficients {
  checkCutoff(fs, f0);
  checkQ(q);
  if (!Number.isFinite(gainDb)) throw new RangeError(`gainDb must be finite (gainDb = ${gainDb})`);
  const w0 = (2 * Math.PI * f0) / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const A = 10 ** (gainDb / 40);
  const a0 = 1 + alpha / A;
  const b1 = (-2 * cosw) / a0;
  return { b0: (1 + alpha * A) / a0, b1, b2: (1 - alpha * A) / a0, a1: b1, a2: (1 - alpha / A) / a0 };
}

/** RBJ peaking EQ (gainDb at f0, Q q); see peakingCoefficients. */
export function peaking(fs: number, f0: number, gainDb: number, q: number): Biquad {
  return section(peakingCoefficients(fs, f0, gainDb, q));
}
