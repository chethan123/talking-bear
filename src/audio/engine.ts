// The audio engine (plan §3.1–§3.3): the imperative adapter the session's effect runner drives. It owns the
// AudioContext, the microphone stream (through the mic manager), the capture worklet node, the DSP worker and
// the MessageChannel between those two, and turns their messages into `EngineEvent`s.
//
//   mic → MediaStreamAudioSourceNode → capture worklet ──frames (channel)──→ DSP worker
//                                          │  armed / clip chunks / takeFailed      │ seg / level / floorSnapshot /
//                                          ▼                                        ▼ processed / error
//                                        engine (main thread) ───── onEvent ─────→ session
//
// The worker also posts `vadReady` (its Silero model is loaded) and `vadStats`; both are forwarded as events,
// which the session routes to its level listeners. So is `traceBatch`, the per-frame VAD features the worker
// streams while `setTrace(true)` is in effect (lab/vad-trace, the debug overlay).
//
// The graph is built on the first successful resume(). The worklet's output is connected to `destination` only
// when `connectWorkletOutput` is set (plan §3.2: a runtime flag, off until X-R4 shows no capture gaps).

import type { SessionEvent } from '../app/events.ts';
import type { Envelope, VoicePreset } from '../dsp/types.ts';
import workerUrl from '../workers/dsp.worker.ts?worker&url';
import { createMasterBus, type MasterBus } from './bus.ts';
import { DEFAULT_VAD_BACKEND, PREGATE_ENABLED } from './constants.ts';
import workletUrl from './capture.worklet.ts?worker&url';
import {
  transferList,
  type MainToWorker,
  type MainToWorklet,
  type WorkerToMain,
  type WorkletToMain,
} from './messages.ts';
import { createMicManager, type MicResult } from './mic.ts';

export type EngineEvent =
  | Extract<
      SessionEvent,
      {
        t:
          | 'ctxRunning'
          | 'ctxResumeFailed'
          | 'ctxError'
          | 'micGranted'
          | 'micDenied'
          | 'noDevice'
          | 'armed'
          | 'seg'
          | 'floorSnapshot'
          | 'clipReady'
          | 'takeFailed'
          | 'processed'
          | 'fxError'
          | 'workerFailed'
          | 'trackMuted'
          | 'trackUnmuted'
          | 'trackEnded'
          | 'inputsChanged';
      }
    >
  | { t: 'level'; epoch: number; frame: number; db: number; floorDb: number }
  | { t: 'vadError'; message: string }
  | { t: 'vadReady'; backend: 'silero' } // the worker's Silero model is loaded (informational)
  | { t: 'vadStats'; p95Ms: number } // p95 Silero inference time over the last ≈ 10 s
  | Extract<WorkerToMain, { t: 'traceBatch' }>; // the feature trace (setTrace), every 250 ms of audio

export interface Engine {
  resume(): Promise<void>;
  suspend(): Promise<void>;
  openMic(req: number): void;
  closeMic(): void;
  arm(epoch: number, restoreFloorDb?: number): void;
  disarm(epoch: number): void;
  /**
   * Cuts `[fromFrame, toFrame)` from the capture ring; emits `clipReady{epoch, id}` or `takeFailed{epoch, id}`.
   * Only the latest take is kept: a take superseded by a newer take() never emits clipReady (a takeFailed from the
   * worklet may still arrive for it).
   */
  take(epoch: number, id: number, fromFrame: number, toFrame: number): void;
  process(id: number, preset: VoicePreset): void;
  getProcessed(
    id: number,
  ): { pcm: Float32Array; sampleRate: number; envelope: Envelope; durationSec: number } | undefined;
  /**
   * Drops the stored processed result if it belongs to `id`, so no captured audio outlives its replay (plan §2);
   * any other id is a no-op.
   */
  releaseProcessed(id: number): void;
  /**
   * The assembled clip of the latest completed take, if (epoch, id) matches it. Used by lab pages; process()
   * transfers it away. A take superseded by a newer take() never completes: no clipReady (a takeFailed from the
   * worklet may still arrive for it).
   */
  getClip(epoch: number, id: number): Float32Array | undefined;
  restartWorker(): void;
  reselectInput(): void;
  context(): AudioContext | null;
  masterBus(): AudioNode | null;
}

/**
 * The e2e test hooks' access to the output (plan §4.9.3, issue #36). createEngine's result has it; `Engine`, the
 * interface the session and its test fakes implement, doesn't.
 */
export interface OutputTapHost {
  /**
   * Re-routes the master bus's `output` → `node` → `destination`, so `node` sees the bus's final signal (after
   * Quiet mode, from M3). Call it at most once, after the graph exists (after the first `ctxRunning`); it
   * throws otherwise and leaves the graph unchanged.
   */
  insertOutputTap(node: AudioNode): void;
}

/** Quiet mode for the master bus (main.ts applies the setting). createEngine's result has it; `Engine` doesn't. */
export interface QuietHost {
  /** Quiet mode (plan §4.3.4): remembered, used when the graph is built, applied at once if the bus exists. */
  setQuiet(on: boolean): void;
}

/** The feature trace (lab/vad-trace, the debug overlay). createEngine's result has it; `Engine` doesn't. */
export interface TraceHost {
  /**
   * Turns the worker's feature trace on or off: while on, `traceBatch` events arrive every 250 ms of audio
   * (src/workers/vad-core.ts; the pre-gate is suspended, so Silero runs on every frame). Remembered: sent to
   * the current worker at once, and to every new worker after its `init` (restartWorker, recreation after a
   * failure, the first resume()). Turning it off flushes the partial batch.
   */
  setTrace(on: boolean): void;
}

/** A VAD backend the worker's `reset` can ask for (src/audio/messages.ts). */
export type VadBackend = Extract<MainToWorker, { t: 'reset' }>['vad'];

/**
 * Pinning the VAD backend, for the e2e test hooks only (issue #51). createEngine's result has `setVadBackend`
 * only in builds with `VITE_BEAR_TEST_HOOKS === '1'`; production builds dead-code-eliminate it, name included
 * (`pnpm build && ! grep -rq setVadBackend dist`).
 */
export interface VadBackendHost {
  /** The backend every later arm() asks the worker for; until the first call, DEFAULT_VAD_BACKEND. */
  setVadBackend?: (b: VadBackend) => void;
}

type Processed = NonNullable<ReturnType<Engine['getProcessed']>>;
type ClipChunk = Extract<WorkletToMain, { t: 'clipChunk' }>;

/** The latest completed take. */
interface Clip {
  epoch: number;
  id: number;
  pcm: Float32Array;
  sampleRate: number;
}

/** The take being collected from its clip chunks. */
interface Assembly {
  epoch: number;
  id: number;
  chunks: Float32Array[];
  length: number;
  nextSeq: number;
}

/** `navigator.mediaDevices`, which only exists in secure contexts. */
function mediaDevices(): MediaDevices | undefined {
  return 'mediaDevices' in navigator ? navigator.mediaDevices : undefined;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function postToWorklet(n: AudioWorkletNode, msg: MainToWorklet): void {
  n.port.postMessage(msg, transferList(msg));
}

function postToWorker(w: Worker, msg: MainToWorker): void {
  w.postMessage(msg, transferList(msg));
}

function concat(chunks: readonly Float32Array[], length: number): Float32Array {
  const [first] = chunks;
  if (chunks.length === 1 && first !== undefined) return first;
  const out = new Float32Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function createEngine(opts: {
  connectWorkletOutput: boolean;
  onEvent: (e: EngineEvent) => void;
}): Engine & OutputTapHost & QuietHost & TraceHost & VadBackendHost {
  const { connectWorkletOutput, onEvent } = opts;
  const emit = (e: EngineEvent): void => {
    onEvent(e);
  };

  // Plan §4.1.1 constraints; the lookup happens per call, so a missing mediaDevices becomes noDevice.
  const mic = createMicManager((c) => navigator.mediaDevices.getUserMedia(c));

  // The graph: all null until the first successful resume() has built it (context, worklet, bus, node, worker).
  let ctx: AudioContext | null = null;
  let bus: MasterBus | null = null;
  let node: AudioWorkletNode | null = null;
  let setup: Promise<AudioContext> | null = null;
  /** The node insertOutputTap() put between the bus and `destination`, if any. */
  let outputTap: AudioNode | null = null;
  let quietMode = true; // plan §4.3.4: on by default
  /** The feature trace setting (setTrace); every new worker gets it after its init. */
  let traceOn = false;
  /** The backend arm() asks the worker for (plan §4.2.3: Silero, energy while the model loads). */
  let vadBackend: VadBackend = DEFAULT_VAD_BACKEND;
  /** Set by resume(), cleared by suspend(): the latest call wins when they race with the first build. */
  let wantRunning = false;

  let worker: Worker | null = null;
  /** The worker failed (error / messageerror, or could not be created) since its last init (T17 D25). */
  let workerDead = false;

  let source: MediaStreamAudioSourceNode | null = null;
  let sourceStream: MediaStream | null = null;
  /** req of the last micGranted, for a connect failure while the graph is built later (review F6). */
  let grantedReq: number | null = null;

  let asm: Assembly | null = null;
  let clip: Clip | null = null;
  let lastProcessId: number | null = null;
  /** The sample rate each in-flight process request was sent with (the worker's reply carries none). */
  const processRates = new Map<number, number>();
  let processed: { id: number; result: Processed } | null = null;

  /** Non-empty audioinput deviceIds at the last enumeration; null until the first one. */
  let inputs: ReadonlySet<string> | null = null;
  let enumSeq = 0;
  let enumApplied = 0;

  // ---- worklet -----------------------------------------------------------------------------------------------

  function onWorkletMessage(e: MessageEvent<WorkletToMain>): void {
    const m = e.data;
    switch (m.t) {
      case 'armed':
        emit({ t: 'armed', epoch: m.epoch, armFrame: m.armFrame });
        break;
      case 'clipChunk':
        onClipChunk(m);
        break;
      case 'takeFailed':
        if (asm !== null && asm.epoch === m.epoch && asm.id === m.id) asm = null;
        emit({ t: 'takeFailed', epoch: m.epoch, id: m.id });
        break;
    }
  }

  /** Collects the chunks of the take being assembled, in seq order; other takes' chunks are ignored. */
  function onClipChunk(m: ClipChunk): void {
    const a = asm;
    if (a === null || a.epoch !== m.epoch || a.id !== m.id) return;
    if (m.seq !== a.nextSeq) {
      asm = null; // a gap would give a wrong clip; the reducer's processing timeout recovers
      return;
    }
    a.chunks.push(m.pcm);
    a.length += m.pcm.length;
    a.nextSeq++;
    if (!m.last) return;
    asm = null;
    clip = { epoch: a.epoch, id: a.id, pcm: concat(a.chunks, a.length), sampleRate: m.sampleRate };
    emit({ t: 'clipReady', epoch: a.epoch, id: a.id });
  }

  // ---- worker ------------------------------------------------------------------------------------------------

  function onWorkerMessage(e: MessageEvent<WorkerToMain>): void {
    const m = e.data;
    switch (m.t) {
      case 'seg':
        emit({ t: 'seg', epoch: m.epoch, ev: m.ev });
        break;
      case 'level':
        emit({ t: 'level', epoch: m.epoch, frame: m.frame, db: m.db, floorDb: m.floorDb });
        break;
      case 'floorSnapshot':
        emit({ t: 'floorSnapshot', epoch: m.epoch, floorDb: m.floorDb });
        break;
      case 'processed': {
        const sampleRate = processRates.get(m.id);
        if (sampleRate === undefined) return; // not a request of this worker
        processRates.delete(m.id);
        processed = {
          id: m.id,
          result: { pcm: m.pcm, sampleRate, envelope: m.envelope, durationSec: m.durationSec },
        };
        emit({ t: 'processed', id: m.id, durationSec: m.durationSec });
        break;
      }
      case 'error':
        if (m.where === 'fx') {
          if (lastProcessId !== null) {
            processRates.delete(lastProcessId);
            emit({ t: 'fxError', id: lastProcessId });
          }
        } else {
          emit({ t: 'vadError', message: m.message });
        }
        break;
      case 'vadReady':
        emit({ t: 'vadReady', backend: m.backend });
        break;
      case 'vadStats':
        emit({ t: 'vadStats', p95Ms: m.p95Ms });
        break;
      case 'traceBatch':
        emit({
          t: 'traceBatch',
          epoch: m.epoch,
          hop0Frame: m.hop0Frame,
          sil0Frame: m.sil0Frame,
          rawDb: m.rawDb,
          bandDb: m.bandDb,
          voicing: m.voicing,
          sileroP: m.sileroP,
          inferMs: m.inferMs,
        });
        break;
    }
  }

  function onWorkerFailure(): void {
    if (workerDead) return; // one failure per worker: error and messageerror may both fire
    workerDead = true;
    emit({ t: 'workerFailed' });
  }

  /** A new worker and a fresh worklet↔worker channel; `init` goes to both ends with its port transferred. */
  function startWorker(c: AudioContext, n: AudioWorkletNode): void {
    let w: Worker;
    try {
      w = new Worker(workerUrl, { type: 'module' });
    } catch {
      onWorkerFailure();
      return;
    }
    w.addEventListener('message', onWorkerMessage);
    w.addEventListener('error', onWorkerFailure);
    w.addEventListener('messageerror', onWorkerFailure);
    worker = w;
    workerDead = false;
    const ch = new MessageChannel();
    postToWorklet(n, { t: 'init', port: ch.port1 });
    postToWorker(w, { t: 'init', ctxRate: c.sampleRate, port: ch.port2 });
    if (traceOn) postToWorker(w, { t: 'trace', on: true });
  }

  /** Terminates the worker; its listeners go first, so nothing it still has queued is forwarded. */
  function stopWorker(): void {
    workerDead = false; // the failure, if any, belonged to the worker being stopped
    const w = worker;
    if (w === null) return;
    w.removeEventListener('message', onWorkerMessage);
    w.removeEventListener('error', onWorkerFailure);
    w.removeEventListener('messageerror', onWorkerFailure);
    w.terminate();
    worker = null;
    processRates.clear();
  }

  function restartWorker(): void {
    // Before the graph exists this is a no-op: the first resume() starts a worker. The worklet stays armed;
    // the new worker drops every frame until the next arm() sends it a reset.
    if (ctx === null || node === null) return;
    stopWorker();
    startWorker(ctx, node);
  }

  // ---- context -----------------------------------------------------------------------------------------------

  function onCtxError(): void {
    emit({ t: 'ctxError' });
  }

  async function buildGraph(): Promise<AudioContext> {
    // Plan §4.1.3: never pass sampleRate (a forced rate resamples the output); 'interactive' = low latency.
    const c = new AudioContext({ latencyHint: 'interactive' });
    c.addEventListener('error', onCtxError); // ctx.onerror (render errors, Chrome 128+)
    try {
      await c.audioWorklet.addModule(workletUrl);
      const b = createMasterBus(c, quietMode);
      const n = new AudioWorkletNode(c, 'capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      n.port.addEventListener('message', onWorkletMessage);
      n.port.start(); // addEventListener, unlike the onmessage setter, doesn't start the port
      if (connectWorkletOutput) n.connect(c.destination); // plan §3.2: runtime flag, default unconnected
      ctx = c;
      bus = b;
      node = n;
      startWorker(c, n);
    } catch (err) {
      c.removeEventListener('error', onCtxError);
      stopWorker();
      ctx = null;
      bus = null;
      node = null;
      void c.close().catch(() => undefined);
      throw err;
    }
    // A mic granted before the graph existed is connected now, before ctxRunning (so before any arm).
    try {
      connectSource();
    } catch {
      const req = grantedReq; // closeMicStream() clears it
      closeMicStream();
      if (req !== null) emit({ t: 'noDevice', req });
    }
    return c;
  }

  function ensureSetup(): Promise<AudioContext> {
    setup ??= buildGraph().catch((err: unknown) => {
      setup = null; // the next resume() retries from scratch
      throw err;
    });
    return setup;
  }

  async function resume(): Promise<void> {
    wantRunning = true;
    const built = ctx !== null; // recreate a dead worker only if the graph existed before this call
    let c: AudioContext;
    try {
      c = await ensureSetup();
      if (built && workerDead) restartWorker();
      if (!wantRunning) {
        await c.suspend().catch(() => undefined); // a suspend() arrived during the first build
        return;
      }
      await c.resume();
    } catch {
      emit({ t: 'ctxResumeFailed' });
      return;
    }
    if (!wantRunning) {
      // A suspend() raced this resume: no ctxRunning, and the context ends suspended (Chrome can finish the
      // pending resume after a suspend() issued while it was pending).
      await c.suspend().catch(() => undefined);
      return;
    }
    emit({ t: 'ctxRunning', sampleRate: c.sampleRate });
  }

  async function suspend(): Promise<void> {
    wantRunning = false;
    const c = ctx;
    if (c === null) return;
    try {
      await c.suspend();
    } catch {
      // A closed context has nothing to suspend.
    }
  }

  // ---- mic ---------------------------------------------------------------------------------------------------

  function connectSource(): void {
    const stream = mic.current();
    if (ctx === null || node === null || stream === null || stream === sourceStream) return;
    disconnectSource();
    const s = ctx.createMediaStreamSource(stream);
    s.connect(node);
    source = s;
    sourceStream = stream;
  }

  function disconnectSource(): void {
    source?.disconnect();
    source = null;
    sourceStream = null;
  }

  function closeMicStream(): void {
    mic.close();
    disconnectSource();
    grantedReq = null;
  }

  function onMicResult(r: MicResult | { t: 'stale'; req: number }): void {
    switch (r.t) {
      case 'stale':
        return;
      case 'micDenied':
        emit({ t: 'micDenied', req: r.req });
        return;
      case 'noDevice':
        emit({ t: 'noDevice', req: r.req });
        return;
      case 'micGranted': {
        if (mic.current() !== r.stream) return; // closed or replaced before this ran: stale
        grantedReq = r.req;
        try {
          connectSource();
        } catch {
          closeMicStream();
          emit({ t: 'noDevice', req: r.req });
          return;
        }
        emit({ t: 'micGranted', req: r.req });
        // T17 F6/D24: report the new track's initial mute state, so micMuted can't go stale across a reopen.
        const muted = r.stream.getAudioTracks().some((track) => track.muted);
        emit(muted ? { t: 'trackMuted' } : { t: 'trackUnmuted' });
        void refreshInputs(false); // the devicechange baseline, now that deviceIds are exposed
        return;
      }
    }
  }

  mic.onTrackEvent((e) => {
    switch (e) {
      case 'mute':
        emit({ t: 'trackMuted' });
        break;
      case 'unmute':
        emit({ t: 'trackUnmuted' });
        break;
      case 'endedExternally':
        emit({ t: 'trackEnded' });
        break;
    }
  });

  // ---- devicechange (plan §4.5: compare the set of input ids; never pick inputs by position or label) ------

  async function refreshInputs(report: boolean): Promise<void> {
    const devices = mediaDevices();
    if (devices === undefined) return;
    const seq = ++enumSeq;
    let list: MediaDeviceInfo[];
    try {
      list = await devices.enumerateDevices();
    } catch {
      return;
    }
    if (seq < enumApplied) return; // a later enumeration already landed
    enumApplied = seq;
    const next = new Set<string>();
    for (const d of list) if (d.kind === 'audioinput' && d.deviceId !== '') next.add(d.deviceId);
    const prev = inputs;
    inputs = next;
    if (report && prev !== null && !sameSet(prev, next)) emit({ t: 'inputsChanged' });
  }

  mediaDevices()?.addEventListener('devicechange', () => {
    void refreshInputs(true);
  });

  // ---- the Engine --------------------------------------------------------------------------------------------

  const api: Engine & OutputTapHost & QuietHost & TraceHost & VadBackendHost = {
    resume,
    suspend,
    openMic(req: number): void {
      void mic.open(req).then(onMicResult);
    },
    closeMic(): void {
      closeMicStream();
      asm = null;
      clip = null;
      processed = null; // no captured audio outlives the mic
      processRates.clear(); // so a late processed reply can't bring it back
    },
    arm(epoch: number, restoreFloorDb?: number): void {
      // Epochs come from the reducer's integer counter. The worker's reset goes out before the worklet's arm.
      if (worker !== null) {
        postToWorker(worker, {
          t: 'reset',
          epoch,
          vad: vadBackend,
          restoreFloorDb,
          pregate: PREGATE_ENABLED,
        });
      }
      if (node !== null) postToWorklet(node, { t: 'arm', epoch });
    },
    disarm(epoch: number): void {
      if (node !== null) postToWorklet(node, { t: 'disarm', epoch });
    },
    take(epoch: number, id: number, fromFrame: number, toFrame: number): void {
      clip = null;
      asm = null;
      const valid =
        Number.isSafeInteger(epoch) &&
        Number.isSafeInteger(id) &&
        Number.isSafeInteger(fromFrame) &&
        Number.isSafeInteger(toFrame);
      // The worklet ignores a malformed take silently, so fail it here instead of leaving the reducer waiting.
      if (!valid || node === null) {
        emit({ t: 'takeFailed', epoch, id });
        return;
      }
      asm = { epoch, id, chunks: [], length: 0, nextSeq: 0 };
      postToWorklet(node, { t: 'take', epoch, id, fromFrame, toFrame });
    },
    process(id: number, preset: VoicePreset): void {
      lastProcessId = id;
      const c = clip;
      const w = worker;
      if (c === null || c.id !== id || w === null || workerDead) {
        emit({ t: 'fxError', id });
        return;
      }
      clip = null; // the pcm is transferred to the worker
      processRates.set(id, c.sampleRate);
      postToWorker(w, { t: 'process', id, pcm: c.pcm, sampleRate: c.sampleRate, preset });
    },
    getProcessed(id: number): Processed | undefined {
      return processed !== null && processed.id === id ? processed.result : undefined;
    },
    releaseProcessed(id: number): void {
      if (processed !== null && processed.id === id) processed = null;
    },
    getClip(epoch: number, id: number): Float32Array | undefined {
      return clip !== null && clip.epoch === epoch && clip.id === id ? clip.pcm : undefined;
    },
    restartWorker,
    reselectInput(): void {
      // M8: Bluetooth policy (X-E4)
    },
    context(): AudioContext | null {
      return ctx;
    },
    masterBus(): AudioNode | null {
      return bus === null ? null : bus.input;
    },
    insertOutputTap(tap: AudioNode): void {
      if (ctx === null || bus === null) throw new Error('insertOutputTap: the audio graph is not built yet');
      if (outputTap !== null) throw new Error('insertOutputTap: an output tap is already inserted');
      bus.output.disconnect(ctx.destination);
      bus.output.connect(tap);
      tap.connect(ctx.destination);
      outputTap = tap;
    },
    setQuiet(on: boolean): void {
      quietMode = on;
      bus?.setQuiet(on);
    },
    setTrace(on: boolean): void {
      traceOn = on;
      if (worker !== null) postToWorker(worker, { t: 'trace', on });
    },
  };
  // Only the e2e build can pin the backend (issue #51): production builds drop this branch, as main.ts's hooks.
  if (import.meta.env.VITE_BEAR_TEST_HOOKS === '1') {
    api.setVadBackend = (b: VadBackend): void => {
      vadBackend = b;
    };
  }
  return api;
}
