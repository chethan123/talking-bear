/**
 * The session-driven clips (plan §3.5): `wake`, `sleep`, `earTwitch`, `confused` and `shrug`. M5 adds the
 * reaction clips beside these.
 *
 * Conventions:
 * - Units follow `pose.ts`. Rotations are radians, **positive = clockwise on screen** (y down) on both sides,
 *   with no left/right sign mirroring (the rig's bone rotation, #75; mirroring is a part-level path copy).
 *   The arms hang down from their shoulders, so raising both arms outward ("arms up") is `ArmRotL` +θ and
 *   `ArmRotR` −θ. A dropped head is negative `HeadTilt`, as in the `asleep` and `dozing` base poses.
 * - Every track starts at (t 0, v 0) and ends at 0, so nothing pops when the director (#79) drops a clip at
 *   its end. No clip writes a mouth channel.
 * - `wake` and `sleep` play while the director crossfades the base pose over 150 ms (to `idle` and
 *   `asleep`). Their lid and head tracks are shaped against that fade: `wake` turns the asleep → idle fade
 *   into a linear 1 → 0 lid opening over 0.3 s; during the fade, `sleep` lets the lids close no further
 *   than 0.6 and the head drop no further than −3° (the `dozing` values, so from Dozing nothing reopens or
 *   lifts), then closes the lids by 0.75 s and drops the head past −6° to −8° before it settles on the
 *   `asleep` −6°.
 * - `earTwitch` keys its `EarRotR` flick instead of using `impulses`: the app's named SpringBank indices
 *   (`SPRING`, #81) don't exist yet. #81/#89 may add an `earR` impulse once `SPRING` exists.
 */
import type { Clip } from '../clip.ts';
import { Ch } from '../pose.ts';

const DEG = Math.PI / 180;

/** Arm raise of the `wake` stretch. */
const WAKE_ARM = 40 * DEG;
/** First swing of the `earTwitch` flick. */
const TWITCH_EAR = 12 * DEG;
/** Head tilt each way in `confused`. */
const CONFUSED_TILT = 10 * DEG;
/** Arm raise of `shrug`. */
const SHRUG_ARM = 15 * DEG;
/** Brow lift of `shrug`. */
const SHRUG_BROW = 4;

/** The names of the session clips. */
export type SessionClipName = 'wake' | 'sleep' | 'earTwitch' | 'confused' | 'shrug';

/** Stretch on waking: squash then stretch, lids open by 0.3 s, arms up and back. */
const wake: Clip = {
  name: 'wake',
  duration: 1.2,
  tracks: [
    {
      ch: Ch.BodySquash,
      keys: [
        { t: 0, v: 0, ease: 'inOut' },
        { t: 0.3, v: -0.05, ease: 'inOut' },
        { t: 0.7, v: 0.04, ease: 'inOut' },
        { t: 1.2, v: 0 },
      ],
    },
    {
      ch: Ch.LidL,
      keys: [
        { t: 0, v: 0 },
        { t: 0.15, v: 0.5 },
        { t: 0.3, v: 0 },
      ],
    },
    {
      ch: Ch.LidR,
      keys: [
        { t: 0, v: 0 },
        { t: 0.15, v: 0.5 },
        { t: 0.3, v: 0 },
      ],
    },
    {
      ch: Ch.ArmRotL,
      keys: [
        { t: 0, v: 0 },
        { t: 0.3, v: 0, ease: 'inOut' },
        { t: 0.7, v: WAKE_ARM },
        { t: 0.85, v: WAKE_ARM, ease: 'inOut' },
        { t: 1.2, v: 0 },
      ],
    },
    {
      ch: Ch.ArmRotR,
      keys: [
        { t: 0, v: 0 },
        { t: 0.3, v: 0, ease: 'inOut' },
        { t: 0.7, v: -WAKE_ARM },
        { t: 0.85, v: -WAKE_ARM, ease: 'inOut' },
        { t: 1.2, v: 0 },
      ],
    },
  ],
};

/** Falling asleep: lids close, the head drops. */
const sleep: Clip = {
  name: 'sleep',
  duration: 1.0,
  tracks: [
    {
      ch: Ch.LidL,
      keys: [
        { t: 0, v: 0 },
        { t: 0.15, v: -0.4, ease: 'inOut' },
        { t: 0.75, v: 0 },
      ],
    },
    {
      ch: Ch.LidR,
      keys: [
        { t: 0, v: 0 },
        { t: 0.15, v: -0.4, ease: 'inOut' },
        { t: 0.75, v: 0 },
      ],
    },
    {
      ch: Ch.HeadTilt,
      keys: [
        { t: 0, v: 0 },
        { t: 0.15, v: 3 * DEG, ease: 'inOut' },
        { t: 0.6, v: -2 * DEG, ease: 'inOut' },
        { t: 1.0, v: 0 },
      ],
    },
  ],
};

/** A flick of the right ear with a quick fold, like a damped spring kick. */
const earTwitch: Clip = {
  name: 'earTwitch',
  duration: 0.35,
  tracks: [
    {
      ch: Ch.EarRotR,
      keys: [
        { t: 0, v: 0, ease: 'out' },
        { t: 0.04, v: TWITCH_EAR, ease: 'inOut' },
        { t: 0.13, v: -4 * DEG, ease: 'inOut' },
        { t: 0.22, v: 1.5 * DEG, ease: 'inOut' },
        { t: 0.3, v: 0 },
      ],
    },
    {
      ch: Ch.EarFoldR,
      keys: [
        { t: 0, v: 0, ease: 'out' },
        { t: 0.1, v: 0.4, ease: 'inOut' },
        { t: 0.35, v: 0 },
      ],
    },
  ],
};

/** A quizzical head wobble, +10° then −10°, with one brow up and one down. */
const confused: Clip = {
  name: 'confused',
  duration: 0.9,
  tracks: [
    {
      ch: Ch.HeadTilt,
      keys: [
        { t: 0, v: 0, ease: 'inOut' },
        { t: 0.25, v: CONFUSED_TILT, ease: 'inOut' },
        { t: 0.55, v: -CONFUSED_TILT, ease: 'inOut' },
        { t: 0.9, v: 0 },
      ],
    },
    {
      ch: Ch.BrowL,
      keys: [
        { t: 0, v: 0, ease: 'inOut' },
        { t: 0.2, v: 6 },
        { t: 0.7, v: 6, ease: 'inOut' },
        { t: 0.9, v: 0 },
      ],
    },
    {
      ch: Ch.BrowR,
      keys: [
        { t: 0, v: 0, ease: 'inOut' },
        { t: 0.2, v: -4 },
        { t: 0.7, v: -4, ease: 'inOut' },
        { t: 0.9, v: 0 },
      ],
    },
  ],
};

/** Arms up 15° and back, brows up. */
const shrug: Clip = {
  name: 'shrug',
  duration: 0.8,
  tracks: [
    {
      ch: Ch.ArmRotL,
      keys: [
        { t: 0, v: 0, ease: 'inOut' },
        { t: 0.25, v: SHRUG_ARM },
        { t: 0.5, v: SHRUG_ARM, ease: 'inOut' },
        { t: 0.8, v: 0 },
      ],
    },
    {
      ch: Ch.ArmRotR,
      keys: [
        { t: 0, v: 0, ease: 'inOut' },
        { t: 0.25, v: -SHRUG_ARM },
        { t: 0.5, v: -SHRUG_ARM, ease: 'inOut' },
        { t: 0.8, v: 0 },
      ],
    },
    {
      ch: Ch.BrowL,
      keys: [
        { t: 0, v: 0, ease: 'inOut' },
        { t: 0.25, v: SHRUG_BROW },
        { t: 0.5, v: SHRUG_BROW, ease: 'inOut' },
        { t: 0.8, v: 0 },
      ],
    },
    {
      ch: Ch.BrowR,
      keys: [
        { t: 0, v: 0, ease: 'inOut' },
        { t: 0.25, v: SHRUG_BROW },
        { t: 0.5, v: SHRUG_BROW, ease: 'inOut' },
        { t: 0.8, v: 0 },
      ],
    },
  ],
};

/** The session clips by name; each clip's `name` equals its key. No clip has `impulses`. */
export const SESSION_CLIPS: Readonly<Record<SessionClipName, Clip>> = {
  wake,
  sleep,
  earTwitch,
  confused,
  shrug,
};
