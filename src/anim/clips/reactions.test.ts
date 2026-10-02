import { describe, expect, it, vi } from 'vitest';

import { BONES } from '../../art/bear-parts.gen.ts';
import { sampleClip } from '../clip.ts';
import type { Clip } from '../clip.ts';
import { EAR_SPRING, GAZE_SPRING } from '../layers/index.ts';
import { Ch, CH_COUNT, createPose } from '../pose.ts';
import type { Pose } from '../pose.ts';
import { BONE_COUNT, boneIndex, boneMatrices, createRig, MAT } from '../rig.ts';
import { SpringBank } from '../springs.ts';
import {
  BELLY_SPRING,
  configureSprings,
  HEAD_SPRING,
  KERCHIEF_A_SPRING,
  KERCHIEF_B_SPRING,
  NOSE_SPRING,
  SECONDARY_SPRINGS,
  SPRING,
  SPRING_CHANNEL,
  SPRING_COUNT,
  SPRING_PARAMS,
  TUFT_SPRING,
} from '../springs-map.ts';
import { SUBSTEP } from '../stepper.ts';
import { GENTLE_BASES, GENTLE_SCALE, REACTION_CLIPS } from './reactions.ts';
import type { ReactionClipName } from './reactions.ts';

const DEG = Math.PI / 180;
/** "Within 0.02 of neutral" (validation 2). */
const NEUTRAL_TOL = 0.02;
/** A gentle variant's max |channel| is at most this × its base clip's (validation 3). */
const GENTLE_MAX_RATIO = 0.35;

/** Every clip, iterated from the exported set: `[name, clip]`. */
const CLIPS = Object.entries(REACTION_CLIPS);
const SUSTAINED = CLIPS.filter(([, c]) => c.sustained === true);
const NOT_SUSTAINED = CLIPS.filter(([, c]) => c.sustained !== true);

/** The #90 table's clip names: one per reaction, the L/R ones per side (#90 "Sides"). */
const TABLE = [
  'sneeze',
  'bigSneeze',
  'noseWrinkle',
  'tuftBoing',
  'headPress',
  'pet',
  'againstFur',
  'wobble',
  'dizzy',
  'blush',
  'squish',
  'bellyBoing',
  'bellyRub',
  'giggle',
  'laughFit',
  'hug',
  'kickGiggle',
  'kerchiefAdjust',
] as const;
const SIDED = [
  'earFlick',
  'earDroop',
  'earFlatten',
  'hardBlink',
  'cheekPuff',
  'pawWave',
  'highFive',
  'footPull',
] as const;
const GENTLE = ['sneezeGentle', 'bigSneezeGentle', 'wobbleGentle', 'dizzyGentle', 'laughFitGentle'] as const;
/** The clips the issue marks sustained. */
const SUSTAINED_NAMES = [
  'noseWrinkle',
  'headPress',
  'pet',
  'earDroopL',
  'earDroopR',
  'squish',
  'bellyRub',
  'hug',
  'highFiveL',
  'highFiveR',
] as const;

function clip(name: ReactionClipName): Clip {
  return REACTION_CLIPS[name];
}

/** Channel `ch` of clip `c` at time `t`. */
function at(c: Clip, t: number, ch: number): number {
  return sampleClip(c, t, createPose())[ch]!;
}

/** 0, 1 ms, 2 ms, … up to the duration, plus every key time. */
function grid(c: Clip): number[] {
  const ts = new Set<number>();
  for (let i = 0; i * 0.001 < c.duration; i++) ts.add(i * 0.001);
  ts.add(c.duration);
  for (const tr of c.tracks) for (const key of tr.keys) ts.add(key.t);
  return [...ts].toSorted((a, b) => a - b);
}

/** Channel `ch` of `c` over `grid(c)`. */
function series(c: Clip, ch: number): number[] {
  return grid(c).map((t) => at(c, t, ch));
}

/** The times in `grid(c)` at which channel `ch` of `c` reaches 0 from a nonzero value. */
function zeros(c: Clip, ch: number): number[] {
  const ts = grid(c);
  const xs = series(c, ch);
  return ts.filter((_, i) => i > 0 && xs[i] === 0 && xs[i - 1] !== 0);
}

// `createRig` builds a `Path2D` per part; Node has none and the bone matrices don't need them.
vi.stubGlobal(
  'Path2D',
  class {
    readonly d: string | undefined;
    constructor(d?: string) {
      this.d = d;
    }
  },
);
const RIG = createRig();
const BONE_BUF = new Float32Array(BONE_COUNT * MAT);

/** Where bone `id`'s pivot is drawn (design units) in `pose`: its rest pivot through its bone matrix. */
function posedPivot(pose: Pose, id: string): [number, number] {
  boneMatrices(RIG, pose, BONE_BUF);
  const b = boneIndex(id);
  const [x, y] = BONES[b]!.pivot;
  const o = b * MAT;
  const m = BONE_BUF;
  return [m[o]! * x + m[o + 2]! * y + m[o + 4]!, m[o + 1]! * x + m[o + 3]! * y + m[o + 5]!];
}

/** The distance from paw `side` to eye `side` (design units) in hardBlink`side` at `t`, or at rest for null. */
function pawToEye(side: 'L' | 'R', t: number | null): number {
  const pose = t === null ? createPose() : sampleClip(REACTION_CLIPS[`hardBlink${side}`], t, createPose());
  const [px, py] = posedPivot(pose, `paw${side}`);
  const [ex, ey] = posedPivot(pose, `eye${side}`);
  return Math.hypot(px - ex, py - ey);
}

/** The largest |value| of each channel over `grid(c)`. */
function maxAbs(c: Clip): Float64Array {
  const out = new Float64Array(CH_COUNT);
  const pose = createPose();
  for (const t of grid(c)) {
    sampleClip(c, t, pose);
    for (let ch = 0; ch < CH_COUNT; ch++) out[ch] = Math.max(out[ch]!, Math.abs(pose[ch]!));
  }
  return out;
}

/** The channels clip `c` has a track for. */
function channels(c: Clip): number[] {
  return c.tracks.map((tr) => tr.ch);
}

interface SpringRun {
  /** Each spring's position at the end of the run. */
  readonly pos: Float32Array;
  /** Each spring's largest |position| during the run. */
  readonly peak: Float64Array;
}

/**
 * Runs the app's SpringBank (`configureSprings`, from rest) for `seconds` at the 1/120 s substep, applying the
 * clip's impulses as the substep that starts at or before each impulse's `t` begins, the way a frame loop that
 * owns the bank would.
 */
function runSprings(c: Clip, seconds: number, minZeta = 0): SpringRun {
  const bank = new SpringBank(SPRING_COUNT);
  configureSprings(bank, minZeta);
  const peak = new Float64Array(SPRING_COUNT);
  const steps = Math.ceil(seconds / SUBSTEP);
  for (let n = 0; n < steps; n++) {
    substep(bank, c, n);
    for (let i = 0; i < SPRING_COUNT; i++) peak[i] = Math.max(peak[i]!, Math.abs(bank.pos[i]!));
  }
  return { pos: bank.pos, peak };
}

/** Substep `n` of `bank` for clip `c`: the kicks due in [n, n + 1)·SUBSTEP, then one step. */
function substep(bank: SpringBank, c: Clip, n: number): void {
  const t0 = n * SUBSTEP;
  for (const imp of c.impulses ?? [])
    if (imp.t >= t0 && imp.t < t0 + SUBSTEP) bank.impulse(imp.spring, imp.dv);
  bank.step(SUBSTEP);
}

/**
 * The largest |value| of each channel a viewer sees over `grid(c)`: the clip's sample plus every spring's position
 * on its channel (`SPRING_CHANNEL`), with the springs run from rest as in `runSprings`. Each grid time takes the
 * springs as of the last substep that ended by then.
 */
function maxAbsSeen(c: Clip): Float64Array {
  const out = new Float64Array(CH_COUNT);
  const pose = createPose();
  const bank = new SpringBank(SPRING_COUNT);
  configureSprings(bank);
  let n = 0;
  for (const t of grid(c)) {
    while ((n + 1) * SUBSTEP <= t) substep(bank, c, n++);
    sampleClip(c, t, pose);
    for (let i = 0; i < SPRING_COUNT; i++)
      pose[SPRING_CHANNEL[i]!] = pose[SPRING_CHANNEL[i]!]! + bank.pos[i]!;
    for (let ch = 0; ch < CH_COUNT; ch++) out[ch] = Math.max(out[ch]!, Math.abs(pose[ch]!));
  }
  return out;
}

describe('springs-map: the springs the reaction clips kick', () => {
  it('SPRING has tuft, earL, earR, belly, kerchiefA, kerchiefB, head and nose; #81’s indices are unchanged', () => {
    for (const name of ['tuft', 'earL', 'earR', 'belly', 'kerchiefA', 'kerchiefB', 'head', 'nose'])
      expect(SPRING, name).toHaveProperty(name);
    expect(SPRING).toMatchObject({ headRot: 0, headTilt: 1, earL: 2, earR: 3 });
    const indices = Object.values(SPRING);
    expect(indices.toSorted((a, b) => a - b)).toEqual(Array.from({ length: SPRING_COUNT }, (_, i) => i));
    expect(SPRING_COUNT).toBe(Object.keys(SPRING).length);
  });

  it('each spring has its constants (layers’ for #81’s, lab/rig’s for the secondary ones), underdamped, f ≤ 10 Hz', () => {
    expect(SPRING_PARAMS[SPRING.headRot]).toBe(GAZE_SPRING);
    expect(SPRING_PARAMS[SPRING.headTilt]).toBe(GAZE_SPRING);
    expect(SPRING_PARAMS[SPRING.earL]).toBe(EAR_SPRING);
    expect(SPRING_PARAMS[SPRING.earR]).toBe(EAR_SPRING);
    expect(SPRING_PARAMS[SPRING.tuft]).toEqual({ freqHz: 4, zeta: 0.25 });
    expect(SPRING_PARAMS[SPRING.tuft]).toBe(TUFT_SPRING);
    expect(SPRING_PARAMS[SPRING.belly]).toEqual({ freqHz: 5, zeta: 0.3 });
    expect(SPRING_PARAMS[SPRING.belly]).toBe(BELLY_SPRING);
    expect(SPRING_PARAMS[SPRING.kerchiefA]).toEqual({ freqHz: 2.5, zeta: 0.2 });
    expect(SPRING_PARAMS[SPRING.kerchiefA]).toBe(KERCHIEF_A_SPRING);
    expect(SPRING_PARAMS[SPRING.kerchiefB]).toEqual({ freqHz: 2.8, zeta: 0.2 });
    expect(SPRING_PARAMS[SPRING.kerchiefB]).toBe(KERCHIEF_B_SPRING);
    expect(SPRING_PARAMS[SPRING.head]).toEqual({ freqHz: 3, zeta: 0.3 });
    expect(SPRING_PARAMS[SPRING.head]).toBe(HEAD_SPRING);
    expect(SPRING_PARAMS[SPRING.nose]).toEqual({ freqHz: 6, zeta: 0.4 });
    expect(SPRING_PARAMS[SPRING.nose]).toBe(NOSE_SPRING);
    for (const p of SPRING_PARAMS) {
      expect(p.zeta).toBeLessThan(1);
      expect(p.freqHz).toBeLessThanOrEqual(10);
    }
  });

  it('SPRING_CHANNEL maps each spring to its channel; the secondary springs are the six no layer writes', () => {
    expect(SPRING_CHANNEL).toHaveLength(SPRING_COUNT);
    expect(SPRING_CHANNEL[SPRING.headRot]).toBe(Ch.HeadRot);
    expect(SPRING_CHANNEL[SPRING.headTilt]).toBe(Ch.HeadTilt);
    expect(SPRING_CHANNEL[SPRING.earL]).toBe(Ch.EarRotL);
    expect(SPRING_CHANNEL[SPRING.earR]).toBe(Ch.EarRotR);
    expect(SPRING_CHANNEL[SPRING.tuft]).toBe(Ch.TuftRot);
    expect(SPRING_CHANNEL[SPRING.belly]).toBe(Ch.BellyJiggle);
    expect(SPRING_CHANNEL[SPRING.kerchiefA]).toBe(Ch.KerchiefA);
    expect(SPRING_CHANNEL[SPRING.kerchiefB]).toBe(Ch.KerchiefB);
    expect(SPRING_CHANNEL[SPRING.head]).toBe(Ch.HeadRot);
    expect(SPRING_CHANNEL[SPRING.nose]).toBe(Ch.NoseY);
    expect(SECONDARY_SPRINGS.toSorted((a, b) => a - b)).toEqual(
      [SPRING.tuft, SPRING.belly, SPRING.kerchiefA, SPRING.kerchiefB, SPRING.head, SPRING.nose].toSorted(
        (a, b) => a - b,
      ),
    );
  });
});

describe('REACTION_CLIPS: the set', () => {
  it('has every clip name of the #90 table, both sides of each L/R reaction, and the five gentle variants', () => {
    const expected = [...TABLE, ...SIDED.flatMap((n) => [`${n}L`, `${n}R`]), ...GENTLE];
    expect(Object.keys(REACTION_CLIPS).toSorted()).toEqual(expected.toSorted());
    expect(GENTLE_BASES.map((b) => `${b}Gentle`)).toEqual([...GENTLE]);
  });

  it.each(CLIPS)('%s is named after its key', (name, c) => {
    expect(c.name).toBe(name);
  });

  it('exactly the clips the issue marks sustained are sustained', () => {
    expect(SUSTAINED.map(([name]) => name).toSorted()).toEqual([...SUSTAINED_NAMES].toSorted());
  });

  it('content guard (plan Q3): no clip name is about crying, hurting, pain or fear', () => {
    for (const [name] of CLIPS) expect(name.toLowerCase()).not.toMatch(/cry|hurt|pain|scared|fear/);
  });

  it('only dizzy shows the stars', () => {
    for (const [name, c] of CLIPS) expect(channels(c).includes(Ch.Stars), name).toBe(name === 'dizzy');
  });
});

describe('REACTION_CLIPS: validation 1, keys sorted, duration ≥ the last key, valid channel and spring indices', () => {
  it.each(CLIPS)('%s', (_name, c) => {
    expect(Number.isFinite(c.duration) && c.duration > 0).toBe(true);
    const chs = channels(c);
    expect(new Set(chs).size, 'one track per channel').toBe(chs.length);
    for (const tr of c.tracks) {
      expect(Number.isInteger(tr.ch) && tr.ch >= 0 && tr.ch < CH_COUNT, `channel ${tr.ch}`).toBe(true);
      const ks = tr.keys;
      expect(ks.length, `channel ${tr.ch}`).toBeGreaterThan(0);
      expect(ks[0]!.t, `channel ${tr.ch}`).toBeGreaterThanOrEqual(0);
      for (let i = 1; i < ks.length; i++)
        expect(ks[i]!.t, `channel ${tr.ch} key ${i}`).toBeGreaterThan(ks[i - 1]!.t);
      for (const key of ks) expect(Number.isFinite(key.v), `channel ${tr.ch}`).toBe(true);
      expect(c.duration, `channel ${tr.ch}`).toBeGreaterThanOrEqual(ks.at(-1)!.t);
    }
    for (const imp of c.impulses ?? []) {
      expect(Number.isInteger(imp.spring) && imp.spring >= 0 && imp.spring < SPRING_COUNT).toBe(true);
      expect(imp.t).toBeGreaterThanOrEqual(0);
      expect(imp.t).toBeLessThanOrEqual(c.duration);
      expect(Number.isFinite(imp.dv) && imp.dv !== 0).toBe(true);
    }
  });
});

describe('REACTION_CLIPS: validation 2, back to within 0.02 of neutral at 0 and at the duration', () => {
  it.each(NOT_SUSTAINED)('%s: at 0 and at the duration', (_name, c) => {
    for (const t of [0, c.duration]) {
      const pose = sampleClip(c, t, createPose());
      for (let ch = 0; ch < CH_COUNT; ch++)
        expect(Math.abs(pose[ch]!), `channel ${ch} at ${t}`).toBeLessThanOrEqual(NEUTRAL_TOL);
    }
  });

  it.each(NOT_SUSTAINED)(
    '%s: its spring kicks have rung out (within 0.02 of rest) by the duration',
    (_name, c) => {
      const { pos } = runSprings(c, c.duration);
      for (let i = 0; i < SPRING_COUNT; i++)
        expect(Math.abs(pos[i]!), `spring ${i}`).toBeLessThanOrEqual(NEUTRAL_TOL);
    },
  );

  it.each(SUSTAINED)('%s (sustained): neutral at 0, and holds a pose from the duration on', (_name, c) => {
    const start = sampleClip(c, 0, createPose());
    for (let ch = 0; ch < CH_COUNT; ch++)
      expect(Math.abs(start[ch]!), `channel ${ch}`).toBeLessThanOrEqual(NEUTRAL_TOL);
    const end = Array.from(sampleClip(c, c.duration, createPose()));
    expect(end.some((v) => Math.abs(v) > NEUTRAL_TOL)).toBe(true);
    expect(Array.from(sampleClip(c, c.duration + 10, createPose()))).toEqual(end);
  });
});

describe('REACTION_CLIPS: validation 3, every gentle variant is its base × 0.3 with no stars', () => {
  it.each(GENTLE_BASES)(
    '%sGentle: max |channel| (tracks plus springs) ≤ 0.35 × the base clip’s, per channel, and no Stars',
    (base) => {
      const b = REACTION_CLIPS[base];
      const g = REACTION_CLIPS[`${base}Gentle` as const];
      const bm = maxAbsSeen(b);
      const gm = maxAbsSeen(g);
      expect(Math.max(...bm), 'the base clip moves').toBeGreaterThan(0);
      for (let ch = 0; ch < CH_COUNT; ch++)
        expect(gm[ch], `channel ${ch}`).toBeLessThanOrEqual(GENTLE_MAX_RATIO * bm[ch]!);
      expect(channels(g)).not.toContain(Ch.Stars);
      expect(gm[Ch.Stars]).toBe(0);
    },
  );

  it.each(GENTLE_BASES)('%sGentle: every amplitude is the base’s × 0.3, kicks included', (base) => {
    const b = REACTION_CLIPS[base];
    const g = REACTION_CLIPS[`${base}Gentle` as const];
    expect(GENTLE_SCALE).toBe(0.3);
    expect(g.duration).toBe(b.duration);
    expect(g.sustained).toBe(b.sustained);
    expect(channels(g)).toEqual(channels(b).filter((ch) => ch !== Ch.Stars));
    for (const t of grid(b)) {
      const bp = sampleClip(b, t, createPose());
      const gp = sampleClip(g, t, createPose());
      for (let ch = 0; ch < CH_COUNT; ch++)
        if (ch !== Ch.Stars) expect(gp[ch], `channel ${ch} at ${t}`).toBeCloseTo(GENTLE_SCALE * bp[ch]!, 6);
    }
    expect(g.impulses?.length).toBe(b.impulses?.length);
    (b.impulses ?? []).forEach((imp, i) => {
      const gi = g.impulses![i]!;
      expect([gi.t, gi.spring]).toEqual([imp.t, imp.spring]);
      expect(gi.dv).toBeCloseTo(GENTLE_SCALE * imp.dv, 9);
      expect(Math.abs(gi.dv)).toBeLessThanOrEqual(GENTLE_MAX_RATIO * Math.abs(imp.dv));
    });
  });

  it('the stars check bites: dizzy has stars, dizzyGentle none', () => {
    expect(maxAbs(clip('dizzy'))[Ch.Stars]).toBe(1);
    expect(maxAbs(clip('dizzyGentle'))[Ch.Stars]).toBe(0);
  });
});

describe('REACTION_CLIPS: content (issue #89 "Clips")', () => {
  it('sneeze: 300 ms anticipation (head −5°, nose up, lids 0.5), snap (head −15°, squash −0.1, lids 1 for 80 ms), recovered by 700 ms', () => {
    const c = clip('sneeze');
    expect(c.duration).toBe(0.7);
    expect(at(c, 0.3, Ch.HeadRot)).toBeCloseTo(-5 * DEG, 6);
    expect(at(c, 0.3, Ch.LidL)).toBeCloseTo(0.5, 6);
    expect(at(c, 0.3, Ch.LidR)).toBeCloseTo(0.5, 6);
    expect(at(c, 0.3, Ch.NoseY)).toBeLessThan(0);
    for (const t of [0.34, 0.38, 0.42]) {
      expect(at(c, t, Ch.HeadRot)).toBeCloseTo(-15 * DEG, 6);
      expect(at(c, t, Ch.BodySquash)).toBeCloseTo(-0.1, 6);
      expect(at(c, t, Ch.LidL)).toBe(1);
      expect(at(c, t, Ch.LidR)).toBe(1);
    }
    expect(Math.min(...series(c, Ch.HeadRot))).toBeCloseTo(-15 * DEG, 6);
    expect(c.impulses?.map((i) => i.spring)).toEqual([SPRING.nose]);
  });

  it('bigSneeze: the sneeze × 1.5, capped (head 20°, lids 1), with a double snap', () => {
    const c = clip('bigSneeze');
    const s = clip('sneeze');
    expect(Math.min(...series(c, Ch.HeadRot))).toBeCloseTo(-20 * DEG, 6);
    expect(Math.min(...series(c, Ch.BodySquash))).toBeCloseTo(1.5 * Math.min(...series(s, Ch.BodySquash)), 6);
    expect(Math.max(...series(c, Ch.LidL))).toBe(1);
    expect(at(c, 0.3, Ch.HeadRot)).toBeCloseTo(1.5 * at(s, 0.3, Ch.HeadRot), 6);
    expect(at(c, 0.3, Ch.LidL)).toBeCloseTo(0.75, 6);
    expect(Math.min(...series(c, Ch.NoseY))).toBeCloseTo(1.5 * Math.min(...series(s, Ch.NoseY)), 6);
    // Two snaps: the lids shut (1) in two separate runs, and the nose sniffs twice.
    const shut = series(c, Ch.LidL).map((v) => v === 1);
    const runs = shut.filter((v, i) => v && !shut[i - 1]).length;
    expect(runs).toBe(2);
    expect(c.impulses?.map((i) => i.spring)).toEqual([SPRING.nose, SPRING.nose]);
    expect(c.duration).toBeGreaterThan(s.duration);
  });

  it('noseWrinkle: NoseWrinkle → 1, both irises 6 units toward the nose, sustained', () => {
    const c = clip('noseWrinkle');
    expect(at(c, c.duration, Ch.NoseWrinkle)).toBe(1);
    expect(at(c, c.duration, Ch.IrisY)).toBe(6);
  });

  it('tuftBoing: a tuft kick and a small head bob', () => {
    const c = clip('tuftBoing');
    expect(c.impulses?.map((i) => i.spring)).toEqual([SPRING.tuft]);
    expect(Math.max(...series(c, Ch.HeadY).map(Math.abs))).toBeLessThanOrEqual(5);
    expect(Math.max(...series(c, Ch.HeadY))).toBeGreaterThan(0);
    expect(runSprings(c, c.duration).peak[SPRING.tuft]).toBeGreaterThan(10 * DEG);
  });

  it('headPress: head up 8 units, lids 0.3, sustained', () => {
    const c = clip('headPress');
    expect(at(c, c.duration, Ch.HeadY)).toBe(-8);
    expect(at(c, c.duration, Ch.LidL)).toBeCloseTo(0.3, 6);
    expect(at(c, c.duration, Ch.LidR)).toBeCloseTo(0.3, 6);
  });

  it('pet: lids 0.8, a HeadRot lean ≤ 8°, Blush 0.8, sustained', () => {
    const c = clip('pet');
    expect(at(c, c.duration, Ch.LidL)).toBeCloseTo(0.8, 6);
    expect(at(c, c.duration, Ch.LidR)).toBeCloseTo(0.8, 6);
    expect(at(c, c.duration, Ch.Blush)).toBeCloseTo(0.8, 6);
    const lean = Math.max(...series(c, Ch.HeadRot).map(Math.abs));
    expect(lean).toBeGreaterThan(0);
    expect(lean).toBeLessThanOrEqual(8 * DEG);
  });

  it('againstFur: brows −5, a head shake ±6° three times', () => {
    const c = clip('againstFur');
    expect(Math.min(...series(c, Ch.BrowL))).toBe(-5);
    expect(Math.min(...series(c, Ch.BrowR))).toBe(-5);
    const head = c.tracks.find((tr) => tr.ch === Ch.HeadRot)!.keys.map((key) => key.v);
    expect(head.filter((v) => Math.abs(v - 6 * DEG) < 1e-9)).toHaveLength(3);
    expect(head.filter((v) => Math.abs(v + 6 * DEG) < 1e-9)).toHaveLength(3);
    expect(Math.max(...series(c, Ch.HeadRot).map(Math.abs))).toBeCloseTo(6 * DEG, 6);
  });

  it('wobble: a head-spring kick whose peak is ≤ 12°, with or without reduced motion', () => {
    const c = clip('wobble');
    expect(c.tracks).toHaveLength(0);
    expect(c.impulses?.map((i) => i.spring)).toEqual([SPRING.head]);
    const normal = runSprings(c, c.duration).peak[SPRING.head]!;
    expect(normal).toBeLessThanOrEqual(12 * DEG);
    expect(normal).toBeGreaterThan(8 * DEG);
    expect(runSprings(c, c.duration, 0.9).peak[SPRING.head]).toBeLessThanOrEqual(12 * DEG);
  });

  it('dizzy: Stars 0 → 1 → 0 over 2.5 s, body sway ±5°, then a shake-off with Blush 0.5', () => {
    const c = clip('dizzy');
    expect(at(c, 0, Ch.Stars)).toBe(0);
    expect(at(c, 1.25, Ch.Stars)).toBe(1);
    expect(at(c, 2.5, Ch.Stars)).toBe(0);
    for (const t of [0.1, 1, 2, 2.4]) expect(at(c, t, Ch.Stars), `at ${t}`).toBeGreaterThan(0);
    const sway = series(c, Ch.BodyLean);
    expect(Math.max(...sway)).toBeCloseTo(5 * DEG, 6);
    expect(Math.min(...sway)).toBeCloseTo(-5 * DEG, 6);
    expect(Math.max(...series(c, Ch.Blush))).toBe(0.5);
    for (const t of [0.5, 1.5, 2.4]) expect(at(c, t, Ch.Blush), `at ${t}`).toBe(0);
    const ts = grid(c);
    const shake = series(c, Ch.HeadRot).filter((_, i) => ts[i]! > 2.5);
    expect(Math.max(...shake)).toBeGreaterThan(0);
    expect(Math.min(...shake)).toBeLessThan(0);
  });

  it.each(['L', 'R'] as const)('earFlick%s: an outward kick on that ear and a quick fold', (s) => {
    const c = clip(`earFlick${s}`);
    expect(c.impulses).toHaveLength(1);
    expect(c.impulses![0]!.spring).toBe(s === 'L' ? SPRING.earL : SPRING.earR);
    expect(Math.sign(c.impulses![0]!.dv)).toBe(s === 'L' ? -1 : 1);
    expect(channels(c)).toEqual([s === 'L' ? Ch.EarFoldL : Ch.EarFoldR]);
  });

  it.each(['L', 'R'] as const)('earDroop%s: that ear folds → 1, lids 0.5, sustained', (s) => {
    const c = clip(`earDroop${s}`);
    expect(at(c, c.duration, s === 'L' ? Ch.EarFoldL : Ch.EarFoldR)).toBe(1);
    expect(at(c, c.duration, s === 'L' ? Ch.EarFoldR : Ch.EarFoldL)).toBe(0);
    expect(at(c, c.duration, Ch.LidL)).toBe(0.5);
    expect(at(c, c.duration, Ch.LidR)).toBe(0.5);
  });

  it.each(['L', 'R'] as const)('earFlatten%s: that ear folds 0.6', (s) => {
    const c = clip(`earFlatten${s}`);
    expect(channels(c)).toEqual([s === 'L' ? Ch.EarFoldL : Ch.EarFoldR]);
    expect(Math.max(...series(c, s === 'L' ? Ch.EarFoldL : Ch.EarFoldR))).toBeCloseTo(0.6, 6);
  });

  it.each(['L', 'R'] as const)(
    'hardBlink%s: lids 1 for 150 ms, that paw up 150° beside the face rubbing the squeezed eye, head leaning in, brows −3',
    (s) => {
      const c = clip(`hardBlink${s}`);
      for (const t of [0.05, 0.1, 0.15, 0.2]) {
        expect(at(c, t, Ch.LidL), `at ${t}`).toBe(1);
        expect(at(c, t, Ch.LidR), `at ${t}`).toBe(1);
      }
      // Arms up: ArmRotL +θ, ArmRotR −θ (ORCH-ANSWER on #89); the head rolls toward the raised paw.
      const sign = s === 'L' ? 1 : -1;
      const arm = series(c, s === 'L' ? Ch.ArmRotL : Ch.ArmRotR).map((v) => sign * v);
      expect(Math.max(...arm)).toBeCloseTo(150 * DEG, 6);
      expect(Math.min(...arm)).toBeGreaterThanOrEqual(0);
      const lean = series(c, Ch.HeadRot).map((v) => -sign * v);
      expect(Math.max(...lean)).toBeCloseTo(10 * DEG, 6);
      expect(Math.min(...lean)).toBeGreaterThanOrEqual(0);
      expect(channels(c)).not.toContain(s === 'L' ? Ch.ArmRotR : Ch.ArmRotL);
      // The rubbed eye stays squeezed through the rub; the other one reopens.
      for (const t of [0.3, 0.42, 0.54, 0.66, 0.75]) {
        expect(at(c, t, s === 'L' ? Ch.LidL : Ch.LidR), `at ${t}`).toBeCloseTo(0.7, 6);
        expect(at(c, t, s === 'L' ? Ch.LidR : Ch.LidL), `at ${t}`).toBe(0);
      }
      expect(Math.min(...series(c, Ch.BrowL))).toBe(-3);
    },
  );

  it('hardBlink: at the rub the paw is up beside the face, much closer to the rubbed eye, the same on both sides', () => {
    for (const side of ['L', 'R'] as const) {
      const rest = pawToEye(side, null);
      for (const t of [0.3, 0.54]) expect(pawToEye(side, t), `${side} at ${t}`).toBeLessThan(0.6 * rest);
      // Above the shoulder (both shoulders pivot at y 700), not swung out below it.
      expect(
        posedPivot(sampleClip(clip(`hardBlink${side}`), 0.3, createPose()), `paw${side}`)[1],
      ).toBeLessThan(700);
    }
    expect(pawToEye('L', 0.3)).toBeCloseTo(pawToEye('R', 0.3), 3);
  });

  it('cheekPuffL / cheekPuffR: CheekPuff 0 → 1 → 0, the same motion on both sides', () => {
    const l = clip('cheekPuffL');
    const r = clip('cheekPuffR');
    expect(Math.max(...series(l, Ch.CheekPuff))).toBe(1);
    expect({ ...r, name: 'cheekPuffL' }).toEqual(l);
  });

  it('blush: Blush → 1 for 1.5 s', () => {
    const c = clip('blush');
    const held = grid(c).filter((t) => at(c, t, Ch.Blush) === 1);
    expect(held.at(-1)! - held[0]!).toBeCloseTo(1.5, 6);
  });

  it('squish: HeadSquishX −0.12, HeadSquishY +0.08, MouthRound 1, sustained', () => {
    const c = clip('squish');
    expect(at(c, c.duration, Ch.HeadSquishX)).toBeCloseTo(-0.12, 6);
    expect(at(c, c.duration, Ch.HeadSquishY)).toBeCloseTo(0.08, 6);
    expect(at(c, c.duration, Ch.MouthRound)).toBe(1);
  });

  it('bellyBoing: a BellyJiggle (belly spring) kick and BodySquash −0.06', () => {
    const c = clip('bellyBoing');
    expect(c.impulses?.map((i) => i.spring)).toEqual([SPRING.belly]);
    expect(SPRING_CHANNEL[SPRING.belly]).toBe(Ch.BellyJiggle);
    expect(Math.min(...series(c, Ch.BodySquash))).toBeCloseTo(-0.06, 6);
  });

  it('bellyRub: lids 0.6, sustained', () => {
    const c = clip('bellyRub');
    expect(at(c, c.duration, Ch.LidL)).toBeCloseTo(0.6, 6);
    expect(at(c, c.duration, Ch.LidR)).toBeCloseTo(0.6, 6);
  });

  it('giggle: BodySquash ±0.03 and the jaw 0.4 at 8 Hz for 0.8 s, Blush 0.5', () => {
    const c = clip('giggle');
    expect(c.duration).toBe(0.8);
    const squash = series(c, Ch.BodySquash);
    expect(Math.max(...squash)).toBeCloseTo(0.03, 6);
    expect(Math.min(...squash)).toBeCloseTo(-0.03, 6);
    // 8 Hz: the squash crosses 0 every 1/16 s; the jaw closes every 1/8 s.
    const sz = zeros(c, Ch.BodySquash);
    expect(sz.length).toBeGreaterThanOrEqual(12);
    sz.forEach((t, i) => expect(t).toBeCloseTo((i + 1) / 16, 6));
    expect(Math.max(...series(c, Ch.Jaw))).toBeCloseTo(0.4, 6);
    const jz = zeros(c, Ch.Jaw);
    expect(jz.length).toBeGreaterThanOrEqual(6);
    jz.forEach((t, i) => expect(t).toBeCloseTo((i + 1) / 8, 6));
    expect(Math.max(...series(c, Ch.Blush))).toBe(0.5);
  });

  it('laughFit: the giggle for 2.5 s with a −10° back lean, then a recovery', () => {
    const c = clip('laughFit');
    const g = clip('giggle');
    for (const t of [0.4, 1, 2, 2.5]) expect(at(c, t, Ch.BodyLean), `at ${t}`).toBeCloseTo(-10 * DEG, 6);
    expect(zeros(c, Ch.Jaw)).toHaveLength(20);
    expect(zeros(c, Ch.Jaw).at(-1)).toBeCloseTo(2.5, 6);
    for (const t of [0.03125, 0.0625, 1.21875]) {
      expect(at(c, t, Ch.BodySquash)).toBeCloseTo(at(g, t % 0.75, Ch.BodySquash), 6);
      expect(at(c, t, Ch.Jaw)).toBeCloseTo(at(g, t % 0.75, Ch.Jaw), 6);
    }
    expect(c.duration).toBeGreaterThan(2.5);
  });

  it('hug: both arms 40° inward (ArmRotL −, ArmRotR +), lids 0.7, Blush 1, sustained', () => {
    const c = clip('hug');
    expect(at(c, c.duration, Ch.ArmRotL)).toBeCloseTo(-40 * DEG, 6);
    expect(at(c, c.duration, Ch.ArmRotR)).toBeCloseTo(40 * DEG, 6);
    expect(at(c, c.duration, Ch.LidL)).toBeCloseTo(0.7, 6);
    expect(at(c, c.duration, Ch.LidR)).toBeCloseTo(0.7, 6);
    expect(at(c, c.duration, Ch.Blush)).toBe(1);
  });

  it.each(['L', 'R'] as const)('pawWave%s / highFive%s: that arm up, the other untouched', (s) => {
    const arm = s === 'L' ? Ch.ArmRotL : Ch.ArmRotR;
    const sign = s === 'L' ? 1 : -1;
    const wave = clip(`pawWave${s}`);
    expect(channels(wave)).not.toContain(s === 'L' ? Ch.ArmRotR : Ch.ArmRotL);
    expect(Math.max(...series(wave, arm).map((v) => sign * v))).toBeGreaterThan(30 * DEG);
    const five = clip(`highFive${s}`);
    expect(channels(five)).not.toContain(s === 'L' ? Ch.ArmRotR : Ch.ArmRotL);
    expect(sign * at(five, five.duration, arm)).toBeGreaterThan(30 * DEG);
  });

  it.each(['L', 'R'] as const)('footPull%s: that foot pulls in and comes back', (s) => {
    const c = clip(`footPull${s}`);
    expect(channels(c)).toContain(s === 'L' ? Ch.FootL : Ch.FootR);
    expect(channels(c)).not.toContain(s === 'L' ? Ch.FootR : Ch.FootL);
    expect(Math.min(...series(c, s === 'L' ? Ch.FootL : Ch.FootR))).toBeLessThan(0);
  });

  it('kickGiggle: the giggle with both feet kicking out', () => {
    const c = clip('kickGiggle');
    const g = clip('giggle');
    for (const tr of g.tracks) expect(c.tracks).toContainEqual(tr);
    expect(Math.max(...series(c, Ch.FootL))).toBeGreaterThan(0);
    expect(Math.max(...series(c, Ch.FootR))).toBeGreaterThan(0);
  });

  it('kerchiefAdjust: the arm goes to the knot (inward) and both tails get a kick', () => {
    const c = clip('kerchiefAdjust');
    expect(Math.min(...series(c, Ch.ArmRotL))).toBeLessThan(-45 * DEG);
    expect(c.impulses?.map((i) => i.spring)).toEqual([SPRING.kerchiefA, SPRING.kerchiefB]);
    const { peak } = runSprings(c, c.duration);
    expect(peak[SPRING.kerchiefA]).toBeGreaterThan(5 * DEG);
    expect(peak[SPRING.kerchiefB]).toBeGreaterThan(5 * DEG);
  });
});
