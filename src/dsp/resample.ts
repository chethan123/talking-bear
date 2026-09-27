// Kaiser-windowed polyphase sinc resampler. One kernel serves both the streaming 48k/44.1k → 16 kHz VAD
// decimator in the capture worklet and the offline voice pitch shift in the DSP worker (plan §3.3, §4.1.3,
// §4.3.4). Pure: no DOM, no globals; Float32Array in and out, float64 accumulation.
//
// Ratio convention (plan §3.3): ratio = outRate / inRate, i.e. output samples per input sample.
// Kernel, with t in input samples, cutoff c as a fraction of the INPUT Nyquist and H = zc / c:
//   h(t) = c · sinc(c·t) · w(t / H),   w(u) = I0(β·√(1 − u²)) / I0(β) for |u| < 1, else 0.
// Output sample j sits at input position exactly j / ratio: y[j] = Σ_i x[i] · h(i − j / ratio), with x = 0
// outside the signal.

/** Polyphase table resolution: phases per input sample. h between two phases is linearly interpolated. */
export const PHASES = 1024;
/** Default number of sinc zero-crossings per side. */
export const DEFAULT_ZERO_CROSSINGS = 8;
/** Default Kaiser β. β = 7 lets a 9 kHz tone through the 48k → 16k decimator above −60 dBFS (issue #21). */
export const DEFAULT_BETA = 6;
/** Default anti-alias cutoff, as a fraction of the input Nyquist, is CUTOFF_FACTOR · min(1, ratio). */
export const CUTOFF_FACTOR = 0.9;

/** Terms of the I0 power series (k = 0 … 29). */
const BESSEL_TERMS = 30;
/** Bound on the module-level table cache (FIFO eviction); live resamplers keep their own table. */
const MAX_CACHED_TABLES = 16;

export interface ResampleOpts {
  zeroCrossings?: number;
  beta?: number;
  /** Anti-alias cutoff as a fraction of the input Nyquist, in (0, 1]. Default CUTOFF_FACTOR · min(1, ratio). */
  cutoff?: number;
}

export interface Resampler {
  /** outRate / inRate. */
  readonly ratio: number;
  /**
   * Lookahead: an output sample is emitted once input up to ceil(its position + H) has arrived. Equals
   * Math.ceil(H). (Precisely, output j is emitted as soon as input index floor(j / ratio) + ceil(H) has
   * arrived, which is never later.) Frame tags follow the timing contract: output j sits at input j / ratio.
   */
  readonly groupDelayInputFrames: number;
  /**
   * Writes every output sample that is now computable into out; returns how many. Must not allocate.
   * out.length must be ≥ Math.ceil(input.length * ratio) + 2, else RangeError.
   */
  processInto(input: Float32Array, out: Float32Array): number;
  /** Allocating convenience wrapper around processInto. */
  process(input: Float32Array): Float32Array;
  /**
   * Emits the remaining outputs, treating future input as zeros, so the total output count is
   * Math.round(totalIn * ratio). Ends the stream: process/processInto then throw until reset(), and a second
   * flush() returns an empty array.
   */
  flush(): Float32Array;
  /** Back to the freshly constructed state; output indices count from here again. */
  reset(): void;
}

interface KernelTable {
  /** L = ceil(H), taps per side. */
  readonly half: number;
  /** 2L taps per phase row. */
  readonly taps: number;
  /** (PHASES + 1) rows of `taps`: coeffs[p·taps + m] = h(m − L + 1 − p / PHASES). */
  readonly coeffs: Float32Array;
}

interface KernelParams {
  readonly c: number;
  readonly zc: number;
  readonly beta: number;
}

const tableCache = new Map<string, KernelTable>();

/** Zeroth-order modified Bessel function of the first kind, power series Σ_k ((x/2)^k / k!)², k = 0 … 29. */
function besselI0(x: number): number {
  const q = (x / 2) * (x / 2);
  let term = 1;
  let sum = 1;
  for (let k = 1; k < BESSEL_TERMS; k++) {
    term *= q / (k * k);
    sum += term;
  }
  return sum;
}

/** h(t) = c · sinc(c·t) · w(t / H). */
function kernelAt(t: number, c: number, halfWidth: number, beta: number, i0Beta: number): number {
  const u = t / halfWidth;
  if (!(Math.abs(u) < 1)) return 0;
  const w = besselI0(beta * Math.sqrt(1 - u * u)) / i0Beta;
  const a = c * t;
  const sinc = a === 0 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a);
  return c * sinc * w;
}

function buildTable(p: KernelParams): KernelTable {
  const halfWidth = p.zc / p.c;
  const half = Math.ceil(halfWidth);
  const taps = 2 * half;
  const i0Beta = besselI0(p.beta);
  const coeffs = new Float32Array((PHASES + 1) * taps);
  // Row PHASES (frac = 1) equals row 0 shifted by one tap, so phase interpolation is continuous at integers.
  for (let ph = 0; ph <= PHASES; ph++) {
    const frac = ph / PHASES;
    const row = ph * taps;
    for (let m = 0; m < taps; m++)
      coeffs[row + m] = kernelAt(m - half + 1 - frac, p.c, halfWidth, p.beta, i0Beta);
  }
  return { half, taps, coeffs };
}

function getTable(p: KernelParams): KernelTable {
  const key = `${p.c}|${p.zc}|${p.beta}`;
  const hit = tableCache.get(key);
  if (hit !== undefined) return hit;
  const table = buildTable(p);
  tableCache.set(key, table);
  if (tableCache.size > MAX_CACHED_TABLES) {
    const oldest = tableCache.keys().next().value;
    if (oldest !== undefined) tableCache.delete(oldest);
  }
  return table;
}

function checkRatio(ratio: number): void {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new RangeError(`ratio must be finite and > 0 (got ${ratio})`);
  }
}

/** Resolves and validates the kernel parameters for a ratio; throws RangeError on bad options. */
function resolveKernel(ratio: number, opts: ResampleOpts | undefined): KernelParams {
  const zc = opts?.zeroCrossings ?? DEFAULT_ZERO_CROSSINGS;
  const beta = opts?.beta ?? DEFAULT_BETA;
  const c = opts?.cutoff ?? CUTOFF_FACTOR * Math.min(1, ratio);
  if (!Number.isInteger(zc) || zc < 1) {
    throw new RangeError(`zeroCrossings must be an integer >= 1 (got ${zc})`);
  }
  if (!Number.isFinite(beta) || beta < 0) {
    throw new RangeError(`beta must be finite and >= 0 (got ${beta})`);
  }
  if (!Number.isFinite(c) || c <= 0 || c > 1) {
    throw new RangeError(`cutoff must be in (0, 1] (got ${c})`);
  }
  return { c, zc, beta };
}

/**
 * Σ_m h(m − L + 1 − frac) · x[start + m] over the table's taps, with h linearly interpolated between the two
 * neighbouring phases. frac must be in [0, 1). Hot path: no allocation.
 */
function kernelDot(coeffs: Float32Array, taps: number, x: Float32Array, start: number, frac: number): number {
  const pf = frac * PHASES;
  const p = Math.floor(pf);
  const a = pf - p;
  const i0 = p * taps;
  const i1 = i0 + taps;
  let s0 = 0;
  let s1 = 0;
  for (let m = 0; m < taps; m++) {
    const v = x[start + m]!;
    s0 += coeffs[i0 + m]! * v;
    s1 += coeffs[i1 + m]! * v;
  }
  return s0 + a * (s1 - s0);
}

/**
 * One-shot resample of x by `ratio` (outRate / inRate). Output length is Math.round(x.length * ratio) and
 * y[j] = Σ_i x[i] · h(i − j / ratio), with x zero outside [0, n). Equals the streaming result (all chunks +
 * flush) of a resampler with the same ratio and options.
 */
export function resampleOffline(x: Float32Array, ratio: number, opts?: ResampleOpts): Float32Array {
  checkRatio(ratio);
  const { half, taps, coeffs } = getTable(resolveKernel(ratio, opts));
  const n = x.length;
  const outLength = Math.round(n * ratio);
  const y = new Float32Array(outLength);
  // xp[q] = x[q − (L − 1)], zero-padded on both sides, so xp[k + m] = x[k − L + 1 + m].
  const xp = new Float32Array(n + 2 * half + 2);
  xp.set(x, half - 1);
  for (let j = 0; j < outLength; j++) {
    const pos = j / ratio; // computed directly, never accumulated
    const k = Math.floor(pos);
    y[j] = kernelDot(coeffs, taps, xp, k, pos - k);
  }
  return y;
}

/** Zeros appended per step by flush(). */
const FLUSH_BLOCK = 1024;

/**
 * Streaming resampler over a preallocated history buffer. buf[q] holds absolute input index bufStart + q;
 * indices below 0 are the zeros before the stream, and flush() appends zeros after it. Output j reads inputs
 * floor(j / ratio) − L + 1 … floor(j / ratio) + L, exactly like resampleOffline, so the two agree bit for bit.
 */
class StreamingResampler implements Resampler {
  readonly ratio: number;
  readonly groupDelayInputFrames: number;
  private readonly coeffs: Float32Array;
  private readonly taps: number;
  private readonly half: number;
  private readonly buf: Float32Array;
  /** Absolute input index of buf[0]. */
  private bufStart = 0;
  /** Absolute end (exclusive) of the buffered samples: real input plus flush zeros. */
  private filled = 0;
  /** Real input samples since construction or reset(). */
  private nIn = 0;
  /** Output samples emitted since construction or reset(). */
  private nOut = 0;
  private flushed = false;

  constructor(ratio: number, table: KernelTable) {
    this.ratio = ratio;
    this.coeffs = table.coeffs;
    this.taps = table.taps;
    this.half = table.half;
    this.groupDelayInputFrames = table.half;
    // After emitting, the span still needed is at most max(2L − 1, L + 0.5 / ratio + 1) samples, so a
    // compaction always frees at least FLUSH_BLOCK slots.
    this.buf = new Float32Array(2 * table.half + Math.ceil(0.5 / ratio) + 4 + FLUSH_BLOCK);
    this.reset();
  }

  processInto(input: Float32Array, out: Float32Array): number {
    if (this.flushed) throw new Error('flush() ended the stream; call reset()');
    const len = input.length;
    if (out.length < Math.ceil(len * this.ratio) + 2) {
      throw new RangeError(`out.length must be >= Math.ceil(input.length * ratio) + 2 (got ${out.length})`);
    }
    const buf = this.buf;
    const cap = buf.length;
    let written = 0;
    let off = 0;
    while (off < len) {
      if (this.filled - this.bufStart === cap) this.compact();
      const base = this.filled - this.bufStart;
      const n = Math.min(cap - base, len - off);
      for (let i = 0; i < n; i++) buf[base + i] = input[off + i]!;
      off += n;
      this.filled += n;
      this.nIn += n;
      written = this.emit(out, written, Math.round(this.nIn * this.ratio));
    }
    return written;
  }

  process(input: Float32Array): Float32Array {
    const out = new Float32Array(Math.ceil(input.length * this.ratio) + 2);
    const n = this.processInto(input, out);
    return out.slice(0, n);
  }

  flush(): Float32Array {
    if (this.flushed) return new Float32Array(0);
    const total = Math.round(this.nIn * this.ratio);
    const out = new Float32Array(total - this.nOut);
    const buf = this.buf;
    const cap = buf.length;
    let written = 0;
    while (this.nOut < total) {
      if (this.filled - this.bufStart === cap) this.compact();
      const base = this.filled - this.bufStart;
      const n = Math.min(cap - base, FLUSH_BLOCK);
      buf.fill(0, base, base + n); // slots past `filled` may hold stale samples after compact()
      this.filled += n;
      written = this.emit(out, written, total);
    }
    this.flushed = true;
    return out;
  }

  reset(): void {
    this.buf.fill(0);
    this.bufStart = 1 - this.half; // the first L − 1 slots stand for the zeros before input 0
    this.filled = 0;
    this.nIn = 0;
    this.nOut = 0;
    this.flushed = false;
  }

  /** Emits outputs nOut … limit − 1 while every input their kernel reads has arrived. No allocation. */
  private emit(out: Float32Array, written: number, limit: number): number {
    const ratio = this.ratio;
    const half = this.half;
    const filled = this.filled;
    let w = written;
    let j = this.nOut;
    while (j < limit) {
      const pos = j / ratio; // computed directly, never accumulated
      const k = Math.floor(pos);
      if (k + half >= filled) break; // the last tap, input k + L, has not arrived yet
      if (w >= out.length) throw new RangeError('out is too short for the computable outputs');
      out[w++] = kernelDot(this.coeffs, this.taps, this.buf, k - half + 1 - this.bufStart, pos - k);
      j++;
    }
    this.nOut = j;
    return w;
  }

  /** Drops history older than the first input that output nOut reads. No allocation. */
  private compact(): void {
    const oldest = Math.floor(this.nOut / this.ratio) - this.half + 1;
    const keepFrom = Math.min(oldest, this.filled);
    this.buf.copyWithin(0, keepFrom - this.bufStart, this.filled - this.bufStart);
    this.bufStart = keepFrom;
  }
}

/**
 * Streaming resampler from inRate to outRate (ratio = outRate / inRate). The history buffer is preallocated
 * here; processInto never allocates. Throws RangeError on non-finite or non-positive rates or bad options.
 */
export function createResampler(inRate: number, outRate: number, opts?: ResampleOpts): Resampler {
  if (!Number.isFinite(inRate) || inRate <= 0 || !Number.isFinite(outRate) || outRate <= 0) {
    throw new RangeError(`rates must be finite and > 0 (got ${inRate} -> ${outRate})`);
  }
  const ratio = outRate / inRate;
  checkRatio(ratio);
  return new StreamingResampler(ratio, getTable(resolveKernel(ratio, opts)));
}
