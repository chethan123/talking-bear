/**
 * Bone-attached hit regions (plan §4.6.1 "geometric regions attached to bones", §4.6.4, §7 M8; issue #85).
 *
 * Each region is an ellipse in its bone's **rest-pose design space** (the 1000 × 1400 box of `art/bear.svg`,
 * y down), so hit-testing follows the animated pose: `hitTest` maps the CSS point back through the inverse
 * view and the inverse bone matrix, then tests the ellipse there. `REGIONS` is in priority order: the first
 * region that contains the point wins, and a point outside every region is `background`. An id may have more
 * than one region (`headTop`: the head and the tuft); the first is its main one.
 *
 * **Coordinates.** `(x, y)` are CSS px relative to the canvas's top-left corner (`clientX − rect.left`,
 * `clientY − rect.top`), and `view` maps design units to those CSS px: `x_css = scale·x + ox`,
 * `y_css = scale·y + oy`, i.e. `fitView(cssWidth, cssHeight, out)` (`src/anim/renderer.ts`) over the canvas's
 * CSS size. The renderer's own view maps to backing-store px instead: divide its `scale`, `ox` and `oy` by the
 * backing-store-to-CSS ratio (`canvas.width / cssWidth`, ≈ `min(devicePixelRatio, 2)`) to get this one.
 *
 * **Padding** (plan §7 M8: "bear hit regions padded by 12 px beyond the art"): `padCssPx / view.scale` design
 * units are added to both radii, in the bone's space.
 *
 * `hitTest` never allocates: the regions are compiled once, at module load, into typed tables (bone offsets
 * resolved with `boneIndex`), and the per-call inverse transforms live in locals.
 */
import { BONE_COUNT, boneIndex, MAT } from '../anim/rig.ts';
import type { RegionId } from './region-ids.ts';

/** One hit region: an ellipse centred at (`cx`, `cy`) with radii `rx`, `ry`, in design units, bone-local (rest pose). */
export interface RegionDef {
  id: RegionId;
  /** A bone id of `BONES` in `src/art/bear-parts.gen.ts`. */
  bone: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/**
 * The regions, in priority order (first match wins): issue #85's table, with two changes (see the PR):
 * - the paw centres are moved onto the paw art (the table's (255, 940) / (745, 940) lie outside the paws);
 * - a second `headTop` region on the `tuft` bone, right after the head's, covers the tuft (plan §4.6.4's
 *   "Head top / tuft" row): the ellipse inscribed in the `tuftFur` bbox [418, 62, 594, 226].
 */
const TABLE: RegionDef[] = [
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
/** Frozen, array and entries, because `hitTest` reads the typed tables compiled from them at module load. */
export const REGIONS: readonly RegionDef[] = Object.freeze(TABLE.map((r) => Object.freeze(r)));

const COUNT = REGIONS.length;
/** Region `i`'s bone matrix starts at `boneMatrices[OFFSET[i]]`. */
const OFFSET = new Int32Array(COUNT);
const CX = new Float64Array(COUNT);
const CY = new Float64Array(COUNT);
const RX = new Float64Array(COUNT);
const RY = new Float64Array(COUNT);
const ID: readonly RegionId[] = REGIONS.map((r) => r.id);

for (let i = 0; i < COUNT; i++) {
  const r = REGIONS[i]!;
  OFFSET[i] = boneIndex(r.bone) * MAT;
  CX[i] = r.cx;
  CY[i] = r.cy;
  RX[i] = r.rx;
  RY[i] = r.ry;
}

/**
 * The region under the CSS point (`x`, `y`): the first of `REGIONS` whose ellipse, padded by `padCssPx` CSS px,
 * contains it once mapped into its bone's rest-pose space, or `background`. `boneMatrices` is the output of
 * `boneMatrices` (`src/anim/rig.ts`): 6 floats per bone, `BONES` order. `view.scale` must be > 0 and
 * `padCssPx` ≥ 0. A boundary point counts as inside. A bone whose matrix is singular (a zero scale) hits
 * nothing. Never allocates.
 */
export function hitTest(
  x: number,
  y: number,
  boneMatrices: Float32Array,
  view: { scale: number; ox: number; oy: number },
  padCssPx = 12,
): RegionId {
  if (boneMatrices.length < BONE_COUNT * MAT)
    throw new RangeError('hitTest: boneMatrices needs 6 floats per bone');
  const s = view.scale;
  // CSS px → posed design units (the inverse view).
  const px = (x - view.ox) / s;
  const py = (y - view.oy) / s;
  const pad = padCssPx / s;
  for (let i = 0; i < COUNT; i++) {
    const o = OFFSET[i]!;
    const a = boneMatrices[o]!;
    const b = boneMatrices[o + 1]!;
    const c = boneMatrices[o + 2]!;
    const d = boneMatrices[o + 3]!;
    const det = a * d - b * c;
    if (det === 0) continue;
    // Posed → rest-pose design units (the inverse bone matrix), relative to the region's centre.
    const qx = px - boneMatrices[o + 4]!;
    const qy = py - boneMatrices[o + 5]!;
    const u = ((d * qx - c * qy) / det - CX[i]!) / (RX[i]! + pad);
    const v = ((a * qy - b * qx) / det - CY[i]!) / (RY[i]! + pad);
    if (u * u + v * v <= 1) return ID[i]!;
  }
  return 'background';
}
