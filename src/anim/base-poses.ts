/**
 * The static base pose of each director base state (plan §3.5, §4.6.5).
 *
 * The director (#79) maps its states onto these: Asleep → `asleep`, Waking and Idle → `idle`,
 * Attentive → `attentive`, Thinking → `thinking`, Talking → `talking`, Dozing → `dozing`. It crossfades
 * between them over 150 ms and adds the additive layers and clips on top.
 *
 * Units follow `pose.ts`: rotations in radians (positive = clockwise on screen, y down), brows and iris in
 * design units (brows positive up; iris y down, so a negative `IrisY` looks up), lids and ear folds 0–1,
 * `BodySquash` a multiplicative delta. No pose writes a mouth channel (`Jaw`, `MouthW`, `MouthRound`,
 * `Teeth`): the mouth layer owns them.
 *
 * The poses are shared and **read-only by convention** (a non-empty typed array can't be frozen): never
 * write into them. Every state has its own instance.
 */
import { Ch, createPose } from './pose.ts';
import type { Pose } from './pose.ts';

const DEG = Math.PI / 180;

/** The director's base states. */
export type BaseName = 'asleep' | 'idle' | 'attentive' | 'thinking' | 'talking' | 'dozing';

/** A new pose with the given channel values and every other channel neutral (0). */
function pose(values: readonly (readonly [ch: number, v: number])[]): Pose {
  const p = createPose();
  for (const [ch, v] of values) p[ch] = v;
  return p;
}

export const BASE: Record<BaseName, Pose> = {
  /** Lids shut, head dropped, body slumped, ears folded. */
  asleep: pose([
    [Ch.LidL, 1],
    [Ch.LidR, 1],
    [Ch.HeadTilt, -6 * DEG],
    [Ch.BodySquash, -0.02],
    [Ch.EarFoldL, 0.3],
    [Ch.EarFoldR, 0.3],
  ]),
  /** Neutral. */
  idle: createPose(),
  /** §4.6.5 "Listening": tilt 8°, ears −10°, brows +6, lean 3°. */
  attentive: pose([
    [Ch.HeadTilt, 8 * DEG],
    [Ch.EarRotL, -10 * DEG],
    [Ch.EarRotR, -10 * DEG],
    [Ch.BrowL, 6],
    [Ch.BrowR, 6],
    [Ch.BodyLean, 3 * DEG],
  ]),
  /** Eyes up and to the side, one brow raised, head turned a little. */
  thinking: pose([
    [Ch.IrisY, -6],
    [Ch.IrisX, 4],
    [Ch.BrowL, 4],
    [Ch.HeadRot, 4 * DEG],
  ]),
  /** Neutral: the mouth layer drives talking. */
  talking: createPose(),
  /** Lids half shut, head a little dropped. */
  dozing: pose([
    [Ch.LidL, 0.6],
    [Ch.LidR, 0.6],
    [Ch.HeadTilt, -3 * DEG],
  ]),
};
