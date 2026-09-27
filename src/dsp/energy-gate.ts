// Energy VAD step (plan §4.2.1, §3.3): band-limited level in dBFS against an adaptive noise floor.
// The floor is an asymmetric EMA in dB (falls fast, rises slowly, only drifts up during speech) that ignores
// digital silence; onset / offset use hysteresis against the floor as it was before the step. It is the M1 VAD
// backend, the level meter, the Silero fallback and the optional pre-gate (plan §4.2.3).
//
// Pure: no DOM, no globals, no timers. `energyGateStep` and `frameDb` don't allocate, so the worker can run
// them on every 10 ms hop.

import { butterworthHighpass, butterworthLowpass, cascade, type Biquad } from './biquad.ts';

/** Per-hop features (plan §3.3). The gate reads `db` only. */
export interface FrameFeatures {
  frame: number;
  db: number;
  floorDb: number;
  voiced?: boolean;
}

export interface EnergyGateParams {
  /** Onset when db > max(floor + onsetMarginDb, absMinDb). */
  onsetMarginDb: number;
  /** Offset when db < floor + offsetMarginDb. */
  offsetMarginDb: number;
  /** Absolute onset minimum in dBFS. */
  absMinDb: number;
  /** Floor time constant when db <= floor (fast fall). */
  floorDownTauMs: number;
  /** Floor time constant when db > floor and the gate is closed (slow rise). */
  floorUpTauMs: number;
  /** Floor time constant when db > floor and the gate is open (drift during speech). */
  floorInSpeechTauMs: number;
  /** Hops below this level are digital silence: they never touch the floor. */
  ignoreBelowDb: number;
  /** The hop size the time constants are applied at (addition to plan §3.3). */
  hopMs: number;
}

export const DEFAULT_ENERGY_PARAMS: EnergyGateParams = {
  onsetMarginDb: 10,
  offsetMarginDb: 5,
  absMinDb: -65,
  floorDownTauMs: 45,
  floorUpTauMs: 2500,
  floorInSpeechTauMs: 20000,
  ignoreBelowDb: -100,
  hopMs: 10,
};

export interface EnergyGateState {
  /** Noise floor in dBFS; NaN until initialised. */
  floorDb: number;
  /** True while the gate is open (speech). */
  active: boolean;
  /** False until the first hop that isn't digital silence, unless the floor was restored. */
  initialized: boolean;
}

/**
 * A fresh gate state. A finite `restoreFloorDb` (the floor snapshot from the previous listen) starts the gate
 * initialised at that floor; anything else (undefined, NaN, ±Infinity) starts it uninitialised.
 */
export function initialEnergyGateState(restoreFloorDb?: number): EnergyGateState {
  if (restoreFloorDb !== undefined && Number.isFinite(restoreFloorDb)) {
    return { floorDb: restoreFloorDb, active: false, initialized: true };
  }
  return { floorDb: Number.NaN, active: false, initialized: false };
}

/**
 * Mutates and returns s (no allocation). Uses f.db only. In order:
 * 1. digital silence (db < ignoreBelowDb, or NaN): close the gate, leave the floor;
 * 2. the first other hop initialises the floor to db and is never an onset;
 * 3. hysteresis against the floor as it was before this step;
 * 4. floor += α·(db − floor), α = 1 − exp(−hopMs/τ), τ = down if db <= floor, else in-speech if the gate is
 *    open (after step 3), else up.
 */
export function energyGateStep(s: EnergyGateState, f: FrameFeatures, p: EnergyGateParams): EnergyGateState {
  const db = f.db;
  // 1. Digital silence. `!(db >= …)` also sends NaN here, so a NaN level can never poison the floor.
  if (!(db >= p.ignoreBelowDb)) {
    if (s.active) s.active = false;
    return s;
  }
  // 2. Initialisation: the initialising hop can never be an onset.
  if (!s.initialized) {
    s.floorDb = db;
    s.initialized = true;
    s.active = false;
    return s;
  }
  const floor = s.floorDb;
  // 3. Hysteresis, against the floor before this step's update.
  if (!s.active) {
    if (db > Math.max(floor + p.onsetMarginDb, p.absMinDb)) s.active = true;
  } else if (db < floor + p.offsetMarginDb) {
    s.active = false;
  }
  // 4. Asymmetric EMA in dB.
  const tauMs = db <= floor ? p.floorDownTauMs : s.active ? p.floorInSpeechTauMs : p.floorUpTauMs;
  const alpha = 1 - Math.exp(-p.hopMs / tauMs);
  s.floorDb = floor + alpha * (db - floor);
  return s;
}

/**
 * 10·log10(mean(x[from..to)²) + 1e-12): the level of x[from, to) in dBFS (a full-scale sine reads −3.01 dB,
 * all zeros −120 dB). Throws RangeError unless from and to are integers with 0 <= from < to <= x.length.
 */
export function frameDb(x: Float32Array, from = 0, to = x.length): number {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > x.length || from >= to) {
    throw new RangeError(`invalid range [${from}, ${to}) for length ${x.length}`);
  }
  let sum = 0;
  for (let i = from; i < to; i++) {
    const v = x[i]!;
    sum += v * v;
  }
  return 10 * Math.log10(sum / (to - from) + 1e-12);
}

/** Gate band-limit corners (plan §4.2.1 step 1); exported so front-end configs can be checked against them. */
export const GATE_HPF_HZ = 200;
export const GATE_LPF_HZ = 3400;

/** Gate-path band-limit at fs: cascade(HPF 200, HPF 200, LPF 3400), all Butterworth (plan §4.2.1 step 1).
 *  Throws RangeError when 3400 Hz is not below fs/2. Each call returns an independent filter. */
export function createGateFilter(fs: number): Biquad {
  return cascade(
    butterworthHighpass(fs, GATE_HPF_HZ),
    butterworthHighpass(fs, GATE_HPF_HZ),
    butterworthLowpass(fs, GATE_LPF_HZ),
  );
}
