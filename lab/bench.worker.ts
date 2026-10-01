// Lab worker for lab/bench (plan §5 X-V2 and X-F3, §4.10). lab/bench.ts starts one worker per benchmark run
// and terminates it after the result, so no run inherits another's JIT, heap or wasm state:
//   silero-ts    the Silero TS port (src/dsp/silero/model.ts, shipped weights.bin), timed per 512-sample frame;
//   silero-ort   onnxruntime-web (wasm, 1 thread) on the pinned ONNX file, same input, for comparison;
//   worklet-dsp  the capture worklet's per-quantum DSP (mono copy, 80 Hz high-pass, 12 s ring, 16 kHz
//                decimator, and its armed output path: 512-sample frames posted with transfer) at 48 or
//                44.1 kHz, timed in batches of 100 quanta: the worklet itself has no `performance` (plan §4.10);
//   voice-chain  the voice effect (src/dsp/voice.ts processVoice) on 1, 5 and 10 s clips at 48 or 44.1 kHz for
//                the cub, chipmunk and bigbear presets, 30 timed calls each, then each of its voiceStages
//                functions timed on its own input in batches (plan §5 X-F3; budget §4.10: p95 ≤ 15 ms per s).
// The input is synthetic, generated here: alternating 2 s of pink noise at −40 dBFS RMS and 2 s of a synthetic
// vowel, made as scripts/gen-fixtures.ts makes them; voice-chain clips are 400 ms vowel bursts, each followed
// by 100 ms of that pink noise (20 % noise). Nothing is captured, stored or exported (plan Q2).
//
// Type-checked by tsconfig.app.json (its `lab` include: DOM lib, no WebWorker lib), so this file uses only
// what a DedicatedWorkerGlobalScope shares with Window: self.postMessage(message, options), self.addEventListener
// ('message'), self.crossOriginIsolated, fetch, performance and setTimeout.

import type { InferenceSession, Tensor } from 'onnxruntime-web/wasm';
import { HPF_CLIP_HZ, RING_SECONDS, VAD_FRAME, VAD_RATE } from '../src/audio/constants.ts';
import type { WorkletToWorker } from '../src/audio/messages.ts';
import { butterworthHighpass } from '../src/dsp/biquad.ts';
import { createResampler } from '../src/dsp/resample.ts';
import { RingBuffer } from '../src/dsp/ring-buffer.ts';
import { SILERO_CONTEXT, SILERO_FRAME, createSilero } from '../src/dsp/silero/model.ts';
import { decodeWeights } from '../src/dsp/silero/weights.ts';
import weightsUrl from '../src/dsp/silero/weights.bin?url';
import { PRESETS, type Envelope, type VoicePreset } from '../src/dsp/types.ts';
import { processVoice, voiceStages, type VoiceResult } from '../src/dsp/voice.ts';

// ---- protocol (lab/bench.ts imports these types) ----------------------------------------------------------

export type BenchName = 'silero-ts' | 'silero-ort' | 'worklet-dsp' | 'voice-chain';

/** One benchmark run; the worker answers with info and progress messages, then one result, unavailable or error. */
export interface BenchRequest {
  readonly bench: BenchName;
  /** Seconds of synthetic input: 60 or 600. voice-chain ignores it: its clips are always 1, 5 and 10 s. */
  readonly seconds: number;
  /** worklet-dsp and voice-chain: the context rate, 48000 or 44100 Hz. */
  readonly rate: number;
  /**
   * Feed the input in real time (one frame per 32 ms, one batch per 100 quanta) instead of back to back.
   * voice-chain ignores it and always runs back to back.
   */
  readonly realtime: boolean;
  /** FrameStats.overPct counts frames slower than this (ms): the X-V2 gate's threshold, set by lab/bench.ts. */
  readonly overMs: number;
}

/** silero-ts and silero-ort: per-frame `process` time over every frame. */
export interface FrameStats {
  readonly kind: 'frame';
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** The first frame's time: it includes JIT warm-up (and, for ORT, the wasm runtime's lazy start). */
  readonly firstMs: number;
  /** Share of frames whose time is above BenchRequest.overMs, in %. */
  readonly overPct: number;
  /** Mean speech probability over the run: the same input must give about the same value in TS and ORT. */
  readonly meanP: number;
  readonly wallS: number;
}

/** worklet-dsp: µs per quantum as batch means, one value per batch of 100 quanta (the batch time / 100). */
export interface QuantumStats {
  readonly kind: 'quantum';
  readonly batches: number;
  readonly quantaPerBatch: number;
  readonly rate: number;
  readonly p50Us: number;
  readonly p99Us: number;
  readonly maxUs: number;
  /** The first batch's mean: it includes JIT warm-up. */
  readonly firstUs: number;
  readonly wallS: number;
}

/** The voiceStages functions of src/dsp/voice.ts (processVoice is exactly their composition). */
export type VoiceStageName = keyof typeof voiceStages;

/** voice-chain, one stage on one clip and preset: ms per call as batch means, one value per timed batch. */
export interface StageStats {
  readonly stage: VoiceStageName;
  /** Calls per timed batch: doubled from 1 until a batch lasts at least max(2 ms, 20 timer steps), ≤ 1024. */
  readonly batch: number;
  /** Timed batches (each a mean over `batch` calls). */
  readonly batches: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  /** Checked once after timing: one more call of the timed batch gives processVoice's own result for the stage. */
  readonly matches: boolean;
}

/** voice-chain, one clip length and preset: processVoice timed per call, then each stage. */
export interface VoiceRow {
  /** The clip's length in seconds of audio (1, 5 or 10): ms per second of audio is ms / clipS. */
  readonly clipS: number;
  readonly preset: VoicePreset['id'];
  readonly pitchRatio: number;
  /** Samples in and out of processVoice (the output plays at rate 1). */
  readonly inSamples: number;
  readonly outSamples: number;
  /** Timed processVoice calls (after one untimed warm-up call). */
  readonly calls: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  /** The timed calls' times in ms, ascending (p50, p95 and max are read from it). */
  readonly sortedMs: readonly number[];
  /** The warm-up call before the timed ones, not in the percentiles: the first per clip and preset. */
  readonly warmupMs: number;
  /** The stage inputs (voiceStages composed as processVoice composes them) reproduce processVoice's output. */
  readonly composed: boolean;
  /** One entry per voiceStages function, in chain order. */
  readonly stages: readonly StageStats[];
}

/** voice-chain: one row per clip length (1, 5, 10 s) and preset (cub, chipmunk, bigbear), in that order. */
export interface VoiceStats {
  readonly kind: 'voice';
  readonly rate: number;
  readonly rows: readonly VoiceRow[];
  readonly wallS: number;
}

export type BenchReply =
  | { readonly t: 'info'; readonly bench: BenchName; readonly line: string }
  | { readonly t: 'progress'; readonly bench: BenchName; readonly done: number; readonly total: number }
  | {
      readonly t: 'result';
      readonly bench: BenchName;
      readonly stats: FrameStats | QuantumStats | VoiceStats;
    }
  | { readonly t: 'unavailable'; readonly bench: BenchName; readonly message: string }
  | { readonly t: 'error'; readonly bench: BenchName; readonly message: string };

// ---- constants --------------------------------------------------------------------------------------------

/** Render quantum size, as in src/audio/capture.worklet.ts. */
const QUANTUM = 128;
/** worklet-dsp times this many quanta per performance.now() pair (the timer is 5–100 µs coarse). */
const BATCH = 100;
/** Progress messages per run. */
const PROGRESS_STEPS = 10;
/** worklet-dsp, back to back: yield to the event loop every this many batches (outside the timed region), so the
 *  frame sink drains the posted frames. */
const DRAIN_BATCHES = 10;
/** Where `pnpm silero:fetch` (scripts/fetch-silero-onnx.ts) caches the pinned ONNX file; `pnpm dev` serves it. */
const ONNX_URL = '/.cache/silero/silero_vad_16k_op15.onnx';
/** The ONNX model's recurrent state: [2 (h, c), batch 1, 128], as in scripts/silero-parity.ts. */
const STATE_DIMS: readonly number[] = [2, 1, 128];

// Synthetic input (scripts/gen-fixtures.ts recipes, at the benchmark's rate).
const SEED = 43;
const SEGMENT_S = 2;
const NOISE_DBFS = -40;
const VOWEL_F0 = 140;
const VOWEL_PEAK_DBFS = -12;
const FADE_S = 0.02;
/** Formants (Hz) and bandwidths (Hz) of the synthetic vowel: F1 700/80, F2 1220/90, F3 2600/120. */
const FORMANTS: readonly (readonly [number, number])[] = [
  [700, 80],
  [1220, 90],
  [2600, 120],
];

// voice-chain (plan §5 X-F3).
/** Clip lengths in seconds of audio, timed processVoice calls per clip and preset, and the presets, in order. */
const VOICE_CLIPS_S: readonly number[] = [1, 5, 10];
const VOICE_CALLS = 30;
/** Untimed processVoice rounds (each preset once) on the 1 s clip before the first row, so it isn't JIT-cold. */
const VOICE_PREWARM_ROUNDS = 10;
const VOICE_PRESETS: readonly VoicePreset[] = [PRESETS.cub, PRESETS.chipmunk, PRESETS.bigbear];
/** A clip is 500 ms units of a 400 ms vowel burst then 100 ms of pink noise: 20 % of it is noise. */
const BURST_S = 0.4;
const NOISE_GAP_S = 0.1;
/** A timed stage batch lasts at least this long, and at least STAGE_BATCH_STEPS timer steps (≤ 5 % each). */
const STAGE_BATCH_MIN_MS = 2;
const STAGE_BATCH_STEPS = 20;
/** The largest stage batch, in calls. */
const STAGE_BATCH_MAX = 1024;
/** The voiceStages functions in processVoice's order (voiceStages lists them in that order). */
const STAGE_ORDER: readonly VoiceStageName[] = Object.keys(voiceStages).filter((k): k is VoiceStageName =>
  Object.hasOwn(voiceStages, k),
);

// ---- synthetic input ----------------------------------------------------------------------------------------

/** Seeded 32-bit PRNG (mulberry32, as test/dsp-helpers.ts): uniform values in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n samples of pink noise (Paul Kellet's refined filter on white noise from rng), scaled to `db` dBFS RMS. */
function pinkNoise(rng: () => number, n: number, db: number): Float64Array {
  const x = new Float64Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const w = 2 * rng() - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    x[i] = v;
    sumSq += v * v;
  }
  const gain = 10 ** (db / 20) / Math.sqrt(sumSq / n);
  for (let i = 0; i < n; i++) x[i] = x[i]! * gain;
  return x;
}

/** One 2nd-order Klatt resonator at `rate`, in place: y = A·x + B·y1 + C·y2 (unity gain at DC). */
function resonate(x: Float64Array, rate: number, freq: number, bandwidth: number): void {
  const c = -Math.exp((-2 * Math.PI * bandwidth) / rate);
  const b = 2 * Math.exp((-Math.PI * bandwidth) / rate) * Math.cos((2 * Math.PI * freq) / rate);
  const a = 1 - b - c;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = a * x[i]! + b * y1 + c * y2;
    x[i] = v;
    y2 = y1;
    y1 = v;
  }
}

/**
 * n samples of a synthetic vowel at `rate`: an impulse train at f0 (±1 % period jitter) through the three
 * FORMANTS resonators, times a 4 Hz syllabic envelope and 20 ms raised-cosine fades, peak-normalised.
 */
function vowel(rng: () => number, rate: number, n: number): Float64Array {
  const x = new Float64Array(n);
  for (let pos = 0; Math.round(pos) < n; pos += (rate / VOWEL_F0) * (1 + 0.01 * (2 * rng() - 1))) {
    x[Math.round(pos)] = 1;
  }
  for (const [freq, bandwidth] of FORMANTS) resonate(x, rate, freq, bandwidth);
  const fade = Math.round(FADE_S * rate);
  const fadeGain = (i: number): number => 0.5 * (1 - Math.cos((Math.PI * i) / fade));
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let gain = 0.5 * (1 - Math.cos((2 * Math.PI * 4 * i) / rate));
    if (i < fade) gain *= fadeGain(i);
    if (i >= n - fade) gain *= fadeGain(n - 1 - i);
    const v = x[i]! * gain;
    x[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  const g = 10 ** (VOWEL_PEAK_DBFS / 20) / peak;
  for (let i = 0; i < n; i++) x[i] = x[i]! * g;
  return x;
}

/** One 4 s cycle at `rate`: 2 s of pink noise at −40 dBFS RMS, then 2 s of the vowel. The input repeats it. */
function synthCycle(rate: number): Float32Array {
  const rng = mulberry32(SEED);
  const n = Math.round(SEGMENT_S * rate);
  const cycle = new Float32Array(2 * n);
  cycle.set(pinkNoise(rng, n, NOISE_DBFS), 0);
  cycle.set(vowel(rng, rate, n), n);
  return cycle;
}

/**
 * A voice-chain clip of `seconds` (a multiple of 0.5) at `rate`: 500 ms units, each a 400 ms vowel burst (the
 * vowel above: 4 Hz syllabic envelope, 20 ms fades, peak −12 dBFS) then 100 ms of pink noise at −40 dBFS RMS,
 * so 20 % of the clip is noise. Seeded: the same arguments always give the same clip.
 */
function speechClip(rate: number, seconds: number): Float32Array {
  const rng = mulberry32(SEED);
  const n = Math.round(seconds * rate);
  const burst = Math.round(BURST_S * rate);
  const gap = Math.round(NOISE_GAP_S * rate);
  const clip = new Float32Array(n);
  for (let pos = 0; pos < n;) {
    const b = Math.min(burst, n - pos);
    clip.set(vowel(rng, rate, b), pos);
    pos += b;
    const g = Math.min(gap, n - pos);
    if (g > 0) clip.set(pinkNoise(rng, g, NOISE_DBFS), pos);
    pos += g;
  }
  return clip;
}

/** A source that fills each buffer it is given with the next samples of `cycle`, wrapping; never allocates. */
function cyclicSource(cycle: Float32Array): (out: Float32Array) => void {
  let pos = 0;
  return (out) => {
    for (let i = 0; i < out.length; i++) {
      out[i] = cycle[pos]!;
      pos = pos + 1 === cycle.length ? 0 : pos + 1;
    }
  };
}

// ---- timing helpers -----------------------------------------------------------------------------------------

function post(msg: BenchReply): void {
  // { transfer: [] } fits both Window.postMessage (the type checked here) and DedicatedWorkerGlobalScope's.
  self.postMessage(msg, { transfer: [] });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Nearest-rank percentile of ascending `sorted` (n ≥ 1): the smallest value with ≥ p % of the values at or below it. */
function percentile(sorted: Float64Array, p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

/** The smallest step performance.now() takes here, in µs (Chrome: 100 µs, or 5 µs when cross-origin isolated). */
function timerStepUs(): number {
  let step = Infinity;
  for (let k = 0; k < 20; k++) {
    const a = performance.now();
    let b = a;
    while (b === a) b = performance.now();
    step = Math.min(step, b - a);
  }
  return step * 1000;
}

/** Resolves once performance.now() reaches `t` (ms); at once if it already has. */
function sleepUntil(t: number): Promise<void> {
  const ms = t - performance.now();
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** A frame model: the TS port returns p synchronously, ORT asynchronously. */
type FrameProcess = (frame16k: Float32Array) => number | Promise<number>;

/**
 * Times `process` on every 512-sample frame of `seconds` of the synthetic 16 kHz input, with performance.now()
 * right around the call (the input is copied into the frame before t0). Back to back, or one frame per 32 ms
 * when `realtime`.
 */
async function timeFrames(req: BenchRequest, process: FrameProcess): Promise<FrameStats> {
  const total = Math.floor((req.seconds * VAD_RATE) / SILERO_FRAME);
  const times = new Float64Array(total);
  const frame = new Float32Array(SILERO_FRAME);
  const next = cyclicSource(synthCycle(VAD_RATE));
  const periodMs = (SILERO_FRAME / VAD_RATE) * 1000;
  const every = Math.ceil(total / PROGRESS_STEPS);
  let sumP = 0;
  let over = 0;
  const start = performance.now();
  for (let i = 0; i < total; i++) {
    if (req.realtime) await sleepUntil(start + i * periodMs);
    next(frame);
    const t0 = performance.now();
    const r = process(frame);
    const p = typeof r === 'number' ? r : await r;
    const dt = performance.now() - t0;
    times[i] = dt;
    if (dt > req.overMs) over++;
    sumP += p;
    if ((i + 1) % every === 0 || i + 1 === total)
      post({ t: 'progress', bench: req.bench, done: i + 1, total });
  }
  const wallS = (performance.now() - start) / 1000;
  const firstMs = times[0]!;
  times.sort();
  return {
    kind: 'frame',
    count: total,
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    p99Ms: percentile(times, 99),
    maxMs: times[total - 1]!,
    firstMs,
    overPct: (100 * over) / total,
    meanP: sumP / total,
    wallS,
  };
}

// ---- benchmarks ---------------------------------------------------------------------------------------------

async function fetchBytes(url: string, hint: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  const type = res.headers.get('content-type') ?? '';
  // A missing file must not be read as the dev server's HTML page.
  if (!res.ok || type.includes('text/html')) {
    throw new Error(`GET ${url}: HTTP ${res.status}${type === '' ? '' : ` (${type})`}${hint}`);
  }
  return res.arrayBuffer();
}

async function sileroTs(req: BenchRequest): Promise<FrameStats> {
  const bytes = await fetchBytes(weightsUrl, '');
  const model = createSilero(decodeWeights(bytes));
  post({ t: 'info', bench: req.bench, line: `weights.bin: ${bytes.byteLength} bytes` });
  return timeFrames(req, (frame) => model.process(frame));
}

/**
 * The ONNX model in onnxruntime-web (wasm, 1 thread), fed per frame as scripts/silero-parity.ts does: `input`
 * [1, 576] = the 64-sample context + the frame, `state` [2, 1, 128], and `sr` = 16000 if the model has it.
 * Throws if anything fails to load.
 */
async function loadOrt(req: BenchRequest): Promise<(frame16k: Float32Array) => Promise<number>> {
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.numThreads = 1;
  const onnx = await fetchBytes(ONNX_URL, '; run `pnpm silero:fetch` first');
  const session: InferenceSession = await ort.InferenceSession.create(new Uint8Array(onnx), {
    executionProviders: ['wasm'],
  });
  for (const name of ['input', 'state']) {
    if (!session.inputNames.includes(name)) throw new Error(`ONNX model has no input "${name}"`);
  }
  for (const name of ['output', 'stateN']) {
    if (!session.outputNames.includes(name)) throw new Error(`ONNX model has no output "${name}"`);
  }
  post({
    t: 'info',
    bench: req.bench,
    line: `onnxruntime-web ${ort.env.versions.web ?? '?'}: wasm, numThreads ${ort.env.wasm.numThreads ?? '?'}; ONNX ${onnx.byteLength} bytes`,
  });
  const hasSr = session.inputNames.includes('sr');
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(VAD_RATE)]), []);
  let state: Tensor = new ort.Tensor('float32', new Float32Array(2 * 128), [...STATE_DIMS]);
  const context = new Float32Array(SILERO_CONTEXT);
  return async (frame) => {
    const input = new Float32Array(SILERO_CONTEXT + SILERO_FRAME);
    input.set(context, 0);
    input.set(frame, SILERO_CONTEXT);
    const feeds: Record<string, Tensor> = {
      input: new ort.Tensor('float32', input, [1, input.length]),
      state,
    };
    if (hasSr) feeds['sr'] = sr;
    const out = await session.run(feeds);
    const p = out['output'];
    const next = out['stateN'];
    if (p === undefined || next === undefined) throw new Error('ORT returned no output or stateN');
    if (!(p.data instanceof Float32Array)) throw new Error(`ORT output is ${p.type}, expected float32`);
    state = next;
    context.set(frame.subarray(SILERO_FRAME - SILERO_CONTEXT));
    return p.data[0]!;
  };
}

async function sileroOrt(req: BenchRequest): Promise<FrameStats | null> {
  let process: (frame16k: Float32Array) => Promise<number>;
  try {
    process = await loadOrt(req);
  } catch (err) {
    post({ t: 'unavailable', bench: req.bench, message: errorMessage(err) });
    return null;
  }
  return timeFrames(req, process);
}

/**
 * The capture worklet's per-quantum DSP (src/audio/capture.worklet.ts: constructor and process() steps 2, 3
 * and 5) on `seconds` of the synthetic input at `rate`: mono copy, butterworthHighpass.process, RingBuffer.write
 * and resampler.processInto, then its #decimate output loop on the armed path, its worst case, armed from the
 * first quantum: per decimated sample its position, the frame fill and the output counter; per full frame
 * #postFrame (postMessage with the frame's buffer transferred, to a MessageChannel whose other end drains and
 * drops it, then a new Float32Array(VAD_FRAME)). Each batch of 100 quanta is timed as a whole (its input is
 * copied in before t0).
 */
async function workletDsp(req: BenchRequest): Promise<QuantumStats> {
  const rate = req.rate;
  const hpf = butterworthHighpass(rate, HPF_CLIP_HZ);
  const ring = new RingBuffer(Math.ceil(RING_SECONDS * rate));
  const dec = createResampler(rate, VAD_RATE);
  const mono = new Float32Array(QUANTUM);
  const hp = new Float32Array(QUANTUM);
  const decOut = new Float32Array(Math.ceil(QUANTUM * dec.ratio) + 2);
  const batchIn = new Float32Array(QUANTUM * BATCH);
  const inputs: Float32Array[] = [];
  for (let q = 0; q < BATCH; q++) inputs.push(batchIn.subarray(q * QUANTUM, (q + 1) * QUANTUM));
  const next = cyclicSource(synthCycle(rate));
  const total = Math.floor((req.seconds * rate) / (QUANTUM * BATCH));
  const usPerQuantum = new Float64Array(total);
  const periodMs = ((QUANTUM * BATCH) / rate) * 1000;
  const every = Math.ceil(total / PROGRESS_STEPS);
  // #decimate / #postFrame state, as the worklet's fields (armed at the first quantum: armFrame = streamBase).
  const sink = new MessageChannel();
  // Drains and drops the posted frames (addEventListener, unlike the onmessage setter, needs start()).
  sink.port2.addEventListener('message', () => {});
  sink.port2.start();
  const port = sink.port1;
  const ratio = dec.ratio;
  const streamBase = 0;
  const armed = true;
  const armFrame = streamBase;
  const epoch = 1;
  let outIndex = 0;
  let fill = 0;
  let framePos = 0;
  let frame16k = new Float32Array(VAD_FRAME);
  const frameMsg: WorkletToWorker = { t: 'frame', epoch, firstFrame: 0, pcm16k: frame16k };
  const transfer: ArrayBuffer[] = [frame16k.buffer];
  let posted = 0;
  let frame = 0;
  const start = performance.now();
  for (let b = 0; b < total; b++) {
    if (req.realtime) await sleepUntil(start + b * periodMs);
    next(batchIn);
    const t0 = performance.now();
    for (let q = 0; q < BATCH; q++) {
      const ch = inputs[q]!;
      for (let i = 0; i < QUANTUM; i++) mono[i] = ch[i] ?? 0;
      hpf.process(mono, hp);
      ring.write(hp, frame);
      const n = dec.processInto(hp, decOut);
      for (let j = 0; j < n; j++) {
        const pos = streamBase + outIndex / ratio;
        if (armed && pos >= armFrame) {
          if (fill === 0) framePos = pos;
          frame16k[fill++] = decOut[j]!;
          if (fill === VAD_FRAME) {
            fill = 0;
            frameMsg.epoch = epoch;
            frameMsg.firstFrame = Math.round(framePos);
            frameMsg.pcm16k = frame16k;
            transfer[0] = frame16k.buffer;
            port.postMessage(frameMsg, transfer);
            frame16k = new Float32Array(VAD_FRAME); // as #postFrame: replaces the transferred frame
            posted++;
          }
        }
        outIndex++;
      }
      frame += QUANTUM;
    }
    usPerQuantum[b] = ((performance.now() - t0) * 1000) / BATCH;
    if ((b + 1) % every === 0 || b + 1 === total)
      post({ t: 'progress', bench: req.bench, done: b + 1, total });
    if (!req.realtime && (b + 1) % DRAIN_BATCHES === 0) await sleepUntil(performance.now() + 1);
  }
  sink.port1.close();
  const wallS = (performance.now() - start) / 1000;
  post({
    t: 'info',
    bench: req.bench,
    line:
      `${frame} frames at ${rate} Hz → ${outIndex} samples at ${VAD_RATE} Hz; armed path: ${posted} frames of ` +
      `${VAD_FRAME} posted with transfer; ring ${ring.capacity} frames`,
  });
  const firstUs = usPerQuantum[0]!;
  usPerQuantum.sort();
  return {
    kind: 'quantum',
    batches: total,
    quantaPerBatch: BATCH,
    rate,
    p50Us: percentile(usPerQuantum, 50),
    p99Us: percentile(usPerQuantum, 99),
    maxUs: usPerQuantum[total - 1]!,
    firstUs,
    wallS,
  };
}

/** Calls `call` `b` times back to back and returns the elapsed ms: one performance.now() pair for the batch. */
function timeCalls(b: number, call: () => unknown): number {
  const t0 = performance.now();
  for (let k = 0; k < b; k++) call();
  return performance.now() - t0;
}

/** Whether a and b hold the same samples. */
function sameSamples(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The inputs of each voiceStages function for one clip `pcm` at `rate` and pitch ratio `p`: processVoice's
 * intermediate buffers, made by composing voiceStages exactly as processVoice does (x = hpfTrim(pcm, rate);
 * y = resample(x, p); voiced = isVoiced(y, rate); applyGain(y, rate, voiced); fades(y, rate)), with a copy of
 * y kept before each in-place stage. `faded` is the buffer processVoice returns (and envelope's input).
 */
interface StageInputs {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly voiced: boolean;
  readonly gained: Float32Array;
  readonly faded: Float32Array;
}

function stageInputs(pcm: Float32Array, rate: number, p: number): StageInputs {
  const x = voiceStages.hpfTrim(pcm, rate);
  const y = voiceStages.resample(x, p);
  const voiced = voiceStages.isVoiced(y, rate);
  const gained = y.slice();
  voiceStages.applyGain(gained, rate, voiced);
  const faded = gained.slice();
  voiceStages.fades(faded, rate);
  return { x, y, voiced, gained, faded };
}

/** The result of the latest timed call of each pure stage, kept so checkStages can compare it. */
interface StageResults {
  clipped: boolean;
  x: Float32Array;
  y: Float32Array;
  voiced: boolean;
  envelope: Envelope | null;
}

/**
 * Per voiceStages function, a batch: `(b) => ms` runs the stage b times on its input from `inp` and returns
 * the elapsed ms; each pure stage's latest result goes to `last`. The in-place stages (applyGain, fades) first
 * restore `work` from their input, outside the timed region; the calls of one batch then repeat on that copy,
 * which costs the same each time, since their loops don't depend on the sample values.
 */
function stageBatches(
  pcm: Float32Array,
  rate: number,
  p: number,
  inp: StageInputs,
  work: Float32Array,
  last: StageResults,
): Readonly<Record<VoiceStageName, (b: number) => number>> {
  return {
    clipDetect: (b) =>
      timeCalls(b, () => {
        last.clipped = voiceStages.clipDetect(pcm);
      }),
    hpfTrim: (b) =>
      timeCalls(b, () => {
        last.x = voiceStages.hpfTrim(pcm, rate);
      }),
    resample: (b) =>
      timeCalls(b, () => {
        last.y = voiceStages.resample(inp.x, p);
      }),
    isVoiced: (b) =>
      timeCalls(b, () => {
        last.voiced = voiceStages.isVoiced(inp.y, rate);
      }),
    applyGain: (b) => {
      work.set(inp.y);
      return timeCalls(b, () => voiceStages.applyGain(work, rate, inp.voiced));
    },
    fades: (b) => {
      work.set(inp.gained);
      return timeCalls(b, () => voiceStages.fades(work, rate));
    },
    envelope: (b) =>
      timeCalls(b, () => {
        last.envelope = voiceStages.envelope(inp.faded, rate, p);
      }),
  };
}

/** Whether two envelopes have the same hop and the same four tracks. */
function sameEnvelope(a: Envelope | null, b: Envelope): boolean {
  return (
    a !== null &&
    a.hopMs === b.hopMs &&
    sameSamples(a.jaw, b.jaw) &&
    sameSamples(a.width, b.width) &&
    sameSamples(a.round, b.round) &&
    sameSamples(a.teeth, b.teeth)
  );
}

/**
 * Checks, once per row after the timing, what the timed batches compute: runs each batch once more with one
 * call and compares that call's result with processVoice's own (`out`) or its intermediate buffers (`inp`):
 * clipDetect with out.clipped, hpfTrim with x, resample with y, isVoiced with voiced, applyGain (on y) with
 * gained, fades (on gained) with faded, envelope with out.envelope.
 */
function checkStages(
  batches: Readonly<Record<VoiceStageName, (b: number) => number>>,
  inp: StageInputs,
  out: VoiceResult,
  work: Float32Array,
  last: StageResults,
): Readonly<Record<VoiceStageName, boolean>> {
  const ran = (stage: VoiceStageName): void => {
    batches[stage](1);
  };
  ran('clipDetect');
  const clipDetect = last.clipped === out.clipped;
  ran('hpfTrim');
  const hpfTrim = sameSamples(last.x, inp.x);
  ran('resample');
  const resample = sameSamples(last.y, inp.y);
  ran('isVoiced');
  const isVoiced = last.voiced === inp.voiced;
  ran('applyGain');
  const applyGain = sameSamples(work, inp.gained);
  ran('fades');
  const fades = sameSamples(work, inp.faded);
  ran('envelope');
  const envelope = sameEnvelope(last.envelope, out.envelope);
  return { clipDetect, hpfTrim, resample, isVoiced, applyGain, fades, envelope };
}

/**
 * Times one stage: doubles the batch size from 1 until the fastest of 3 batches lasts at least `minMs` or the
 * size reaches STAGE_BATCH_MAX calls (these calibration batches also warm it up; the minimum keeps one slow
 * batch, a GC, from stopping it early), then times VOICE_CALLS batches of that size. Returns ms per call as
 * batch means (each batch's time / its size); `matches` is filled in by voiceChain.
 */
function timeStage(
  stage: VoiceStageName,
  batch: (b: number) => number,
  minMs: number,
): Omit<StageStats, 'matches'> {
  let size = 1;
  while (size < STAGE_BATCH_MAX && Math.min(batch(size), batch(size), batch(size)) < minMs) size *= 2;
  const perCall = new Float64Array(VOICE_CALLS);
  for (let i = 0; i < VOICE_CALLS; i++) perCall[i] = batch(size) / size;
  perCall.sort();
  return {
    stage,
    batch: size,
    batches: VOICE_CALLS,
    p50Ms: percentile(perCall, 50),
    p95Ms: percentile(perCall, 95),
    maxMs: perCall[VOICE_CALLS - 1]!,
  };
}

/**
 * X-F3, back to back. First an untimed pre-warm (VOICE_PREWARM_ROUNDS rounds of processVoice on the 1 s clip,
 * each preset once), so the first row isn't timed while the JIT tiers up. Then, for each clip length (1, 5,
 * 10 s) and preset (cub, chipmunk, bigbear): one untimed warm-up call of processVoice(clip, rate, preset), then
 * VOICE_CALLS calls timed one by one with performance.now() around each; then each voiceStages function timed
 * on its own input (timeStage) in batches lasting at least max(2 ms, 20 timer steps), since a stage of a 1 s
 * clip can take less than one timer step; then checkStages.
 */
function voiceChain(req: BenchRequest, timerStepMs: number): VoiceStats {
  const rate = req.rate;
  const minMs = Math.max(STAGE_BATCH_MIN_MS, STAGE_BATCH_STEPS * timerStepMs);
  const total = VOICE_CLIPS_S.length * VOICE_PRESETS.length;
  const rows: VoiceRow[] = [];
  post({
    t: 'info',
    bench: req.bench,
    line:
      `${VOICE_CALLS} timed processVoice calls per clip and preset after 1 warm-up call; stages in batches ` +
      `of ≥ ${minMs.toFixed(1)} ms (≤ ${STAGE_BATCH_MAX} calls), ${VOICE_CALLS} batches each`,
  });
  const warmClip = speechClip(rate, 1);
  const tw = performance.now();
  for (let k = 0; k < VOICE_PREWARM_ROUNDS; k++)
    for (const preset of VOICE_PRESETS) processVoice(warmClip, rate, preset);
  post({
    t: 'info',
    bench: req.bench,
    line:
      `pre-warm: ${VOICE_PREWARM_ROUNDS} × ${VOICE_PRESETS.length} presets on the 1 s clip, ` +
      `${(performance.now() - tw).toFixed(1)} ms`,
  });
  const start = performance.now();
  for (const clipS of VOICE_CLIPS_S) {
    const pcm = speechClip(rate, clipS);
    post({
      t: 'info',
      bench: req.bench,
      line:
        `${clipS} s clip: ${pcm.length} samples at ${rate} Hz, ${clipS / (BURST_S + NOISE_GAP_S)} × ` +
        `(${BURST_S * 1000} ms vowel burst + ${NOISE_GAP_S * 1000} ms pink noise at ${NOISE_DBFS} dBFS)`,
    });
    for (const preset of VOICE_PRESETS) {
      let t0 = performance.now();
      const out = processVoice(pcm, rate, preset);
      const warmupMs = performance.now() - t0;
      const times = new Float64Array(VOICE_CALLS);
      for (let i = 0; i < VOICE_CALLS; i++) {
        t0 = performance.now();
        processVoice(pcm, rate, preset);
        times[i] = performance.now() - t0;
      }
      times.sort();
      const p = preset.pitchRatio;
      const inp = stageInputs(pcm, rate, p);
      const work = new Float32Array(inp.y.length);
      const none = new Float32Array(0);
      const last: StageResults = { clipped: false, x: none, y: none, voiced: false, envelope: null };
      const batches = stageBatches(pcm, rate, p, inp, work, last);
      const timed = STAGE_ORDER.map((stage) => timeStage(stage, batches[stage], minMs));
      const matches = checkStages(batches, inp, out, work, last);
      rows.push({
        clipS,
        preset: preset.id,
        pitchRatio: p,
        inSamples: pcm.length,
        outSamples: out.pcm.length,
        calls: VOICE_CALLS,
        p50Ms: percentile(times, 50),
        p95Ms: percentile(times, 95),
        maxMs: times[VOICE_CALLS - 1]!,
        sortedMs: Array.from(times),
        warmupMs,
        composed: sameSamples(inp.faded, out.pcm),
        stages: timed.map((t) => ({ ...t, matches: matches[t.stage] })),
      });
      post({ t: 'progress', bench: req.bench, done: rows.length, total });
    }
  }
  return { kind: 'voice', rate, rows, wallS: (performance.now() - start) / 1000 };
}

async function run(req: BenchRequest): Promise<void> {
  const stepUs = timerStepUs();
  post({
    t: 'info',
    bench: req.bench,
    line: `timer step ≈ ${stepUs.toFixed(1)} µs (crossOriginIsolated ${String(self.crossOriginIsolated)})`,
  });
  let stats: FrameStats | QuantumStats | VoiceStats | null;
  switch (req.bench) {
    case 'silero-ts':
      stats = await sileroTs(req);
      break;
    case 'silero-ort':
      stats = await sileroOrt(req);
      break;
    case 'worklet-dsp':
      stats = await workletDsp(req);
      break;
    case 'voice-chain':
      stats = voiceChain(req, stepUs / 1000);
      break;
  }
  if (stats !== null) post({ t: 'result', bench: req.bench, stats });
}

self.addEventListener('message', (e: MessageEvent<BenchRequest>) => {
  const req = e.data;
  run(req).catch((err: unknown) => post({ t: 'error', bench: req.bench, message: errorMessage(err) }));
});
