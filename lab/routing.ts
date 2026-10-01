// Lab page for X-E1 and X-E2 (plan §5): output routing and the volume stream while the mic is open, and the
// input preset's residual processing, seen as a live spectrum. Dev-only: `pnpm dev`, then /lab/routing.html
// (docs/lab.md). Privacy (plan Q2): the 3 s recording lives only in memory, is played back in place, and is
// zeroed and dropped on Close and on pagehide. Nothing captured is stored or exported; the log is text only.

import { el, fmt, logPanel } from './common.ts';
import recorderUrl from './recorder.worklet.ts?worker&url';

/** The processor name registered by lab/recorder.worklet.ts. */
const RECORDER = 'lab-recorder';
const RECORD_SEC = 3;
const FFT_SIZE = 8192;
const SMOOTHING = 0.8;
/** ~15 fps; 1 ms of slack so a 60 Hz display draws every 4th frame. */
const DRAW_MS = 1000 / 15 - 1;
/** How often the energy share is appended to the log while the mic is open. */
const SHARE_LOG_MS = 1000;
const F_MIN_HZ = 50;
const SPLIT_HZ = 8000;
const MARKERS_HZ = [4000, 8000, 16000] as const;
/** Spectrum y range (dB, as reported by `getFloatFrequencyData`). */
const DB_TOP = 0;
const DB_BOTTOM = -140;
const TONE_HZ = 1000;
const TONE_SEC = 1;
const TONE_DBFS = -12;
/** Raised-cosine fade at each end of the tone, so it starts and stops without a click. */
const TONE_FADE_SEC = 0.005;
const MARKER_COLOR = '#d0443e';
const AXIS_COLOR = '#888888';
const SPECTRUM_COLOR = '#2f7ed8';
const AXIS_LOW = `${F_MIN_HZ} Hz`;
const DB_TOP_LABEL = `${DB_TOP} dB`;
const DB_BOTTOM_LABEL = `${DB_BOTTOM} dB`;

type Order = 'before' | 'after';

/** Canvas geometry and per-bin lookups, computed once per open so a drawn frame allocates nothing else. */
interface Plot {
  readonly width: number;
  readonly height: number;
  readonly fontPx: number;
  /** First bin at or above 50 Hz, and first bin at or above 8 kHz. */
  readonly kStart: number;
  readonly kSplit: number;
  /** Canvas column of each bin (log-frequency axis from 50 Hz to Nyquist). */
  readonly column: Int32Array<ArrayBuffer>;
  readonly markers: readonly { readonly x: number; readonly label: string }[];
  readonly nyquistLabel: string;
}

interface Session {
  readonly ctx: AudioContext;
  readonly stream: MediaStream;
  readonly source: MediaStreamAudioSourceNode;
  readonly analyser: AnalyserNode;
  readonly plot: Plot;
  /** `getFloatFrequencyData` output, reused every drawn frame. */
  readonly bins: Float32Array<ArrayBuffer>;
  /** The loudest bin (dB) per canvas column, reused every drawn frame. */
  readonly columns: Float32Array<ArrayBuffer>;
  readonly players: Set<AudioBufferSourceNode>;
  recorder: AudioWorkletNode | null;
  /** The finished in-memory recording (3 s at the context rate), or null. */
  recording: Float32Array<ArrayBuffer> | null;
  raf: number;
  lastDraw: number;
  lastShareLog: number;
  /** The displayed energy share, rounded to 0.1 dB (NaN: no signal), and its text. */
  shareTenths: number;
  shareText: string;
}

// ---- page ---------------------------------------------------------------------------------------------------

const root = document.getElementById('lab');
if (!(root instanceof HTMLElement)) throw new Error('lab/routing: missing #lab');

const ecBox = el('input', { type: 'checkbox' });
const beforeRadio = el('input', { type: 'radio', name: 'ctx-order', value: 'before', checked: '' });
const afterRadio = el('input', { type: 'radio', name: 'ctx-order', value: 'after' });
const openButton = el('button', { type: 'button' }, 'Open mic');
const recordButton = el('button', { type: 'button' }, 'Record 3 s');
const playButton = el('button', { type: 'button' }, 'Play recording');
const toneButton = el('button', { type: 'button' }, 'Play 1 kHz tone (1 s, −12 dBFS)');
const closeButton = el('button', { type: 'button' }, 'Close');

const show = {
  rate: el('dd'),
  base: el('dd'),
  output: el('dd'),
  settings: el('dd'),
  inputs: el('ol'),
  outputs: el('ol'),
  share: el('dd'),
};
const canvas = el('canvas', { class: 'lab-spectrum' });
const maybeG = canvas.getContext('2d');
if (maybeG === null) throw new Error('lab/routing: no 2D canvas context');
const g = maybeG;

function row(term: string, value: HTMLElement): HTMLElement[] {
  return [el('dt', {}, term), value.tagName === 'DD' ? value : el('dd', {}, value)];
}

root.append(
  el(
    'fieldset',
    {},
    el('legend', {}, 'Settings (apply on the next Open mic)'),
    el(
      'label',
      {},
      ecBox,
      ' EC: echoCancellation, noiseSuppression and autoGainControl all on (off when unchecked)',
    ),
    el(
      'p',
      {},
      'Context: ',
      el('label', {}, beforeRadio, ' before'),
      ' ',
      el('label', {}, afterRadio, ' after'),
      ' getUserMedia',
    ),
  ),
  el('div', { class: 'lab-buttons' }, openButton, recordButton, playButton, toneButton, closeButton),
  el(
    'dl',
    { class: 'lab-values' },
    ...row('ctx.sampleRate', show.rate),
    ...row('ctx.baseLatency', show.base),
    ...row('ctx.outputLatency', show.output),
    ...row('track.getSettings()', show.settings),
    ...row('Audio inputs', show.inputs),
    ...row('Audio outputs', show.outputs),
    ...row('Energy above 8 kHz vs below', show.share),
  ),
  el('h2', {}, 'Input spectrum'),
  canvas,
);
const log = logPanel(root);

// ---- session ------------------------------------------------------------------------------------------------

let session: Session | null = null;
/** Bumped by every open, close and pagehide: an open that finds it changed after an await was superseded. */
let generation = 0;

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** Releases what a superseded or failed open acquired. */
function abandon(ctx: AudioContext | null, stream: MediaStream | null, why: string): void {
  if (stream !== null) stopTracks(stream);
  if (ctx !== null) ctx.close().catch((err: unknown) => log(`context close failed: ${String(err)}`));
  log(`open: ${why}; mic and context released`);
}

async function startContext(): Promise<AudioContext> {
  // As in the app (src/audio/engine.ts): no forced sampleRate, 'interactive' latency.
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  log(`context created: state ${ctx.state}`);
  return ctx;
}

function setList(list: HTMLOListElement, labels: readonly string[]): void {
  list.replaceChildren(...(labels.length === 0 ? ['(none)'] : labels).map((l) => el('li', {}, l)));
}

async function refreshDevices(): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const kind of ['audioinput', 'audiooutput'] as const) {
    const labels = devices
      .filter((d) => d.kind === kind)
      .map((d) => (d.label === '' ? '(no label)' : d.label));
    setList(kind === 'audioinput' ? show.inputs : show.outputs, labels);
    if (labels.length === 0) log(`${kind}: (none)`);
    labels.forEach((label, i) => log(`${kind}[${i}]: ${label}`));
  }
}

function refreshContext(ctx: AudioContext): void {
  show.rate.textContent = `${ctx.sampleRate} Hz`;
  show.base.textContent = `${fmt(ctx.baseLatency * 1000, 1)} ms`;
  show.output.textContent = `${fmt(ctx.outputLatency * 1000, 1)} ms`;
  log(`sampleRate: ${ctx.sampleRate} Hz`);
  log(`baseLatency: ${fmt(ctx.baseLatency, 4)} s`);
  log(`outputLatency: ${fmt(ctx.outputLatency, 4)} s`);
}

function refreshTrack(track: MediaStreamTrack | undefined): void {
  if (track === undefined) {
    show.settings.textContent = '(no audio track)';
    log('track: none');
    return;
  }
  for (const type of ['mute', 'unmute', 'ended'] as const) {
    track.addEventListener(type, () => log(`track ${type}`));
  }
  show.settings.textContent = JSON.stringify(track.getSettings());
  log(`track.label: ${track.label}`);
  log(`track.getSettings(): ${show.settings.textContent}`);
}

/** Sizes the canvas to its CSS box and precomputes the log-frequency axis for `sampleRate`. */
function makePlot(sampleRate: number, binCount: number): Plot {
  const dpr = window.devicePixelRatio;
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  const { width, height } = canvas;
  const nyquist = sampleRate / 2;
  const binHz = sampleRate / FFT_SIZE;
  const xOf = (hz: number): number => (width * Math.log(hz / F_MIN_HZ)) / Math.log(nyquist / F_MIN_HZ);
  const column = new Int32Array(binCount);
  for (let k = 0; k < binCount; k++) column[k] = Math.min(width - 1, Math.max(0, Math.floor(xOf(k * binHz))));
  const fontPx = 12 * dpr;
  // Resizing the canvas reset its 2D state; these stay for every frame of the session.
  g.font = `${fontPx}px sans-serif`;
  g.lineWidth = dpr;
  return {
    width,
    height,
    fontPx,
    kStart: Math.ceil(F_MIN_HZ / binHz),
    kSplit: Math.ceil(SPLIT_HZ / binHz),
    column,
    markers: MARKERS_HZ.filter((hz) => hz < nyquist).map((hz) => ({
      x: Math.round(xOf(hz)) + 0.5,
      label: `${hz / 1000} kHz`,
    })),
    nyquistLabel: `${fmt(nyquist / 1000, 2)} kHz`,
  };
}

async function openMic(): Promise<void> {
  if (session !== null) close('re-open');
  const gen = ++generation;
  const ec = ecBox.checked;
  const order: Order = beforeRadio.checked ? 'before' : 'after';
  const audio = { echoCancellation: ec, noiseSuppression: ec, autoGainControl: ec };
  log(`open: EC ${ec ? 'on' : 'off'}, context ${order} getUserMedia, constraints ${JSON.stringify(audio)}`);
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  try {
    if (order === 'before') ctx = await startContext();
    if (gen !== generation) return abandon(ctx, stream, 'superseded');
    stream = await navigator.mediaDevices.getUserMedia({ audio });
    if (gen !== generation) return abandon(ctx, stream, 'superseded');
    log('getUserMedia: granted');
    if (order === 'after') ctx = await startContext();
    if (gen !== generation || ctx === null) return abandon(ctx, stream, 'superseded');
    await ctx.audioWorklet.addModule(recorderUrl);
    if (gen !== generation) return abandon(ctx, stream, 'superseded');
  } catch (err) {
    return abandon(ctx, stream, `failed: ${String(err)}`);
  }

  const c = ctx;
  const source = c.createMediaStreamSource(stream);
  const analyser = new AnalyserNode(c, { fftSize: FFT_SIZE, smoothingTimeConstant: SMOOTHING });
  source.connect(analyser);
  const plot = makePlot(c.sampleRate, analyser.frequencyBinCount);
  const s: Session = {
    ctx: c,
    stream,
    source,
    analyser,
    plot,
    bins: new Float32Array(analyser.frequencyBinCount),
    columns: new Float32Array(plot.width),
    players: new Set(),
    recorder: null,
    recording: null,
    raf: 0,
    lastDraw: -Infinity,
    lastShareLog: -Infinity,
    shareTenths: Number.NEGATIVE_INFINITY,
    shareText: '',
  };
  session = s;
  c.addEventListener('statechange', () => log(`context state: ${c.state}`));
  refreshContext(c);
  refreshTrack(stream.getAudioTracks()[0]);
  s.raf = requestAnimationFrame(frame);
  try {
    await refreshDevices();
  } catch (err) {
    log(`enumerateDevices failed: ${String(err)}`);
  }
  if (gen === generation) log('open: ready');
}

/** Stops the mic, playback and recording, zeroes and drops the recording, and closes the context. */
function close(reason: string): void {
  generation++; // also cancels an open that is still awaiting the prompt, the context or the worklet
  const s = session;
  if (s === null) {
    log(`${reason}: no open session`);
    return;
  }
  session = null;
  cancelAnimationFrame(s.raf);
  stopRecorder(s);
  for (const player of s.players) {
    player.stop();
    player.disconnect();
    player.buffer?.getChannelData(0).fill(0); // the playback copy (of the recording, or of the tone)
  }
  s.players.clear();
  s.recording?.fill(0);
  s.recording = null;
  s.source.disconnect();
  stopTracks(s.stream);
  log(`${reason}: mic stopped, recording discarded`);
  s.ctx.close().then(
    () => log('context closed'),
    (err: unknown) => log(`context close failed: ${String(err)}`),
  );
}

// ---- recording ----------------------------------------------------------------------------------------------

/** Ends a recording in progress: the worklet stops on 'stop', and blocks already in flight are ignored. */
function stopRecorder(s: Session): void {
  const node = s.recorder;
  if (node === null) return;
  s.recorder = null;
  node.port.postMessage('stop', []); // MessagePort: the second argument is the (empty) transfer list
  s.source.disconnect(node);
}

function levels(x: Float32Array): { peakDb: number; rmsDb: number } {
  let peak = 0;
  let sum = 0;
  for (const v of x) {
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  return { peakDb: 20 * Math.log10(peak), rmsDb: 10 * Math.log10(sum / x.length) };
}

function record(): void {
  const s = session;
  if (s === null) return log('record: open the mic first');
  if (s.recorder !== null) return log('record: already recording');
  s.recording?.fill(0);
  s.recording = null;
  const total = Math.round(RECORD_SEC * s.ctx.sampleRate);
  const buffer = new Float32Array(total);
  let filled = 0;
  const node = new AudioWorkletNode(s.ctx, RECORDER, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  node.port.addEventListener('message', (e: MessageEvent<unknown>) => {
    const block = e.data;
    if (!(block instanceof Float32Array) || s.recorder !== node) return;
    const n = Math.min(block.length, total - filled);
    buffer.set(block.subarray(0, n), filled);
    filled += n;
    if (filled < total) return;
    stopRecorder(s);
    s.recording = buffer;
    const { peakDb, rmsDb } = levels(buffer);
    log(
      `record: done, ${total} frames (${fmt(total / s.ctx.sampleRate, 3)} s), peak ${fmt(peakDb, 1)} dBFS, rms ${fmt(rmsDb, 1)} dBFS`,
    );
  });
  node.port.start(); // addEventListener, unlike the onmessage setter, doesn't start the port
  s.recorder = node;
  s.source.connect(node); // the output stays unconnected: Chrome still pulls a worklet node with an input
  log(`record: started, ${total} frames`);
}

// ---- playback -----------------------------------------------------------------------------------------------

function play(s: Session, data: Float32Array<ArrayBuffer>, what: string): void {
  const buffer = s.ctx.createBuffer(1, data.length, s.ctx.sampleRate);
  buffer.copyToChannel(data, 0);
  const player = new AudioBufferSourceNode(s.ctx, { buffer });
  player.connect(s.ctx.destination);
  player.addEventListener('ended', () => {
    s.players.delete(player);
    player.disconnect();
    buffer.getChannelData(0).fill(0); // the playback copy (of the recording, or of the tone)
    log(`${what}: ended`);
  });
  s.players.add(player);
  player.start();
  log(`${what}: playing ${fmt(buffer.duration, 3)} s, outputLatency ${fmt(s.ctx.outputLatency, 4)} s`);
}

function playRecording(): void {
  const s = session;
  if (s === null) return log('play recording: open the mic first');
  if (s.recording === null) return log('play recording: nothing recorded');
  play(s, s.recording, 'play recording');
}

/** 1 s of 1 kHz sine at −12 dBFS peak, with raised-cosine ends. */
function tone(sampleRate: number): Float32Array<ArrayBuffer> {
  const n = Math.round(TONE_SEC * sampleRate);
  const fade = Math.round(TONE_FADE_SEC * sampleRate);
  const amp = 10 ** (TONE_DBFS / 20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const edge = Math.min(i, n - 1 - i);
    const gain = edge < fade ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade) : 1;
    out[i] = amp * gain * Math.sin((2 * Math.PI * TONE_HZ * i) / sampleRate);
  }
  return out;
}

function playTone(): void {
  const s = session;
  if (s === null) return log('tone: open the mic first');
  const data = tone(s.ctx.sampleRate);
  log(
    `tone: ${TONE_HZ} Hz, ${fmt(data.length / s.ctx.sampleRate, 3)} s, peak ${fmt(levels(data).peakDb, 1)} dBFS`,
  );
  play(s, data, 'tone');
}

// ---- spectrum -----------------------------------------------------------------------------------------------

function frame(now: number): void {
  const s = session;
  if (s === null) return;
  s.raf = requestAnimationFrame(frame);
  if (now - s.lastDraw < DRAW_MS) return;
  s.lastDraw = now;
  const tenths = Math.round(10 * draw(s));
  if (!Object.is(tenths, s.shareTenths)) {
    // Only a changed value allocates its text.
    s.shareTenths = tenths;
    s.shareText = Number.isNaN(tenths) ? 'no signal' : `${fmt(tenths / 10, 1)} dB`;
    show.share.textContent = s.shareText;
  }
  if (now - s.lastShareLog >= SHARE_LOG_MS) {
    s.lastShareLog = now;
    log(`energy above 8 kHz vs below: ${s.shareText}`);
  }
}

/**
 * Draws the analyser's spectrum on the log-frequency axis (50 Hz to Nyquist, markers at 4, 8 and 16 kHz) and
 * returns the energy above 8 kHz relative to 50 Hz–8 kHz in dB (NaN when there is no signal). Allocates nothing.
 */
function draw(s: Session): number {
  const { analyser, bins, columns, plot } = s;
  const { width, height, column } = plot;
  analyser.getFloatFrequencyData(bins);
  columns.fill(-Infinity);
  let below = 0;
  let above = 0;
  for (let k = plot.kStart; k < bins.length; k++) {
    const db = bins[k]!;
    const power = 10 ** (db / 10);
    if (k < plot.kSplit) below += power;
    else above += power;
    const x = column[k]!;
    if (db > columns[x]!) columns[x] = db;
  }

  g.clearRect(0, 0, width, height);
  g.strokeStyle = MARKER_COLOR;
  g.fillStyle = MARKER_COLOR;
  for (let i = 0; i < plot.markers.length; i++) {
    const { x, label } = plot.markers[i]!;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, height);
    g.stroke();
    g.fillText(label, x + 3, plot.fontPx);
  }
  g.fillStyle = AXIS_COLOR;
  g.fillText(DB_TOP_LABEL, 3, plot.fontPx);
  g.fillText(DB_BOTTOM_LABEL, 3, height - 4 - 1.5 * plot.fontPx);
  g.fillText(AXIS_LOW, 3, height - 4);
  g.textAlign = 'right';
  g.fillText(plot.nyquistLabel, width - 3, height - 4);
  g.textAlign = 'left';
  g.strokeStyle = SPECTRUM_COLOR;
  g.beginPath();
  let started = false;
  for (let x = 0; x < width; x++) {
    const db = columns[x]!;
    if (db === -Infinity) continue;
    const y = (height * (DB_TOP - Math.min(DB_TOP, Math.max(DB_BOTTOM, db)))) / (DB_TOP - DB_BOTTOM);
    if (started) g.lineTo(x, y);
    else g.moveTo(x, y);
    started = true;
  }
  g.stroke();

  if (below === 0 && above === 0) return Number.NaN;
  return 10 * Math.log10(above / below);
}

// ---- wiring -------------------------------------------------------------------------------------------------

function action(button: HTMLButtonElement, run: () => Promise<void> | void): void {
  button.addEventListener('click', () => {
    Promise.resolve()
      .then(run)
      .catch((err: unknown) => log(`${button.textContent}: ${String(err)}`));
  });
}

action(openButton, openMic);
action(recordButton, record);
action(playButton, playRecording);
action(toneButton, playTone);
action(closeButton, () => close('close'));
window.addEventListener('pagehide', () => close('pagehide'));
log(`lab/routing ready: ${navigator.userAgent}`);
if (window.isSecureContext) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (session === null) return;
    log('devicechange');
    refreshDevices().catch((err: unknown) => log(`enumerateDevices failed: ${String(err)}`));
  });
} else {
  log('not a secure context: the mic needs https or http://localhost (docs/lab.md: adb reverse)');
}
