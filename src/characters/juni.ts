/**
 * Juni the bear (plan §4.6): the spec the rig, the renderer, the hit regions, the gaze and the texts read (duck plan
 * §4.1). Its art is `art/bear.svg`, generated into `src/art/bear-parts.gen.ts`.
 *
 * Node scripts import this module (scripts/gesture-eval.ts), so its relative imports end in `.ts`.
 */
import { BONE, BONES, PART, PARTS } from '../art/bear-parts.gen.ts';
import { Ch } from '../anim/pose.ts';
import type { RegionDef } from '../input/regions.ts';
import type { CharacterSpec, Drive, MouthSpec, StarsSpec } from './types.ts';

/**
 * Issue #75's channel → bone table. `IrisX/Y`, `IrisConverge` and `LidL/R` are part-level (`partMatrix`); `Blush` is
 * the renderer's alpha.
 */
const DRIVES: Readonly<Record<string, Drive>> = {
  head: {
    rot: [Ch.HeadRot, 1],
    tx: [Ch.HeadX, 1],
    ty: [Ch.HeadY, 1],
    sx: [Ch.HeadSquishX, 1],
    sy: [Ch.HeadSquishY, 1],
  },
  neck: { rot: [Ch.HeadTilt, 1] },
  earL: { rot: [Ch.EarRotL, 1], sy: [Ch.EarFoldL, -0.5] },
  earR: { rot: [Ch.EarRotR, 1], sy: [Ch.EarFoldR, -0.5] },
  tuft: { rot: [Ch.TuftRot, 1] },
  body: { rot: [Ch.BodyLean, 1], sx: [Ch.BodySquash, -0.5], sy: [Ch.BodySquash, 1] },
  belly: { sx: [Ch.BellyJiggle, 1], sy: [Ch.BellyJiggle, 1] },
  armL: { rot: [Ch.ArmRotL, 1] },
  armR: { rot: [Ch.ArmRotR, 1] },
  footL: { tx: [Ch.FootL, -30] },
  footR: { tx: [Ch.FootR, 30] },
  tailA: { rot: [Ch.KerchiefA, 1] },
  tailB: { rot: [Ch.KerchiefB, 1] },
  nose: { ty: [Ch.NoseY, 1], sy: [Ch.NoseWrinkle, -0.15] },
  cheekBlushL: { sx: [Ch.CheekPuff, 1], sy: [Ch.CheekPuff, 1] },
  cheekBlushR: { sx: [Ch.CheekPuff, 1], sy: [Ch.CheekPuff, 1] },
  browL: { ty: [Ch.BrowL, -1] },
  browR: { ty: [Ch.BrowR, -1] },
};

/** The mouth, in jaw-bone space (= muzzle space: no channel drives `jaw` in M4), drawn after the muzzle's parts. */
const MOUTH: MouthSpec = {
  kind: 'lips',
  bone: 'jaw',
  afterSubtree: 'muzzle',
  x: 500,
  y: 525,
  /** width = 60 + 90·MouthW */
  minWidth: 60,
  widthRange: 90,
  /** open = 110·Jaw */
  openRange: 110,
  /** The tongue shows when `Jaw` > this. */
  tongueJaw: 0.15,
  /** The teeth show when `Teeth` > this. */
  teethMin: 0.3,
  interior: '#5A1E2E',
  tongue: '#E07A7A',
  teeth: '#FFFFFF',
};

/** The dizzy stars, in head-bone space: 3 stars on a circle of radius 320 about the head centre (plan §4.6.5). */
const STARS: StarsSpec = {
  bone: 'head',
  cx: 500,
  cy: 400,
  radius: 320,
  count: 3,
  outer: 26,
  inner: 11,
  fill: '#E2B33C',
};

/**
 * The regions, in priority order (first match wins): issue #85's table, with two changes (see the PR):
 * - the paw centres are moved onto the paw art (the table's (255, 940) / (745, 940) lie outside the paws);
 * - a second `headTop` region on the `tuft` bone, right after the head's, covers the tuft (plan §4.6.4's
 *   "Head top / tuft" row): the ellipse inscribed in the `tuftFur` bbox [418, 62, 594, 226].
 */
const REGIONS: RegionDef[] = [
  { id: 'eyeL', bone: 'head', cx: 405, cy: 385, rx: 45, ry: 52 },
  { id: 'eyeR', bone: 'head', cx: 595, cy: 385, rx: 45, ry: 52 },
  { id: 'nose', bone: 'nose', cx: 500, cy: 470, rx: 45, ry: 35 },
  { id: 'earL', bone: 'earL', cx: 285, cy: 195, rx: 90, ry: 90 },
  { id: 'earR', bone: 'earR', cx: 715, cy: 195, rx: 90, ry: 90 },
  { id: 'cheekL', bone: 'head', cx: 340, cy: 470, rx: 70, ry: 55 },
  { id: 'cheekR', bone: 'head', cx: 660, cy: 470, rx: 70, ry: 55 },
  { id: 'neckerchief', bone: 'neckerchief', cx: 500, cy: 640, rx: 170, ry: 50 },
  { id: 'pawL', bone: 'pawL', cx: 328, cy: 876, rx: 60, ry: 60 },
  { id: 'pawR', bone: 'pawR', cx: 672, cy: 876, rx: 60, ry: 60 },
  { id: 'footL', bone: 'footL', cx: 350, cy: 1270, rx: 110, ry: 85 },
  { id: 'footR', bone: 'footR', cx: 650, cy: 1270, rx: 110, ry: 85 },
  { id: 'belly', bone: 'belly', cx: 500, cy: 930, rx: 190, ry: 220 },
  { id: 'headTop', bone: 'head', cx: 500, cy: 400, rx: 290, ry: 235 },
  { id: 'headTop', bone: 'tuft', cx: 506, cy: 144, rx: 88, ry: 82 },
  { id: 'flankL', bone: 'body', cx: 300, cy: 1050, rx: 90, ry: 150 },
  { id: 'flankR', bone: 'body', cx: 700, cy: 1050, rx: 90, ry: 150 },
];

export const JUNI: CharacterSpec = {
  id: 'juni',
  art: { BONES, PARTS, BONE, PART },
  drives: DRIVES,
  gazeParts: ['irisL', 'pupilL', 'highlightL', 'irisR', 'pupilR', 'highlightR'],
  lidParts: { L: 'lidUpperL', R: 'lidUpperR' },
  blushParts: ['blushL', 'blushR'],
  mouth: MOUTH,
  stars: STARS,
  /** The background gradient, top to bottom (plan §4.6.5). */
  background: { top: '#FFF4E0', bottom: '#F3D6B3' },
  /** Midpoint between the eyes (plan §4.6.5: eyes at (405/595, 385)), in design units. */
  eyesCenter: { x: 500, y: 385 },
  /** Frozen, array and entries: `compileRegions` reads them once into typed tables. */
  regions: Object.freeze(REGIONS.map((r) => Object.freeze(r))),
  names: { name: 'Juni', stage: 'Juni the bear', switchTo: 'Switch to Juni the bear' },
};
