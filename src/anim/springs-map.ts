/**
 * The app's SpringBank index allocation (plan §3.5, §4.6.6; issue #81): one named index per spring the
 * always-running layers drive, and the count. `BearView` creates one `SpringBank` of `SPRING_COUNT`
 * springs, configures them with `configureSprings` from the layers' exported constants, and passes the
 * indices to the gaze and ear-twitch layers (#78). #89 extends the table (tuft, kerchief, …) by appending
 * indices and their constants.
 */
import { EAR_SPRING, GAZE_SPRING } from './layers/index.ts';
import type { SpringBank } from './springs.ts';

/** Named SpringBank indices. */
export const SPRING = {
  /** Gaze head follow, `HeadRot` (`GAZE_SPRING`). */
  headRot: 0,
  /** Gaze head follow, `HeadTilt` (`GAZE_SPRING`). */
  headTilt: 1,
  /** Ear twitch, `EarRotL` (`EAR_SPRING`). */
  earL: 2,
  /** Ear twitch, `EarRotR` (`EAR_SPRING`). */
  earR: 3,
} as const;

/** Spring constants, indexed by `SPRING` value. #89 appends an entry per new index. */
export const SPRING_PARAMS: readonly { readonly freqHz: number; readonly zeta: number }[] = [
  GAZE_SPRING,
  GAZE_SPRING,
  EAR_SPRING,
  EAR_SPRING,
];

/** Number of springs: the size of the app's `SpringBank` (one per `SPRING_PARAMS` entry). */
export const SPRING_COUNT = SPRING_PARAMS.length;

/**
 * `bank.set(i, freqHz, max(zeta, minZeta))` for every spring of `SPRING_PARAMS`. Reduced motion passes
 * `minZeta = 0.9` (plan §4.6.6); the default 0 keeps each layer's own ζ. Position, velocity and target are
 * left as they are, so it can be called again at any time.
 */
export function configureSprings(bank: SpringBank, minZeta = 0): void {
  for (let i = 0; i < SPRING_PARAMS.length; i++) {
    const p = SPRING_PARAMS[i]!;
    bank.set(i, p.freqHz, Math.max(p.zeta, minZeta));
  }
}
