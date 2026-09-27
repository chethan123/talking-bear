/**
 * The key-pose gallery: the poses the renderer screenshot test draws (issue #75) and the full-app screenshots
 * reuse (#81). Each is `createPose()` plus a few channel values; units follow `pose.ts` (rotations in radians,
 * clockwise-positive on screen).
 *
 * The poses are shared and **read-only by convention** (a non-empty typed array can't be frozen): never write
 * into them. `listening` and `asleep` copy the director's base poses (`src/anim/base-poses.ts`) as separate
 * instances, so the gallery and the director never share a buffer.
 */
import { Ch, createPose } from './pose.ts';
import type { Pose } from './pose.ts';

const DEG = Math.PI / 180;

export type PoseName =
  'neutral' | 'blink' | 'listening' | 'talkOpen' | 'talkRound' | 'asleep' | 'squish' | 'dizzy';

/** A new pose with the given channel values and every other channel neutral (0). */
function pose(values: readonly (readonly [ch: number, v: number])[]): Pose {
  const p = createPose();
  for (const [ch, v] of values) p[ch] = v;
  return p;
}

export const POSES: Record<PoseName, Pose> = {
  /** Every channel 0: eyes open, mouth shut. */
  neutral: createPose(),
  /** Both upper lids closed. */
  blink: pose([
    [Ch.LidL, 1],
    [Ch.LidR, 1],
  ]),
  /** Plan §4.6.5 "Listening": tilt 8°, ears −10°, brows +6, lean 3° (the values of `BASE.attentive` in base-poses.ts). */
  listening: pose([
    [Ch.HeadTilt, 8 * DEG],
    [Ch.EarRotL, -10 * DEG],
    [Ch.EarRotR, -10 * DEG],
    [Ch.BrowL, 6],
    [Ch.BrowR, 6],
    [Ch.BodyLean, 3 * DEG],
  ]),
  /** Wide open mouth with teeth and tongue, brows up a little. */
  talkOpen: pose([
    [Ch.Jaw, 0.7],
    [Ch.MouthW, 0.6],
    [Ch.Teeth, 0.6],
    [Ch.BrowL, 3],
    [Ch.BrowR, 3],
  ]),
  /** A round "oh": narrow, open, fully rounded. */
  talkRound: pose([
    [Ch.Jaw, 0.55],
    [Ch.MouthW, 0.15],
    [Ch.MouthRound, 1],
  ]),
  /** Lids shut, head dropped, body slumped, ears folded (the values of `BASE.asleep` in base-poses.ts). */
  asleep: pose([
    [Ch.LidL, 1],
    [Ch.LidR, 1],
    [Ch.HeadTilt, -6 * DEG],
    [Ch.BodySquash, -0.02],
    [Ch.EarFoldL, 0.3],
    [Ch.EarFoldR, 0.3],
  ]),
  /** Squeezed: head squashed wide, body squashed, eyes screwed up, cheeks puffed and blushing, nose wrinkled. */
  squish: pose([
    [Ch.HeadSquishX, 0.12],
    [Ch.HeadSquishY, -0.12],
    [Ch.BodySquash, -0.08],
    [Ch.LidL, 0.7],
    [Ch.LidR, 0.7],
    [Ch.CheekPuff, 0.3],
    [Ch.Blush, 1],
    [Ch.NoseWrinkle, 1],
  ]),
  /** Dizzy: stars at phase π/4, head turned, eyes off to the side, mouth a little open, leaning. */
  dizzy: pose([
    [Ch.Stars, 0.125],
    [Ch.HeadRot, -8 * DEG],
    [Ch.IrisX, 6],
    [Ch.IrisY, -4],
    [Ch.Jaw, 0.25],
    [Ch.MouthRound, 0.6],
    [Ch.BodyLean, -3 * DEG],
  ]),
};
