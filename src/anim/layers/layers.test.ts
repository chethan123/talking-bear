import { describe, expect, it, vi } from 'vitest';

import { mulberry32 as referenceMulberry32 } from '../../../test/dsp-helpers.ts';
import { Ch, createPose } from '../pose.ts';
import type { Pose } from '../pose.ts';
import { exponential, mulberry32, uniform } from '../rng.ts';
import { SpringBank } from '../springs.ts';
import { SUBSTEP } from '../stepper.ts';
import {
  EAR_SPRING,
  EAR_TWITCH_DV,
  EAR_TWITCH_MAX,
  EAR_TWITCH_MIN,
  EYES_CENTER,
  GAZE_MAX,
  GAZE_SPRING,
  HEAD_FOLLOW,
  HEAD_FULL_ANGLE,
  LOOK_SATURATE,
  SACCADE_MAX,
  SACCADE_MIN,
  createEarTwitch,
  createGaze,
} from './index.ts';
import type { AnimContext, Layer, LayerWeights, LookAt } from './index.ts';

/** The issue's simulation step (#78 Validation): dt = 1/60 s. */
const DT = 1 / 60;

/**
 * The seed of the single-seed statistical tests ("T67"); fixed, so each run replays the same draws. It is
 * central, not lucky: 3.5066 s and 15.47 % doubles, where 171 of seeds 1–200 pass the issue's ±0.1 s mean
 * check (the tolerance is ≈ 1.5 standard errors); the 100-seed pooled test below doesn't depend on it.
 */
const SEED = 0x7467;

/**
 * SpringBank indices of this test's own bank: deliberately scattered, with unused springs 2 and 5, so a layer
 * that ignores its options (or hard-codes an index) is caught.
 */
const IDX = { headRot: 3, headTilt: 1, earL: 4, earR: 0 } as const;
const BANK_SIZE = 6;

function makeBank(): SpringBank {
  const bank = new SpringBank(BANK_SIZE);
  bank.set(IDX.headRot, GAZE_SPRING.freqHz, GAZE_SPRING.zeta);
  bank.set(IDX.headTilt, GAZE_SPRING.freqHz, GAZE_SPRING.zeta);
  bank.set(IDX.earL, EAR_SPRING.freqHz, EAR_SPRING.zeta);
  bank.set(IDX.earR, EAR_SPRING.freqHz, EAR_SPRING.zeta);
  return bank;
}

const FULL: LayerWeights = { blink: 1, breathing: 1, gaze: 1, ears: 1 };

function makeCtx(seed = SEED, weights: LayerWeights = { ...FULL }): AnimContext {
  return { rng: mulberry32(seed), weights, lookAt: null, springs: makeBank() };
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, x) => a + x, 0) / xs.length;
}

function sampleStd(xs: readonly number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}

function diffs(xs: readonly number[]): number[] {
  return xs.slice(1).map((x, i) => x - xs[i]!);
}

/**
 * Steps one layer the way the app's loop does (#81: `springs.step(dt)`, then the layers), `steps` times at
 * `DT`, on a cleared pose. After each step, `each(stepIndex, timeAtEndOfStep, pose)` observes it.
 */
function run(
  layer: Layer,
  ctx: AnimContext,
  steps: number,
  each: (i: number, t: number, pose: Pose) => void,
  pose: Pose = createPose(),
): void {
  for (let i = 0; i < steps; i++) {
    ctx.springs.step(DT);
    pose.fill(0);
    layer.update(DT, pose, ctx);
    each(i, (i + 1) * DT, pose);
  }
}

describe('rng', () => {
  it.each([0, 1, SEED, 2 ** 32 - 1, -1, 2 ** 40 + 3])(
    'mulberry32(%s) matches the reference implementation in test/dsp-helpers.ts',
    (seed) => {
      const a = mulberry32(seed);
      const b = referenceMulberry32(seed);
      for (let i = 0; i < 1000; i++) expect(a()).toBe(b());
    },
  );

  it('mulberry32 stays in [0, 1), repeats per seed and differs across seeds', () => {
    const a = mulberry32(SEED);
    const b = mulberry32(SEED);
    const c = mulberry32(SEED + 1);
    let outside = 0;
    let differ = 0;
    let same = 0;
    let sum = 0;
    for (let i = 0; i < 100_000; i++) {
      const x = a();
      if (!(x >= 0 && x < 1)) outside++;
      if (b() !== x) differ++;
      if (c() === x) same++;
      sum += x;
    }
    expect(outside).toBe(0);
    expect(differ).toBe(0);
    expect(same).toBeLessThan(5);
    expect(Math.abs(sum / 100_000 - 0.5)).toBeLessThan(0.005);
  });

  it('uniform(rng, lo, hi) is lo + (hi − lo)·rng(), on [lo, hi) with mean (lo + hi)/2', () => {
    expect(uniform(() => 0, 1.5, 4)).toBe(1.5);
    expect(uniform(() => 0.5, 1.5, 4)).toBe(2.75);
    const rng = mulberry32(SEED);
    const xs = Array.from({ length: 100_000 }, () => uniform(rng, 6, 15));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(6);
    expect(Math.max(...xs)).toBeLessThan(15);
    expect(Math.abs(mean(xs) - 10.5)).toBeLessThan(0.05);
  });

  it('exponential(rng, mean) is finite and ≥ 0, with the given mean and P(x < mean) = 1 − 1/e', () => {
    expect(exponential(() => 0, 3.5)).toBe(0);
    const last = exponential(() => 1 - 2 ** -32, 3.5);
    expect(last).toBeCloseTo(3.5 * 32 * Math.LN2, 9);
    const rng = mulberry32(SEED);
    const xs = Array.from({ length: 100_000 }, () => exponential(rng, 3.5));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.abs(mean(xs) / 3.5 - 1)).toBeLessThan(0.02);
    expect(Math.abs(sampleStd(xs) / 3.5 - 1)).toBeLessThan(0.03);
    expect(Math.abs(xs.filter((x) => x < 3.5).length / xs.length - (1 - 1 / Math.E))).toBeLessThan(0.01);
  });
});

/** The settled head-follow value the spec asks for: 0.3·(iris/10)·0.12 rad. */
function followOf(iris: number): number {
  return 0.3 * (iris / 10) * 0.12;
}

/** Gaze held still on `lookAt` for 5 s. */
function settle(lookAt: LookAt): { pose: Pose; layer: ReturnType<typeof createGaze> } {
  const layer = createGaze({ headRot: IDX.headRot, headTilt: IDX.headTilt });
  const ctx = makeCtx();
  ctx.lookAt = lookAt;
  const pose = createPose();
  run(layer, ctx, 300, () => undefined, pose);
  return { pose, layer };
}

describe('gaze', () => {
  it('uses the spec constants: iris ≤ 10, follow 30 % of 0.12 rad through f = 2 Hz, ζ = 0.8, saccades U(1.5, 4)', () => {
    expect(GAZE_SPRING).toEqual({ freqHz: 2, zeta: 0.8 });
    expect(GAZE_MAX).toBe(10);
    expect(HEAD_FOLLOW).toBe(0.3);
    expect(HEAD_FULL_ANGLE).toBe(0.12);
    expect(SACCADE_MIN).toBe(1.5);
    expect(SACCADE_MAX).toBe(4);
  });

  describe('random saccades over 10 000 s at dt = 1/60 (seed 0x7467)', () => {
    const layer = createGaze({ headRot: IDX.headRot, headTilt: IDX.headTilt });
    const ctx = makeCtx();
    // The bank's owner configures and steps it (#81): the layer must never call set or step.
    const setSpy = vi.spyOn(ctx.springs, 'set');
    const stepSpy = vi.spyOn(ctx.springs, 'step');
    const onsets: number[] = [];
    const moveSteps: number[] = [];
    /** |iris| settled on each random target (read on the step before the next saccade). */
    const radii: number[] = [];
    let count = 0;
    let skipped = 0;
    let maxIris = 0;
    let maxPoseIris = 0;
    let lastX = 0;
    let lastY = 0;
    let quietSince = 0;
    /** Head-follow ratios on the step before each saccade (1.5 s or more after the previous one). */
    const ratios: number[] = [];
    let prevHead: [number, number, number, number] = [0, 0, 0, 0];
    run(layer, ctx, 600_000, (i, t, pose) => {
      if (layer.count !== count) {
        if (layer.count !== count + 1) skipped++;
        count = layer.count;
        onsets.push(t - layer.sinceSaccade);
        const [rot, tilt, ix, iy] = prevHead;
        if (Math.abs(ix) >= 1) ratios.push(rot / ((ix / 10) * 0.12));
        if (Math.abs(iy) >= 1) ratios.push(tilt / ((iy / 10) * 0.12));
        if (count >= 2) radii.push(Math.hypot(ix, iy));
      }
      const x = pose[Ch.IrisX]!;
      const y = pose[Ch.IrisY]!;
      maxIris = Math.max(maxIris, Math.hypot(layer.irisX, layer.irisY));
      maxPoseIris = Math.max(maxPoseIris, Math.hypot(x, y));
      // A realised saccade: the iris starts moving after a quiet half second.
      const moving = Math.abs(x - lastX) + Math.abs(y - lastY) > 1e-3;
      if (moving && t - quietSince >= 0.5) moveSteps.push(t);
      if (moving) quietSince = t;
      lastX = x;
      lastY = y;
      prevHead = [pose[Ch.HeadRot]!, pose[Ch.HeadTilt]!, x, y];
    });
    const setCalls = setSpy.mock.calls.length;
    const stepCalls = stepSpy.mock.calls.length;
    setSpy.mockRestore();
    stepSpy.mockRestore();
    const intervals = diffs(onsets);

    it('never configures or steps the bank itself', () => {
      expect(setCalls).toBe(0);
      expect(stepCalls).toBe(600_000);
    });

    it('schedules saccades U(1.5, 4) s apart', () => {
      expect(skipped).toBe(0);
      expect(onsets.length).toBeGreaterThan(3000);
      expect(Math.min(...intervals)).toBeGreaterThanOrEqual(1.5 - 1e-9);
      expect(Math.max(...intervals)).toBeLessThanOrEqual(4 + 1e-9);
      // Uniform: spans the range, mean 2.75.
      expect(Math.min(...intervals)).toBeLessThan(1.55);
      expect(Math.max(...intervals)).toBeGreaterThan(3.95);
      expect(Math.abs(mean(intervals) - 2.75)).toBeLessThanOrEqual(0.05);
    });

    it('moves the iris in the pose exactly once per saccade, [1.5, 4] s apart within one step', () => {
      expect(moveSteps).toHaveLength(onsets.length);
      for (const d of diffs(moveSteps)) {
        expect(d).toBeGreaterThanOrEqual(1.5 - DT - 1e-9);
        expect(d).toBeLessThanOrEqual(4 + DT + 1e-9);
      }
    });

    it('keeps |iris| ≤ 10 and uses the whole range', () => {
      expect(maxIris).toBeLessThanOrEqual(10);
      expect(maxPoseIris).toBeLessThanOrEqual(10 + 1e-5);
      expect(maxIris).toBeGreaterThan(9.9);
    });

    it('spreads the saccade targets uniformly over the disc: half of them within 10/√2', () => {
      expect(radii.length).toBeGreaterThan(3000);
      expect(Math.max(...radii)).toBeLessThanOrEqual(10 + 1e-5);
      const inner = radii.filter((r) => r < 10 / Math.SQRT2).length / radii.length;
      expect(Math.abs(inner - 0.5)).toBeLessThanOrEqual(0.03);
    });

    it('has the head settled at 30 % ± 3 % of the follow angle before each saccade', () => {
      expect(ratios.length).toBeGreaterThan(3000);
      for (const r of ratios) {
        expect(r).toBeGreaterThanOrEqual(0.27);
        expect(r).toBeLessThanOrEqual(0.33);
      }
    });

    it('touches only its two springs, and only their targets', () => {
      for (let s = 0; s < BANK_SIZE; s++) {
        if (s === IDX.headRot || s === IDX.headTilt) continue;
        expect([ctx.springs.target[s], ctx.springs.pos[s], ctx.springs.vel[s]]).toEqual([0, 0, 0]);
      }
      expect(ctx.springs.target[IDX.headRot]).toBeCloseTo(followOf(layer.irisX), 7);
      expect(ctx.springs.target[IDX.headTilt]).toBeCloseTo(followOf(layer.irisY), 7);
    });
  });

  it.each<{ name: string; lookAt: LookAt; ux: number; uy: number }>([
    { name: 'far right', lookAt: { x: 1500, y: 385 }, ux: 1, uy: 0 },
    { name: 'far left', lookAt: { x: -500, y: 385 }, ux: -1, uy: 0 },
    { name: 'far down', lookAt: { x: 500, y: 1385 }, ux: 0, uy: 1 },
    { name: 'far up', lookAt: { x: 500, y: -615 }, ux: 0, uy: -1 },
    { name: 'up and right', lookAt: { x: 800, y: -15 }, ux: 0.6, uy: -0.8 },
  ])(
    'with lookAt $name, turns the iris fully toward it and settles the head at 0.3 ± 0.03 of the follow',
    ({ lookAt, ux, uy }) => {
      const { pose, layer } = settle(lookAt);
      const x = pose[Ch.IrisX]!;
      const y = pose[Ch.IrisY]!;
      expect(x).toBeCloseTo(10 * ux, 4);
      expect(y).toBeCloseTo(10 * uy, 4);
      expect(Math.hypot(layer.irisX, layer.irisY)).toBeLessThanOrEqual(10);
      if (ux !== 0) {
        const r = pose[Ch.HeadRot]! / ((x / 10) * 0.12);
        expect(r).toBeGreaterThanOrEqual(0.27);
        expect(r).toBeLessThanOrEqual(0.33);
      } else {
        expect(Math.abs(pose[Ch.HeadRot]!)).toBeLessThan(1e-6);
      }
      if (uy !== 0) {
        const r = pose[Ch.HeadTilt]! / ((y / 10) * 0.12);
        expect(r).toBeGreaterThanOrEqual(0.27);
        expect(r).toBeLessThanOrEqual(0.33);
      } else {
        expect(Math.abs(pose[Ch.HeadTilt]!)).toBeLessThan(1e-6);
      }
      // Signs: rotations are clockwise-positive on screen, y down.
      expect(Math.sign(pose[Ch.HeadRot]!)).toBe(Math.sign(Math.round(ux * 10)));
      expect(Math.sign(pose[Ch.HeadTilt]!)).toBe(Math.sign(Math.round(uy * 10)));
    },
  );

  it('scales the iris with the distance inside LOOK_SATURATE, and looks straight at the eyes centre', () => {
    const near = settle({ x: EYES_CENTER.x + 0.3 * LOOK_SATURATE, y: EYES_CENTER.y + 0.4 * LOOK_SATURATE });
    expect(near.pose[Ch.IrisX]).toBeCloseTo(0.3 * 10, 4);
    expect(near.pose[Ch.IrisY]).toBeCloseTo(0.4 * 10, 4);
    const centre = settle({ x: EYES_CENTER.x, y: EYES_CENTER.y });
    expect(centre.pose[Ch.IrisX]).toBe(0);
    expect(centre.pose[Ch.IrisY]).toBe(0);
    expect(centre.pose[Ch.HeadRot]).toBe(0);
  });

  it('rejects bad spring indices', () => {
    expect(() => createGaze({ headRot: -1, headTilt: 0 })).toThrow(RangeError);
    expect(() => createGaze({ headRot: 0, headTilt: 1.5 })).toThrow(RangeError);
    const layer = createGaze({ headRot: 0, headTilt: BANK_SIZE });
    expect(() => layer.update(DT, createPose(), makeCtx())).toThrow(RangeError);
  });
});

describe('ear twitch', () => {
  it('uses the spec constants: one twitch per U(6, 15) s through f = 6 Hz, ζ = 0.35 springs', () => {
    expect(EAR_SPRING).toEqual({ freqHz: 6, zeta: 0.35 });
    expect(EAR_TWITCH_MIN).toBe(6);
    expect(EAR_TWITCH_MAX).toBe(15);
  });

  it('flicks an ear from rest to 12° ± 0.5 (the #77 earTwitch swing) with EAR_TWITCH_DV at SUBSTEP', () => {
    const bank = new SpringBank(1);
    bank.set(0, EAR_SPRING.freqHz, EAR_SPRING.zeta);
    bank.impulse(0, EAR_TWITCH_DV);
    let peak = 0;
    for (let i = 0; i < 0.3 / SUBSTEP; i++) {
      bank.step(SUBSTEP);
      peak = Math.max(peak, bank.pos[0]!);
    }
    expect(Math.abs(peak * (180 / Math.PI) - 12)).toBeLessThanOrEqual(0.5);
  });

  describe('over 10 000 s at dt = 1/60 (seed 0x7467)', () => {
    const layer = createEarTwitch({ earL: IDX.earL, earR: IDX.earR });
    const ctx = makeCtx();
    const { springs } = ctx;
    const setSpy = vi.spyOn(springs, 'set');
    const stepSpy = vi.spyOn(springs, 'step');
    const onsets: number[] = [];
    /** Every step in which an ear spring's velocity jumped: its time and the two jumps. */
    const kicks: { t: number; right: boolean; dL: number; dR: number }[] = [];
    let count = 0;
    let skipped = 0;
    let poseMatches = true;
    /** Sign of the first swing after each kick: +1 clockwise, −1 counter-clockwise. */
    const firstSwing: { right: boolean; sign: number }[] = [];
    const pose = createPose();
    for (let i = 0; i < 600_000; i++) {
      const t = (i + 1) * DT;
      springs.step(DT);
      const vL = springs.vel[IDX.earL]!;
      const vR = springs.vel[IDX.earR]!;
      pose.fill(0);
      layer.update(DT, pose, ctx);
      const dL = springs.vel[IDX.earL]! - vL;
      const dR = springs.vel[IDX.earR]! - vR;
      if (dL !== 0 || dR !== 0) kicks.push({ t, right: dR !== 0, dL, dR });
      if (layer.count !== count) {
        if (layer.count !== count + 1) skipped++;
        count = layer.count;
        onsets.push(t - layer.sinceTwitch);
      }
      if (pose[Ch.EarRotL] !== springs.pos[IDX.earL] || pose[Ch.EarRotR] !== springs.pos[IDX.earR]) {
        poseMatches = false;
      }
      const last = kicks.at(-1);
      if (last !== undefined && firstSwing.length < kicks.length && t - last.t >= 0.05) {
        firstSwing.push({ right: last.right, sign: Math.sign(pose[last.right ? Ch.EarRotR : Ch.EarRotL]!) });
      }
    }
    const setCalls = setSpy.mock.calls.length;
    const stepCalls = stepSpy.mock.calls.length;
    setSpy.mockRestore();
    stepSpy.mockRestore();
    const intervals = diffs(onsets);

    it('never configures or steps the bank itself', () => {
      expect(setCalls).toBe(0);
      expect(stepCalls).toBe(600_000);
    });

    it('schedules twitches U(6, 15) s apart', () => {
      expect(skipped).toBe(0);
      expect(onsets.length).toBeGreaterThan(800);
      expect(Math.min(...intervals)).toBeGreaterThanOrEqual(6 - 1e-9);
      expect(Math.max(...intervals)).toBeLessThanOrEqual(15 + 1e-9);
      expect(Math.min(...intervals)).toBeLessThan(6.2);
      expect(Math.max(...intervals)).toBeGreaterThan(14.8);
      expect(Math.abs(mean(intervals) - 10.5)).toBeLessThanOrEqual(0.3);
    });

    it('kicks exactly one ear spring per twitch, by EAR_TWITCH_DV outward, [6, 15] s apart within one step', () => {
      expect(kicks).toHaveLength(onsets.length);
      for (const k of kicks) {
        expect(k.right ? k.dL : k.dR).toBe(0);
        if (k.right) expect(k.dR).toBeCloseTo(EAR_TWITCH_DV, 4);
        else expect(k.dL).toBeCloseTo(-EAR_TWITCH_DV, 4);
      }
      for (const d of diffs(kicks.map((k) => k.t))) {
        expect(d).toBeGreaterThanOrEqual(6 - DT - 1e-9);
        expect(d).toBeLessThanOrEqual(15 + DT + 1e-9);
      }
      const right = kicks.filter((k) => k.right).length;
      expect(right).toBe(layer.right);
      expect(Math.abs(right / kicks.length - 0.5)).toBeLessThanOrEqual(0.05);
    });

    it('flicks each ear outward: right ear clockwise (+), left ear counter-clockwise (−)', () => {
      expect(firstSwing).toHaveLength(kicks.length);
      for (const s of firstSwing) expect(s.sign).toBe(s.right ? 1 : -1);
    });

    it('adds the springs’ positions to EarRotL/EarRotR, and leaves every other spring alone', () => {
      expect(poseMatches).toBe(true);
      for (let s = 0; s < BANK_SIZE; s++) {
        expect(springs.target[s]).toBe(0);
        if (s !== IDX.earL && s !== IDX.earR) expect([springs.pos[s], springs.vel[s]]).toEqual([0, 0]);
      }
    });
  });

  it('rejects bad spring indices', () => {
    expect(() => createEarTwitch({ earL: -1, earR: 0 })).toThrow(RangeError);
    expect(() => createEarTwitch({ earL: 0, earR: Number.NaN })).toThrow(RangeError);
    const layer = createEarTwitch({ earL: BANK_SIZE, earR: 0 });
    expect(() => layer.update(DT, createPose(), makeCtx())).toThrow(RangeError);
  });
});
