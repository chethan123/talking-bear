/// <reference lib="webworker" />
// DSP worker glue (plan §3.1, §3.3). Wires the main thread's messages and the worklet's MessagePort to a
// VadCore, and answers `process` with the voice chain, processVoice (plan §4.3.4): the reply's buffers (the
// processed pcm and the four envelope tracks) are transferred, never copied.
// Every handler is wrapped, so an exception becomes an `error` message instead of killing the worker.
//
// Silero (plan §4.2.3): the first successful `init` starts loading the shipped weights (weights.bin, which Vite
// emits as a hashed asset next to this chunk). Once decoded, the model is handed to the current VadCore and
// `vadReady` is posted; a later `init` reuses it. Until then, and if loading fails, epochs that ask for Silero
// run on the energy backend. A failed load is retried by the next `reset` that asks for Silero while no model
// is set (#251), and by the next `init`: no timer, at most one attempt per Silero re-arm, and never a second
// fetch while one is in flight.
//
// Feature trace (`trace`): the setting is kept here and handed to every VadCore, so it survives a later
// `init`; the VadCore posts the `traceBatch` messages, whose five stream buffers are transferred.

import {
  transferList,
  type MainToWorker,
  type WorkerToMain,
  type WorkletToWorker,
} from '../audio/messages.ts';
import { createSilero, type SileroModel } from '../dsp/silero/model.ts';
import { decodeWeights } from '../dsp/silero/weights.ts';
import { processVoice } from '../dsp/voice.ts';
import { VadCore } from './vad-core.ts';

declare const self: DedicatedWorkerGlobalScope;

/** The shipped Silero weights (fp16 or fp32 per tensor; see src/dsp/silero/weights.ts). */
const WEIGHTS_URL = new URL('../dsp/silero/weights.bin', import.meta.url);

let core: VadCore | null = null;
let port: MessagePort | null = null;
/** The decoded Silero model, once loaded; shared by every VadCore of this worker (one is active at a time). */
let model: SileroModel | null = null;
/** A weights fetch is in flight. */
let loading = false;
/** The feature trace is on (the last `trace` message). */
let traceOn = false;

function post(msg: WorkerToMain): void {
  self.postMessage(msg, transferList(msg));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function postError(where: 'vad' | 'fx', err: unknown): void {
  post({ t: 'error', where, message: errorMessage(err) });
}

/** Hands the model to `c` (which may switch its current epoch to Silero at once), then reports it. */
function attachModel(c: VadCore, m: SileroModel): void {
  c.setModel(m);
  post({ t: 'vadReady', backend: 'silero' });
}

/** Fetches and decodes the weights unless the model is set or a load is in flight, so at most one fetch is ever
 *  in flight. A failure is reported; the next Silero `reset` (or `init`) tries again. */
function loadModel(): void {
  if (loading || model !== null) return;
  loading = true;
  void fetch(WEIGHTS_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    })
    .then((buf) => {
      const m = createSilero(decodeWeights(buf));
      loading = false;
      model = m;
      if (core !== null) attachModel(core, m);
    })
    .catch((err: unknown) => {
      loading = false; // before posting, so a retry can start as soon as the error is seen
      post({ t: 'error', where: 'vad', message: `silero weights failed to load: ${errorMessage(err)}` });
    });
}

function onFrame(e: MessageEvent<WorkletToWorker>): void {
  try {
    const msg = e.data;
    if (msg.t === 'frame' && core !== null) core.frame(msg.epoch, msg.firstFrame, msg.pcm16k);
  } catch (err) {
    postError('vad', err);
  }
}

/** A new VadCore on the given channel. A later init replaces both; the previous port is closed. On failure
 *  (a bad ctxRate) the new port is closed and the previous wiring stays. */
function init(ctxRate: number, next: MessagePort): void {
  let nextCore: VadCore;
  try {
    nextCore = new VadCore(ctxRate, post);
  } catch (err) {
    next.close();
    throw err;
  }
  if (port !== null) {
    port.removeEventListener('message', onFrame);
    port.close();
  }
  core = nextCore;
  port = next;
  port.addEventListener('message', onFrame);
  port.start(); // addEventListener, unlike the onmessage setter, doesn't start the port's message queue
  if (traceOn) nextCore.setTrace(true);
  if (model !== null) attachModel(nextCore, model);
  else loadModel();
}

function onMainMessage(e: MessageEvent<MainToWorker>): void {
  const msg = e.data;
  switch (msg.t) {
    case 'init':
      try {
        init(msg.ctxRate, msg.port);
      } catch (err) {
        postError('vad', err);
      }
      break;
    case 'reset':
      try {
        if (core === null) throw new Error('reset before init');
        core.reset(msg.epoch, msg.vad, msg.restoreFloorDb, msg.pregate, msg.proximityDb, msg.marginBoostDb);
        // A Silero epoch without a model runs on energy: retry a failed load (#251). Once it lands, setModel
        // switches this epoch to Silero if its segmenter is still idle.
        if (msg.vad === 'silero') loadModel();
      } catch (err) {
        postError('vad', err);
      }
      break;
    case 'trace':
      try {
        traceOn = msg.on;
        core?.setTrace(traceOn);
      } catch (err) {
        postError('vad', err);
      }
      break;
    case 'process':
      try {
        const r = processVoice(msg.pcm, msg.sampleRate, msg.preset);
        post({
          t: 'processed',
          id: msg.id,
          pcm: r.pcm,
          envelope: r.envelope,
          durationSec: r.durationSec,
          clipped: r.clipped,
        });
      } catch (err) {
        postError('fx', err);
      }
      break;
  }
}

self.addEventListener('message', onMainMessage);
