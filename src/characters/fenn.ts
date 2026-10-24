/**
 * Fenn the duckling (duck plan §4.4, plan §4.6.7): the spec the rig, the renderer, the hit regions, the gaze, the
 * director, the reactions and the texts read (duck plan §4.1). Its art is `art/duck.svg`, generated into
 * `src/art/duck-parts.gen.ts`.
 *
 * Fenn reuses Juni's pose channels: `EarRot`/`EarFold` move the fluff tufts, `ArmRot` the wings, `Kerchief*` the tail
 * feathers, `NoseY`/`NoseWrinkle` the bill and `Jaw`/`MouthW` the lower bill. `MouthRound` and `Teeth` drive nothing on
 * Fenn: the beak is ordinary parts (mouth kind `'parts'`).
 *
 * Node scripts may import this module, so its relative imports end in `.ts`.
 */
import { MIME_CLIPS, REACTION_CLIPS } from '../anim/clips/reactions.ts';
import { SESSION_CLIPS } from '../anim/clips/session.ts';
import { createDirectorCast } from '../anim/director.ts';
import { Ch } from '../anim/pose.ts';
import { BONE, BONES, PART, PARTS } from '../art/duck-parts.gen.ts';
import type { RegionDef } from '../input/regions.ts';
import { REACTIONS } from '../reactions/table.ts';
import type { CharacterSpec, Drive, StarsSpec } from './types.ts';

/** Duck plan §4.4's drives table (same `Term` semantics as Juni's). */
const DRIVES: Readonly<Record<string, Drive>> = {
  head: {
    rot: [Ch.HeadRot, 1],
    tx: [Ch.HeadX, 1],
    ty: [Ch.HeadY, 1],
    sx: [Ch.HeadSquishX, 1],
    sy: [Ch.HeadSquishY, 1],
  },
  neck: { rot: [Ch.HeadTilt, 1] },
  fluffL: { rot: [Ch.EarRotL, 1], sy: [Ch.EarFoldL, -0.5] },
  fluffR: { rot: [Ch.EarRotR, 1], sy: [Ch.EarFoldR, -0.5] },
  tuft: { rot: [Ch.TuftRot, 1] },
  body: { rot: [Ch.BodyLean, 1], sx: [Ch.BodySquash, -0.5], sy: [Ch.BodySquash, 1] },
  belly: { sx: [Ch.BellyJiggle, 1], sy: [Ch.BellyJiggle, 1] },
  wingL: { rot: [Ch.ArmRotL, 1] },
  wingR: { rot: [Ch.ArmRotR, 1] },
  footL: { tx: [Ch.FootL, -30] },
  footR: { tx: [Ch.FootR, 30] },
  tailA: { rot: [Ch.KerchiefA, 1] },
  tailB: { rot: [Ch.KerchiefB, 1] },
  bill: { ty: [Ch.NoseY, 1], sy: [Ch.NoseWrinkle, -0.1] },
  jaw: { ty: [Ch.Jaw, 60], sx: [Ch.MouthW, 0.12] },
  cheekBlushL: { sx: [Ch.CheekPuff, 1], sy: [Ch.CheekPuff, 1] },
  cheekBlushR: { sx: [Ch.CheekPuff, 1], sy: [Ch.CheekPuff, 1] },
  browL: { ty: [Ch.BrowL, -1] },
  browR: { ty: [Ch.BrowR, -1] },
};

/** The dizzy stars, in head-bone space: 3 stars on a circle of radius 330 about the head centre (duck plan §4.4). */
const STARS: StarsSpec = {
  bone: 'head',
  cx: 500,
  cy: 400,
  radius: 330,
  count: 3,
  outer: 26,
  inner: 11,
  fill: '#E2B33C',
};

/** Duck plan §4.5's regions, in priority order (first match wins); 12 CSS px padding as Juni's. */
const REGIONS: RegionDef[] = [
  { id: 'eyeL', bone: 'head', cx: 400, cy: 380, rx: 50, ry: 56 },
  { id: 'eyeR', bone: 'head', cx: 600, cy: 380, rx: 50, ry: 56 },
  { id: 'beak', bone: 'bill', cx: 500, cy: 528, rx: 120, ry: 65 },
  { id: 'cheekL', bone: 'head', cx: 330, cy: 470, rx: 65, ry: 50 },
  { id: 'cheekR', bone: 'head', cx: 670, cy: 470, rx: 65, ry: 50 },
  { id: 'wingL', bone: 'wingL', cx: 255, cy: 860, rx: 70, ry: 140 },
  { id: 'wingR', bone: 'wingR', cx: 745, cy: 860, rx: 70, ry: 140 },
  { id: 'footL', bone: 'footL', cx: 370, cy: 1275, rx: 120, ry: 70 },
  { id: 'footR', bone: 'footR', cx: 630, cy: 1275, rx: 120, ry: 70 },
  { id: 'tail', bone: 'tailA', cx: 815, cy: 1015, rx: 55, ry: 55 },
  { id: 'belly', bone: 'belly', cx: 500, cy: 960, rx: 200, ry: 220 },
  { id: 'headTop', bone: 'head', cx: 500, cy: 400, rx: 290, ry: 250 },
  { id: 'headTop', bone: 'tuft', cx: 520, cy: 115, rx: 70, ry: 60 },
  { id: 'flankL', bone: 'body', cx: 275, cy: 1115, rx: 80, ry: 135 },
  { id: 'flankR', bone: 'body', cx: 725, cy: 1115, rx: 80, ry: 135 },
];

export const FENN: CharacterSpec = {
  id: 'fenn',
  art: { BONES, PARTS, BONE, PART },
  drives: DRIVES,
  gazeParts: ['irisL', 'pupilL', 'highlightL', 'irisR', 'pupilR', 'highlightR'],
  lidParts: { L: 'lidUpperL', R: 'lidUpperR' },
  blushParts: ['blushL', 'blushR'],
  /** The beak is parts on the `bill` and `jaw` bones: nothing parametric. */
  mouth: { kind: 'parts' },
  stars: STARS,
  /** The background gradient, top to bottom (duck plan §4.4). */
  background: { top: '#E9F5F0', bottom: '#C9E6DC' },
  /** Midpoint between the eyes (eyes at (400/600, 380)), in design units. */
  eyesCenter: { x: 500, y: 380 },
  /** Frozen, array and entries: `compileRegions` reads them once into typed tables. */
  regions: Object.freeze(REGIONS.map((r) => Object.freeze(r))),
  names: { name: 'Fenn', stage: 'Fenn the duckling', switchTo: 'Switch to Fenn the duckling' },
  /** Placeholder until T125: Juni's session, reaction and mime clips and escalation targets. */
  cast: createDirectorCast([SESSION_CLIPS, REACTION_CLIPS, MIME_CLIPS], REACTIONS),
  /** Placeholder until T125 (Fenn's reaction table): no gesture reacts. */
  reactionFor: () => null,
};
