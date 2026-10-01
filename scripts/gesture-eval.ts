// X-A7 (plan §5, §7 M5; issue #94): replays the labelled pointer traces that `lab/gestures` exports through the
// app's own recogniser and prints the confusion matrix of intended gesture × predicted class.
//
//   node scripts/gesture-eval.ts <files…> [--min <fraction>]
//
// Each trial is replayed alone, from `initialRecState()`, feeding its recorded samples (downs, every coalesced
// move, ups, cancels and the adapter's frame ticks) to `recognize()` in order, with the neutral-pose `hitTest`
// of the canvas the file was recorded on (`fitView` over its CSS size, the default 12 px padding). The emitted
// gestures map to one predicted class:
//
//   tap up → tap · longPress start → long-press · stroke with pathPx ≥ STROKE_MIN_PATH (120) → pet ·
//   tickle → tickle · none of these → none
//
// and when several are emitted the highest priority wins: tickle > pet > long-press > tap.
//
// Exit 0; 1 when `--min` is given and the overall accuracy (over tap, long-press, pet and tickle) is below it;
// 2 on a usage error or a file that can't be read or isn't a valid trace file.
//
// Run by Node with type stripping: erasable TypeScript syntax only.

import { readFileSync } from 'node:fs';
import { fitView } from '../src/anim/renderer.ts';
import { POSES } from '../src/anim/poses.ts';
import { BONE_COUNT, boneMatrices, MAT } from '../src/anim/rig.ts';
import type { Rig } from '../src/anim/rig.ts';
import { initialRecState, recognize, STROKE_MIN_PATH } from '../src/input/recognizer.ts';
import type { Gesture, PointerSample } from '../src/input/recognizer.ts';
import type { RegionId } from '../src/input/region-ids.ts';
import { hitTest } from '../src/input/regions.ts';

/** The `format` and `version` of a trace file (written by `lab/gestures.ts`). */
export const FORMAT = 'talking-bear-gestures';
export const VERSION = 1;

/** The prompted gestures, in matrix row order. */
export const INTENDED = ['tap', 'long-press', 'pet', 'tickle'] as const;
export type Intended = (typeof INTENDED)[number];
/** The predicted classes, in matrix column order. */
export const PREDICTED = [...INTENDED, 'none'] as const;
export type Predicted = (typeof PREDICTED)[number];
export const AGES = ['adult', 'child'] as const;
export type Age = (typeof AGES)[number];

/** The issue's priority when a trial emits several classes, highest first. */
export const PRIORITY: readonly Intended[] = ['tickle', 'pet', 'long-press', 'tap'];

/** One prompted gesture: every sample the pointer adapter fed the recogniser, from the first down on. */
export interface GestureTrial {
  participant: string;
  age: Age;
  intended: Intended;
  samples: PointerSample[];
}

/** A `lab/gestures` export: one participant's trials, on one canvas. */
export interface GestureFile {
  format: typeof FORMAT;
  version: typeof VERSION;
  /** The canvas's CSS size (its backing store has the same size) and the page's `devicePixelRatio`. */
  canvas: { cssWidth: number; cssHeight: number; dpr: number };
  trials: GestureTrial[];
}

// ---- parsing ------------------------------------------------------------------------------------------------

const SAMPLE_TYPES: readonly PointerSample['type'][] = ['down', 'move', 'up', 'cancel', 'tick'];
const POINTER_TYPES: readonly NonNullable<PointerSample['pointerType']>[] = ['touch', 'mouse', 'pen'];
const PARTICIPANT = /^P[1-9][0-9]*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: expected a finite number`);
  return v;
}

function positive(v: unknown, where: string): number {
  const n = finite(v, where);
  if (n <= 0) throw new Error(`${where}: expected a number > 0`);
  return n;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], where: string): T {
  const found = allowed.find((a) => a === v);
  if (found === undefined) throw new Error(`${where}: expected one of ${allowed.join(', ')}`);
  return found;
}

function parseSample(v: unknown, where: string): PointerSample {
  if (!isObject(v)) throw new Error(`${where}: expected an object`);
  const s: PointerSample = {
    id: finite(v.id, `${where}.id`),
    t: finite(v.t, `${where}.t`),
    x: finite(v.x, `${where}.x`),
    y: finite(v.y, `${where}.y`),
    type: oneOf(v.type, SAMPLE_TYPES, `${where}.type`),
  };
  if (v.pointerType !== undefined) {
    s.pointerType = oneOf(v.pointerType, POINTER_TYPES, `${where}.pointerType`);
  }
  return s;
}

function parseTrial(v: unknown, where: string): GestureTrial {
  if (!isObject(v)) throw new Error(`${where}: expected an object`);
  const participant = v.participant;
  if (typeof participant !== 'string' || !PARTICIPANT.test(participant)) {
    throw new Error(`${where}.participant: expected P1, P2, …`);
  }
  if (!Array.isArray(v.samples)) throw new Error(`${where}.samples: expected an array`);
  return {
    participant,
    age: oneOf(v.age, AGES, `${where}.age`),
    intended: oneOf(v.intended, INTENDED, `${where}.intended`),
    samples: v.samples.map((s: unknown, k) => parseSample(s, `${where}.samples[${k}]`)),
  };
}

/** Validates a parsed trace file; throws an `Error` naming the first bad field. */
export function parseGestureFile(v: unknown): GestureFile {
  if (!isObject(v)) throw new Error('expected a JSON object');
  if (v.format !== FORMAT) throw new Error(`format: expected "${FORMAT}"`);
  if (v.version !== VERSION) throw new Error(`version: expected ${VERSION}`);
  const c = v.canvas;
  if (!isObject(c)) throw new Error('canvas: expected an object');
  if (!Array.isArray(v.trials)) throw new Error('trials: expected an array');
  return {
    format: FORMAT,
    version: VERSION,
    canvas: {
      cssWidth: positive(c.cssWidth, 'canvas.cssWidth'),
      cssHeight: positive(c.cssHeight, 'canvas.cssHeight'),
      dpr: positive(c.dpr, 'canvas.dpr'),
    },
    trials: v.trials.map((t: unknown, i) => parseTrial(t, `trials[${i}]`)),
  };
}

// ---- replay and classes -------------------------------------------------------------------------------------

/**
 * The neutral pose's bone matrices, as `lab/gestures` computes them. `boneMatrices` uses a `Rig` only for its
 * matrix stack; `createRig` also builds every part's `Path2D`, which Node lacks, so this rig has no paths.
 */
function neutralBones(): Float32Array {
  const rig: Rig = {
    paths: [],
    kind: new Uint8Array(0),
    mouthSlot: 0,
    stack: new Float64Array(BONE_COUNT * MAT),
  };
  return boneMatrices(rig, POSES.neutral, new Float32Array(BONE_COUNT * MAT));
}

/** The page's hit test on a `cssWidth × cssHeight` canvas: the neutral pose, fitted with `fitView`, 12 px padding. */
export function neutralHit(canvas: {
  cssWidth: number;
  cssHeight: number;
}): (x: number, y: number) => RegionId {
  const bones = neutralBones();
  const view = fitView(canvas.cssWidth, canvas.cssHeight, { scale: 0, ox: 0, oy: 0 });
  return (x, y) => hitTest(x, y, bones, view);
}

/** Every gesture the recogniser emits for `samples`, fed in order from a fresh state. */
export function replay(
  samples: readonly PointerSample[],
  hit: (x: number, y: number) => RegionId,
): Gesture[] {
  let state = initialRecState();
  const out: Gesture[] = [];
  for (const s of samples) {
    const [next, gestures] = recognize(state, s, hit);
    state = next;
    out.push(...gestures);
  }
  return out;
}

/** The class one gesture stands for, or null (every other gesture, phase or a stroke shorter than a pet). */
export function classOf(g: Gesture): Intended | null {
  switch (g.g) {
    case 'tap':
      return g.phase === 'up' ? 'tap' : null;
    case 'longPress':
      return g.phase === 'start' ? 'long-press' : null;
    case 'stroke':
      return g.pathPx >= STROKE_MIN_PATH ? 'pet' : null;
    case 'tickle':
      return 'tickle';
    default:
      return null;
  }
}

/** The predicted class of a trial's gestures: the highest-priority class among them, or `none`. */
export function predict(gestures: readonly Gesture[]): Predicted {
  let best = PRIORITY.length;
  for (const g of gestures) {
    const c = classOf(g);
    if (c !== null) best = Math.min(best, PRIORITY.indexOf(c));
  }
  return PRIORITY[best] ?? 'none';
}

// ---- evaluation ---------------------------------------------------------------------------------------------

export interface TrialResult {
  file: string;
  /** The trial's index in its file (0-based). */
  index: number;
  trial: GestureTrial;
  gestures: Gesture[];
  predicted: Predicted;
}

export interface Tally {
  trials: number;
  correct: number;
}

export interface Evaluation {
  /** `matrix[r][c]`: trials intended `INTENDED[r]` and predicted `PREDICTED[c]`. */
  matrix: number[][];
  overall: Tally;
  byAge: Record<Age, Tally>;
  results: TrialResult[];
}

export function evaluate(files: readonly { name: string; data: GestureFile }[]): Evaluation {
  const matrix = INTENDED.map(() => PREDICTED.map(() => 0));
  const overall: Tally = { trials: 0, correct: 0 };
  const byAge: Record<Age, Tally> = { adult: { trials: 0, correct: 0 }, child: { trials: 0, correct: 0 } };
  const results: TrialResult[] = [];
  for (const { name, data } of files) {
    const hit = neutralHit(data.canvas);
    data.trials.forEach((trial, index) => {
      const gestures = replay(trial.samples, hit);
      const predicted = predict(gestures);
      const ok = predicted === trial.intended ? 1 : 0;
      matrix[INTENDED.indexOf(trial.intended)]![PREDICTED.indexOf(predicted)]! += 1;
      overall.trials += 1;
      overall.correct += ok;
      byAge[trial.age].trials += 1;
      byAge[trial.age].correct += ok;
      results.push({ file: name, index, trial, gestures, predicted });
    });
  }
  return { matrix, overall, byAge, results };
}

/** `c / n` as a percentage with one decimal (`n/a` for n = 0). */
function pct(c: number, n: number): string {
  return n === 0 ? 'n/a' : `${((100 * c) / n).toFixed(1)} %`;
}

function tally(t: Tally): string {
  return `${pct(t.correct, t.trials)} (${t.correct}/${t.trials})`;
}

/** One gesture for the misclassified list (stroke updates are left out). */
export function describe(g: Gesture): string {
  switch (g.g) {
    case 'tap':
      return `tap ${g.phase} ${g.region}${g.count > 1 ? ` ×${g.count}` : ''}`;
    case 'longPress':
      return `longPress ${g.phase} ${g.region}`;
    case 'stroke':
      return `stroke ${g.phase} ${g.region} ${g.pathPx.toFixed(0)} px`;
    case 'tickle':
    case 'flick':
      return `${g.g} ${g.region}`;
    default:
      // pinch, hug, allOver, cancel
      return g.g;
  }
}

/** The report: participants, the confusion matrix with per-class accuracy, overall and per-age accuracy, misses. */
export function formatReport(e: Evaluation, fileCount: number): string[] {
  /** Trials per participant and age, in order of appearance. */
  const people = new Map<string, number>();
  for (const r of e.results) {
    const key = `${r.trial.participant} (${r.trial.age}`;
    people.set(key, (people.get(key) ?? 0) + 1);
  }
  const who = [...people].map(([key, n]) => `${key}, ${n} trials)`).join(', ');
  const lines = [
    `gesture-eval: ${fileCount} file${fileCount === 1 ? '' : 's'}, ${e.overall.trials} trials: ${who}`,
    '',
  ];
  const head = ['intended \\ predicted', ...PREDICTED, 'trials', 'accuracy'];
  const rows = INTENDED.map((intended, r) => {
    const counts = e.matrix[r]!;
    const n = counts.reduce((a, b) => a + b, 0);
    return [intended, ...counts.map(String), String(n), pct(counts[r]!, n)];
  });
  const widths = head.map((h, k) => Math.max(h.length, ...rows.map((row) => row[k]!.length)));
  const line = (cells: readonly string[]): string =>
    cells.map((c, k) => (k === 0 ? c.padEnd(widths[k]!) : c.padStart(widths[k]!))).join('  ');
  lines.push(line(head), ...rows.map(line), '');
  lines.push(`overall (tap, long-press, pet, tickle): ${tally(e.overall)}`);
  lines.push(AGES.map((age) => `${age}: ${tally(e.byAge[age])}`).join(' · '));
  const wrong = e.results.filter((r) => r.predicted !== r.trial.intended);
  lines.push(`misclassified: ${wrong.length}`);
  for (const r of wrong) {
    const shown = r.gestures.filter((g) => !(g.g === 'stroke' && g.phase === 'update')).map(describe);
    lines.push(
      `  ${r.file} trial ${r.index + 1} (${r.trial.participant}, ${r.trial.age}): intended ${r.trial.intended}, ` +
        `predicted ${r.predicted}: ${shown.length === 0 ? 'no gestures' : shown.join(', ')}`,
    );
  }
  return lines;
}

// ---- CLI ----------------------------------------------------------------------------------------------------

const USAGE = 'usage: node scripts/gesture-eval.ts <files…> [--min <fraction 0…1>]';

/** The CLI. Returns the exit code: 0, 1 (accuracy below `--min`) or 2 (usage or input error). */
export function main(args: readonly string[]): number {
  const paths: string[] = [];
  let min: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--min') {
      const v = args[++i];
      const n = v === undefined || v.trim() === '' ? Number.NaN : Number(v);
      if (min !== undefined || !(n >= 0 && n <= 1)) {
        console.error(`gesture-eval: --min needs one fraction from 0 to 1\n${USAGE}`);
        return 2;
      }
      min = n;
    } else if (a.startsWith('-')) {
      console.error(`gesture-eval: unknown option ${a}\n${USAGE}`);
      return 2;
    } else {
      paths.push(a);
    }
  }
  if (paths.length === 0) {
    console.error(USAGE);
    return 2;
  }
  const files: { name: string; data: GestureFile }[] = [];
  for (const path of paths) {
    try {
      files.push({ name: path, data: parseGestureFile(JSON.parse(readFileSync(path, 'utf8'))) });
    } catch (err) {
      console.error(`gesture-eval: ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }
  const e = evaluate(files);
  if (e.overall.trials === 0) {
    console.error('gesture-eval: the files hold no trials');
    return 2;
  }
  for (const l of formatReport(e, files.length)) console.log(l);
  if (min === undefined) return 0;
  const accuracy = e.overall.correct / e.overall.trials;
  const verdict = `--min ${min}: overall ${pct(e.overall.correct, e.overall.trials)}`;
  if (accuracy < min) {
    console.error(`${verdict} is below ${(100 * min).toFixed(1)} %: FAIL`);
    return 1;
  }
  console.log(`${verdict} ≥ ${(100 * min).toFixed(1)} %: PASS`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
