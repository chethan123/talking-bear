// Lab page for the rig: the SVG DOM debug view (plan §4.6.1 "Keep SVG DOM as a debug view", §7 M4 "Debug")
// and the X-A1 stress helper (plan §5). One slider per pose channel drives a pose that is drawn side by side as
// SVG DOM, built from the generated parts with the rig's matrices as `transform` attributes, and by the app's
// Canvas 2D renderer, with their max pixel difference sampled once a second. Stress mode kicks every spring
// every 200 ms, runs the idle layers on top of the sliders' pose and renders every frame at the app stage's
// size (DPR cap 2 or native), with frame-time statistics. The clip preview plays a reaction or session clip on
// the canvas: its tracks on top of the sliders' pose, and its spring kicks through the page's own SpringBank
// (the app's springs-map.ts constants), every spring added to its channel. Dev-only: `pnpm dev`, then
// /lab/rig.html (docs/lab.md). No audio is involved; the log is text only. Lab pages set no CSS `style`: SVG
// geometry and sizes are attributes.

import { el, fmt, logPanel } from './common.ts';
import type { Attrs } from './common.ts';
import { BONES, PARTS } from '../src/art/bear-parts.gen.ts';
import { sampleClip } from '../src/anim/clip.ts';
import type { Clip } from '../src/anim/clip.ts';
import { REACTION_CLIPS } from '../src/anim/clips/reactions.ts';
import { SESSION_CLIPS } from '../src/anim/clips/session.ts';
import {
  createBlink,
  createBreathing,
  createEarTwitch,
  createGaze,
  createMood,
  EAR_SPRING,
  GAZE_SPRING,
} from '../src/anim/layers/index.ts';
import type { AnimContext, Layer } from '../src/anim/layers/index.ts';
import { Ch, CH_COUNT, createPose, lerpPose } from '../src/anim/pose.ts';
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
  MAX_DPR,
  render,
  resizeCanvas,
} from '../src/anim/renderer.ts';
import type { View } from '../src/anim/renderer.ts';
import { BONE_COUNT, boneMatrices, createRig, MAT, PartKind, partMatrix } from '../src/anim/rig.ts';
import { mulberry32 } from '../src/anim/rng.ts';
import { SpringBank } from '../src/anim/springs.ts';
import {
  BELLY_SPRING,
  configureSprings,
  HEAD_SPRING,
  KERCHIEF_A_SPRING,
  KERCHIEF_B_SPRING,
  NOSE_SPRING,
  SPRING_CHANNEL,
  SPRING_COUNT,
  TUFT_SPRING,
} from '../src/anim/springs-map.ts';
import { Stepper, SUBSTEP } from '../src/anim/stepper.ts';

const DEG = Math.PI / 180;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** CSS size of each view in the comparison: the 1000 × 1400 design box at scale 0.36, one backing px per CSS px. */
const VIEW_W = 360;
const VIEW_H = 504;
/** The pixel difference is sampled, and the stress statistics refreshed, this often. */
const SAMPLE_MS = 1000;
/** A pixel whose largest channel |Δ| (of 255) exceeds this is counted as a real disagreement, not anti-aliasing. */
const DIFF_COUNT_MIN = 64;
/** The channels only the canvas draws (the mouth and the stars): zero in the parts-only reference. */
const CANVAS_ONLY = [Ch.Jaw, Ch.MouthW, Ch.MouthRound, Ch.Teeth, Ch.Stars] as const;
/** Stress: every spring gets a random impulse every 200 ms of simulated time, i.e. every 24 substeps. */
const KICK_S = 0.2;
const KICK_STEPS = Math.round(KICK_S / SUBSTEP);
/** Stress: seed of the layers' and impulses' random source, so every run starts the same way. */
const SEED = 71;
/** The statistics cover the frames of the last 60 s. */
const WINDOW_MS = 60_000;
/**
 * A rAF interval longer than this counts as a dropped frame (the issue's definition). Intervals are measured
 * between the callbacks' start times (`performance.now()`), not the rAF timestamps: a frame that starts late
 * still gets its vsync's timestamp in headless Chromium (and wherever the scheduler hands the main thread a
 * stale frame time), which would hide the overrun.
 */
const DROP_MS = 20;
/**
 * A rAF interval longer than this many median intervals counts as a missed vsync: on a 90/120 Hz display one
 * missed vsync stays under 20 ms, so `DROP_MS` alone can't see it.
 */
const MISSED_FACTOR = 1.5;
/** Frames the statistics ring holds: 60 s at up to 240 Hz. */
const RING = 60 * 240;
/** While stress runs, a summary line goes to the log this often. */
const LOG_EVERY_MS = 10_000;
/** Clip preview: a sustained clip holds its pose this long past its duration, then is released. */
const HOLD_S = 1;
/** Clip preview: a released sustained clip eases back to neutral over this long (the director's 400 ms, #91). */
const RELEASE_S = 0.4;
/** Clip preview: after the clip's own motion, the preview runs until every spring rests, or this long at most. */
const SETTLE_MAX_S = 3;
/** Clip preview: a spring rests when its |position| and |velocity| are below these. */
const REST_POS = 1e-4;
const REST_VEL = 1e-3;

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
/** `IrisX` / `IrisY` / `IrisConverge`: at most 10 design units (pose.ts). */
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
  IrisConverge: IRIS,
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

// ---- springs (stress) ---------------------------------------------------------------------------------------

interface LabSpring {
  readonly name: string;
  /** The channel the spring moves. */
  readonly ch: number;
  readonly freqHz: number;
  /** Damping ratio, < 1: every spring here is underdamped. */
  readonly zeta: number;
  /** Peak excursion from rest of a full-size impulse, in the channel's units. */
  readonly amp: number;
  /** The layer that adds the spring's position to its channel; null: this page adds it. */
  readonly layer: 'gaze' | 'ears' | null;
}

/**
 * Every spring of the plan §4.6.5 rig (the `~` bones): the gaze layer's head-follow springs and the ear-twitch
 * layer's ear springs, with those layers' constants, the secondary springs of the app's index allocation
 * (`src/anim/springs-map.ts`, #81, #89: head wobble, tuft, kerchief tails, belly, nose sniff) with its constants,
 * and a body-squash spring with lab-only constants (f ≤ 10 Hz, stable at the 1/120 s substep).
 */
const SPRINGS: readonly LabSpring[] = [
  { name: 'headRot', ch: Ch.HeadRot, ...GAZE_SPRING, amp: 3 * DEG, layer: 'gaze' },
  { name: 'headTilt', ch: Ch.HeadTilt, ...GAZE_SPRING, amp: 3 * DEG, layer: 'gaze' },
  { name: 'earL', ch: Ch.EarRotL, ...EAR_SPRING, amp: 12 * DEG, layer: 'ears' },
  { name: 'earR', ch: Ch.EarRotR, ...EAR_SPRING, amp: 12 * DEG, layer: 'ears' },
  { name: 'head', ch: Ch.HeadRot, ...HEAD_SPRING, amp: 8 * DEG, layer: null },
  { name: 'tuft', ch: Ch.TuftRot, ...TUFT_SPRING, amp: 15 * DEG, layer: null },
  { name: 'kerchiefA', ch: Ch.KerchiefA, ...KERCHIEF_A_SPRING, amp: 15 * DEG, layer: null },
  { name: 'kerchiefB', ch: Ch.KerchiefB, ...KERCHIEF_B_SPRING, amp: 15 * DEG, layer: null },
  { name: 'belly', ch: Ch.BellyJiggle, ...BELLY_SPRING, amp: 0.04, layer: null },
  { name: 'body', ch: Ch.BodySquash, freqHz: 4, zeta: 0.35, amp: 0.04, layer: null },
  { name: 'nose', ch: Ch.NoseY, ...NOSE_SPRING, amp: 4, layer: null },
];

function springIndex(name: string): number {
  const i = SPRINGS.findIndex((s) => s.name === name);
  if (i < 0) throw new Error(`lab/rig: no spring ${name}`);
  return i;
}

/**
 * The velocity impulse whose free response from rest peaks at `amp`: x(t) = (v/ωd)·e^(−ζωt)·sin(ωd·t) peaks at
 * ωd·t = θ = atan2(√(1 − ζ²), ζ), where x = (v/ω)·e^(−ζθ/√(1 − ζ²)).
 */
function kickFor(s: LabSpring): number {
  if (!(s.zeta >= 0 && s.zeta < 1)) throw new RangeError(`lab/rig: spring ${s.name} must be underdamped`);
  const w = 2 * Math.PI * s.freqHz;
  const r = Math.sqrt(1 - s.zeta * s.zeta);
  return s.amp * w * Math.exp((s.zeta * Math.atan2(r, s.zeta)) / r);
}

/** The springs this page adds to the pose (the layers add their own), and their channels. */
const EXTRA = SPRINGS.flatMap((s, i) => (s.layer === null ? [i] : []));
const EXTRA_IDX = Int32Array.from(EXTRA);
const EXTRA_CH = Int32Array.from(EXTRA, (i) => SPRINGS[i]!.ch);

// ---- frame statistics ---------------------------------------------------------------------------------------

/** The start time (`performance.now()`) and the callback's own time of the latest `RING` frames, preallocated. */
interface Ring {
  readonly t: Float64Array;
  readonly work: Float64Array;
  /** The work times inside the window, gathered for the percentiles. */
  readonly scratch: Float64Array;
  /** The rAF intervals inside the window, gathered for their median. */
  readonly dts: Float64Array;
  head: number;
  size: number;
}

interface Summary {
  readonly frames: number;
  readonly spanMs: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly dropped: number;
  /** Median rAF interval in the window (ms; NaN with fewer than 2 frames), and the intervals above 1.5 × it. */
  readonly medianDtMs: number;
  readonly missed: number;
  readonly fps: number;
}

const ring: Ring = {
  t: new Float64Array(RING),
  work: new Float64Array(RING),
  scratch: new Float64Array(RING),
  dts: new Float64Array(RING),
  head: 0,
  size: 0,
};

/** Records one frame. Never allocates. */
function pushFrame(t: number, work: number): void {
  ring.t[ring.head] = t;
  ring.work[ring.head] = work;
  ring.head = (ring.head + 1) % RING;
  if (ring.size < RING) ring.size++;
}

/** Nearest-rank percentile `p` (0–100) of the sorted `xs`. */
function percentile(xs: Float64Array, p: number): number {
  return xs[Math.max(0, Math.ceil((p / 100) * xs.length) - 1)]!;
}

/**
 * The frames that started within 60 s of the latest one: work-time percentiles and max, the rAF
 * intervals over 20 ms between consecutive frames in that window, the median interval and the intervals over
 * 1.5 × it (missed vsyncs at any refresh rate), and the mean fps over it. Null before a frame. Runs at 1 Hz only.
 */
function summarize(): Summary | null {
  if (ring.size === 0) return null;
  const end = ring.t[(ring.head - 1 + RING) % RING]!;
  let n = 0;
  let intervals = 0;
  let dropped = 0;
  let first = end;
  let prev = Number.NaN;
  for (let k = 0; k < ring.size; k++) {
    const i = (ring.head - ring.size + k + RING) % RING;
    const t = ring.t[i]!;
    if (end - t > WINDOW_MS) continue;
    if (n === 0) first = t;
    else {
      const dt = t - prev;
      ring.dts[intervals++] = dt;
      if (dt > DROP_MS) dropped++;
    }
    prev = t;
    ring.scratch[n++] = ring.work[i]!;
  }
  const sorted = ring.scratch.subarray(0, n).toSorted();
  const dts = ring.dts.subarray(0, intervals);
  const medianDtMs = intervals > 0 ? percentile(dts.toSorted(), 50) : Number.NaN;
  let missed = 0;
  for (let k = 0; k < intervals; k++) if (dts[k]! > MISSED_FACTOR * medianDtMs) missed++;
  const spanMs = end - first;
  return {
    frames: n,
    spanMs,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[n - 1]!,
    dropped,
    medianDtMs,
    missed,
    fps: n > 1 ? (n - 1) / (spanMs / 1000) : Number.NaN,
  };
}

// ---- rig, views and page ------------------------------------------------------------------------------------

const rig = createRig();
/** The sliders' pose: what both views show, and the stress run's base pose. */
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
const stressBox = el('input', { type: 'checkbox' });
const dprSelect = el(
  'select',
  {},
  el('option', { value: 'cap' }, `cap ${MAX_DPR} (the app)`),
  el('option', { value: 'native' }, 'native'),
);

const show = {
  diff: el('dd'),
  diffParts: el('dd'),
  backing: el('dd'),
  work: el('dd'),
  dropped: el('dd'),
  missed: el('dd'),
  fps: el('dd'),
  window: el('dd'),
  springs: el('dd'),
  clip: el('dd'),
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

const stressFieldset = el(
  'fieldset',
  {},
  el('legend', {}, 'Stress (X-A1)'),
  el(
    'p',
    {},
    el('label', {}, stressBox, ' Stress: a random impulse on every spring every 200 ms, idle layers on'),
  ),
  el('p', {}, el('label', {}, 'DPR of the stress canvas: ', dprSelect)),
  el(
    'dl',
    { class: 'lab-values' },
    ...row('Canvas backing store', show.backing),
    ...row('Main-thread ms per frame (rAF callback), p50 / p95 / max', show.work),
    ...row(`Dropped frames (Δt > ${DROP_MS} ms)`, show.dropped),
    ...row(`Missed vsync (Δt > ${MISSED_FACTOR} × median rAF interval)`, show.missed),
    ...row('fps', show.fps),
    ...row('Window (last 60 s)', show.window),
    ...row('Spring peak |x − target| / amp (last 1 s)', show.springs),
  ),
);

/** Every clip the preview offers: the reaction clips (#89), then the session clips (#77). */
const CLIPS = new Map<string, Clip>([...Object.entries(REACTION_CLIPS), ...Object.entries(SESSION_CLIPS)]);

function clipOption(name: string): HTMLOptionElement {
  const c = CLIPS.get(name);
  if (c === undefined) throw new Error(`lab/rig: no clip ${name}`);
  const kicks = c.impulses?.length ?? 0;
  const notes = [`${fmt(c.duration, 2)} s`];
  if (c.sustained === true) notes.push('sustained');
  if (kicks > 0) notes.push(`${kicks} spring kick${kicks === 1 ? '' : 's'}`);
  return el('option', { value: name }, `${name} (${notes.join(', ')})`);
}

const clipSelect = el(
  'select',
  {},
  el('optgroup', { label: 'Reaction clips' }, ...Object.keys(REACTION_CLIPS).map(clipOption)),
  el('optgroup', { label: 'Session clips' }, ...Object.keys(SESSION_CLIPS).map(clipOption)),
);
const playButton = el('button', { type: 'button' }, 'Play');

const clipFieldset = el(
  'fieldset',
  {},
  el('legend', {}, 'Clip preview'),
  el(
    'p',
    {},
    'Plays a clip on the canvas on top of the sliders’ pose, with its spring kicks; a sustained clip is held ',
    `${HOLD_S} s, then released over ${RELEASE_S * 1000} ms. The SVG view keeps the sliders’ pose.`,
  ),
  el('p', {}, el('label', {}, 'Clip: ', clipSelect), ' ', playButton),
  el('dl', { class: 'lab-values' }, ...row('Clip', show.clip)),
);

root.append(
  el('fieldset', {}, el('legend', {}, 'Pose'), el('label', {}, 'Key pose: ', poseSelect), ' ', resetButton),
  clipFieldset,
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

/** Draws `base` in both views (once per frame at most), unless stress or the clip preview owns the canvas. */
function drawStatic(): void {
  pendingStatic = 0;
  if (stress !== null || preview !== null) return;
  render(g, rig, base, compareView);
  updateSvg(base);
}

/** Notes a change of `base` and schedules both views. */
function changed(): void {
  version++;
  if (stress === null && pendingStatic === 0) pendingStatic = requestAnimationFrame(drawStatic);
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
 * Skipped while stress runs, while a sample is in flight and when the SVG view hasn't changed since the last one.
 */
async function sampleDiff(): Promise<void> {
  if (stress !== null || sampling || svgVersion === sampledVersion) return;
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
    if (stress !== null) return;
    show.diff.textContent = views;
    show.diffParts.textContent = parts;
    log(`max pixel difference: views ${views}; parts only ${parts}`);
  } finally {
    sampling = false;
  }
}

// ---- stress -------------------------------------------------------------------------------------------------

interface Stress {
  readonly stepper: Stepper;
  /** The physics states before and after the latest substep, and the interpolated pose that is drawn. */
  readonly prev: Pose;
  readonly cur: Pose;
  readonly out: Pose;
  readonly view: View;
  /** One substep; allocated once per run, so the frame passes the same function every time. */
  readonly substep: (dt: number) => void;
  /** Largest |pos − target| of each spring since the last statistics refresh. */
  readonly peak: Float64Array;
  /** The viewport (CSS px) the stage was last sized for. */
  cssW: number;
  cssH: number;
  raf: number;
  /** rAF timestamp of the previous frame; −1 before the first. */
  lastT: number;
  startedAt: number;
  lastLog: number;
}

let stress: Stress | null = null;

/** A fresh run: a seeded random source, the spring bank, the idle layers and the fixed-step stepper. */
function createStress(): Stress {
  const springs = new SpringBank(SPRINGS.length);
  const kick = new Float64Array(SPRINGS.length);
  SPRINGS.forEach((s, i) => {
    springs.set(i, s.freqHz, s.zeta);
    kick[i] = kickFor(s);
  });
  const anim: AnimContext = {
    rng: mulberry32(SEED),
    weights: { blink: 1, breathing: 1, gaze: 1, ears: 1 },
    lookAt: null,
    springs,
  };
  // The always-running additive layers of plan §3.5.
  const layers: readonly Layer[] = [
    createBlink(),
    createBreathing(),
    createGaze({ headRot: springIndex('headRot'), headTilt: springIndex('headTilt') }),
    createEarTwitch({ earL: springIndex('earL'), earR: springIndex('earR') }),
    createMood(),
  ];
  const prev = createPose();
  const cur = createPose();
  prev.set(base);
  cur.set(base);
  const peak = new Float64Array(SPRINGS.length);
  let steps = 0;
  /** As the app's loop: step the springs, reseed from the base pose, add the layers (index.ts contract). */
  function substep(dt: number): void {
    springs.step(dt);
    for (let i = 0; i < peak.length; i++) {
      const d = Math.abs(springs.pos[i]! - springs.target[i]!);
      if (d > peak[i]!) peak[i] = d;
    }
    prev.set(cur);
    cur.set(base);
    for (let i = 0; i < layers.length; i++) layers[i]!.update(dt, cur, anim);
    for (let k = 0; k < EXTRA_IDX.length; k++) {
      const ch = EXTRA_CH[k]!;
      cur[ch] = cur[ch]! + springs.pos[EXTRA_IDX[k]!]!;
    }
    if (++steps >= KICK_STEPS) {
      steps = 0;
      for (let i = 0; i < kick.length; i++) springs.impulse(i, kick[i]! * (2 * anim.rng() - 1));
    }
  }
  return {
    stepper: new Stepper(),
    prev,
    cur,
    out: createPose(),
    view: { scale: 0, ox: 0, oy: 0 },
    substep,
    peak,
    cssW: 0,
    cssH: 0,
    raf: 0,
    lastT: -1,
    startedAt: performance.now(),
    lastLog: performance.now(),
  };
}

/** One stress frame: physics, interpolation and render, timed. Allocates nothing. */
function frame(t: number): void {
  const s = stress;
  if (s === null) return;
  const t0 = performance.now();
  s.raf = requestAnimationFrame(frame);
  const dt = s.lastT < 0 ? 0 : (t - s.lastT) / 1000;
  s.lastT = t;
  const alpha = s.stepper.advance(dt, s.substep);
  lerpPose(s.prev, s.cur, alpha, s.out);
  render(g, rig, s.out, s.view);
  pushFrame(t0, performance.now() - t0);
}

/**
 * Sizes the canvas as the app's stage: the viewport (CSS px) × min(devicePixelRatio, 2), or × devicePixelRatio
 * for "native". Without CSS the canvas shows at its backing-store size in CSS px. Restarts the statistics and
 * returns the backing-store description.
 */
function sizeStage(s: Stress): string {
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  s.cssW = cssW;
  s.cssH = cssH;
  const dpr = window.devicePixelRatio;
  const native = dprSelect.value === 'native';
  if (native) {
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
  } else {
    resizeCanvas(canvas, cssW, cssH, dpr);
  }
  fitView(canvas.width, canvas.height, s.view);
  const factor = native ? dpr : Math.min(dpr, MAX_DPR);
  const text = `${canvas.width} × ${canvas.height} px: viewport ${cssW} × ${cssH} CSS px × ${fmt(factor, 3)} (devicePixelRatio ${dpr}, ${native ? 'native' : `cap ${MAX_DPR}`})`;
  show.backing.textContent = text;
  ring.head = 0;
  ring.size = 0;
  s.lastT = -1;
  s.startedAt = performance.now();
  s.lastLog = s.startedAt;
  refreshStats();
  return text;
}

function summaryLine(sum: Summary): string {
  return `ms/frame p50 ${fmt(sum.p50, 2)} p95 ${fmt(sum.p95, 2)} max ${fmt(sum.max, 2)}; dropped ${sum.dropped}; ${missedText(sum)}; fps ${fmt(sum.fps, 1)}; ${sum.frames} frames over ${fmt(sum.spanMs / 1000, 1)} s`;
}

function missedText(sum: Summary): string {
  return `missed vsync ${sum.missed} (median interval ${fmt(sum.medianDtMs, 2)} ms)`;
}

/** Each spring's peak excursion from its target since the last refresh, relative to its `amp`. */
function springText(peak: Float64Array): string {
  return SPRINGS.map((sp, i) => `${sp.name} ${fmt(peak[i]! / sp.amp, 2)}`).join(', ');
}

/** Shows the statistics; while stress runs, the spring peaks of the last second, and every 10 s a log line. */
function refreshStats(): void {
  const s = stress;
  let springs = '';
  if (s !== null) {
    springs = springText(s.peak);
    s.peak.fill(0);
    show.springs.textContent = springs;
  }
  const sum = summarize();
  if (sum === null) {
    show.work.textContent = '(no frames yet)';
    show.dropped.textContent = '';
    show.missed.textContent = '';
    show.fps.textContent = '';
    show.window.textContent = '';
    return;
  }
  show.work.textContent = `${fmt(sum.p50, 2)} / ${fmt(sum.p95, 2)} / ${fmt(sum.max, 2)} ms`;
  show.dropped.textContent = String(sum.dropped);
  show.missed.textContent = `${sum.missed} (median interval ${fmt(sum.medianDtMs, 2)} ms)`;
  show.fps.textContent = fmt(sum.fps, 1);
  show.window.textContent = `${fmt(sum.spanMs / 1000, 1)} s, ${sum.frames} frames`;
  const now = performance.now();
  if (s !== null && now - s.lastLog >= LOG_EVERY_MS) {
    s.lastLog = now;
    log(`stress ${fmt((now - s.startedAt) / 1000, 0)} s: ${summaryLine(sum)}; springs ${springs}`);
  }
}

/** Brings the stress canvas on screen: the compositor must draw what X-A1 measures. */
function showStage(): void {
  canvas.scrollIntoView({ block: 'center', inline: 'center' });
}

function startStress(): void {
  if (stress !== null) return;
  stopPreview('stopped: stress started');
  const s = createStress();
  stress = s;
  show.diff.textContent = '(paused while stress runs)';
  show.diffParts.textContent = '(paused while stress runs)';
  log(
    `stress: start, seed ${SEED}, ${SPRINGS.length} springs kicked every ${KICK_S * 1000} ms, layers blink, breathing, gaze, ear twitch, mood`,
  );
  log(`stress canvas: ${sizeStage(s)}`);
  showStage();
  s.raf = requestAnimationFrame(frame);
}

function stopStress(reason: string): void {
  const s = stress;
  if (s === null) return;
  stress = null;
  cancelAnimationFrame(s.raf);
  stressBox.checked = false;
  refreshStats();
  const sum = summarize();
  log(`stress: ${reason}${sum === null ? '' : `: ${summaryLine(sum)}`}`);
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  show.diff.textContent = '';
  show.diffParts.textContent = '';
  sampledVersion = -1;
  changed();
}

// ---- clip preview -------------------------------------------------------------------------------------------

interface Preview {
  readonly name: string;
  readonly clip: Clip;
  /** The page's own bank of the app's springs (springs-map.ts), from rest. */
  readonly springs: SpringBank;
  readonly stepper: Stepper;
  /** The clip's sample, and the drawn pose. */
  readonly delta: Pose;
  readonly out: Pose;
  /** One substep: the clip's kicks due in it, then the springs' step. Allocated once per preview. */
  readonly substep: (dt: number) => void;
  /** End of the clip's own motion (s): its duration, plus the hold and the release for a sustained clip. */
  readonly end: number;
  /** Simulated time since the start (s), advanced by the substeps. */
  time: number;
  raf: number;
  /** rAF timestamp of the previous frame; −1 before the first. */
  lastT: number;
}

let preview: Preview | null = null;

function createPreview(name: string, clip: Clip): Preview {
  const springs = new SpringBank(SPRING_COUNT);
  configureSprings(springs);
  const impulses = clip.impulses ?? [];
  const p: Preview = {
    name,
    clip,
    springs,
    stepper: new Stepper(),
    delta: createPose(),
    out: createPose(),
    substep(dt: number): void {
      const t0 = p.time;
      for (let i = 0; i < impulses.length; i++) {
        const imp = impulses[i]!;
        if (imp.t >= t0 && imp.t < t0 + dt) springs.impulse(imp.spring, imp.dv);
      }
      springs.step(dt);
      p.time = t0 + dt;
    },
    end: clip.sustained === true ? clip.duration + HOLD_S + RELEASE_S : clip.duration,
    time: 0,
    raf: 0,
    lastT: -1,
  };
  return p;
}

/** The clip's weight at time `t`: 1, except for a sustained clip after its hold, which eases out linearly. */
function clipWeight(p: Preview, t: number): number {
  if (p.clip.sustained !== true) return 1;
  const release = p.clip.duration + HOLD_S;
  return t <= release ? 1 : Math.max(0, 1 - (t - release) / RELEASE_S);
}

function springsAtRest(s: SpringBank): boolean {
  for (let i = 0; i < SPRING_COUNT; i++) {
    if (Math.abs(s.pos[i]!) > REST_POS || Math.abs(s.vel[i]!) > REST_VEL) return false;
  }
  return true;
}

/**
 * One preview frame: the fixed-step substeps, then the sliders' pose + the clip's sample × its weight + every
 * spring's position on its channel (`SPRING_CHANNEL`), drawn on the canvas. It ends once the clip's own motion is
 * over and the springs rest.
 */
function previewFrame(t: number): void {
  const p = preview;
  if (p === null) return;
  const dt = p.lastT < 0 ? 0 : (t - p.lastT) / 1000;
  p.lastT = t;
  p.stepper.advance(dt, p.substep);
  const w = clipWeight(p, p.time);
  sampleClip(p.clip, p.time, p.delta);
  for (let ch = 0; ch < CH_COUNT; ch++) p.out[ch] = base[ch]! + w * p.delta[ch]!;
  for (let i = 0; i < SPRING_COUNT; i++) {
    const ch = SPRING_CHANNEL[i]!;
    p.out[ch] = p.out[ch]! + p.springs.pos[i]!;
  }
  render(g, rig, p.out, compareView);
  if (p.time >= p.end && (springsAtRest(p.springs) || p.time >= p.end + SETTLE_MAX_S)) {
    stopPreview(`done after ${fmt(p.time, 2)} s`);
    return;
  }
  p.raf = requestAnimationFrame(previewFrame);
}

function startPreview(): void {
  const name = clipSelect.value;
  const clip = CLIPS.get(name);
  if (clip === undefined) return;
  stopStress('stopped: clip preview');
  stopPreview('stopped: another clip');
  const p = createPreview(name, clip);
  preview = p;
  show.clip.textContent = `${name}: playing`;
  const held = clip.sustained === true ? `; sustained: held ${HOLD_S} s, released over ${RELEASE_S} s` : '';
  log(`clip ${name}: play, ${fmt(clip.duration, 2)} s, ${clip.impulses?.length ?? 0} spring kicks${held}`);
  p.raf = requestAnimationFrame(previewFrame);
}

function stopPreview(reason: string): void {
  const p = preview;
  if (p === null) return;
  preview = null;
  cancelAnimationFrame(p.raf);
  show.clip.textContent = `${p.name}: ${reason}`;
  log(`clip ${p.name}: ${reason}`);
  changed();
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

stressBox.addEventListener('change', () => {
  if (stressBox.checked) startStress();
  else stopStress('stopped');
});

dprSelect.addEventListener('change', () => {
  log(`DPR: ${dprSelect.value}`);
  if (stress === null) return;
  log(`stress canvas: ${sizeStage(stress)}`);
  showStage();
});

// As the app's stage: a new viewport (rotation, the mobile toolbar collapsing) resizes the stress canvas and
// restarts the statistics.
window.addEventListener('resize', () => {
  const s = stress;
  if (s === null || (window.innerWidth === s.cssW && window.innerHeight === s.cssH)) return;
  log(`stress: resized to ${sizeStage(s)}`);
  showStage();
});

playButton.addEventListener('click', startPreview);

// A hidden page gets no rAF: stop rather than count the gap as dropped frames.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  stopStress('page hidden');
  stopPreview('stopped: page hidden');
});

setInterval(() => {
  if (stress !== null) refreshStats();
  else sampleDiff().catch((err: unknown) => log(`pixel difference failed: ${String(err)}`));
}, SAMPLE_MS);

poseSelect.value = 'neutral';
syncSliders();
refreshStats();
show.backing.textContent = '(stress off)';
show.clip.textContent = '(none played yet)';
changed();
log(
  `lab/rig ready: ${PARTS.length} parts, ${BONES.length} bones, ${CH_COUNT} channels; devicePixelRatio ${window.devicePixelRatio}, viewport ${window.innerWidth} × ${window.innerHeight}; ${navigator.userAgent}`,
);
