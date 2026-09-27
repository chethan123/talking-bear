// VAD core of the DSP worker (plan §3.1, §4.2.1, §4.4 point 4): the energy backend (M1). It consumes the
// 512-sample 16 kHz frames the capture worklet tags with {epoch, firstFrame}, band-limits them, carves 10 ms
// hops across frame boundaries, steps the adaptive energy gate and the shared segmenter, and posts `seg`,
// `level` and `floorSnapshot` messages in context-rate frame indices for the current epoch.
//
// Pure TypeScript: no worker globals (`post` is injected), so the whole backend runs in Node tests. The
// per-frame path doesn't allocate: the scratch and hop buffers and the gate's feature record are
// preallocated, and objects are created only for the messages it posts.

import type { WorkerToMain } from '../audio/messages.ts';
import { ENERGY_HOP, ONSET_BLOCK_MS, VAD_FRAME, VAD_RATE } from '../audio/constants.ts';
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
import { ENERGY_SEG_PARAMS, initialSegState, segmenterStep, type SegState } from '../dsp/segmenter.ts';

/** A `level` message is posted on every LEVEL_EVERY_HOPS-th hop of an epoch (10 ms hops: ≈ 33 Hz). */
export const LEVEL_EVERY_HOPS = 3;

export const SILERO_UNAVAILABLE_MESSAGE = 'silero backend not available in M1; using energy';

export class VadCore {
  private readonly ctxRate: number;
  private readonly post: (m: WorkerToMain) => void;
  /** Onset block length in ctx frames: Math.round(ONSET_BLOCK_MS / 1000 · ctxRate). */
  private readonly onsetBlockFrames: number;
  private readonly filter: Biquad;
  /** Gate-filtered copy of the current frame. */
  private readonly scratch = new Float32Array(VAD_FRAME);
  /** Hop accumulator: holds the first `hopFill` samples of the next 10 ms hop. */
  private readonly hop = new Float32Array(ENERGY_HOP);
  /** Reused per hop; the gate reads `db` only. */
  private readonly features: FrameFeatures = { frame: 0, db: 0, floorDb: Number.NaN };

  /** The current epoch. null until the first reset: every frame is dropped until then. */
  private epoch: number | null = null;
  private gate: EnergyGateState = initialEnergyGateState();
  private seg: SegState = initialSegState();
  private hopFill = 0;
  /** Ctx frame (unrounded) of the hop accumulator's first sample; valid while hopFill > 0. */
  private hopFirstFrame = 0;
  /** Hops completed in this epoch. */
  private hopCount = 0;
  /** firstFrame of the epoch's first accepted frame; null until then. */
  private epochStartFrame: number | null = null;
  /** Hops starting before this ctx frame get prob 0 (onset block); valid once epochStartFrame is set. */
  private onsetBlockEnd = 0;

  constructor(ctxRate: number, post: (m: WorkerToMain) => void) {
    if (!Number.isFinite(ctxRate) || ctxRate <= 0) {
      throw new RangeError(`ctxRate must be a positive finite number (got ${ctxRate})`);
    }
    this.ctxRate = ctxRate;
    this.post = post;
    this.onsetBlockFrames = Math.round((ONSET_BLOCK_MS / 1000) * ctxRate);
    this.filter = createGateFilter(VAD_RATE);
  }

  /** Starts a new listen: `epoch` becomes current, and the filter, hop remainder, segmenter, gate
   *  (restored to `restoreFloorDb` when it is finite) and epoch start are reset. */
  reset(epoch: number, vad: 'silero' | 'energy', restoreFloorDb?: number): void {
    this.epoch = epoch;
    this.filter.reset();
    this.hopFill = 0;
    this.hopFirstFrame = 0;
    this.hopCount = 0;
    this.seg = initialSegState();
    this.gate = initialEnergyGateState(restoreFloorDb);
    this.epochStartFrame = null;
    this.onsetBlockEnd = 0;
    if (vad === 'silero') {
      this.post({ t: 'error', where: 'vad', message: SILERO_UNAVAILABLE_MESSAGE });
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
    for (let i = 0; i < VAD_FRAME; i++) {
      if (this.hopFill === 0) this.hopFirstFrame = firstFrame + (i * this.ctxRate) / VAD_RATE;
      hop[this.hopFill] = x[i]!;
      this.hopFill++;
      if (this.hopFill === ENERGY_HOP) {
        this.hopFill = 0;
        this.stepHop(epoch, Math.round(this.hopFirstFrame));
      }
    }
  }

  private stepHop(epoch: number, ctxFrame: number): void {
    const db = frameDb(this.hop, 0, ENERGY_HOP);
    const f = this.features;
    f.frame = ctxFrame;
    f.db = db;
    const gate = energyGateStep(this.gate, f, DEFAULT_ENERGY_PARAMS);
    const floorDb = gate.initialized ? gate.floorDb : Number.NaN;
    f.floorDb = floorDb;
    const prob = gate.active && ctxFrame >= this.onsetBlockEnd ? 1 : 0;
    const ev = segmenterStep(this.seg, ENERGY_SEG_PARAMS, ctxFrame, prob);
    if (ev !== null) {
      if (ev.kind === 'start') this.post({ t: 'floorSnapshot', epoch, floorDb });
      this.post({ t: 'seg', epoch, ev });
    }
    if (this.hopCount % LEVEL_EVERY_HOPS === 0) {
      this.post({ t: 'level', epoch, frame: ctxFrame, db, floorDb });
    }
    this.hopCount++;
  }
}
