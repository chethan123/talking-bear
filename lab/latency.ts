// Lab page for X-E5 (plan §5, §4.4 point 3, §3.3): plays clicks through the master bus and finds each one in the
// phone's own mic, via the capture worklet's ring (an engine take). It compares the measured arrival with the
// getOutputTimestamp() prediction of the output latency, which validates the audio side of clipTimeNow, and
// measures the room and speaker echo tail, which sets the cooldown (250 ms by default). Dev-only: `pnpm dev`,
// then /lab/latency.html (docs/lab.md).
// Privacy (plan Q2): each take is analysed at once, then zero-filled and dropped (closeMic drops the engine's
// copy); only numbers are kept and logged. Nothing captured is stored or exported; Copy log copies text only.

import { createEngine, type EngineEvent } from '../src/audio/engine.ts';
import { outputContextTimeNow } from '../src/audio/output-clock.ts';
import { el, fmt, logPanel } from './common.ts';

/** Clicks per run. */
const CLICKS = 20;
/** Context-time spacing of consecutive clicks. */
const INTERVAL_SEC = 1.5;
/** Each click is scheduled this far after ctx.currentTime. */
const LEAD_SEC = 0.3;
/** The take starts this long before the click's scheduled time T... */
const PRE_SEC = 0.1;
/** ...and ends this long after it; it is requested once ctx.currentTime has reached T + POST_SEC. */
const POST_SEC = 0.6;
/** The click: a Hann window of this many samples (1 ms at 48 kHz) with a peak of 1.0 (full scale). */
const CLICK_SAMPLES = 48;
/** The take's first NOISE_SEC is the pre-click noise floor. */
const NOISE_SEC = 0.05;
/** The arrival is the first sample from T on whose |x| exceeds DETECT_FACTOR × the floor's RMS. */
const DETECT_FACTOR = 10;
/** The echo tail is measured in RMS windows of TAIL_WINDOW_SEC from the arrival on... */
const TAIL_WINDOW_SEC = 0.005;
/** ...and ends where the level stays within TAIL_SETTLE_DB of the noise floor for TAIL_HOLD_SEC. */
const TAIL_SETTLE_DB = 3;
const TAIL_HOLD_SEC = 0.05;
/** Plan §4.4 point 3: the cooldown is at least 250 ms. X-E5 recommends max(250, p90(tailMs) + 50) ms. */
const COOLDOWN_MIN_MS = 250;
const COOLDOWN_MARGIN_MS = 50;
/** The residual is stable when its p90 − p10 spread is at most this. */
const STABLE_SPREAD_MS = 5;
/** How long to wait for the context and the mic (the permission prompt). */
const SETUP_TIMEOUT_MS = 30000;
/** How long to wait for `armed`, and for a take's `clipReady` or `takeFailed`. */
const EVENT_TIMEOUT_MS = 2000;
/** How far the context clock may fall behind the wall clock before a run gives up (a stalled context). */
const CLOCK_SLACK_MS = 2000;

// ---- analysis (pure; exported for throwaway checks) ---------------------------------------------------------

/** What one take shows about its click. */
export interface TakeAnalysis {
  /** RMS of the take's first NOISE_SEC: the pre-click noise floor. */
  readonly floorRms: number;
  /** The largest |x| from T to the end of the take. */
  readonly peak: number;
  /** The ctx frame of the arrival, or null: not detected. */
  readonly arrivalFrame: number | null;
  /** Ms from the arrival until the level settles (see TAIL_*), or null: not detected, or not settled in the take. */
  readonly tailMs: number | null;
  /**
   * For a detected click whose tail did not settle in the take: the censoring limit, the largest tail the take
   * could have shown, `max(0, n − arrival − TAIL_HOLD_SEC worth of windows) / sr` in ms (the true tail is longer).
   * Null otherwise.
   */
  readonly tailLimitMs: number | null;
}

/**
 * Finds the click scheduled at context time `t` in `pcm`, the take of ctx frames
 * `[fromFrame, fromFrame + pcm.length)` at `sampleRate`.
 *
 * - The noise floor is the RMS of the take's first NOISE_SEC.
 * - The arrival is the first sample whose |x| exceeds DETECT_FACTOR × that RMS, searched from T's frame on (the
 *   click can't reach the mic before it is played) and never inside the noise window.
 * - The tail is cut into windows of TAIL_WINDOW_SEC from the arrival on. It ends at the first window of the first
 *   run of TAIL_HOLD_SEC worth of consecutive windows whose mean square is at most the floor's mean square
 *   raised by TAIL_SETTLE_DB (quieter windows count as settled); `tailMs` is that window's start, from the
 *   arrival. A run must fit in the take, or the tail is not settled.
 */
export function analyseTake(
  pcm: Float32Array,
  sampleRate: number,
  fromFrame: number,
  t: number,
): TakeAnalysis {
  const n = pcm.length;
  const noiseLen = Math.round(NOISE_SEC * sampleRate);
  if (noiseLen < 1 || n <= noiseLen) {
    return { floorRms: NaN, peak: NaN, arrivalFrame: null, tailMs: null, tailLimitMs: null };
  }
  let sum = 0;
  for (let i = 0; i < noiseLen; i++) sum += pcm[i]! ** 2;
  const floorMs = sum / noiseLen;
  const floorRms = Math.sqrt(floorMs);
  const threshold = DETECT_FACTOR * floorRms;

  const searchFrom = Math.max(noiseLen, Math.ceil(t * sampleRate) - fromFrame);
  let arrival = -1;
  let peak = 0;
  for (let i = searchFrom; i < n; i++) {
    const a = Math.abs(pcm[i]!);
    if (a > peak) peak = a;
    if (arrival < 0 && a > threshold) arrival = i;
  }
  if (arrival < 0) return { floorRms, peak, arrivalFrame: null, tailMs: null, tailLimitMs: null };

  const win = Math.max(1, Math.round(TAIL_WINDOW_SEC * sampleRate));
  const hold = Math.round(TAIL_HOLD_SEC / TAIL_WINDOW_SEC);
  const settleMs = floorMs * 10 ** (TAIL_SETTLE_DB / 10);
  let run = 0;
  for (let k = 0; arrival + (k + 1) * win <= n; k++) {
    const at = arrival + k * win;
    let s = 0;
    for (let i = at; i < at + win; i++) s += pcm[i]! ** 2;
    if (s / win > settleMs) {
      run = 0;
      continue;
    }
    run++;
    if (run === hold) {
      const tailMs = (((k + 1 - hold) * win) / sampleRate) * 1000;
      return { floorRms, peak, arrivalFrame: fromFrame + arrival, tailMs, tailLimitMs: null };
    }
  }
  const tailLimitMs = (Math.max(0, n - arrival - hold * win) / sampleRate) * 1000;
  return { floorRms, peak, arrivalFrame: fromFrame + arrival, tailMs: null, tailLimitMs };
}

/** The p-quantile (0 ≤ p ≤ 1) of non-empty ascending `sorted`, interpolated linearly between order statistics. */
export function quantile(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const a = sorted[lo]!;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)]!;
  return a + (h - lo) * (b - a);
}

export interface Stats {
  readonly n: number;
  readonly median: number;
  readonly p10: number;
  readonly p90: number;
  readonly max: number;
}

/** Median, p10, p90 and max of `values`, or null when there are none. */
export function stats(values: readonly number[]): Stats | null {
  if (values.length === 0) return null;
  const s = values.toSorted((a, b) => a - b);
  return {
    n: s.length,
    median: quantile(s, 0.5),
    p10: quantile(s, 0.1),
    p90: quantile(s, 0.9),
    max: s[s.length - 1]!,
  };
}

/**
 * The tails the cooldown is computed from, one per detected click: a settled tail as measured, an unsettled one
 * at its censoring limit (`tailLimitMs`); `censored` counts the latter. Undetected clicks have neither and are
 * skipped.
 */
export function cooldownTails(clicks: readonly Pick<TakeAnalysis, 'tailMs' | 'tailLimitMs'>[]): {
  tailsMs: number[];
  censored: number;
} {
  const tailsMs: number[] = [];
  let censored = 0;
  for (const c of clicks) {
    if (c.tailMs !== null) {
      tailsMs.push(c.tailMs);
    } else if (c.tailLimitMs !== null) {
      tailsMs.push(c.tailLimitMs);
      censored++;
    }
  }
  return { tailsMs, censored };
}

/** max(250, p90(tailsMs) + 50) ms, rounded up to a whole ms; null without any tail. */
export function recommendedCooldownMs(tailsMs: readonly number[]): number | null {
  const s = stats(tailsMs);
  return s === null ? null : Math.max(COOLDOWN_MIN_MS, Math.ceil(s.p90 + COOLDOWN_MARGIN_MS));
}

/** The click: a symmetric Hann window of CLICK_SAMPLES samples, scaled so its peak is exactly 1.0. */
export function clickSamples(): Float32Array<ArrayBuffer> {
  const w = (i: number): number => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (CLICK_SAMPLES - 1));
  let peak = 0;
  for (let i = 0; i < CLICK_SAMPLES; i++) peak = Math.max(peak, w(i));
  const x = new Float32Array(CLICK_SAMPLES);
  for (let i = 0; i < CLICK_SAMPLES; i++) x[i] = w(i) / peak;
  return x;
}

// ---- page ---------------------------------------------------------------------------------------------------

const root = document.getElementById('lab');
if (!(root instanceof HTMLElement)) throw new Error('lab/latency: missing #lab');

const startButton = el('button', { type: 'button' }, `Start (${CLICKS} clicks)`);
const stopButton = el('button', { type: 'button' }, 'Stop');
stopButton.disabled = true;
const status = el('p', { 'aria-live': 'polite' }, 'Idle.');

const CLICK_COLUMNS = [
  'Click',
  'arrivalLagMs',
  'predictedOutMs',
  'residualMs',
  'tailMs',
  'outputLatency (ms)',
  'baseLatency (ms)',
] as const;
const clickRows = el('tbody');
const SUMMARY_COLUMNS = ['', 'n', 'median', 'p10', 'p90', 'max'] as const;
const summaryRows = el('tbody');
const spreadValue = el('dd', {}, '–');
const cooldownValue = el('dd', {}, '–');

function table(columns: readonly string[], body: HTMLTableSectionElement): HTMLTableElement {
  return el('table', {}, el('thead', {}, el('tr', {}, ...columns.map((c) => el('th', {}, c)))), body);
}

root.append(
  el('fieldset', {}, el('legend', {}, 'X-E5: loopback clicks'), startButton, stopButton, status),
  el('h2', {}, 'Clicks'),
  table(CLICK_COLUMNS, clickRows),
  el('h2', {}, 'Summary (ms)'),
  table(SUMMARY_COLUMNS, summaryRows),
  el(
    'dl',
    { class: 'lab-values' },
    el('dt', {}, 'Residual spread (p90 − p10)'),
    spreadValue,
    el('dt', {}, 'Recommended cooldown'),
    cooldownValue,
  ),
);
const log = logPanel(root);
log(`userAgent: ${navigator.userAgent}`);

// ---- engine -------------------------------------------------------------------------------------------------

/** A pending waitEvent: resolved with the first matching event, or null on timeout or Stop. */
interface Waiter {
  readonly match: (e: EngineEvent) => boolean;
  readonly resolve: (e: EngineEvent | null) => void;
}

const waiters = new Set<Waiter>();

/** Events too frequent, or irrelevant here, to log. */
const QUIET_EVENTS: ReadonlySet<EngineEvent['t']> = new Set(['level', 'seg', 'floorSnapshot', 'vadStats']);

const engine = createEngine({
  connectWorkletOutput: false,
  onEvent(e: EngineEvent): void {
    if (!QUIET_EVENTS.has(e.t)) log(`engine: ${JSON.stringify(e)}`);
    for (const w of waiters) if (w.match(e)) w.resolve(e);
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

// ---- run ----------------------------------------------------------------------------------------------------

/** One run of CLICKS clicks; `stopped` is set by Stop and pagehide. */
interface Run {
  stopped: boolean;
}

/** One click's numbers. The values are null when missing; `note` then says why. */
interface ClickResult {
  readonly index: number;
  /** The click's scheduled context time, in s. */
  readonly t: number;
  readonly predictedOutMs: number;
  readonly outputLatencyMs: number;
  readonly baseLatencyMs: number;
  /** The raw getOutputTimestamp() the prediction used (log only). */
  readonly tsContextTime: number | undefined;
  readonly tsPerformanceTime: number | undefined;
  /** No output timestamp yet: the prediction fell back to `currentTime − outputLatency`. */
  readonly fallback: boolean;
  readonly arrivalLagMs: number | null;
  readonly residualMs: number | null;
  readonly tailMs: number | null;
  /** The censoring limit of a detected tail that did not settle (TakeAnalysis.tailLimitMs). */
  readonly tailLimitMs: number | null;
  /** 'not detected', or why the take has no analysis; null when detected. */
  readonly note: string | null;
  readonly floorDb: number;
  readonly peakDb: number;
}

/** openMic request ids and arm epochs: a new pair per run, so an earlier run's late events never match. */
let nextReq = 1;
let nextEpoch = 1;
let current: Run | null = null;
/**
 * The take requested and not yet handed to the analysis, so Stop and pagehide can zero its clip if it already
 * arrived (plan Q2); clickOnce clears it once it holds the clip itself.
 */
let pendingTake: { readonly epoch: number; readonly id: number } | null = null;

/** Zero-fills the pending take's clip if the engine holds it; closeMic() then drops it. */
function discardPendingTake(): void {
  const p = pendingTake;
  pendingTake = null;
  if (p !== null) engine.getClip(p.epoch, p.id)?.fill(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function db(x: number): number {
  return 20 * Math.log10(x);
}

function checkStopped(r: Run): void {
  if (r.stopped) throw new Error('stopped');
}

/** Resolves once ctx.currentTime ≥ t. Throws on Stop, and when the context clock stalls. */
async function untilCtxTime(ctx: AudioContext, t: number, r: Run): Promise<void> {
  const deadline = performance.now() + (t - ctx.currentTime) * 1000 + CLOCK_SLACK_MS;
  while (ctx.currentTime < t) {
    checkStopped(r);
    if (performance.now() > deadline) {
      throw new Error(
        `context clock stalled (state ${ctx.state}, currentTime ${fmt(ctx.currentTime, 3)} s, waiting for ${fmt(t, 3)} s)`,
      );
    }
    await sleep(Math.min(50, Math.max(1, (t - ctx.currentTime) * 1000)));
  }
  checkStopped(r);
}

/** Resumes the context and opens the mic; returns the running context. */
async function startEngine(r: Run): Promise<AudioContext> {
  const running = waitEvent((e) => e.t === 'ctxRunning' || e.t === 'ctxResumeFailed', SETUP_TIMEOUT_MS);
  engine.resume().catch((err: unknown) => log(`resume failed: ${String(err)}`));
  const c = await running;
  checkStopped(r);
  const ctx = engine.context();
  if (c?.t !== 'ctxRunning' || ctx === null) throw new Error(`no running context (${c?.t ?? 'no answer'})`);
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
  checkStopped(r);
  if (m?.t !== 'micGranted') throw new Error(`no mic (${m?.t ?? 'no answer'})`);
  return ctx;
}

/** Arms `epoch` and waits for its `armed`. */
async function armEngine(epoch: number, r: Run): Promise<void> {
  const armed = waitEvent((e) => e.t === 'armed' && e.epoch === epoch, EVENT_TIMEOUT_MS);
  engine.arm(epoch);
  const a = await armed;
  checkStopped(r);
  if (a === null) throw new Error(`no armed event within ${EVENT_TIMEOUT_MS} ms`);
}

/** Plays click `index` at T = currentTime + LEAD_SEC, takes [T − PRE_SEC, T + POST_SEC] and analyses it. */
async function clickOnce(
  ctx: AudioContext,
  bus: AudioNode,
  click: AudioBuffer,
  epoch: number,
  index: number,
  r: Run,
): Promise<ClickResult> {
  const src = new AudioBufferSourceNode(ctx, { buffer: click });
  src.connect(bus);
  src.addEventListener('ended', () => src.disconnect());
  // One snapshot of the clock for T, the prediction and the log: outputContextTimeNow sees exactly the
  // currentTime, outputLatency and output timestamp that are logged.
  const now = ctx.currentTime;
  const outputLatency = ctx.outputLatency;
  const ts = ctx.getOutputTimestamp();
  const t = now + LEAD_SEC;
  const outNow = outputContextTimeNow({ currentTime: now, outputLatency, getOutputTimestamp: () => ts });
  const predictedOutMs = (now - outNow) * 1000;
  const base = {
    index,
    t,
    predictedOutMs,
    outputLatencyMs: outputLatency * 1000,
    baseLatencyMs: ctx.baseLatency * 1000,
    tsContextTime: ts.contextTime,
    tsPerformanceTime: ts.performanceTime,
    fallback: !ts.performanceTime || ts.contextTime === undefined, // outputContextTimeNow's fallback test
  };
  src.start(t);

  const sr = ctx.sampleRate;
  const fromFrame = Math.round((t - PRE_SEC) * sr);
  const toFrame = Math.round((t + POST_SEC) * sr);
  await untilCtxTime(ctx, t + POST_SEC, r);
  const done = waitEvent(
    (e) => (e.t === 'clipReady' || e.t === 'takeFailed') && e.epoch === epoch && e.id === index,
    EVENT_TIMEOUT_MS,
  );
  pendingTake = { epoch, id: index };
  engine.take(epoch, index, fromFrame, toFrame);
  const e = await done;
  checkStopped(r); // stopped: start() zero-fills the pending take's clip
  pendingTake = null; // from here on this function zero-fills any clip it gets

  const missing = {
    arrivalLagMs: null,
    residualMs: null,
    tailMs: null,
    tailLimitMs: null,
    floorDb: NaN,
    peakDb: NaN,
  };
  if (e === null) return { ...base, ...missing, note: `no clip within ${EVENT_TIMEOUT_MS} ms` };
  if (e.t !== 'clipReady') return { ...base, ...missing, note: 'take failed' };
  const pcm = engine.getClip(epoch, index);
  if (pcm === undefined) return { ...base, ...missing, note: 'no clip' };
  const want = toFrame - fromFrame;
  if (pcm.length !== want) {
    pcm.fill(0); // plan Q2: discarded unanalysed
    return { ...base, ...missing, note: `wrong length (${pcm.length} of ${want})` };
  }
  let a: TakeAnalysis;
  try {
    a = analyseTake(pcm, sr, fromFrame, t); // the same fromFrame the take was cut from
  } finally {
    pcm.fill(0); // plan Q2: the take is discarded once analysed, even if the analysis throws
  }
  const levels = { floorDb: db(a.floorRms), peakDb: db(a.peak) };
  if (a.arrivalFrame === null) {
    return { ...base, ...missing, ...levels, note: 'not detected' };
  }
  const arrivalLagMs = (a.arrivalFrame / sr - t) * 1000;
  return {
    ...base,
    ...levels,
    arrivalLagMs,
    residualMs: arrivalLagMs - predictedOutMs,
    tailMs: a.tailMs,
    tailLimitMs: a.tailLimitMs,
    note: null,
  };
}

function msOr(v: number | null, missing: string): string {
  return v === null ? missing : fmt(v, 1);
}

/** The tail cell: the tail, `not settled (> limit)` for a censored one, or the click's note. */
function tailText(c: ClickResult): string {
  if (c.tailMs !== null) return fmt(c.tailMs, 1);
  if (c.tailLimitMs !== null) return `not settled (> ${fmt(c.tailLimitMs, 1)})`;
  return c.note ?? 'not settled';
}

function showClick(c: ClickResult): void {
  const missing = c.note ?? '';
  const tail = tailText(c);
  const cells = [
    `${c.index}/${CLICKS}`,
    msOr(c.arrivalLagMs, missing),
    fmt(c.predictedOutMs, 1),
    msOr(c.residualMs, missing),
    tail,
    fmt(c.outputLatencyMs, 1),
    fmt(c.baseLatencyMs, 1),
  ];
  clickRows.append(el('tr', {}, ...cells.map((v) => el('td', {}, v))));
  const tsContext = c.tsContextTime === undefined ? 'missing' : `${fmt(c.tsContextTime, 6)} s`;
  const tsPerformance = c.tsPerformanceTime === undefined ? 'missing' : `${fmt(c.tsPerformanceTime, 3)} ms`;
  log(
    `click ${c.index}/${CLICKS} at T ${fmt(c.t, 3)} s: arrivalLagMs ${msOr(c.arrivalLagMs, missing)}, ` +
      `predictedOutMs ${fmt(c.predictedOutMs, 1)}, residualMs ${msOr(c.residualMs, missing)}, tailMs ${tail}, ` +
      `outputLatency ${fmt(c.outputLatencyMs, 1)} ms, baseLatency ${fmt(c.baseLatencyMs, 1)} ms, ` +
      `getOutputTimestamp contextTime ${tsContext}, performanceTime ${tsPerformance}` +
      `${c.fallback ? ' (fallback: no output timestamp yet)' : ''}, ` +
      `floor ${fmt(c.floorDb, 1)} dBFS, peak ${fmt(c.peakDb, 1)} dBFS`,
  );
}

function showSummary(results: readonly ClickResult[]): void {
  const values = (pick: (c: ClickResult) => number | null): number[] =>
    results.flatMap((c) => {
      const v = pick(c);
      return v === null ? [] : [v];
    });
  const lags = values((c) => c.arrivalLagMs);
  const residuals = values((c) => c.residualMs);
  const tails = values((c) => c.tailMs);
  const { tailsMs, censored } = cooldownTails(results);
  log(
    `summary: ${lags.length} of ${results.length} clicks detected, ${tails.length} tails settled, ` +
      `${censored} censored`,
  );
  for (const [name, v] of [
    ['arrivalLagMs', lags],
    ['residualMs', residuals],
    ['tailMs', tails],
  ] as const) {
    const s = stats(v);
    const cells =
      s === null
        ? ['0', '–', '–', '–', '–']
        : [String(s.n), ...[s.median, s.p10, s.p90, s.max].map((x) => fmt(x, 1))];
    summaryRows.append(el('tr', {}, el('th', {}, name), ...cells.map((x) => el('td', {}, x))));
    log(
      `summary ${name}: n ${cells[0]}, median ${cells[1]}, p10 ${cells[2]}, p90 ${cells[3]}, max ${cells[4]}`,
    );
  }

  const r = stats(residuals);
  spreadValue.textContent =
    r === null
      ? 'n/a (no click detected)'
      : `${fmt(r.p90 - r.p10, 1)} ms over ${r.n} clicks: ` +
        (r.p90 - r.p10 <= STABLE_SPREAD_MS
          ? `stable (≤ ${STABLE_SPREAD_MS} ms)`
          : `not stable (> ${STABLE_SPREAD_MS} ms)`);
  const cooldown = recommendedCooldownMs(tailsMs);
  cooldownValue.textContent =
    cooldown === null
      ? `n/a (no click detected; the plan's default is ${COOLDOWN_MIN_MS} ms)`
      : `${cooldown} ms = max(${COOLDOWN_MIN_MS}, p90 + ${COOLDOWN_MARGIN_MS}) over the ${tailsMs.length} ` +
        `detected clicks' tails: ` +
        (censored === 0
          ? 'all settled'
          : `${tailsMs.length - censored} settled, ${censored} unsettled counted at their censoring limit ` +
            `(the largest tail the take could show), so this is a lower bound (${censored} tails censored)`);
  log(`residual spread (p90 − p10): ${spreadValue.textContent}`);
  log(`recommended cooldown: ${cooldownValue.textContent}`);
}

async function runClicks(r: Run, results: ClickResult[]): Promise<void> {
  const ctx = await startEngine(r);
  const bus = engine.masterBus();
  if (bus === null) throw new Error('no master bus');
  const click = new AudioBuffer({ length: CLICK_SAMPLES, numberOfChannels: 1, sampleRate: ctx.sampleRate });
  click.copyToChannel(clickSamples(), 0);
  const epoch = nextEpoch++;
  try {
    await armEngine(epoch, r);
    for (let i = 1; i <= CLICKS; i++) {
      status.textContent = `Click ${i} of ${CLICKS}…`;
      const c = await clickOnce(ctx, bus, click, epoch, i, r);
      results.push(c);
      showClick(c);
      if (i < CLICKS) await untilCtxTime(ctx, c.t + INTERVAL_SEC - LEAD_SEC, r);
    }
  } finally {
    engine.disarm(epoch);
  }
}

async function start(): Promise<void> {
  if (current !== null) return;
  const r: Run = { stopped: false };
  current = r;
  startButton.disabled = true;
  stopButton.disabled = false;
  clickRows.replaceChildren();
  summaryRows.replaceChildren();
  spreadValue.textContent = '–';
  cooldownValue.textContent = '–';
  status.textContent = 'Starting…';
  log(`run: ${CLICKS} clicks, ${INTERVAL_SEC} s apart`);
  const results: ClickResult[] = [];
  try {
    await runClicks(r, results);
    status.textContent = `Done: ${CLICKS} clicks.`;
    log('run complete');
  } catch (err) {
    const why = r.stopped ? 'stopped' : `failed: ${String(err)}`;
    status.textContent = `Run ${why} after ${results.length} clicks.`;
    log(`run ${why} after ${results.length} clicks`);
  } finally {
    discardPendingTake();
    engine.closeMic(); // stops the tracks and drops the engine's last clip
    showSummary(results);
    await engine.suspend();
    current = null;
    startButton.disabled = false;
    stopButton.disabled = true;
  }
}

/** Stops the run in progress at its next step; pending waits resolve at once. */
function stop(why: string): void {
  const r = current;
  if (r === null || r.stopped) return;
  r.stopped = true;
  log(`stop: ${why}`);
  for (const w of waiters) w.resolve(null);
}

startButton.addEventListener('click', () => {
  start().catch((err: unknown) => log(`start: ${String(err)}`));
});
stopButton.addEventListener('click', () => stop('Stop pressed'));
window.addEventListener('pagehide', () => {
  stop('pagehide');
  discardPendingTake();
  engine.closeMic(); // at once: no captured audio outlives the visible page
});
