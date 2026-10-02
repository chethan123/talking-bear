// Capture AudioWorklet processor `capture` (plan §3.1, §4.1.2), run on the audio render thread every
// 128-frame quantum:
//   mono down-mix → 80 Hz high-pass → 12 s ring buffer at the context rate (written continuously);
//   the high-passed signal also feeds a 16 kHz decimator that runs continuously (issue #25: no filter
//   start-up transient at arm), and while armed its output is cut into 512-sample frames posted to the DSP
//   worker, tagged with the ctx-rate frame index of their first sample (the resampler's timing contract puts
//   output j at input j / ratio, so the group delay is already removed);
//   the ring and the decimator are fed one and the same stream, so every tag is a ring frame even where
//   currentFrame doesn't step by one quantum (issue #237, see process());
//   deferred `take`s are streamed to the main thread in chunks of ≤ CHUNK_MAX frames, one chunk per quantum.
// The output is silence.
//
// Render-thread rules: process() never throws and allocates only the buffers it transfers (a new frame after
// each posted frame, one array per clip chunk). Message objects and the transfer list are preallocated and
// reused: postMessage serialises them synchronously, so mutating them afterwards is safe.

import { butterworthHighpass } from '../dsp/biquad.ts';
import type { Biquad } from '../dsp/biquad.ts';
import { createResampler } from '../dsp/resample.ts';
import type { Resampler } from '../dsp/resample.ts';
import { RingBuffer } from '../dsp/ring-buffer.ts';
import { CHUNK_MAX, HPF_CLIP_HZ, RING_SECONDS, VAD_FRAME, VAD_RATE } from './constants.ts';
import type { WorkletToMain, WorkletToWorker } from './messages.ts';

/** Render quantum size: Chrome's default, and the only size main asks for (no renderSizeHint). */
const QUANTUM = 128;
/** Capacity of the pending-take queue; a take that finds it full fails at once. */
const TAKE_QUEUE = 4;
const NO_CHANNELS: readonly Float32Array[] = [];
/** Transfer list of the messages that carry no buffer (`armed`, `takeFailed`). */
const NO_TRANSFER: Transferable[] = [];
/**
 * ZERO_RUNS[n] is n zero samples (n = 0…QUANTUM), views made once at load: the decimator's input over a
 * currentFrame jump, without allocating in process().
 */
const ZEROS = new Float32Array(QUANTUM);
const ZERO_RUNS: readonly Float32Array[] = Array.from({ length: QUANTUM + 1 }, (_, n) =>
  ZEROS.subarray(0, n),
);

/** A ctx-frame index that ring reads accept. */
function isFrame(v: unknown): v is number {
  return Number.isSafeInteger(v);
}

type ArmedMsg = Extract<WorkletToMain, { t: 'armed' }>;
type ChunkMsg = Extract<WorkletToMain, { t: 'clipChunk' }>;
type FailedMsg = Extract<WorkletToMain, { t: 'takeFailed' }>;

/** A queued take; slots are preallocated and reused. */
interface TakeSlot {
  epoch: number;
  id: number;
  fromFrame: number;
  toFrame: number;
  /** Frames already sent: the next chunk starts at fromFrame + sent. */
  sent: number;
  /** seq of the next chunk. */
  seq: number;
}

/** Fields of an incoming message; anything may be missing or of the wrong type. */
interface Incoming {
  t?: unknown;
  epoch?: unknown;
  id?: unknown;
  fromFrame?: unknown;
  toFrame?: unknown;
  port?: unknown;
}

class CaptureProcessor extends AudioWorkletProcessor implements AudioWorkletProcessorImpl {
  readonly #rate: number;
  readonly #ringFrames: number;
  readonly #hpf: Biquad;
  readonly #ring: RingBuffer;
  readonly #dec: Resampler;
  readonly #mono = new Float32Array(QUANTUM);
  readonly #hp = new Float32Array(QUANTUM);
  readonly #decOut: Float32Array;
  #frame = new Float32Array(VAD_FRAME);
  #fill = 0;
  /** Input position (ctx frames) of #frame[0]. */
  #framePos = 0;
  /** Global decimator output counter. */
  #outIndex = 0;
  /**
   * The ring frame of the decimator's input sample 0: the ring's first frame, or the frame of the quantum
   * that re-anchored the decimator after a gap over #maxZeroFeed. From there on the decimator is fed exactly
   * the ring's frames, zero-filled gaps included, so its output j sits at ring frame streamBase + j / ratio.
   */
  #streamBase = Number.NaN;
  /** The longest currentFrame gap fed to the decimator as zeros (0.5 s of frames); longer ones re-anchor. */
  readonly #maxZeroFeed: number;

  #worker: MessagePort | null = null;
  #armed = false;
  #epoch = 0;
  #armFrame = 0;
  #armPending = false;
  #pendingEpoch = 0;

  readonly #takes: TakeSlot[] = [];
  #takeHead = 0;
  #takeCount = 0;

  // Reused messages and transfer list (see the header).
  readonly #armedMsg: ArmedMsg = { t: 'armed', epoch: 0, armFrame: 0 };
  readonly #frameMsg: WorkletToWorker;
  readonly #chunkMsg: ChunkMsg;
  readonly #failedMsg: FailedMsg = { t: 'takeFailed', epoch: 0, id: 0, reason: 'evicted' };
  readonly #transfer: ArrayBuffer[] = [new ArrayBuffer(0)];

  constructor() {
    super();
    this.#rate = sampleRate;
    this.#ringFrames = RING_SECONDS * sampleRate;
    this.#hpf = butterworthHighpass(sampleRate, HPF_CLIP_HZ);
    this.#ring = new RingBuffer(Math.ceil(this.#ringFrames));
    this.#dec = createResampler(sampleRate, VAD_RATE);
    this.#maxZeroFeed = Math.round(sampleRate / 2);
    this.#decOut = new Float32Array(Math.ceil(QUANTUM * this.#dec.ratio) + 2);
    for (let i = 0; i < TAKE_QUEUE; i++) {
      this.#takes.push({ epoch: 0, id: 0, fromFrame: 0, toFrame: 0, sent: 0, seq: 0 });
    }
    this.#frameMsg = { t: 'frame', epoch: 0, firstFrame: 0, pcm16k: this.#frame };
    this.#chunkMsg = {
      t: 'clipChunk',
      epoch: 0,
      id: 0,
      seq: 0,
      last: false,
      pcm: new Float32Array(0),
      sampleRate: this.#rate,
    };
    this.port.addEventListener('message', (e: MessageEvent<unknown>): void => {
      this.#onMessage(e.data);
    });
    this.port.start();
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // This quantum's frame (issue #237). Chrome doesn't always step currentFrame by one quantum per call: it
    // can jump ahead (at start-up, by up to 4,480 frames in local runs and ≈ 9,800 in the failing CI run),
    // and it can repeat, then catch up. A jump leaves a gap that the ring zero-fills, and the decimator is
    // fed the same zeros: otherwise its tags, counted from streamBase, fall behind the ring by the gap, and a
    // take cut by them misses the gap's length of its tail. A gap over 0.5 s re-anchors the decimator
    // instead, so a huge jump costs no more than a small one. A currentFrame at or behind the ring's end (the
    // normal step, a repeat, or not a safe integer) continues the ring. With an empty ring, a quantum without
    // a valid currentFrame is dropped, and so is any quantum whose last frame isn't a safe integer (the ring
    // would throw).
    const ring = this.#ring;
    const cf = currentFrame;
    const frame = ring.isEmpty ? cf : Number.isSafeInteger(cf) && cf > ring.endFrame ? cf : ring.endFrame;
    if (Number.isSafeInteger(frame) && Number.isSafeInteger(frame + QUANTUM)) {
      this.#downmix(inputs[0] ?? NO_CHANNELS);
      this.#hpf.process(this.#mono, this.#hp);
      const gap = ring.isEmpty ? 0 : frame - ring.endFrame;
      if (ring.isEmpty) this.#streamBase = frame;
      ring.write(this.#hp, frame);
      if (gap > this.#maxZeroFeed) {
        // After a reset the decimator's history is zeros, as after a long gap, and its outputs sit at ring
        // frames frame + j / ratio again. The partial frame and the outputs still due before the gap are
        // dropped.
        this.#dec.reset();
        this.#streamBase = frame;
        this.#outIndex = 0;
        this.#fill = 0;
      } else {
        for (let left = gap; left > 0; left -= QUANTUM) this.#decimate(ZERO_RUNS[Math.min(left, QUANTUM)]!);
      }
      if (this.#armPending) {
        this.#armPending = false;
        this.#armed = true;
        this.#epoch = this.#pendingEpoch;
        this.#armFrame = frame;
        this.#fill = 0;
        const msg = this.#armedMsg;
        msg.epoch = this.#epoch;
        msg.armFrame = frame;
        this.port.postMessage(msg, NO_TRANSFER);
      }
      this.#decimate(this.#hp);
    }
    this.#serveTake();
    const out = outputs[0];
    if (out !== undefined) for (let c = 0; c < out.length; c++) out[c]!.fill(0);
    return true;
  }

  /** mono[i] = mean over the input channels of sample i; zeros with no channels. */
  #downmix(channels: readonly Float32Array[]): void {
    const mono = this.#mono;
    const n = channels.length;
    if (n === 0) {
      mono.fill(0);
    } else if (n === 1) {
      const ch = channels[0]!;
      for (let i = 0; i < QUANTUM; i++) mono[i] = ch[i] ?? 0;
    } else {
      for (let i = 0; i < QUANTUM; i++) {
        let sum = 0;
        for (let c = 0; c < n; c++) {
          const ch = channels[c]!;
          sum += ch[i] ?? 0;
        }
        mono[i] = sum / n;
      }
    }
  }

  /**
   * Runs the decimator on x: this quantum, or up to QUANTUM zeros of a gap. While armed, frames outputs at
   * positions ≥ armFrame.
   */
  #decimate(x: Float32Array): void {
    const dec = this.#dec;
    const decOut = this.#decOut;
    const n = dec.processInto(x, decOut);
    for (let j = 0; j < n; j++) {
      const pos = this.#streamBase + this.#outIndex / dec.ratio;
      if (this.#armed && pos >= this.#armFrame) {
        if (this.#fill === 0) this.#framePos = pos;
        this.#frame[this.#fill++] = decOut[j]!;
        if (this.#fill === VAD_FRAME) this.#postFrame();
      }
      this.#outIndex++;
    }
  }

  /** Posts the full frame to the worker (transferred) and starts a new one. No worker port: dropped. */
  #postFrame(): void {
    this.#fill = 0;
    const worker = this.#worker;
    if (worker === null) return;
    const frame = this.#frame;
    const msg = this.#frameMsg;
    msg.epoch = this.#epoch;
    msg.firstFrame = Math.round(this.#framePos);
    msg.pcm16k = frame;
    this.#transfer[0] = frame.buffer;
    worker.postMessage(msg, this.#transfer);
    this.#frame = new Float32Array(VAD_FRAME); // allocation: replaces the transferred frame
  }

  /** One action per quantum on the head take: fail it if evicted, or send its next chunk once complete. */
  #serveTake(): void {
    if (this.#takeCount === 0) return;
    const take = this.#takes[this.#takeHead]!;
    const ring = this.#ring;
    // The next unsent chunk, not the original fromFrame: once chunk 0 is out, fromFrame itself may be evicted.
    const next = take.fromFrame + take.sent;
    if (next < ring.startFrame) {
      this.#postFailed(take.epoch, take.id);
      this.#dropHead();
    } else if (ring.endFrame >= take.toFrame) {
      const pcm = new Float32Array(Math.min(CHUNK_MAX, take.toFrame - next)); // allocation: the transferred chunk
      ring.readInto(next, pcm); // same bounds checks as ring.read, which the guards above satisfy
      take.sent += pcm.length;
      const last = take.fromFrame + take.sent === take.toFrame;
      const msg = this.#chunkMsg;
      msg.epoch = take.epoch;
      msg.id = take.id;
      msg.seq = take.seq++;
      msg.last = last;
      msg.pcm = pcm;
      this.#transfer[0] = pcm.buffer;
      this.port.postMessage(msg, this.#transfer);
      if (last) this.#dropHead();
    }
  }

  #dropHead(): void {
    this.#takeHead = (this.#takeHead + 1) % TAKE_QUEUE;
    this.#takeCount--;
  }

  #postFailed(epoch: number, id: number): void {
    const msg = this.#failedMsg;
    msg.epoch = epoch;
    msg.id = id;
    this.port.postMessage(msg, NO_TRANSFER);
  }

  /** Commands from main. Never throws; ignores unknown or malformed messages. */
  #onMessage(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const m = data as Incoming;
    switch (m.t) {
      case 'init':
        if (m.port instanceof MessagePort) this.#worker = m.port;
        return;
      case 'arm':
        if (typeof m.epoch !== 'number') return;
        this.#armPending = true;
        this.#pendingEpoch = m.epoch;
        return;
      case 'disarm':
        if (typeof m.epoch !== 'number') return;
        if (this.#armPending && m.epoch === this.#pendingEpoch) {
          // A disarm that overtakes its own arm (both between two quanta) cancels it. That arm would have
          // superseded the current epoch, so the current feed stops too.
          this.#armPending = false;
          this.#armed = false;
          this.#fill = 0;
        } else if (this.#armed && m.epoch === this.#epoch) {
          this.#armed = false;
          this.#fill = 0;
        }
        return;
      case 'take':
        this.#onTake(m);
        return;
      default:
        return;
    }
  }

  #onTake(m: Incoming): void {
    const { epoch, id, fromFrame, toFrame } = m;
    if (typeof epoch !== 'number' || typeof id !== 'number') return;
    // Non-integer or unsafe frames would make the ring read throw inside process(), so they fail here.
    if (
      !isFrame(fromFrame) ||
      !isFrame(toFrame) ||
      fromFrame >= toFrame ||
      toFrame - fromFrame > this.#ringFrames ||
      this.#takeCount === TAKE_QUEUE
    ) {
      this.#postFailed(epoch, id);
      return;
    }
    const slot = this.#takes[(this.#takeHead + this.#takeCount) % TAKE_QUEUE]!;
    slot.epoch = epoch;
    slot.id = id;
    slot.fromFrame = fromFrame;
    slot.toFrame = toFrame;
    slot.sent = 0;
    slot.seq = 0;
    this.#takeCount++;
  }
}

registerProcessor('capture', CaptureProcessor);
