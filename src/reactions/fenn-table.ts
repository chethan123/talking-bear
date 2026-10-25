/**
 * Fenn's reaction table (duck plan §4.6, plan §4.6.7): the mapping from a recognised gesture on Fenn's regions to a
 * reaction. It follows `table.ts`'s rules (priorities, sides, only the start of a gesture reacts, pet on an `update`
 * once `pathPx ≥ STROKE_MIN_PATH`, `background` and the flanks map to `null`), and reuses Juni's frozen `REACTIONS`
 * entries where the duck plan's table says "Juni's".
 *
 * - `fennReactionFor` is pure and allocates nothing: it returns a frozen `FENN_REACTIONS` or `REACTIONS` entry, or
 *   `null` for every pair the table doesn't list.
 * - Fenn's cast holds `{ ...REACTIONS, ...FENN_REACTIONS }` (`characters/fenn.ts`); the new names don't collide with
 *   Juni's, so the escalation targets (`dizzy`, `laughFit`) are Juni's.
 * - A beak tap with a multi-poke `count` ≥ 3 is a big quack: a count rule, like the big sneeze, not an escalation.
 * - **Content** (plan Q3): surprise, ticklishness, delight or mild grumpiness only; never pain, fear or crying.
 *
 * Node scripts may import this module, so its relative imports end in `.ts`.
 */
import type { FennClipName } from '../anim/clips/fenn.ts';
import type { BaseReactionClipName } from '../anim/clips/reactions.ts';
import type { SfxId } from '../audio/sfx-ids.ts';
import { STROKE_MIN_PATH } from '../input/recognizer.ts';
import type { Gesture } from '../input/recognizer.ts';
import type { RegionId } from '../input/region-ids.ts';
import { ANNOY, HAPTIC_PURR, HAPTIC_TAP, JOY, REACTIONS } from './table.ts';
import type { Reaction } from './table.ts';

/** A beak `tap down` with a multi-poke `count` of at least this is a big quack. */
const BIG_QUACK_COUNT = 3;

/** Fenn's own reactions, by name. */
export type FennReactionName =
  | 'quack'
  | 'bigQuack'
  | 'beakNibble'
  | 'petTrill'
  | 'fluffRuffle'
  | 'blinkPeepL'
  | 'blinkPeepR'
  | 'wingFlapL'
  | 'wingFlapR'
  | 'wingHighFiveL'
  | 'wingHighFiveR'
  | 'bellyRubTrill'
  | 'footPatL'
  | 'footPatR'
  | 'tailWiggle';

type Priority = Reaction['priority'];
/** The optional fields, with the gentle clip typed against Fenn's clips. */
type Extras = Partial<Pick<Reaction, 'haptic' | 'mood' | 'sfxOnRelease' | 'sfxLoopMs'>> & {
  gentleClip?: FennClipName;
};

/** One frozen reaction playing `clip`, Fenn's or Juni's (which may differ from its name). */
function defClip(
  name: FennReactionName,
  clip: FennClipName | BaseReactionClipName,
  priority: Priority,
  sfx: SfxId | null,
  sustained: boolean,
  extras: Extras = {},
): Reaction {
  return Object.freeze({ name, priority, sfx, clip, sustained, ...extras });
}

// Beak
const quack = defClip('quack', 'quack', 2, 'quack', false, { haptic: HAPTIC_TAP });
const bigQuack = defClip('bigQuack', 'bigQuack', 4, 'bigQuack', false, {
  gentleClip: 'bigQuackGentle',
  haptic: HAPTIC_TAP,
});
const beakNibble = defClip('beakNibble', 'beakNibble', 3, 'nibble', true, { sfxLoopMs: 600 });
// Head top (and belly): the pet trills instead of purring; against the down, the fluff ruffles.
const petTrill = defClip('petTrill', 'pet', 3, 'trill', true, {
  haptic: HAPTIC_PURR,
  mood: JOY,
  sfxLoopMs: 1200,
});
const fluffRuffle = defClip('fluffRuffle', 'fluffRuffle', 3, 'hmph', true, { mood: ANNOY });
// Eyes
const blinkPeepL = defClip('blinkPeepL', 'hardBlinkL', 2, 'peep', false, { haptic: HAPTIC_TAP, mood: ANNOY });
const blinkPeepR = defClip('blinkPeepR', 'hardBlinkR', 2, 'peep', false, { haptic: HAPTIC_TAP, mood: ANNOY });
// Wings
const wingFlapL = defClip('wingFlapL', 'wingFlapL', 2, 'flap', false, { haptic: HAPTIC_TAP });
const wingFlapR = defClip('wingFlapR', 'wingFlapR', 2, 'flap', false, { haptic: HAPTIC_TAP });
const wingHighFiveL = defClip('wingHighFiveL', 'highFiveL', 3, null, true, { sfxOnRelease: 'peep' });
const wingHighFiveR = defClip('wingHighFiveR', 'highFiveR', 3, null, true, { sfxOnRelease: 'peep' });
// Belly
const bellyRubTrill = defClip('bellyRubTrill', 'bellyRub', 3, 'trill', true);
// Feet
const footPatL = defClip('footPatL', 'footPullL', 2, 'pat', false, { haptic: HAPTIC_TAP });
const footPatR = defClip('footPatR', 'footPullR', 2, 'pat', false, { haptic: HAPTIC_TAP });
// Tail
const tailWiggle = defClip('tailWiggle', 'tailWiggle', 2, 'rustle', false, { haptic: HAPTIC_TAP });

/** Fenn's own reactions, by name (Fenn's cast adds them to Juni's `REACTIONS`). */
export const FENN_REACTIONS: Readonly<Record<FennReactionName, Reaction>> = Object.freeze({
  quack,
  bigQuack,
  beakNibble,
  petTrill,
  fluffRuffle,
  blinkPeepL,
  blinkPeepR,
  wingFlapL,
  wingFlapR,
  wingHighFiveL,
  wingHighFiveR,
  bellyRubTrill,
  footPatL,
  footPatR,
  tailWiggle,
});

/** Juni's entry `name`, which Fenn reuses as it is (module setup only). */
function juni(name: BaseReactionClipName): Reaction {
  const r = REACTIONS[name];
  if (r === undefined) throw new Error(`fenn-table: Juni has no reaction ${name}`);
  return r;
}
const tuftBoing = juni('tuftBoing');
const headPress = juni('headPress');
const wobble = juni('wobble');
const cheekPuffL = juni('cheekPuffL');
const cheekPuffR = juni('cheekPuffR');
const blush = juni('blush');
const squish = juni('squish');
const bellyBoing = juni('bellyBoing');
const giggle = juni('giggle');
const hug = juni('hug');
const kickGiggle = juni('kickGiggle');

// ---- gesture → reaction ---------------------------------------------------------------------------------------

/** Fenn's reaction to `g`, or `null` for none (pure; returns a shared frozen entry, never a new object). */
export function fennReactionFor(g: Gesture): Reaction | null {
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
    case 'beak':
      return count >= BIG_QUACK_COUNT ? bigQuack : quack;
    case 'headTop':
      return tuftBoing;
    case 'eyeL':
      return blinkPeepL;
    case 'eyeR':
      return blinkPeepR;
    case 'cheekL':
      return cheekPuffL;
    case 'cheekR':
      return cheekPuffR;
    case 'wingL':
      return wingFlapL;
    case 'wingR':
      return wingFlapR;
    case 'belly':
      return bellyBoing;
    case 'footL':
      return footPatL;
    case 'footR':
      return footPatR;
    case 'tail':
      return tailWiggle;
    default:
      return null;
  }
}

function longPressReaction(region: RegionId): Reaction | null {
  switch (region) {
    case 'beak':
      return beakNibble;
    case 'headTop':
      return headPress;
    case 'wingL':
      return wingHighFiveL;
    case 'wingR':
      return wingHighFiveR;
    case 'belly':
      return bellyRubTrill;
    default:
      return null;
  }
}

function strokeReaction(g: Extract<Gesture, { g: 'stroke' }>): Reaction | null {
  if (g.phase === 'end') return null;
  const petting = g.phase === 'update' && g.pathPx >= STROKE_MIN_PATH;
  switch (g.region) {
    case 'headTop':
      return petting ? (g.against ? fluffRuffle : petTrill) : null;
    case 'belly':
      return petting ? petTrill : null;
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
