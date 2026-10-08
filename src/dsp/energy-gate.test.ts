import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mulberry32, rmsDb, sine, toneLevelDb } from '../../test/dsp-helpers.ts';
import { butterworthHighpass, butterworthLowpass, cascade, type Biquad } from './biquad.ts';
import {
  DEFAULT_ENERGY_PARAMS,
  GATE_HPF_HZ,
  GATE_LPF_HZ,
  createGateFilter,
  energyGateStep,
  frameDb,
  initialEnergyGateState,
  type EnergyGateParams,
  type EnergyGateState,
  type FrameFeatures,
} from './energy-gate.ts';

const P = DEFAULT_ENERGY_PARAMS;

/** A hop with only `db` meaningful; `floorDb` is NaN on purpose, since the gate must read `db` only. */
function hop(db: number, frame = 0): FrameFeatures {
  return { frame, db, floorDb: Number.NaN };
}

/** Steps s in place through `n` hops at `db`, calling `each` after every step. */
function run(
  s: EnergyGateState,
  db: number,
  n: number,
  each?: (s: EnergyGateState, i: number) => void,
): void {
  for (let i = 0; i < n; i++) {
    energyGateStep(s, hop(db, i), P);
    each?.(s, i);
  }
}

/** The EMA coefficient α = 1 − exp(−hopMs/τ), at the default 10 ms hop unless given. */
function alpha(tauMs: number, hopMs = P.hopMs): number {
  return 1 - Math.exp(-hopMs / tauMs);
}

function activeAt(floorDb: number): EnergyGateState {
  const s = initialEnergyGateState(floorDb);
  s.active = true;
  return s;
}

describe('DEFAULT_ENERGY_PARAMS', () => {
  it('holds the specified values', () => {
    expect(DEFAULT_ENERGY_PARAMS).toStrictEqual({
      onsetMarginDb: 10,
      offsetMarginDb: 5,
      absMinDb: -65,
      floorDownTauMs: 45,
      floorUpTauMs: 2500,
      floorInSpeechTauMs: 20000,
      ignoreBelowDb: -100,
      initFloorCapDb: -40,
      hopMs: 10,
    });
  });
});

describe('initialEnergyGateState', () => {
  it('without a restore value is uninitialised with a NaN floor', () => {
    expect(initialEnergyGateState()).toStrictEqual({
      floorDb: Number.NaN,
      active: false,
      initialized: false,
    });
  });

  it('with a restore value starts initialised at that floor and closed', () => {
    expect(initialEnergyGateState(-47)).toStrictEqual({ floorDb: -47, active: false, initialized: true });
  });

  it('treats a non-finite restore value as no restore (decision D2)', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(initialEnergyGateState(v)).toStrictEqual({
        floorDb: Number.NaN,
        active: false,
        initialized: false,
      });
    }
  });
});

describe('energyGateStep: digital silence (validation 1)', () => {
  it('500 hops at -120 dB leave the gate uninitialised, closed, with a NaN floor', () => {
    const s = initialEnergyGateState();
    run(s, -120, 500);
    expect(s.initialized).toBe(false);
    expect(s.active).toBe(false);
    expect(s.floorDb).toBeNaN();
  });

  it('after initialisation, a -120 dB hop never changes the floor', () => {
    const s = initialEnergyGateState();
    energyGateStep(s, hop(-42.5), P);
    expect(s.floorDb).toBe(-42.5);
    run(s, -120, 500, (st) => expect(st.floorDb).toBe(-42.5));
    // Also from a restored floor and mid-convergence.
    const r = initialEnergyGateState(-60);
    run(r, -70, 3);
    const before = r.floorDb;
    run(r, -120, 10, (st) => expect(st.floorDb).toBe(before));
  });

  it('closes an open gate without touching the floor', () => {
    const s = activeAt(-60);
    energyGateStep(s, hop(-120), P);
    expect(s).toStrictEqual({ floorDb: -60, active: false, initialized: true });
  });

  it('is strict at ignoreBelowDb: -100 dB is not silence and initialises the floor', () => {
    const s = initialEnergyGateState();
    energyGateStep(s, hop(-100.001), P);
    expect(s.initialized).toBe(false);
    energyGateStep(s, hop(-100), P);
    expect(s).toStrictEqual({ floorDb: -100, active: false, initialized: true });
  });

  it('treats a NaN level as digital silence (decision D3)', () => {
    const fresh = initialEnergyGateState();
    energyGateStep(fresh, hop(Number.NaN), P);
    expect(fresh).toStrictEqual({ floorDb: Number.NaN, active: false, initialized: false });
    const s = activeAt(-60);
    energyGateStep(s, hop(Number.NaN), P);
    expect(s).toStrictEqual({ floorDb: -60, active: false, initialized: true });
  });

  it('treats a non-finite level (+-Infinity) as digital silence (decision D8)', () => {
    for (const v of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const fresh = initialEnergyGateState();
      energyGateStep(fresh, hop(v), P);
      expect(fresh).toStrictEqual({ floorDb: Number.NaN, active: false, initialized: false });
      const s = activeAt(-60);
      energyGateStep(s, hop(v), P);
      expect(s).toStrictEqual({ floorDb: -60, active: false, initialized: true });
      // The floor stays usable: the next finite hop updates it normally.
      energyGateStep(s, hop(-70), P);
      expect(s.floorDb).toBe(-60 + alpha(45) * (-70 - -60));
    }
  });
});

describe('energyGateStep: initialisation (validation 2)', () => {
  it('the first hop at -30 dB initialises the floor to the cap, -40 (#146), and is not active', () => {
    const s = initialEnergyGateState();
    energyGateStep(s, hop(-30), P);
    expect(s).toStrictEqual({ floorDb: -40, active: false, initialized: true });
  });

  it('the initialising hop is never an onset, however loud', () => {
    const s = initialEnergyGateState();
    run(s, -120, 20);
    energyGateStep(s, hop(0), P);
    expect(s).toStrictEqual({ floorDb: -40, active: false, initialized: true });
  });
});

describe('energyGateStep: onset (validation 3)', () => {
  it('with the floor at -60 dB, -49 dB activates and -51 dB does not', () => {
    const a = initialEnergyGateState(-60);
    energyGateStep(a, hop(-49), P);
    expect(a.active).toBe(true);
    const b = initialEnergyGateState(-60);
    energyGateStep(b, hop(-51), P);
    expect(b.active).toBe(false);
  });

  it('with the floor at -90 dB, -70 dB does not activate (absMin -65) and -64 dB does', () => {
    const a = initialEnergyGateState(-90);
    energyGateStep(a, hop(-70), P);
    expect(a.active).toBe(false);
    const b = initialEnergyGateState(-90);
    energyGateStep(b, hop(-64), P);
    expect(b.active).toBe(true);
  });

  it('is strict at both onset bounds', () => {
    const a = initialEnergyGateState(-60);
    energyGateStep(a, hop(-50), P);
    expect(a.active).toBe(false);
    const b = initialEnergyGateState(-90);
    energyGateStep(b, hop(-65), P);
    expect(b.active).toBe(false);
  });

  it('compares against the floor before this step (-49.999 dB activates from -60)', () => {
    // After the update the floor would be above -60, and -49.999 would no longer clear it by 10 dB.
    const s = initialEnergyGateState(-60);
    energyGateStep(s, hop(-49.999), P);
    expect(s.active).toBe(true);
  });
});

describe('energyGateStep: offset (validation 4)', () => {
  it('from active with the floor at -60, -54 dB stays active and -56 dB deactivates', () => {
    const a = activeAt(-60);
    energyGateStep(a, hop(-54), P);
    expect(a.active).toBe(true);
    const b = activeAt(-60);
    energyGateStep(b, hop(-56), P);
    expect(b.active).toBe(false);
  });

  it('is strict at the offset bound and compares against the floor before this step', () => {
    const a = activeAt(-60);
    energyGateStep(a, hop(-55), P);
    expect(a.active).toBe(true);
    // After the update the floor would be above -60, and -54.999 would fall below floor + 5.
    const b = activeAt(-60);
    energyGateStep(b, hop(-54.999), P);
    expect(b.active).toBe(true);
  });
});

describe('energyGateStep: floor update', () => {
  it('falls with floorDownTauMs when db <= floor', () => {
    const s = initialEnergyGateState(-60);
    energyGateStep(s, hop(-70), P);
    expect(s.floorDb).toBe(-60 + alpha(45) * (-70 - -60));
    const e = initialEnergyGateState(-60);
    energyGateStep(e, hop(-60), P);
    expect(e.floorDb).toBe(-60);
  });

  it('falls with floorDownTauMs on the hop that closes the gate', () => {
    const s = activeAt(-60);
    energyGateStep(s, hop(-70), P);
    expect(s.active).toBe(false);
    expect(s.floorDb).toBe(-60 + alpha(45) * (-70 - -60));
  });

  it('prefers floorDownTauMs over floorInSpeechTauMs when db <= floor and the gate stays open', () => {
    // With the default offsetMarginDb (5 > 0) a hop at or below the floor always closes the gate first,
    // so a negative margin is needed to reach this branch of step 4.
    const p: EnergyGateParams = { ...P, offsetMarginDb: -20 };
    const s = activeAt(-60);
    energyGateStep(s, hop(-70), p);
    expect(s.active).toBe(true);
    expect(s.floorDb).toBe(-60 + alpha(45) * (-70 - -60));
  });

  it('rises with floorUpTauMs when db > floor and the gate stays closed', () => {
    const s = initialEnergyGateState(-60);
    energyGateStep(s, hop(-55), P);
    expect(s.active).toBe(false);
    expect(s.floorDb).toBe(-60 + alpha(2500) * (-55 - -60));
  });

  it('drifts with floorInSpeechTauMs when db > floor and the gate is open', () => {
    const s = activeAt(-60);
    energyGateStep(s, hop(-40), P);
    expect(s.active).toBe(true);
    expect(s.floorDb).toBe(-60 + alpha(20000) * (-40 - -60));
  });

  it('uses the gate state after hysteresis: the onset hop drifts with floorInSpeechTauMs', () => {
    const s = initialEnergyGateState(-60);
    energyGateStep(s, hop(-49), P);
    expect(s.active).toBe(true);
    expect(s.floorDb).toBe(-60 + alpha(20000) * (-49 - -60));
  });

  it('uses the gate state after hysteresis: the offset hop rises with floorUpTauMs', () => {
    const s = activeAt(-60);
    energyGateStep(s, hop(-56), P);
    expect(s.active).toBe(false);
    expect(s.floorDb).toBe(-60 + alpha(2500) * (-56 - -60));
  });

  it('applies the taus at hopMs', () => {
    const p: EnergyGateParams = { ...P, hopMs: 32 };
    const s = initialEnergyGateState(-60);
    energyGateStep(s, hop(-70), p);
    expect(s.floorDb).toBe(-60 + alpha(45, 32) * (-70 - -60));
  });
});

describe('energyGateStep: contract', () => {
  it('mutates and returns the same state object', () => {
    const s = initialEnergyGateState();
    for (const db of [-120, -30, -10, -60, -120]) expect(energyGateStep(s, hop(db), P)).toBe(s);
  });

  it('reads f.db only (frame, floorDb and voiced are ignored)', () => {
    const dbs = [-120, -45, -44, -30, -52, -120, -58, -20, -61, -61];
    const a = initialEnergyGateState();
    const b = initialEnergyGateState();
    dbs.forEach((db, i) => {
      energyGateStep(a, { frame: i, db, floorDb: Number.NaN }, P);
      energyGateStep(b, { frame: -7 * i, db, floorDb: 1e9 - i, voiced: i % 2 === 0 }, P);
      expect(b).toStrictEqual(a);
    });
  });
});

describe('energyGateStep: convergence (validation 5)', () => {
  it('steady -50 dB after a floor restored at -30 is within 0.5 dB of -50 in <= 50 hops and never activates', () => {
    const s = initialEnergyGateState(-30);
    let firstWithin = -1;
    run(s, -50, 1000, (st, i) => {
      expect(st.active).toBe(false);
      if (firstWithin < 0 && Math.abs(st.floorDb - -50) <= 0.5) firstWithin = i + 1;
    });
    expect(firstWithin).toBeGreaterThan(0);
    expect(firstWithin).toBeLessThanOrEqual(50);
    expect(Math.abs(s.floorDb - -50)).toBeLessThanOrEqual(0.5);
  });

  it('a floor restored at -70 under steady -62 dB stays inactive and rises to within 1 dB of -62 after 600 hops', () => {
    const s = initialEnergyGateState(-70);
    let prev = s.floorDb;
    run(s, -62, 600, (st) => {
      expect(st.active).toBe(false);
      expect(st.floorDb).toBeGreaterThan(prev);
      expect(st.floorDb).toBeLessThanOrEqual(-62);
      prev = st.floorDb;
    });
    expect(Math.abs(s.floorDb - -62)).toBeLessThanOrEqual(1);
  });
});

describe('energyGateStep: floor bounds (validation 6, property)', () => {
  const level = fc.oneof(
    fc.double({ min: -130, max: 0, noNaN: true }),
    fc.constantFrom(-130, -120, -100.000001, -100, -65, -0, 0),
  );

  it('once initialised, floorDb is finite and within [min(min, initFloorCapDb), max] of the non-silent inputs so far', () => {
    fc.assert(
      fc.property(fc.array(level, { minLength: 1, maxLength: 400 }), (dbs) => {
        const s = initialEnergyGateState();
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < dbs.length; i++) {
          const db = dbs[i]!;
          const before = s.floorDb;
          expect(energyGateStep(s, hop(db, i), P)).toBe(s);
          if (db < P.ignoreBelowDb) {
            expect(Object.is(s.floorDb, before)).toBe(true);
            expect(s.active).toBe(false);
          } else {
            lo = Math.min(lo, db);
            hi = Math.max(hi, db);
          }
          expect(s.initialized).toBe(lo <= hi);
          if (s.initialized) {
            expect(Number.isFinite(s.floorDb)).toBe(true);
            expect(s.floorDb).toBeGreaterThanOrEqual(Math.min(lo, P.initFloorCapDb));
            expect(s.floorDb).toBeLessThanOrEqual(hi);
          } else {
            expect(s.floorDb).toBeNaN();
            expect(s.active).toBe(false);
          }
        }
      }),
      { numRuns: 1000, seed: 0x7110 },
    );
  });

  it('with the cap disabled (the pre-#146 rule), floorDb stays within [min, max] of the non-silent inputs', () => {
    const p: EnergyGateParams = { ...P, initFloorCapDb: Number.POSITIVE_INFINITY };
    fc.assert(
      fc.property(fc.array(level, { minLength: 1, maxLength: 400 }), (dbs) => {
        const s = initialEnergyGateState();
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < dbs.length; i++) {
          const db = dbs[i]!;
          energyGateStep(s, hop(db, i), p);
          if (db >= p.ignoreBelowDb) {
            lo = Math.min(lo, db);
            hi = Math.max(hi, db);
          }
          if (s.initialized) {
            expect(s.floorDb).toBeGreaterThanOrEqual(lo);
            expect(s.floorDb).toBeLessThanOrEqual(hi);
          }
        }
      }),
      { numRuns: 1000, seed: 0x7146 },
    );
  });
});

describe('frameDb (validation 7)', () => {
  it('reads -3.01 +- 0.05 dB for a full-scale 1 kHz sine at 16 kHz over 160 samples', () => {
    const x = sine(1000, 16_000, 0.01, 1);
    expect(x.length).toBe(160);
    expect(Math.abs(frameDb(x, 0, 160) - -3.01)).toBeLessThanOrEqual(0.05);
  });

  it('reads -120 dB for all zeros and 10·log10(c²) for a constant c', () => {
    expect(frameDb(new Float32Array(160), 0, 160)).toBeCloseTo(-120, 9);
    expect(frameDb(new Float32Array(160).fill(0.1), 0, 160)).toBeCloseTo(-20, 5);
  });

  it('measures x[from, to) only', () => {
    const x = new Float32Array(480);
    x.set(sine(1000, 16_000, 0.01, 1), 160);
    expect(frameDb(x, 0, 160)).toBeCloseTo(-120, 9);
    expect(frameDb(x, 160, 320)).toBe(frameDb(sine(1000, 16_000, 0.01, 1), 0, 160));
    expect(frameDb(x, 320, 480)).toBeCloseTo(-120, 9);
  });

  it('defaults to the whole array (decision D1)', () => {
    const x = sine(1000, 16_000, 0.01, 0.5);
    expect(frameDb(x)).toBe(frameDb(x, 0, x.length));
    expect(frameDb(x, 80)).toBe(frameDb(x, 80, x.length));
  });

  it('throws RangeError for an empty, reversed, out-of-bounds or non-integer range (decision D1)', () => {
    const x = new Float32Array(160);
    for (const [from, to] of [
      [0, 0],
      [80, 80],
      [100, 50],
      [-1, 160],
      [0, 161],
      [0.5, 160],
      [0, 159.5],
      [Number.NaN, 160],
    ] as const) {
      expect(() => frameDb(x, from, to)).toThrow(RangeError);
    }
    expect(() => frameDb(new Float32Array(0))).toThrow(RangeError);
  });
});

/** Steady-state gain in dB at f: toneLevelDb(out) - toneLevelDb(in) over the last 0.5 s of a 1 s sine. */
function gainDb(filter: Biquad, fs: number, f: number): number {
  const x = sine(f, fs, 1);
  const y = filter.process(x);
  const from = x.length - Math.round(0.5 * fs);
  return toneLevelDb(y, f, fs, from, x.length) - toneLevelDb(x, f, fs, from, x.length);
}

/** Uniform white noise in [-1, 1) from a seeded PRNG. */
function noise(n: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rand() * 2 - 1;
  return x;
}

describe('createGateFilter (validation 7)', () => {
  it('exports the band-limit corners (HPF 200 Hz, LPF 3400 Hz)', () => {
    expect([GATE_HPF_HZ, GATE_LPF_HZ]).toStrictEqual([200, 3400]);
  });

  it('attenuates 100 Hz by at least 20 dB at 16 kHz', () => {
    expect(gainDb(createGateFilter(16_000), 16_000, 100)).toBeLessThanOrEqual(-20);
  });

  it('passes 1 kHz within +-0.5 dB at 16 kHz', () => {
    expect(Math.abs(gainDb(createGateFilter(16_000), 16_000, 1000))).toBeLessThanOrEqual(0.5);
  });

  it('is exactly cascade(HPF 200, HPF 200, LPF 3400), in that order', () => {
    const x = noise(4800, 11);
    const expected = cascade(
      butterworthHighpass(16_000, 200),
      butterworthHighpass(16_000, 200),
      butterworthLowpass(16_000, 3400),
    ).process(x);
    const reordered = cascade(
      butterworthLowpass(16_000, 3400),
      butterworthHighpass(16_000, 200),
      butterworthHighpass(16_000, 200),
    ).process(x);
    expect(createGateFilter(16_000).process(x)).toStrictEqual(expected);
    // Guards the check itself: float32 rounding between stages makes the order observable.
    expect(reordered).not.toStrictEqual(expected);
  });

  it('returns independent filters (no shared state between calls)', () => {
    const a = createGateFilter(16_000);
    const b = createGateFilter(16_000);
    a.process(noise(1000, 3));
    const x = noise(800, 5);
    expect(b.process(x)).toStrictEqual(createGateFilter(16_000).process(x));
  });

  it('keeps the same corners at 48 kHz: >= 20 dB down at 100 Hz, 1 kHz within +-0.5 dB, <= -12 dB at 7 kHz', () => {
    expect(gainDb(createGateFilter(48_000), 48_000, 100)).toBeLessThanOrEqual(-20);
    expect(Math.abs(gainDb(createGateFilter(48_000), 48_000, 1000))).toBeLessThanOrEqual(0.5);
    // The 7 kHz check is what catches a low-pass designed for 16 kHz regardless of fs (its corner would sit at
    // 10.2 kHz here, and 7 kHz would read about -0.6 dB instead of about -13.7 dB).
    expect(gainDb(createGateFilter(48_000), 48_000, 7000)).toBeLessThanOrEqual(-12);
  });

  it('throws RangeError when 3400 Hz is not below fs/2', () => {
    expect(() => createGateFilter(6800)).toThrow(RangeError);
  });
});

// ---- First-listen floor initialisation (#146) ----

/** Gate-path hop levels of a 16 kHz signal, as VadCore computes them: a fresh createGateFilter(16 kHz), then
 *  frameDb over each whole 10 ms (160-sample) hop. */
function gateHopLevels(x: Float32Array): number[] {
  const y = createGateFilter(16_000).process(x);
  const out: number[] = [];
  for (let from = 0; from + 160 <= y.length; from += 160) out.push(frameDb(y, from, from + 160));
  return out;
}

/** Scales x in place so that its gate-path (band-limited) RMS level is `db` dBFS. */
function atGateLevel(x: Float32Array, db: number): Float32Array {
  const g = 10 ** ((db - rmsDb(createGateFilter(16_000).process(x))) / 20);
  for (let i = 0; i < x.length; i++) x[i] = x[i]! * g;
  return x;
}

/**
 * A steady synthetic vowel at 16 kHz with an RMS of `rmsDbfs` dBFS, at full level from its first sample (no
 * envelope, no fade): the harmonics of f0 below 3.4 kHz, each weighted by the magnitude of three formant
 * resonances (F1 700/80, F2 1220/90, F3 2600/120 Hz, the formants of scripts/gen-fixtures.ts).
 */
function steadyVowel(f0: number, seconds: number, rmsDbfs: number): Float32Array {
  const formants = [
    [700, 80],
    [1220, 90],
    [2600, 120],
  ] as const;
  const n = Math.round(seconds * 16_000);
  const x = new Float32Array(n);
  for (let k = 1; k * f0 < 3400; k++) {
    const f = k * f0;
    let a = 1;
    for (const [fHz, bw] of formants) a *= (fHz * fHz) / Math.hypot(fHz * fHz - f * f, bw * f);
    const w = (2 * Math.PI * f) / 16_000;
    for (let i = 0; i < n; i++) x[i] = x[i]! + a * Math.sin(w * i);
  }
  const g = 10 ** ((rmsDbfs - rmsDb(x)) / 20);
  for (let i = 0; i < n; i++) x[i] = x[i]! * g;
  return x;
}

/** Steps a fresh gate (no restored floor) over `levels`; returns the end (ms) of the first active hop, or -1. */
function openedAfterMs(levels: readonly number[], p: EnergyGateParams = P): number {
  const s = initialEnergyGateState();
  for (let i = 0; i < levels.length; i++) {
    energyGateStep(s, hop(levels[i]!, i), p);
    if (s.active) return (i + 1) * p.hopMs;
  }
  return -1;
}

describe('energyGateStep: first-listen floor initialisation (#146)', () => {
  it('the first accepted hop initialises the floor to min(db, initFloorCapDb), after any digital silence', () => {
    const cases = [
      [0, -40],
      [-20, -40],
      [-39.5, -40],
      [-40, -40],
      [-40.5, -40.5],
      [-55, -55],
      [-100, -100],
    ] as const;
    for (const [db, floorDb] of cases) {
      const s = initialEnergyGateState();
      run(s, -120, 5);
      energyGateStep(s, hop(db), P);
      expect(s).toStrictEqual({ floorDb, active: false, initialized: true });
    }
  });

  it('speech on the first hop: the next hop more than 10 dB above the cap is an onset', () => {
    const s = initialEnergyGateState();
    energyGateStep(s, hop(-25), P);
    expect(s).toStrictEqual({ floorDb: -40, active: false, initialized: true });
    energyGateStep(s, hop(-25), P);
    expect(s.active).toBe(true);
    expect(s.floorDb).toBe(-40 + alpha(20000) * (-25 - -40));
    // Exactly at cap + onsetMarginDb is not an onset (strict, as in validation 3).
    const t = initialEnergyGateState();
    energyGateStep(t, hop(-25), P);
    energyGateStep(t, hop(-30), P);
    expect(t.active).toBe(false);
  });

  it('reads the cap from the params; a non-finite cap disables it (the pre-#146 rule)', () => {
    const low = initialEnergyGateState();
    energyGateStep(low, hop(-50), { ...P, initFloorCapDb: -60 });
    expect(low).toStrictEqual({ floorDb: -60, active: false, initialized: true });
    for (const initFloorCapDb of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const s = initialEnergyGateState();
      energyGateStep(s, hop(-20), { ...P, initFloorCapDb });
      expect(s).toStrictEqual({ floorDb: -20, active: false, initialized: true });
    }
  });

  it('never caps a restored floor: a re-arm keeps its snapshot, even above the cap', () => {
    const s = initialEnergyGateState(-30);
    energyGateStep(s, hop(-28), P);
    expect(s.active).toBe(false);
    expect(s.floorDb).toBe(-30 + alpha(2500) * (-28 - -30));
  });

  it('a steady vowel at -25 dBFS from the very first accepted hop opens the gate within 150 ms (validation 1)', () => {
    const levels = gateHopLevels(steadyVowel(140, 1, -25));
    // The very first hop is already speech, well above the cap.
    expect(levels[0]).toBeGreaterThan(P.initFloorCapDb + P.onsetMarginDb);
    const ms = openedAfterMs(levels);
    expect(ms).toBeGreaterThan(P.hopMs); // the initialising hop is never an onset
    expect(ms).toBeLessThanOrEqual(150);
  });

  it('without the cap (the pre-#146 rule) the same vowel never opens the gate within its 1 s', () => {
    const levels = gateHopLevels(steadyVowel(140, 1, -25));
    expect(openedAfterMs(levels, { ...P, initFloorCapDb: Number.POSITIVE_INFINITY })).toBe(-1);
  });

  it('steady ambient noise at -45 dBFS alone never opens the gate within 10 s (validation 1)', () => {
    const levels = gateHopLevels(atGateLevel(noise(10 * 16_000, 146), -45));
    expect(levels).toHaveLength(1000);
    expect(openedAfterMs(levels)).toBe(-1);
  });

  it('steady noise 5 dB above the cap (-35 dBFS, the plan’s too-noisy floor) never opens the gate within 10 s', () => {
    const levels = gateHopLevels(atGateLevel(noise(10 * 16_000, 1460), -35));
    expect(levels[0]).toBeGreaterThan(P.initFloorCapDb); // so the cap is what initialises the floor
    expect(openedAfterMs(levels)).toBe(-1);
  });
});
