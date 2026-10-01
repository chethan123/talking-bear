// Lab page for X-E6, X-E10 and X-E11 (plan §5, §4.5): what the platform does to a running capture when the
// page is backgrounded or the screen locks, the actual sample rates and latencies per constraint set, and the
// screen wake lock under battery saver and lock/unlock. Dev-only: `pnpm dev`, then /lab/platform.html
// (docs/lab.md). Every log line carries the local wall-clock time (logPanel) and performance.now() in ms.
// Privacy (plan Q2): no audio is kept anywhere. The capture logs only RMS numbers, the log lives in memory,
// and Copy log copies text only.

import { CONSTRAINTS, createMicManager } from '../src/audio/mic.ts';
import { createVisibility } from '../src/platform/visibility.ts';
import {
  createWakeLock,
  type WakeLockNavigator,
  type WakeLockSentinelLike,
} from '../src/platform/wake-lock.ts';
import { el, fmt, logPanel } from './common.ts';

/** How often the input RMS is logged while capturing. A timer, not rAF, which stops while the page is hidden. */
const RMS_LOG_MS = 1000;
/** The analyser window: the largest fftSize (~0.7 s at 44.1 or 48 kHz), so each RMS covers most of its second. */
const RMS_FFT_SIZE = 32768;
/** How long Probe rates keeps each set's mic open before logging, so the latencies are those of a live stream. */
const PROBE_SETTLE_MS = 1000;

/** Every production constraint switched on: the "EC on" set, as lab/routing's EC checkbox (plan §4.1.1). */
const ALL_ON = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const satisfies Record<keyof typeof CONSTRAINTS, true>;

/** X-E10's constraint sets. The mic manager merges each over the production CONSTRAINTS. */
const PROBE_SETS: readonly { readonly name: string; readonly extra: MediaTrackConstraints }[] = [
  { name: 'all three off', extra: {} },
  { name: 'EC on', extra: ALL_ON },
  { name: 'noiseSuppression: true only', extra: { noiseSuppression: true } },
];

type Activity = 'idle' | 'starting' | 'capturing' | 'probing';

/** A running capture: the context, the mic source and the analyser its RMS is read from once a second. */
interface Capture {
  readonly ctx: AudioContext;
  readonly source: MediaStreamAudioSourceNode;
  readonly analyser: AnalyserNode;
  readonly track: MediaStreamTrack | null;
  /** `getFloatTimeDomainData` output, reused every tick. */
  readonly samples: Float32Array<ArrayBuffer>;
  readonly timer: number;
}

// ---- page ---------------------------------------------------------------------------------------------------

const root = document.getElementById('lab');
if (!(root instanceof HTMLElement)) throw new Error('lab/platform: missing #lab');

const startButton = el('button', { type: 'button' }, 'Start capture');
const stopButton = el('button', { type: 'button' }, 'Stop');
const acquireButton = el('button', { type: 'button' }, 'Acquire wake lock');
const releaseButton = el('button', { type: 'button' }, 'Release wake lock');
const probeButton = el('button', { type: 'button' }, 'Probe rates');

root.append(
  el(
    'fieldset',
    {},
    el('legend', {}, "X-E6: capture (echo cancellation off, the app's constraints)"),
    startButton,
    stopButton,
  ),
  el('fieldset', {}, el('legend', {}, 'X-E11: screen wake lock'), acquireButton, releaseButton),
  el('fieldset', {}, el('legend', {}, 'X-E10: sample rates and latencies'), probeButton),
);
const logLine = logPanel(root);

/** Appends `line` after performance.now() in ms; logPanel prefixes the local wall-clock time. */
function log(line: string): void {
  logLine(`[${fmt(performance.now(), 1)} ms] ${line}`);
}

/** An error's name and message (a DOMException is an Error), or the value as text. */
function describe(value: unknown): string {
  return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}

// ---- page lifecycle (X-E6, X-E11) ---------------------------------------------------------------------------

// Registered before createVisibility() below, so each event's line comes before the wake lock's reaction to it.
document.addEventListener('visibilitychange', () => {
  log(`visibilitychange: visibilityState ${document.visibilityState}`);
});
window.addEventListener('pagehide', (e) => log(`pagehide: persisted ${e.persisted}`));
window.addEventListener('pageshow', (e) => log(`pageshow: persisted ${e.persisted}`));
document.addEventListener('freeze', () => log('freeze'));
document.addEventListener('resume', () => log('resume'));

// ---- wake lock (X-E11) --------------------------------------------------------------------------------------

/** `navigator.wakeLock.request`, logging the request, the grant and the sentinel's `release` event. */
async function requestLogged(type: 'screen'): Promise<WakeLockSentinelLike> {
  log(`wake lock: requesting (visibilityState ${document.visibilityState})`);
  const sentinel = await navigator.wakeLock.request(type);
  log(`wake lock: granted (released ${sentinel.released})`);
  sentinel.addEventListener('release', () => {
    log(`wake lock: release event (visibilityState ${document.visibilityState})`);
  });
  return sentinel;
}

const hasWakeLock = 'wakeLock' in navigator;
/**
 * The app's wake-lock policy (src/platform/wake-lock.ts): requested only while visible, re-requested on every
 * `visible` while wanted, released on set(false). Its navigator logs every request; its log callback receives
 * request rejections and release failures, with their messages.
 */
const wakeNav: WakeLockNavigator = hasWakeLock ? { wakeLock: { request: requestLogged } } : {};
const wakeLock = createWakeLock(wakeNav, createVisibility(), (...args: unknown[]) => {
  log(args.map(describe).join(': '));
});

function acquire(): void {
  if (!hasWakeLock) return log('acquire wake lock: navigator.wakeLock is missing');
  log(`acquire wake lock: wanted (held ${wakeLock.held()})`);
  wakeLock.set(true);
}

function release(): void {
  log(`release wake lock: not wanted (held ${wakeLock.held()})`);
  wakeLock.set(false);
}

// ---- mic (X-E6, X-E10) --------------------------------------------------------------------------------------

/** `getUserMedia`, logging the exact constraints the mic manager requests and any rejection's message. */
async function getUserMediaLogged(c: MediaStreamConstraints): Promise<MediaStream> {
  log(`getUserMedia ${JSON.stringify(c)}`);
  try {
    return await navigator.mediaDevices.getUserMedia(c);
  } catch (err) {
    log(`getUserMedia failed: ${describe(err)}`);
    throw err;
  }
}

/** The app's mic manager (src/audio/mic.ts): the production CONSTRAINTS and its stale-request rule. */
const mic = createMicManager(getUserMediaLogged);
let nextReq = 0;
let activity: Activity = 'idle';
let capture: Capture | null = null;
/** Bumped by Start capture, Probe rates and Stop: a step that finds it changed after an await was stopped. */
let generation = 0;

function watchTrack(track: MediaStreamTrack, label: string): void {
  for (const type of ['mute', 'unmute', 'ended'] as const) {
    track.addEventListener(type, () => {
      log(`${label}: track ${type} (readyState ${track.readyState}, muted ${track.muted})`);
    });
  }
}

function closeContext(ctx: AudioContext, label: string): Promise<void> {
  return ctx.close().catch((err: unknown) => log(`${label}: context close failed: ${describe(err)}`));
}

/**
 * As in the app (src/audio/engine.ts): no forced sampleRate, 'interactive' latency, created and resumed before
 * getUserMedia. Logs every statechange. The event carries no state, so each line shows `ctx.state` when the
 * event is handled: a fast running → closed can log `closed` twice.
 */
async function openContext(label: string): Promise<AudioContext> {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  ctx.addEventListener('statechange', () => log(`${label}: ctx.state ${ctx.state}`));
  log(`${label}: context created (ctx.state ${ctx.state})`);
  try {
    await ctx.resume();
  } catch (err) {
    void closeContext(ctx, label); // a context that never started still holds audio resources
    throw err;
  }
  return ctx;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

// ---- capture (X-E6) -----------------------------------------------------------------------------------------

function logRms(): void {
  const c = capture;
  if (c === null) return;
  const x = c.samples;
  c.analyser.getFloatTimeDomainData(x);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i]! * x[i]!;
  const t = c.track;
  const track = t === null ? 'none' : `${t.readyState}${t.muted ? ', muted' : ''}`;
  log(`rms: ${fmt(10 * Math.log10(sum / x.length), 1)} dBFS (ctx.state ${c.ctx.state}, track ${track})`);
}

function begin(ctx: AudioContext, stream: MediaStream): Capture {
  const track = stream.getAudioTracks()[0] ?? null;
  if (track !== null) watchTrack(track, 'capture');
  const source = ctx.createMediaStreamSource(stream);
  const analyser = new AnalyserNode(ctx, { fftSize: RMS_FFT_SIZE });
  source.connect(analyser);
  log(
    `capture: running at ${ctx.sampleRate} Hz; track "${track?.label ?? ''}" ${JSON.stringify(track?.getSettings() ?? null)}`,
  );
  return {
    ctx,
    source,
    analyser,
    track,
    samples: new Float32Array(analyser.fftSize),
    timer: window.setInterval(logRms, RMS_LOG_MS),
  };
}

async function startCapture(): Promise<void> {
  if (activity !== 'idle') return log(`start capture: ignored while ${activity} (Stop ends it)`);
  activity = 'starting';
  const gen = ++generation;
  let ctx: AudioContext | null = null;
  let outcome: string;
  try {
    ctx = await openContext('capture');
    const r = gen === generation ? await mic.open(++nextReq) : null;
    if (r?.t === 'micGranted') {
      capture = begin(ctx, r.stream);
      activity = 'capturing';
      return;
    }
    outcome = r === null || r.t === 'stale' ? 'stopped' : r.t;
  } catch (err) {
    outcome = `failed: ${describe(err)}`;
  }
  if (ctx !== null) void closeContext(ctx, 'capture');
  if (gen === generation) {
    mic.close(); // a stream granted before begin() threw must not stay live
    activity = 'idle';
  }
  log(`start capture: ${outcome}`);
}

function stop(): void {
  generation++; // stops a start or a probe that is still awaiting the context, the prompt or the settle time
  mic.close(); // stops every live mic track and makes a pending open stale
  const was = activity;
  activity = 'idle';
  const c = capture;
  capture = null;
  if (c !== null) {
    window.clearInterval(c.timer);
    c.source.disconnect();
    void closeContext(c.ctx, 'capture');
  }
  log(was === 'idle' ? 'stop: nothing running' : `stop: ${was} stopped, mic released`);
}

// ---- probe rates (X-E10) ------------------------------------------------------------------------------------

/**
 * One constraint set: a new context and the mic with `extra` over CONSTRAINTS, PROBE_SETTLE_MS of live stream,
 * then one log line with the rates, the latencies and `track.getSettings()`, then both closed. False: stopped.
 */
async function probeOne(gen: number, label: string, extra: MediaTrackConstraints): Promise<boolean> {
  let ctx: AudioContext | null = null;
  try {
    ctx = await openContext(label);
    if (gen !== generation) return false;
    const r = await mic.open(++nextReq, extra);
    if (r.t === 'stale') return false;
    if (r.t !== 'micGranted') {
      log(`${label}: ${r.t}`);
      return true;
    }
    const track = r.stream.getAudioTracks()[0] ?? null;
    if (track !== null) watchTrack(track, label);
    const source = ctx.createMediaStreamSource(r.stream);
    source.connect(new AnalyserNode(ctx)); // the stream flows into the graph, as in a capture
    await sleep(PROBE_SETTLE_MS);
    if (gen !== generation) return false;
    log(
      `${label}: ctx.sampleRate ${ctx.sampleRate} Hz, baseLatency ${fmt(ctx.baseLatency, 4)} s, outputLatency ${fmt(ctx.outputLatency, 4)} s, track.getSettings() ${JSON.stringify(track?.getSettings() ?? null)}`,
    );
    mic.close();
    log(`${label}: mic closed (track readyState ${track?.readyState ?? 'none'})`);
    source.disconnect();
    return true;
  } catch (err) {
    if (gen !== generation) return false;
    log(`${label}: failed: ${describe(err)}`);
    mic.close();
    return true;
  } finally {
    if (ctx !== null) await closeContext(ctx, label); // sets never overlap
  }
}

async function probeRates(): Promise<void> {
  if (activity !== 'idle') return log(`probe rates: ignored while ${activity} (Stop ends it)`);
  activity = 'probing';
  const gen = ++generation;
  for (const [i, set] of PROBE_SETS.entries()) {
    const label = `probe ${i + 1}/${PROBE_SETS.length} (${set.name})`;
    if (gen !== generation || !(await probeOne(gen, label, set.extra))) return;
  }
  if (gen !== generation) return;
  activity = 'idle';
  log('probe rates: done');
}

// ---- wiring -------------------------------------------------------------------------------------------------

function action(button: HTMLButtonElement, run: () => Promise<void> | void): void {
  button.addEventListener('click', () => {
    Promise.resolve()
      .then(run)
      .catch((err: unknown) => log(`${button.textContent}: ${describe(err)}`));
  });
}

action(startButton, startCapture);
action(stopButton, stop);
action(acquireButton, acquire);
action(releaseButton, release);
action(probeButton, probeRates);
log(`lab/platform ready: ${navigator.userAgent}`);
log(
  `timeOrigin ${new Date(performance.timeOrigin).toISOString()}, visibilityState ${document.visibilityState}, wasDiscarded ${'wasDiscarded' in document ? String(document.wasDiscarded) : 'unsupported'}`,
);
if (!window.isSecureContext) {
  log(
    'not a secure context: the mic and the wake lock need https or http://localhost (docs/lab.md: adb reverse)',
  );
}
