// Lab page for X-A3 (plan §5, §4.6.2): the mouth envelope (jaw, width, round and teeth) of spoken phrases after
// the app's voice chain, to check that vowels separate in width and round, and to decide whether the band edges
// should scale with the pitch ratio p. Dev-only: `pnpm dev`, then /lab/envelope.html (docs/lab.md).
//
// Capture: hold to talk. While the button is held (at most 5 s), the mic, opened through the app's mic manager
// with its CONSTRAINTS (all browser processing off) on a context created as the engine creates it, is recorded
// by the lab recorder worklet into the session's one in-memory buffer. On release the page high-passes the
// phrase in place at HPF_CLIP_HZ (80 Hz), as the app's capture worklet does before its ring; here the filter
// starts from rest for each phrase, while the app's runs continuously, so only roughly the first 20 ms differ.
// It then runs the app's processVoice with the selected voice, and computes the envelope of the processed buffer
// y twice: with the band edges × p (processVoice's own envelope, the app's behaviour) and with the fixed edges
// (analyzeEnvelope's scaleBandsWithP: false). Both are plotted.
//
// Vowel-dominant frames (the frames the table averages over): envelope frame i is centred on sample i·H of y
// (H = round(0.01·fs)). It is vowel-dominant when it is voiced (processVoice's voicing scorer, rate, window and
// threshold, on an 8 kHz copy of y, the window centred on the frame) and loud: its level over a 25 ms window
// centred on the frame is within VOWEL_RANGE_DB of the phrase's loudest frame. The level test doesn't use jaw,
// which is normalised per phrase and can be 0 throughout a steady sustained vowel.
//
// Privacy (plan Q2): only the numbers are kept. Where each buffer is released:
// 1. the session's capture buffer: zero-filled in processCapture's `finally` right after processing (even if
//    processing throws), in finishPhrase for a hold too short to process, in discardPhrase (an interrupted hold,
//    a missed release, a hidden page) and in close() (Close, re-open, pagehide, a mic track that ended);
// 2. every block delivered to the port listener: zero-filled at once after it is copied (or ignored); blocks
//    still queued when ctx.close() runs may never be delivered, and are dropped in memory only;
// 3. processVoice's output y, the 8 kHz voicing copy and the voicing window: zero-filled in analyzePhrase's
//    `finally`;
// 4. copies made inside library calls (processVoice's high-pass and trim copy, its resampler's padded input, its
//    voiced check's 8 kHz copy, resampleOffline's padded input): not reachable from here, dropped unzeroed
//    (memory only);
// 5. the latest phrase's two envelopes and its vowel mask (features, not audio) stay for the plot until the next
//    phrase is processed; the table keeps per-phrase means only.
// Nothing captured is stored or exported; Copy table and Copy log copy text only.

import {
  CUSTOM_PITCH_MAX,
  CUSTOM_PITCH_MIN,
  DEFAULT_SETTINGS,
  presetFor,
  type Settings,
} from '../src/app/settings.ts';
import { HPF_CLIP_HZ } from '../src/audio/constants.ts';
import { CONSTRAINTS, createMicManager } from '../src/audio/mic.ts';
import { butterworthHighpass } from '../src/dsp/biquad.ts';
import { analyzeEnvelope } from '../src/dsp/envelope.ts';
import { resampleOffline } from '../src/dsp/resample.ts';
import { PRESETS, type Envelope, type VoicePreset } from '../src/dsp/types.ts';
// VOICING_WINDOW here is processVoice's (256 samples at 8 kHz), not src/audio/constants.ts's (512 at 16 kHz).
import { processVoice, VOICING_FS, VOICING_WINDOW } from '../src/dsp/voice.ts';
import { createVoicing, VOICED_THRESHOLD } from '../src/dsp/voicing.ts';
import { el, fmt, logPanel } from './common.ts';
import recorderUrl from './recorder.worklet.ts?worker&url';

/** The processor name registered by lab/recorder.worklet.ts. */
const RECORDER = 'lab-recorder';
/** Longest capture per phrase: the capture ends there even if the button is still held. */
const MAX_SEC = 5;
/** Shortest capture that is processed: a shorter hold is a slip. */
const MIN_SEC = 0.5;
/** A vowel-dominant frame is voiced and its level is within this many dB of the phrase's loudest frame. */
const VOWEL_RANGE_DB = 15;
/** The level window of that test: 25 ms, the envelope's window length. */
const LEVEL_WIN_SEC = 0.025;
/** Added to the mean square before the logarithm, so a silent window gives −200 dB rather than −Infinity. */
const LEVEL_EPS = 1e-20;
/**
 * Suggested phrases (plan §5 X-A3: 10 phrases), each dominated by one vowel quality, and one that alternates
 * them. The phrase field starts with the first; after a tabled phrase it moves on to the next suggestion.
 */
const PHRASES = [
  'eeee (a long ee)',
  'oooo (a long oo)',
  'aaah (a long ah)',
  'See three green trees.',
  'Who knew two blue moons?',
  "Father's car is far.",
  'Oh no, go home, Joe.',
  'Ten red hens fled.',
  'Kim fills his big tin.',
  'Ee, oo, ah, ee, oo, ah.',
] as const;
const TRACKS = ['jaw', 'width', 'round', 'teeth'] as const;
type Track = (typeof TRACKS)[number];
/** Track colours (categorical slots 1–4 of the dataviz reference palette), per colour scheme. */
const COLORS: Readonly<Record<'light' | 'dark', Readonly<Record<Track, string>>>> = {
  light: { jaw: '#2a78d6', width: '#eb6834', round: '#1baf7a', teeth: '#eda100' },
  dark: { jaw: '#3987e5', width: '#d95926', round: '#199e70', teeth: '#c98500' },
};
/** Background of the vowel-dominant frames in the plot. */
const VOWEL_SHADE = 'rgba(128, 128, 128, 0.25)';
/** Plot margins in CSS px: the title and legend above, the y labels left, the time labels below. */
const MARGIN = { left: 34, right: 8, top: 46, bottom: 20 } as const;
/** Time-axis tick steps in seconds: the smallest that gives at most 8 intervals is used. */
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2] as const;
const VOICE_NAMES: Readonly<Record<Settings['voice'], string>> = {
  cub: 'Bear cub',
  chipmunk: 'Chipmunk',
  bigbear: 'Big bear',
  duck: 'Duckling',
  custom: 'Custom',
};
/** The table's columns, which Copy table copies too. */
const COLUMNS = [
  '#',
  'Phrase',
  'Voice (p)',
  'Vowel frames',
  'Jaw',
  'Width ×p',
  'Round ×p',
  'Width fixed',
  'Round fixed',
] as const;

/** Mean jaw, width and round over a phrase's vowel-dominant frames. */
interface Means {
  readonly jaw: number;
  readonly width: number;
  readonly round: number;
}

/** All the page keeps of a processed phrase: features and numbers, no audio. */
interface Analysis {
  /** The envelope with the band edges × p (processVoice's own), and with the fixed edges. */
  readonly on: Envelope;
  readonly off: Envelope;
  /** vowel[i] is 1 for a vowel-dominant frame, else 0. */
  readonly vowel: Uint8Array;
  readonly voicedFrames: number;
  readonly vowelFrames: number;
  /** The envelope hop in seconds (H / fs). */
  readonly hopSec: number;
  /** How long the processed phrase plays (processVoice's durationSec). */
  readonly playedSec: number;
  readonly clipped: boolean;
  /** Every frame's jaw is 0: the envelope's per-phrase normalisation left no level range (a steady phrase). */
  readonly jawSilent: boolean;
  /** Means over the vowel-dominant frames, or null if there are none. */
  readonly meansOn: Means | null;
  readonly meansOff: Means | null;
}

/** The phrase the plots show. */
interface Plotted {
  readonly label: string;
  readonly preset: VoicePreset;
  readonly a: Analysis;
}

/** One table row: per-phrase summary statistics only. */
interface Row {
  readonly n: number;
  readonly label: string;
  readonly preset: VoicePreset;
  readonly frames: number;
  readonly vowelFrames: number;
  readonly on: Means;
  readonly off: Means;
}

/** A phrase being captured: its worklet node, how much of the buffer it has filled, and its label and voice. */
interface Capture {
  readonly node: AudioWorkletNode;
  filled: number;
  readonly label: string;
  readonly preset: VoicePreset;
}

interface Session {
  readonly ctx: AudioContext;
  readonly source: MediaStreamAudioSourceNode;
  /**
   * The one capture buffer of the session (MAX_SEC at the context rate), reused by every phrase and zero-filled
   * as soon as a phrase has been processed or discarded, and on close.
   */
  readonly buffer: Float32Array<ArrayBuffer>;
  capture: Capture | null;
}

// ---- analysis -----------------------------------------------------------------------------------------------

/** Mean jaw, width and round of `env` over the frames with vowel[i] = 1, or null if there are none. */
function vowelMeans(env: Envelope, vowel: Uint8Array): Means | null {
  let n = 0;
  let jaw = 0;
  let width = 0;
  let round = 0;
  for (let i = 0; i < vowel.length; i++) {
    if (vowel[i] !== 1) continue;
    n++;
    jaw += env.jaw[i]!;
    width += env.width[i]!;
    round += env.round[i]!;
  }
  return n === 0 ? null : { jaw: jaw / n, width: width / n, round: round / n };
}

/**
 * The level of each envelope frame of y in dB: lv[i] = 10·log10(Σ y[k]² / win + LEVEL_EPS) over the `win`
 * samples k in [i·hop − floor(win/2), i·hop − floor(win/2) + win), where samples outside y count as 0. A level
 * track, not audio.
 */
function frameLevels(y: Float32Array, frames: number, hop: number, win: number): Float64Array {
  const lv = new Float64Array(frames);
  const half = Math.floor(win / 2);
  for (let i = 0; i < frames; i++) {
    const start = i * hop - half;
    const to = Math.min(y.length, start + win);
    let sum = 0;
    for (let k = Math.max(0, start); k < to; k++) sum += y[k]! * y[k]!;
    lv[i] = 10 * Math.log10(sum / win + LEVEL_EPS);
  }
  return lv;
}

/**
 * Processes one phrase: `clip` (the capture at fs) is high-passed in place at HPF_CLIP_HZ, as the app's capture
 * worklet does, and run through processVoice with `preset`; the processed buffer y gives the envelope with the
 * band edges × p (processVoice's own) and with the fixed edges, the vowel mask and the means. The caller
 * zero-fills `clip`; every audio copy made here (y, the 8 kHz copy, the voicing window) is zero-filled before
 * this returns or throws.
 */
function analyzePhrase(clip: Float32Array, fs: number, preset: VoicePreset): Analysis {
  butterworthHighpass(fs, HPF_CLIP_HZ).process(clip, clip);
  let y: Float32Array | null = null;
  let y8: Float32Array | null = null;
  const win = new Float32Array(VOICING_WINDOW);
  try {
    const r = processVoice(clip, fs, preset);
    const pcm = r.pcm;
    y = pcm;
    const on = r.envelope;
    const off = analyzeEnvelope(pcm, fs, preset.pitchRatio, { scaleBandsWithP: false });
    const frames = on.jaw.length;
    const hop = Math.round((on.hopMs / 1000) * fs); // analyzeEnvelope's hop H
    const lv = frameLevels(pcm, frames, hop, Math.round(LEVEL_WIN_SEC * fs));
    let maxLv = -Infinity;
    for (let i = 0; i < frames; i++) maxLv = Math.max(maxLv, lv[i]!);
    const copy8k = resampleOffline(pcm, VOICING_FS / fs);
    y8 = copy8k;
    const voicing = createVoicing(VOICING_FS);
    const half = VOICING_WINDOW / 2;
    const vowel = new Uint8Array(frames);
    let voicedFrames = 0;
    let vowelFrames = 0;
    let jawSilent = frames > 0;
    for (let i = 0; i < frames; i++) {
      // The voicing window: copy8k[from, from + VOICING_WINDOW), centred on frame i, zero outside the copy.
      const from = Math.round((i * hop * VOICING_FS) / fs) - half;
      const a = Math.max(0, from);
      const b = Math.min(copy8k.length, from + VOICING_WINDOW);
      win.fill(0);
      if (b > a) win.set(copy8k.subarray(a, b), a - from);
      const voiced = voicing.score(win) > VOICED_THRESHOLD;
      if (voiced) voicedFrames++;
      if (voiced && lv[i]! >= maxLv - VOWEL_RANGE_DB) {
        vowel[i] = 1;
        vowelFrames++;
      }
      if (on.jaw[i] !== 0) jawSilent = false;
    }
    return {
      on,
      off,
      vowel,
      voicedFrames,
      vowelFrames,
      hopSec: hop / fs,
      playedSec: r.durationSec,
      clipped: r.clipped,
      jawSilent,
      meansOn: vowelMeans(on, vowel),
      meansOff: vowelMeans(off, vowel),
    };
  } finally {
    y?.fill(0);
    y8?.fill(0);
    win.fill(0);
  }
}

// ---- page ---------------------------------------------------------------------------------------------------

const root = document.getElementById('lab');
if (!(root instanceof HTMLElement)) throw new Error('lab/envelope: missing #lab');

const openButton = el('button', { type: 'button' }, 'Open mic');
const closeButton = el('button', { type: 'button' }, 'Close');
const copyButton = el('button', { type: 'button' }, 'Copy table');
const holdButton = el('button', { type: 'button' }, 'Hold to talk');
const voiceSelect = el(
  'select',
  {},
  ...(['cub', 'chipmunk', 'bigbear', 'duck'] as const).map((v) =>
    el('option', { value: v }, `${VOICE_NAMES[v]} (p = ${PRESETS[v].pitchRatio})`),
  ),
  el('option', { value: 'custom' }, VOICE_NAMES.custom),
);
voiceSelect.value = DEFAULT_SETTINGS.voice;
const customInput = el('input', {
  type: 'number',
  min: String(CUSTOM_PITCH_MIN),
  max: String(CUSTOM_PITCH_MAX),
  step: '0.05',
  value: String(DEFAULT_SETTINGS.customPitch),
});
const phraseInput = el('input', { type: 'text', size: '32', value: PHRASES[0] });
const status = el('p', { 'aria-live': 'polite' }, 'Open the mic to start.');
const show = { rate: el('dd', {}, '—'), device: el('dd', {}, '—'), count: el('dd') };
const canvasOn = el('canvas', { class: 'lab-spectrum' });
const canvasOff = el('canvas', { class: 'lab-spectrum' });
const rows = el('tbody');

function row(term: string, value: HTMLElement): HTMLElement[] {
  return [el('dt', {}, term), value];
}

root.append(
  el('div', { class: 'lab-buttons' }, openButton, closeButton, copyButton),
  el(
    'fieldset',
    {},
    el('legend', {}, 'Voice and phrase'),
    el('p', {}, el('label', {}, 'Voice: ', voiceSelect), ' ', el('label', {}, 'Custom p: ', customInput)),
    el('p', {}, el('label', {}, 'Phrase: ', phraseInput)),
  ),
  holdButton,
  status,
  el(
    'dl',
    { class: 'lab-values' },
    ...row('ctx.sampleRate', show.rate),
    ...row('Device', show.device),
    ...row('Phrases in the table', show.count),
  ),
  el('h2', {}, 'Latest phrase'),
  el('h3', {}, 'Band edges × p (the app)'),
  canvasOn,
  el('h3', {}, 'Fixed edges (scaleBandsWithP: false)'),
  canvasOff,
  el('h2', {}, 'Per phrase'),
  el(
    'p',
    {},
    `Means over the vowel-dominant frames (voiced, and within ${VOWEL_RANGE_DB} dB of the phrase's loudest ` +
      'frame). Jaw is the same with both edge sets.',
  ),
  el('table', {}, el('thead', {}, el('tr', {}, ...COLUMNS.map((c) => el('th', {}, c)))), rows),
);
const log = logPanel(root);

// ---- state --------------------------------------------------------------------------------------------------

// As in the app (src/audio/engine.ts): the mic manager opens the mic with its CONSTRAINTS (plan §4.1.1).
const mic = createMicManager((c) => navigator.mediaDevices.getUserMedia(c));
let micReq = 0;
let session: Session | null = null;
/** Bumped by every open, close and pagehide: an open that finds it changed after an await was superseded. */
let generation = 0;
/** The table's rows (kept after Close: each row carries its voice). */
const table: Row[] = [];
/** The phrase the plots show, or null before the first one. */
let plotted: Plotted | null = null;
/** Index in PHRASES of the current suggestion. */
let next = 0;

function say(text: string): void {
  status.textContent = text;
}

function render(): void {
  holdButton.disabled = session === null;
  customInput.disabled = voiceSelect.value !== 'custom';
  show.count.textContent = String(table.length);
}

function isVoice(v: string): v is Settings['voice'] {
  return v === 'cub' || v === 'chipmunk' || v === 'bigbear' || v === 'duck' || v === 'custom';
}

/** The selected voice's preset (the app's presetFor), or null for a Custom p outside its range. */
function selectedPreset(): VoicePreset | null {
  const voice = voiceSelect.value;
  if (!isVoice(voice)) return null;
  if (voice !== 'custom') return presetFor({ ...DEFAULT_SETTINGS, voice });
  const customPitch = customInput.valueAsNumber;
  if (!(customPitch >= CUSTOM_PITCH_MIN && customPitch <= CUSTOM_PITCH_MAX)) return null;
  return presetFor({ ...DEFAULT_SETTINGS, voice, customPitch });
}

/** The phrase label: the field's text with whitespace runs collapsed (so the copied table stays well-formed). */
function phraseLabel(): string {
  return phraseInput.value.replace(/\s+/g, ' ').trim() || '(no label)';
}

function voiceText(preset: VoicePreset): string {
  return `${preset.id} (${preset.pitchRatio})`;
}

function rowCells(r: Row): string[] {
  return [
    String(r.n),
    r.label,
    voiceText(r.preset),
    `${r.vowelFrames}/${r.frames}`,
    fmt(r.on.jaw, 3),
    fmt(r.on.width, 3),
    fmt(r.on.round, 3),
    fmt(r.off.width, 3),
    fmt(r.off.round, 3),
  ];
}

/** The table as tab-separated text (header and rows), for pasting into a spreadsheet. */
function tableText(): string {
  return [[...COLUMNS], ...table.map(rowCells)].map((cells) => `${cells.join('\t')}\n`).join('');
}

// ---- plot ---------------------------------------------------------------------------------------------------

function trackColors(): Readonly<Record<Track, string>> {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? COLORS.dark : COLORS.light;
}

/**
 * Draws one envelope of the latest phrase on `canvas`, sized to its CSS box × devicePixelRatio: the phrase
 * label, voice and `title`, a legend, the vowel-dominant frames shaded, a 0–1 grid, the playback time axis,
 * and the four tracks as 2 px lines.
 */
function drawPlot(canvas: HTMLCanvasElement, which: 'on' | 'off', title: string): void {
  const g = canvas.getContext('2d');
  if (g === null) return;
  const dpr = window.devicePixelRatio;
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  const w = canvas.width;
  const h = canvas.height;
  const ink = getComputedStyle(canvas).color;
  g.clearRect(0, 0, w, h);
  g.font = `${12 * dpr}px sans-serif`;
  g.textAlign = 'left';
  g.fillStyle = ink;
  const p = plotted;
  if (p === null) {
    g.fillText(`${title}: hold to talk to plot a phrase.`, 4 * dpr, 16 * dpr);
    return;
  }
  const env = which === 'on' ? p.a.on : p.a.off;
  const frames = env.jaw.length;
  const hopSec = p.a.hopSec;
  const dur = Math.max(frames * hopSec, 0.1);
  const x0 = MARGIN.left * dpr;
  const x1 = w - MARGIN.right * dpr;
  const y0 = MARGIN.top * dpr;
  const y1 = h - MARGIN.bottom * dpr;
  const xOf = (t: number): number => x0 + (t / dur) * (x1 - x0);
  const yOf = (v: number): number => y1 - v * (y1 - y0);
  const colors = trackColors();

  // Title and legend (text in ink; the swatches carry the colours).
  g.fillText(`"${p.label}" · ${p.preset.id} p = ${p.preset.pitchRatio} · ${title}`, 4 * dpr, 14 * dpr);
  const box = 10 * dpr;
  const ly = 32 * dpr;
  let lx = 4 * dpr;
  const legend: [string, string][] = [
    ...TRACKS.map((t): [string, string] => [colors[t], t]),
    [VOWEL_SHADE, 'vowel-dominant frames'],
  ];
  for (const [color, name] of legend) {
    g.fillStyle = color;
    g.fillRect(lx, ly - box, box, box);
    lx += box + 4 * dpr;
    g.fillStyle = ink;
    g.fillText(name, lx, ly);
    lx += g.measureText(name).width + 12 * dpr;
  }

  // The vowel-dominant frames, shaded as runs.
  g.fillStyle = VOWEL_SHADE;
  const vowel = p.a.vowel;
  for (let i = 0; i < frames; i++) {
    if (vowel[i] !== 1) continue;
    let j = i;
    while (j + 1 < frames && vowel[j + 1] === 1) j++;
    const a = Math.max(x0, xOf((i - 0.5) * hopSec));
    const b = Math.min(x1, xOf((j + 0.5) * hopSec));
    g.fillRect(a, y0, b - a, y1 - y0);
    i = j;
  }

  // Grid at 0, 0.5 and 1, and the axis labels.
  g.strokeStyle = ink;
  g.lineWidth = dpr;
  g.globalAlpha = 0.3;
  g.beginPath();
  for (const v of [0, 0.5, 1]) {
    g.moveTo(x0, yOf(v));
    g.lineTo(x1, yOf(v));
  }
  g.stroke();
  g.globalAlpha = 1;
  g.fillStyle = ink;
  g.textAlign = 'right';
  for (const v of [0, 0.5, 1]) g.fillText(String(v), x0 - 4 * dpr, yOf(v) + 4 * dpr);
  const step = TICK_STEPS.find((s) => dur / s <= 8) ?? 2;
  g.textAlign = 'center';
  for (let k = 0; k * step <= dur + 1e-9; k++) {
    g.fillText(`${Math.round(k * step * 100) / 100} s`, xOf(k * step), h - 5 * dpr);
  }
  g.textAlign = 'left';

  // The four tracks.
  g.lineWidth = 2 * dpr;
  g.lineJoin = 'round';
  for (const t of TRACKS) {
    const track = env[t];
    g.strokeStyle = colors[t];
    g.beginPath();
    for (let i = 0; i < frames; i++) {
      const x = xOf(i * hopSec);
      const y = yOf(track[i]!);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
}

function drawPlots(): void {
  drawPlot(canvasOn, 'on', 'band edges × p (the app)');
  drawPlot(canvasOff, 'off', 'fixed edges (scaleBandsWithP: false)');
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
    buffer: new Float32Array(Math.round(MAX_SEC * c.sampleRate)),
    capture: null,
  };
  c.addEventListener('statechange', () => log(`context state: ${c.state}`));
  show.rate.textContent = `${c.sampleRate} Hz`;
  show.device.textContent = device;
  log(`sampleRate: ${c.sampleRate} Hz`);
  log(`device: ${device}`);
  log(`track.getSettings(): ${JSON.stringify(track?.getSettings() ?? null)}`);
  render();
  say('Hold the button, say the phrase, then release.');
  log('open: ready');
}

/** Stops the mic, discards a phrase being captured, and closes the context. The table and the plot stay. */
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
 * flight are ignored. The caller processes it or discards it, and zero-fills the session's buffer either way.
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
  const preset = selectedPreset();
  if (preset === null) {
    return say(`Custom p must be ${CUSTOM_PITCH_MIN}–${CUSTOM_PITCH_MAX}: correct it, then hold again.`);
  }
  const label = phraseLabel();
  const total = s.buffer.length;
  const node = new AudioWorkletNode(s.ctx, RECORDER, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  const capture: Capture = { node, filled: 0, label, preset };
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
    if (current && capture.filled === total) guard('cap', () => finishPhrase(`${MAX_SEC} s cap`));
  });
  node.port.start(); // addEventListener, unlike the onmessage setter, doesn't start the port
  s.capture = capture;
  s.source.connect(node); // the output stays unconnected: Chrome still pulls a worklet node with an input
  say(`Recording "${label}" (${voiceText(preset)}): release the button when done.`);
  log(`phrase "${label}": recording, ${preset.id} p = ${preset.pitchRatio} (at most ${MAX_SEC} s)`);
}

/** Processes the captured span of the session's buffer, which is zero-filled right after, even on a throw. */
function processCapture(s: Session, capture: Capture): Analysis {
  try {
    return analyzePhrase(s.buffer.subarray(0, capture.filled), s.ctx.sampleRate, capture.preset);
  } finally {
    s.buffer.fill(0); // discard the audio as soon as it is processed (plan Q2)
  }
}

/**
 * Ends the capture and, unless it is shorter than MIN_SEC, processes it (the buffer is zero-filled either way),
 * plots it, and adds a table row if it has a vowel-dominant frame.
 */
function finishPhrase(why: string): void {
  const s = session;
  if (s === null) return;
  const capture = stopRecorder(s);
  if (capture === null) return;
  const sec = capture.filled / s.ctx.sampleRate;
  const head = `phrase "${capture.label}" (${why}): ${fmt(sec, 2)} s captured`;
  if (sec < MIN_SEC) {
    s.buffer.fill(0);
    say(`Not processed (shorter than ${MIN_SEC} s): hold the button for the whole phrase.`);
    log(`${head}, shorter than ${MIN_SEC} s, not processed; audio discarded`);
    return;
  }
  const t0 = performance.now();
  const a = processCapture(s, capture);
  const ms = performance.now() - t0;
  plotted = { label: capture.label, preset: capture.preset, a };
  drawPlots();
  const detail =
    `${capture.preset.id} p = ${capture.preset.pitchRatio}, processed in ${fmt(ms, 0)} ms: ` +
    `${fmt(a.playedSec, 2)} s played, ${a.on.jaw.length} frames, clipped ${a.clipped}, ` +
    `${a.voicedFrames} voiced, ${a.vowelFrames} vowel-dominant` +
    (a.jawSilent ? ', jaw never above 0 (steady-level phrase)' : '');
  if (a.meansOn === null || a.meansOff === null) {
    say(`"${capture.label}" plotted, but it has no vowel-dominant frame, so no row: say it again.`);
    log(`${head}; ${detail}; no table row; audio discarded`);
    return;
  }
  const r: Row = {
    n: table.length + 1,
    label: capture.label,
    preset: capture.preset,
    frames: a.on.jaw.length,
    vowelFrames: a.vowelFrames,
    on: a.meansOn,
    off: a.meansOff,
  };
  table.push(r);
  rows.append(el('tr', {}, ...rowCells(r).map((cell) => el('td', {}, cell))));
  // Move on to the next suggestion only if this phrase was the current one: a typed label stays for a repeat.
  if (capture.label === PHRASES[next]) {
    next = (next + 1) % PHRASES.length;
    phraseInput.value = PHRASES[next] ?? '';
  }
  render();
  say(`Row ${r.n}: "${r.label}" plotted, ${r.vowelFrames} vowel-dominant frames. Audio discarded.`);
  log(
    `${head}; ${detail}; row ${r.n}: jaw ${fmt(r.on.jaw, 3)}, width/round with edges × p ` +
      `${fmt(r.on.width, 3)}/${fmt(r.on.round, 3)}, fixed ${fmt(r.off.width, 3)}/${fmt(r.off.round, 3)}; ` +
      'audio discarded',
  );
}

/** Ends the capture without processing it (an interrupted hold, a hidden page): zeroed at once. */
function discardPhrase(why: string): void {
  const s = session;
  if (s === null) return;
  const capture = stopRecorder(s);
  if (capture === null) return;
  s.buffer.fill(0);
  say(`"${capture.label}" not processed (${why}): say it again.`);
  log(
    `phrase "${capture.label}" (${why}): ${fmt(capture.filled / s.ctx.sampleRate, 2)} s, not processed; ` +
      'audio discarded',
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

/**
 * The pointer that pressed the button, or null. A newer press replaces it and discards the capture whose release
 * was missed, so nothing gets stuck and no stale capture is processed.
 */
let holdPointer: number | null = null;

holdButton.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary || e.button !== 0) return;
  holdPointer = e.pointerId;
  guard('hold', () => {
    // A capture still running at a new press lost its release: discard it, then start the new phrase.
    if (session !== null && session.capture !== null) discardPhrase('missed release');
    startPhrase();
  });
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
  const text = tableText();
  // Through a promise, so a missing clipboard API (not a secure context) is logged too, never thrown.
  Promise.resolve()
    .then(() => navigator.clipboard.writeText(text))
    .then(
      () => log(`table copied (${table.length} rows, ${text.length} characters)`),
      (err: unknown) => log(`copy failed: ${String(err)}`),
    );
});
voiceSelect.addEventListener('change', () => {
  render();
  log(`voice: ${voiceSelect.value}`);
});
customInput.addEventListener('change', () => log(`custom p: ${customInput.value}`));
mic.onTrackEvent((e) => {
  log(`mic track: ${e}`);
  if (e === 'endedExternally') close('mic track ended');
});
window.addEventListener('pagehide', () => close('pagehide'));
// A hidden page ends the hold unseen: discard the phrase, keep the session open.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') guard('hidden', () => discardPhrase('page hidden'));
});
// The plots follow the canvas size and the colour scheme.
window.addEventListener('resize', () => guard('redraw', drawPlots));
window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', () => guard('redraw', drawPlots));

render();
drawPlots();
log(`lab/envelope ready: ${navigator.userAgent}`);
if (!window.isSecureContext) {
  log('not a secure context: the mic needs https or http://localhost (docs/lab.md: adb reverse)');
}
