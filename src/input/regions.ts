/**
 * Bone-attached hit regions (plan §4.6.1 "geometric regions attached to bones", §4.6.4, §7 M8; issue #85).
 *
 * Each region is an ellipse in its bone's **rest-pose design space** (the 1000 × 1400 box of the character's art,
 * y down), so hit-testing follows the animated pose: `hitTest` maps the CSS point back through the inverse
 * view and the inverse bone matrix, then tests the ellipse there. A character's regions (`spec.regions`, e.g.
 * `JUNI.regions` in `src/characters/juni.ts`) are in priority order: the first region that contains the point wins,
 * and a point outside every region is `background`. An id may have more than one region (Juni's `headTop`: the head
 * and the tuft); the first is its main one.
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
 * `hitTest` never allocates: `compileRegions(rig)` compiles a character's regions once, at setup, into typed
 * tables (bone offsets resolved with `boneIndex`), and the per-call inverse transforms live in locals.
 */
import { boneIndex, MAT } from '../anim/rig.ts';
import type { Rig } from '../anim/rig.ts';
import type { RegionId } from './region-ids.ts';

/** One hit region: an ellipse centred at (`cx`, `cy`) with radii `rx`, `ry`, in design units, bone-local (rest pose). */
export interface RegionDef {
  id: RegionId;
  /** A bone id of the character's art (`spec.art.BONES`). */
  bone: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** A character's regions compiled for `hitTest` (`compileRegions`): one entry per region, priority order. */
export interface RegionTable {
  /** The regions it was compiled from (`rig.spec.regions`). */
  readonly defs: readonly RegionDef[];
  /** Number of bones of the rig: `hitTest` needs `boneMatrices.length ≥ boneCount · MAT`. */
  readonly boneCount: number;
  /** Region `i`'s bone matrix starts at `boneMatrices[offset[i]]`. */
  readonly offset: Int32Array;
  readonly cx: Float64Array;
  readonly cy: Float64Array;
  readonly rx: Float64Array;
  readonly ry: Float64Array;
  readonly id: readonly RegionId[];
}

/**
 * Compiles `rig.spec.regions` into typed tables for `hitTest`. Allocates: call it at setup.
 * @throws Error if a region names a bone the rig lacks.
 */
export function compileRegions(rig: Rig): RegionTable {
  const defs = rig.spec.regions;
  const count = defs.length;
  const offset = new Int32Array(count);
  const cx = new Float64Array(count);
  const cy = new Float64Array(count);
  const rx = new Float64Array(count);
  const ry = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const r = defs[i]!;
    offset[i] = boneIndex(rig, r.bone) * MAT;
    cx[i] = r.cx;
    cy[i] = r.cy;
    rx[i] = r.rx;
    ry[i] = r.ry;
  }
  return { defs, boneCount: rig.boneCount, offset, cx, cy, rx, ry, id: defs.map((r) => r.id) };
}

/**
 * The region under the CSS point (`x`, `y`): the first of `table`'s regions whose ellipse, padded by `padCssPx` CSS
 * px, contains it once mapped into its bone's rest-pose space, or `background`. `boneMatrices` is the output of
 * `boneMatrices` (`src/anim/rig.ts`) for the rig `table` was compiled for: 6 floats per bone, `BONES` order.
 * `view.scale` must be > 0 and `padCssPx` ≥ 0. A boundary point counts as inside. A bone whose matrix is singular
 * (a zero scale) hits nothing. Never allocates.
 */
export function hitTest(
  x: number,
  y: number,
  boneMatrices: Float32Array,
  view: { scale: number; ox: number; oy: number },
  table: RegionTable,
  padCssPx = 12,
): RegionId {
  if (boneMatrices.length < table.boneCount * MAT)
    throw new RangeError('hitTest: boneMatrices needs 6 floats per bone');
  const s = view.scale;
  // CSS px → posed design units (the inverse view).
  const px = (x - view.ox) / s;
  const py = (y - view.oy) / s;
  const pad = padCssPx / s;
  const offset = table.offset;
  const cx = table.cx;
  const cy = table.cy;
  const rx = table.rx;
  const ry = table.ry;
  const count = offset.length;
  for (let i = 0; i < count; i++) {
    const o = offset[i]!;
    const a = boneMatrices[o]!;
    const b = boneMatrices[o + 1]!;
    const c = boneMatrices[o + 2]!;
    const d = boneMatrices[o + 3]!;
    const det = a * d - b * c;
    if (det === 0) continue;
    // Posed → rest-pose design units (the inverse bone matrix), relative to the region's centre.
    const qx = px - boneMatrices[o + 4]!;
    const qy = py - boneMatrices[o + 5]!;
    const u = ((d * qx - c * qy) / det - cx[i]!) / (rx[i]! + pad);
    const v = ((a * qy - b * qx) / det - cy[i]!) / (ry[i]! + pad);
    if (u * u + v * v <= 1) return table.id[i]!;
  }
  return 'background';
}
