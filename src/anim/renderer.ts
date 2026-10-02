/**
 * The Canvas 2D renderer: draws Juni for one pose (plan §4.6.1, §4.6.5, §4.6.6; issue #75).
 *
 * `render` is a pure function of the pose: it walks the parts in draw order with `setTransform`, filling the
 * `Path2D` objects the rig built once, and draws the mouth and the dizzy stars parametrically on the context
 * (`moveTo`, `lineTo`, `quadraticCurveTo`, `bezierCurveTo`, `ellipse`), so no string, path or array is made per frame.
 * (`roundRect` is avoided on purpose: Chromium boxes its double arguments, i.e. it allocates per call.) The mouth
 * is drawn inside `render`'s parts loop, not by a helper of its own: see `render` (#214).
 * The one per-resize object is the background gradient, cached per context and rebuilt only when the backing
 * store's size changes.
 *
 * `view` maps design units to canvas backing-store pixels: `x_px = scale·x + ox`, `y_px = scale·y + oy`.
 */
import { PARTS } from '../art/bear-parts.gen.ts';
import { Ch } from './pose.ts';
import type { Pose } from './pose.ts';
import { boneIndex, boneMatrices, BONE_COUNT, MAT, PartKind, partMatrix } from './rig.ts';
import type { Rig } from './rig.ts';

/** Design units → backing-store pixels. */
export interface View {
  scale: number;
  ox: number;
  oy: number;
}

/** The design box of `art/bear.svg`. */
export const DESIGN_WIDTH = 1000;
export const DESIGN_HEIGHT = 1400;
/** Backing store = CSS size × `min(devicePixelRatio, MAX_DPR)` (plan §4.6.1). */
export const MAX_DPR = 2;
/** The background gradient, top to bottom (plan §4.6.5). */
export const BG_TOP = '#FFF4E0';
export const BG_BOTTOM = '#F3D6B3';
/** Blush alpha at `Blush = 1` (plan §4.6.5: α ≤ 0.35). */
export const BLUSH_ALPHA = 0.35;

/** The mouth, in jaw-bone space (= muzzle space: no channel drives `jaw` in M4). */
export const MOUTH = {
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
} as const;

/** The dizzy stars, in head-bone space: 3 stars on a circle of radius 320 about the head centre (plan §4.6.5). */
export const STARS = {
  cx: 500,
  cy: 400,
  radius: 320,
  count: 3,
  outer: 26,
  inner: 11,
  fill: '#E2B33C',
} as const;

/**
 * The mouth thresholds at float32, the precision pose channels are stored at. `Teeth = 0.3` is stored as
 * 0.30000001, which is `> 0.3`, so comparing against the double 0.3 would show teeth at exactly "0.3".
 */
const TONGUE_MIN = Math.fround(MOUTH.tongueJaw);
const TEETH_MIN = Math.fround(MOUTH.teethMin);

const JAW = boneIndex('jaw');
const HEAD = boneIndex('head');

/** `boneMatrices` output for the current frame. */
const BONE_BUF = new Float32Array(BONE_COUNT * MAT);
/** The current part's matrix. */
const M = new Float64Array(MAT);
/** Unit star: 10 vertices (outer, inner, …) as x, y pairs, the first pointing up. */
const STAR_UNIT = new Float64Array(20);
for (let k = 0; k < 10; k++) {
  const r = k % 2 === 0 ? 1 : STARS.inner / STARS.outer;
  const a = -Math.PI / 2 + (k * Math.PI) / 5;
  STAR_UNIT[2 * k] = r * Math.cos(a);
  STAR_UNIT[2 * k + 1] = r * Math.sin(a);
}

interface Background {
  width: number;
  height: number;
  fill: CanvasGradient;
}

/** The background gradient per context, rebuilt only when the backing store's size changes. */
const backgrounds = new WeakMap<CanvasRenderingContext2D, Background>();

function background(g: CanvasRenderingContext2D, width: number, height: number): CanvasGradient {
  let bg = backgrounds.get(g);
  if (bg === undefined || bg.width !== width || bg.height !== height) {
    const fill = g.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, BG_TOP);
    fill.addColorStop(1, BG_BOTTOM);
    if (bg === undefined) {
      bg = { width, height, fill };
      backgrounds.set(g, bg);
    } else {
      bg.width = width;
      bg.height = height;
      bg.fill = fill;
    }
  }
  return bg.fill;
}

/** The 2D context the renderer expects: `getContext('2d', { alpha: false })`. Throws if the canvas has none. */
export function createContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = canvas.getContext('2d', { alpha: false });
  if (g === null) throw new Error('canvas has no 2d context');
  return g;
}

/** Sets the backing store to the CSS size × `min(devicePixelRatio, 2)`, rounded. Doesn't touch CSS. */
export function resizeCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): void {
  const dpr = Math.min(devicePixelRatio, MAX_DPR);
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
}

/** Fits the design box into `width × height` pixels, centred; writes `out` and returns it. */
export function fitView(width: number, height: number, out: View): View {
  const scale = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT);
  out.scale = scale;
  out.ox = (width - DESIGN_WIDTH * scale) / 2;
  out.oy = (height - DESIGN_HEIGHT * scale) / 2;
  return out;
}

/** `setTransform(view × bone matrix of bone i)`. */
function setBoneTransform(g: CanvasRenderingContext2D, i: number, view: View): void {
  const o = i * MAT;
  const s = view.scale;
  g.setTransform(
    s * BONE_BUF[o]!,
    s * BONE_BUF[o + 1]!,
    s * BONE_BUF[o + 2]!,
    s * BONE_BUF[o + 3]!,
    s * BONE_BUF[o + 4]! + view.ox,
    s * BONE_BUF[o + 5]! + view.oy,
  );
}

/** 3 stars on a circle of radius 320 about the head centre, at phase `Stars·2π`, each spun by the phase. */
function drawStars(g: CanvasRenderingContext2D, pose: Pose, view: View): void {
  const phase = pose[Ch.Stars]! * 2 * Math.PI;
  const cs = Math.cos(phase) * STARS.outer;
  const sn = Math.sin(phase) * STARS.outer;
  setBoneTransform(g, HEAD, view);
  g.globalAlpha = 1;
  g.beginPath();
  for (let s = 0; s < STARS.count; s++) {
    const a = phase + (s * 2 * Math.PI) / STARS.count;
    const sx = STARS.cx + STARS.radius * Math.cos(a);
    const sy = STARS.cy + STARS.radius * Math.sin(a);
    for (let k = 0; k < 10; k++) {
      const ux = STAR_UNIT[2 * k]!;
      const uy = STAR_UNIT[2 * k + 1]!;
      const px = sx + ux * cs - uy * sn;
      const py = sy + ux * sn + uy * cs;
      if (k === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
  }
  g.fillStyle = STARS.fill;
  g.fill();
}

/**
 * Draws `pose`: the background, every part in draw order (`setTransform(view × bone [× part] [× mirror])`,
 * `fillStyle`, `globalAlpha`, `fill(path)`), the eyes' sclera clip, the mouth and the stars. Never allocates
 * after the first frame at a given canvas size.
 *
 * The mouth is drawn inside the parts loop, at `rig.mouthSlot` (the extra pass `i === PARTS.length` when it
 * comes after every part), rather than by a helper: V8 compiles this loop with its optimising tier within the
 * first few thousand frames, and its canvas calls then pass doubles without allocating, while a loop-free helper
 * called once per frame stays for the first ~10 000–20 000 frames in V8's mid tier, which boxes every double it
 * passes to a canvas method as a new heap number (#214).
 */
export function render(g: CanvasRenderingContext2D, rig: Rig, pose: Pose, view: View): void {
  const width = g.canvas.width;
  const height = g.canvas.height;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.fillStyle = background(g, width, height);
  g.fillRect(0, 0, width, height);

  boneMatrices(rig, pose, BONE_BUF);
  const s = view.scale;
  const count = PARTS.length;
  let clipped = false;
  // i === count is the mouth's slot when it draws after every part.
  for (let i = 0; i <= count; i++) {
    const kind = i < count ? rig.kind[i]! : PartKind.plain;
    if (clipped && kind !== PartKind.gaze) {
      g.restore();
      clipped = false;
    }
    if (i === rig.mouthSlot) {
      // The mouth, in jaw-bone space at `MOUTH.x/y`. The interior is closed by two cubics: the top lip curve
      // (left corner → right corner) and the jaw curve (back). `MouthRound` pulls the corners in by up to 30 %,
      // lifts the top curve and widens the jaw curve's control points towards an ellipse. The tongue (an
      // ellipse) and the teeth (a rounded rect along the top) are clipped to the interior. Nothing shows while
      // the mouth is shut (open < 0.5 design units): the upper lip line is the closed mouth.
      // Clamps are written out, not a helper: a call V8 doesn't inline boxes doubles (allocates).
      const jawRaw = pose[Ch.Jaw]!;
      const jaw = jawRaw < 0 ? 0 : jawRaw > 1 ? 1 : jawRaw;
      const open = MOUTH.openRange * jaw;
      if (open >= 0.5) {
        const roundRaw = pose[Ch.MouthRound]!;
        const round = roundRaw < 0 ? 0 : roundRaw > 1 ? 1 : roundRaw;
        const wRaw = pose[Ch.MouthW]!;
        const w = wRaw < 0 ? 0 : wRaw > 1 ? 1 : wRaw;
        const hw = 0.5 * (MOUTH.minWidth + MOUTH.widthRange * w) * (1 - 0.3 * round);
        const x = MOUTH.x;
        const y = MOUTH.y;
        const top = open * (0.16 - 0.36 * round);
        const cx = hw * (0.55 + 0.45 * round);
        const bottom = (4 / 3) * open;
        const o = JAW * MAT;
        g.setTransform(
          s * BONE_BUF[o]!,
          s * BONE_BUF[o + 1]!,
          s * BONE_BUF[o + 2]!,
          s * BONE_BUF[o + 3]!,
          s * BONE_BUF[o + 4]! + view.ox,
          s * BONE_BUF[o + 5]! + view.oy,
        );
        g.globalAlpha = 1;
        g.beginPath();
        g.moveTo(x - hw, y);
        g.bezierCurveTo(x - 0.5 * hw, y + top, x + 0.5 * hw, y + top, x + hw, y);
        g.bezierCurveTo(x + cx, y + bottom, x - cx, y + bottom, x - hw, y);
        g.closePath();
        g.fillStyle = MOUTH.interior;
        g.fill();
        const tongue = jaw > TONGUE_MIN;
        const teeth = pose[Ch.Teeth]! > TEETH_MIN;
        if (tongue || teeth) {
          g.save();
          g.clip();
          if (tongue) {
            g.beginPath();
            g.ellipse(x, y + 0.8 * open, 0.55 * hw, 0.34 * open, 0, 0, 2 * Math.PI);
            g.fillStyle = MOUTH.tongue;
            g.fill();
          }
          if (teeth) {
            // A rounded rect along the top edge, its top hidden above the clip, with quadraticCurveTo corners.
            const r = 4;
            const tx0 = x - 0.5 * hw;
            const tx1 = x + 0.5 * hw;
            const ty0 = y + 0.75 * top - 10;
            const ty1 = ty0 + 14 + 0.12 * open;
            g.beginPath();
            g.moveTo(tx0 + r, ty0);
            g.lineTo(tx1 - r, ty0);
            g.quadraticCurveTo(tx1, ty0, tx1, ty0 + r);
            g.lineTo(tx1, ty1 - r);
            g.quadraticCurveTo(tx1, ty1, tx1 - r, ty1);
            g.lineTo(tx0 + r, ty1);
            g.quadraticCurveTo(tx0, ty1, tx0, ty1 - r);
            g.lineTo(tx0, ty0 + r);
            g.quadraticCurveTo(tx0, ty0, tx0 + r, ty0);
            g.closePath();
            g.fillStyle = MOUTH.teeth;
            g.fill();
          }
          g.restore();
        }
      }
    }
    if (i === count) break;
    const part = PARTS[i]!;
    let alpha = part.opacity;
    if (kind === PartKind.blush) {
      const blush = pose[Ch.Blush]!;
      alpha = BLUSH_ALPHA * (blush < 0 ? 0 : blush > 1 ? 1 : blush);
    } else if (kind === PartKind.lidL) alpha = pose[Ch.LidL]! > 0 ? alpha : 0;
    else if (kind === PartKind.lidR) alpha = pose[Ch.LidR]! > 0 ? alpha : 0;
    if (alpha <= 0 && !part.clip) continue;
    partMatrix(rig, pose, BONE_BUF, i, M);
    g.setTransform(s * M[0]!, s * M[1]!, s * M[2]!, s * M[3]!, s * M[4]! + view.ox, s * M[5]! + view.oy);
    const path = rig.paths[i]!;
    if (alpha > 0) {
      g.globalAlpha = alpha;
      g.fillStyle = part.fill;
      g.fill(path);
    }
    if (part.clip) {
      g.save();
      g.clip(path);
      clipped = true;
    }
  }
  if (pose[Ch.Stars]! > 0) drawStars(g, pose, view);
  g.globalAlpha = 1;
}
