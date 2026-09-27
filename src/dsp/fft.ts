// Real FFT: an n/2-point complex radix-2 FFT (iterative, decimation in time) of the even/odd-packed input,
// plus the standard real-split step. Used for the mouth envelope's spectral shape tracks (2048-point,
// plan §4.6.2) and the lab's HF-energy page. Pure: no DOM, no globals. Twiddles, the bit-reversal table
// and the float64 work arrays are precomputed in createRealFft, so forward() does not allocate.

const MIN_SIZE = 4;
const MAX_SIZE = 65536;

export interface RealFft {
  /**
   * Real DFT of x (length n) into re/im bins 0…n/2 (both of length ≥ n/2 + 1; entries beyond n/2 are left
   * untouched): X[k] = Σ_t x[t]·e^(−2πi·k·t/n), unnormalised; im[0] = im[n/2] = 0. Does not allocate.
   * Throws RangeError on a length mismatch.
   */
  forward(x: Float32Array, re: Float32Array, im: Float32Array): void;
}

/**
 * Creates a real FFT of size n: an integer power of two with 4 ≤ n ≤ 65536 (the voice chain uses 256–4096;
 * the envelope uses the next power of two above its window at high sample rates). Throws RangeError otherwise.
 */
export function createRealFft(n: number): RealFft {
  if (!(Number.isInteger(n) && n >= MIN_SIZE && n <= MAX_SIZE && (n & (n - 1)) === 0)) {
    throw new RangeError(`n must be a power of two in [${MIN_SIZE}, ${MAX_SIZE}] (n = ${n})`);
  }
  const m = n >> 1;
  let bits = 0;
  while (1 << bits < m) bits++;

  const rev = new Uint32Array(m);
  for (let i = 0; i < m; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  // m-point twiddles e^(−2πi·j/m) = cosM[j] − i·sinM[j], j < m/2.
  const half = m >> 1;
  const cosM = new Float64Array(half);
  const sinM = new Float64Array(half);
  for (let j = 0; j < half; j++) {
    cosM[j] = Math.cos((2 * Math.PI * j) / m);
    sinM[j] = Math.sin((2 * Math.PI * j) / m);
  }
  // Split twiddles e^(−2πi·k/n) = cosN[k] − i·sinN[k], k ≤ m.
  const cosN = new Float64Array(m + 1);
  const sinN = new Float64Array(m + 1);
  for (let k = 0; k <= m; k++) {
    cosN[k] = Math.cos((2 * Math.PI * k) / n);
    sinN[k] = Math.sin((2 * Math.PI * k) / n);
  }
  const zr = new Float64Array(m);
  const zi = new Float64Array(m);

  function forward(x: Float32Array, re: Float32Array, im: Float32Array): void {
    if (x.length !== n || re.length < m + 1 || im.length < m + 1) {
      throw new RangeError(
        `need x.length = ${n} and re/im length ≥ ${m + 1} (got ${x.length}, ${re.length}, ${im.length})`,
      );
    }
    // Pack z[t] = x[2t] + i·x[2t+1] in bit-reversed order.
    for (let i = 0; i < m; i++) {
      const r = rev[i]!;
      zr[r] = x[2 * i]!;
      zi[r] = x[2 * i + 1]!;
    }
    // Iterative radix-2 decimation-in-time butterflies.
    for (let size = 2; size <= m; size <<= 1) {
      const hs = size >> 1;
      const step = m / size;
      for (let j = 0; j < hs; j++) {
        const wr = cosM[j * step]!;
        const wi = -sinM[j * step]!;
        for (let a = j; a < m; a += size) {
          const b = a + hs;
          const br = zr[b]!;
          const bi = zi[b]!;
          const tr = wr * br - wi * bi;
          const ti = wr * bi + wi * br;
          const ar = zr[a]!;
          const ai = zi[a]!;
          zr[b] = ar - tr;
          zi[b] = ai - ti;
          zr[a] = ar + tr;
          zi[a] = ai + ti;
        }
      }
    }
    // Real split: X[k] = E[k] + e^(−2πi·k/n)·O[k], with E/O the spectra of the even/odd samples.
    const z0r = zr[0]!;
    const z0i = zi[0]!;
    re[0] = z0r + z0i;
    im[0] = 0;
    re[m] = z0r - z0i;
    im[m] = 0;
    for (let k = 1; k < m; k++) {
      const ar = zr[k]!;
      const ai = zi[k]!;
      const br = zr[m - k]!;
      const bi = -zi[m - k]!;
      const er = 0.5 * (ar + br);
      const ei = 0.5 * (ai + bi);
      const or = 0.5 * (ai - bi);
      const oi = -0.5 * (ar - br);
      const wr = cosN[k]!;
      const wi = -sinN[k]!;
      re[k] = er + wr * or - wi * oi;
      im[k] = ei + wr * oi + wi * or;
    }
  }

  return { forward };
}
