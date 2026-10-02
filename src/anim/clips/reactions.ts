/**
 * The reaction clips (plan §4.6.4, §4.6.5 "Sneeze, squish, laugh, dizzy: keyframed curves on the same channels,
 * plus spring impulses", §4.6.6; issue #89): one clip per reaction of the #90 table, per side for the L/R
 * regions, and the gentle variants that Gentle mode and reduced motion play instead of the big ones.
 *
 * Conventions:
 * - Units follow `pose.ts`, as in `clips/session.ts`. Rotations are radians, **positive = clockwise on screen**
 *   (y down) on both sides, with no left/right sign mirroring (ORCH-ANSWER on #89): raising an arm is
 *   `ArmRotL` +θ / `ArmRotR` −θ, an arm turning inward (the hug) is `ArmRotL` −θ / `ArmRotR` +θ, and an ear
 *   flicks outward with `EarRotL` −θ / `EarRotR` +θ (the ear-twitch layer's kick). `HeadY` is design units,
 *   y down, so "head up" is negative; brows are positive up; `NoseY` is positive down.
 * - "Head" angles are `HeadRot`, the head's own rotation: bear-view.ts scales a clip's `HeadRot` with the other
 *   wobble channels under reduced motion, while `HeadTilt` stays the base poses' and the gaze follow's.
 * - Every track starts at 0 (at t 0, or at its first key with v 0), so nothing pops when a clip starts. A clip
 *   that isn't `sustained` also ends every track at 0, so nothing pops when the director drops it at its end,
 *   and it lasts until its spring kicks have rung out. A `sustained` clip eases into its held pose and ends
 *   there (`Clip.sustained`).
 * - Spring kicks use `SPRING` indices (springs-map.ts). Each kick is sized by the peak it gives from rest
 *   with the spring's own constants (`kick`).
 * - Content (plan Q3): surprise, ticklishness, delight or mild grumpiness only.
 */
import type { Clip, Key, Track } from '../clip.ts';
import { Ch } from '../pose.ts';
import { SPRING, SPRING_PARAMS } from '../springs-map.ts';

const DEG = Math.PI / 180;

/** Every amplitude of a gentle variant is its base clip's × this (plan §4.6.6), and it has no `Stars`. */
export const GENTLE_SCALE = 0.3;
/** The clips with a gentle variant, `<name>Gentle`. */
export const GENTLE_BASES = ['sneeze', 'bigSneeze', 'wobble', 'dizzy', 'laughFit'] as const;

/** The base reaction clips: one per reaction of the #90 table, per side for the L/R regions. */
export type BaseReactionClipName =
  | 'sneeze'
  | 'bigSneeze'
  | 'noseWrinkle'
  | 'tuftBoing'
  | 'headPress'
  | 'pet'
  | 'againstFur'
  | 'wobble'
  | 'dizzy'
  | 'earFlickL'
  | 'earFlickR'
  | 'earDroopL'
  | 'earDroopR'
  | 'earFlattenL'
  | 'earFlattenR'
  | 'hardBlinkL'
  | 'hardBlinkR'
  | 'cheekPuffL'
  | 'cheekPuffR'
  | 'blush'
  | 'squish'
  | 'bellyBoing'
  | 'bellyRub'
  | 'giggle'
  | 'laughFit'
  | 'hug'
  | 'pawWaveL'
  | 'pawWaveR'
  | 'highFiveL'
  | 'highFiveR'
  | 'footPullL'
  | 'footPullR'
  | 'kickGiggle'
  | 'kerchiefAdjust';
/** The gentle variants. */
export type GentleClipName = `${(typeof GENTLE_BASES)[number]}Gentle`;
/** Every reaction clip. */
export type ReactionClipName = BaseReactionClipName | GentleClipName;

// ---- helpers (module setup only; nothing here runs per frame) -------------------------------------------------

type Ease = Key['ease'];
type Side = 'L' | 'R';

/** A key. */
function k(t: number, v: number, ease?: Ease): Key {
  return ease === undefined ? { t, v } : { t, v, ease };
}

/** A track. */
function track(ch: number, ...keys: Key[]): Track {
  return { ch, keys };
}

/**
 * `count` half-waves of `len` seconds each from `t0`: 0 at every start and end, `peak(j)` in the middle of
 * half-wave `j`, eased like a sine (`out` into a peak, `in` out of it). Ends with 0 at `t0 + count·len`.
 */
function waves(t0: number, len: number, count: number, peak: (j: number) => number): Key[] {
  const keys: Key[] = [];
  for (let j = 0; j < count; j++) {
    const a = t0 + j * len;
    keys.push(k(a, 0, 'out'), k(a + len / 2, peak(j), 'in'));
  }
  keys.push(k(t0 + count * len, 0));
  return keys;
}

/** ±`amp` at `hz` for `cycles` whole cycles from `t0`: a sine-like oscillation about 0. */
function oscillate(t0: number, hz: number, cycles: number, amp: number): Key[] {
  return waves(t0, 1 / (2 * hz), 2 * cycles, (j) => (j % 2 === 0 ? amp : -amp));
}

/** 0 → `amp` → 0 at `hz` for `cycles` whole cycles from `t0`: one opening per cycle (a jaw). */
function pulse(t0: number, hz: number, cycles: number, amp: number): Key[] {
  return waves(t0, 1 / hz, cycles, () => amp);
}

/**
 * The velocity kick that takes spring `spring` from rest to a peak of `peak` (channel units; its sign is the
 * direction). The free response of an underdamped spring, x(t) = (dv/ωd)·e^(−ζωt)·sin(ωd·t), peaks where
 * ωd·t = θ = atan2(√(1 − ζ²), ζ), at (dv/ω)·e^(−ζθ/√(1 − ζ²)) (lab/rig.ts's `kickFor`).
 */
function kick(spring: number, peak: number): number {
  const p = SPRING_PARAMS[spring]!;
  const w = 2 * Math.PI * p.freqHz;
  const r = Math.sqrt(1 - p.zeta * p.zeta);
  return peak * w * Math.exp((p.zeta * Math.atan2(r, p.zeta)) / r);
}

/** `v`, with its magnitude capped at `cap`. */
function capped(v: number, cap: number): number {
  return Math.max(-cap, Math.min(cap, v));
}

/** The variant of `base` with every key value and every kick × `GENTLE_SCALE`, and no `Stars` track. */
function gentle(base: Clip): Clip {
  const c: Clip = {
    name: `${base.name}Gentle`,
    duration: base.duration,
    tracks: base.tracks
      .filter((tr) => tr.ch !== Ch.Stars)
      .map((tr) => ({ ch: tr.ch, keys: tr.keys.map((key) => ({ ...key, v: key.v * GENTLE_SCALE })) })),
  };
  if (base.impulses !== undefined)
    c.impulses = base.impulses.map((imp) => ({ ...imp, dv: imp.dv * GENTLE_SCALE }));
  if (base.sustained !== undefined) c.sustained = base.sustained;
  return c;
}

/** Per-side channels and signs. */
const ARM = { L: Ch.ArmRotL, R: Ch.ArmRotR } as const;
/** The sign of raising an arm (ORCH-ANSWER on #89). */
const ARM_UP = { L: 1, R: -1 } as const;
const EAR_FOLD = { L: Ch.EarFoldL, R: Ch.EarFoldR } as const;
const EAR_IDX = { L: SPRING.earL, R: SPRING.earR } as const;
/** The sign of an ear flicking outward (the ear-twitch layer's kick). */
const EAR_OUT = { L: -1, R: 1 } as const;
const FOOT = { L: Ch.FootL, R: Ch.FootR } as const;

/** The same keys on both lids. */
function lids(...keys: Key[]): Track[] {
  return [track(Ch.LidL, ...keys), track(Ch.LidR, ...keys)];
}

/** The same keys on both brows. */
function brows(...keys: Key[]): Track[] {
  return [track(Ch.BrowL, ...keys), track(Ch.BrowR, ...keys)];
}

// ---- nose ---------------------------------------------------------------------------------------------------

/** End of the sneeze anticipation, and of the snap into the sneeze (s). */
const SNEEZE_WINDUP = 0.3;
const SNEEZE_SNAP = 0.34;
/** The lids stay shut this long from the snap (s). */
const SNEEZE_SHUT = 0.08;
/** Sneeze anticipation: head back, lids half closed, nose up. */
const SNEEZE_HEAD_BACK = -5 * DEG;
const SNEEZE_LIDS = 0.5;
const SNEEZE_NOSE_UP = -4;
/** Sneeze snap: head, squash (`BodySquash` −0.1 = squash 0.9), lids shut, and the nose kick's peak. */
const SNEEZE_HEAD = -15 * DEG;
const SNEEZE_SQUASH = -0.1;
const SNEEZE_NOSE_KICK = 2;
/** Big sneeze: the sneeze's amplitudes × 1.5, the head capped at 20° and the lids at 1. */
const BIG = 1.5;
const BIG_HEAD_CAP = 20 * DEG;

/** Anticipation for 300 ms, a snap with the lids shut for 80 ms, recovered by 700 ms; the nose sniffs. */
const sneeze: Clip = {
  name: 'sneeze',
  duration: 0.7,
  tracks: [
    track(
      Ch.HeadRot,
      k(0, 0, 'inOut'),
      k(SNEEZE_WINDUP, SNEEZE_HEAD_BACK, 'out'),
      k(SNEEZE_SNAP, SNEEZE_HEAD),
      k(SNEEZE_SNAP + SNEEZE_SHUT, SNEEZE_HEAD, 'inOut'),
      k(0.7, 0),
    ),
    track(
      Ch.BodySquash,
      k(SNEEZE_WINDUP, 0, 'out'),
      k(SNEEZE_SNAP, SNEEZE_SQUASH),
      k(SNEEZE_SNAP + SNEEZE_SHUT, SNEEZE_SQUASH, 'inOut'),
      k(0.7, 0),
    ),
    ...lids(
      k(0, 0, 'inOut'),
      k(SNEEZE_WINDUP, SNEEZE_LIDS, 'out'),
      k(SNEEZE_SNAP, 1),
      k(SNEEZE_SNAP + SNEEZE_SHUT, 1, 'inOut'),
      k(0.62, 0),
    ),
    track(Ch.NoseY, k(0, 0, 'inOut'), k(SNEEZE_WINDUP, SNEEZE_NOSE_UP, 'out'), k(SNEEZE_SNAP, 0)),
  ],
  impulses: [{ t: SNEEZE_WINDUP, spring: SPRING.nose, dv: kick(SPRING.nose, SNEEZE_NOSE_KICK) }],
};

/** The second snap of the big sneeze starts this much after the first (s). */
const BIG_SECOND = 0.26;

/** The sneeze × 1.5 (capped), with a double snap; recovered by 1 s. */
const bigSneeze: Clip = (() => {
  const back = BIG * SNEEZE_HEAD_BACK;
  const head = capped(BIG * SNEEZE_HEAD, BIG_HEAD_CAP);
  const squash = BIG * SNEEZE_SQUASH;
  const half = capped(BIG * SNEEZE_LIDS, 1);
  const shut = capped(BIG * 1, 1);
  const nose = BIG * SNEEZE_NOSE_UP;
  const w1 = SNEEZE_WINDUP;
  const w2 = SNEEZE_WINDUP + BIG_SECOND;
  const snap = SNEEZE_SNAP - SNEEZE_WINDUP;
  return {
    name: 'bigSneeze',
    duration: 1.0,
    tracks: [
      track(
        Ch.HeadRot,
        k(0, 0, 'inOut'),
        k(w1, back, 'out'),
        k(w1 + snap, head),
        k(w1 + snap + SNEEZE_SHUT, head, 'inOut'),
        k(w2, back, 'out'),
        k(w2 + snap, head),
        k(w2 + snap + SNEEZE_SHUT, head, 'inOut'),
        k(1.0, 0),
      ),
      track(
        Ch.BodySquash,
        k(w1, 0, 'out'),
        k(w1 + snap, squash),
        k(w1 + snap + SNEEZE_SHUT, squash, 'inOut'),
        k(w2, 0, 'out'),
        k(w2 + snap, squash),
        k(w2 + snap + SNEEZE_SHUT, squash, 'inOut'),
        k(1.0, 0),
      ),
      ...lids(
        k(0, 0, 'inOut'),
        k(w1, half, 'out'),
        k(w1 + snap, shut),
        k(w1 + snap + SNEEZE_SHUT, shut, 'inOut'),
        k(w2, half, 'out'),
        k(w2 + snap, shut),
        k(w2 + snap + SNEEZE_SHUT, shut, 'inOut'),
        k(0.9, 0),
      ),
      track(
        Ch.NoseY,
        k(0, 0, 'inOut'),
        k(w1, nose, 'out'),
        k(w1 + snap, 0, 'inOut'),
        k(w2, nose, 'out'),
        k(w2 + snap, 0),
      ),
    ],
    impulses: [
      { t: w1, spring: SPRING.nose, dv: kick(SPRING.nose, BIG * SNEEZE_NOSE_KICK) },
      { t: w2, spring: SPRING.nose, dv: kick(SPRING.nose, BIG * SNEEZE_NOSE_KICK) },
    ],
  };
})();

/**
 * Long-press on the nose: the nose wrinkles and the eyes look down at the finger on it. The rig has one
 * `IrisX`/`IrisY` pair for both eyes, so they can't cross: both irises move 6 units toward the nose (down).
 */
const noseWrinkle: Clip = {
  name: 'noseWrinkle',
  duration: 0.2,
  sustained: true,
  tracks: [track(Ch.NoseWrinkle, k(0, 0, 'out'), k(0.2, 1)), track(Ch.IrisY, k(0, 0, 'out'), k(0.2, 6))],
};

// ---- head top -----------------------------------------------------------------------------------------------

/** Peak of the tuft boing's kick. */
const TUFT_BOING = 20 * DEG;

/** Tap on the tuft: it boings (spring kick) while the head bobs down 5 units and back. */
const tuftBoing: Clip = {
  name: 'tuftBoing',
  duration: 0.8,
  tracks: [track(Ch.HeadY, k(0, 0, 'out'), k(0.08, 5, 'inOut'), k(0.22, -2, 'inOut'), k(0.4, 0))],
  impulses: [{ t: 0, spring: SPRING.tuft, dv: kick(SPRING.tuft, TUFT_BOING) }],
};

/** Long-press on the head top: the head presses up 8 units into the finger, eyes a little closed. */
const headPress: Clip = {
  name: 'headPress',
  duration: 0.25,
  sustained: true,
  tracks: [track(Ch.HeadY, k(0, 0, 'inOut'), k(0.25, -8)), ...lids(k(0, 0, 'inOut'), k(0.25, 0.3))],
};

/** The pet lean (≤ 8°). A clip has no stroke direction: it leans one way (clockwise). */
const PET_LEAN = 6 * DEG;

/** Stroke (with the fur): eyes nearly closed, a lean into the stroke, a blush. */
const pet: Clip = {
  name: 'pet',
  duration: 0.4,
  sustained: true,
  tracks: [
    ...lids(k(0, 0, 'inOut'), k(0.3, 0.8)),
    track(Ch.HeadRot, k(0, 0, 'inOut'), k(0.4, PET_LEAN)),
    track(Ch.Blush, k(0, 0, 'inOut'), k(0.4, 0.8)),
  ],
};

/** Stroke against the fur: brows down 5 and a head shake, ±6° three times (mild grumpiness). */
const againstFur: Clip = {
  name: 'againstFur',
  duration: 0.95,
  tracks: [
    ...brows(k(0, 0, 'out'), k(0.1, -5), k(0.75, -5, 'inOut'), k(0.95, 0)),
    track(Ch.HeadRot, ...oscillate(0.05, 4, 3, 6 * DEG)),
  ],
};

/** Peak of the wobble's head kick: within the issue's 12° cap. */
const WOBBLE = 10 * DEG;

/** Flick on the head: a head-spring wobble (`SPRING.head`, on top of `HeadRot`). */
const wobble: Clip = {
  name: 'wobble',
  duration: 1.0,
  tracks: [],
  impulses: [{ t: 0, spring: SPRING.head, dv: kick(SPRING.head, WOBBLE) }],
};

/** The dizzy spell (s): stars and sway for 2.5 s, then the shake-off. */
const DIZZY_S = 2.5;
const DIZZY_SWAY = 5 * DEG;
/** Peak of the shake-off's first swing. */
const SHAKE_OFF = 8 * DEG;

/**
 * Head flick × 3 (P4): a gentle dizzy spell. The stars circle (`Stars` 0 → 1 → 0 over 2.5 s) while the body
 * sways ±5°, then a happy shake-off of the head with a blush. `Stars` is the stars' phase: the renderer draws them
 * at phase `Stars·2π` whenever `Stars` > 0, so 0 → 1 → 0 spins them one full turn forward and back, and they
 * vanish at 0.
 */
const dizzy: Clip = {
  name: 'dizzy',
  duration: 3.5,
  tracks: [
    track(Ch.Stars, k(0, 0, 'inOut'), k(DIZZY_S / 2, 1, 'inOut'), k(DIZZY_S, 0)),
    track(
      Ch.BodyLean,
      k(0, 0, 'inOut'),
      k(0.3125, DIZZY_SWAY, 'inOut'),
      k(0.9375, -DIZZY_SWAY, 'inOut'),
      k(1.5625, DIZZY_SWAY, 'inOut'),
      k(2.1875, -DIZZY_SWAY, 'inOut'),
      k(DIZZY_S, 0),
    ),
    track(
      Ch.HeadRot,
      k(DIZZY_S, 0, 'inOut'),
      k(DIZZY_S + 0.1, SHAKE_OFF, 'inOut'),
      k(DIZZY_S + 0.2, -SHAKE_OFF, 'inOut'),
      k(DIZZY_S + 0.3, 0.75 * SHAKE_OFF, 'inOut'),
      k(DIZZY_S + 0.4, -0.5 * SHAKE_OFF, 'inOut'),
      k(DIZZY_S + 0.5, 0),
    ),
    track(Ch.Blush, k(DIZZY_S, 0, 'inOut'), k(DIZZY_S + 0.2, 0.5), k(3.2, 0.5, 'inOut'), k(3.5, 0)),
  ],
};

// ---- ears ---------------------------------------------------------------------------------------------------

/** Peak of an ear flick's kick, outward. */
const EAR_FLICK = 20 * DEG;

/** Tap on an ear ("hm?"): it flicks outward (spring kick) with a quick fold. */
function earFlick(s: Side): Clip {
  return {
    name: `earFlick${s}`,
    duration: 0.5,
    tracks: [track(EAR_FOLD[s], k(0, 0, 'out'), k(0.08, 0.4, 'inOut'), k(0.35, 0))],
    impulses: [{ t: 0, spring: EAR_IDX[s], dv: kick(EAR_IDX[s], EAR_OUT[s] * EAR_FLICK) }],
  };
}

/** Long-press on an ear: it droops (fold → 1) and the eyes half close; held until the release. */
function earDroop(s: Side): Clip {
  return {
    name: `earDroop${s}`,
    duration: 0.4,
    sustained: true,
    tracks: [track(EAR_FOLD[s], k(0, 0, 'inOut'), k(0.4, 1)), ...lids(k(0, 0, 'inOut'), k(0.4, 0.5))],
  };
}

/** Stroke on an ear: it flattens (fold 0.6) along the stroke, then springs back. */
function earFlatten(s: Side): Clip {
  return {
    name: `earFlatten${s}`,
    duration: 0.9,
    tracks: [track(EAR_FOLD[s], k(0, 0, 'out'), k(0.15, 0.6), k(0.6, 0.6, 'inOut'), k(0.9, 0))],
  };
}

// ---- eyes and cheeks ----------------------------------------------------------------------------------------

/**
 * The paw rub of a hard blink: the arm on that side rises 150° ("up" sign) to bring the paw up beside the face at
 * eye height. The arms draw behind the head, so a paw over the eye would be hidden; beside it, against the side of
 * the face, is the closest visible reach (the arm is 170 units long, the eye 332 units from the shoulder, so a 60°
 * raise only swings the paw out at the side, below the shoulder).
 */
const RUB_ARM = 150 * DEG;
/** The rub: the raised arm dips this much twice. */
const RUB_DIP = 8 * DEG;
/** The head leans into the paw by this much (`HeadRot`, toward the paw's side). */
const RUB_LEAN = 10 * DEG;
/** The rubbed eye stays this squeezed while the paw rubs it. */
const RUB_LID = 0.7;

/**
 * Tap on an eye ("hmph!", mild grumpiness, no pain): the lids shut hard for 150 ms, then the paw on that side rises
 * to the side of the face and rubs that eye twice while the head leans into it and the eye stays squeezed, and
 * everything goes back; the brows go down 3.
 */
function hardBlink(s: Side): Clip {
  const up = ARM_UP[s];
  const rubbed = s === 'L' ? Ch.LidL : Ch.LidR;
  const other = s === 'L' ? Ch.LidR : Ch.LidL;
  return {
    name: `hardBlink${s}`,
    duration: 1.0,
    tracks: [
      track(
        rubbed,
        k(0, 0, 'out'),
        k(0.05, 1),
        k(0.2, 1, 'inOut'),
        k(0.3, RUB_LID),
        k(0.75, RUB_LID, 'inOut'),
        k(0.95, 0),
      ),
      track(other, k(0, 0, 'out'), k(0.05, 1), k(0.2, 1, 'in'), k(0.3, 0)),
      track(
        ARM[s],
        k(0, 0, 'inOut'),
        k(0.3, up * RUB_ARM, 'inOut'),
        k(0.42, up * (RUB_ARM - RUB_DIP), 'inOut'),
        k(0.54, up * RUB_ARM, 'inOut'),
        k(0.66, up * (RUB_ARM - RUB_DIP), 'inOut'),
        k(1.0, 0),
      ),
      // The head rolls toward the raised paw: counter-clockwise for the left one.
      track(
        Ch.HeadRot,
        k(0, 0, 'inOut'),
        k(0.3, -up * RUB_LEAN),
        k(0.66, -up * RUB_LEAN, 'inOut'),
        k(1.0, 0),
      ),
      ...brows(k(0, 0, 'out'), k(0.1, -3), k(0.8, -3, 'inOut'), k(1.0, 0)),
    ],
  };
}

/**
 * Tap on a cheek: `CheekPuff` 0 → 1 → 0. There is one `CheekPuff` channel, so both sides puff the same way.
 * The puff scales the blush parts, which only show with `Blush`, so the cheeks blush 0.5 while puffed.
 */
function cheekPuff(s: Side): Clip {
  return {
    name: `cheekPuff${s}`,
    duration: 0.6,
    tracks: [
      track(Ch.CheekPuff, k(0, 0, 'out'), k(0.15, 1), k(0.45, 1, 'in'), k(0.6, 0)),
      track(Ch.Blush, k(0, 0, 'out'), k(0.15, 0.5), k(0.45, 0.5, 'in'), k(0.6, 0)),
    ],
  };
}

/** Stroke on a cheek: `Blush` → 1 for 1.5 s. */
const blush: Clip = {
  name: 'blush',
  duration: 2.1,
  tracks: [track(Ch.Blush, k(0, 0, 'inOut'), k(0.2, 1), k(1.7, 1, 'inOut'), k(2.1, 0))],
};

/**
 * Pinch on the cheeks: the head squishes (narrower, taller) and the lips pucker; held until the release. The
 * "pop" on release is the table's `sfxOnRelease` (#90), not part of the clip.
 */
const squish: Clip = {
  name: 'squish',
  duration: 0.15,
  sustained: true,
  tracks: [
    track(Ch.HeadSquishX, k(0, 0, 'out'), k(0.15, -0.12)),
    track(Ch.HeadSquishY, k(0, 0, 'out'), k(0.15, 0.08)),
    track(Ch.MouthRound, k(0, 0, 'out'), k(0.15, 1)),
  ],
};

// ---- belly --------------------------------------------------------------------------------------------------

/** Peak of the belly boing's jiggle kick (scale 1.06). */
const BELLY_BOING = 0.06;

/** Tap on the belly ("boing-hehe"): the belly jiggles (spring kick) and the body squashes 0.06. */
const bellyBoing: Clip = {
  name: 'bellyBoing',
  duration: 0.6,
  tracks: [track(Ch.BodySquash, k(0, 0, 'out'), k(0.08, -0.06, 'inOut'), k(0.4, 0))],
  impulses: [{ t: 0, spring: SPRING.belly, dv: kick(SPRING.belly, BELLY_BOING) }],
};

/** Long-press on the belly: a content belly rub, eyes 0.6 closed; held until the release. */
const bellyRub: Clip = {
  name: 'bellyRub',
  duration: 0.4,
  sustained: true,
  tracks: lids(k(0, 0, 'inOut'), k(0.4, 0.6)),
};

/** Giggle: 8 Hz for 0.8 s, i.e. 6 whole cycles (0.75 s). */
const GIGGLE_HZ = 8;
const GIGGLE_S = 0.8;
const GIGGLE_CYCLES = Math.floor(GIGGLE_S * GIGGLE_HZ);
const GIGGLE_SQUASH = 0.03;
const GIGGLE_JAW = 0.4;
const GIGGLE_BLUSH = 0.5;

/** The giggle's bounce and jaw for `cycles` cycles from `t0`. */
function giggleTracks(t0: number, cycles: number): Track[] {
  return [
    track(Ch.BodySquash, ...oscillate(t0, GIGGLE_HZ, cycles, GIGGLE_SQUASH)),
    track(Ch.Jaw, ...pulse(t0, GIGGLE_HZ, cycles, GIGGLE_JAW)),
  ];
}

/** Tickle on the belly: `BodySquash` ±0.03 and the jaw 0.4 at 8 Hz, with a 0.5 blush. */
const giggle: Clip = {
  name: 'giggle',
  duration: GIGGLE_S,
  tracks: [
    ...giggleTracks(0, GIGGLE_CYCLES),
    track(Ch.Blush, k(0, 0, 'out'), k(0.15, GIGGLE_BLUSH), k(0.55, GIGGLE_BLUSH, 'inOut'), k(GIGGLE_S, 0)),
  ],
};

/** The laugh fit's giggle (s; 20 whole cycles at 8 Hz) and its back lean. */
const LAUGH_S = 2.5;
const LAUGH_LEAN = -10 * DEG;

/** Belly tickle > 3 s (P4): a giggle for 2.5 s leaning back 10°, then the recovery. */
const laughFit: Clip = {
  name: 'laughFit',
  duration: 3.1,
  tracks: [
    ...giggleTracks(0, LAUGH_S * GIGGLE_HZ),
    track(Ch.BodyLean, k(0, 0, 'inOut'), k(0.4, LAUGH_LEAN), k(LAUGH_S, LAUGH_LEAN, 'inOut'), k(3.1, 0)),
    track(Ch.Blush, k(0, 0, 'out'), k(0.15, GIGGLE_BLUSH), k(2.6, GIGGLE_BLUSH, 'inOut'), k(3.1, 0)),
  ],
};

/** Hug: both arms turn 40° inward, eyes 0.7 closed, a full blush; held until the release. */
const HUG_ARM = 40 * DEG;
const hug: Clip = {
  name: 'hug',
  duration: 0.35,
  sustained: true,
  tracks: [
    track(Ch.ArmRotL, k(0, 0, 'inOut'), k(0.35, -HUG_ARM)),
    track(Ch.ArmRotR, k(0, 0, 'inOut'), k(0.35, HUG_ARM)),
    ...lids(k(0, 0, 'inOut'), k(0.35, 0.7)),
    track(Ch.Blush, k(0, 0, 'inOut'), k(0.35, 1)),
  ],
};

// ---- paws, feet, neckerchief --------------------------------------------------------------------------------

/** The wave: the arm rises 50° and swings ±10° about it. */
const WAVE_ARM = 50 * DEG;
const WAVE_SWING = 10 * DEG;

/** Tap on a paw: it waves back, brows up 3 (friendly). */
function pawWave(s: Side): Clip {
  const up = ARM_UP[s];
  return {
    name: `pawWave${s}`,
    duration: 1.2,
    tracks: [
      track(
        ARM[s],
        k(0, 0, 'inOut'),
        k(0.25, up * WAVE_ARM, 'inOut'),
        k(0.4, up * (WAVE_ARM - WAVE_SWING), 'inOut'),
        k(0.55, up * (WAVE_ARM + WAVE_SWING), 'inOut'),
        k(0.7, up * (WAVE_ARM - WAVE_SWING), 'inOut'),
        k(0.85, up * WAVE_ARM, 'inOut'),
        k(1.2, 0),
      ),
      ...brows(k(0, 0, 'out'), k(0.15, 3), k(0.95, 3, 'inOut'), k(1.2, 0)),
    ],
  };
}

/** The high five's arm raise. */
const HIGH_FIVE_ARM = 45 * DEG;

/** Long-press on a paw: the paw rises to the finger, brows up 3; held until the release ("hi!"). */
function highFive(s: Side): Clip {
  return {
    name: `highFive${s}`,
    duration: 0.3,
    sustained: true,
    tracks: [
      track(ARM[s], k(0, 0, 'inOut'), k(0.3, ARM_UP[s] * HIGH_FIVE_ARM)),
      ...brows(k(0, 0, 'out'), k(0.2, 3)),
    ],
  };
}

/** The foot pull: `FootL`/`FootR` −0.8 moves the foot 24 units inward, toward the body. */
const FOOT_PULL = -0.8;

/** Tap on a foot ("hey!"): it pulls back in, brows down 3 (mild grumpiness), and comes back out. */
function footPull(s: Side): Clip {
  return {
    name: `footPull${s}`,
    duration: 0.9,
    tracks: [
      track(FOOT[s], k(0, 0, 'out'), k(0.12, FOOT_PULL), k(0.5, FOOT_PULL, 'inOut'), k(0.9, 0)),
      ...brows(k(0, 0, 'out'), k(0.1, -3), k(0.6, -3, 'inOut'), k(0.9, 0)),
    ],
  };
}

/** The kicks: a foot kicks out 0.6 (18 units) per giggle cycle, left and right in turn. */
const KICK = 0.6;

/** Tickle on a foot: the giggle, with the legs kicking out in turn. */
const kickGiggle: Clip = {
  name: 'kickGiggle',
  duration: GIGGLE_S,
  tracks: [
    ...giggle.tracks,
    track(Ch.FootL, ...waves(0, 1 / GIGGLE_HZ, GIGGLE_CYCLES, (j) => (j % 2 === 0 ? KICK : 0))),
    track(Ch.FootR, ...waves(0, 1 / GIGGLE_HZ, GIGGLE_CYCLES, (j) => (j % 2 === 0 ? 0 : KICK))),
  ],
};

/** The arm reaching to the knot (left on screen): `ArmRotL` 80° inward. */
const KNOT_ARM = -80 * DEG;
const KNOT_TUG = 8 * DEG;
/** Peak of each tail's swing. */
const TAIL_SWING = 15 * DEG;

/** Tap on the neckerchief: the left paw goes to the knot and tugs it, and the tails swing (spring kicks). */
const kerchiefAdjust: Clip = {
  name: 'kerchiefAdjust',
  duration: 1.6,
  tracks: [
    track(
      Ch.ArmRotL,
      k(0, 0, 'inOut'),
      k(0.35, KNOT_ARM, 'inOut'),
      k(0.5, KNOT_ARM + KNOT_TUG, 'inOut'),
      k(0.65, KNOT_ARM, 'inOut'),
      k(1.1, 0),
    ),
  ],
  impulses: [
    { t: 0.45, spring: SPRING.kerchiefA, dv: kick(SPRING.kerchiefA, TAIL_SWING) },
    { t: 0.5, spring: SPRING.kerchiefB, dv: kick(SPRING.kerchiefB, TAIL_SWING) },
  ],
};

// ---- the set ------------------------------------------------------------------------------------------------

/** The reaction clips by name, base and gentle; each clip's `name` equals its key. */
export const REACTION_CLIPS: Readonly<Record<ReactionClipName, Clip>> = {
  sneeze,
  bigSneeze,
  noseWrinkle,
  tuftBoing,
  headPress,
  pet,
  againstFur,
  wobble,
  dizzy,
  earFlickL: earFlick('L'),
  earFlickR: earFlick('R'),
  earDroopL: earDroop('L'),
  earDroopR: earDroop('R'),
  earFlattenL: earFlatten('L'),
  earFlattenR: earFlatten('R'),
  hardBlinkL: hardBlink('L'),
  hardBlinkR: hardBlink('R'),
  cheekPuffL: cheekPuff('L'),
  cheekPuffR: cheekPuff('R'),
  blush,
  squish,
  bellyBoing,
  bellyRub,
  giggle,
  laughFit,
  hug,
  pawWaveL: pawWave('L'),
  pawWaveR: pawWave('R'),
  highFiveL: highFive('L'),
  highFiveR: highFive('R'),
  footPullL: footPull('L'),
  footPullR: footPull('R'),
  kickGiggle,
  kerchiefAdjust,
  sneezeGentle: gentle(sneeze),
  bigSneezeGentle: gentle(bigSneeze),
  wobbleGentle: gentle(wobble),
  dizzyGentle: gentle(dizzy),
  laughFitGentle: gentle(laughFit),
};
