// VAD core of the DSP worker (plan §3.1, §3.3 design rule 4, §4.2.1, §4.2.3, §4.4 point 4). It consumes the
// 512-sample 16 kHz frames the capture worklet tags with {epoch, firstFrame} and posts `seg`, `level`,
// `floorSnapshot` and `vadStats` messages in context-rate frame indices for the current epoch.
//
// Two backends share one segmenter, chosen per epoch by `reset`:
// - energy (M1, and the fallback): the frames are band-limited and carved into 10 ms hops across frame
//   boundaries; each hop steps the adaptive energy gate and the segmenter. A segment ends as a `misfire`
//   instead of an `end` unless at least 60 ms of its hops were voiced (normalised autocorrelation over the
//   last 512 band-limited samples, plan §4.2.1 step 5).
// - Silero (once `setModel` has handed over the model): each raw frame's speech probability steps the
//   segmenter. The energy gate still runs on every hop, for `level`, the floor and `floorSnapshot`. A model
//   that throws switches the epoch to energy. The optional pre-gate (plan §4.2.3) skips inference while the
//   gate has been closed for ≥ 700 ms and the segmenter is idle, and replays the last 10 skipped frames to
//   warm the LSTM up when the gate opens again.
//
// Pure TypeScript: no worker globals (`post` is injected; the clock defaults to `performance.now`), so the
// whole core runs in Node tests. The per-frame path doesn't allocate: every buffer is preallocated, and
// objects are created only for the messages it posts.

import {
  ENERGY_HOP,
  ONSET_BLOCK_MS,
  PREGATE_WARMUP_FRAMES,
  VAD_FRAME,
  VAD_RATE,
  VOICING_WINDOW,
} from '../audio/constants.ts';
import type { WorkerToMain } from '../audio/messages.ts';
import type { Biquad } from '../dsp/biquad.ts';
import {
  createGateFilter,
  DEFAULT_ENERGY_PARAMS,
  energyGateStep,
  frameDb,
  initialEnergyGateState,
  type EnergyGateState,
  type FrameFeatures,
} from '../dsp/energy-gate.ts';
import {
  ENERGY_SEG_PARAMS,
  initialSegState,
  segmenterStep,
  SILERO_SEG_PARAMS,
  type SegEvent,
  type SegState,
} from '../dsp/segmenter.ts';
import type { SileroModel } from '../dsp/silero/model.ts';
import { createVoicing, VOICED_THRESHOLD, type Voicing } from '../dsp/voicing.ts';

/** A `level` message is posted on every LEVEL_EVERY_HOPS-th hop of an epoch (10 ms hops: ≈ 33 Hz). */
export const LEVEL_EVERY_HOPS = 3;

/** Posted once per epoch that requests Silero before a model is set. */
export const SILERO_NOT_READY_MESSAGE = 'silero not ready; using energy';

/** Energy backend: a segment needs this much voiced audio, else its `end` becomes a `misfire`. */
export const MIN_VOICED_MS = 60;

/** Pre-gate: a hop opens the gate when its band-limited level is this far above the floor (plan §4.2.3). */
export const PREGATE_MARGIN_DB = 3;
/** Pre-gate: inference continues until the gate has been closed this long. */
export const PREGATE_HOLD_MS = 700;
/** PREGATE_HOLD_MS in 32 ms frames (22). */
export const PREGATE_HOLD_FRAMES = Math.ceil(PREGATE_HOLD_MS / ((VAD_FRAME * 1000) / VAD_RATE));

/** Inference times kept for `vadStats` (≈ 10 s of 32 ms frames); a `vadStats` is posted every this many. */
export const VAD_STATS_WINDOW = 312;
/** Nearest-rank index of the 95th percentile in a sorted window. */
const P95_INDEX = Math.ceil(0.95 * VAD_STATS_WINDOW) - 1;

/** One energy hop in ms (10). */
const HOP_MS = (ENERGY_HOP * 1000) / VAD_RATE;

export interface VadCoreOptions {
  /** Clock for the inference timings, in ms (default `performance.now()`). */
  now?: () => number;
}

const defaultNow = (): number => performance.now();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class VadCore {
  private readonly ctxRate: number;
  private readonly post: (m: WorkerToMain) => void;
  private readonly now: () => number;
  /** Onset block length in ctx frames: Math.round(ONSET_BLOCK_MS / 1000 · ctxRate). */
  private readonly onsetBlockFrames: number;
  private readonly filter: Biquad;
  /** Gate-filtered copy of the current frame. */
  private readonly scratch = new Float32Array(VAD_FRAME);
  /** Hop accumulator: holds the first `hopFill` samples of the next 10 ms hop. */
  private readonly hop = new Float32Array(ENERGY_HOP);
  /** Reused per hop; the gate reads `db` only. */
  private readonly features: FrameFeatures = { frame: 0, db: 0, floorDb: Number.NaN };
  private readonly voicing: Voicing = createVoicing(VAD_RATE);
  /** The most recent VOICING_WINDOW gate-filtered samples, oldest first (zeros at the start of an epoch). */
  private readonly voiceWin = new Float32Array(VOICING_WINDOW);
  /** Pre-gate ring of skipped raw frames: PREGATE_WARMUP_FRAMES views over one buffer. */
  private readonly ringFrames: Float32Array[] = [];
  /** The last VAD_STATS_WINDOW inference times (ms), a ring indexed by `inferences`. */
  private readonly times = new Float64Array(VAD_STATS_WINDOW);
  /** Sort buffer for the p95. */
  private readonly sorted = new Float64Array(VAD_STATS_WINDOW);
  /** Inferences over the core's lifetime. */
  private inferences = 0;
  /** The model handed over by `setModel`, used from the next `reset` (or at once by a late switch). */
  private model: SileroModel | null = null;

  /** The current epoch. null until the first reset: every frame is dropped until then. */
  private epoch: number | null = null;
  /** The backend the current epoch asked for. */
  private requested: 'silero' | 'energy' = 'energy';
  /** The epoch's model while it runs on Silero; null on the energy path. */
  private silero: SileroModel | null = null;
  /** A `process` call threw this epoch: it stays on energy until the next reset. */
  private failed = false;
  private pregate = false;
  private gate: EnergyGateState = initialEnergyGateState();
  private seg: SegState = initialSegState();
  private hopFill = 0;
  /** Ctx frame (unrounded) of the hop accumulator's first sample; valid while hopFill > 0. */
  private hopFirstFrame = 0;
  /** Hops completed in this epoch. */
  private hopCount = 0;
  /** firstFrame of the epoch's first accepted frame; null until then. */
  private epochStartFrame: number | null = null;
  /** Hops (energy) or frames (Silero) starting before this ctx frame get prob 0 (onset block). */
  private onsetBlockEnd = 0;
  /** Energy path: voiced hops of the current segment, from its `start` hop on. */
  private voicedHops = 0;
  /** Pre-gate ring: index of the oldest skipped frame, and how many are held. */
  private ringStart = 0;
  private ringCount = 0;
  /** Pre-gate: consecutive frames, up to this one, in which no hop opened the gate. */
  private closedFrames = 0;
  /** Some hop of the current frame passed the gate-open test. */
  private gateOpen = false;

  constructor(ctxRate: number, post: (m: WorkerToMain) => void, opts?: VadCoreOptions) {
    if (!Number.isFinite(ctxRate) || ctxRate <= 0) {
      throw new RangeError(`ctxRate must be a positive finite number (got ${ctxRate})`);
    }
    this.ctxRate = ctxRate;
    this.post = post;
    this.now = opts?.now ?? defaultNow;
    this.onsetBlockFrames = Math.round((ONSET_BLOCK_MS / 1000) * ctxRate);
    this.filter = createGateFilter(VAD_RATE);
    const ring = new Float32Array(PREGATE_WARMUP_FRAMES * VAD_FRAME);
    for (let i = 0; i < PREGATE_WARMUP_FRAMES; i++) {
      this.ringFrames.push(ring.subarray(i * VAD_FRAME, (i + 1) * VAD_FRAME));
    }
  }

  /**
   * Hands over the Silero model; epochs from the next `reset` on use it. If the current epoch asked for Silero,
   * runs on energy only because no model was set, and its segmenter is idle, it switches to Silero at once
   * (with an LSTM reset); otherwise it stays on its backend until the next `reset`.
   */
  setModel(m: SileroModel): void {
    this.model = m;
    if (
      this.epoch !== null &&
      this.requested === 'silero' &&
      this.silero === null &&
      !this.failed &&
      !this.seg.inSpeech
    ) {
      m.reset();
      this.silero = m;
      this.seg = initialSegState(); // Silero steps are 32 ms, energy steps 10 ms: the step count can't carry
      this.voicedHops = 0;
      this.ringStart = 0;
      this.ringCount = 0;
      this.closedFrames = 0;
    }
  }

  /**
   * Starts a new listen: `epoch` becomes current, and the filter, hop remainder, segmenter, gate (restored to
   * `restoreFloorDb` when it is finite), voicing history, pre-gate ring and epoch start are reset, and so is the
   * model's LSTM state. The epoch runs on Silero iff `vad === 'silero'` and a model is set; a Silero request
   * without a model posts SILERO_NOT_READY_MESSAGE and runs on energy. `pregate === true` enables the pre-gate.
   */
  reset(epoch: number, vad: 'silero' | 'energy', restoreFloorDb?: number, pregate?: boolean): void {
    this.epoch = epoch;
    this.filter.reset();
    this.hopFill = 0;
    this.hopFirstFrame = 0;
    this.hopCount = 0;
    this.seg = initialSegState();
    this.gate = initialEnergyGateState(restoreFloorDb);
    this.epochStartFrame = null;
    this.onsetBlockEnd = 0;
    this.voiceWin.fill(0);
    this.voicedHops = 0;
    this.requested = vad;
    this.pregate = pregate === true;
    this.failed = false;
    this.ringStart = 0;
    this.ringCount = 0;
    this.closedFrames = 0;
    const m = this.model;
    if (m !== null) m.reset(); // plan §4.4 point 4: the LSTM state is reset at every re-arm
    this.silero = vad === 'silero' ? m : null;
    if (vad === 'silero' && m === null) {
      this.post({ t: 'error', where: 'vad', message: SILERO_NOT_READY_MESSAGE });
    }
  }

  /** Consumes one 512-sample frame at 16 kHz whose first sample is ctx frame `firstFrame`. Frames of any
   *  epoch other than the current one (including every frame before the first reset) are dropped. */
  frame(epoch: number, firstFrame: number, pcm16k: Float32Array): void {
    if (epoch !== this.epoch) return;
    if (pcm16k.length !== VAD_FRAME) {
      throw new RangeError(`frame must hold ${VAD_FRAME} samples (got ${pcm16k.length})`);
    }
    if (this.epochStartFrame === null) {
      this.epochStartFrame = firstFrame;
      this.onsetBlockEnd = firstFrame + this.onsetBlockFrames;
    }
    const x = this.filter.process(pcm16k, this.scratch);
    const hop = this.hop;
    this.gateOpen = false;
    for (let i = 0; i < VAD_FRAME; i++) {
      if (this.hopFill === 0) this.hopFirstFrame = firstFrame + (i * this.ctxRate) / VAD_RATE;
      hop[this.hopFill] = x[i]!;
      this.hopFill++;
      if (this.hopFill === ENERGY_HOP) {
        this.hopFill = 0;
        this.stepHop(epoch, Math.round(this.hopFirstFrame));
      }
    }
    const m = this.silero;
    if (m !== null) this.stepSilero(epoch, firstFrame, pcm16k, m);
  }

  private stepHop(epoch: number, ctxFrame: number): void {
    const db = frameDb(this.hop, 0, ENERGY_HOP);
    const gate = this.gate;
    // Pre-gate test, against the floor before this hop's update. The hop that initialises the floor (after
    // digital silence) also counts as open: a steady onset would otherwise never rise 3 dB above itself.
    if (
      gate.initialized ? db > gate.floorDb + PREGATE_MARGIN_DB : db >= DEFAULT_ENERGY_PARAMS.ignoreBelowDb
    ) {
      this.gateOpen = true;
    }
    const f = this.features;
    f.frame = ctxFrame;
    f.db = db;
    energyGateStep(gate, f, DEFAULT_ENERGY_PARAMS);
    const floorDb = gate.initialized ? gate.floorDb : Number.NaN;
    f.floorDb = floorDb;
    const win = this.voiceWin;
    win.copyWithin(0, ENERGY_HOP);
    win.set(this.hop, VOICING_WINDOW - ENERGY_HOP);
    if (this.silero === null) {
      const voiced = this.voicing.score(win) > VOICED_THRESHOLD;
      const prob = gate.active && ctxFrame >= this.onsetBlockEnd ? 1 : 0;
      const wasInSpeech = this.seg.inSpeech;
      let ev: SegEvent | null = segmenterStep(this.seg, ENERGY_SEG_PARAMS, ctxFrame, prob);
      if (ev !== null && ev.kind === 'start') this.voicedHops = voiced ? 1 : 0;
      else if (wasInSpeech && voiced) this.voicedHops++;
      if (ev !== null && ev.kind === 'end' && this.voicedHops * HOP_MS < MIN_VOICED_MS) {
        ev = { kind: 'misfire', frame: ev.frame }; // plan §4.2.1 step 5: an utterance needs ≥ 60 ms voiced
      }
      if (ev !== null) this.emit(epoch, ev, floorDb);
    }
    if (this.hopCount % LEVEL_EVERY_HOPS === 0) {
      this.post({ t: 'level', epoch, frame: ctxFrame, db, floorDb });
    }
    this.hopCount++;
  }

  private stepSilero(epoch: number, firstFrame: number, raw: Float32Array, m: SileroModel): void {
    if (this.pregate) {
      this.closedFrames = this.gateOpen ? 0 : this.closedFrames + 1;
      if (!this.gateOpen && !this.seg.inSpeech && this.closedFrames > PREGATE_HOLD_FRAMES) {
        // Skip: keep the raw frame for the warm-up (the oldest goes once the ring is full) and feed p = 0.
        const n = PREGATE_WARMUP_FRAMES;
        this.ringFrames[(this.ringStart + this.ringCount) % n]!.set(raw);
        if (this.ringCount < n) this.ringCount++;
        else this.ringStart = (this.ringStart + 1) % n;
        segmenterStep(this.seg, SILERO_SEG_PARAMS, firstFrame, 0); // idle and p = 0: never an event
        return;
      }
    }
    let p: number;
    try {
      // Warm-up: the skipped frames, oldest first, through the LSTM but not the segmenter.
      while (this.ringCount > 0) {
        const buffered = this.ringFrames[this.ringStart]!;
        this.ringStart = (this.ringStart + 1) % PREGATE_WARMUP_FRAMES;
        this.ringCount--;
        this.infer(m, buffered);
      }
      p = this.infer(m, raw); // the raw frame: Silero is not band-limited
    } catch (err) {
      this.post({ t: 'error', where: 'vad', message: `silero failed: ${errorMessage(err)}; using energy` });
      this.silero = null;
      this.failed = true;
      this.seg = initialSegState();
      this.voicedHops = 0;
      this.ringStart = 0;
      this.ringCount = 0;
      return;
    }
    if (firstFrame < this.onsetBlockEnd) p = 0;
    const ev = segmenterStep(this.seg, SILERO_SEG_PARAMS, firstFrame, p);
    if (ev !== null) this.emit(epoch, ev, this.gate.initialized ? this.gate.floorDb : Number.NaN);
  }

  /** model.process(x), timed; every VAD_STATS_WINDOW inferences, posts the p95 of the last that many. */
  private infer(m: SileroModel, x: Float32Array): number {
    const t0 = this.now();
    const p = m.process(x);
    const n = this.inferences;
    this.times[n % VAD_STATS_WINDOW] = this.now() - t0;
    this.inferences = n + 1;
    if (this.inferences % VAD_STATS_WINDOW === 0) {
      const s = this.sorted;
      s.set(this.times);
      s.sort();
      this.post({ t: 'vadStats', p95Ms: s[P95_INDEX]! });
    }
    return p;
  }

  private emit(epoch: number, ev: SegEvent, floorDb: number): void {
    if (ev.kind === 'start') this.post({ t: 'floorSnapshot', epoch, floorDb });
    this.post({ t: 'seg', epoch, ev });
  }
}
