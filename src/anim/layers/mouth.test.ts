import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

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
