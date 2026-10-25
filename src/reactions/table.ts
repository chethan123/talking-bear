/**
 * The reactions table (plan §4.6.4, issue #90): the single mapping from a recognised gesture (#86) to a
 * reaction: its name, priority (plan §3.5), sound effect (#88), clip and gentle clip (#89), escalation to a P4
 * variant, haptic pattern (plan §4.6.3) and mood. The director (#91) decides which reactions actually play.
 *
 * - `reactionFor` is pure and allocates nothing: it returns one of the frozen `REACTIONS` entries, or `null`.
 * - **Priorities** (plan §3.5): P2 for taps and the head flick, which is a one-shot like a tap ("Idle →
 *   Reacting: tap / flick / long-press"); P3 for the sustained reactions (long-press, stroke, tickle, pinch);
 *   P4 for the big ones: `bigSneeze`, `dizzy`, `laughFit` and `hug` ("P4: big reaction (laugh fit, dizzy,
 *   hug)").
 * - **Sides:** for the L/R regions, the reaction and its clip take the region's side (`earL` → `earFlickL`).
 * - **Only the start of a gesture reacts:** a tap reacts on `down`, a long-press on `start`. A `tap up`, a
 *   `longPress end` and a `stroke end` map to `null`; the app turns the end of a sustained gesture into the
 *   director's `release` (#91).
 * - **Pet:** a `headTop` or `belly` stroke becomes `pet` (or `againstFur`, against the fur on `headTop`) on an
 *   `update` once `pathPx ≥ STROKE_MIN_PATH`, never on `start` or `end`: an upward head flick emits an against
 *   `stroke start` before its `flick`, and a scrub can begin with a stroke whose `end` carries ≥ 120 px (#86).
 * - **Not in the table:** `background` (the app sets the gaze instead, #93), the flanks (they only form a hug)
 *   and every other unlisted combination map to `null`.
 * - **Content** (plan Q3): surprise, ticklishness, delight or mild grumpiness only; never pain, fear or crying.
 */
import type { BaseReactionClipName, GentleClipName } from '../anim/clips/reactions.ts';
import type { SfxId } from '../audio/sfx-ids.ts';
import { STROKE_MIN_PATH } from '../input/recognizer.ts';
import type { Gesture } from '../input/recognizer.ts';
import type { RegionId } from '../input/region-ids.ts';

export interface Escalation {
  to: string;
  count?: number; // repeat-based: the same reaction `count` times within `withinMs`
  withinMs?: number;
  continuousMs?: number; // duration-based: gestures keep arriving (gaps ≤ maxGapMs) for > continuousMs
  maxGapMs?: number;
}
export interface Reaction {
  name: string;
  priority: 1 | 2 | 3 | 4;
  sfx: SfxId | null;
  clip: string;
  gentleClip?: string;
  escalation?: Escalation;
  sustained: boolean;
  haptic?: number[];
  mood?: { joy?: number; annoy?: number };
  sfxOnRelease?: SfxId; // played when the sustained gesture is released
  sfxLoopMs?: number; // sustained only: re-emit `sfx` at most this often while the gesture continues
}

// ---- constants (plan §4.6.3, §4.6.4, §3.5) ----------------------------------------------------------------------

/** A nose `tap down` with a multi-poke `count` of at least this is a big sneeze ("×3 → big sneeze"). */
const BIG_SNEEZE_COUNT = 3;

/** Haptic patterns (plan §4.6.3; issue #90): a poke, a tickle or giggle, a purr. Shared and frozen. */
export const HAPTIC_TAP: number[] = [12];
export const HAPTIC_TICKLE: number[] = [8, 40, 8, 40, 8];
export const HAPTIC_PURR: number[] = [15, 35, 15, 35, 15, 35];
Object.freeze(HAPTIC_TAP);
Object.freeze(HAPTIC_TICKLE);
Object.freeze(HAPTIC_PURR);

/** Mood steps (issue #90): delight for pet, giggle and hug; mild grumpiness for againstFur and hardBlink. */
export const JOY: { joy: number } = { joy: 0.2 };
export const ANNOY: { annoy: number } = { annoy: 0.2 };
Object.freeze(JOY);
Object.freeze(ANNOY);

// ---- the reactions ------------------------------------------------------------------------------------------------

type Priority = Reaction['priority'];
/** The optional fields, with the gentle clip typed against the clip module (#89). */
type Extras = Partial<Pick<Reaction, 'escalation' | 'haptic' | 'mood' | 'sfxOnRelease' | 'sfxLoopMs'>> & {
  gentleClip?: GentleClipName;
};

/** One frozen reaction; its clip has its name (every reaction has its own clip in #89). */
function def(
  name: BaseReactionClipName,
  priority: Priority,
  sfx: SfxId | null,
  sustained: boolean,
  extras: Extras = {},
): Reaction {
  const r: Reaction = { name, priority, sfx, clip: name, sustained, ...extras };
  if (r.escalation) Object.freeze(r.escalation);
  return Object.freeze(r);
}

/** A tap reaction: P2, one-shot, a poke's haptic. */
const tap = (name: BaseReactionClipName, sfx: SfxId | null, extras: Extras = {}): Reaction =>
  def(name, 2, sfx, false, { haptic: HAPTIC_TAP, ...extras });
/** A sustained reaction (long-press, stroke, tickle, pinch): P3, held until the gesture is released. */
const held = (name: BaseReactionClipName, sfx: SfxId | null, extras: Extras = {}): Reaction =>
  def(name, 3, sfx, true, extras);

// Nose
const sneeze = tap('sneeze', 'sneeze', { gentleClip: 'sneezeGentle' });
const bigSneeze = def('bigSneeze', 4, 'bigSneeze', false, {
  gentleClip: 'bigSneezeGentle',
  haptic: HAPTIC_TAP,
});
const noseWrinkle = held('noseWrinkle', null);
// Head top
const tuftBoing = tap('tuftBoing', 'boing');
const headPress = held('headPress', null);
const pet = held('pet', 'purr', { haptic: HAPTIC_PURR, mood: JOY, sfxLoopMs: 1200 });
const againstFur = held('againstFur', 'hmph', { mood: ANNOY });
const wobble = def('wobble', 2, 'whoa', false, {
  gentleClip: 'wobbleGentle',
  escalation: { to: 'dizzy', count: 3, withinMs: 3000 },
});
const dizzy = def('dizzy', 4, 'whoa', false, { gentleClip: 'dizzyGentle' });
// Ears
const earFlickL = tap('earFlickL', 'hm');
const earFlickR = tap('earFlickR', 'hm');
// The ear droop's "low hum" (plan §4.6.4) is the purr, played once per press (ORCH-ANSWER on #90).
const earDroopL = held('earDroopL', 'purr');
const earDroopR = held('earDroopR', 'purr');
const earFlattenL = held('earFlattenL', null);
const earFlattenR = held('earFlattenR', null);
// Eyes
const hardBlinkL = tap('hardBlinkL', 'hmph', { mood: ANNOY });
const hardBlinkR = tap('hardBlinkR', 'hmph', { mood: ANNOY });
// Cheeks
const cheekPuffL = tap('cheekPuffL', 'pop');
const cheekPuffR = tap('cheekPuffR', 'pop');
const blush = held('blush', null);
const squish = held('squish', null, { sfxOnRelease: 'pop' });
// Belly
const bellyBoing = tap('bellyBoing', 'boingHehe');
const bellyRub = held('bellyRub', 'sigh');
const giggle = held('giggle', 'giggle', {
  escalation: { to: 'laughFit', continuousMs: 3000, maxGapMs: 700 },
  haptic: HAPTIC_TICKLE,
  mood: JOY,
});
const laughFit = def('laughFit', 4, 'giggle', false, { gentleClip: 'laughFitGentle', haptic: HAPTIC_TICKLE });
// Hug is a big reaction, P4 (plan §3.5; ORCH-ANSWER on #90).
const hug = def('hug', 4, 'squeal', true, { mood: JOY });
// Paws
const pawWaveL = tap('pawWaveL', null);
const pawWaveR = tap('pawWaveR', null);
const highFiveL = held('highFiveL', null, { sfxOnRelease: 'hi' });
const highFiveR = held('highFiveR', null, { sfxOnRelease: 'hi' });
// Feet
const footPullL = tap('footPullL', 'hey');
const footPullR = tap('footPullR', 'hey');
const kickGiggle = held('kickGiggle', 'giggle', { haptic: HAPTIC_TICKLE });
// Neckerchief
const kerchiefAdjust = tap('kerchiefAdjust', 'rustle');

/** Every reaction, by name. */
export const REACTIONS: Readonly<Record<string, Reaction>> = Object.freeze({
  sneeze,
  bigSneeze,
  noseWrinkle,
  tuftBoing,
  headPress,
  pet,
  againstFur,
  wobble,
  dizzy,
  earFlickL,
  earFlickR,
  earDroopL,
  earDroopR,
  earFlattenL,
  earFlattenR,
  hardBlinkL,
  hardBlinkR,
  cheekPuffL,
  cheekPuffR,
  blush,
  squish,
  bellyBoing,
  bellyRub,
  giggle,
  laughFit,
  hug,
  pawWaveL,
  pawWaveR,
  highFiveL,
  highFiveR,
  footPullL,
  footPullR,
  kickGiggle,
  kerchiefAdjust,
} satisfies Record<BaseReactionClipName, Reaction>);

// ---- gesture → reaction ---------------------------------------------------------------------------------------

/** The reaction to `g`, or `null` for none (pure; returns a shared `REACTIONS` entry, never a new object). */
export function reactionFor(g: Gesture): Reaction | null {
  switch (g.g) {
    case 'tap':
      return g.phase === 'down' ? tapReaction(g.region, g.count) : null;
    case 'longPress':
      return g.phase === 'start' ? longPressReaction(g.region) : null;
    case 'stroke':
      return strokeReaction(g);
    case 'tickle':
      return tickleReaction(g.region);
    case 'flick':
      return g.region === 'headTop' ? wobble : null;
    case 'pinch':
      return isCheekPair(g.regions[0], g.regions[1]) ? squish : null;
    case 'hug':
      return hug;
    case 'allOver':
      return giggle;
    case 'cancel':
      return null;
    default:
      return unknownGesture(g);
  }
}

/** A new gesture kind fails to compile here; at run time it has no reaction. */
function unknownGesture(_g: never): null {
  return null;
}

function tapReaction(region: RegionId, count: number): Reaction | null {
  switch (region) {
    case 'nose':
      return count >= BIG_SNEEZE_COUNT ? bigSneeze : sneeze;
    case 'headTop':
      return tuftBoing;
    case 'earL':
      return earFlickL;
    case 'earR':
      return earFlickR;
    case 'eyeL':
      return hardBlinkL;
    case 'eyeR':
      return hardBlinkR;
    case 'cheekL':
      return cheekPuffL;
    case 'cheekR':
      return cheekPuffR;
    case 'belly':
      return bellyBoing;
    case 'pawL':
      return pawWaveL;
    case 'pawR':
      return pawWaveR;
    case 'footL':
      return footPullL;
    case 'footR':
      return footPullR;
    case 'neckerchief':
      return kerchiefAdjust;
    default:
      return null;
  }
}

function longPressReaction(region: RegionId): Reaction | null {
  switch (region) {
    case 'nose':
      return noseWrinkle;
    case 'headTop':
      return headPress;
    case 'earL':
      return earDroopL;
    case 'earR':
      return earDroopR;
    case 'belly':
      return bellyRub;
    case 'pawL':
      return highFiveL;
    case 'pawR':
      return highFiveR;
    default:
      return null;
  }
}

function strokeReaction(g: Extract<Gesture, { g: 'stroke' }>): Reaction | null {
  if (g.phase === 'end') return null;
  const petting = g.phase === 'update' && g.pathPx >= STROKE_MIN_PATH;
  switch (g.region) {
    case 'headTop':
      return petting ? (g.against ? againstFur : pet) : null;
    case 'belly':
      return petting ? pet : null;
    case 'earL':
      return earFlattenL;
    case 'earR':
      return earFlattenR;
    case 'cheekL':
    case 'cheekR':
      return blush;
    default:
      return null;
  }
}

function tickleReaction(region: RegionId): Reaction | null {
  switch (region) {
    case 'belly':
      return giggle;
    case 'footL':
    case 'footR':
      return kickGiggle;
    default:
      return null;
  }
}

function isCheekPair(a: RegionId, b: RegionId): boolean {
  return (a === 'cheekL' && b === 'cheekR') || (a === 'cheekR' && b === 'cheekL');
}
