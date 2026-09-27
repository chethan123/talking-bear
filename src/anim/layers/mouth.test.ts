import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { outputContextTimeNow } from '../../audio/output-clock.ts';
import type { OutputClockCtx } from '../../audio/output-clock.ts';
import type { Envelope } from '../../dsp/types.ts';
import { DISPLAY_LATENCY_MS } from '../constants.ts';
import { CH_COUNT, Ch, createPose } from '../pose.ts';
import type { Pose } from '../pose.ts';
import {
  BROW_LIFT,
  BROW_TAU,
  BROW_THRESHOLD,
  HEAD_BOB,
  HEAD_BOB_RATE,
  HEAD_BOB_WINDOW,
  MouthLayer,
  envelopeIndex,
  mouthFromEnvelope,
} from './mouth.ts';

/** The mouth channels, which only the mouth layer writes. */
const MOUTH = [Ch.Jaw, Ch.MouthW, Ch.MouthRound, Ch.Teeth] as const;
/** The channels the layer adds to. */
const ADDED = [Ch.HeadY, Ch.BrowL, Ch.BrowR] as const;

/** A `performance.now()` stand-in that always reads 1000 ms. */
const now1000 = (): number => 1000;

interface Tracks {
  jaw: readonly number[];
  width?: readonly number[];
  round?: readonly number[];
  teeth?: readonly number[];
}

/** An envelope from plain arrays; missing tracks are all 0.25 (so they differ from the 0 outside the clip). */
function makeEnv(tracks: Tracks): Envelope {
  const len = tracks.jaw.length;
  const track = (v: readonly number[] | undefined): Float32Array =>
    v === undefined ? new Float32Array(len).fill(0.25) : Float32Array.from(v);
  return {
    hopMs: 10,
    jaw: Float32Array.from(tracks.jaw),
    width: track(tracks.width),
    round: track(tracks.round),
    teeth: track(tracks.teeth),
  };
}

/** An envelope of `len` frames whose tracks are all 0.5. */
function flatEnv(len: number): Envelope {
  return makeEnv({ jaw: Array.from({ length: len }, () => 0.5) });
}

/** A pose whose every channel is `v`. */
function filledPose(v: number): Pose {
  return createPose().fill(v);
}

/**
 * A fake output clock whose output context time is set directly: its timestamp pairs `contextTime` with
 * performanceTime 1000 ms, and `now()` returns 1000, so outputContextTimeNow = contextTime exactly.
 */
interface FakeClock {
  ctx: OutputClockCtx;
  now: () => number;
  set(outputCtxTime: number): void;
}

function fakeClock(outputCtxTime: number): FakeClock {
  const ts = { contextTime: outputCtxTime, performanceTime: 1000 };
  const ctx: OutputClockCtx = {
    currentTime: outputCtxTime + 0.1,
    outputLatency: 0.02,
    getOutputTimestamp: () => ts,
  };
  return {
    ctx,
    now: now1000,
    set(t: number): void {
      ts.contextTime = t;
    },
  };
}

/** A layer sampling `env` (start at context time 100) at clip time t, with L = 0 so t is the sample time. */
function layerAt(env: Envelope): { layer: MouthLayer; sample: (t: number, pose?: Pose) => Pose } {
  const clock = fakeClock(0);
  const layer = new MouthLayer(0);
  layer.setClip(env, 100);
  return {
    layer,
    sample: (t: number, pose: Pose = createPose()): Pose => {
      clock.set(100 + t);
      layer.update(pose, clock.ctx, clock.now);
      return pose;
    },
  };
}

// Expected values below are written with the issue's numbers as literals (−6, /20, 0.030, 0.8, +5, 0.150),
// never with the exported constants, so a wrong constant fails the behaviour tests too.
describe('constants', () => {
  it('L starts at 40 ms, and a layer uses it by default', () => {
    expect(DISPLAY_LATENCY_MS).toBe(40);
    expect(new MouthLayer().latencyMs).toBe(40);
  });

  it('pins every exported constant to the issue', () => {
    expect(HEAD_BOB).toBe(6);
    expect(HEAD_BOB_RATE).toBe(20);
    expect(HEAD_BOB_WINDOW).toBe(0.03);
    expect(BROW_THRESHOLD).toBe(0.8);
    expect(BROW_LIFT).toBe(5);
    expect(BROW_TAU).toBe(0.15);
  });
});

describe('envelopeIndex (Validation 1)', () => {
  const env = flatEnv(20);

  it('t = 0 → 0; t = 0.0149 → 1', () => {
    expect(envelopeIndex(env, 0)).toBe(0);
    expect(envelopeIndex(env, 0.0149)).toBe(1);
  });

  it('is −1 below 0, at the end, after it, and for NaN', () => {
    for (const t of [-1e-9, -0.001, -0.0149, -1, Number.NEGATIVE_INFINITY])
      expect(envelopeIndex(env, t)).toBe(-1);
    for (const t of [0.2, 0.2 + 1e-9, 0.25, 10, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(envelopeIndex(env, t)).toBe(-1);
    }
    expect(envelopeIndex(flatEnv(0), 0)).toBe(-1);
  });

  it('is floor(t / 0.010) on the grid, with frame times written as i·0.01 or i/100 landing on frame i', () => {
    for (let len = 1; len <= 600; len++) {
      const e = flatEnv(len);
      expect(envelopeIndex(e, len * 0.01)).toBe(-1);
      expect(envelopeIndex(e, len / 100)).toBe(-1);
      expect(envelopeIndex(e, (len - 0.5) * 0.01)).toBe(len - 1);
      expect(envelopeIndex(e, len * 0.01 - 1e-7)).toBe(len - 1);
    }
    const e = flatEnv(600);
    for (let i = 0; i < 600; i++) {
      expect(envelopeIndex(e, i * 0.01)).toBe(i);
      expect(envelopeIndex(e, i / 100)).toBe(i);
      expect(envelopeIndex(e, (i + 0.5) * 0.01)).toBe(i);
      expect(envelopeIndex(e, (i + 0.999) * 0.01)).toBe(i);
    }
  });

  it('reads a ctx-time difference that should be a frame time as that frame', () => {
    expect(10.0 - 9.9 + 0.04).not.toBe(0.14);
    expect(envelopeIndex(env, 10.0 - 9.9 + 0.04)).toBe(14);
  });
});

describe('mouthFromEnvelope (Validation 3)', () => {
  /** Jaw ramp 0 → 1 over 100 ms (frames 0…10), then held at 1. */
  const RAMP = makeEnv({ jaw: Array.from({ length: 15 }, (_, i) => Math.min(1, i / 10)) });

  it('a jaw ramp 0 → 1 over 100 ms gives a monotone Jaw that interpolates between frames', () => {
    const jaws: number[] = [];
    const out = createPose();
    for (let j = 0; j <= 200; j++) jaws.push(mouthFromEnvelope(RAMP, j * 0.0005, out)[Ch.Jaw]!);
    for (let j = 1; j < jaws.length; j++) expect(jaws[j]!).toBeGreaterThanOrEqual(jaws[j - 1]!);
    expect(jaws[0]).toBe(0);
    expect(jaws[200]).toBe(1);
    // Linear between frame centres, so it rises strictly inside every frame of the ramp, not in steps.
    for (let k = 0; k < 10; k++) {
      expect(jaws[20 * k + 10]!).toBeCloseTo((k + 0.5) / 10, 6);
      expect(jaws[20 * k + 10]!).toBeGreaterThan(jaws[20 * k]!);
      expect(jaws[20 * k + 20]!).toBeGreaterThan(jaws[20 * k + 10]!);
    }
  });

  it('width, round, jaw and teeth pass through exactly at frame centres', () => {
    const unit = fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 80 }).chain((len) =>
          fc.record({
            jaw: fc.array(unit, { minLength: len, maxLength: len }),
            width: fc.array(unit, { minLength: len, maxLength: len }),
            round: fc.array(unit, { minLength: len, maxLength: len }),
            teeth: fc.array(unit, { minLength: len, maxLength: len }),
          }),
        ),
        (tracks) => {
          const env = makeEnv(tracks);
          const out = createPose();
          for (let i = 0; i < env.jaw.length; i++) {
            for (const t of [i * 0.01, i / 100]) {
              mouthFromEnvelope(env, t, out);
              expect(out[Ch.MouthW]).toBe(env.width[i]);
              expect(out[Ch.MouthRound]).toBe(env.round[i]);
              expect(out[Ch.Jaw]).toBe(env.jaw[i]);
              expect(out[Ch.Teeth]).toBe(env.teeth[i]);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('holds the last frame through the last partial frame, then reads 0', () => {
    const env = makeEnv({ jaw: [0.2, 0.4, 0.6], width: [0.1, 0.3, 0.9], round: [0.5, 0.7, 0.2] });
    const out = createPose();
    for (const t of [0.02, 0.025, 0.0299999]) {
      mouthFromEnvelope(env, t, out);
      expect(out[Ch.Jaw]).toBe(env.jaw[2]);
      expect(out[Ch.MouthW]).toBe(env.width[2]);
      expect(out[Ch.MouthRound]).toBe(env.round[2]);
    }
    mouthFromEnvelope(env, 0.015, out);
    expect(out[Ch.MouthW]).toBeCloseTo(0.6, 6);
  });

  it('writes 0 to the mouth channels outside the clip, touches no other channel and returns out', () => {
    const env = makeEnv({ jaw: [0.5, 0.6, 0.7] });
    for (const t of [-0.001, 0.03, 0.03 + 1e-6, 1, Number.NaN]) {
      const out = filledPose(7);
      expect(mouthFromEnvelope(env, t, out)).toBe(out);
      for (let c = 0; c < CH_COUNT; c++)
        expect(out[c]).toBe((MOUTH as readonly number[]).includes(c) ? 0 : 7);
    }
    const out = filledPose(7);
    mouthFromEnvelope(env, 0.01, out);
    for (let c = 0; c < CH_COUNT; c++) if (!(MOUTH as readonly number[]).includes(c)) expect(out[c]).toBe(7);
  });

  it('maps Teeth = teeth as the issue says, also while the jaw is 0 (hiss in a pause)', () => {
    const env = makeEnv({ jaw: [0, 0, 0.3], teeth: [0.85, 0.85, 0.5] });
    const out = createPose();
    expect(mouthFromEnvelope(env, 0, out)[Ch.Teeth]).toBe(Math.fround(0.85));
    expect(out[Ch.Jaw]).toBe(0);
    expect(mouthFromEnvelope(env, 0.015, out)[Ch.Teeth]).toBeCloseTo(0.675, 6);
    expect(mouthFromEnvelope(env, 0.02, out)[Ch.Teeth]).toBe(Math.fround(0.5));
  });
});

describe('MouthLayer sync (Validation 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Frame i has width i/64 and jaw (i mod 7)/7: every frame is distinguishable. */
  const ENV = makeEnv({
    jaw: Array.from({ length: 40 }, (_, i) => (i % 7) / 7),
    width: Array.from({ length: 40 }, (_, i) => i / 64),
  });

  function expectFrame14(layer: MouthLayer, pose: Pose): void {
    expect(layer.envIndex).toBe(14);
    expect(layer.clipTime).toBeCloseTo(0.14, 12);
    expect(pose[Ch.MouthW]).toBe(ENV.width[14]);
    expect(pose[Ch.Jaw]).toBe(ENV.jaw[14]);
  }

  it('output time 10.0, start 9.9, L = 40 ms → samples t = 0.14 s (index 14)', () => {
    const clock = fakeClock(10.0);
    expect(outputContextTimeNow(clock.ctx, clock.now)).toBe(10.0);
    const layer = new MouthLayer();
    layer.setClip(ENV, 9.9);
    const pose = createPose();
    layer.update(pose, clock.ctx, clock.now);
    expectFrame14(layer, pose);
  });

  it('the same through the fallback clock (no timestamp yet: currentTime − outputLatency)', () => {
    const ctx: OutputClockCtx = {
      currentTime: 10.0,
      outputLatency: 0,
      getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
    };
    expect(outputContextTimeNow(ctx, () => 5)).toBe(10.0);
    const layer = new MouthLayer();
    layer.setClip(ENV, 9.9);
    const pose = createPose();
    layer.update(pose, ctx, () => 5);
    expectFrame14(layer, pose);
  });

  it('without `now`, extrapolates with performance.now()', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const clock = fakeClock(10.0);
    const layer = new MouthLayer();
    layer.setClip(ENV, 9.9);
    const pose = createPose();
    layer.update(pose, clock.ctx);
    expectFrame14(layer, pose);
  });

  it('applies L (negative control: L = 0 samples index 10; L = 100 ms samples index 20)', () => {
    const clock = fakeClock(10.0);
    for (const [l, index] of [
      [0, 10],
      [100, 20],
    ] as const) {
      const layer = new MouthLayer(l);
      layer.setClip(ENV, 9.9);
      layer.update(createPose(), clock.ctx, clock.now);
      expect(layer.envIndex).toBe(index);
    }
  });

  it('reports no sample before the first update and without a clip', () => {
    const layer = new MouthLayer();
    expect(layer.envIndex).toBe(-1);
    expect(layer.clipTime).toBeNaN();
    layer.setClip(ENV, 9.9);
    expect(layer.clipTime).toBeNaN();
    layer.update(createPose(), fakeClock(9.0).ctx, () => 1000);
    expect(layer.envIndex).toBe(-1);
    expect(layer.clipTime).toBeCloseTo(-0.86, 12);
  });
});

describe('MouthLayer channels', () => {
  it('sets the mouth channels, adds only to HeadY and the brows, and leaves every other channel alone', () => {
    const { sample } = layerAt(makeEnv({ jaw: [0, 0.2, 0.9, 0.9, 0.3], teeth: [0, 0, 0, 0.5, 0.5] }));
    for (const t of [-0.05, 0, 0.015, 0.025, 0.04, 0.2]) {
      const pose = sample(t, filledPose(3));
      for (let c = 0; c < CH_COUNT; c++) {
        if (!(MOUTH as readonly number[]).includes(c) && !(ADDED as readonly number[]).includes(c)) {
          expect(pose[c]).toBe(3);
        }
      }
    }
  });

  it('writes 0 to the mouth channels outside the clip', () => {
    const { sample } = layerAt(makeEnv({ jaw: [0.5, 0.6, 0.7] }));
    for (const t of [-0.001, 0.03, 0.5]) {
      const pose = sample(t, filledPose(0.5));
      for (const c of MOUTH) expect(pose[c]).toBe(0);
    }
  });

  it('setClip(null) (and no clip yet) closes the mouth and adds nothing', () => {
    const layer = new MouthLayer(0);
    const clock = fakeClock(100.02);
    const pose = filledPose(0.5);
    layer.update(pose, clock.ctx, clock.now);
    for (const c of MOUTH) expect(pose[c]).toBe(0);
    for (const c of ADDED) expect(pose[c]).toBe(0.5);

    layer.setClip(makeEnv({ jaw: [0.9, 0.9, 0.9, 0.9] }), 100);
    layer.update(filledPose(0.5), clock.ctx, clock.now);
    expect(layer.envIndex).toBe(2);
    layer.setClip(null, 0);
    const after = filledPose(0.5);
    layer.update(after, clock.ctx, clock.now);
    for (const c of MOUTH) expect(after[c]).toBe(0);
    for (const c of ADDED) expect(after[c]).toBe(0.5);
    expect(layer.envIndex).toBe(-1);
    expect(layer.clipTime).toBeNaN();
  });
});

describe('MouthLayer head bob', () => {
  /** Jaw 0 → 1 over 100 ms (10 per second), held for 100 ms, then 1 → 0 over 100 ms. */
  const TRAP = makeEnv({
    jaw: [
      ...Array.from({ length: 11 }, (_, i) => i / 10),
      ...Array(10).fill(1),
      ...Array.from({ length: 11 }, (_, i) => 1 - i / 10),
    ],
  });

  it('HeadY += −6 · clamp(d(jaw)/dt / 20, −1, 1), with the derivative over the last 30 ms', () => {
    const { sample } = layerAt(TRAP);
    expect(sample(0.05)[Ch.HeadY]).toBeCloseTo(-3, 5); // rising 10 per second: −6 · 10/20
    expect(sample(0.15)[Ch.HeadY]).toBeCloseTo(0, 6); // flat
    expect(sample(0.25)[Ch.HeadY]).toBeCloseTo(3, 5); // falling 10 per second
    // Window straddling the top of the ramp: jaw(0.12) = 1, jaw(0.09) = 0.9, so 0.1 / 0.030 per second.
    expect(sample(0.12)[Ch.HeadY]).toBeCloseTo((-6 * (0.1 / 0.03)) / 20, 5);
  });

  it('clamps at ±6 and adds to the HeadY already in the pose', () => {
    const { sample } = layerAt(makeEnv({ jaw: [0, 0.5, 1, 1, 1, 1, 0.5, 0, 0, 0] }));
    expect(sample(0.02, filledPose(2))[Ch.HeadY]).toBe(2 - 6); // 50 per second: clamped
    expect(sample(0.07, filledPose(2))[Ch.HeadY]).toBe(2 + 6);
    expect(sample(0.05, filledPose(2))[Ch.HeadY]).toBe(2); // jaw(0.05) = jaw(0.02) = 1
  });

  it('reads the jaw as 0 outside the clip: a bob as the clip starts and ends, none beyond', () => {
    // Jaw 0.3 for 100 ms: 0.3 over the 30 ms window is 10 per second, half the full rate.
    const { sample } = layerAt(makeEnv({ jaw: Array(10).fill(0.3) }));
    const half = 6 * Math.min(1, 0.3 / 0.03 / 20); // 3
    expect(sample(-0.01)[Ch.HeadY]).toBe(0);
    expect(sample(0.01)[Ch.HeadY]).toBeCloseTo(-half, 5); // jaw(−0.02) = 0
    expect(sample(0.05)[Ch.HeadY]).toBe(0);
    expect(sample(0.11)[Ch.HeadY]).toBeCloseTo(half, 5); // jaw(0.11) = 0, jaw(0.08) = 0.3
    expect(sample(0.13)[Ch.HeadY]).toBe(0);
    expect(sample(0.5)[Ch.HeadY]).toBe(0);
  });
});

describe('MouthLayer brow impulse (Validation 4)', () => {
  /**
   * Jaw with three upward crossings of 0.8 (frames 2→3, 12→13 and 26→27, the last one reaching exactly
   * fround(0.8)), three downward ones (5→6, 17→18, 28→29), a near miss (20→21: 0.4 → 0.79) and a stretch that
   * dips while staying above 0.8 (13…16). Crossings are ≥ 100 ms apart.
   */
  const JAW = [
    0, 0.3, 0.6, 0.9, 0.95, 0.9, 0.7, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.85, 0.9, 0.82, 0.81, 0.6, 0.4, 0.4, 0.4,
    0.79, 0.79, 0.5, 0.5, 0.5, 0.5, 0.8, 0.8, 0.5, 0.2, 0, 0, 0,
  ];
  const ENV = makeEnv({ jaw: JAW });
  /** Exact crossing times on the interpolated (float32) jaw track. */
  const UP: number[] = [];
  const DOWN: number[] = [];
  for (let s = 0; s + 1 < ENV.jaw.length; s++) {
    const j0 = ENV.jaw[s]!;
    const j1 = ENV.jaw[s + 1]!;
    const xc = s + (0.8 - j0) / (j1 - j0);
    if (j0 < 0.8 && j1 >= 0.8) UP.push(xc * 0.01);
    if (j0 >= 0.8 && j1 < 0.8) DOWN.push(xc * 0.01);
  }
  /** The brow lift the spec asks for at clip time t: one +5 impulse per upward crossing at or before t. */
  const expected = (t: number): number =>
    UP.reduce((sum, tc) => (tc <= t ? sum + 5 * Math.exp(-(t - tc) / 0.15) : sum), 0);

  it('the fixture has three upward and three downward crossings', () => {
    expect(UP).toHaveLength(3);
    expect(DOWN).toHaveLength(3);
  });

  it('fires once per upward crossing, at the crossing, and never on a downward one (1 ms frames)', () => {
    const { sample } = layerAt(ENV);
    const fires: number[] = [];
    let prev = 0;
    for (let j = -50; j <= 800; j++) {
      const t = j * 0.001;
      const pose = sample(t);
      const brow = pose[Ch.BrowL]!;
      expect(pose[Ch.BrowR]).toBe(brow);
      if (brow > prev + 1) fires.push(t);
      prev = brow;
    }
    expect(fires).toHaveLength(UP.length);
    fires.forEach((t, i) => {
      expect(t).toBeGreaterThanOrEqual(UP[i]! - 1e-12);
      expect(t).toBeLessThan(UP[i]! + 0.001);
    });
  });

  it('matches one +5 impulse (τ 150 ms) per upward crossing for any frame times', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.001, max: 0.05, noNaN: true }), { minLength: 40, maxLength: 60 }),
        (steps) => {
          const { sample } = layerAt(ENV);
          let t = -0.02;
          for (const dt of steps) {
            t += dt;
            const pose = sample(t);
            expect(pose[Ch.BrowL]).toBeCloseTo(expected(t), 5);
            expect(pose[Ch.BrowR]).toBeCloseTo(expected(t), 5);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('decays with τ = 150 ms and adds to the brows already in the pose', () => {
    // One crossing, at frame 1 + (0.8 − 0.5) / 0.5 = 1.6.
    const env = makeEnv({ jaw: [0, 0.5, ...Array(30).fill(1)] });
    const tc = (1 + (0.8 - 0.5) / 0.5) * 0.01;
    const { sample } = layerAt(env);
    const pose = createPose();
    pose[Ch.BrowL] = 6;
    pose[Ch.BrowR] = -1;
    sample(tc + 0.15, pose);
    expect(pose[Ch.BrowL]).toBeCloseTo(6 + 5 / Math.E, 5);
    expect(pose[Ch.BrowR]).toBeCloseTo(-1 + 5 / Math.E, 5);
  });

  it('does not fire again when the clock steps back across a crossing', () => {
    const { sample } = layerAt(ENV);
    const tc = UP[0]!;
    let fires = 0;
    let prev = 0;
    for (const t of [tc - 0.004, tc + 0.002, tc - 0.003, tc + 0.001, tc + 0.004, tc + 0.02]) {
      const brow = sample(t)[Ch.BrowL]!;
      if (brow > prev + 1) fires++;
      prev = brow;
    }
    expect(fires).toBe(1);
  });

  it('a first frame at or above 0.8 crosses at t = 0; setClip resets the lift', () => {
    const { layer, sample } = layerAt(makeEnv({ jaw: [0.9, 0.9, 0.9, 0.9] }));
    expect(sample(-0.01)[Ch.BrowL]).toBe(0);
    expect(sample(0.02)[Ch.BrowL]).toBeCloseTo(5 * Math.exp(-0.02 / 0.15), 5);
    layer.setClip(makeEnv({ jaw: [0.5, 0.5, 0.5, 0.5] }), 100);
    expect(sample(0.02)[Ch.BrowL]).toBe(0);
  });
});
