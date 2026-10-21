/**
 * The seeded random source of the animation layers (plan §3.5): every random choice a layer makes comes from
 * the `AnimContext.rng` it is given, so a fixed seed replays the same pose sequence. Nothing here allocates
 * per call.
 */

/** A uniform random source on [0, 1). */
export type Rng = () => number;

/**
 * mulberry32: a small, fast 32-bit PRNG with a 2³² period, returning uniform doubles on [0, 1) with 32 bits
 * of resolution. The same seed always gives the same sequence. `seed` is taken modulo 2³² (`seed >>> 0`).
 * Allocates the closure and its one-slot state once; each call allocates nothing itself (its double return is boxed
 * where V8 doesn't inline the call, once per draw: per event, not per frame).
 */
export function mulberry32(seed: number): Rng {
  // The state in an `Int32Array` slot, not a closure variable: an int32 outside V8's small-integer range (31 bits)
  // held in a closure variable is boxed as a new heap number on every write (#229). Storing `seed >>> 0` wraps it
  // to the same 32 bits, and every use below reads them through `| 0`, `>>>` or `Math.imul`, so the sequence is the
  // same.
  const st = new Int32Array(1);
  st[0] = seed >>> 0;
  return () => {
    const a = (st[0]! + 0x6d2b79f5) | 0;
    st[0] = a;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform draw on [lo, hi) (on [lo, hi] up to rounding): `lo + (hi − lo)·rng()`. One `rng` call. */
export function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/**
 * An exponentially distributed draw with the given mean (the waiting time of a Poisson process with rate
 * 1/mean): `−mean·ln(1 − u)`, u = `rng()`, computed as `mean·(−log1p(−u))` so that u = 0 gives +0. Since
 * u ∈ [0, 1), the result is finite and ≥ 0. One `rng` call.
 */
export function exponential(rng: Rng, mean: number): number {
  return mean * -Math.log1p(-rng());
}
