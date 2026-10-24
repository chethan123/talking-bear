/**
 * A character's data (duck plan §4.1): everything the rig, the renderer, the hit regions, the gaze, the director, the
 * reactions and the texts read about one character. The engine code is character-agnostic; each character is a `CharacterSpec` value
 * (`src/characters/juni.ts`, `src/characters/fenn.ts`), listed in `CHARACTERS` (`src/characters/index.ts`).
 *
 * Node scripts import this module (scripts/gesture-eval.ts), so its relative imports end in `.ts` and it uses
 * erasable syntax only.
 */
import type { DirectorCast } from '../anim/director.ts';
import type { Bone, Part } from '../art/bear-parts.gen.ts';
import type { Gesture } from '../input/recognizer.ts';
import type { RegionDef } from '../input/regions.ts';
import type { Reaction } from '../reactions/table.ts';

/** The characters there are: Juni the bear and Fenn the duckling. */
export type CharacterId = 'juni' | 'fenn';

/** A character's generated art module (`src/art/*-parts.gen.ts`). */
export interface CharacterArt {
  readonly BONES: readonly Bone[];
  readonly PARTS: readonly Part[];
  readonly BONE: Readonly<Record<string, number>>;
  readonly PART: Readonly<Record<string, number>>;
}

/** One term `k · pose[ch]`. */
export type Term = readonly [ch: number, k: number];

/** What drives a bone. Rotation `k·v` rad; translation `k·v` design units in the parent's space; scale `1 + k·v`. */
export interface Drive {
  readonly rot?: Term;
  readonly tx?: Term;
  readonly ty?: Term;
  readonly sx?: Term;
  readonly sy?: Term;
}

/** How the renderer draws the mouth. */
export type MouthSpec =
  | {
      /** Parametric lips, tongue and teeth, drawn by the renderer inside its parts loop (#214). */
      readonly kind: 'lips';
      /** The bone whose space the mouth is drawn in. */
      readonly bone: string;
      /** The mouth draws right after the last part of this bone's subtree. */
      readonly afterSubtree: string;
      /** The mouth's anchor, in `bone` space. */
      readonly x: number;
      readonly y: number;
      /** width = minWidth + widthRange·MouthW */
      readonly minWidth: number;
      readonly widthRange: number;
      /** open = openRange·Jaw */
      readonly openRange: number;
      /** The tongue shows when `Jaw` > this. */
      readonly tongueJaw: number;
      /** The teeth show when `Teeth` > this. */
      readonly teethMin: number;
      readonly interior: string;
      readonly tongue: string;
      readonly teeth: string;
    }
  /** The mouth is ordinary parts on bones driven by `Jaw` / `MouthW`: nothing parametric. */
  | { readonly kind: 'parts' };

/** The dizzy stars, in `bone` space: `count` stars on a circle of `radius` about (`cx`, `cy`). */
export interface StarsSpec {
  readonly bone: string;
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly count: number;
  readonly outer: number;
  readonly inner: number;
  readonly fill: string;
}

/** The character's names, for the accessible names, the announcements and the parent texts. */
export interface CharacterNames {
  /** 'Juni' */
  readonly name: string;
  /** The canvas stage's accessible name: 'Juni the bear'. */
  readonly stage: string;
  /** The swap button's label when this is the *other* character: 'Switch to Juni the bear'. */
  readonly switchTo: string;
}

export interface CharacterSpec {
  readonly id: CharacterId;
  readonly art: CharacterArt;
  /** The channel → bone table, by bone id. */
  readonly drives: Readonly<Record<string, Drive>>;
  /** The gaze parts (`PartKind.gaze`): iris, pupil, highlight of the left eye, then the right. */
  readonly gazeParts: readonly string[];
  /** The upper lids (`PartKind.lidL`, `PartKind.lidR`). */
  readonly lidParts: { readonly L: string; readonly R: string };
  /** The blush parts (`PartKind.blush`). */
  readonly blushParts: readonly string[];
  readonly mouth: MouthSpec;
  readonly stars: StarsSpec;
  /** The background gradient, top to bottom. */
  readonly background: { readonly top: string; readonly bottom: string };
  /** The midpoint between the eyes, in design units: the gaze's and the ears' reference point. */
  readonly eyesCenter: { readonly x: number; readonly y: number };
  /** The hit regions, in priority order (first match wins). */
  readonly regions: readonly RegionDef[];
  readonly names: CharacterNames;
  /** The clips and escalation targets the director plays for this character (`createDirectorCast`). */
  readonly cast: DirectorCast;
  /** The character's reactions table: a recognised gesture's reaction, or null (pure, allocates nothing). */
  readonly reactionFor: (g: Gesture) => Reaction | null;
}
