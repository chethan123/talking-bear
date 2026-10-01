// Lab page for X-R4 (plan §5, §3.2, §4.10 battery lever 2): with the capture worklet's zero output connected
// to `destination` (graph B), Chrome's silent-sink suspender can release the output device while the app only
// listens; but suspended rendering runs on a thread-pool task and the mic source's FIFO drops audio on overrun.
// The page counts capture gaps on a continuous tone from a second device (graph A vs B, optionally under load)
// and measures what resuming the output costs. Dev-only: `pnpm dev`, then /lab/continuity.html (docs/lab.md).
// Privacy (plan Q2): the clip the page receives is zero-filled at once; a take still being assembled when it is
// superseded (after a timeout) or when the mic closes is dropped, and the engine's chunk copies of a take over
// 48 000 frames are dropped unzeroed (memory only; nothing is stored). Only counts are kept. The graph choice
// lives in the URL query only; nothing is stored or exported, and Copy log copies text only.

import { createEngine, type EngineEvent } from '../src/audio/engine.ts';
import { el, fmt, logPanel } from './common.ts';

// ---- analysis (pure; exported for throwaway checks) ---------------------------------------------------------

/** A discontinuity is a step |x[n] − x[n−1]| larger than this many times the steepest step of the block's tone. */
export const DISCONTINUITY_FACTOR = 3;
/** The X-R4 gate (plan §5): enable graph B only if there are 0 gaps longer than this... */
export const GATE_MS = 20;
/** ...over 10 minutes with the sink suspended... */
export const GATE_MIN_SEC = 600;
/**
 * ...which takes this long of silent output first (Chrome's silent-sink suspender releases the output after 30 s
 * of exact zeros): no PASS from less than GATE_MIN_SEC + IDLE_SEC of analysed audio.
 */
export const IDLE_SEC = 40;
/** Capture buffer lengths (s) whose whole-buffer drop the tone must be able to show (plan §3.2: FIFO overrun). */
export const DROP_SECONDS = [0.005, 0.01, 0.02] as const;
/**
 * A drop of a buffer holding within this many cycles of a whole number of the tone's periods barely moves the
 * tone's phase: it is detected at under 50 % of cut phases (measured at 48 and 44.1 kHz).
 */
export const BLIND_CYCLES = 0.075;
/** Each block ends this many frames before the context's current frame, so the ring already holds all of it. */
export const MARGIN_FRAMES = 1024;
/**
 * The analysis starts this long after the first captured sample that is not an exact zero: the mic source's
 * first buffers can jump (one buffer after the audio starts, in 3 of 10 headless runs, in both graphs).
 */
export const SETTLE_SEC = 1;

/** A: the worklet's output is unconnected (the default). B: `connectWorkletOutput: true`. */
export type Graph = 'A' | 'B';

/** The graph named by a URL query string: `graph=B` is graph B; anything else, or nothing, is graph A. */
export function parseGraph(search: string): Graph {
  return new URLSearchParams(search).get('graph') === 'B' ? 'B' : 'A';
}

/** The shortest flagged zero run: 1 ms, rounded up to whole frames. */
export function minZeroRunFrames(sampleRate: number): number {
  return Math.ceil(sampleRate / 1000);
}

/** Whether a run of `frames` frames lasts longer than GATE_MS. */
export function longerThanGate(frames: number, sampleRate: number): boolean {
  return frames * 1000 > GATE_MS * sampleRate;
}

/**
 * The index of the first sample of `x` that is not an exact zero, or −1 if there is none: where the captured
 * audio starts (the mic source delivers exact zeros for its first few tens of ms: 15–43 ms in headless Chrome).
 */
export function firstNonZero(x: Float32Array): number {
  for (let i = 0; i < x.length; i++) if (x[i] !== 0) return i;
  return -1;
}

/**
 * The buffer lengths in DROP_SECONDS whose whole-buffer drop a steady tone at `freqHz` hides: those holding
 * within BLIND_CYCLES of a whole number of its periods (every one of them for 1000 Hz; none for 911 Hz).
 */
export function blindDrops(freqHz: number): number[] {
  return DROP_SECONDS.filter((sec) => {
    const cycles = freqHz * sec;
    return Math.abs(cycles - Math.round(cycles)) < BLIND_CYCLES;
  });
}

/**
 * The ctx frame where the analysis starts within the take [from, to), given the frame where the captured audio
 * started: SETTLE_SEC later, or `from` if that is already past (a take was lost meanwhile); null if it lies at or
 * after `to` (the whole take is still settling).
 */
export function analysisStart(
  audioFrame: number,
  from: number,
  to: number,
  sampleRate: number,
): number | null {
  const at = Math.max(from, audioFrame + Math.round(SETTLE_SEC * sampleRate));
  return at < to ? at : null;
}

/** A block's tone estimate. */
export interface Tone {
  /** RMS · √2: the amplitude of a sine with the block's RMS. */
  readonly amplitude: number;
  /** Sign changes (x < 0 vs x ≥ 0) between neighbouring samples, halved, per second of the block. */
  readonly freqHz: number;
}

/** The tone estimate of `x`: amplitude RMS·√2, frequency from zero crossings. Fewer than 2 samples: 0 Hz. */
export function estimateTone(x: Float32Array, sampleRate: number): Tone {
  const n = x.length;
  if (n === 0) return { amplitude: 0, freqHz: 0 };
  let sum = 0;
  let crossings = 0;
  let negative = x[0]! < 0;
  for (let i = 0; i < n; i++) {
    const v = x[i]!;
    sum += v * v;
    const neg = v < 0;
    if (neg !== negative) crossings++;
    negative = neg;
  }
  const amplitude = Math.sqrt(sum / n) * Math.SQRT2;
  const freqHz = n < 2 ? 0 : (crossings * sampleRate) / (2 * (n - 1));
  return { amplitude, freqHz };
}

/** DISCONTINUITY_FACTOR × A·2πf/sr: the largest step between samples of a sine of the tone, with margin. */
export function discontinuityThreshold(tone: Tone, sampleRate: number): number {
  return (DISCONTINUITY_FACTOR * tone.amplitude * 2 * Math.PI * tone.freqHz) / sampleRate;
}

/**
 * The next block's ctx frames [from, to): from `nextFrom` (where the previous block ended) to
 * round(currentTime · sampleRate) − MARGIN_FRAMES; null while that is not past `nextFrom`. The caller's next
 * `nextFrom` is `to`, so consecutive blocks neither overlap nor leave a frame out.
 */
export function nextBlock(
  nextFrom: number,
  currentTime: number,
  sampleRate: number,
): { from: number; to: number } | null {
  const to = Math.round(currentTime * sampleRate) - MARGIN_FRAMES;
  return to > nextFrom ? { from: nextFrom, to } : null;
}

/** What the analysis carries from one block into the next contiguous one. */
export interface Carry {
  /** The last sample analysed, or null: no contiguous predecessor (start, or after a lost block). */
  last: number | null;
  /** Exact zeros at the end of what was analysed so far: a zero run that may go on in the next block. */
  zeroRun: number;
}

export function newCarry(): Carry {
  return { last: null, zeroRun: 0 };
}

/** One block's findings. */
export interface BlockResult {
  readonly tone: Tone;
  readonly threshold: number;
  /** Samples n where |x[n] − x[n−1]| > threshold; n = 0 compares with the carried last sample. */
  readonly discontinuities: number;
  /** The index in `x` of the first discontinuity, or −1 if there is none. */
  readonly firstDiscontinuity: number;
  /**
   * The lengths, in frames, of the flagged zero runs (≥ 1 ms of exact zeros) that ended in this block. A run
   * that began in an earlier block counts here with its whole length; one still open at the end is carried.
   */
  readonly zeroRuns: readonly number[];
}

/**
 * Analyses `x`, the frames right after those `carry` ended with, and updates `carry`. The tone (A, f), and with
 * it the threshold, is `x`'s own unless given: the parts of one block split at a minute boundary share the
 * block's tone (analyseByMinute).
 */
export function analyseBlock(
  x: Float32Array,
  sampleRate: number,
  carry: Carry,
  tone: Tone = estimateTone(x, sampleRate),
): BlockResult {
  const threshold = discontinuityThreshold(tone, sampleRate);
  const minRun = minZeroRunFrames(sampleRate);
  const zeroRuns: number[] = [];
  let discontinuities = 0;
  let firstDiscontinuity = -1;
  let prev = carry.last;
  let run = carry.zeroRun;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    if (prev !== null && Math.abs(v - prev) > threshold) {
      if (discontinuities === 0) firstDiscontinuity = i;
      discontinuities++;
    }
    if (v === 0) {
      run++;
    } else {
      if (run >= minRun) zeroRuns.push(run);
      run = 0;
    }
    prev = v;
  }
  carry.last = prev;
  carry.zeroRun = run;
  return { tone, threshold, discontinuities, firstDiscontinuity, zeroRuns };
}

/**
 * Ends the contiguous stream (a lost block, or Stop): returns the open zero run's length if it is flagged
 * (≥ 1 ms), otherwise null, and resets `carry`.
 */
export function closeStream(carry: Carry, sampleRate: number): number | null {
  const run = carry.zeroRun;
  carry.last = null;
  carry.zeroRun = 0;
  return run >= minZeroRunFrames(sampleRate) ? run : null;
}

/** Counts over a minute, or over the whole run. */
export interface Tally {
  blocks: number;
  /** Frames analysed. */
  frames: number;
  discontinuities: number;
  zeroRuns: number;
  /** The longest flagged zero run, in frames (0: none). */
  longestZeroRun: number;
  /** Flagged zero runs longer than GATE_MS. */
  longZeroRuns: number;
  /** Takes that failed or timed out: their frames could not be analysed. */
  failedTakes: number;
  /** Resume-latency clicks played: the mic hears them as discontinuities. */
  clicks: number;
}

export function newTally(): Tally {
  return {
    blocks: 0,
    frames: 0,
    discontinuities: 0,
    zeroRuns: 0,
    longestZeroRun: 0,
    longZeroRuns: 0,
    failedTakes: 0,
    clicks: 0,
  };
}

export function addZeroRun(t: Tally, frames: number, sampleRate: number): void {
  t.zeroRuns++;
  if (frames > t.longestZeroRun) t.longestZeroRun = frames;
  if (longerThanGate(frames, sampleRate)) t.longZeroRuns++;
}

/** Adds the frames and findings of a block, or of the part of one that falls in this tally's minute. */
export function addPart(t: Tally, frames: number, r: BlockResult, sampleRate: number): void {
  t.frames += frames;
  t.discontinuities += r.discontinuities;
  for (const run of r.zeroRuns) addZeroRun(t, run, sampleRate);
}

/** addPart, and counts one more block. */
export function addBlock(t: Tally, frames: number, r: BlockResult, sampleRate: number): void {
  t.blocks++;
  addPart(t, frames, r, sampleRate);
}

/** The 0-based minute of the run that ctx frame `frame` falls in. */
export function minuteIndex(frame: number, startFrame: number, sampleRate: number): number {
  return Math.max(0, Math.floor((frame - startFrame) / (60 * sampleRate)));
}

/**
 * The first frames of minutes (startFrame + ceil(k·60·sr), k ≥ 1, as minuteIndex counts them) strictly inside
 * the block (from, to), ascending: where the block is cut so that each part counts in its own minute.
 */
export function minuteCuts(from: number, to: number, startFrame: number, sampleRate: number): number[] {
  const cuts: number[] = [];
  for (let k = minuteIndex(from, startFrame, sampleRate) + 1; ; k++) {
    const at = startFrame + Math.ceil(k * 60 * sampleRate);
    if (at >= to) return cuts;
    cuts.push(at); // > from: k starts at the minute after from's
  }
}

/** One part of a block: the frames of the block that fall in one minute. */
export interface Part {
  /** The ctx frame of the part's first sample. */
  readonly from: number;
  readonly minute: number;
  readonly frames: number;
  readonly result: BlockResult;
}

/**
 * Analyses the block `x` = ctx frames [from, from + x.length) as consecutive parts split at minuteCuts, each
 * with analyseBlock on the same carry and with the whole block's tone. So the counts summed over the parts are
 * exactly those of one analyseBlock over the block (a discontinuity at a cut counts in the later part, a zero run
 * in the part where it ends), and each part lands in its own minute.
 */
export function analyseByMinute(
  x: Float32Array,
  from: number,
  startFrame: number,
  sampleRate: number,
  carry: Carry,
): Part[] {
  const to = from + x.length;
  const tone = estimateTone(x, sampleRate);
  const parts: Part[] = [];
  let at = from;
  for (const end of [...minuteCuts(from, to, startFrame, sampleRate), to]) {
    const result = analyseBlock(x.subarray(at - from, end - from), sampleRate, carry, tone);
    parts.push({ from: at, minute: minuteIndex(at, startFrame, sampleRate), frames: end - at, result });
    at = end;
  }
  return parts;
}

export type Verdict = 'pending' | 'pass' | 'fail';

/**
 * The X-R4 gate over the whole run: 0 gaps longer than 20 ms in 10 minutes with the sink suspended. A steady tone
 * can't show how much audio a discontinuity lost (and the ring holds 80 Hz high-passed audio, so a short input
 * dropout leaves no exact zeros), so every discontinuity counts as a gap of unknown length and fails it, as do a
 * zero run longer than 20 ms (the open one included) and a failed take (unanalysed frames). Without any of these
 * it stays pending until GATE_MIN_SEC + IDLE_SEC (the first IDLE_SEC let the sink suspend) have been analysed.
 */
export function gateVerdict(total: Tally, openZeroRun: number, sampleRate: number): Verdict {
  if (
    total.discontinuities > 0 ||
    total.longZeroRuns > 0 ||
    total.failedTakes > 0 ||
    longerThanGate(openZeroRun, sampleRate)
  ) {
    return 'fail';
  }
  return total.frames < (GATE_MIN_SEC + IDLE_SEC) * sampleRate ? 'pending' : 'pass';
}

// ---- constants ----------------------------------------------------------------------------------------------

/** Every BLOCK_MS the newest audio is taken from the capture ring and analysed. */
const BLOCK_MS = 1000;
/** The page never arms: its takes carry epoch 0. */
const EPOCH = 0;
/** A take with no clipReady or takeFailed after this long counts as failed. */
const TAKE_TIMEOUT_MS = 5000;
/** How long to wait for the context and the mic (the permission prompt). */
const SETUP_TIMEOUT_MS = 30000;
/** The click: a Hann window of CLICK_SAMPLES samples peaking at CLICK_PEAK, through the master bus. */
const CLICK_SAMPLES = 48;
const CLICK_PEAK = 0.5;
/** A click whose output timestamp has not passed its start after this long is reported as timed out. */
const CLICK_TIMEOUT_MS = 5000;
/** Load generator: 60 fps, 60 filled paths and a 6 ms busy loop per frame, 20 pointer pairs per second. */
const LOAD_FPS = 60;
const LOAD_PATHS = 60;
const LOAD_BUSY_MS = 6;
const LOAD_POINTER_PAIRS_PER_SEC = 20;
const LOAD_COLORS = ['#d0443e', '#2f7ed8', '#3a9d5d', '#c58b1b', '#8e5cc4'] as const;
const QUIET_EVENTS: ReadonlySet<EngineEvent['t']> = new Set([
  'level',
  'seg',
  'floorSnapshot',
  'vadStats',
  'clipReady',
  'takeFailed',
]);

// ---- page ---------------------------------------------------------------------------------------------------

const graph = parseGraph(location.search);

const root = document.getElementById('lab');
if (!(root instanceof HTMLElement)) throw new Error('lab/continuity: missing #lab');

const graphA = el('input', { type: 'radio', name: 'graph', value: 'A' });
const graphB = el('input', { type: 'radio', name: 'graph', value: 'B' });
graphA.checked = graph === 'A';
graphB.checked = graph === 'B';
const startButton = el('button', { type: 'button' }, 'Start');
const stopButton = el('button', { type: 'button' }, 'Stop');
stopButton.disabled = true;
const clickButton = el('button', { type: 'button' }, 'Play click after idle');
clickButton.disabled = true;
const loadBox = el('input', { type: 'checkbox' });
const canvas = el('canvas', { width: '360', height: '180' });
/** The target of the synthetic pointer events. */
const dummy = el('div', { 'aria-hidden': 'true' });
const status = el('p', { 'aria-live': 'polite' }, 'Idle.');
const show = {
  graph: el('dd', {}, graph === 'B' ? 'B: worklet output → destination' : 'A: worklet output unconnected'),
  state: el('dd', {}, '–'),
  elapsed: el('dd', {}, '–'),
  tone: el('dd', {}, '–'),
  gate: el('dd', {}, '–'),
  idle: el('dd', {}, '–'),
  resume: el('dd', {}, '–'),
  load: el('dd', {}, 'off'),
};
const MINUTE_COLUMNS = [
  'Minute',
  'Blocks',
  'Discontinuities',
  'Zero runs',
  'Longest zero run (ms)',
  'Failed takes',
  'Clicks',
] as const;
const minuteRows = el('tbody');

function row(term: string, value: HTMLElement): HTMLElement[] {
  return [el('dt', {}, term), value];
}

root.append(
  el(
    'fieldset',
    {},
    el('legend', {}, 'Graph (changing it reloads the page)'),
    el('label', {}, graphA, ' A: worklet output unconnected (default)'),
    el('br'),
    el('label', {}, graphB, ' B: worklet zero output → destination (connectWorkletOutput)'),
  ),
  el('fieldset', {}, el('legend', {}, 'X-R4: capture gaps'), startButton, stopButton, status),
  el(
    'fieldset',
    {},
    el('legend', {}, 'Load generator'),
    el(
      'label',
      {},
      loadBox,
      ` ${LOAD_FPS} fps canvas with ${LOAD_PATHS} filled paths, a ${LOAD_BUSY_MS} ms busy loop per frame, ` +
        `${LOAD_POINTER_PAIRS_PER_SEC} pointerdown/pointerup pairs per second`,
    ),
    el('br'),
    canvas,
    dummy,
  ),
  el(
    'fieldset',
    {},
    el('legend', {}, 'Resume latency'),
    clickButton,
    el(
      'p',
      {},
      `Use it after the gap measurement. It unlocks after ${IDLE_SEC} s without output (Since last output, ` +
        'below), so the sink can have suspended; the mic hears the clicks, so the gate freezes at the first ' +
        'click test.',
    ),
  ),
  el(
    'dl',
    { class: 'lab-values' },
    ...row('Graph', show.graph),
    ...row('ctx.state', show.state),
    ...row('Elapsed', show.elapsed),
    ...row('Tone (last block)', show.tone),
    ...row(
      'Gate (plan §5: 0 gaps > 20 ms; every discontinuity counts as a gap of unknown length)',
      show.gate,
    ),
    ...row('Since last output', show.idle),
    ...row('Resume latency', show.resume),
    ...row('Load', show.load),
  ),
  el('h2', {}, 'Per minute'),
  el('table', {}, el('thead', {}, el('tr', {}, ...MINUTE_COLUMNS.map((c) => el('th', {}, c)))), minuteRows),
);
const log = logPanel(root);
log(`lab/continuity ready: graph ${graph}; ${navigator.userAgent}`);
if (!window.isSecureContext) {
  log('not a secure context: the mic needs https or http://localhost (docs/lab.md: adb reverse)');
}

// ---- engine -------------------------------------------------------------------------------------------------

/** A pending waitEvent: resolved with the first matching event, or null on timeout or Stop. */
interface Waiter {
  readonly match: (e: EngineEvent) => boolean;
  readonly resolve: (e: EngineEvent | null) => void;
}

const waiters = new Set<Waiter>();

const engine = createEngine({
  connectWorkletOutput: graph === 'B',
  onEvent(e: EngineEvent): void {
    if (!QUIET_EVENTS.has(e.t)) log(`engine: ${JSON.stringify(e)}`);
    for (const w of waiters) if (w.match(e)) w.resolve(e);
    switch (e.t) {
      case 'clipReady':
        onClip(e.epoch, e.id);
        break;
      case 'takeFailed':
        onTakeFailed(e.epoch, e.id);
        break;
      case 'trackEnded':
        stop('mic track ended');
        break;
      default:
        break;
    }
  },
});

/** The next engine event that `match`es, or null after `timeoutMs` or on Stop. Register before the call that emits it. */
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

// ---- session ------------------------------------------------------------------------------------------------

/** A take requested and not yet answered: ctx frames [from, to). */
interface Pending {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  /** performance.now() when it was requested. */
  readonly at: number;
}

interface Session {
  readonly ctx: AudioContext;
  readonly sampleRate: number;
  /** The ctx frame of the first captured sample that is not an exact zero; null until a take has shown one. */
  audioFrame: number | null;
  /** The ctx frame the analysis starts at (analysisStart), and the minutes count from; null until then. */
  startFrame: number | null;
  /** performance.now() when the analysis started (Elapsed), or null. */
  startWall: number | null;
  readonly timer: number;
  /** The first frame of the next take. */
  nextFrom: number;
  pending: Pending | null;
  readonly carry: Carry;
  readonly minutes: Tally[];
  /** Minutes already summarised in the log. */
  logged: number;
  readonly total: Tally;
  lastTone: Tone | null;
  /** performance.now() of the page's last output (the end of the last click test), or of Start. */
  lastOutputWall: number;
  readonly click: AudioBuffer;
  clicking: boolean;
  /** Click sources not ended yet: Stop and pagehide stop them, so none plays when the context next resumes. */
  readonly sources: Set<AudioBufferSourceNode>;
  /**
   * The gate's inputs when the first click test started, or null. The mic hears the clicks as discontinuities,
   * so from then on the gate shows this snapshot instead of the running counts (the table keeps counting).
   */
  frozen: Frozen | null;
}

interface Frozen {
  readonly total: Tally;
  readonly openZeroRun: number;
  /** The 1-based minute the first click test started in. */
  readonly minute: number;
}

let session: Session | null = null;
/** Bumped by every Start, Stop and pagehide: a Start that finds it changed after an await was superseded. */
let generation = 0;
let nextReq = 1;
/** Take ids grow across sessions, so a late answer for an earlier session never matches. */
let nextTakeId = 1;

function say(text: string): void {
  status.textContent = text;
}

function ms(frames: number, sampleRate: number): string {
  return fmt((frames * 1000) / sampleRate, 1);
}

/**
 * The tally of the minute that ctx frame `frame` falls in (minute 1 before the analysis has started); the rows
 * up to it are created as needed.
 */
function minuteTally(s: Session, frame: number): Tally {
  const m = s.startFrame === null ? 0 : minuteIndex(frame, s.startFrame, s.sampleRate);
  while (s.minutes.length <= m) s.minutes.push(newTally());
  return s.minutes[m]!;
}

/**
 * Logs the minutes before `minute` not logged yet. Called with the minute of each analysed block: takes are
 * answered in order, so every block of an earlier minute is in by then.
 */
function logMinutesBefore(s: Session, minute: number): void {
  for (; s.logged < minute && s.logged < s.minutes.length; s.logged++) {
    log(`minute ${s.logged + 1}: ${tallyText(s.minutes[s.logged]!, s.sampleRate)}`);
  }
}

function tallyText(t: Tally, sampleRate: number): string {
  return (
    `${t.blocks} blocks (${fmt(t.frames / sampleRate, 1)} s), ${t.discontinuities} discontinuities, ` +
    `${t.zeroRuns} zero runs (longest ${ms(t.longestZeroRun, sampleRate)} ms, ${t.longZeroRuns} > ${GATE_MS} ms), ` +
    `${t.failedTakes} failed takes, ${t.clicks} clicks`
  );
}

/** `sec` as "M min S s" (whole seconds, rounded down). */
function minSec(sec: number): string {
  const whole = Math.floor(sec);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

/** The gate's verdict and counts: the running ones, or the snapshot taken at the first click test. */
function gateText(s: Session): string {
  const f = s.frozen;
  const t = f === null ? s.total : f.total;
  const open = f === null ? s.carry.zeroRun : f.openZeroRun;
  const v = gateVerdict(t, open, s.sampleRate);
  const analysed = `${minSec(t.frames / s.sampleRate)} of ${minSec(GATE_MIN_SEC + IDLE_SEC)} analysed`;
  const note = f === null ? '' : `; frozen at the first click test, minute ${f.minute}`;
  if (v === 'pending') {
    return `no verdict yet: no gap so far, ${analysed} (the first ${IDLE_SEC} s let the sink suspend)${note}`;
  }
  if (v === 'pass') {
    return `PASS: 0 discontinuities, 0 zero runs > ${GATE_MS} ms, 0 failed takes; ${analysed}${note}`;
  }
  const longRuns = t.longZeroRuns + (longerThanGate(open, s.sampleRate) ? 1 : 0);
  return (
    `FAIL: ${t.discontinuities} discontinuities (gap length unknown), ${longRuns} zero runs > ${GATE_MS} ms, ` +
    `${t.failedTakes} failed takes; ${analysed}${note}`
  );
}

/** Ends the contiguous stream at `frame`: a flagged open zero run is counted in that frame's minute. */
function breakStream(s: Session, frame: number): void {
  const run = closeStream(s.carry, s.sampleRate);
  if (run === null) return;
  addZeroRun(minuteTally(s, frame), run, s.sampleRate);
  addZeroRun(s.total, run, s.sampleRate);
}

/**
 * A take whose frames could not be analysed: counted, and the stream restarts after it. Before the analysis has
 * started there is nothing to lose yet: only logged.
 */
function lose(s: Session, p: Pending, why: string): void {
  const frames = `${fmt((p.to - p.from) / s.sampleRate, 2)} s`;
  if (s.startFrame === null) {
    log(`take ${p.id} [${p.from}, ${p.to}) ${why} before the analysis started (${frames})`);
    return;
  }
  breakStream(s, p.from);
  minuteTally(s, p.from).failedTakes++;
  s.total.failedTakes++;
  log(`take ${p.id} [${p.from}, ${p.to}) ${why}: ${frames} not analysed`);
}

/** Every BLOCK_MS: requests the frames since the last take, up to MARGIN_FRAMES before the current frame. */
function tick(s: Session): void {
  const p = s.pending;
  if (p !== null) {
    if (performance.now() - p.at < TAKE_TIMEOUT_MS) return; // still answering: the next take covers more
    s.pending = null;
    lose(s, p, `timed out after ${TAKE_TIMEOUT_MS} ms`);
  }
  const b = nextBlock(s.nextFrom, s.ctx.currentTime, s.sampleRate);
  if (b === null) return; // the context clock has not moved on
  const take: Pending = { id: nextTakeId++, from: b.from, to: b.to, at: performance.now() };
  s.pending = take; // before take(): it can emit takeFailed synchronously
  s.nextFrom = b.to;
  engine.take(EPOCH, take.id, take.from, take.to);
}

function onClip(epoch: number, id: number): void {
  const pcm = engine.getClip(epoch, id);
  const s = session;
  const p = s?.pending ?? null;
  if (s === null || p === null || epoch !== EPOCH || p.id !== id) {
    pcm?.fill(0); // not the take in flight: discard it
    return;
  }
  s.pending = null;
  if (pcm === undefined || pcm.length !== p.to - p.from) {
    pcm?.fill(0);
    lose(s, p, `answered with ${pcm === undefined ? 'no clip' : `${pcm.length} frames`}`);
    return;
  }
  let from = p.from;
  let parts: Part[] | null = null;
  try {
    let x = pcm;
    if (s.startFrame === null) {
      if (s.audioFrame === null) {
        const k = firstNonZero(pcm);
        if (k >= 0) {
          s.audioFrame = p.from + k;
          log(`audio from ctx frame ${s.audioFrame}; the analysis starts ${SETTLE_SEC} s later`);
        }
      }
      const at = s.audioFrame === null ? null : analysisStart(s.audioFrame, p.from, p.to, s.sampleRate);
      if (at !== null) {
        from = at;
        x = pcm.subarray(at - p.from);
        s.startFrame = at;
        s.startWall = performance.now();
        log(`analysis starts at ctx frame ${at}`);
      }
    }
    if (s.startFrame !== null) parts = analyseByMinute(x, from, s.startFrame, s.sampleRate, s.carry);
  } finally {
    pcm.fill(0); // plan Q2: the audio is discarded as soon as it is analysed
  }
  if (parts === null || s.startFrame === null) {
    const why = s.audioFrame === null ? 'exact zeros only, waiting for the mic' : 'settling';
    log(`take ${p.id} [${p.from}, ${p.to}): ${why}`);
    render();
    return;
  }
  // Each part counts in its own minute (a block split at a minute boundary counts as a block in both); the total
  // counts the block once. The parts' counts sum to the whole block's.
  let discontinuities = 0;
  let firstAt = -1;
  const runs: string[] = [];
  parts.forEach((part, i) => {
    const r = part.result;
    addBlock(minuteTally(s, part.from), part.frames, r, s.sampleRate);
    if (i === 0) addBlock(s.total, part.frames, r, s.sampleRate);
    else addPart(s.total, part.frames, r, s.sampleRate);
    if (firstAt < 0 && r.firstDiscontinuity >= 0) firstAt = part.from + r.firstDiscontinuity;
    discontinuities += r.discontinuities;
    for (const f of r.zeroRuns) runs.push(`${ms(f, s.sampleRate)} ms`);
  });
  const last = parts[parts.length - 1]!;
  logMinutesBefore(s, last.minute);
  s.lastTone = last.result.tone;
  if (discontinuities > 0 || runs.length > 0) {
    const threshold = last.result.threshold.toPrecision(3);
    const first = firstAt < 0 ? '' : `, the first at ctx frame ${firstAt}`;
    const cuts = parts
      .slice(1)
      .map((q) => q.from)
      .join(', ');
    const split = cuts === '' ? '' : ` (split at ${cuts})`;
    log(
      `block [${from}, ${p.to})${split}: ${discontinuities} discontinuities (threshold ${threshold})` +
        first +
        (runs.length === 0 ? '' : `, zero runs ${runs.join(', ')}`),
    );
  }
  render();
}

function onTakeFailed(epoch: number, id: number): void {
  const s = session;
  const p = s?.pending ?? null;
  if (s === null || p === null || epoch !== EPOCH || p.id !== id) return;
  s.pending = null;
  lose(s, p, 'failed');
  render();
}

/** The click: a symmetric Hann window of CLICK_SAMPLES samples peaking at CLICK_PEAK. */
function clickBuffer(ctx: AudioContext): AudioBuffer {
  const b = new AudioBuffer({ length: CLICK_SAMPLES, sampleRate: ctx.sampleRate, numberOfChannels: 1 });
  const x = new Float32Array(CLICK_SAMPLES);
  for (let i = 0; i < CLICK_SAMPLES; i++) {
    x[i] = CLICK_PEAK * Math.sin((Math.PI * i) / (CLICK_SAMPLES - 1)) ** 2;
  }
  b.copyToChannel(x, 0);
  return b;
}

async function start(): Promise<void> {
  if (session !== null) return;
  const gen = ++generation;
  startButton.disabled = true;
  stopButton.disabled = false;
  show.resume.textContent = '–'; // a new session has no resume measurement yet
  say('Starting: context, then the mic.');
  const running = waitEvent((e) => e.t === 'ctxRunning' || e.t === 'ctxResumeFailed', SETUP_TIMEOUT_MS);
  engine.resume().catch((err: unknown) => log(`resume failed: ${String(err)}`));
  const c = await running;
  if (gen !== generation) return;
  const ctx = engine.context();
  if (c?.t !== 'ctxRunning' || ctx === null) throw new Error(`no running context (${c?.t ?? 'no answer'})`);
  ctx.addEventListener('statechange', onStateChange);
  log(
    `context: sampleRate ${ctx.sampleRate} Hz, baseLatency ${fmt(ctx.baseLatency * 1000, 1)} ms, ` +
      `outputLatency ${fmt(ctx.outputLatency * 1000, 1)} ms`,
  );
  const req = nextReq++;
  const answer = waitEvent(
    (e) => (e.t === 'micGranted' || e.t === 'micDenied' || e.t === 'noDevice') && e.req === req,
    SETUP_TIMEOUT_MS,
  );
  engine.openMic(req);
  const m = await answer;
  if (gen !== generation) return;
  if (m?.t !== 'micGranted') throw new Error(`no mic (${m?.t ?? 'no answer'})`);

  const sampleRate = ctx.sampleRate;
  const firstFrame = Math.round(ctx.currentTime * sampleRate);
  const now = performance.now();
  const s: Session = {
    ctx,
    sampleRate,
    audioFrame: null,
    startFrame: null,
    startWall: null,
    timer: window.setInterval(() => tick(s), BLOCK_MS),
    nextFrom: firstFrame,
    pending: null,
    carry: newCarry(),
    minutes: [],
    logged: 0,
    total: newTally(),
    lastTone: null,
    lastOutputWall: now,
    click: clickBuffer(ctx),
    clicking: false,
    sources: new Set(),
    frozen: null,
  };
  session = s;
  log(`start: graph ${graph}, takes from ctx frame ${firstFrame}`);
  say('Running: play the continuous tone near the phone.');
  render();
}

/**
 * Ends the session: stops the click sources, closes the mic and suspends the context. Privacy (plan Q2): the clip
 * the page receives is zero-filled at once; a take still being assembled when it is superseded (after a timeout)
 * or when the mic closes is dropped, and the engine's chunk copies of a take over 48 000 frames are dropped
 * unzeroed (memory only; nothing is stored).
 */
function stop(reason: string): void {
  generation++;
  for (const w of waiters) w.resolve(null);
  const s = session;
  session = null;
  if (s !== null) {
    clearInterval(s.timer);
    s.pending = null;
    for (const src of s.sources) cancelSource(src);
    s.sources.clear();
    breakStream(s, s.nextFrom);
    logMinutesBefore(s, s.minutes.length - 1);
    const last = s.minutes.length - 1;
    if (last >= s.logged) log(`minute ${last + 1} (partial): ${tallyText(s.minutes[last]!, s.sampleRate)}`);
    log(`${reason}: total ${tallyText(s.total, s.sampleRate)}`);
    log(`${reason}: gate ${gateText(s)}`);
    renderSession(s);
  }
  engine.closeMic();
  engine.suspend().catch((err: unknown) => log(`suspend failed: ${String(err)}`));
  startButton.disabled = false;
  stopButton.disabled = true;
  clickButton.disabled = true;
  say(`Stopped (${reason}).`);
}

// ---- resume latency -----------------------------------------------------------------------------------------

/** Stops and disconnects a click source that may still be scheduled or playing. */
function cancelSource(src: AudioBufferSourceNode): void {
  try {
    src.stop();
  } catch {
    // Already stopped.
  }
  src.disconnect();
}

function sleep(msec: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, msec));
}

/** One click's resume latency, in ms. */
interface ClickLatency {
  /** The issue's measure: wall time from start() until getOutputTimestamp().contextTime is first seen past t0. */
  readonly polledMs: number;
  /**
   * The wall time at which t0 reached the output, from that same timestamp, without the polling error:
   * performanceTime − (contextTime − t0)·1000 − the wall time of start(); null without a performanceTime.
   */
  readonly timestampMs: number | null;
}

/**
 * Plays the click at ctx.currentTime through the master bus and measures when getOutputTimestamp().contextTime
 * first passes that start time; null on timeout or Stop.
 */
async function measureClick(s: Session, label: string): Promise<ClickLatency | null> {
  const bus = engine.masterBus();
  if (bus === null) throw new Error('no master bus');
  const ctx = s.ctx;
  const src = new AudioBufferSourceNode(ctx, { buffer: s.click });
  src.connect(bus);
  s.sources.add(src);
  src.addEventListener('ended', () => {
    s.sources.delete(src);
    src.disconnect();
  });
  const t0 = ctx.currentTime;
  src.start(t0);
  const w0 = performance.now();
  minuteTally(s, Math.round(t0 * s.sampleRate)).clicks++;
  s.total.clicks++;
  for (;;) {
    const ts = ctx.getOutputTimestamp();
    const wall = performance.now();
    if (ts.contextTime !== undefined && ts.contextTime > t0) {
      const polledMs = wall - w0;
      const timestampMs =
        ts.performanceTime === undefined ? null : ts.performanceTime - (ts.contextTime - t0) * 1000 - w0;
      log(
        `${label}: start ${fmt(t0, 4)} s, output passed it after ${fmt(polledMs, 1)} ms ` +
          `(from the timestamp: ${latencyText(timestampMs)}; contextTime ${fmt(ts.contextTime, 4)} s, ` +
          `performanceTime ${fmt(ts.performanceTime ?? NaN, 1)} ms, ` +
          `outputLatency ${fmt(ctx.outputLatency * 1000, 1)} ms)`,
      );
      return { polledMs, timestampMs };
    }
    if (session !== s) return null;
    if (wall - w0 > CLICK_TIMEOUT_MS) {
      log(`${label}: output timestamp did not pass ${fmt(t0, 4)} s within ${CLICK_TIMEOUT_MS} ms`);
      return null;
    }
    await sleep(1);
  }
}

function latencyText(v: number | null): string {
  return v === null ? 'n/a' : `${fmt(v, 1)} ms`;
}

function clickText(c: ClickLatency | null): string {
  return c === null ? 'timed out' : `${fmt(c.polledMs, 1)} ms (timestamp ${latencyText(c.timestampMs)})`;
}

/**
 * Seconds until the click test may run: it needs IDLE_SEC without output (since Start or the last click test),
 * so the sink can have suspended in graph B and the gate is never frozen on an early measurement.
 */
function clickWaitSec(s: Session, now: number): number {
  return Math.max(0, IDLE_SEC - (now - s.lastOutputWall) / 1000);
}

async function clickTest(s: Session): Promise<void> {
  if (s.clicking) return;
  const wait = clickWaitSec(s, performance.now());
  if (wait > 0) {
    log(`click test: ${fmt(wait, 1)} s of the ${IDLE_SEC} s without output still to go`);
    return;
  }
  s.clicking = true;
  clickButton.disabled = true;
  const idle = (performance.now() - s.lastOutputWall) / 1000;
  log(`click test: ${fmt(idle, 1)} s since the last output, graph ${graph}, ctx.state ${s.ctx.state}`);
  if (s.frozen === null) {
    const frame = Math.round(s.ctx.currentTime * s.sampleRate);
    const minute = s.startFrame === null ? 1 : minuteIndex(frame, s.startFrame, s.sampleRate) + 1;
    s.frozen = { total: { ...s.total }, openZeroRun: s.carry.zeroRun, minute };
    log(`gate frozen at the first click test, minute ${minute}: ${gateText(s)}`);
  }
  try {
    const first = await measureClick(s, 'first click');
    const second = session === s ? await measureClick(s, 'second click') : null;
    if (session !== s) {
      show.resume.textContent = 'click test interrupted by Stop';
      log('click test: interrupted by Stop');
      return;
    }
    show.resume.textContent =
      `first ${clickText(first)}, second ${clickText(second)} ` +
      `(after ${fmt(idle, 1)} s idle, graph ${graph})`;
    log(`click test: first ${clickText(first)}, second ${clickText(second)}`);
  } finally {
    s.lastOutputWall = performance.now();
    s.clicking = false;
    clickButton.disabled = true; // locked again for IDLE_SEC; render() unlocks it
    render();
  }
}

// ---- load generator -----------------------------------------------------------------------------------------

interface Load {
  raf: number;
  readonly pointerTimer: number;
  /** performance.now() the next frame is due at. */
  due: number;
  frames: number;
  pairs: number;
  /** pointerdown events the dummy element received. */
  received: number;
  /** Counts at the last readout, and when it was. */
  readonly last: { frames: number; pairs: number; at: number };
}

let load: Load | null = null;
const FRAME_MS = 1000 / LOAD_FPS;

/** Burns `msec` of main-thread time; returns the spin count so the loop isn't empty. */
function busy(msec: number): number {
  const end = performance.now() + msec;
  let spins = 0;
  while (performance.now() < end) spins++;
  return spins;
}

function drawLoad(g: CanvasRenderingContext2D, now: number): void {
  const w = canvas.width;
  const h = canvas.height;
  g.clearRect(0, 0, w, h);
  const t = now / 1000;
  for (let i = 0; i < LOAD_PATHS; i++) {
    const x = w / 2 + Math.cos(t * (0.5 + (i % 5) * 0.3) + i) * (w / 2 - 12);
    const y = h / 2 + Math.sin(t * (0.7 + (i % 3) * 0.4) + 2 * i) * (h / 2 - 12);
    g.beginPath();
    g.moveTo(x, y - 10);
    g.lineTo(x + 9, y + 6);
    g.lineTo(x - 9, y + 6);
    g.closePath();
    g.fillStyle = LOAD_COLORS[i % LOAD_COLORS.length]!;
    g.fill();
  }
}

function startLoad(): void {
  if (load !== null) return;
  const g = canvas.getContext('2d');
  if (g === null) {
    log('load: no 2D canvas context');
    loadBox.checked = false;
    return;
  }
  const now = performance.now();
  const l: Load = {
    raf: 0,
    pointerTimer: window.setInterval(() => {
      dummy.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true }));
      dummy.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true }));
      l.pairs++;
    }, 1000 / LOAD_POINTER_PAIRS_PER_SEC),
    due: now,
    frames: 0,
    pairs: 0,
    received: 0,
    last: { frames: 0, pairs: 0, at: now },
  };
  const frame = (t: number): void => {
    if (load !== l) return;
    if (t >= l.due - 1) {
      // At most LOAD_FPS on faster displays; a late frame restarts the schedule instead of bursting.
      l.due = t - l.due > FRAME_MS ? t + FRAME_MS : l.due + FRAME_MS;
      drawLoad(g, t);
      busy(LOAD_BUSY_MS);
      l.frames++;
    }
    l.raf = requestAnimationFrame(frame);
  };
  l.raf = requestAnimationFrame(frame);
  load = l;
  log('load: on');
}

function stopLoad(): void {
  const l = load;
  if (l === null) return;
  load = null;
  cancelAnimationFrame(l.raf);
  clearInterval(l.pointerTimer);
  log(`load: off (${l.frames} frames, ${l.pairs} pointer pairs, ${l.received} pointerdown received)`);
}

dummy.addEventListener('pointerdown', () => {
  if (load !== null) load.received++;
});

// ---- display ------------------------------------------------------------------------------------------------

function onStateChange(): void {
  const ctx = engine.context();
  log(`ctx.state: ${ctx?.state ?? 'none'}`);
  render();
}

/** The tone readout, with a warning when whole capture-buffer drops would leave no step in this tone. */
function toneText(tone: Tone): string {
  const blind = blindDrops(tone.freqHz).map((sec) => sec * 1000);
  const warn =
    blind.length === 0 ? '' : ` — whole-buffer drops invisible (${blind.join(', ')} ms): use about 911 Hz`;
  return `${fmt(tone.freqHz, 0)} Hz, ${fmt(20 * Math.log10(tone.amplitude), 1)} dBFS peak (from RMS)${warn}`;
}

function renderSession(s: Session): void {
  const rows: HTMLElement[] = s.minutes.map((t, i) =>
    el(
      'tr',
      {},
      el('td', {}, String(i + 1)),
      el('td', {}, String(t.blocks)),
      el('td', {}, String(t.discontinuities)),
      el('td', {}, String(t.zeroRuns)),
      el('td', {}, ms(t.longestZeroRun, s.sampleRate)),
      el('td', {}, String(t.failedTakes)),
      el('td', {}, String(t.clicks)),
    ),
  );
  const t = s.total;
  rows.push(
    el(
      'tr',
      {},
      el('th', {}, 'Total'),
      el('th', {}, String(t.blocks)),
      el('th', {}, String(t.discontinuities)),
      el('th', {}, String(t.zeroRuns)),
      el('th', {}, ms(t.longestZeroRun, s.sampleRate)),
      el('th', {}, String(t.failedTakes)),
      el('th', {}, String(t.clicks)),
    ),
  );
  minuteRows.replaceChildren(...rows);
  show.gate.textContent = gateText(s);
  const tone = s.lastTone;
  show.tone.textContent = tone === null ? '–' : toneText(tone);
}

function render(): void {
  const ctx = engine.context();
  show.state.textContent = ctx?.state ?? 'no context yet';
  const s = session;
  if (s !== null) {
    const now = performance.now();
    show.elapsed.textContent =
      s.startWall === null
        ? s.audioFrame === null
          ? 'waiting for the mic'
          : 'settling'
        : `${fmt((now - s.startWall) / 60000, 2)} min`;
    const wait = clickWaitSec(s, now);
    show.idle.textContent = s.clicking
      ? 'click test running'
      : `${fmt((now - s.lastOutputWall) / 1000, 0)} s` +
        (wait > 0 ? `: Play click after idle unlocks in ${Math.ceil(wait)} s` : '');
    clickButton.disabled = s.clicking || wait > 0;
    renderSession(s);
  }
  const l = load;
  if (l !== null) {
    const now = performance.now();
    const sec = (now - l.last.at) / 1000;
    if (sec >= 1) {
      show.load.textContent =
        `on: ${fmt((l.frames - l.last.frames) / sec, 1)} fps, ` +
        `${fmt((l.pairs - l.last.pairs) / sec, 1)} pointer pairs/s`;
      l.last.frames = l.frames;
      l.last.pairs = l.pairs;
      l.last.at = now;
    }
  } else {
    show.load.textContent = 'off';
  }
}

// ---- wiring -------------------------------------------------------------------------------------------------

function onGraphChange(value: Graph): void {
  if (value === graph) return;
  const url = new URL(location.href);
  url.searchParams.set('graph', value);
  log(`graph ${value}: reloading`);
  location.assign(url.href); // pagehide stops the session
}

graphA.addEventListener('change', () => onGraphChange('A'));
graphB.addEventListener('change', () => onGraphChange('B'));
startButton.addEventListener('click', () => {
  start().catch((err: unknown) => {
    log(`start: ${String(err)}`);
    stop('start failed');
  });
});
stopButton.addEventListener('click', () => stop('stop'));
clickButton.addEventListener('click', () => {
  const s = session;
  if (s === null) return;
  clickTest(s).catch((err: unknown) => log(`click test: ${String(err)}`));
});
loadBox.addEventListener('change', () => {
  if (loadBox.checked) startLoad();
  else stopLoad();
});
window.addEventListener('pagehide', () => {
  stopLoad();
  stop('pagehide');
});
document.addEventListener('visibilitychange', () => log(`visibility: ${document.visibilityState}`));
window.setInterval(render, 1000);
render();
