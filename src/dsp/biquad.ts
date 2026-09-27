// Second-order IIR sections (biquads): RBJ Audio-EQ-Cookbook Butterworth high/low-pass, Direct Form II
// Transposed, plus a cascade. Used by the capture high-pass (80 Hz, plan §4.1.2) and the VAD gate band-limit
// (2x HPF 200 Hz + LPF 3.4 kHz at 16 kHz, plan §4.2.1). Pure: no DOM, no globals; Float32Array in and out,
// float64 coefficients and state.

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

/** Second-order Butterworth high-pass (-3.01 dB at fc). Throws RangeError unless 0 < fc < fs/2. */
export function butterworthHighpass(fs: number, fc: number): Biquad {
  checkCutoff(fs, fc);
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * BUTTERWORTH_Q);
  const a0 = 1 + alpha;
  const b0 = (1 + cosw) / 2 / a0;
  return new Section(b0, -(1 + cosw) / a0, b0, (-2 * cosw) / a0, (1 - alpha) / a0);
}

/** Second-order Butterworth low-pass (-3.01 dB at fc). Throws RangeError unless 0 < fc < fs/2. */
export function butterworthLowpass(fs: number, fc: number): Biquad {
  checkCutoff(fs, fc);
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * BUTTERWORTH_Q);
  const a0 = 1 + alpha;
  const b0 = (1 - cosw) / 2 / a0;
  return new Section(b0, (1 - cosw) / a0, b0, (-2 * cosw) / a0, (1 - alpha) / a0);
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
