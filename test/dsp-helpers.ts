// Shared test helpers for the pure DSP modules in src/dsp (T08 onwards).
// Test-only code: not imported by the app, the worklet or the worker.

function checkRange(x: Float32Array, from: number, to: number, minLength: number): void {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to > x.length ||
    to - from < minLength
  ) {
    throw new RangeError(
      `invalid range [${from}, ${to}) for length ${x.length} (need integers, 0 <= from, to <= length, at least ${minLength} samples)`,
    );
  }
}

/** A sine of `seconds` duration (`Math.round(seconds * fs)` samples): amp · sin(2π·freq·n/fs + phase). */
export function sine(freq: number, fs: number, seconds: number, amp = 0.5, phase = 0): Float32Array {
  const n = Math.round(seconds * fs);
  const x = new Float32Array(n);
  const w = (2 * Math.PI * freq) / fs;
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(w * i + phase);
  return x;
}

/** RMS level of x[from, to) in dBFS: 20·log10(RMS + 1e-20). */
export function rmsDb(x: Float32Array, from = 0, to = x.length): number {
  checkRange(x, from, to, 1);
  let sum = 0;
  for (let i = from; i < to; i++) {
    const v = x[i]!;
    sum += v * v;
  }
  return 20 * Math.log10(Math.sqrt(sum / (to - from)) + 1e-20);
}

/**
 * Amplitude in dBFS of the component at `freq` in x[from, to): Hann-windowed (periodic) projection onto
 * e^{-j2π·freq·t}, scaled so a full-scale sine at `freq` reads 0 dB. Phase is referenced to `from`.
 */
export function toneLevelDb(x: Float32Array, freq: number, fs: number, from = 0, to = x.length): number {
  checkRange(x, from, to, 2);
  const n = to - from;
  const w = (2 * Math.PI * freq) / fs;
  let re = 0;
  let im = 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const v = win * x[from + i]!;
    re += v * Math.cos(w * i);
    im -= v * Math.sin(w * i);
    wsum += win;
  }
  const amp = (2 * Math.hypot(re, im)) / wsum;
  return 20 * Math.log10(amp + 1e-20);
}

/** Seeded 32-bit PRNG (mulberry32). Returns a generator of uniform values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
