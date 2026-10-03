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
//   that throws switches the epoch to energy (an open segment ends as a `misfire`). The optional pre-gate
//   (plan §4.2.3) skips inference while the gate has been closed for ≥ 700 ms and the segmenter is idle, and
//   replays the last 10 skipped frames to warm the LSTM up when the gate opens again.
//   Proximity gate (plan §4.2.2): a Silero `end` (silence or maxLength) becomes a `misfire` unless the power
//   mean of the band-limited hop levels over the segment's speech frames is at least X dB (`proximityDb`,
//   default PROXIMITY_DB) above the floor its `floorSnapshot` carried at the onset.
//
// Feature trace (`setTrace`, for lab/vad-trace and the debug overlay; plan §7 M2): while it is on, every hop's
// raw (unfiltered) and band-limited dB and voicing score, and every Silero frame's p (the model's output, before
// onset blocking) and inference time, are collected and posted as a `traceBatch` once a batch holds
// TRACE_BATCH_HOPS hops (250 ms), at the end of the frame that completes it; `reset` and trace off flush a
// partial batch. Voicing is then computed on every hop on both backends, and the pre-gate never skips, so the
// trace is complete. The values are the ones the VAD itself uses (bandDb is the gate's level, voicing the
// energy path's score); nothing upstream of them changes, and with the trace off nothing changes at all.
//
// Capture gaps (#244): when the audio thread stalls for over 0.5 s, the capture worklet re-anchors its VAD feed
// at the new frame (src/audio/capture.worklet.ts), so the tags jump and the audio in between is missing. A frame
// whose firstFrame differs by more than CAPTURE_GAP_SLACK (one render quantum) from the previous frame's
// firstFrame plus one VAD frame starts after a gap, and no hop, segment or trace batch spans the gap: the partial
// hop is dropped; a segment in progress ends at its last step before the gap, as an `end` (reason 'silence') if
// it passes the checks a silence end faces there (the minimum speech, then the energy voicing rule or the Silero
// proximity gate), else as a `misfire`, and the segmenter starts over; and with the trace on, the batch ends at
// the gap. The voicing window restarts from zeros, as at `reset`. The gate and its floor, the gate filter, the
// LSTM, the pre-gate, the hop count and the onset block carry on. Without a gap, nothing changes.
//
// Pure TypeScript: no worker globals (`post` is injected; the clock defaults to `performance.now`), so the
// whole core runs in Node tests. The per-frame path doesn't allocate: every buffer is preallocated, and
// objects are created only for the messages it posts (and, with the trace on, the five arrays each
// `traceBatch` transfers; at a capture gap, the segmenter's fresh state).

import {
  ENERGY_HOP,
  ONSET_BLOCK_MS,
  PREGATE_WARMUP_FRAMES,
  PROXIMITY_DB,
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
import { activeLevelDb, passesProximity } from '../dsp/proximity.ts';
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

/** Proximity gate: band-limited hop levels (and their ctx frames) kept for the active level, 10 s of hops. */
export const PROXIMITY_HISTORY_HOPS = 1000;

/** Feature trace: a `traceBatch` is posted once this many hops (250 ms) have been collected. */
export const TRACE_BATCH_HOPS = 25;
/** Hops the trace accumulators hold: a batch, plus the rest of the frame that completes it (a frame completes
 *  at most ⌈512 / 160⌉ = 4 hops), which opens the next batch. */
const TRACE_HOP_CAPACITY = TRACE_BATCH_HOPS + Math.ceil(VAD_FRAME / ENERGY_HOP);
/** Silero frames the trace accumulators hold. A frame's p joins the batch its hops fill first: every such frame
 *  but the one that completes the batch adds 3 or 4 hops to it, so a batch gets at most ⌈25 / 3⌉ = 9 values;
 *  TRACE_BATCH_HOPS is a safe bound. */
const TRACE_SILERO_CAPACITY = TRACE_BATCH_HOPS;

/**
 * Capture gaps (#244): a frame whose firstFrame differs by more than this many ctx frames (one 128-frame render
 * quantum) from the previous frame's firstFrame plus one VAD frame (512 · ctxRate / 16000) starts after a gap.
 * The worklet's tags are exact up to rounding (at most 1 frame apart), and it zero-fills every gap up to 0.5 s,
 * so only a re-anchor moves them further.
 */
export const CAPTURE_GAP_SLACK = 128;

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
  /** Length of one 512-sample VAD frame in ctx frames (unrounded): VAD_FRAME · ctxRate / VAD_RATE. */
  private readonly frameCtx: number;
  private readonly filter: Biquad;
  /** Gate-filtered copy of the current frame. */
  private readonly scratch = new Float32Array(VAD_FRAME);
  /** Hop accumulator: holds the first `hopFill` samples of the next 10 ms hop. */
  private readonly hop = new Float32Array(ENERGY_HOP);
  /** The same hop's raw (unfiltered) samples, for the trace's rawDb. */
  private readonly rawHop = new Float32Array(ENERGY_HOP);
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
  /** Band-limited level (dBFS) of the epoch's hop j at j % PROXIMITY_HISTORY_HOPS, for the proximity gate. */
  private readonly histDb = new Float32Array(PROXIMITY_HISTORY_HOPS);
  /** Ctx frame of the epoch's hop j at j % PROXIMITY_HISTORY_HOPS (Float64: ctx frames outgrow 2^24). */
  private readonly histFrame = new Float64Array(PROXIMITY_HISTORY_HOPS);
  /** Trace accumulators (see TRACE_HOP_CAPACITY, TRACE_SILERO_CAPACITY): per hop raw dB, band-limited dB,
   *  voicing and ctx frame; per Silero frame p, inference time (ms) and firstFrame. */
  private readonly trRaw = new Float32Array(TRACE_HOP_CAPACITY);
  private readonly trBand = new Float32Array(TRACE_HOP_CAPACITY);
  private readonly trVoicing = new Float32Array(TRACE_HOP_CAPACITY);
  private readonly trHopFrame = new Float64Array(TRACE_HOP_CAPACITY);
  private readonly trP = new Float32Array(TRACE_SILERO_CAPACITY);
  private readonly trMs = new Float32Array(TRACE_SILERO_CAPACITY);
  private readonly trSilFrame = new Float64Array(TRACE_SILERO_CAPACITY);
  /** Hops and Silero frames held by the trace accumulators (both 0 while the trace is off). */
  private trHops = 0;
  private trSil = 0;
  /** The feature trace is on. */
  private traceOn = false;
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
  /** The proximity gate's X (dB) for this epoch's Silero segments. */
  private proximityDb = PROXIMITY_DB;
  /** The floor the current segment's `floorSnapshot` carried (NaN: no floor yet at its onset). */
  private onsetFloorDb = Number.NaN;
  private gate: EnergyGateState = initialEnergyGateState();
  private seg: SegState = initialSegState();
  private hopFill = 0;
  /** Ctx frame (unrounded) of the hop accumulator's first sample; valid while hopFill > 0. */
  private hopFirstFrame = 0;
  /** Hops completed in this epoch; hop j's level and frame are at j % PROXIMITY_HISTORY_HOPS in the history. */
  private hopCount = 0;
  /** firstFrame of the epoch's first accepted frame; null until then. */
  private epochStartFrame: number | null = null;
  /** firstFrame of the epoch's latest accepted frame (valid once epochStartFrame isn't null). */
  private lastFirstFrame = 0;
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
    this.frameCtx = (VAD_FRAME * ctxRate) / VAD_RATE;
    this.filter = createGateFilter(VAD_RATE);
    const ring = new Float32Array(PREGATE_WARMUP_FRAMES * VAD_FRAME);
    for (let i = 0; i < PREGATE_WARMUP_FRAMES; i++) {
      this.ringFrames.push(ring.subarray(i * VAD_FRAME, (i + 1) * VAD_FRAME));
    }
  }

  /**
   * Hands over the Silero model; epochs from the next `reset` on use it. If the current epoch asked for
   * Silero, runs on energy only because no model was set, and its segmenter is idle, it switches to Silero at
   * once (with an LSTM reset); otherwise it stays on its backend until the next `reset`.
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
   * Turns the feature trace on or off (it starts off, and stays as set across `reset`). Turning it off flushes
   * the partial batch, if any.
   */
  setTrace(on: boolean): void {
    if (on === this.traceOn) return;
    if (!on) this.flushTrace();
    this.traceOn = on;
  }

  /**
   * Starts a new listen: `epoch` becomes current, and the filter, hop remainder, segmenter, gate (restored to
   * `restoreFloorDb` when it is finite), voicing history, hop history, pre-gate ring and epoch start are reset,
   * and so is the model's LSTM state. The epoch runs on Silero iff `vad === 'silero'` and a model is set; a
   * Silero request without a model posts SILERO_NOT_READY_MESSAGE and runs on energy. `pregate === true`
   * enables the pre-gate. `proximityDb` is the proximity gate's X for the epoch's Silero segments
   * (PROXIMITY_DB when undefined or NaN). With the trace on, the previous epoch's partial batch is flushed
   * first.
   */
  reset(
    epoch: number,
    vad: 'silero' | 'energy',
    restoreFloorDb?: number,
    pregate?: boolean,
    proximityDb?: number,
  ): void {
    if (this.traceOn) this.flushTrace();
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
    this.proximityDb = proximityDb === undefined || Number.isNaN(proximityDb) ? PROXIMITY_DB : proximityDb;
    this.onsetFloorDb = Number.NaN;
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
   *  epoch other than the current one (including every frame before the first reset) are dropped. A frame
   *  after a capture gap (see CAPTURE_GAP_SLACK) first closes what the gap interrupts (`captureGap`). */
  frame(epoch: number, firstFrame: number, pcm16k: Float32Array): void {
    if (epoch !== this.epoch) return;
    if (pcm16k.length !== VAD_FRAME) {
      throw new RangeError(`frame must hold ${VAD_FRAME} samples (got ${pcm16k.length})`);
    }
    if (this.epochStartFrame === null) {
      this.epochStartFrame = firstFrame;
      this.onsetBlockEnd = firstFrame + this.onsetBlockFrames;
    } else if (Math.abs(firstFrame - (this.lastFirstFrame + this.frameCtx)) > CAPTURE_GAP_SLACK) {
      this.captureGap(epoch);
    }
    this.lastFirstFrame = firstFrame;
    const x = this.filter.process(pcm16k, this.scratch);
    const hop = this.hop;
    const rawHop = this.rawHop;
    this.gateOpen = false;
    for (let i = 0; i < VAD_FRAME; i++) {
      if (this.hopFill === 0) this.hopFirstFrame = firstFrame + (i * this.ctxRate) / VAD_RATE;
      hop[this.hopFill] = x[i]!;
      rawHop[this.hopFill] = pcm16k[i]!;
      this.hopFill++;
      if (this.hopFill === ENERGY_HOP) {
        this.hopFill = 0;
        this.stepHop(epoch, Math.round(this.hopFirstFrame));
      }
    }
    const m = this.silero;
    if (m !== null) this.stepSilero(epoch, firstFrame, pcm16k, m);
    if (this.trHops >= TRACE_BATCH_HOPS) this.postTrace(epoch, TRACE_BATCH_HOPS);
  }

  /**
   * The frame about to be consumed starts after a capture gap (#244). The partial hop is dropped, so no hop
   * straddles the gap, and the voicing window restarts from zeros (as at `reset`). A segment in progress ends at
   * its last step before the gap (its frame label: the last Silero frame's firstFrame, or the last hop's frame on
   * energy): an `end` with reason 'silence' and its lastSpeechFrame if it passes the checks a silence end would
   * face there (at least minSpeechMs of speech, then MIN_VOICED_MS voiced on energy or the proximity gate on
   * Silero), else a `misfire`; the segmenter then starts over. With the trace on, the batch ends at the gap, so
   * every batch's hops follow on from its hop0Frame and its Silero values from its sil0Frame: the partial batch is
   * posted, except that on Silero a partial batch without a Silero value is dropped, because a batch with hops but
   * no p would read as a broken Silero stream. That is normally the ≤ 3 hops left over from the frame that closed
   * the previous batch, whose p went out with it; up to a batch right after a late model switch.
   */
  private captureGap(epoch: number): void {
    this.hopFill = 0;
    this.voiceWin.fill(0);
    const s = this.seg;
    if (s.inSpeech) {
      const silero = this.silero !== null;
      const params = silero ? SILERO_SEG_PARAMS : ENERGY_SEG_PARAMS;
      const frame = silero
        ? this.lastFirstFrame
        : this.histFrame[(this.hopCount - 1) % PROXIMITY_HISTORY_HOPS]!;
      const speechMs = (s.lastSpeechStep - s.startStep + 1) * params.frameMs;
      const passes =
        speechMs >= params.minSpeechMs &&
        (silero ? this.nearEnough(s.lastSpeechFrame) : this.voicedHops * HOP_MS >= MIN_VOICED_MS);
      const ev: SegEvent = passes
        ? { kind: 'end', frame, lastSpeechFrame: s.lastSpeechFrame, reason: 'silence' }
        : { kind: 'misfire', frame };
      this.emit(epoch, ev, this.gate.initialized ? this.gate.floorDb : Number.NaN);
    }
    this.seg = initialSegState();
    if (this.traceOn) {
      if (this.silero !== null && this.trSil === 0) this.trHops = 0;
      else this.flushTrace();
    }
  }

  private stepHop(epoch: number, ctxFrame: number): void {
    const db = frameDb(this.hop, 0, ENERGY_HOP);
    const gate = this.gate;
    // Pre-gate test, against the floor before this hop's update. A floor-initialising hop loud enough to be
    // an energy onset (> −65 dBFS) also counts as open: a steady onset after digital silence would otherwise
    // never rise 3 dB above the floor it initialises.
    if (gate.initialized ? db > gate.floorDb + PREGATE_MARGIN_DB : db > DEFAULT_ENERGY_PARAMS.absMinDb) {
      this.gateOpen = true;
    }
    const f = this.features;
    f.frame = ctxFrame;
    f.db = db;
    energyGateStep(gate, f, DEFAULT_ENERGY_PARAMS);
    const floorDb = gate.initialized ? gate.floorDb : Number.NaN;
    f.floorDb = floorDb;
    const j = this.hopCount % PROXIMITY_HISTORY_HOPS;
    this.histDb[j] = db;
    this.histFrame[j] = ctxFrame;
    const win = this.voiceWin;
    win.copyWithin(0, ENERGY_HOP);
    win.set(this.hop, VOICING_WINDOW - ENERGY_HOP);
    const energyPath = this.silero === null;
    // The trace needs the score on the Silero path too; it is the same score the energy path uses.
    const score = energyPath || this.traceOn ? this.voicing.score(win) : 0;
    if (this.traceOn) {
      const k = this.trHops;
      this.trRaw[k] = frameDb(this.rawHop, 0, ENERGY_HOP);
      this.trBand[k] = db;
      this.trVoicing[k] = score;
      this.trHopFrame[k] = ctxFrame;
      this.trHops = k + 1;
    }
    if (energyPath) {
      const voiced = score > VOICED_THRESHOLD;
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
      // The trace suspends skipping (it needs p for every frame); the hold count still runs.
      if (!this.traceOn && !this.gateOpen && !this.seg.inSpeech && this.closedFrames > PREGATE_HOLD_FRAMES) {
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
      // The fresh energy segmenter can't end an open Silero segment: close it, or the session stays in
      // Recording until its watchdog restarts the worker.
      if (this.seg.inSpeech) this.emit(epoch, { kind: 'misfire', frame: firstFrame }, Number.NaN);
      this.silero = null;
      this.failed = true;
      this.seg = initialSegState();
      this.voicedHops = 0;
      this.ringStart = 0;
      this.ringCount = 0;
      return;
    }
    if (this.traceOn) {
      // The model's p (before onset blocking) and this inference's time, the newest in the stats ring.
      const k = this.trSil;
      this.trP[k] = p;
      this.trMs[k] = this.times[(this.inferences - 1) % VAD_STATS_WINDOW]!;
      this.trSilFrame[k] = firstFrame;
      this.trSil = k + 1;
    }
    if (firstFrame < this.onsetBlockEnd) p = 0;
    let ev: SegEvent | null = segmenterStep(this.seg, SILERO_SEG_PARAMS, firstFrame, p);
    if (ev !== null && ev.kind === 'end' && !this.nearEnough(ev.lastSpeechFrame)) {
      ev = { kind: 'misfire', frame: ev.frame }; // plan §4.2.2: too far from the floor, e.g. a TV across the room
    }
    if (ev !== null) this.emit(epoch, ev, this.gate.initialized ? this.gate.floorDb : Number.NaN);
  }

  /**
   * Proximity gate for the segment that just ended: the power mean of the hop levels whose ctx frame lies in
   * [start frame, lastSpeechFrame + one VAD frame), i.e. the hops of its speech frames, against the onset floor.
   * Hops older than the history (a segment longer than 10 s) are left out.
   */
  private nearEnough(lastSpeechFrame: number): boolean {
    const n = PROXIMITY_HISTORY_HOPS;
    const lo = this.seg.startFrame;
    const hi = lastSpeechFrame + this.frameCtx;
    const oldest = this.hopCount > n ? this.hopCount - n : 0;
    // Hop frames increase with the hop index: walk back from the newest hop to the range's end, then its start.
    let to = this.hopCount;
    while (to > oldest && this.histFrame[(to - 1) % n]! >= hi) to--;
    let from = to;
    while (from > oldest && this.histFrame[(from - 1) % n]! >= lo) from--;
    const start = from % n;
    const active = activeLevelDb(this.histDb, start, start + (to - from));
    return passesProximity(active, this.onsetFloorDb, this.proximityDb);
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

  /**
   * Posts the first `n` collected hops and every collected Silero frame as a `traceBatch` of `epoch`, in
   * freshly allocated arrays (transferred by the worker), and keeps the hops past `n` for the next batch.
   */
  private postTrace(epoch: number, n: number): void {
    const hops = this.trHops;
    const sil = this.trSil;
    const rawDb = new Float32Array(n);
    const bandDb = new Float32Array(n);
    const voicing = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      rawDb[i] = this.trRaw[i]!;
      bandDb[i] = this.trBand[i]!;
      voicing[i] = this.trVoicing[i]!;
    }
    const sileroP = new Float32Array(sil);
    const inferMs = new Float32Array(sil);
    for (let j = 0; j < sil; j++) {
      sileroP[j] = this.trP[j]!;
      inferMs[j] = this.trMs[j]!;
    }
    const hop0Frame = n > 0 ? this.trHopFrame[0]! : Number.NaN;
    const sil0Frame = sil > 0 ? this.trSilFrame[0]! : Number.NaN;
    this.trRaw.copyWithin(0, n, hops);
    this.trBand.copyWithin(0, n, hops);
    this.trVoicing.copyWithin(0, n, hops);
    this.trHopFrame.copyWithin(0, n, hops);
    this.trHops = hops - n;
    this.trSil = 0;
    this.post({ t: 'traceBatch', epoch, hop0Frame, sil0Frame, rawDb, bandDb, voicing, sileroP, inferMs });
  }

  /** Posts the partial batch of the current epoch, if any, and empties the trace accumulators. */
  private flushTrace(): void {
    const epoch = this.epoch;
    if (epoch !== null && (this.trHops > 0 || this.trSil > 0)) this.postTrace(epoch, this.trHops);
    this.trHops = 0;
    this.trSil = 0;
  }

  private emit(epoch: number, ev: SegEvent, floorDb: number): void {
    if (ev.kind === 'start') {
      this.onsetFloorDb = floorDb; // the proximity gate's reference
      this.post({ t: 'floorSnapshot', epoch, floorDb });
    }
    this.post({ t: 'seg', epoch, ev });
  }
}
