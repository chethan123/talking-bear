// Lab page for X-A7 (plan §5, §7 M5; issue #94): records labelled pointer traces for the recogniser's confusion
// matrix (scripts/gesture-eval.ts). The bear is drawn once, in the neutral pose with no animation, so the hit
// regions never move. Each prompted trial records every sample the app's pointer adapter feeds its recogniser
// (downs, each coalesced move, ups, cancels and the frame ticks) from the first down until TRIAL_TAIL_MS after
// the last up; the page replays the trial's samples through `recognize` as they come, from a fresh state per
// trial, so the live verdict is exactly what gesture-eval computes. Dev-only: `pnpm dev`, then
// /lab/gestures.html (docs/lab.md).
// Privacy (plan Q2, docs/lab.md): pointer coordinates and times only, labelled with an anonymous participant id
// (P1, P2, …) and an age group. No microphone, no audio. Nothing is stored in the browser; Export hands the
// trials to the browser as one JSON file, only when pressed.

import { createContext, DESIGN_HEIGHT, DESIGN_WIDTH, fitView, render } from '../src/anim/renderer.ts';
import { POSES } from '../src/anim/poses.ts';
import { BONE_COUNT, boneIndex, boneMatrices, createRig, MAT } from '../src/anim/rig.ts';
import { attachPointerAdapter } from '../src/input/pointer-adapter.ts';
import { initialRecState, recognize } from '../src/input/recognizer.ts';
import type { Gesture, PointerSample, RecState } from '../src/input/recognizer.ts';
import type { RegionId } from '../src/input/region-ids.ts';
import { hitTest, REGIONS } from '../src/input/regions.ts';
import { el, fmt, logPanel } from './common.ts';

/** A trial lasts from its first down until this long after its last up or cancel (a down before then continues it). */
const TRIAL_TAIL_MS = 600;
/**
 * With no new down, the frame loop closes a trial this much later than its tail ends, so a down whose event was
 * created inside the tail but not yet dispatched still joins it. `onSample` applies the exact rule by sample time.
 */
const CLOSE_GRACE_MS = 100;
/** The canvas is at most this share of the viewport's height, so the prompt below it stays in view. */
const MAX_VIEWPORT_SHARE = 0.85;
/** The exported object URL is released this long after the click. */
const REVOKE_MS = 10_000;
/** The prompt's region outline: canvas px, dash pattern and colour. */
const OUTLINE_PX = 3;
const OUTLINE_DASH = [10, 6];
const OUTLINE_COLOR = '#1A73E8';
/** The trace file format (scripts/gesture-eval.ts reads it). */
const FORMAT = 'talking-bear-gestures';
const VERSION = 1;

type Intended = 'tap' | 'long-press' | 'pet' | 'tickle';
type Age = 'adult' | 'child';
const INTENDED: readonly Intended[] = ['tap', 'long-press', 'pet', 'tickle'];

/** What each prompt asks, and the regions it outlines (plan §4.6.4: each region has a reaction for that gesture). */
const PROMPTS: Readonly<Record<Intended, { text: string; regions: readonly RegionId[] }>> = {
  tap: { text: 'Tap the nose', regions: ['nose'] },
  'long-press': { text: 'Press and hold a paw', regions: ['pawL', 'pawR'] },
  pet: { text: 'Pet the head (stroke it)', regions: ['headTop'] },
  tickle: { text: 'Tickle the belly', regions: ['belly'] },
};

/** One prompted gesture, as exported. */
interface Trial {
  participant: string;
  age: Age;
  intended: Intended;
  samples: PointerSample[];
}

/** The trial in progress: its record, the recogniser state (fresh per trial) and the gestures so far. */
interface Current {
  trial: Trial;
  state: RecState;
  gestures: Gesture[];
  /** The time of the latest up or cancel that left no pointer down (`performance.now()`'s time origin). */
  lastEnd: number;
}

// ---- page ---------------------------------------------------------------------------------------------------

const root = document.getElementById('lab');
if (!(root instanceof HTMLElement)) throw new Error('lab/gestures: missing #lab');

const participantInput = el('input', { type: 'number', min: '1', max: '999', step: '1', value: '1' });
const ageSelect = el(
  'select',
  {},
  el('option', { value: '' }, 'choose…'),
  el('option', { value: 'adult' }, 'adult'),
  el('option', { value: 'child' }, 'child'),
);
const exportButton = el('button', { type: 'button' }, 'Export trials (JSON)');
const newButton = el('button', { type: 'button' }, 'New participant');
const counts = el('p', { 'aria-live': 'polite' });
const prompt = el('h2', { 'aria-live': 'polite' });
const verdict = el('p', { 'aria-live': 'polite' }, 'Recogniser: waiting for the first trial.');
const canvas = el('canvas');

root.append(
  el(
    'fieldset',
    {},
    el('legend', {}, 'Participant (anonymous)'),
    el('label', {}, 'Participant P', participantInput),
    ' ',
    el('label', {}, 'Age group ', ageSelect),
    el('p', {}, exportButton, newButton),
  ),
  // Nothing above the canvas changes size during a session, so the bear never moves under a finger.
  el('div', {}, canvas),
  prompt,
  verdict,
  counts,
);
const log = logPanel(root);

// The canvas's CSS size is its backing store's size: lab pages have no CSS sizing that fits the bear's aspect
// (lab.css has none, and pages set no style attributes), so a DPR-scaled backing store would show DPR times too
// large. Measured once, with the page built; it never changes, so every trial of the session shares one geometry.
const cssWidth = Math.max(1, Math.floor(root.clientWidth));
const cssHeight = Math.max(
  1,
  Math.min(
    Math.round((cssWidth * DESIGN_HEIGHT) / DESIGN_WIDTH),
    Math.floor(window.innerHeight * MAX_VIEWPORT_SHARE),
  ),
);
const dpr = window.devicePixelRatio;
canvas.width = cssWidth;
canvas.height = cssHeight;

const g = createContext(canvas);
const rig = createRig();
const bones = boneMatrices(rig, POSES.neutral, new Float32Array(BONE_COUNT * MAT));
/** Design units → canvas px, which are CSS px here: the renderer's view and the hit test's are the same. */
const view = fitView(cssWidth, cssHeight, { scale: 0, ox: 0, oy: 0 });
const hit = (x: number, y: number): RegionId => hitTest(x, y, bones, view);

/** Draws the neutral bear and outlines `regions` (dashed, in their bones' space through the view). */
function draw(regions: readonly RegionId[]): void {
  render(g, rig, POSES.neutral, view);
  const s = view.scale;
  g.save();
  g.lineWidth = OUTLINE_PX;
  g.setLineDash(OUTLINE_DASH);
  g.strokeStyle = OUTLINE_COLOR;
  for (const r of REGIONS) {
    if (!regions.includes(r.id)) continue;
    const o = boneIndex(r.bone) * MAT;
    // The path is built under view × bone, then stroked in canvas px so the line keeps its width.
    g.setTransform(
      s * bones[o]!,
      s * bones[o + 1]!,
      s * bones[o + 2]!,
      s * bones[o + 3]!,
      s * bones[o + 4]! + view.ox,
      s * bones[o + 5]! + view.oy,
    );
    g.beginPath();
    g.ellipse(r.cx, r.cy, r.rx, r.ry, 0, 0, 2 * Math.PI);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.stroke();
  }
  g.restore();
}

// ---- trials -------------------------------------------------------------------------------------------------

/** The completed trials of this participant, and how many of them the latest export held. */
const trials: Trial[] = [];
let exported = 0;
/** Set by the first trial; the participant and age inputs are locked while it is set. */
let session: { participant: string; age: Age } | null = null;
let current: Current | null = null;
/** The pointers down in the current trial. */
const down = new Set<number>();
/** The prompts come from a shuffled bag: each gesture once in every INTENDED.length trials, in random order. */
let bag: Intended[] = [];
let intended: Intended = nextIntended();

function nextIntended(): Intended {
  if (bag.length === 0) {
    bag = [...INTENDED];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j]!, bag[i]!];
    }
  }
  return bag.pop()!;
}

function participantNumber(): number {
  const n = Math.floor(Number(participantInput.value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 999) : 1;
}

function ageGroup(): Age | null {
  const v = ageSelect.value;
  return v === 'adult' || v === 'child' ? v : null;
}

/** One gesture for the live verdict and the log (stroke updates are left out by the callers). */
function describe(x: Gesture): string {
  switch (x.g) {
    case 'tap':
      return `tap ${x.phase} ${x.region}${x.count > 1 ? ` ×${x.count}` : ''}`;
    case 'longPress':
      return `longPress ${x.phase} ${x.region}`;
    case 'stroke':
      return `stroke ${x.phase} ${x.region} ${fmt(x.pathPx, 0)} px`;
    case 'tickle':
    case 'flick':
      return `${x.g} ${x.region}`;
    default:
      // pinch, hug, allOver, cancel
      return x.g;
  }
}

function gestureList(gestures: readonly Gesture[]): string {
  const shown = gestures.filter((x) => !(x.g === 'stroke' && x.phase === 'update')).map(describe);
  return shown.length === 0 ? 'no gestures' : shown.join(' · ');
}

function refresh(): void {
  const locked = session !== null;
  participantInput.disabled = locked;
  ageSelect.disabled = locked;
  // A trial in progress (its tail included) isn't in `trials` yet: Export waits for it to close.
  exportButton.disabled = trials.length === 0 || current !== null;
  newButton.disabled = current !== null || exported < trials.length;
  const perClass = INTENDED.map((k) => `${k} ${trials.filter((t) => t.intended === k).length}`).join(', ');
  const who = session?.participant ?? `P${participantNumber()}`;
  counts.textContent = `${who}: ${trials.length} trials (${perClass}); ${exported} exported.`;
  const n = trials.length + 1;
  if (current !== null)
    prompt.textContent = `Trial ${n}: ${PROMPTS[current.trial.intended].text} (recording)`;
  else if (session === null && ageGroup() === null) prompt.textContent = 'Choose the age group to start.';
  else prompt.textContent = `Trial ${n}: ${PROMPTS[intended].text}`;
}

/** Starts a trial at a down; false (the down is ignored) while no age group is chosen. */
function startTrial(t: number): boolean {
  const age = ageGroup();
  if (session === null) {
    if (age === null) {
      log('touch ignored: choose the age group first');
      return false;
    }
    session = { participant: `P${participantNumber()}`, age };
    log(`session: ${session.participant}, ${session.age}`);
  }
  current = {
    trial: { participant: session.participant, age: session.age, intended, samples: [] },
    state: initialRecState(),
    gestures: [],
    lastEnd: t,
  };
  verdict.textContent = `Recogniser (intended ${intended}): no gestures yet`;
  refresh();
  return true;
}

function closeTrial(c: Current): void {
  current = null;
  down.clear();
  trials.push(c.trial);
  const s = c.trial.samples;
  const kinds = (type: PointerSample['type']): number => s.filter((x) => x.type === type).length;
  const span = s.length > 0 ? s[s.length - 1]!.t - s[0]!.t : 0;
  const list = gestureList(c.gestures);
  log(
    `trial ${trials.length} (${c.trial.participant}, ${c.trial.age}), intended ${c.trial.intended}: ` +
      `${s.length} samples (${kinds('down')} down, ${kinds('move')} move, ${kinds('up')} up, ` +
      `${kinds('cancel')} cancel, ${kinds('tick')} tick) over ${fmt(span, 0)} ms; ${list}`,
  );
  verdict.textContent = `Last trial (intended ${c.trial.intended}): ${list}`;
  intended = nextIntended();
  draw(PROMPTS[intended].regions);
  refresh();
}

/** Every sample the adapter feeds its recogniser: recorded into the trial and replayed through `recognize`. */
function onSample(s: PointerSample): void {
  if (s.type === 'down') {
    if (current !== null && down.size === 0 && s.t - current.lastEnd >= TRIAL_TAIL_MS) {
      // The frame loop hasn't closed the trial yet (it waits CLOSE_GRACE_MS more), so this down came before the
      // next prompt was shown: note it, so the operator can mark the trial.
      const late = s.t - current.lastEnd - TRIAL_TAIL_MS;
      closeTrial(current);
      log(
        `trial ${trials.length + 1} started ${fmt(late, 0)} ms after the tail, before its prompt was shown`,
      );
    }
    if (current === null && !startTrial(s.t)) return;
    down.add(s.id);
  }
  // A move, up, cancel or tick with no trial: its pointer went down while no age group was chosen.
  if (current === null) return;
  current.trial.samples.push(s);
  const [state, gestures] = recognize(current.state, s, hit);
  current.state = state;
  if (gestures.length > 0) {
    current.gestures.push(...gestures);
    verdict.textContent = `Recogniser (intended ${current.trial.intended}): ${gestureList(current.gestures)}`;
  }
  if ((s.type === 'up' || s.type === 'cancel') && down.delete(s.id) && down.size === 0) current.lastEnd = s.t;
}

const adapter = attachPointerAdapter(canvas, {
  hit,
  onSample,
  // The adapter's own recogniser keeps its state across trials; the page replays each trial from a fresh state.
  onGesture() {},
});

function frame(): void {
  adapter.tick();
  if (
    current !== null &&
    down.size === 0 &&
    performance.now() - current.lastEnd >= TRIAL_TAIL_MS + CLOSE_GRACE_MS
  ) {
    closeTrial(current);
  }
  requestAnimationFrame(frame);
}

/** `YYYYMMDDTHHMMSSZ`: the ISO 8601 basic format in UTC, which every file system accepts. */
function isoBasic(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

exportButton.addEventListener('click', () => {
  if (session === null || trials.length === 0 || current !== null) return;
  const name = `gestures-${session.participant}-${isoBasic(new Date())}.json`;
  const json = JSON.stringify({
    format: FORMAT,
    version: VERSION,
    canvas: { cssWidth, cssHeight, dpr },
    trials,
  });
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  el('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
  exported = trials.length;
  log(`exported ${trials.length} trials as ${name} (${json.length} characters)`);
  refresh();
});

newButton.addEventListener('click', () => {
  if (current !== null || exported < trials.length) return;
  const next = Math.min(participantNumber() + 1, 999);
  trials.length = 0;
  exported = 0;
  session = null;
  participantInput.value = String(next);
  ageSelect.value = '';
  bag = [];
  intended = nextIntended();
  draw(PROMPTS[intended].regions);
  log(`new participant: P${participantNumber()} (choose the age group)`);
  refresh();
});

participantInput.addEventListener('change', () => {
  participantInput.value = String(participantNumber());
  refresh();
});
ageSelect.addEventListener('change', refresh);

// Unexported trials live only in this page: leaving asks first.
window.addEventListener('beforeunload', (e) => {
  if (current !== null || exported < trials.length) e.preventDefault();
});

draw(PROMPTS[intended].regions);
refresh();
log(
  `lab/gestures ready: canvas ${cssWidth} × ${cssHeight} CSS px (backing store the same), devicePixelRatio ${dpr}, ` +
    `view scale ${fmt(view.scale, 4)}; ${navigator.userAgent}`,
);
requestAnimationFrame(frame);
