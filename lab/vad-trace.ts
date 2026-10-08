// Lab page for M2 real-voice feature traces (plan §7 M2 "Real-voice feature traces", Q2 amended; issue #55):
// listen-only capture on D1 with the production constraints, Silero on every frame, hold-to-talk labels on the
// ctx frame clock, and an export of trace.json + trace.bin in the format of src/vad-trace/format.ts. There is no
// session machine and no playback: the page drives the engine directly (resume, openMic, setTrace, arm) and only
// keeps the `traceBatch` feature arrays, in growable Float32Arrays. Dev-only: `pnpm dev`, then
// /lab/vad-trace.html (docs/lab.md).
// Privacy (plan Q2, docs/lab.md): feature traces only, never audio. See the comment block at saveFile.
//
// A trace fails closed: anything that could leave a gap or a wrong clock in it (Silero not running from the
// first frame, a batch that doesn't continue the previous one, an engine error, a muted or lost mic, a hidden
// page, a context that stops running, a stall) ends the recording, and a failed trace can't be exported.

import { DEFAULT_VAD_BACKEND } from '../src/audio/constants.ts';
import { createEngine, type EngineEvent } from '../src/audio/engine.ts';
import { CONSTRAINTS } from '../src/audio/mic.ts';
import { WEIGHTS_SHA256 } from '../src/dsp/silero/weights.ts';
import { createVisibility } from '../src/platform/visibility.ts';
import { createWakeLock } from '../src/platform/wake-lock.ts';
import {
  encodeTrace,
  frontEndHash,
  hopStartFrame,
  sileroStartFrame,
  type TraceMeta,
} from '../src/vad-trace/format.ts';
import { el, fmt, logPanel } from './common.ts';
import {
  CELL_SCRIPTS,
  NEXT_PHRASE_DELAY_MS,
  NOISE_ONLY_SECONDS,
  NOISE_SCRIPT_ID,
  PHRASE_SCRIPT_IDS,
  PHRASE_SCRIPTS,
  PHRASES_PER_SCRIPT,
  type ScriptId,
} from './vad-scripts.ts';

/** Waits for ctxRunning, vadReady, armed and the first trace batch. */
const SETUP_TIMEOUT_MS = 10_000;
/** Waits for the mic: the first visit shows Chrome's permission prompt. */
const MIC_TIMEOUT_MS = 60_000;
/**
 * Ctx frames a batch's first hop or Silero frame may differ from hopStartFrame / sileroStartFrame of the
 * values before it. The worklet stamps exact frames and two roundings give at most 1; a missing batch is off
 * by a whole hop (≥ 441 frames).
 */
const FRAME_SLIP = 2;
/** No accepted batch for this long while capturing fails the trace (a batch comes every 250 ms). */
const STALL_MS = 1000;
/** Stop keeps recording this long after the later of the Stop press and the last release (plan §7 M2's
 *  end-of-speech latency needs the hangover after the last phrase). */
const TAIL_SECONDS = 1.5;
/** The UI tick: the stall watchdog, the first-batch timeout and the countdowns. */
const UI_TICK_MS = 100;
/** A saved file's object URL is released this long after its click. */
const REVOKE_MS = 10_000;
/** Initial capacity (values) of each growable stream. */
const INITIAL_CAPACITY = 6000;
const HOPS_PER_SECOND = 100;
/** The noise-only recording ends when it holds this many hops (a whole number of 25-hop batches). */
const NOISE_HOPS = NOISE_ONLY_SECONDS * HOPS_PER_SECOND;
/** A hold shorter than this is dropped (a tap, or a page-turner that sends key-up at once). */
const MIN_HOLD_SECONDS = 0.05;
/** A hold longer than this is logged: the short-phrase metrics assume phrases under 3 s (plan §7 M2). */
const LONG_HOLD_SECONDS = 3;
/**
 * The hold button's canvas: this share of the viewport's height (the button must be at least 40 % of it), and
 * the page's width less the button's padding, border and margin. lab.css has no class that tall and lab pages
 * set no style attributes, so the canvas is sized by its width and height attributes, in CSS px.
 */
const HOLD_HEIGHT_SHARE = 0.45;
const HOLD_SIDE_PX = 48;
const HOLD_MIN_WIDTH = 200;
/** The live plot shows the last PLOT_SECONDS; bandDb is drawn over [PLOT_DB_MIN, PLOT_DB_MAX] dBFS. */
const PLOT_SECONDS = 10;
const PLOT_DB_MIN = -90;
const PLOT_DB_MAX = 0;
/** Length of a Silero frame (512 samples at 16 kHz). */
const SILERO_FRAME_SECONDS = 0.032;
/** Hold-to-talk keys, matched by KeyboardEvent.code or .key (a Bluetooth page-turner sends one of them). */
const HOLD_CODES: ReadonlySet<string> = new Set(['Space', 'PageDown', 'PageUp', 'ArrowRight', 'Enter']);
const HOLD_KEYS: ReadonlySet<string> = new Set([' ', 'PageDown', 'PageUp', 'ArrowRight', 'Enter']);
const COLORS = {
  idle: '#5f6368',
  prompt: '#1a73e8',
  holding: '#d93025',
  countdown: '#b06000',
  done: '#188038',
  text: '#ffffff',
  sileroP: '#1a73e8',
  bandDb: '#e8710a',
  label: 'rgba(52, 168, 83, 0.3)',
} as const;

const SESSIONS: readonly TraceMeta['session'][] = ['A', 'B', 'other'];
const CONDITIONS: readonly TraceMeta['condition'][] = ['quiet', 'fan', 'tv', 'music'];
const PLACEMENTS: readonly TraceMeta['placement'][] = ['arm', 'table', 'none'];
const SPEAKERS: readonly TraceMeta['speaker'][] = ['adult', 'child'];
const SCRIPT_IDS: readonly ScriptId[] = [...PHRASE_SCRIPT_IDS, NOISE_SCRIPT_ID];
const PLACEMENT_TEXT: Readonly<Record<TraceMeta['placement'], string>> = {
  arm: "arm (arm's length)",
  table: 'table (on a table)',
  none: 'none',
};
const SCRIPT_TEXT: Readonly<Record<ScriptId, string>> = {
  S1: 'S1 (30 phrases)',
  S2: 'S2 (30 phrases)',
  S3: 'S3 (30 phrases)',
  S4: 'S4 (30 phrases)',
  S5: 'S5 (30 phrases)',
  S6: 'S6 (30 phrases)',
  noise: 'noise (15 min, no prompts)',
};

type TraceBatch = Extract<EngineEvent, { t: 'traceBatch' }>;

/** The setup a recording was started with: the export uses only this snapshot (the form may change later). */
interface Setup {
  readonly session: TraceMeta['session'];
  readonly condition: TraceMeta['condition'];
  readonly placement: TraceMeta['placement'];
  readonly speaker: TraceMeta['speaker'];
  readonly scriptId: ScriptId;
  readonly device: string;
  readonly chrome: string;
}

/**
 * starting: Start pressed, waiting for the context, the mic, Silero, `armed` and the first batch;
 * capturing: the first batch passed its check, holds are accepted;
 * finishing: Stop pressed, recording the tail; stopped: the trace is complete and can be exported;
 * failed: ended by an error (or a cancelled start), nothing to export.
 */
type Phase = 'starting' | 'capturing' | 'finishing' | 'stopped' | 'failed';

/** What started a hold: a pointer (its pointerId) or a key (its code); only the same source ends it. */
type HoldSource =
  { readonly kind: 'pointer'; readonly id: number } | { readonly kind: 'key'; readonly id: string };

/** A growable Float32Array: values are only appended; capacity doubles. */
class Floats {
  #buf = new Float32Array(INITIAL_CAPACITY);
  #n = 0;

  get length(): number {
    return this.#n;
  }

  append(x: Float32Array): void {
    const need = this.#n + x.length;
    if (need > this.#buf.length) {
      let cap = Math.max(INITIAL_CAPACITY, this.#buf.length * 2);
      while (cap < need) cap *= 2;
      const next = new Float32Array(cap);
      next.set(this.#buf.subarray(0, this.#n));
      this.#buf.fill(0);
      this.#buf = next;
    }
    this.#buf.set(x, this.#n);
    this.#n = need;
  }

  /** The values so far (a view, not a copy). */
  view(): Float32Array {
    return this.#buf.subarray(0, this.#n);
  }

  at(i: number): number {
    return this.#buf[i] ?? Number.NaN;
  }

  /** Zero-fills and drops every value. */
  wipe(): void {
    this.#buf.fill(0);
    this.#buf = new Float32Array(0);
    this.#n = 0;
  }
}

interface Recording {
  /** The arm epoch and the mic request id (a new one per recording, so late events of an older one never match). */
  readonly epoch: number;
  readonly setup: Setup;
  phase: Phase;
  /** Why it failed (phase 'failed'). */
  error: string;
  ctx: AudioContext | null;
  ctxRate: number;
  /** ISO 8601 time of the arm. */
  startedAt: string;
  /** performance.now() of the arm, until the first batch arrives. */
  armedAt: number | null;
  /** Ctx frame of hop 0 and Silero frame 0: the first batch's hop0Frame. */
  firstFrame: number | null;
  readonly rawDb: Floats;
  readonly bandDb: Floats;
  readonly voicing: Floats;
  readonly sileroP: Floats;
  inferMsSum: number;
  inferMsMax: number;
  /** Hold-to-talk marks, in ctx frames. */
  readonly labels: Array<{ press: number; release: number }>;
  /** The hold in progress: its press (ctx frame), what started it, and whether it cancelled a countdown. */
  hold: { readonly press: number; readonly source: HoldSource; readonly early: boolean } | null;
  /** Index of the phrase shown (short-phrase scripts); PHRASES_PER_SCRIPT once the script is done. */
  phrase: number;
  /** performance.now() at which the next phrase appears (the countdown after a release), or null. */
  countdownEnd: number | null;
  /** performance.now() of the latest accepted batch (the stall watchdog). */
  lastBatchAt: number;
  /** While finishing: the trace ends once its hops reach this ctx frame. */
  endFrame: number | null;
  /** Export has saved the trace at least once. */
  exported: boolean;
  /** An export is building its files. */
  exporting: boolean;
}

// ---- page ---------------------------------------------------------------------------------------------------

const found = document.getElementById('lab');
if (!(found instanceof HTMLElement)) throw new Error('lab/vad-trace: missing #lab');
const root: HTMLElement = found;

function selectOf(id: string, values: readonly string[], text?: (v: string) => string): HTMLSelectElement {
  return el(
    'select',
    { id },
    el('option', { value: '' }, 'choose…'),
    ...values.map((v) => el('option', { value: v }, text === undefined ? v : text(v))),
  );
}

/** The select's value if it is one of `allowed`, else null. */
function pick<T extends string>(select: HTMLSelectElement, allowed: readonly T[]): T | null {
  const v = select.value;
  return allowed.find((a) => a === v) ?? null;
}

function textOf<T extends string>(table: Readonly<Record<T, string>>, allowed: readonly T[]) {
  return (v: string): string => {
    const k = allowed.find((a) => a === v);
    return k === undefined ? v : table[k];
  };
}

const sessionSelect = selectOf('session', SESSIONS);
const conditionSelect = selectOf('condition', CONDITIONS);
const placementSelect = selectOf('placement', PLACEMENTS, textOf(PLACEMENT_TEXT, PLACEMENTS));
const speakerSelect = selectOf('speaker', SPEAKERS);
const scriptSelect = selectOf('script', SCRIPT_IDS, textOf(SCRIPT_TEXT, SCRIPT_IDS));
const deviceInput = el('input', { type: 'text', id: 'device', size: '30', autocomplete: 'off' });
const notesInput = el('input', { type: 'text', id: 'notes', size: '40', autocomplete: 'off' });
const chromeValue = el('code', { id: 'chrome' }, '…');
/** Every setup control the Start snapshot covers (Notes is read at Export instead). */
const setupControls: readonly (HTMLSelectElement | HTMLInputElement)[] = [
  sessionSelect,
  conditionSelect,
  placementSelect,
  speakerSelect,
  scriptSelect,
  deviceInput,
];

const startButton = el('button', { type: 'button', id: 'start' }, 'Start');
const stopButton = el('button', { type: 'button', id: 'stop' }, 'Stop');
const exportButton = el('button', { type: 'button', id: 'export' }, 'Export');
const discardButton = el('button', { type: 'button', id: 'discard' }, 'Discard');
const statusText = el('strong', {}, 'Choose the setup, then press Start.');
/** Next to Export while a trace is held: whether the run completed its script (a stray Stop is flagged). */
const completenessText = el('strong', { id: 'completeness' });
const holdCanvas = el('canvas', { width: '300', height: '300' });
const holdButton = el('button', { type: 'button', id: 'hold', 'aria-label': 'Hold to talk' }, holdCanvas);
const plotCanvas = el('canvas', { class: 'lab-spectrum', id: 'plot' });

const rateValue = el('dd', { id: 'rate' }, '–');
/**
 * The trace needs Silero p on every frame (plan §7 M2). createEngine's arm() sends the DSP worker `reset{vad}`
 * with DEFAULT_VAD_BACKEND (this page never calls the e2e-only setVadBackend), so the effective backend is the
 * default; the first batch's check (onTraceBatch) fails the recording unless Silero ran from the epoch's first
 * frame.
 */
const backendValue = el('dd', { id: 'backend' }, `${DEFAULT_VAD_BACKEND} (default)`);
const wakeValue = el('dd', { id: 'wake' }, '–');
const elapsedValue = el('dd', { id: 'elapsed' }, '–');
const n10Value = el('dd', { id: 'n10' }, '0');
const n32Value = el('dd', { id: 'n32' }, '0');
const labelsValue = el('dd', { id: 'labels' }, '0');
const scriptValue = el('dd', { id: 'progress' }, '–');
const inferValue = el('dd', { id: 'infer' }, '–');

function field(label: string, control: HTMLElement): HTMLElement {
  return el('p', {}, el('label', {}, `${label} `, control));
}

root.append(
  el(
    'fieldset',
    {},
    el('legend', {}, 'Setup'),
    field('Session', sessionSelect),
    field('Condition', conditionSelect),
    field('Placement', placementSelect),
    field('Speaker', speakerSelect),
    field('Script', scriptSelect),
    field('Device', deviceInput),
    el('p', {}, 'Chrome ', chromeValue),
    field('Notes (optional, read at Export)', notesInput),
  ),
  el('p', {}, startButton, stopButton, exportButton, discardButton, completenessText),
  el('p', { id: 'status' }, statusText),
  el('p', {}, holdButton),
  el(
    'dl',
    { class: 'lab-values' },
    el('dt', {}, 'Context rate'),
    rateValue,
    el('dt', {}, 'VAD backend'),
    backendValue,
    el('dt', {}, 'Wake lock'),
    wakeValue,
    el('dt', {}, 'Trace length'),
    elapsedValue,
    el('dt', {}, '10 ms hops (n10)'),
    n10Value,
    el('dt', {}, 'Silero frames (n32)'),
    n32Value,
    el('dt', {}, 'Labels'),
    labelsValue,
    el('dt', {}, 'Script'),
    scriptValue,
    el('dt', {}, 'Silero inference'),
    inferValue,
  ),
  el('h2', {}, 'Last 10 s'),
  plotCanvas,
);
const log = logPanel(root);

/** An error's name and message (a DOMException is an Error), or the value as text. */
function describe(value: unknown): string {
  return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}

// ---- engine ---------------------------------------------------------------------------------------------------

interface Waiter {
  readonly match: (e: EngineEvent) => boolean;
  readonly resolve: (e: EngineEvent | null) => void;
}

const waiters = new Set<Waiter>();
/** A `vadReady` arrived since the current worker started (cleared by workerFailed). */
let sileroReady = false;

/** Events too frequent, or handled elsewhere, to log. */
const QUIET_EVENTS: ReadonlySet<EngineEvent['t']> = new Set(['level', 'seg', 'floorSnapshot']);
/** Events that end a recording that is starting, capturing or finishing. */
const FATAL_EVENTS: ReadonlySet<EngineEvent['t']> = new Set([
  'vadError',
  'workerFailed',
  'ctxError',
  'ctxResumeFailed',
  'micDenied',
  'noDevice',
  'trackEnded',
  'trackMuted',
]);

const engine = createEngine({ connectWorkletOutput: false, onEvent });

function onEvent(e: EngineEvent): void {
  if (e.t === 'traceBatch') {
    onTraceBatch(e);
    return;
  }
  if (!QUIET_EVENTS.has(e.t)) log(`engine: ${JSON.stringify(e)}`);
  if (e.t === 'vadReady') sileroReady = true;
  if (e.t === 'workerFailed') sileroReady = false;
  for (const w of waiters) if (w.match(e)) w.resolve(e);
  const r = rec;
  if (r === null || !isActive(r) || !FATAL_EVENTS.has(e.t)) return;
  if ('req' in e && e.req !== r.epoch) return; // an older recording's mic request
  fail(r, 'message' in e ? `${e.t}: ${e.message}` : e.t);
}

/** The next engine event that `match`es, or null after `timeoutMs` or when the recording ends. Register it
 *  before the call that emits the event. */
function waitEvent(match: (e: EngineEvent) => boolean, timeoutMs: number): Promise<EngineEvent | null> {
  return new Promise((resolve) => {
    const w: Waiter = {
      match,
      resolve(e: EngineEvent | null): void {
        waiters.delete(w);
        clearTimeout(timer);
        resolve(e);
      },
    };
    const timer = setTimeout(() => w.resolve(null), timeoutMs);
    waiters.add(w);
  });
}

// ---- page lifecycle: visibility, wake lock ---------------------------------------------------------------------

const visibility = createVisibility();
const wakeLock = createWakeLock(navigator, visibility, (...args: unknown[]) => {
  log(`wake lock: ${args.map(describe).join(': ')}`);
});

visibility.subscribe((v) => {
  if (v === 'hidden') {
    const r = rec;
    if (r !== null && isActive(r)) fail(r, 'the page was hidden');
  } else if (v === 'pagehide') {
    onPageHide();
  }
});

/** The context whose statechange is watched (the engine keeps one context for the page's life). */
let watchedCtx: AudioContext | null = null;

function watchContext(ctx: AudioContext): void {
  if (watchedCtx === ctx) return;
  watchedCtx = ctx;
  ctx.addEventListener('statechange', () => {
    log(`context state: ${ctx.state}`);
    const r = rec;
    if (r !== null && (r.phase === 'capturing' || r.phase === 'finishing') && ctx.state !== 'running') {
      fail(r, `the audio context is ${ctx.state}`);
    }
  });
}

// ---- recording ------------------------------------------------------------------------------------------------

let rec: Recording | null = null;
let nextEpoch = 1;
/** device and chrome have been detected (Start waits for them). */
let clientReady = false;
let chromeVersion = 'unknown';

function isActive(r: Recording): boolean {
  return r.phase === 'starting' || r.phase === 'capturing' || r.phase === 'finishing';
}

function readSetup(): Setup | null {
  const session = pick(sessionSelect, SESSIONS);
  const condition = pick(conditionSelect, CONDITIONS);
  const placement = pick(placementSelect, PLACEMENTS);
  const speaker = pick(speakerSelect, SPEAKERS);
  const scriptId = pick(scriptSelect, SCRIPT_IDS);
  const device = deviceInput.value.trim();
  if (session === null || condition === null || placement === null || speaker === null) return null;
  if (scriptId === null || device === '' || !clientReady) return null;
  return { session, condition, placement, speaker, scriptId, device, chrome: chromeVersion };
}

/** The current ctx frame: Math.round(ctx.currentTime · ctx.sampleRate), the clock of the hold-to-talk marks. */
function nowFrame(r: Recording): number {
  const c = r.ctx;
  return c === null ? 0 : Math.round(c.currentTime * c.sampleRate);
}

function frames(r: Recording): { firstFrame: number; ctxRate: number } {
  return { firstFrame: r.firstFrame ?? 0, ctxRate: r.ctxRate };
}

class Cancelled extends Error {}

function checkStarting(r: Recording): void {
  if (rec !== r || r.phase !== 'starting') throw new Cancelled('start cancelled');
}

/** Plan §7 M2 start order: resume, openMic, (Silero ready), setTrace(true), arm; then the first batch. */
async function start(): Promise<void> {
  const setup = readSetup();
  if (setup === null) return;
  const prev = rec;
  if (prev !== null) {
    if (isActive(prev) || (prev.phase === 'stopped' && !prev.exported)) return;
    dropRecording(prev);
  }
  const epoch = nextEpoch++;
  const r: Recording = {
    epoch,
    setup,
    phase: 'starting',
    error: '',
    ctx: null,
    ctxRate: 0,
    startedAt: '',
    armedAt: null,
    firstFrame: null,
    rawDb: new Floats(),
    bandDb: new Floats(),
    voicing: new Floats(),
    sileroP: new Floats(),
    inferMsSum: 0,
    inferMsMax: 0,
    labels: [],
    hold: null,
    phrase: 0,
    countdownEnd: null,
    lastBatchAt: 0,
    endFrame: null,
    exported: false,
    exporting: false,
  };
  rec = r;
  log(
    `start: epoch ${epoch}; session ${setup.session}, condition ${setup.condition}, placement ` +
      `${setup.placement}, speaker ${setup.speaker}, script ${setup.scriptId}, device "${setup.device}", ` +
      `chrome ${setup.chrome}`,
  );
  setStatus('Starting…');
  refresh();
  wakeLock.set(true);
  try {
    const running = waitEvent((e) => e.t === 'ctxRunning' || e.t === 'ctxResumeFailed', SETUP_TIMEOUT_MS);
    engine.resume().catch((err: unknown) => log(`resume failed: ${describe(err)}`));
    const c = await running;
    checkStarting(r);
    const ctx = engine.context();
    if (c?.t !== 'ctxRunning' || ctx === null) throw new Error(`no running context (${c?.t ?? 'timeout'})`);
    r.ctx = ctx;
    r.ctxRate = ctx.sampleRate;
    watchContext(ctx);
    rateValue.textContent = `${ctx.sampleRate} Hz`;

    const mic = waitEvent(
      (e) => (e.t === 'micGranted' || e.t === 'micDenied' || e.t === 'noDevice') && e.req === epoch,
      MIC_TIMEOUT_MS,
    );
    engine.openMic(epoch);
    const m = await mic;
    checkStarting(r);
    if (m?.t !== 'micGranted') throw new Error(`no microphone (${m?.t ?? 'timeout'})`);

    // Arming before the model is set would start the epoch on energy and switch to Silero later, so the first
    // batch's sil0Frame would come after its hop0Frame.
    if (!sileroReady) {
      const ready = await waitEvent((e) => e.t === 'vadReady', SETUP_TIMEOUT_MS);
      checkStarting(r);
      if (ready === null)
        throw new Error(`Silero model not ready (no vadReady within ${SETUP_TIMEOUT_MS} ms)`);
    }

    engine.setTrace(true);
    const armed = waitEvent((e) => e.t === 'armed' && e.epoch === epoch, SETUP_TIMEOUT_MS);
    r.startedAt = new Date().toISOString();
    engine.arm(epoch);
    const a = await armed;
    checkStarting(r);
    if (a?.t !== 'armed') throw new Error('no armed event');
    r.armedAt = performance.now(); // the tick fails the start if no batch arrives within SETUP_TIMEOUT_MS
    log(`armed: epoch ${epoch}, armFrame ${a.armFrame}; waiting for the first trace batch`);
  } catch (err) {
    if (rec === r && r.phase === 'starting') fail(r, describe(err));
  }
}

/** D4: checks a batch of the current epoch against the trace so far, then appends it. */
function onTraceBatch(e: TraceBatch): void {
  const r = rec;
  if (r === null || !isActive(r) || e.epoch !== r.epoch) return; // a stale or late batch
  const hops = e.rawDb.length;
  if (hops === 0 || e.bandDb.length !== hops || e.voicing.length !== hops) {
    fail(r, `malformed batch (${hops} raw, ${e.bandDb.length} band, ${e.voicing.length} voicing values)`);
    return;
  }
  if (r.firstFrame === null) {
    if (e.sileroP.length === 0 || !Number.isFinite(e.sil0Frame)) {
      fail(r, `Silero is not the effective backend (sil0Frame ${e.sil0Frame})`);
      return;
    }
    if (e.sil0Frame !== e.hop0Frame) {
      fail(r, `trace started mid-epoch (hop0Frame ${e.hop0Frame}, sil0Frame ${e.sil0Frame})`);
      return;
    }
    r.firstFrame = e.hop0Frame;
    r.armedAt = null;
    r.phase = 'capturing';
    log(
      `first batch: hop0Frame = sil0Frame = ${e.hop0Frame} (epoch ${r.epoch}); capturing, ` +
        `wake lock held ${wakeLock.held()}`,
    );
    onCaptureStarted(r);
  } else {
    const at = frames(r);
    const wantHop = hopStartFrame(at, r.rawDb.length);
    const wantSil = sileroStartFrame(at, r.sileroP.length);
    if (!(Math.abs(e.hop0Frame - wantHop) <= FRAME_SLIP)) {
      fail(r, notContiguous(e.hop0Frame, wantHop, r.ctxRate));
      return;
    }
    if (e.sileroP.length === 0 || !(Math.abs(e.sil0Frame - wantSil) <= FRAME_SLIP)) {
      fail(
        r,
        `Silero stream broken: a batch has ${e.sileroP.length} Silero values from frame ${e.sil0Frame}, ` +
          `expected some from ${wantSil}`,
      );
      return;
    }
  }
  r.rawDb.append(e.rawDb);
  r.bandDb.append(e.bandDb);
  r.voicing.append(e.voicing);
  r.sileroP.append(e.sileroP);
  for (const ms of e.inferMs) {
    r.inferMsSum += ms;
    if (ms > r.inferMsMax) r.inferMsMax = ms;
  }
  r.lastBatchAt = performance.now();
  const n10 = r.rawDb.length;
  if (r.setup.scriptId === NOISE_SCRIPT_ID && n10 >= NOISE_HOPS) {
    stopCapture(r, `${NOISE_ONLY_SECONDS / 60} min of noise recorded`);
  } else if (r.phase === 'finishing' && r.endFrame !== null && hopStartFrame(frames(r), n10) >= r.endFrame) {
    stopCapture(r, `${TAIL_SECONDS} s tail recorded`);
  }
  showValues();
  drawHold(); // the noise-only time left
  drawPlot();
}

/**
 * The "not contiguous" failure for a batch that starts at `hop0Frame` where the trace so far ends at `wantHop`. A
 * later start is a capture jump: when the audio thread stalls for over 0.5 s, the capture worklet re-anchors its
 * VAD feed at the frame it resumes at (#237), and the DSP worker ends the batch at the gap (#244), so the frames in
 * between were not delivered to the VAD. An earlier start would be a bug.
 */
function notContiguous(hop0Frame: number, wantHop: number, ctxRate: number): string {
  const gap = hop0Frame - wantHop;
  if (!(gap > 0)) {
    return `trace not contiguous: a batch starts at hop frame ${hop0Frame}, expected ${wantHop}`;
  }
  const ms = ((gap / ctxRate) * 1000).toFixed(0);
  return (
    `trace not contiguous: a capture jump of ${gap} frames (${ms} ms) before hop frame ${hop0Frame} ` +
    `(an audio-thread stall of over 0.5 s re-anchors the capture; those frames were not delivered to the VAD)`
  );
}

/** Capture has started: the first batch passed its check, so holds are accepted from now on. */
function onCaptureStarted(r: Recording): void {
  setStatus(
    r.setup.scriptId === NOISE_SCRIPT_ID
      ? 'Recording noise only: stay quiet, and hold the button if anyone speaks.'
      : 'Recording: hold the button while you say each phrase.',
  );
  refresh();
  holdButton.focus();
}

/** Stop pressed while capturing: record TAIL_SECONDS past the later of now and the last release, then stop. */
function finish(r: Recording): void {
  if (r.phase !== 'capturing') return;
  dropHold(r, 'stop');
  if (r.countdownEnd !== null) r.phrase++; // the phrase was said and released; only its countdown was left
  r.countdownEnd = null;
  const lastRelease = r.labels.at(-1)?.release ?? 0;
  r.endFrame = Math.max(nowFrame(r), lastRelease) + Math.round(TAIL_SECONDS * r.ctxRate);
  r.phase = 'finishing';
  log(`stop: recording until ctx frame ${r.endFrame} (${TAIL_SECONDS} s tail)`);
  setStatus(`Finishing (${TAIL_SECONDS} s)…`);
  refresh();
}

/** Stops the engine's part of a recording: no trace, no arm, no mic, context suspended, no wake lock. */
function teardown(r: Recording): void {
  dropHold(r, 'end of the recording');
  r.countdownEnd = null;
  engine.setTrace(false); // its flush of the partial batch is ignored: the phase is no longer active
  engine.disarm(r.epoch);
  engine.closeMic();
  engine.suspend().catch((err: unknown) => log(`suspend failed: ${describe(err)}`));
  wakeLock.set(false);
  for (const w of waiters) w.resolve(null);
}

/** The trace is complete. */
function stopCapture(r: Recording, why: string): void {
  r.phase = 'stopped';
  r.endFrame = null;
  teardown(r);
  const n10 = r.rawDb.length;
  const n32 = r.sileroP.length;
  const meanMs = n32 > 0 ? r.inferMsSum / n32 : Number.NaN;
  log(
    `stopped (${why}): n10 ${n10} (${fmt(n10 / HOPS_PER_SECOND, 2)} s), n32 ${n32}, ${r.labels.length} labels; ` +
      `Silero inference mean ${fmt(meanMs, 2)} ms, max ${fmt(r.inferMsMax, 2)} ms`,
  );
  log(completeness(r));
  setStatus(`Stopped: ${fmt(n10 / HOPS_PER_SECOND, 2)} s, ${r.labels.length} labels. Export the trace.`);
  refresh();
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Whether a stopped run is a complete protocol trace (plan §7 M2: 30 phrases per cell, 15 min of noise only).
 * An early Stop still exports (the counts are in the meta for the checks downstream), but is flagged here.
 */
function completeness(r: Recording): string {
  const labels = plural(r.labels.length, 'label', 'labels');
  if (r.setup.scriptId === NOISE_SCRIPT_ID) {
    const total = minutes(NOISE_ONLY_SECONDS);
    return r.rawDb.length >= NOISE_HOPS
      ? `Complete: ${total} of noise, ${labels}.`
      : `Stopped early: ${minutes(r.rawDb.length / HOPS_PER_SECOND)} of ${total} of noise (incomplete: not a protocol trace).`;
  }
  const done = Math.min(r.phrase, PHRASES_PER_SCRIPT);
  return done >= PHRASES_PER_SCRIPT
    ? `Complete: ${PHRASES_PER_SCRIPT} of ${PHRASES_PER_SCRIPT} phrases, ${labels}.`
    : `Stopped early: ${done} of ${PHRASES_PER_SCRIPT} phrases, ${labels} (incomplete: not a protocol trace).`;
}

/** Ends a recording that is starting, capturing or finishing with an error; its data is wiped. */
function fail(r: Recording, reason: string): void {
  if (!isActive(r)) return;
  r.phase = 'failed';
  r.error = reason;
  teardown(r);
  wipe(r);
  log(`failed: ${reason}`);
  setStatus(`Failed: ${reason}. This trace can't be exported; press Start to record it again.`);
  refresh();
}

/** Zero-fills and drops a recording's streams and labels. */
function wipe(r: Recording): void {
  r.rawDb.wipe();
  r.bandDb.wipe();
  r.voicing.wipe();
  r.sileroP.wipe();
  r.labels.length = 0;
}

function dropRecording(r: Recording): void {
  wipe(r);
  if (rec === r) rec = null;
}

function stop(): void {
  const r = rec;
  if (r === null) return;
  if (r.phase === 'starting') {
    r.phase = 'failed';
    r.error = 'cancelled';
    teardown(r);
    dropRecording(r);
    log('start cancelled');
    setStatus('Start cancelled.');
    refresh();
  } else if (r.phase === 'capturing') {
    finish(r);
  }
}

// ---- hold-to-talk ---------------------------------------------------------------------------------------------

/** The phrase shown (short-phrase scripts), or '' (noise-only, or the script is done). */
function phraseOf(r: Recording): string {
  const id = r.setup.scriptId;
  return id === NOISE_SCRIPT_ID ? '' : (PHRASE_SCRIPTS[id][r.phrase] ?? '');
}

function sameSource(a: HoldSource, b: HoldSource): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** Drops a hold still in progress (Stop, the end of a recording): it has no release, so it is no label. */
function dropHold(r: Recording, why: string): void {
  if (r.hold === null) return;
  log(`${why}: the press at ctx frame ${r.hold.press} is still held, dropped`);
  r.hold = null;
  if (resizePending) sizeHold();
  drawHold();
}

/**
 * A press, while capturing only (so every label starts inside the trace): press = Math.round(ctx.currentTime ·
 * ctx.sampleRate). One hold at a time. A press during the countdown is still recorded (labels are the ground
 * truth of when someone spoke) and cancels the countdown; its release starts a new one. Returns whether the
 * press started a hold.
 */
function press(source: HoldSource): boolean {
  const r = rec;
  if (r === null || r.phase !== 'capturing' || r.hold !== null) return false;
  const frame = nowFrame(r);
  const early = r.countdownEnd !== null;
  if (early) {
    const last = r.labels.at(-1);
    const gapMs = last === undefined ? Number.NaN : ((frame - last.release) / r.ctxRate) * 1000;
    log(`early press: gap ${fmt(gapMs, 0)} ms < ${NEXT_PHRASE_DELAY_MS}`);
    r.countdownEnd = null;
  }
  r.hold = { press: frame, source, early };
  drawHold();
  drawPlot();
  return true;
}

/**
 * The release of the hold `source` started: release = Math.round(ctx.currentTime · ctx.sampleRate). A hold
 * shorter than MIN_HOLD_SECONDS is dropped; otherwise it becomes a label, and in a short-phrase script the next
 * phrase appears NEXT_PHRASE_DELAY_MS later (after the last phrase, the script is done at once).
 */
function release(source: HoldSource): void {
  const r = rec;
  if (r === null || r.hold === null || !sameSource(r.hold.source, source)) return;
  const pressFrame = r.hold.press;
  const early = r.hold.early;
  r.hold = null;
  if (resizePending) sizeHold();
  if (r.phase !== 'capturing') return;
  const frame = nowFrame(r);
  const seconds = (frame - pressFrame) / r.ctxRate;
  if (frame - pressFrame < Math.round(MIN_HOLD_SECONDS * r.ctxRate)) {
    log(`short hold (${fmt(seconds * 1000, 0)} ms): dropped; check the page-turner holds`);
  } else {
    r.labels.push({ press: pressFrame, release: frame });
    // An early press is an extra utterance, not the shown phrase (that one was already said).
    const phrase = early ? '' : phraseOf(r);
    log(
      `label ${r.labels.length}: press ${pressFrame}, release ${frame} (${fmt(seconds, 2)} s)` +
        (early
          ? ', extra label (early press)'
          : phrase === ''
            ? ''
            : `, phrase ${r.phrase + 1}: "${phrase}"`),
    );
    if (seconds > LONG_HOLD_SECONDS) log(`long hold: ${fmt(seconds, 2)} s > ${LONG_HOLD_SECONDS} s`);
    if (r.setup.scriptId !== NOISE_SCRIPT_ID && r.phrase < PHRASES_PER_SCRIPT) {
      if (r.phrase + 1 < PHRASES_PER_SCRIPT) {
        r.countdownEnd = performance.now() + NEXT_PHRASE_DELAY_MS;
      } else {
        r.phrase = PHRASES_PER_SCRIPT;
        log(`script ${r.setup.scriptId} done: press Stop`);
      }
    }
  }
  showValues();
  drawHold();
  drawPlot();
}

function isHoldKey(e: KeyboardEvent): boolean {
  return HOLD_CODES.has(e.code) || HOLD_KEYS.has(e.key);
}

function keySource(e: KeyboardEvent): HoldSource {
  return { kind: 'key', id: e.code === '' ? e.key : e.code };
}

/** A key event for the hold: only while capturing or finishing, and not while typing in a text field. */
function holdKeyEvent(e: KeyboardEvent): boolean {
  const r = rec;
  if (r === null || (r.phase !== 'capturing' && r.phase !== 'finishing') || !isHoldKey(e)) return false;
  const t = e.target;
  return !(
    t instanceof HTMLInputElement ||
    t instanceof HTMLSelectElement ||
    t instanceof HTMLTextAreaElement
  );
}

// ---- drawing ------------------------------------------------------------------------------------------------

/** A window resize that came during a hold; applied at the release, so the button never moves under a finger. */
let resizePending = false;

function sizeHold(): void {
  resizePending = false;
  const w = Math.max(HOLD_MIN_WIDTH, Math.floor(root.clientWidth) - HOLD_SIDE_PX);
  const h = Math.round(HOLD_HEIGHT_SHARE * window.innerHeight);
  if (holdCanvas.width !== w) holdCanvas.width = w;
  if (holdCanvas.height !== h) holdCanvas.height = h;
  drawHold();
}

/** What the hold button shows: its colour, a large title (wrapped) and a one-line detail. */
function holdView(): { color: string; title: string; detail: string } {
  const r = rec;
  if (r === null || r.phase === 'stopped' || r.phase === 'failed') {
    return { color: COLORS.idle, title: 'Hold to talk', detail: 'Press Start first' };
  }
  if (r.phase === 'starting')
    return { color: COLORS.idle, title: 'Starting…', detail: 'Wait for the prompt' };
  if (r.phase === 'finishing') {
    return { color: COLORS.idle, title: 'Finishing…', detail: `Recording ${TAIL_SECONDS} s more` };
  }
  const noise = r.setup.scriptId === NOISE_SCRIPT_ID;
  if (r.hold !== null) {
    return {
      color: COLORS.holding,
      title: noise ? 'Holding' : phraseOf(r) || 'Holding',
      detail: 'Let go just after the speech ends',
    };
  }
  if (noise) {
    const left = Math.max(0, NOISE_ONLY_SECONDS - r.rawDb.length / HOPS_PER_SECOND);
    return {
      color: COLORS.done,
      title: 'Noise only: stay quiet',
      detail: `${minutes(left)} left; hold the button if anyone speaks`,
    };
  }
  if (r.phrase >= PHRASES_PER_SCRIPT) {
    return { color: COLORS.done, title: 'Script done: press Stop', detail: `${r.labels.length} labels` };
  }
  if (r.countdownEnd !== null) {
    const s = Math.max(0, r.countdownEnd - performance.now()) / 1000;
    return {
      color: COLORS.countdown,
      title: `Next phrase in ${fmt(s, 1)} s`,
      detail: `Phrase ${r.phrase + 2} of ${PHRASES_PER_SCRIPT} comes next`,
    };
  }
  return {
    color: COLORS.prompt,
    title: phraseOf(r),
    detail: `Phrase ${r.phrase + 1} of ${PHRASES_PER_SCRIPT}: hold the button while you say it`,
  };
}

/** `text` split at spaces into lines no wider than `maxWidth` in g's current font. */
function wrapLines(g: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && g.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

function drawHold(): void {
  const g = holdCanvas.getContext('2d');
  if (g === null) return;
  const w = holdCanvas.width;
  const h = holdCanvas.height;
  const v = holdView();
  g.fillStyle = v.color;
  g.fillRect(0, 0, w, h);
  g.fillStyle = COLORS.text;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const big = Math.max(18, Math.round(h * 0.1));
  g.font = `600 ${big}px system-ui, sans-serif`;
  const lines = wrapLines(g, v.title, w * 0.9);
  const lineHeight = big * 1.25;
  const top = h * 0.42 - ((lines.length - 1) * lineHeight) / 2;
  for (let i = 0; i < lines.length; i++) g.fillText(lines[i] ?? '', w / 2, top + i * lineHeight, w * 0.95);
  g.font = `${Math.max(12, Math.round(h * 0.045))}px system-ui, sans-serif`;
  g.fillText(v.detail, w / 2, h * 0.85, w * 0.95);
}

/** The plot's CSS colour, for the axis line and the legend (read live, so it follows the colour scheme). */
const plotStyle = getComputedStyle(plotCanvas);

/** The last PLOT_SECONDS of sileroP (0–1) and bandDb, the labels shaded; redrawn per batch and per hold. */
function drawPlot(): void {
  const g = plotCanvas.getContext('2d');
  if (g === null) return;
  const dpr = window.devicePixelRatio;
  const w = Math.max(1, Math.round(plotCanvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(plotCanvas.clientHeight * dpr));
  if (plotCanvas.width !== w) plotCanvas.width = w;
  if (plotCanvas.height !== h) plotCanvas.height = h;
  g.clearRect(0, 0, w, h);
  const ink = plotStyle.color;
  g.strokeStyle = ink;
  g.globalAlpha = 0.4;
  g.lineWidth = dpr;
  g.setLineDash([4 * dpr, 4 * dpr]);
  g.beginPath();
  g.moveTo(0, h / 2); // p = 0.5, and −45 dBFS
  g.lineTo(w, h / 2);
  g.stroke();
  g.setLineDash([]);
  g.globalAlpha = 1;
  const r = rec;
  if (r !== null && r.firstFrame !== null && r.ctxRate > 0) {
    const n10 = r.bandDb.length;
    const n32 = r.sileroP.length;
    // Seconds since firstFrame at the right edge, and px per second.
    const tEnd = Math.max(PLOT_SECONDS, n10 / HOPS_PER_SECOND);
    const t0 = tEnd - PLOT_SECONDS;
    const scale = w / PLOT_SECONDS;
    const f0 = r.firstFrame;
    const rate = r.ctxRate;
    g.fillStyle = COLORS.label;
    for (let k = r.labels.length - 1; k >= 0; k--) {
      const l = r.labels[k];
      if (l === undefined) continue;
      const b = (l.release - f0) / rate;
      if (b < t0) break;
      const a = (l.press - f0) / rate;
      g.fillRect((a - t0) * scale, 0, (b - a) * scale, h);
    }
    if (r.hold !== null) {
      const a = (r.hold.press - f0) / rate;
      g.fillRect((a - t0) * scale, 0, w - (a - t0) * scale, h);
    }
    g.lineWidth = 1.5 * dpr;
    g.strokeStyle = COLORS.bandDb;
    g.beginPath();
    const i0 = Math.max(0, n10 - PLOT_SECONDS * HOPS_PER_SECOND);
    for (let i = i0; i < n10; i++) {
      const db = Math.min(PLOT_DB_MAX, Math.max(PLOT_DB_MIN, r.bandDb.at(i)));
      const x = (i / HOPS_PER_SECOND - t0) * scale;
      const y = h * (1 - (db - PLOT_DB_MIN) / (PLOT_DB_MAX - PLOT_DB_MIN));
      if (i === i0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.strokeStyle = COLORS.sileroP;
    g.beginPath();
    const j0 = Math.max(0, n32 - Math.ceil(PLOT_SECONDS / SILERO_FRAME_SECONDS) - 1);
    for (let j = j0; j < n32; j++) {
      const p = Math.min(1, Math.max(0, r.sileroP.at(j)));
      const x = (j * SILERO_FRAME_SECONDS - t0) * scale;
      const y = h * (1 - p);
      if (j === j0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  g.font = `${12 * dpr}px system-ui, sans-serif`;
  g.textAlign = 'left';
  g.textBaseline = 'top';
  g.fillStyle = COLORS.sileroP;
  g.fillText('Silero p (0 to 1)', 6 * dpr, 4 * dpr);
  g.fillStyle = COLORS.bandDb;
  g.fillText(`band dB (${PLOT_DB_MIN} to ${PLOT_DB_MAX} dBFS)`, 6 * dpr, 20 * dpr);
  g.fillStyle = ink;
  g.fillText('shaded: labels', 6 * dpr, 36 * dpr);
}

/** `m:ss` of a duration in seconds. */
function minutes(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

// ---- export ---------------------------------------------------------------------------------------------------

/** `YYYYMMDDTHHMMSSZ`: an ISO 8601 UTC time in the basic format, which every file system accepts. */
function isoBasic(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Object URLs not yet revoked (pagehide revokes them at once). */
const pendingUrls = new Set<string>();

// ---- The only way out of this page (plan Q2, docs/lab.md) ----------------------------------------------------
// Only two files can ever be saved from this page: trace-….json and trace-….bin, the two outputs of
// encodeTrace() (src/vad-trace/format.ts), built in exportTrace below from the per-frame features (raw and
// band-limited dB, voicing, Silero p) and the hold-to-talk frames. saveFile has no other caller.
// No audio buffer is reachable from this page: it never calls the engine's take(), getClip(), process() or
// getProcessed(), so no clip is ever cut from the capture ring or assembled from clipChunk messages, and every
// Float32Array it holds is a traceBatch feature array. Nothing is stored in the browser either.
function saveFile(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  pendingUrls.add(url);
  el('a', { href: url, download: name }).click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    pendingUrls.delete(url);
  }, REVOKE_MS);
}

const EXPORT_HINT =
  'Export saves 2 files; if Chrome asks to download multiple files, choose Allow, then check that both ' +
  'trace-….json and trace-….bin are in Downloads.';

async function exportTrace(): Promise<void> {
  const r = rec;
  if (r === null || r.phase !== 'stopped' || r.firstFrame === null || r.exporting) return;
  r.exporting = true;
  try {
    const firstFrame = r.firstFrame;
    const n10 = r.rawDb.length;
    const n32 = r.sileroP.length;
    const end = hopStartFrame(frames(r), n10);
    const labels = r.labels.filter((l) => {
      const ok = firstFrame <= l.press && l.press < l.release && l.release <= end;
      if (!ok) log(`label ${l.press}–${l.release} dropped: outside the trace [${firstFrame}, ${end}]`);
      return ok;
    });
    const s = r.setup;
    const notes = notesInput.value.trim();
    const hash = await frontEndHash();
    if (rec !== r || r.phase !== 'stopped') return; // discarded or replaced meanwhile
    const meta: TraceMeta = {
      version: 1,
      device: s.device,
      chrome: s.chrome,
      ctxRate: r.ctxRate,
      constraints: CONSTRAINTS,
      sileroWeightsSha256: WEIGHTS_SHA256,
      frontEndHash: hash,
      session: s.session,
      condition: s.condition,
      placement: s.placement,
      speaker: s.speaker,
      scriptId: s.scriptId,
      startedAt: r.startedAt,
      firstFrame,
      n10,
      n32,
      labels,
      ...(notes === '' ? {} : { notes }),
    };
    const { json, bin } = encodeTrace(meta, {
      rawDb: r.rawDb.view(),
      bandDb: r.bandDb.view(),
      voicing: r.voicing.view(),
      sileroP: r.sileroP.view(),
    });
    const base = `trace-${s.session}-${s.condition}-${s.placement}-${s.speaker}-${isoBasic(r.startedAt)}`;
    const jsonBlob = new Blob([json], { type: 'application/json' });
    const binBlob = new Blob([bin], { type: 'application/octet-stream' });
    saveFile(`${base}.json`, jsonBlob);
    saveFile(`${base}.bin`, binBlob);
    r.exported = true;
    log(
      `exported ${base}.json (${jsonBlob.size} bytes) and ${base}.bin (${binBlob.size} bytes): script ` +
        `${s.scriptId}, n10 ${n10}, n32 ${n32}, ${labels.length} labels, frontEndHash ${hash}`,
    );
    const dropped = r.labels.length - labels.length;
    if (dropped === 0) {
      setStatus(EXPORT_HINT);
    } else {
      const what = `${plural(dropped, 'label', 'labels')} fell outside the trace and ${dropped === 1 ? 'was' : 'were'} dropped`;
      log(`export: ${what}`);
      setStatus(`Exported, but ${what} (see the log); report this.`);
    }
  } catch (err) {
    log(`export failed: ${describe(err)}`);
    setStatus(`Export failed: ${describe(err)}`);
  } finally {
    r.exporting = false;
    refresh();
  }
}

function discard(): void {
  const r = rec;
  if (r === null || isActive(r)) return;
  dropRecording(r);
  log(r.phase === 'stopped' && !r.exported ? 'discarded an unexported trace' : 'discarded');
  setStatus('Discarded. Choose the setup, then press Start.');
  refresh();
}

/** Leaving the page discards everything (plan Q2): the recording, its streams, labels and setup. */
function onPageHide(): void {
  const r = rec;
  if (r !== null) {
    if (isActive(r)) {
      r.phase = 'failed';
      r.error = 'pagehide';
      teardown(r);
    }
    dropRecording(r);
  }
  engine.closeMic();
  for (const url of pendingUrls) URL.revokeObjectURL(url);
  pendingUrls.clear();
  refresh();
}

// ---- UI state ---------------------------------------------------------------------------------------------------

function setStatus(text: string): void {
  statusText.textContent = text;
}

function showValues(): void {
  const r = rec;
  const n10 = r?.rawDb.length ?? 0;
  const n32 = r?.sileroP.length ?? 0;
  elapsedValue.textContent = `${fmt(n10 / HOPS_PER_SECOND, 2)} s`;
  n10Value.textContent = String(n10);
  n32Value.textContent = String(n32);
  labelsValue.textContent = String(r?.labels.length ?? 0);
  inferValue.textContent =
    r === null || n32 === 0 ? '–' : `mean ${fmt(r.inferMsSum / n32, 2)} ms, max ${fmt(r.inferMsMax, 2)} ms`;
  wakeValue.textContent = wakeLock.held() ? 'held' : 'not held';
  if (r === null) {
    scriptValue.textContent = '–';
  } else if (r.setup.scriptId === NOISE_SCRIPT_ID) {
    const left = Math.max(0, NOISE_ONLY_SECONDS - n10 / HOPS_PER_SECOND);
    scriptValue.textContent = `noise only, ${minutes(left)} left`;
  } else {
    scriptValue.textContent = `${r.setup.scriptId}: ${Math.min(r.phrase, PHRASES_PER_SCRIPT)} of ${PHRASES_PER_SCRIPT} phrases done`;
  }
}

/** Enables and disables the controls for the current state. */
function refresh(): void {
  const r = rec;
  const active = r !== null && isActive(r);
  const held = r !== null && r.phase === 'stopped';
  // The setup is locked from Start until the trace is discarded or replaced (the export uses the Start snapshot).
  const locked = active || held;
  for (const c of setupControls) c.disabled = locked;
  startButton.disabled = readSetup() === null || active || (held && !r.exported);
  stopButton.disabled = r === null || (r.phase !== 'starting' && r.phase !== 'capturing');
  exportButton.disabled = !held || r.exporting;
  discardButton.disabled = r === null || active;
  holdButton.disabled = r === null || r.phase !== 'capturing';
  completenessText.textContent = held ? completeness(r) : '';
  showValues();
  drawHold();
  drawPlot();
}

// ---- setup form ---------------------------------------------------------------------------------------------------

/** Preselects the cell's script (plan §7 M2: one script per cell; music and `none` are noise-only). */
function preselectScript(): void {
  const c = pick(conditionSelect, CONDITIONS);
  const p = pick(placementSelect, PLACEMENTS);
  if (c === null || p === null) return;
  const id: ScriptId = c === 'music' || p === 'none' ? NOISE_SCRIPT_ID : CELL_SCRIPTS[c][p];
  if (scriptSelect.value === id) return;
  scriptSelect.value = id;
  log(`script ${id} preselected for ${c} × ${p}`);
  refresh(); // the generic change listener ran before this, with the script still blank
}

/** The `Google Chrome` (else `Chromium`) version in a `fullVersionList`, if any. */
function brandVersion(list: readonly unknown[], brand: string): string | null {
  for (const b of list) {
    if (typeof b !== 'object' || b === null || !('brand' in b) || !('version' in b)) continue;
    if (b.brand === brand && typeof b.version === 'string') return b.version;
  }
  return null;
}

function stringField(o: object, key: string): string {
  if (!(key in o)) return '';
  const v: unknown = Reflect.get(o, key);
  return typeof v === 'string' ? v : '';
}

/**
 * device and chrome (TraceMeta): from navigator.userAgentData's high-entropy values when it exists (not in the
 * DOM lib, so it is narrowed from unknown), else chrome from the UA string's Chrome/ token.
 */
async function detectClient(): Promise<{ device: string; chrome: string }> {
  const nav: object = navigator;
  if (!('userAgentData' in nav)) {
    return { device: '', chrome: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? 'unknown' };
  }
  const d: unknown = nav.userAgentData;
  if (
    typeof d !== 'object' ||
    d === null ||
    !('getHighEntropyValues' in d) ||
    typeof d.getHighEntropyValues !== 'function'
  ) {
    return { device: '', chrome: 'unknown' };
  }
  let values: unknown;
  try {
    values = await d.getHighEntropyValues.call(d, [
      'model',
      'platform',
      'platformVersion',
      'fullVersionList',
    ]);
  } catch (err) {
    log(`userAgentData.getHighEntropyValues failed: ${describe(err)}`);
    return { device: '', chrome: 'unknown' };
  }
  if (typeof values !== 'object' || values === null) return { device: '', chrome: 'unknown' };
  const model = stringField(values, 'model');
  const os = `${stringField(values, 'platform')} ${stringField(values, 'platformVersion')}`.trim();
  const device = model === '' ? os : os === '' ? model : `${model} (${os})`;
  const list: unknown = Reflect.get(values, 'fullVersionList');
  const brands: readonly unknown[] = Array.isArray(list) ? list : [];
  const chrome = brandVersion(brands, 'Google Chrome') ?? brandVersion(brands, 'Chromium') ?? 'unknown';
  return { device, chrome };
}

// ---- wiring -------------------------------------------------------------------------------------------------------

for (const c of setupControls) {
  c.addEventListener('change', refresh);
  c.addEventListener('input', refresh);
}
conditionSelect.addEventListener('change', preselectScript);
placementSelect.addEventListener('change', preselectScript);
startButton.addEventListener('click', () => {
  start().catch((err: unknown) => log(`start: ${describe(err)}`));
});
stopButton.addEventListener('click', stop);
exportButton.addEventListener('click', () => {
  exportTrace().catch((err: unknown) => log(`export: ${describe(err)}`));
});
discardButton.addEventListener('click', discard);

// The hold button: pointer capture keeps the release on it; touch and contextmenu defaults are prevented, so a
// finger that moves a little doesn't pan the page (which would cancel the pointer) and a long press opens no menu
// (the no-CSS equivalent of touch-action: none).
holdButton.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!press({ kind: 'pointer', id: e.pointerId })) return;
  try {
    holdButton.setPointerCapture(e.pointerId);
  } catch {
    // The pointer is already gone; its pointerup or pointercancel still ends the hold.
  }
});
holdButton.addEventListener('pointerup', (e) => release({ kind: 'pointer', id: e.pointerId }));
holdButton.addEventListener('pointercancel', (e) => release({ kind: 'pointer', id: e.pointerId }));
holdButton.addEventListener('contextmenu', (e) => e.preventDefault());
holdButton.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
holdButton.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

// Keys (a Bluetooth page-turner): key repeat is ignored, and the default (scrolling, activating a focused
// button) is prevented while capturing or finishing.
window.addEventListener('keydown', (e) => {
  if (!holdKeyEvent(e)) return;
  e.preventDefault();
  if (!e.repeat) press(keySource(e));
});
window.addEventListener('keyup', (e) => {
  if (!holdKeyEvent(e)) return;
  e.preventDefault();
  release(keySource(e));
});

// A key whose keyup never comes (a page-turner reconnecting, focus moving to the system UI) would leave a stuck
// hold, and its next release would make one bogus long label: a blur drops a key hold.
window.addEventListener('blur', () => {
  const r = rec;
  if (r !== null && r.hold !== null && r.hold.source.kind === 'key') {
    dropHold(r, 'window lost focus');
    refresh();
  }
});

window.addEventListener('resize', () => {
  const r = rec;
  if (r !== null && r.hold !== null) {
    resizePending = true;
    return;
  }
  sizeHold();
  drawPlot();
});

// A trace that isn't exported yet lives only in this page: leaving asks first.
window.addEventListener('beforeunload', (e) => {
  const r = rec;
  if (r !== null && (isActive(r) || (r.phase === 'stopped' && !r.exported))) e.preventDefault();
});
// pagehide dropped everything; a page restored from the back/forward cache starts afresh.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});

function tick(): void {
  const r = rec;
  if (r === null) return;
  const now = performance.now();
  if (r.phase === 'starting' && r.armedAt !== null && now - r.armedAt > SETUP_TIMEOUT_MS) {
    fail(r, `no trace batch within ${SETUP_TIMEOUT_MS} ms of the arm`);
    return;
  }
  if ((r.phase === 'capturing' || r.phase === 'finishing') && now - r.lastBatchAt > STALL_MS) {
    fail(r, `trace stalled: no batch for ${fmt(now - r.lastBatchAt, 0)} ms`);
    return;
  }
  if (r.phase === 'capturing' && r.countdownEnd !== null) {
    if (now >= r.countdownEnd) {
      r.countdownEnd = null;
      r.phrase++;
      showValues();
    }
    drawHold();
  }
}
setInterval(tick, UI_TICK_MS);

detectClient()
  .then(({ device, chrome }) => {
    chromeVersion = chrome;
    chromeValue.textContent = chrome;
    if (deviceInput.value === '') deviceInput.value = device;
    log(`client: device "${device}", chrome ${chrome}`);
  })
  .catch((err: unknown) => log(`client detection failed: ${describe(err)}`))
  .finally(() => {
    clientReady = true;
    refresh();
  });

sizeHold();
refresh();
log(
  `lab/vad-trace ready: VAD backend ${backendValue.textContent}, DEFAULT_VAD_BACKEND ${DEFAULT_VAD_BACKEND}; ` +
    navigator.userAgent,
);
