// The developer overlay, `?debug=1` (plan §7 M2, §7 M4 exit criteria, §4.7; issues #56, #81, #98). Its parts:
//
// - the frame-loop line (#81): the main-thread time per drawn frame (p95 over the last 120 drawn frames) and the
//   current fps, read from the bear's frame loop four times a second;
// - the performance line (#122, plan §4.10): the last `first-frame` and `tap-to-listening` measures (src/perf.ts),
//   copied from two cached numbers and formatted with the frame line, four times a second;
// - the storage line (#98, plan §4.7 "Offline guarantees"): `navigator.storage.persisted()` and `estimate()`,
//   read every 5 s;
// - the device lines (#93, for the owner checks of #95, #123 and #120): the haptics log's latest `vibrate` line,
//   the audio context's `state` (rewritten on every `statechange`), the mic track's mute / unmute / ended events
//   with their times, and the audio-input labels of `enumerateDevices()` (refreshed on `devicechange`);
// - the VAD section (#56, plan §7 M2 "probability trace, floor and per-frame timings"): a canvas plot of the last
//   10 s (Silero p with its two thresholds, band dB and floor dB, the energy-gate bar, segment markers) and four
//   lines (state and epoch, backend and vadReady, Silero inference p95 and max, the context's rate and output
//   latency). While mounted it turns the worker's feature trace on (`setTrace`). It reads `traceBatch`, `level`,
//   `vadStats` and `vadReady` from `session.subscribeLevel`, and `seg` events and `restartWorker` effects from
//   `session.addTransitionListener`.
//
// The bar ("egate") is the energy gate's open state (`EnergyGateState.active`, plan §4.2.1), the fallback VAD's
// hysteresis against the noise floor. It is not the §4.2.3 Silero pre-gate (+3 dB), which is off in the MVP and
// whose skipping the trace suspends. The trace carries no gate stream, so the bar replays `energyGateStep` over
// the trace's per-hop band dB, re-synced to every floor the worker posts (`createVadPlot`).
//
// CSP `style-src 'self'` (plan §4.8.3): the DOM is built with createElement/textContent only and nothing sets a
// `style` attribute; the look is in styles.css (`.debug-overlay`, `.debug-plot`). The text allocates a string
// per refresh, never per animation frame. The plot redraws at most 15 times a second from preallocated rings and
// allocates nothing per drawn frame or per ingested event (debug-overlay.browser.test.ts probes both).

import type { Clock } from '../app/clock.ts';
import type { StateName } from '../app/events.ts';
import type { LevelEvent, Session } from '../app/session.ts';
import type { FrameStats } from '../anim/loop.ts';
import { MAX_DPR } from '../anim/renderer.ts';
import { ENERGY_HOP, VAD_FRAME, VAD_RATE } from '../audio/constants.ts';
import type { TraceHost } from '../audio/engine.ts';
import {
  DEFAULT_ENERGY_PARAMS,
  energyGateStep,
  initialEnergyGateState,
  type FrameFeatures,
} from '../dsp/energy-gate.ts';
import { SILERO_SEG_PARAMS, type SegEvent } from '../dsp/segmenter.ts';
import type { StorageApi, StorageUsage } from '../platform/storage.ts';
import { readPerfMeasures, type PerfMeasures } from '../perf.ts';

/** How often the text is refreshed, in ms. */
export const DEBUG_REFRESH_MS = 250;
/** How often the storage line is refreshed, in ms: it changes slowly and each read is an async browser call. */
export const DEBUG_STORAGE_REFRESH_MS = 5000;

export interface DebugOverlayDeps {
  /** The frame loop's stats (`BearView.frameStats`). */
  frameStats(out: FrameStats): FrameStats;
  clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
  /** Storage persistence and usage (#98); without it there is no storage line. */
  storage?: Pick<StorageApi, 'persisted' | 'estimate'>;
  /** The device lines (#93); without it there are none. */
  device?: DebugDeviceDeps;
  /** The VAD section (#56): the plot and the VAD lines; without it there are none. */
  vad?: DebugVadDeps;
}

export interface DebugOverlay {
  /** Refreshes the text now. */
  refresh(): void;
  /** Stops refreshing and removes the overlay. */
  dispose(): void;
}

/** "frame p95 1.8 ms · 60 fps"; dashes before there are numbers. */
export function formatFrameStats(s: FrameStats): string {
  const p95 = Number.isFinite(s.p95Ms) ? `${s.p95Ms.toFixed(1)} ms` : '– ms';
  const fps = Number.isFinite(s.fps) ? `${Math.round(s.fps)} fps` : '– fps';
  return `frame p95 ${p95} · ${fps}`;
}

/** "first frame 312 ms · tap→listening 208 ms" (plan §4.10, #122); dashes until a measure exists. */
export function formatPerfMeasures(m: PerfMeasures): string {
  const first = Number.isFinite(m.firstFrameMs) ? `${Math.round(m.firstFrameMs)} ms` : '– ms';
  const tap = Number.isFinite(m.tapToListeningMs) ? `${Math.round(m.tapToListeningMs)} ms` : '– ms';
  return `first frame ${first} · tap→listening ${tap}`;
}

/** "storage persisted yes · 870 / 1953125 KB" (usage / quota); "?" and dashes where the API is missing. */
export function formatStorage(persisted: boolean | null, usage: StorageUsage | null): string {
  const p = persisted === null ? '?' : persisted ? 'yes' : 'no';
  const kb =
    usage === null ? '– / – KB' : `${Math.round(usage.usage / 1024)} / ${Math.round(usage.quota / 1024)} KB`;
  return `storage persisted ${p} · ${kb}`;
}

export function mountDebugOverlay(root: HTMLElement, deps: DebugOverlayDeps): DebugOverlay {
  const box = document.createElement('div');
  box.className = 'debug-overlay';
  const frames = document.createElement('p');
  frames.className = 'debug-line';
  const perfLine = document.createElement('p');
  perfLine.className = 'debug-line';
  perfLine.dataset.line = 'perf';
  box.append(frames, perfLine);
  root.append(box);

  const stats: FrameStats = { p95Ms: Number.NaN, fps: Number.NaN, frames: 0 };
  const measures: PerfMeasures = { firstFrameMs: Number.NaN, tapToListeningMs: Number.NaN };
  let timer = 0;
  let live = true;

  function refresh(): void {
    frames.textContent = formatFrameStats(deps.frameStats(stats));
    perfLine.textContent = formatPerfMeasures(readPerfMeasures(measures));
  }

  function schedule(): void {
    timer = deps.clock.setTimeout(() => {
      if (!live) return;
      refresh();
      schedule();
    }, DEBUG_REFRESH_MS);
  }

  refresh();
  schedule();

  // ---- storage line (#98) ----
  let storageTimer: number | null = null;
  const { storage } = deps;
  if (storage !== undefined) {
    const storageLine = document.createElement('p');
    storageLine.className = 'debug-line';
    storageLine.textContent = formatStorage(null, null);
    box.append(storageLine);
    const refreshStorage = async (): Promise<void> => {
      const [persisted, usage] = await Promise.all([storage.persisted(), storage.estimate()]);
      if (live) storageLine.textContent = formatStorage(persisted, usage);
    };
    const scheduleStorage = (): void => {
      storageTimer = deps.clock.setTimeout(() => {
        if (!live) return;
        void refreshStorage();
        scheduleStorage();
      }, DEBUG_STORAGE_REFRESH_MS);
    };
    void refreshStorage();
    scheduleStorage();
  }

  // ---- device lines (#93) ----
  const device = deps.device === undefined ? null : mountDeviceSection(box, deps.device, deps.clock);

  // ---- VAD section (#56) ----
  const vad = deps.vad === undefined ? null : mountVadSection(root, box, deps.vad, deps.clock);

  return {
    refresh() {
      refresh();
      device?.refresh();
      vad?.refresh();
    },
    dispose() {
      live = false;
      deps.clock.clearTimeout(timer);
      if (storageTimer !== null) deps.clock.clearTimeout(storageTimer);
      device?.dispose();
      vad?.dispose();
      box.remove();
    },
  };
}

// ---- the device lines (#93) -----------------------------------------------------------------------------------

/** How many mic-track events the track line shows (the newest). */
export const DEBUG_TRACK_EVENTS = 4;

/** The audio context's state and its `statechange` event (an AudioContext). */
export interface DebugStateContext {
  readonly state: AudioContextState;
  addEventListener(type: 'statechange', cb: () => void): void;
  removeEventListener(type: 'statechange', cb: () => void): void;
}

/** `navigator.mediaDevices`: the device list and its `devicechange` event. */
export interface DebugMediaDevices {
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  addEventListener(type: 'devicechange', cb: () => void): void;
  removeEventListener(type: 'devicechange', cb: () => void): void;
}

export interface DebugDeviceDeps {
  /** The haptics log's latest line (`createHaptics`'s `log`: each `vibrate` call and its result), or null. */
  lastVibrate(): string | null;
  /** The engine's audio context, once it exists (it is created at the first wake). */
  engine: { context(): DebugStateContext | null };
  /** The mic track's events arrive as session events: `trackMuted`, `trackUnmuted`, `trackEnded`. */
  session: Pick<Session, 'addTransitionListener'>;
  /** `navigator.mediaDevices`, or null where it is missing (an insecure context). */
  mediaDevices: DebugMediaDevices | null;
  /** Milliseconds on the page clock (`performance.now()` in the app): the track events' times. */
  now(): number;
}

/** A mic-track event of the track line. */
export interface TrackEvent {
  kind: 'mute' | 'unmute' | 'ended';
  /** Page time, ms. */
  t: number;
}

/** The haptics log's latest line as it is ("vibrate([12]) = true; immediate; …"); "vibrate –" before any. */
export function formatVibrate(line: string | null): string {
  return line ?? 'vibrate –';
}

/** "ctx state running"; a dash before there is a context. */
export function formatCtxState(state: AudioContextState | null): string {
  return `ctx state ${state ?? '–'}`;
}

/** "track mute 12.3 s · unmute 15.0 s" (page time, s); "track –" before any. */
export function formatTrackEvents(events: readonly TrackEvent[]): string {
  if (events.length === 0) return 'track –';
  return `track ${events.map((e) => `${e.kind} ${(e.t / 1000).toFixed(1)} s`).join(' · ')}`;
}

/** "inputs Speakerphone · Headset earpiece"; "(no label)" for an empty one, "(none)" for none, "–" if unknown. */
export function formatInputs(labels: readonly string[] | null): string {
  if (labels === null) return 'inputs –';
  if (labels.length === 0) return 'inputs (none)';
  return `inputs ${labels.map((l) => (l === '' ? '(no label)' : l)).join(' · ')}`;
}

/**
 * The device lines. The text tick (every DEBUG_REFRESH_MS) re-reads the vibrate line and moves the `statechange`
 * listener to the engine's current context (it exists from the first wake on); the state line itself is rewritten
 * by every `statechange`. Mic-track events come from the transition listeners, and the inputs are enumerated at
 * mount, on every `devicechange` and on `micGranted` (labels appear once the mic is granted).
 */
function mountDeviceSection(
  box: HTMLElement,
  deps: DebugDeviceDeps,
  clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>,
): { refresh(): void; dispose(): void } {
  const line = (name: string): HTMLParagraphElement => {
    const p = document.createElement('p');
    p.className = 'debug-line';
    p.dataset.line = name;
    box.append(p);
    return p;
  };
  const vibrateLine = line('vibrate');
  const ctxLine = line('ctxState');
  const trackLine = line('track');
  const inputsLine = line('inputs');
  let live = true;
  let timer = 0;

  // ---- the context's state ----
  let watched: DebugStateContext | null = null;
  const onState = (): void => {
    ctxLine.textContent = formatCtxState(watched === null ? null : watched.state);
  };
  function watch(): void {
    const ctx = deps.engine.context();
    if (ctx === watched) return;
    watched?.removeEventListener('statechange', onState);
    watched = ctx;
    watched?.addEventListener('statechange', onState);
    onState();
  }

  // ---- the audio inputs ----
  const media = deps.mediaDevices;
  /** Bumped by every enumeration: only the newest one writes the line. */
  let inputsGen = 0;
  async function refreshInputs(): Promise<void> {
    if (media === null) return;
    const gen = ++inputsGen;
    let labels: string[] | null = null;
    try {
      const devices = await media.enumerateDevices();
      labels = devices.filter((d) => d.kind === 'audioinput').map((d) => d.label);
    } catch {
      labels = null;
    }
    if (live && gen === inputsGen) inputsLine.textContent = formatInputs(labels);
  }
  const onDeviceChange = (): void => {
    void refreshInputs();
  };
  media?.addEventListener('devicechange', onDeviceChange);

  // ---- the mic track ----
  const track: TrackEvent[] = [];
  const offTransition = deps.session.addTransitionListener((_from, _to, e) => {
    const kind =
      e.t === 'trackMuted'
        ? 'mute'
        : e.t === 'trackUnmuted'
          ? 'unmute'
          : e.t === 'trackEnded'
            ? 'ended'
            : null;
    if (kind !== null) {
      track.push({ kind, t: deps.now() });
      if (track.length > DEBUG_TRACK_EVENTS) track.shift();
      trackLine.textContent = formatTrackEvents(track);
    } else if (e.t === 'micGranted') {
      void refreshInputs();
    }
  });

  function refresh(): void {
    vibrateLine.textContent = formatVibrate(deps.lastVibrate());
    watch();
  }

  // Each tick reschedules the same function: no closure per tick.
  function tick(): void {
    if (!live) return;
    refresh();
    timer = clock.setTimeout(tick, DEBUG_REFRESH_MS);
  }

  ctxLine.textContent = formatCtxState(null);
  trackLine.textContent = formatTrackEvents(track);
  inputsLine.textContent = formatInputs(null);
  refresh();
  void refreshInputs();
  timer = clock.setTimeout(tick, DEBUG_REFRESH_MS);

  return {
    refresh,
    dispose() {
      live = false;
      clock.clearTimeout(timer);
      offTransition();
      watched?.removeEventListener('statechange', onState);
      watched = null;
      media?.removeEventListener('devicechange', onDeviceChange);
    },
  };
}

// ---- the VAD section's lines, plot and data (#56) -----------------------------------------------------------

/** How often the VAD plot is redrawn, in ms: at most 15 fps (1000 / 67 ≈ 14.9). */
export const DEBUG_PLOT_MS = 67;
/** The VAD plot's time span, in seconds. */
export const DEBUG_PLOT_SECONDS = 10;
/** The VAD plot's size in CSS px (styles.css `.debug-plot` shows it at this size). */
export const DEBUG_PLOT_WIDTH = 320;
export const DEBUG_PLOT_HEIGHT = 160;
/** The dB axis of band dB and floor dB, in dBFS. */
export const DEBUG_PLOT_DB_MIN = -90;
export const DEBUG_PLOT_DB_MAX = 0;
/** The energy-gate bar's height at the bottom of the plot, in CSS px. */
export const DEBUG_GATE_BAR_PX = 6;
/** The plot's colours (canvas fill and stroke styles). */
export const DEBUG_PLOT_COLORS = {
  p: '#1a73e8',
  threshold: 'rgb(26 115 232 / 55%)',
  band: '#2f7a6d',
  floor: '#e8710a',
  egate: '#7fc8bc',
  start: '#188038',
  end: '#d93025',
  misfire: '#80868b',
} as const;

/** Ring capacities, each at least DEBUG_PLOT_SECONDS of its stream: 10 ms hops (1000), 32 ms Silero frames
 *  (313) and `level` events (one per LEVEL_HOPS hops: 334). */
const HOP_RING = 1024;
const SILERO_RING = 320;
const LEVEL_RING = 384;
/** Segment markers kept. */
const MARK_RING = 32;
/** The worker posts a `level` every this many hops (vad-core.ts LEVEL_EVERY_HOPS): the floor series' step. */
const LEVEL_HOPS = 3;
/**
 * Hops per 512-sample VAD frame, rounded up (4). On Silero every frame adds 3 or 4 hops and one p to the trace,
 * and a posted batch keeps at most 3 hops for the next one, so a batch of this many hops without a p ran on
 * energy.
 */
const HOPS_PER_VAD_FRAME = Math.ceil(VAD_FRAME / ENERGY_HOP);
/** A series line breaks where two points are more than this many steps apart (the VAD feed stopped). */
const GAP_STEPS = 3;
/** Marker kinds, the markers ring's tags. */
const MARK_START = 0;
const MARK_END = 1;
const MARK_MISFIRE = 2;
const LEGEND_FONT = '10px ui-monospace, monospace';
/** setLineDash arguments, allocated once. */
const DASH: number[] = [4, 3];
const SOLID: number[] = [];
/** Slots of a plot's `geo` array: the draw window's left edge and span, the last drawn end frame, the current
 *  series step, the hop length, and the gate replay's epoch, last synced level frame and sync limit. */
const G_T0 = 0;
const G_SPAN = 1;
const G_LAST_END = 2;
const G_STEP = 3;
const G_HOP = 4;
const G_GATE_EPOCH = 5;
const G_LAST_SYNCED = 6;
const G_LIMIT = 7;
const GEO_SIZE = 8;

/** The audio context's clock, rate and output latency (an AudioContext). */
export type DebugAudioContext = Pick<AudioContext, 'sampleRate' | 'outputLatency' | 'currentTime'>;
export type VadBackendName = 'silero' | 'energy';
export type TraceBatch = Extract<LevelEvent, { t: 'traceBatch' }>;

export interface DebugVadDeps {
  /** createEngine's result: the feature-trace switch and the audio context. */
  engine: TraceHost & { context(): DebugAudioContext | null };
  /** State and epoch, the level listeners (trace, levels, stats) and the transition listeners (seg). */
  session: Pick<Session, 'state' | 'subscribeLevel' | 'addTransitionListener'>;
}

/** "state Listening · epoch 3". */
export function formatVadState(name: StateName, epoch: number): string {
  return `state ${name} · epoch ${epoch}`;
}

/** "vad silero · ready yes"; a dash before the first trace batch. */
export function formatVadBackend(backend: VadBackendName | null, ready: boolean): string {
  return `vad ${backend ?? '–'} · ready ${ready ? 'yes' : 'no'}`;
}

/** "infer p95 0.94 ms · max 1.30 ms": the last `vadStats` p95 and the newest Silero batch's largest inference
 *  time; dashes where there is none. */
export function formatVadStats(p95Ms: number, maxMs: number): string {
  return `infer p95 ${formatMs(p95Ms)} · max ${formatMs(maxMs)}`;
}

/** "ctx 48000 Hz · out 12.5 ms" (sample rate, output latency); dashes without a context or a latency. */
export function formatAudioContext(ctx: DebugAudioContext | null): string {
  const rate = ctx === null ? '–' : String(ctx.sampleRate);
  const out =
    ctx !== null && Number.isFinite(ctx.outputLatency) ? (ctx.outputLatency * 1000).toFixed(1) : '–';
  return `ctx ${rate} Hz · out ${out} ms`;
}

function formatMs(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(2)} ms` : '– ms';
}

/**
 * The backend a trace batch shows the worker ran: Silero if it carries a p; energy if it spans a whole VAD frame
 * (HOPS_PER_VAD_FRAME hops) without one; null for a shorter batch without one (a flush right after a post).
 */
export function batchBackend(b: TraceBatch): VadBackendName | null {
  if (b.sileroP.length > 0) return 'silero';
  return b.bandDb.length >= HOPS_PER_VAD_FRAME ? 'energy' : null;
}

/** A fixed-capacity ring of timed samples (ctx frame, value, tag); when full, a new one overwrites the oldest. */
class TimedRing {
  readonly frames: Float64Array;
  readonly values: Float64Array;
  readonly tags: Float64Array;
  /** Samples held, at most the capacity. */
  size = 0;
  /** Index of the next write. */
  private next = 0;

  constructor(capacity: number) {
    this.frames = new Float64Array(capacity);
    this.values = new Float64Array(capacity);
    this.tags = new Float64Array(capacity);
  }

  /**
   * Makes room for a new newest sample, overwriting the oldest when full, and returns its array index; the caller
   * writes `frames`, `values` and `tags` there. (Handing the numbers over as arguments could box them.)
   */
  claim(): number {
    const i = this.next;
    this.next = i + 1 === this.frames.length ? 0 : i + 1;
    if (this.size < this.frames.length) this.size++;
    return i;
  }

  /** The array index of the k-th newest sample (k = 0: the newest), for 0 ≤ k < size. */
  at(k: number): number {
    const i = this.next - 1 - k;
    return i < 0 ? i + this.frames.length : i;
  }
}

/** The VAD plot: its data rings and its drawing. */
export interface VadPlot {
  /** Appends a trace batch at context rate `rate`: per hop the band dB and the replayed energy gate, per Silero
   *  frame its p. Hop i is at ctx frame hop0Frame + i hops and Silero frame j at sil0Frame + j VAD frames, its own
   *  frame: the DSP worker ends a batch at a capture gap (vad-core.ts `captureGap`, #244), so no batch spans one. */
  trace(b: TraceBatch, rate: number): void;
  /** Appends a `level` event's floor: the energy gate's floor after the hop at ctx frame `frame` (NaN while
   *  uninitialised). */
  level(epoch: number, frame: number, floorDb: number): void;
  /** Appends a segment marker. */
  seg(ev: SegEvent): void;
  /** Redraws the DEBUG_PLOT_SECONDS that end at ctx frame `endFrame`; nothing when neither `endFrame` nor the
   *  data changed since the last draw. */
  draw(endFrame: number, rate: number): void;
  /** The replayed energy-gate state of the k-th newest hop (k = 0: the newest); false past the stored hops. */
  gateOpen(k: number): boolean;
}

/**
 * The plot on `canvas`: a backing store of DEBUG_PLOT_WIDTH × DEBUG_PLOT_HEIGHT CSS px at `dpr`, and rings for
 * the last DEBUG_PLOT_SECONDS of hops, Silero frames, floors and segment markers, all allocated here. Neither
 * ingesting nor drawing allocates.
 *
 * The energy gate (the bar) is replayed hop by hop with `energyGateStep`, the worker's own step, on the trace's
 * band dB. Before each hop the replay takes the floor of the newest `level` of the batch's epoch that the worker
 * posted at an earlier hop, if it hasn't taken that one yet; between levels its own floor update carries the
 * floor exactly as the worker's does. A batch of a new epoch starts the replay uninitialised and closed, like the
 * worker's `reset`. One known difference: an epoch armed with a restored floor has that floor on its first hop
 * in the worker only, so an onset on that very hop shows once the gate next crosses.
 */
export function createVadPlot(
  canvas: HTMLCanvasElement,
  dpr: number = Math.min(window.devicePixelRatio || 1, MAX_DPR),
): VadPlot {
  return new VadPlotImpl(canvas, dpr);
}

// The plot's per-draw and per-hop helpers are module functions and prototype methods, never per-plot closures, so
// every call site has one target. Whether V8 inlines a call still depends on how often it ran before the compile,
// and a call it doesn't inline boxes a fractional number it returns. So a loop that runs per point, hop, run or
// marker computes its coordinates inline (the same expressions, so the same values) and hands numbers only to
// canvas methods, which TurboFan calls without boxing (#319).

const PLOT_H = DEBUG_PLOT_HEIGHT - DEBUG_GATE_BAR_PX;

/** The y of a Silero p, clamped to 0–1. (strokeSeries writes it out inline.) */
function plotYP(p: number): number {
  return (1 - Math.min(1, Math.max(0, p))) * PLOT_H;
}

/** The Silero thresholds' dashed lines (SILERO_SEG_PARAMS, 0.5 and 0.35). */
const Y_POS = plotYP(SILERO_SEG_PARAMS.posThreshold);
const Y_NEG = plotYP(SILERO_SEG_PARAMS.negThreshold);

/**
 * One series, newest to oldest, in `color`: on the dB axis if `db` (clamped to DEBUG_PLOT_DB_MIN–MAX), else on the
 * p axis (clamped to 0–1). A point's x is ((f - t0) / span) · DEBUG_PLOT_WIDTH in the window geo holds (G_T0,
 * G_SPAN). Points more than GAP_STEPS steps (geo[G_STEP]) apart aren't joined; a non-finite value lifts the pen.
 */
function strokeSeries(
  c: CanvasRenderingContext2D,
  ring: TimedRing,
  geo: Float64Array,
  db: boolean,
  color: string,
): void {
  const gap = GAP_STEPS * geo[G_STEP]!;
  const t0 = geo[G_T0]!;
  const span = geo[G_SPAN]!;
  c.strokeStyle = color;
  c.beginPath();
  let prev = Number.POSITIVE_INFINITY;
  let pen = false;
  for (let k = 0; k < ring.size; k++) {
    const i = ring.at(k);
    const f = ring.frames[i]!;
    if (f > prev) break; // older than a restarted timeline (a new AudioContext)
    const v = ring.values[i]!;
    if (Number.isFinite(v)) {
      const px = ((f - t0) / span) * DEBUG_PLOT_WIDTH;
      const py = db
        ? ((DEBUG_PLOT_DB_MAX - Math.min(DEBUG_PLOT_DB_MAX, Math.max(DEBUG_PLOT_DB_MIN, v))) /
            (DEBUG_PLOT_DB_MAX - DEBUG_PLOT_DB_MIN)) *
          PLOT_H
        : (1 - Math.min(1, Math.max(0, v))) * PLOT_H;
      if (pen && prev - f <= gap) c.lineTo(px, py);
      else c.moveTo(px, py);
      pen = true;
    } else {
      pen = false;
    }
    prev = f;
    if (f < t0) break; // one point past the left edge, so the line reaches it
  }
  c.stroke();
}

/**
 * The energy-gate bar: one rectangle per run of contiguous open hops (hop length geo[G_HOP]), its x as in
 * strokeSeries.
 *
 * The walk's last step (k = hops.size, or a hop older than the timeline or left of the window) closes the last run
 * inside the loop, at the loop's one fillRect, and nothing follows the loop. V8 keeps a function's on-stack-
 * replacement (OSR) code when it deoptimises after the OSR'd loop, so a flush after the loop that had no type
 * feedback when the loop was compiled would deoptimise on every draw that ends inside an open run (#319).
 */
function drawGateBar(c: CanvasRenderingContext2D, hops: TimedRing, geo: Float64Array): void {
  const hop = geo[G_HOP]!;
  const t0 = geo[G_T0]!;
  const span = geo[G_SPAN]!;
  c.fillStyle = DEBUG_PLOT_COLORS.egate;
  let inRun = false;
  let runStart = 0;
  let runEnd = 0;
  let prev = Number.POSITIVE_INFINITY;
  for (let k = 0; k <= hops.size; k++) {
    let last = k === hops.size;
    let open = false;
    let f = 0;
    if (!last) {
      const i = hops.at(k);
      f = hops.frames[i]!;
      if (f > prev || f + hop < t0) {
        last = true; // an older timeline, or left of the window
      } else {
        prev = f;
        open = hops.tags[i] === 1;
      }
    }
    if (open && inRun && runStart - (f + hop) <= hop / 2) {
      runStart = f; // the run reaches one hop further back
      continue;
    }
    if (inRun) {
      const xa = ((runStart - t0) / span) * DEBUG_PLOT_WIDTH;
      c.fillRect(xa, PLOT_H, ((runEnd - t0) / span) * DEBUG_PLOT_WIDTH - xa, DEBUG_GATE_BAR_PX);
    }
    if (last) break;
    inRun = open;
    runStart = f;
    runEnd = f + hop;
  }
}

/** The segment markers in the window: 2 px columns, green start, red end, grey misfire; x as in strokeSeries. */
function drawMarkers(c: CanvasRenderingContext2D, marks: TimedRing, geo: Float64Array): void {
  const t0 = geo[G_T0]!;
  const span = geo[G_SPAN]!;
  let prev = Number.POSITIVE_INFINITY;
  for (let k = 0; k < marks.size; k++) {
    const i = marks.at(k);
    const f = marks.frames[i]!;
    if (f > prev || f < t0) break;
    prev = f;
    const kind = marks.tags[i];
    c.fillStyle =
      kind === MARK_START
        ? DEBUG_PLOT_COLORS.start
        : kind === MARK_END
          ? DEBUG_PLOT_COLORS.end
          : DEBUG_PLOT_COLORS.misfire;
    c.fillRect(Math.round(((f - t0) / span) * DEBUG_PLOT_WIDTH) - 1, 0, 2, PLOT_H);
  }
}

/** The plot's legend, top left, in the series' colours. */
function drawLegend(c: CanvasRenderingContext2D): void {
  c.fillStyle = DEBUG_PLOT_COLORS.p;
  c.fillText('p', 4, 3);
  c.fillStyle = DEBUG_PLOT_COLORS.band;
  c.fillText('band', 16, 3);
  c.fillStyle = DEBUG_PLOT_COLORS.floor;
  c.fillText('floor', 46, 3);
  c.fillStyle = DEBUG_PLOT_COLORS.egate;
  c.fillText('egate', 82, 3);
}

class VadPlotImpl implements VadPlot {
  private readonly g: CanvasRenderingContext2D | null;
  private readonly hops = new TimedRing(HOP_RING);
  private readonly sils = new TimedRing(SILERO_RING);
  private readonly levels = new TimedRing(LEVEL_RING);
  private readonly marks = new TimedRing(MARK_RING);
  /** The replayed energy gate and the features object it steps on. */
  private readonly gate = initialEnergyGateState();
  private readonly feat: FrameFeatures = { frame: 0, db: 0, floorDb: Number.NaN };
  /** The plot's changing numbers (the G_* slots): a fractional number in an object field or a closure variable
   *  can be boxed (allocated) on a store; in a Float64Array it never is. */
  private readonly geo = new Float64Array(GEO_SIZE);
  /** Bumped by every append (a small integer, never boxed); draw() skips while neither it nor the end frame
   *  changed. */
  private version = 0;
  private lastVersion = -1;

  constructor(canvas: HTMLCanvasElement, dpr: number) {
    canvas.width = Math.round(DEBUG_PLOT_WIDTH * dpr);
    canvas.height = Math.round(DEBUG_PLOT_HEIGHT * dpr);
    const g = canvas.getContext('2d');
    if (g !== null) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.font = LEGEND_FONT;
      g.textBaseline = 'top';
    }
    this.g = g;
    this.geo[G_SPAN] = 1;
    this.geo[G_LAST_END] = Number.NaN;
    this.geo[G_GATE_EPOCH] = Number.NaN;
    this.geo[G_LAST_SYNCED] = Number.NEGATIVE_INFINITY;
  }

  trace(b: TraceBatch, rate: number): void {
    const geo = this.geo;
    const gate = this.gate;
    const feat = this.feat;
    const hops = this.hops;
    const sils = this.sils;
    const hop = (rate * ENERGY_HOP) / VAD_RATE;
    const sil = (rate * VAD_FRAME) / VAD_RATE;
    const epoch = b.epoch;
    if (epoch !== geo[G_GATE_EPOCH]) {
      geo[G_GATE_EPOCH] = epoch;
      geo[G_LAST_SYNCED] = Number.NEGATIVE_INFINITY;
      gate.floorDb = Number.NaN;
      gate.initialized = false;
      gate.active = false;
    }
    const band = b.bandDb;
    for (let i = 0; i < band.length; i++) {
      const f = b.hop0Frame + i * hop; // the hop's own frame: a batch never spans a capture gap (#244)
      geo[G_LIMIT] = f - hop / 2;
      this.sync(epoch);
      const db = band[i]!;
      feat.frame = f;
      feat.db = db;
      energyGateStep(gate, feat, DEFAULT_ENERGY_PARAMS);
      const h = hops.claim();
      hops.frames[h] = f;
      hops.values[h] = db;
      hops.tags[h] = gate.active ? 1 : 0;
    }
    const p = b.sileroP;
    for (let j = 0; j < p.length; j++) {
      const k = sils.claim();
      sils.frames[k] = b.sil0Frame + j * sil;
      sils.values[k] = p[j]!;
      sils.tags[k] = 0;
    }
    this.version++;
  }

  level(epoch: number, frame: number, floorDb: number): void {
    const levels = this.levels;
    const i = levels.claim();
    levels.frames[i] = frame;
    levels.values[i] = floorDb;
    levels.tags[i] = epoch;
    this.version++;
  }

  seg(ev: SegEvent): void {
    const kind = ev.kind === 'start' ? MARK_START : ev.kind === 'end' ? MARK_END : MARK_MISFIRE;
    const marks = this.marks;
    const i = marks.claim();
    marks.frames[i] = ev.frame;
    marks.values[i] = 0;
    marks.tags[i] = kind;
    this.version++;
  }

  draw(endFrame: number, rate: number): void {
    const g = this.g;
    const geo = this.geo;
    if (g === null || (endFrame === geo[G_LAST_END] && this.version === this.lastVersion)) return;
    geo[G_LAST_END] = endFrame;
    this.lastVersion = this.version;
    const hop = (rate * ENERGY_HOP) / VAD_RATE;
    geo[G_HOP] = hop;
    geo[G_SPAN] = DEBUG_PLOT_SECONDS * rate;
    geo[G_T0] = endFrame - DEBUG_PLOT_SECONDS * rate;
    g.clearRect(0, 0, DEBUG_PLOT_WIDTH, DEBUG_PLOT_HEIGHT);
    g.lineWidth = 1;
    g.strokeStyle = DEBUG_PLOT_COLORS.threshold;
    g.setLineDash(DASH);
    g.beginPath();
    g.moveTo(0, Y_POS);
    g.lineTo(DEBUG_PLOT_WIDTH, Y_POS);
    g.moveTo(0, Y_NEG);
    g.lineTo(DEBUG_PLOT_WIDTH, Y_NEG);
    g.stroke();
    g.setLineDash(SOLID);
    drawGateBar(g, this.hops, geo);
    g.lineWidth = 1.5;
    geo[G_STEP] = hop;
    strokeSeries(g, this.hops, geo, true, DEBUG_PLOT_COLORS.band);
    geo[G_STEP] = LEVEL_HOPS * hop;
    strokeSeries(g, this.levels, geo, true, DEBUG_PLOT_COLORS.floor);
    geo[G_STEP] = (rate * VAD_FRAME) / VAD_RATE;
    strokeSeries(g, this.sils, geo, false, DEBUG_PLOT_COLORS.p);
    drawMarkers(g, this.marks, geo);
    drawLegend(g);
  }

  gateOpen(k: number): boolean {
    return k >= 0 && k < this.hops.size && this.hops.tags[this.hops.at(k)] === 1;
  }

  /** Takes the floor of the newest `level` of `epoch` posted before ctx frame geo[G_LIMIT], unless already
   *  taken. */
  private sync(epoch: number): void {
    const geo = this.geo;
    const levels = this.levels;
    const limit = geo[G_LIMIT]!;
    let prev = Number.POSITIVE_INFINITY;
    for (let k = 0; k < levels.size; k++) {
      const i = levels.at(k);
      const f = levels.frames[i]!;
      if (f > prev) return; // older than a restarted timeline (a new AudioContext)
      prev = f;
      if (f >= limit) continue;
      if (levels.tags[i] === epoch && f > geo[G_LAST_SYNCED]!) {
        const floorDb = levels.values[i]!;
        this.gate.floorDb = floorDb;
        this.gate.initialized = Number.isFinite(floorDb);
        geo[G_LAST_SYNCED] = f;
      }
      return;
    }
  }
}

/**
 * The VAD section's four lines (`data-line` = state, vad, infer, ctx) in the overlay's box and its plot canvas
 * in `root`. Subscribes to the session, then turns the feature trace on; `dispose` undoes all of it.
 */
function mountVadSection(
  root: HTMLElement,
  box: HTMLElement,
  deps: DebugVadDeps,
  clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>,
): { refresh(): void; dispose(): void } {
  const { engine, session } = deps;
  const line = (name: string): HTMLParagraphElement => {
    const p = document.createElement('p');
    p.className = 'debug-line';
    p.dataset.line = name;
    box.append(p);
    return p;
  };
  const stateLine = line('state');
  const vadLine = line('vad');
  const inferLine = line('infer');
  const ctxLine = line('ctx');
  const canvas = document.createElement('canvas');
  canvas.className = 'debug-plot';
  root.append(canvas);
  const plot = createVadPlot(canvas);

  let backend: VadBackendName | null = null;
  let ready = false;
  let p95Ms = Number.NaN;
  let maxMs = Number.NaN;

  const offLevel = session.subscribeLevel((e) => {
    switch (e.t) {
      case 'traceBatch': {
        const ctx = engine.context();
        if (ctx !== null) plot.trace(e, ctx.sampleRate);
        const bk = batchBackend(e);
        if (bk !== null) backend = bk;
        if (e.inferMs.length > 0) maxMs = maxOf(e.inferMs);
        else if (bk === 'energy') maxMs = Number.NaN;
        break;
      }
      case 'level':
        plot.level(e.epoch, e.frame, e.floorDb);
        break;
      case 'vadStats':
        p95Ms = e.p95Ms;
        break;
      case 'vadReady':
        ready = true;
        break;
      case 'vadError':
        break;
    }
  });
  // A restarted worker (workerFailed, or the recording watchdog's restartWorker without one) reloads the model
  // and posts a fresh vadReady.
  const offTransition = session.addTransitionListener((_from, _to, e, effects) => {
    if (e.t === 'seg') plot.seg(e.ev);
    else if (e.t === 'workerFailed') ready = false;
    for (let i = 0; i < effects.length; i++) {
      if (effects[i]?.k === 'restartWorker') ready = false;
    }
  });
  engine.setTrace(true);

  let live = true;
  let textTimer = 0;
  let plotTimer = 0;

  function refresh(): void {
    const st = session.state();
    stateLine.textContent = formatVadState(st.name, st.epoch);
    vadLine.textContent = formatVadBackend(backend, ready);
    inferLine.textContent = formatVadStats(p95Ms, maxMs);
    ctxLine.textContent = formatAudioContext(engine.context());
  }

  /** Redraws the plot up to the audio clock now (the ctx-frame timeline); nothing without a context. */
  function draw(): void {
    const ctx = engine.context();
    if (ctx !== null) plot.draw(ctx.currentTime * ctx.sampleRate, ctx.sampleRate);
  }

  // Each tick reschedules the same function: no closure per tick.
  function textTick(): void {
    if (!live) return;
    refresh();
    textTimer = clock.setTimeout(textTick, DEBUG_REFRESH_MS);
  }

  function plotTick(): void {
    if (!live) return;
    draw();
    plotTimer = clock.setTimeout(plotTick, DEBUG_PLOT_MS);
  }

  refresh();
  draw();
  textTimer = clock.setTimeout(textTick, DEBUG_REFRESH_MS);
  plotTimer = clock.setTimeout(plotTick, DEBUG_PLOT_MS);

  return {
    refresh,
    dispose() {
      live = false;
      clock.clearTimeout(textTimer);
      clock.clearTimeout(plotTimer);
      offLevel();
      offTransition();
      engine.setTrace(false);
      canvas.remove();
    },
  };
}

/** The largest value of a non-empty array. */
function maxOf(a: Float32Array): number {
  let m = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (v > m) m = v;
  }
  return m;
}
