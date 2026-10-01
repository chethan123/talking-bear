// Lab page for the rig: the SVG DOM debug view (plan §4.6.1 "Keep SVG DOM as a debug view", §7 M4 "Debug")
// and the X-A1 stress helper (plan §5). One slider per pose channel drives a pose that is drawn side by side as
// SVG DOM, built from the generated parts with the rig's matrices as `transform` attributes, and by the app's
// Canvas 2D renderer, with their max pixel difference sampled once a second. Dev-only: `pnpm dev`, then /lab/rig.html (docs/lab.md). No audio is involved; the log is
// text only. Lab pages set no CSS `style`: SVG geometry and every size are attributes.

import { el, fmt, logPanel } from './common.ts';
import type { Attrs } from './common.ts';
import { BONES, PARTS } from '../src/art/bear-parts.gen.ts';
import { Ch, CH_COUNT, createPose } from '../src/anim/pose.ts';
import type { Pose } from '../src/anim/pose.ts';
import { POSES } from '../src/anim/poses.ts';
import type { PoseName } from '../src/anim/poses.ts';
import {
  BG_BOTTOM,
  BG_TOP,
  BLUSH_ALPHA,
  createContext,
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  fitView,
  render,
} from '../src/anim/renderer.ts';
import type { View } from '../src/anim/renderer.ts';
import { BONE_COUNT, boneMatrices, createRig, MAT, PartKind, partMatrix } from '../src/anim/rig.ts';

const DEG = Math.PI / 180;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** CSS size of each view in the comparison: the 1000 × 1400 design box at scale 0.36, one backing px per CSS px. */
const VIEW_W = 360;
const VIEW_H = 504;
/** The pixel difference is sampled this often. */
const SAMPLE_MS = 1000;
/** A pixel whose largest channel |Δ| (of 255) exceeds this is counted as a real disagreement, not anti-aliasing. */
const DIFF_COUNT_MIN = 64;
/** The channels only the canvas draws (the mouth and the stars): zero in the parts-only reference. */
const CANVAS_ONLY = [Ch.Jaw, Ch.MouthW, Ch.MouthRound, Ch.Teeth, Ch.Stars] as const;

// ---- channels -----------------------------------------------------------------------------------------------

type ChName = keyof typeof Ch;

/** How a slider shows its value: radians (plus degrees), design units, a scale delta (scale = 1 + v), or 0–1. */
type Unit = 'rad' | 'units' | 'delta' | 'unit';

/** A slider: `min`, `max` and `step` in slider units; the channel value is the slider value × `scale`. */
interface Range {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly scale: number;
  readonly unit: Unit;
}

/** Rotations and tilts (radians, clockwise-positive on screen): the slider moves in degrees, ±90° in 0.5° steps. */
const ROT: Range = { min: -90, max: 90, step: 0.5, scale: DEG, unit: 'rad' };
/** Squish, squash and jiggle: scale = 1 + v. */
const DELTA: Range = { min: -0.5, max: 0.5, step: 0.005, scale: 1, unit: 'delta' };
/** Lids, mouth, folds, wrinkle, puff, blush, stars phase. */
const UNIT: Range = { min: 0, max: 1, step: 0.01, scale: 1, unit: 'unit' };
const HEAD_OFFSET: Range = { min: -50, max: 50, step: 0.5, scale: 1, unit: 'units' };
/** `IrisX` / `IrisY`: at most 10 design units (pose.ts). */
const IRIS: Range = { min: -10, max: 10, step: 0.1, scale: 1, unit: 'units' };
/** Brows (positive up) and `NoseY` (positive down): design units. */
const SMALL_OFFSET: Range = { min: -20, max: 20, step: 0.5, scale: 1, unit: 'units' };
/** `FootL` / `FootR`: the foot moves 30·v design units outward. */
const FOOT: Range = { min: -1, max: 1, step: 0.01, scale: 1, unit: 'unit' };

/** One slider range per channel, suited to the channel's units (pose.ts, rig.ts). */
const RANGES: { readonly [K in ChName]: Range } = {
  HeadRot: ROT,
  HeadTilt: ROT,
  HeadX: HEAD_OFFSET,
  HeadY: HEAD_OFFSET,
  HeadSquishX: DELTA,
  HeadSquishY: DELTA,
  Jaw: UNIT,
  MouthW: UNIT,
  MouthRound: UNIT,
  Teeth: UNIT,
  LidL: UNIT,
  LidR: UNIT,
  IrisX: IRIS,
  IrisY: IRIS,
  BrowL: SMALL_OFFSET,
  BrowR: SMALL_OFFSET,
  EarRotL: ROT,
  EarRotR: ROT,
  EarFoldL: UNIT,
  EarFoldR: UNIT,
  NoseY: SMALL_OFFSET,
  NoseWrinkle: UNIT,
  CheekPuff: UNIT,
  Blush: UNIT,
  TuftRot: ROT,
  BodySquash: DELTA,
  BodyLean: ROT,
  BellyJiggle: DELTA,
  ArmRotL: ROT,
  ArmRotR: ROT,
  FootL: FOOT,
  FootR: FOOT,
  KerchiefA: ROT,
  KerchiefB: ROT,
  Stars: UNIT,
};

const CH_NAMES = Object.keys(Ch).filter((name): name is ChName => name in Ch);
if (CH_NAMES.length !== CH_COUNT)
  throw new Error(`lab/rig: ${CH_NAMES.length} channel names, ${CH_COUNT} channels`);
const POSE_NAMES = Object.keys(POSES).filter((name): name is PoseName => name in POSES);

function valueText(v: number, unit: Unit): string {
  if (unit === 'rad') return `${fmt(v, 3)} rad (${fmt(v / DEG, 1)}°)`;
  if (unit === 'units') return `${fmt(v, 1)} units`;
  if (unit === 'delta') return `${fmt(v, 3)} (scale ${fmt(1 + v, 3)})`;
  return fmt(v, 2);
}

// ---- rig, views and page ------------------------------------------------------------------------------------

const rig = createRig();
/** The sliders' pose: what both views show. */
const base = createPose();
/** Bumped by every change of `base`. */
let version = 0;

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: readonly Node[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

/**
 * The SVG DOM view: the background gradient, then one `<path>` per part in `PARTS` order. The gaze parts after a
 * `clip: true` sclera go in a group clipped to that sclera, as `render` clips them. Every path's `transform` is the
 * renderer's draw matrix for the part (`partMatrix`: bone × part-level × mirror); the mouth and the stars are
 * canvas-only.
 */
const svg = svgEl('svg', {
  width: String(VIEW_W),
  height: String(VIEW_H),
  viewBox: `0 0 ${DESIGN_WIDTH} ${DESIGN_HEIGHT}`,
  role: 'img',
  'aria-label': 'SVG DOM view',
});
const svgParts: SVGPathElement[] = [];
/** The `<path>` inside each sclera's `<clipPath>`, by part index: it takes the sclera's transform too. */
const svgClips = new Map<number, SVGPathElement>();
{
  const defs = svgEl(
    'defs',
    {},
    svgEl(
      'linearGradient',
      { id: 'rig-bg', x1: '0', y1: '0', x2: '0', y2: '1' },
      svgEl('stop', { offset: '0', 'stop-color': BG_TOP }),
      svgEl('stop', { offset: '1', 'stop-color': BG_BOTTOM }),
    ),
  );
  svg.append(
    defs,
    svgEl('rect', { width: String(DESIGN_WIDTH), height: String(DESIGN_HEIGHT), fill: 'url(#rig-bg)' }),
  );
  let clipGroup: SVGGElement | null = null;
  for (let i = 0; i < PARTS.length; i++) {
    const part = PARTS[i]!;
    if (rig.kind[i] !== PartKind.gaze) clipGroup = null;
    const path = svgEl('path', {
      d: part.d,
      fill: part.fill,
      'fill-opacity': String(part.opacity),
      'data-part': part.id,
      'data-bone': BONES[part.bone]!.id,
    });
    (clipGroup ?? svg).append(path);
    svgParts.push(path);
    if (part.clip) {
      const id = `rig-clip-${part.id}`;
      const clipPath = svgEl('path', { d: part.d });
      defs.append(svgEl('clipPath', { id }, clipPath));
      svgClips.set(i, clipPath);
      clipGroup = svgEl('g', { 'clip-path': `url(#${id})` });
      svg.append(clipGroup);
    }
  }
}

const canvas = el('canvas', {
  width: String(VIEW_W),
  height: String(VIEW_H),
  'aria-label': 'Canvas 2D view',
});
const g = createContext(canvas);
const compareView: View = fitView(VIEW_W, VIEW_H, { scale: 0, ox: 0, oy: 0 });

/** A canvas the page reads back; never the visible one, which must stay as the renderer uses it. */
function readbackContext(): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = VIEW_W;
  c.height = VIEW_H;
  const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
  if (ctx === null) throw new Error('lab/rig: no 2D canvas context');
  return ctx;
}
/** The renderer's drawing of the SVG view's pose, of that pose without the mouth and stars, and the SVG image. */
const refG = readbackContext();
const partsG = readbackContext();
const imgG = readbackContext();

const root = document.getElementById('lab');
if (!(root instanceof HTMLElement)) throw new Error('lab/rig: missing #lab');

const poseSelect = el(
  'select',
  {},
  el('option', { value: '' }, '(custom)'),
  ...POSE_NAMES.map((name) => el('option', { value: name }, name)),
);
const resetButton = el('button', { type: 'button' }, 'Reset');

const show = {
  diff: el('dd'),
  diffParts: el('dd'),
};

interface Slider {
  readonly name: ChName;
  readonly ch: number;
  readonly range: Range;
  readonly input: HTMLInputElement;
  readonly value: HTMLOutputElement;
}

const sliders: readonly Slider[] = CH_NAMES.map((name) => {
  const range = RANGES[name];
  const id = `ch-${name}`;
  const input = el('input', {
    type: 'range',
    id,
    min: String(range.min),
    max: String(range.max),
    step: String(range.step),
    value: '0',
  });
  return { name, ch: Ch[name], range, input, value: el('output', { for: id }) };
});

function row(term: string | HTMLElement, value: HTMLElement): HTMLElement[] {
  return [el('dt', {}, term), value.tagName === 'DD' ? value : el('dd', {}, value)];
}

const stressFieldset = el('fieldset', {}, el('legend', {}, 'Stress (X-A1)'));

root.append(
  el('fieldset', {}, el('legend', {}, 'Pose'), el('label', {}, 'Key pose: ', poseSelect), ' ', resetButton),
  stressFieldset,
  el('h2', {}, 'Views'),
  el('p', {}, 'Left: SVG DOM (parts and bone matrices). Right: the Canvas 2D renderer.'),
  el('div', {}, svg, ' ', canvas),
  el(
    'dl',
    { class: 'lab-values' },
    ...row('Max pixel difference (views)', show.diff),
    ...row('Max pixel difference (parts only: mouth and stars excluded)', show.diffParts),
  ),
  el('h2', {}, 'Channels'),
  el(
    'dl',
    { class: 'lab-values' },
    ...sliders.flatMap((s) =>
      row(el('label', { for: s.input.id }, s.name), el('dd', {}, s.input, ' ', s.value)),
    ),
  ),
);
const log = logPanel(root);

// ---- static views -------------------------------------------------------------------------------------------

const BONE_BUF = new Float32Array(BONE_COUNT * MAT);
const PART_M = new Float64Array(MAT);
/** The pose the SVG view shows, and its `version`: the pixel difference renders exactly this pose. */
const svgPose = createPose();
let svgVersion = -1;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The renderer's alpha for part `i` (renderer.ts): blush from `Blush`, upper lids hidden while open. */
function partAlpha(i: number, pose: Pose): number {
  const kind = rig.kind[i];
  const opacity = PARTS[i]!.opacity;
  if (kind === PartKind.blush) return BLUSH_ALPHA * clamp01(pose[Ch.Blush]!);
  if (kind === PartKind.lidL) return pose[Ch.LidL]! > 0 ? opacity : 0;
  if (kind === PartKind.lidR) return pose[Ch.LidR]! > 0 ? opacity : 0;
  return opacity;
}

/** Writes every part's draw matrix (and its alpha) to the SVG view as attributes. */
function updateSvg(pose: Pose): void {
  boneMatrices(rig, pose, BONE_BUF);
  for (let i = 0; i < PARTS.length; i++) {
    partMatrix(rig, pose, BONE_BUF, i, PART_M);
    const m = `matrix(${PART_M[0]!} ${PART_M[1]!} ${PART_M[2]!} ${PART_M[3]!} ${PART_M[4]!} ${PART_M[5]!})`;
    svgParts[i]!.setAttribute('transform', m);
    svgParts[i]!.setAttribute('fill-opacity', String(partAlpha(i, pose)));
    svgClips.get(i)?.setAttribute('transform', m);
  }
  svgPose.set(pose);
  svgVersion = version;
}

let pendingStatic = 0;

/** Draws `base` in both views (once per frame at most). */
function drawStatic(): void {
  pendingStatic = 0;
  render(g, rig, base, compareView);
  updateSvg(base);
}

/** Notes a change of `base` and schedules both views. */
function changed(): void {
  version++;
  if (pendingStatic === 0) pendingStatic = requestAnimationFrame(drawStatic);
}

function syncSliders(): void {
  for (const s of sliders) {
    const v = base[s.ch]!;
    s.input.value = String(v / s.range.scale);
    s.value.textContent = valueText(v, s.range.unit);
  }
}

// ---- pixel difference ---------------------------------------------------------------------------------------

const serializer = new XMLSerializer();
/** The SVG view's pose with the canvas-only channels at 0. */
const partsPose = createPose();
let sampling = false;
let sampledVersion = -1;

interface Diff {
  /** The largest channel difference over all pixels, 0–255. */
  readonly max: number;
  /** Pixels whose largest channel difference exceeds `DIFF_COUNT_MIN`. */
  readonly over: number;
}

/** Compares two RGBA buffers of the same size: per pixel, the largest |Δ| of R, G and B. */
function diffStats(a: Uint8ClampedArray, b: Uint8ClampedArray): Diff {
  let max = 0;
  let over = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(
      Math.abs(a[i]! - b[i]!),
      Math.abs(a[i + 1]! - b[i + 1]!),
      Math.abs(a[i + 2]! - b[i + 2]!),
    );
    if (d > max) max = d;
    if (d > DIFF_COUNT_MIN) over++;
  }
  return { max, over };
}

function diffText(d: Diff): string {
  return `${d.max} of 255; ${d.over} of ${VIEW_W * VIEW_H} pixels differ by more than ${DIFF_COUNT_MIN}`;
}

/**
 * Rasterises the SVG view as an image and compares it, with `getImageData`, with the renderer's drawing of the
 * same pose at the same size (the views), and with the renderer's drawing of that pose without the mouth and
 * the stars (parts only: a real mismatch between the rig and the SVG view shows there whatever the mouth does).
 * Skipped while a sample is in flight and when the SVG view hasn't changed since the last one.
 */
async function sampleDiff(): Promise<void> {
  if (sampling || svgVersion === sampledVersion) return;
  sampling = true;
  try {
    const v = svgVersion;
    // Every side from the pose the SVG shows, taken before any await.
    render(refG, rig, svgPose, compareView);
    partsPose.set(svgPose);
    for (const ch of CANVAS_ONLY) partsPose[ch] = 0;
    render(partsG, rig, partsPose, compareView);
    const img = new Image(VIEW_W, VIEW_H);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serializer.serializeToString(svg))}`;
    await img.decode();
    imgG.drawImage(img, 0, 0, VIEW_W, VIEW_H);
    const image = imgG.getImageData(0, 0, VIEW_W, VIEW_H).data;
    const views = diffText(diffStats(refG.getImageData(0, 0, VIEW_W, VIEW_H).data, image));
    const parts = diffText(diffStats(partsG.getImageData(0, 0, VIEW_W, VIEW_H).data, image));
    sampledVersion = v;
    show.diff.textContent = views;
    show.diffParts.textContent = parts;
    log(`max pixel difference: views ${views}; parts only ${parts}`);
  } finally {
    sampling = false;
  }
}

// ---- wiring -------------------------------------------------------------------------------------------------

for (const s of sliders) {
  s.input.addEventListener('input', () => {
    const v = s.input.valueAsNumber * s.range.scale;
    base[s.ch] = v;
    s.value.textContent = valueText(v, s.range.unit);
    poseSelect.value = '';
    changed();
  });
  s.input.addEventListener('change', () => log(`${s.name} = ${valueText(base[s.ch]!, s.range.unit)}`));
}

poseSelect.addEventListener('change', () => {
  const name = poseSelect.value;
  const pose = POSE_NAMES.find((n) => n === name);
  if (pose === undefined) return;
  base.set(POSES[pose]);
  syncSliders();
  changed();
  log(`pose: ${pose}`);
});

resetButton.addEventListener('click', () => {
  base.fill(0);
  poseSelect.value = 'neutral';
  syncSliders();
  changed();
  log('reset: neutral');
});

setInterval(() => {
  sampleDiff().catch((err: unknown) => log(`pixel difference failed: ${String(err)}`));
}, SAMPLE_MS);

poseSelect.value = 'neutral';
syncSliders();
changed();
log(
  `lab/rig ready: ${PARTS.length} parts, ${BONES.length} bones, ${CH_COUNT} channels; devicePixelRatio ${window.devicePixelRatio}, viewport ${window.innerWidth} × ${window.innerHeight}; ${navigator.userAgent}`,
);
