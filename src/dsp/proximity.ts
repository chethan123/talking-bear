// Proximity gate (plan §4.2.2): no VAD rejects TV speech, so a Silero segment only counts when its active level
// is at least X dB above the noise floor at its onset. The active level is the power mean of the segment's
// band-limited 10 ms hop levels; X is tuned in the M2 grid (#59) and raised by the too-noisy logic (plan §4.4).
//
// Pure: no DOM, no globals, no timers. Neither function allocates, so the worker can call them on its
// per-frame path.

/** Hop levels below this (dBFS) are digital silence: `activeLevelDb` ignores them, like the energy gate does. */
export const DIGITAL_SILENCE_DB = -100;

/**
 * Power mean of the hop levels hopDb[from..to) in dBFS: 10·log10(mean(10^(db/10))). Values below
 * DIGITAL_SILENCE_DB (and NaN) are ignored; −Infinity when no value is left (an empty range included).
 *
 * Element i of the range is hopDb[i % hopDb.length], so a range may wrap around the end of a ring buffer; a
 * plain array just uses to ≤ hopDb.length. Throws RangeError unless from and to are integers with
 * 0 ≤ from ≤ to ≤ from + hopDb.length.
 */
export function activeLevelDb(hopDb: Float32Array, from: number, to: number): number {
  const n = hopDb.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to - from > n) {
    throw new RangeError(`invalid range [${from}, ${to}) for length ${n}`);
  }
  let sum = 0;
  let count = 0;
  for (let i = from; i < to; i++) {
    const db = hopDb[i % n]!;
    if (!(db >= DIGITAL_SILENCE_DB)) continue; // below the silence level, or NaN
    sum += 10 ** (db / 10);
    count++;
  }
  return count === 0 ? Number.NEGATIVE_INFINITY : 10 * Math.log10(sum / count);
}

/**
 * True when the segment is near enough: activeDb − floorAtOnsetDb ≥ proximityDb. A NaN floor (the gate had no
 * floor yet at the onset) always passes.
 */
export function passesProximity(activeDb: number, floorAtOnsetDb: number, proximityDb: number): boolean {
  if (Number.isNaN(floorAtOnsetDb)) return true;
  return activeDb - floorAtOnsetDb >= proximityDb;
}
