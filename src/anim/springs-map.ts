/**
 * The app's SpringBank index allocation (plan §3.5, §4.6.6; issues #81, #89): one named index per spring, its
 * constants, the pose channel it moves, and the count. `BearView` creates one `SpringBank` of `SPRING_COUNT`
 * springs, configures them with `configureSprings`, and passes the gaze and ear indices to the gaze and
 * ear-twitch layers (#78). #89 appended the secondary springs (tuft, belly, kerchief tails, head wobble, nose
 * sniff) that reaction clips kick through `Clip.impulses`. New springs are appended; indices never change.
 */
import { EAR_SPRING, GAZE_SPRING } from './layers/index.ts';
import { Ch } from './pose.ts';
import type { SpringBank } from './springs.ts';

// The secondary springs' constants (plan §4.6.5's `~` bones; #89): lab/rig.ts's stress constants. Every one is
// underdamped, so a kick rings, and f ≤ 10 Hz keeps it stable at the 1/120 s substep.
/** Tuft boing. */
export const TUFT_SPRING = { freqHz: 4, zeta: 0.25 } as const;
/** Belly jiggle. */
export const BELLY_SPRING = { freqHz: 5, zeta: 0.3 } as const;
/** Neckerchief tail A. */
export const KERCHIEF_A_SPRING = { freqHz: 2.5, zeta: 0.2 } as const;
/** Neckerchief tail B: a little stiffer than A, so the two tails swing out of step. */
export const KERCHIEF_B_SPRING = { freqHz: 2.8, zeta: 0.2 } as const;
/** Head wobble: a spring of its own, looser than the gaze head follow (`GAZE_SPRING`, ζ 0.8), so a kick wobbles. */
export const HEAD_SPRING = { freqHz: 3, zeta: 0.3 } as const;
/** Nose sniff. */
export const NOSE_SPRING = { freqHz: 6, zeta: 0.4 } as const;

/** Named SpringBank indices. */
export const SPRING = {
  /** Gaze head follow, `HeadRot` (`GAZE_SPRING`). */
  headRot: 0,
  /** Gaze head follow, `HeadTilt` (`GAZE_SPRING`). */
  headTilt: 1,
  /** Ear twitch and ear flick, `EarRotL` (`EAR_SPRING`). */
  earL: 2,
  /** Ear twitch and ear flick, `EarRotR` (`EAR_SPRING`). */
  earR: 3,
  /** Tuft boing, `TuftRot` (`TUFT_SPRING`). */
  tuft: 4,
  /** Belly jiggle, `BellyJiggle` (`BELLY_SPRING`). */
  belly: 5,
  /** Neckerchief tail A, `KerchiefA` (`KERCHIEF_A_SPRING`). */
  kerchiefA: 6,
  /** Neckerchief tail B, `KerchiefB` (`KERCHIEF_B_SPRING`). */
  kerchiefB: 7,
  /** Head wobble, `HeadRot` (`HEAD_SPRING`): added on top of the gaze follow `headRot`, which it leaves alone. */
  head: 8,
  /** Nose sniff, `NoseY` (`NOSE_SPRING`). */
  nose: 9,
} as const;

/** Spring constants, indexed by `SPRING` value. */
export const SPRING_PARAMS: readonly { readonly freqHz: number; readonly zeta: number }[] = [
  GAZE_SPRING,
  GAZE_SPRING,
  EAR_SPRING,
  EAR_SPRING,
  TUFT_SPRING,
  BELLY_SPRING,
  KERCHIEF_A_SPRING,
  KERCHIEF_B_SPRING,
  HEAD_SPRING,
  NOSE_SPRING,
];

/** Number of springs: the size of the app's `SpringBank` (one per `SPRING_PARAMS` entry). */
export const SPRING_COUNT = SPRING_PARAMS.length;

/**
 * The pose channel each spring moves, indexed by `SPRING` value: the spring's position (rest 0) is added to that
 * channel. The gaze and ear-twitch layers add their own springs (`headRot`, `headTilt`, `earL`, `earR`); the
 * others are the `SECONDARY_SPRINGS`.
 */
export const SPRING_CHANNEL: readonly number[] = [
  Ch.HeadRot,
  Ch.HeadTilt,
  Ch.EarRotL,
  Ch.EarRotR,
  Ch.TuftRot,
  Ch.BellyJiggle,
  Ch.KerchiefA,
  Ch.KerchiefB,
  Ch.HeadRot,
  Ch.NoseY,
];

/**
 * The springs no layer writes; only reaction clip impulses move them. Whoever owns the SpringBank adds
 * `pos[i]` to `pose[SPRING_CHANNEL[i]]` for each of them after the layers, as lab/rig.ts's clip preview does.
 */
export const SECONDARY_SPRINGS: readonly number[] = [
  SPRING.tuft,
  SPRING.belly,
  SPRING.kerchiefA,
  SPRING.kerchiefB,
  SPRING.head,
  SPRING.nose,
];

/**
 * `bank.set(i, freqHz, max(zeta, minZeta))` for every spring of `SPRING_PARAMS`. Reduced motion passes
 * `minZeta = 0.9` (plan §4.6.6); the default 0 keeps each spring's own ζ. Position, velocity and target are
 * left as they are, so it can be called again at any time.
 */
export function configureSprings(bank: SpringBank, minZeta = 0): void {
  for (let i = 0; i < SPRING_PARAMS.length; i++) {
    const p = SPRING_PARAMS[i]!;
    bank.set(i, p.freqHz, Math.max(p.zeta, minZeta));
  }
}
