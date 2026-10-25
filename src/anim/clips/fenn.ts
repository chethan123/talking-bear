/**
 * Fenn's own clips (duck plan §4.6 "New clips", plan §4.6.7): the beak, the head-top ruffle, the wings and the tail
 * feathers. Every other Fenn reaction plays one of Juni's clips (`REACTION_CLIPS`), which drive the same channels on
 * Fenn's bones (`characters/fenn.ts`: `Jaw` the lower bill, `NoseY` the bill, `ArmRot` the wings, `EarRot` the fluff
 * tufts, `Kerchief*` the tail feathers).
 *
 * The conventions are `clips/reactions.ts`'s: radians positive clockwise on screen, `HeadY` in design units with up
 * negative, brows positive up. Every track starts at 0, a clip that isn't `sustained` also ends every track at 0 and
 * lasts until its spring kicks have rung out, and each kick is sized by the peak it gives from rest (`kick`).
 * Content (plan Q3): surprise, ticklishness, delight or mild grumpiness only.
 */
import type { Clip, Key, Track } from '../clip.ts';
import { Ch } from '../pose.ts';
import { SPRING } from '../springs-map.ts';
import { gentle, k, kick, lids, track } from './reactions.ts';

const DEG = Math.PI / 180;

/** Fenn's clips, by name. */
export type FennClipName =
  | 'quack'
  | 'bigQuack'
  | 'bigQuackGentle'
  | 'beakNibble'
  | 'fluffRuffle'
  | 'wingFlapL'
  | 'wingFlapR'
  | 'tailWiggle';

// ---- beak ---------------------------------------------------------------------------------------------------

/** The quack's jaw: [t, value] after its onset, two openings ("qua-ack"), closed at 0.40 s. */
const QUACK_JAW: readonly (readonly [t: number, v: number])[] = [
  [0, 0],
  [0.06, 0.8],
  [0.16, 0.1],
  [0.24, 0.6],
  [0.4, 0],
];
/** The head bobs up this much at the quack's first opening (design units, up negative). */
const QUACK_HEAD_UP = -6;
/** Peak of the bill's kick (`NoseY`, down). */
const QUACK_BILL = 3;

/** The quack's jaw keys from `t0`, × `scale`. */
function quackJaw(t0: number, scale: number): Key[] {
  const last = QUACK_JAW.length - 1;
  return QUACK_JAW.map(([t, v], i) =>
    k(t0 + t, v * scale, i === last ? undefined : i === 0 ? 'out' : 'inOut'),
  );
}

/** Tap on the beak: a quick double-opening quack with a little head bob up, and the bill springs. */
const quack: Clip = {
  name: 'quack',
  duration: 0.45,
  tracks: [
    track(Ch.Jaw, ...quackJaw(0, 1)),
    track(Ch.HeadY, k(0, 0, 'out'), k(0.06, QUACK_HEAD_UP, 'inOut'), k(0.4, 0)),
  ],
  impulses: [{ t: 0, spring: SPRING.nose, dv: kick(SPRING.nose, QUACK_BILL) }],
};

/** The big quack's three onsets (s); the last opens wider, its first peak 1.0 (the quack's shape × 1.25). */
const BIG_QUACK_AT = [0, 0.35, 0.7] as const;
const BIG_QUACK_LAST = 1.0 / 0.8;
/** Peak of the crown curl's kick at each quack (rad). */
const BIG_QUACK_TUFT = 0.2;

/**
 * Beak tap with a multi-poke count ≥ 3 (P4): three quacks in a row, the last the widest, while the body squashes and
 * stretches and the head rocks; the crown curl and the bill spring at each. A quack's jaw would close at +0.40 s, after
 * the next one starts at +0.35 s, so the first two close at the next onset (its first key, 0).
 */
const bigQuack: Clip = {
  name: 'bigQuack',
  duration: 1.2,
  tracks: [
    track(
      Ch.Jaw,
      ...quackJaw(BIG_QUACK_AT[0], 1).slice(0, -1),
      ...quackJaw(BIG_QUACK_AT[1], 1).slice(0, -1),
      ...quackJaw(BIG_QUACK_AT[2], BIG_QUACK_LAST),
    ),
    track(Ch.BodySquash, k(0, 0, 'out'), k(0.1, -0.06, 'inOut'), k(0.5, 0.04, 'inOut'), k(1.1, 0)),
    track(Ch.HeadRot, k(0, 0, 'inOut'), k(0.35, -0.05, 'inOut'), k(0.7, 0.05, 'inOut'), k(1.1, 0)),
  ],
  impulses: BIG_QUACK_AT.flatMap((t) => [
    { t, spring: SPRING.tuft, dv: kick(SPRING.tuft, BIG_QUACK_TUFT) },
    { t, spring: SPRING.nose, dv: kick(SPRING.nose, QUACK_BILL) },
  ]),
};

/** Long-press on the beak: the bill opens a little to nibble the finger, cross-eyed at it, lids 0.2; held. */
const beakNibble: Clip = {
  name: 'beakNibble',
  duration: 0.2,
  sustained: true,
  tracks: [
    track(Ch.Jaw, k(0, 0, 'out'), k(0.2, 0.25)),
    track(Ch.IrisConverge, k(0, 0, 'out'), k(0.2, 4)),
    ...lids(k(0, 0, 'out'), k(0.2, 0.2)),
  ],
};

// ---- head top -----------------------------------------------------------------------------------------------

/** The fluff tufts flare outward this much (`EarRotL` −, `EarRotR` +; rad). */
const RUFFLE_FLUFF = 0.3;
/** Brows down (mild grumpiness). */
const RUFFLE_BROW = -4;
/** Peak of the crown curl's kick (rad). */
const RUFFLE_TUFT = 0.3;

/** The same keys on both brows. */
function brows(...keys: Key[]): Track[] {
  return [track(Ch.BrowL, ...keys), track(Ch.BrowR, ...keys)];
}

/** Stroke against the down on the head: a shiver, the fluff tufts flare out, brows down, the crown curl springs. */
const fluffRuffle: Clip = {
  name: 'fluffRuffle',
  duration: 0.95,
  tracks: [
    track(
      Ch.BodySquash,
      k(0, 0, 'inOut'),
      k(0.1, -0.03, 'inOut'),
      k(0.2, 0.03, 'inOut'),
      k(0.3, -0.02, 'inOut'),
      k(0.45, 0),
    ),
    track(Ch.EarRotL, k(0, 0, 'out'), k(0.15, -RUFFLE_FLUFF, 'inOut'), k(0.6, 0)),
    track(Ch.EarRotR, k(0, 0, 'out'), k(0.15, RUFFLE_FLUFF, 'inOut'), k(0.6, 0)),
    ...brows(k(0, 0, 'out'), k(0.2, RUFFLE_BROW, 'inOut'), k(0.9, 0)),
  ],
  impulses: [{ t: 0, spring: SPRING.tuft, dv: kick(SPRING.tuft, RUFFLE_TUFT) }],
};

// ---- wings and tail -----------------------------------------------------------------------------------------

/** The flap on `ArmRotL` (raising: +; `wingFlapR` negates it): [t, rad]. Two full flaps and a smaller third. */
const FLAP: readonly (readonly [t: number, v: number])[] = [
  [0, 0],
  [0.1, 0.6],
  [0.2, 0],
  [0.3, 0.6],
  [0.4, 0],
  [0.5, 0.4],
  [0.6, 0],
];

/** Tap on a wing: it flaps three times. */
function wingFlap(s: 'L' | 'R'): Clip {
  const sign = s === 'L' ? 1 : -1;
  return {
    name: `wingFlap${s}`,
    duration: 0.6,
    tracks: [
      track(
        s === 'L' ? Ch.ArmRotL : Ch.ArmRotR,
        ...FLAP.map(([t, v], i) => k(t, sign * v, i === FLAP.length - 1 ? undefined : 'inOut')),
      ),
    ],
  };
}

/** The body's wiggle (rad). */
const WIGGLE = 2 * DEG;
/** Peaks of the tail feathers' kicks (rad), in opposite directions. */
const TAIL_A = 0.35;
const TAIL_B = -0.3;

/**
 * How long the tail wiggle lasts (s): the plan's 0.8 s leaves tail feather B 0.021 rad off rest, past the 0.02 that
 * "rung out" allows; by 1.2 s each feather's free-swing envelope is under 0.012 rad whatever its phase.
 */
const TAIL_WIGGLE_S = 1.2;

/** Tap on the tail: a little body wiggle and the two tail feathers swing. */
const tailWiggle: Clip = {
  name: 'tailWiggle',
  duration: TAIL_WIGGLE_S,
  tracks: [
    track(
      Ch.BodyLean,
      k(0, 0, 'inOut'),
      k(0.15, WIGGLE, 'inOut'),
      k(0.3, -WIGGLE, 'inOut'),
      k(0.45, WIGGLE / 2, 'inOut'),
      k(0.6, 0),
    ),
  ],
  impulses: [
    { t: 0, spring: SPRING.kerchiefA, dv: kick(SPRING.kerchiefA, TAIL_A) },
    { t: 0, spring: SPRING.kerchiefB, dv: kick(SPRING.kerchiefB, TAIL_B) },
  ],
};

// ---- the set ------------------------------------------------------------------------------------------------

/** Fenn's clips by name; each clip's `name` equals its key. `bigQuackGentle` is `bigQuack` × `GENTLE_SCALE`. */
export const FENN_CLIPS: Readonly<Record<FennClipName, Clip>> = {
  quack,
  bigQuack,
  bigQuackGentle: gentle(bigQuack),
  beakNibble,
  fluffRuffle,
  wingFlapL: wingFlap('L'),
  wingFlapR: wingFlap('R'),
  tailWiggle,
};
