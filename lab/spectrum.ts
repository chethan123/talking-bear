// Lab page for X-F2 (plan §5): how much energy real Android captures carry above 8 kHz, which shows how
// audible aliasing would have been without the sinc resampler. Dev-only: `pnpm dev`, then /lab/spectrum.html
// (docs/lab.md). Hold to talk: while the button is held, the mic (opened through the app's mic manager, so
// with the production constraints) is captured into the session's one in-memory buffer; on release the page
// computes the energy share above 8 and 12 kHz with createRealFft, then zeroes the buffer at once. An interrupted
// hold or a hidden page discards the phrase unanalysed. Privacy (plan Q2): only the numbers are kept; Copy
// results (JSON) and Copy log copy text only, and nothing captured is stored or exported.

import { MAX_UTTERANCE_MS } from '../src/audio/constants.ts';
import { CONSTRAINTS, createMicManager } from '../src/audio/mic.ts';
import { createRealFft } from '../src/dsp/fft.ts';
import { el, fmt, logPanel } from './common.ts';
import { SIBILANT_PHRASES } from './phrases-sibilant.ts';
import recorderUrl from './recorder.worklet.ts?worker&url';

/** The processor name registered by lab/recorder.worklet.ts. */
const RECORDER = 'lab-recorder';
const FFT_SIZE = 2048;
const HALF = FFT_SIZE / 2;
/** Analysis hop: 10 ms, rounded to whole samples at the context rate. */
const HOP_SEC = 0.01;
/** Band edges: each share is the energy in the bins strictly above the edge relative to all bins. */
const EDGES_HZ = [8000, 12000] as const;
/** Longest capture per phrase: the app's utterance cap. The capture ends there even if the button is held. */
const MAX_SEC = MAX_UTTERANCE_MS / 1000;
/** Shortest capture that is measured: every phrase takes well over a second to say, so a shorter hold is a slip. */
const MIN_SEC = 1;

/** One phrase's numbers: all the page keeps of a capture. */
interface PhraseResult {
  /** 1-based number of the phrase in SIBILANT_PHRASES. */
  readonly phrase: number;
  /**
   * Energy above 8 kHz and above 12 kHz relative to the total, in dB: −Infinity if the active frames carry no
   * energy at all above the edge, null if the band lies above Nyquist.
   */
  readonly above8kDb: number | null;
  readonly above12kDb: number | null;
}

interface Analysis {
  /** Full frames in the capture (no zero padding), and the active ones: energy above the median frame's. */
  readonly frames: number;
  readonly active: number;
  /**
   * Per edge in EDGES_HZ: 10·log10(energy above the edge / total energy), both summed over the active frames;
   * null if no bin lies above the edge. Meaningless when `active` is 0.
   */
  readonly shareDb: readonly (number | null)[];
  /** The same shares pooled over all frames, for the text log only (how much the median gate changes them). */
  readonly allFramesDb: readonly (number | null)[];
}

interface Summary {
  readonly n: number;
  readonly median: number;
  readonly p90: number;
  readonly max: number;
}

/** A phrase being captured: its worklet node and how much of the session's buffer it has filled. */
interface Capture {
  readonly node: AudioWorkletNode;
  filled: number;
  /** Index in SIBILANT_PHRASES of the phrase being spoken. */
  readonly phrase: number;
}

interface Session {
  readonly ctx: AudioContext;
  readonly source: MediaStreamAudioSourceNode;
  readonly analyze: (x: Float32Array) => Analysis;
  /**
   * The one capture buffer of the session (MAX_SEC at the context rate), reused by every phrase and zero-filled
   * as soon as a phrase has been analysed or discarded, and on close.
   */
  readonly buffer: Float32Array<ArrayBuffer>;
  capture: Capture | null;
}

/** What the results so far were measured with. */
interface Setup {
  readonly sampleRate: number;
  readonly device: string;
}

// ---- analysis -----------------------------------------------------------------------------------------------

/**
 * Linear-interpolation quantile (type 7) of the ascending, non-empty `sorted`, for 0 ≤ q ≤ 1. −Infinity values
 * (a share with no energy above the edge) sort lowest, and interpolating from one gives −Infinity.
 */
function quantile(sorted: ArrayLike<number>, q: number): number {
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const a = sorted[lo]!;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)]!;
  return h === lo || a === b || a === -Infinity ? a : a + (h - lo) * (b - a);
}

/**
 * The analysis at one context rate. analyze(x) cuts x into full periodic-Hann frames of FFT_SIZE samples every
 * round(10 ms · fs) samples (no zero padding), takes each frame's one-sided power spectrum with createRealFft,
 * keeps the active frames (energy above the median frame energy), and returns, per edge, the energy in the
 * bins strictly above the edge relative to the energy in all bins (DC to Nyquist), both summed over the active
 * frames, in dB (and, for the log, the same shares over all frames). It returns only these numbers, and it zeroes
 * its own scratch (the last frame's samples and spectrum) before returning.
 */
function createAnalysis(sampleRate: number): (x: Float32Array) => Analysis {
  const fft = createRealFft(FFT_SIZE);
  const hop = Math.round(HOP_SEC * sampleRate);
  const hann = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
  // Bin k is centred on k·fs/FFT_SIZE Hz: the first bin strictly above each edge (above HALF: an empty band).
  const firstBin = EDGES_HZ.map((hz) => Math.floor((hz * FFT_SIZE) / sampleRate) + 1);
  const frame = new Float32Array(FFT_SIZE);
  const re = new Float32Array(HALF + 1);
  const im = new Float32Array(HALF + 1);
  const power = new Float64Array(HALF + 1);

  return (x) => {
    const frames = x.length < FFT_SIZE ? 0 : Math.floor((x.length - FFT_SIZE) / hop) + 1;
    const total = new Float64Array(frames);
    const above = firstBin.map(() => new Float64Array(frames));
    for (let f = 0; f < frames; f++) {
      const start = f * hop;
      for (let i = 0; i < FFT_SIZE; i++) frame[i] = x[start + i]! * hann[i]!;
      fft.forward(frame, re, im);
      let sum = 0;
      for (let k = 0; k <= HALF; k++) {
        // Bins 1…HALF−1 stand for a conjugate pair, so `sum` is FFT_SIZE × the windowed frame's energy (Parseval).
        const p = (k === 0 || k === HALF ? 1 : 2) * (re[k]! * re[k]! + im[k]! * im[k]!);
        power[k] = p;
        sum += p;
      }
      total[f] = sum;
      for (let b = 0; b < firstBin.length; b++) {
        let a = 0;
        for (let k = firstBin[b]!; k <= HALF; k++) a += power[k]!;
        above[b]![f] = a;
      }
    }
    frame.fill(0);
    re.fill(0);
    im.fill(0);
    power.fill(0);

    let active = 0;
    let activeTotal = 0;
    let allTotal = 0;
    const activeAbove = new Float64Array(firstBin.length);
    const allAbove = new Float64Array(firstBin.length);
    if (frames > 0) {
      const median = quantile(total.toSorted(), 0.5);
      for (let f = 0; f < frames; f++) {
        const e = total[f]!;
        allTotal += e;
        for (let b = 0; b < firstBin.length; b++) allAbove[b] = allAbove[b]! + above[b]![f]!;
        if (!(e > median)) continue;
        active++;
        activeTotal += e;
        for (let b = 0; b < firstBin.length; b++) activeAbove[b] = activeAbove[b]! + above[b]![f]!;
      }
    }
    const shareDb = firstBin.map((k0, b) =>
      k0 > HALF ? null : 10 * Math.log10(activeAbove[b]! / activeTotal),
    );
    const allFramesDb = firstBin.map((k0, b) =>
      k0 > HALF ? null : 10 * Math.log10(allAbove[b]! / allTotal),
    );
    return { frames, active, shareDb, allFramesDb };
  };
}

/** Median, p90 and max of the values that aren't null (−Infinity counts as the lowest), or null if none. */
function summarize(values: readonly (number | null)[]): Summary | null {
  const v = values.filter((x): x is number => x !== null).toSorted((a, b) => a - b);
  if (v.length === 0) return null;
  return { n: v.length, median: quantile(v, 0.5), p90: quantile(v, 0.9), max: v[v.length - 1]! };
}

// ---- page ---------------------------------------------------------------------------------------------------

const root = document.getElementById('lab');
if (!(root instanceof HTMLElement)) throw new Error('lab/spectrum: missing #lab');

const openButton = el('button', { type: 'button' }, 'Open mic');
const closeButton = el('button', { type: 'button' }, 'Close');
const copyButton = el('button', { type: 'button' }, 'Copy results (JSON)');
const holdButton = el('button', { type: 'button' }, 'Hold to talk');
const promptHead = el('h2');
const promptText = el('strong');
const status = el('p', { 'aria-live': 'polite' }, 'Open the mic to start.');
const show = {
  rate: el('dd'),
  device: el('dd'),
  count: el('dd'),
  above8k: el('dd'),
  above12k: el('dd'),
};
const rows = el('tbody');

function row(term: string, value: HTMLElement): HTMLElement[] {
  return [el('dt', {}, term), value];
}

root.append(
  el('div', { class: 'lab-buttons' }, openButton, closeButton, copyButton),
  promptHead,
  el('p', {}, promptText),
  holdButton,
  status,
  el(
    'dl',
    { class: 'lab-values' },
    ...row('ctx.sampleRate', show.rate),
    ...row('Device', show.device),
    ...row('Phrases measured', show.count),
    ...row('Above 8 kHz', show.above8k),
    ...row('Above 12 kHz', show.above12k),
  ),
  el('h2', {}, 'Per phrase'),
  el(
    'table',
    {},
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', {}, '#'),
        el('th', {}, 'Phrase'),
        el('th', {}, '> 8 kHz'),
        el('th', {}, '> 12 kHz'),
      ),
    ),
    rows,
  ),
);
const log = logPanel(root);

// ---- state --------------------------------------------------------------------------------------------------

// As in the app (src/audio/engine.ts): the mic manager opens the mic with its CONSTRAINTS (plan §4.1.1).
const mic = createMicManager((c) => navigator.mediaDevices.getUserMedia(c));
let micReq = 0;
let session: Session | null = null;
/** Bumped by every open, close and pagehide: an open that finds it changed after an await was superseded. */
let generation = 0;
/** The sample rate and device of `results` (kept after Close, so the results stay copyable). */
let setup: Setup | null = null;
const results: PhraseResult[] = [];
/** Index in SIBILANT_PHRASES of the next phrase to say. */
let next = 0;

function say(text: string): void {
  status.textContent = text;
}

function db(v: number | null): string {
  return v === null ? 'n/a (above Nyquist)' : `${fmt(v, 1)} dB`;
}

function summaryText(s: Summary | null): string {
  if (s === null) return '—';
  return `median ${fmt(s.median, 1)} dB, p90 ${fmt(s.p90, 1)} dB, max ${fmt(s.max, 1)} dB (n = ${s.n})`;
}

function render(): void {
  holdButton.disabled = session === null;
  promptHead.textContent = `Phrase ${next + 1} of ${SIBILANT_PHRASES.length}`;
  promptText.textContent = SIBILANT_PHRASES[next] ?? '';
  show.rate.textContent = setup === null ? '—' : `${setup.sampleRate} Hz`;
  show.device.textContent = setup === null ? '—' : setup.device;
  show.count.textContent = String(results.length);
  show.above8k.textContent = summaryText(summarize(results.map((r) => r.above8kDb)));
  show.above12k.textContent = summaryText(summarize(results.map((r) => r.above12kDb)));
}

/** A dB value for the JSON: rounded to 0.01 dB; the string "-inf" for −Infinity; null for n/a. */
function round(v: number | null): number | string | null {
  if (v === -Infinity) return '-inf';
  return v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
}

function stats(s: Summary | null): Record<string, number | string | null> | null {
  return s === null ? null : { n: s.n, median: round(s.median), p90: round(s.p90), max: round(s.max) };
}

/** The numbers only (plan Q2): sample rate, device label, per-phrase shares and their session statistics. */
function resultsJson(): string {
  return JSON.stringify(
    {
      sampleRate: setup?.sampleRate ?? null,
      device: setup?.device ?? null,
      phrases: results.map((r) => ({
        phrase: r.phrase,
        above8kDb: round(r.above8kDb),
        above12kDb: round(r.above12kDb),
      })),
      summary: {
        above8kDb: stats(summarize(results.map((r) => r.above8kDb))),
        above12kDb: stats(summarize(results.map((r) => r.above12kDb))),
      },
    },
    null,
    2,
  );
}

// ---- session ------------------------------------------------------------------------------------------------

/** Invalidates an open in progress and stops every mic track (the mic manager's close). */
function cancelPending(): void {
  generation++;
  mic.close();
}

/** Releases the context of a superseded or failed open (close() or the failing open stopped the mic). */
function abandon(ctx: AudioContext | null, why: string): void {
  if (ctx !== null) ctx.close().catch((err: unknown) => log(`context close failed: ${String(err)}`));
  log(`open: ${why}; mic and context released`);
}

async function startContext(): Promise<AudioContext> {
  // As in the app (src/audio/engine.ts): no forced sampleRate, 'interactive' latency, created before the mic.
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  try {
    await ctx.resume();
  } catch (err) {
    // A context that never started still holds audio resources: close it before reporting the failure.
    ctx.close().catch((e: unknown) => log(`context close failed: ${String(e)}`));
    throw err;
  }
  log(`context created: state ${ctx.state}`);
  return ctx;
}

async function openMic(): Promise<void> {
  if (session !== null) close('re-open');
  else cancelPending();
  const gen = generation;
  log(`open: production constraints ${JSON.stringify(CONSTRAINTS)}`);
  let ctx: AudioContext | null = null;
  let stream: MediaStream;
  try {
    ctx = await startContext();
    if (gen !== generation) return abandon(ctx, 'superseded');
    const r = await mic.open(++micReq);
    if (r.t === 'stale' || gen !== generation) return abandon(ctx, 'superseded');
    if (r.t !== 'micGranted') return abandon(ctx, r.t);
    stream = r.stream;
    log('getUserMedia: granted');
    await ctx.audioWorklet.addModule(recorderUrl);
    if (gen !== generation) return abandon(ctx, 'superseded');
  } catch (err) {
    if (gen === generation) mic.close(); // no newer open owns the mic: stop the stream this open got
    return abandon(ctx, `failed: ${String(err)}`);
  }

  const c = ctx;
  const track = stream.getAudioTracks()[0];
  const device = track === undefined ? '(no audio track)' : track.label === '' ? '(no label)' : track.label;
  session = {
    ctx: c,
    source: c.createMediaStreamSource(stream),
    analyze: createAnalysis(c.sampleRate),
    buffer: new Float32Array(Math.round(MAX_SEC * c.sampleRate)),
    capture: null,
  };
  c.addEventListener('statechange', () => log(`context state: ${c.state}`));
  if (
    setup !== null &&
    results.length > 0 &&
    (setup.sampleRate !== c.sampleRate || setup.device !== device)
  ) {
    log(`results cleared: measured at ${setup.sampleRate} Hz on ${setup.device}`);
    results.length = 0;
    rows.replaceChildren();
    next = 0;
  }
  setup = { sampleRate: c.sampleRate, device };
  log(`sampleRate: ${c.sampleRate} Hz`);
  log(`device: ${device}`);
  log(`track.getSettings(): ${JSON.stringify(track?.getSettings() ?? null)}`);
  render();
  say(`Hold the button, say phrase ${next + 1}, then release.`);
  log('open: ready');
}

/** Stops the mic, discards a phrase being captured, and closes the context. The results stay. */
function close(reason: string): void {
  cancelPending(); // also cancels an open that is still awaiting the context, the prompt or the worklet
  const s = session;
  if (s === null) {
    log(`${reason}: no open session`);
    return;
  }
  session = null;
  const cut = stopRecorder(s);
  s.buffer.fill(0);
  s.source.disconnect();
  render();
  say('Mic closed. Open it again to go on.');
  log(`${reason}: mic stopped${cut === null ? '' : ', phrase in progress discarded'}`);
  s.ctx.close().then(
    () => log('context closed'),
    (err: unknown) => log(`context close failed: ${String(err)}`),
  );
}

// ---- capture ------------------------------------------------------------------------------------------------

/**
 * Ends the capture in progress, if any, and returns it: the worklet stops on 'stop', and blocks already in
 * flight are ignored. The caller analyses it or discards it, and zero-fills the session's buffer either way.
 */
function stopRecorder(s: Session): Capture | null {
  const capture = s.capture;
  if (capture === null) return null;
  s.capture = null;
  capture.node.port.postMessage('stop', []); // MessagePort: the second argument is the (empty) transfer list
  s.source.disconnect(capture.node);
  return capture;
}

function startPhrase(): void {
  const s = session;
  if (s === null) return say('Open the mic first.');
  if (s.capture !== null) return;
  const total = s.buffer.length;
  const node = new AudioWorkletNode(s.ctx, RECORDER, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  const capture: Capture = { node, filled: 0, phrase: next };
  node.port.addEventListener('message', (e: MessageEvent<unknown>) => {
    const block = e.data;
    if (!(block instanceof Float32Array)) return;
    const current = s.capture === capture;
    if (current) {
      const n = Math.min(block.length, total - capture.filled);
      s.buffer.set(block.subarray(0, n), capture.filled);
      capture.filled += n;
    }
    block.fill(0); // the transferred block is discarded at once
    if (current && capture.filled === total) finishPhrase(`${MAX_SEC} s cap`);
  });
  node.port.start(); // addEventListener, unlike the onmessage setter, doesn't start the port
  s.capture = capture;
  s.source.connect(node); // the output stays unconnected: Chrome still pulls a worklet node with an input
  say(`Recording phrase ${next + 1}: release the button when done.`);
  log(`phrase ${next + 1}: recording (at most ${MAX_SEC} s)`);
}

/**
 * Ends the capture, analyses it unless it is shorter than MIN_SEC, zero-fills the session's buffer, and records
 * the numbers if any frame was active.
 */
function finishPhrase(why: string): void {
  const s = session;
  if (s === null) return;
  const capture = stopRecorder(s);
  if (capture === null) return;
  const sec = capture.filled / s.ctx.sampleRate;
  let a: Analysis | null = null;
  try {
    if (sec >= MIN_SEC) a = s.analyze(s.buffer.subarray(0, capture.filled));
  } finally {
    s.buffer.fill(0); // discard the audio as soon as it is analysed (plan Q2)
  }
  const n = capture.phrase + 1;
  const head = `phrase ${n} (${why}): ${fmt(sec, 2)} s`;
  if (a === null || a.active === 0) {
    const reason =
      a === null ? `shorter than ${MIN_SEC} s` : 'no frame above the median (silent or perfectly steady)';
    say(`Phrase ${n} not measured (${reason}): hold the button for the whole phrase and say it again.`);
    log(`${head}, ${a === null ? reason : `0/${a.frames} frames active`}, nothing measured; audio discarded`);
    return;
  }
  const r: PhraseResult = { phrase: n, above8kDb: a.shareDb[0] ?? null, above12kDb: a.shareDb[1] ?? null };
  results.push(r);
  next = (capture.phrase + 1) % SIBILANT_PHRASES.length;
  rows.append(
    el(
      'tr',
      {},
      el('td', {}, String(results.length)),
      el('td', {}, `${n}. ${SIBILANT_PHRASES[capture.phrase] ?? ''}`),
      el('td', {}, db(r.above8kDb)),
      el('td', {}, db(r.above12kDb)),
    ),
  );
  render();
  const values = `above 8 kHz ${db(r.above8kDb)}, above 12 kHz ${db(r.above12kDb)}`;
  say(
    `Phrase ${n}: ${values}. Audio discarded.${results.length === SIBILANT_PHRASES.length ? ' All phrases done: copy the results.' : ''}`,
  );
  const all = `above 8 kHz ${db(a.allFramesDb[0] ?? null)}, above 12 kHz ${db(a.allFramesDb[1] ?? null)}`;
  log(`${head}, ${a.active}/${a.frames} frames active, ${values} (all frames: ${all}); audio discarded`);
}

/** Ends the capture without analysing it (an interrupted hold, a hidden page): zeroed at once, prompt kept. */
function discardPhrase(why: string): void {
  const s = session;
  if (s === null) return;
  const capture = stopRecorder(s);
  if (capture === null) return;
  s.buffer.fill(0);
  const n = capture.phrase + 1;
  say(`Phrase ${n} not measured (${why}): say it again.`);
  log(
    `phrase ${n} (${why}): ${fmt(capture.filled / s.ctx.sampleRate, 2)} s, nothing measured; audio discarded`,
  );
}

// ---- wiring -------------------------------------------------------------------------------------------------

function guard(what: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    log(`${what}: ${String(err)}`);
  }
}

/** The pointer that pressed the button, or null. A newer press replaces it, so a missed release can't stick. */
let holdPointer: number | null = null;

holdButton.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary || e.button !== 0) return;
  holdPointer = e.pointerId;
  guard('hold', startPhrase);
});
/**
 * The release is heard on the window, so lifting the finger or the mouse button off the button counts too. A
 * cancelled pointer (the browser took the gesture over) discards the phrase: it may have been cut short.
 */
function release(e: PointerEvent): void {
  if (e.pointerId !== holdPointer) return;
  holdPointer = null;
  if (e.type === 'pointerup') guard('release', () => finishPhrase('released'));
  else guard('cancel', () => discardPhrase('hold interrupted'));
}
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);
// A finger that drifts during the hold must not scroll the page: that would cancel the pointer.
holdButton.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
// A long press must neither open a menu nor start a text selection (either could cancel the pointer).
holdButton.addEventListener('contextmenu', (e) => e.preventDefault());
holdButton.addEventListener('selectstart', (e) => e.preventDefault());

openButton.addEventListener('click', () => {
  openMic().catch((err: unknown) => log(`open: ${String(err)}`));
});
closeButton.addEventListener('click', () => close('close'));
copyButton.addEventListener('click', () => {
  const text = resultsJson();
  // Through a promise, so a missing clipboard API (not a secure context) is logged too, never thrown.
  Promise.resolve()
    .then(() => navigator.clipboard.writeText(text))
    .then(
      () => log(`results copied (${results.length} phrases, ${text.length} characters)`),
      (err: unknown) => log(`copy failed: ${String(err)}`),
    );
});
mic.onTrackEvent((e) => {
  log(`mic track: ${e}`);
  if (e === 'endedExternally') close('mic track ended');
});
window.addEventListener('pagehide', () => close('pagehide'));
// A hidden page ends the hold unseen: discard the phrase, keep the session open.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') guard('hidden', () => discardPhrase('page hidden'));
});

render();
log(`lab/spectrum ready: ${navigator.userAgent}`);
if (!window.isSecureContext) {
  log('not a secure context: the mic needs https or http://localhost (docs/lab.md: adb reverse)');
}
