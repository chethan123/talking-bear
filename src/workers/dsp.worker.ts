/// <reference lib="webworker" />
// DSP worker glue (plan §3.1, §3.3). Wires the main thread's messages and the worklet's MessagePort to a
// VadCore, and answers `process` (M1: the clip is echoed unchanged; the voice chain replaces this in M3).
// Every handler is wrapped, so an exception becomes an `error` message instead of killing the worker.
//
// Silero (plan §4.2.3): the first successful `init` starts loading the shipped weights (weights.bin, which Vite
// emits as a hashed asset next to this chunk). Once decoded, the model is handed to the current VadCore and
// `vadReady` is posted; a later `init` reuses it. Until then, and if loading fails, epochs that ask for Silero
// run on the energy backend.

import {
  transferList,
  type MainToWorker,
  type WorkerToMain,
  type WorkletToWorker,
} from '../audio/messages.ts';
import { createSilero, type SileroModel } from '../dsp/silero/model.ts';
import { decodeWeights } from '../dsp/silero/weights.ts';
import { emptyEnvelope } from '../dsp/types.ts';
import { VadCore } from './vad-core.ts';

declare const self: DedicatedWorkerGlobalScope;

/** The shipped Silero weights (fp16, conv biases fp32; see src/dsp/silero/weights.ts). */
const WEIGHTS_URL = new URL('../dsp/silero/weights.bin', import.meta.url);

let core: VadCore | null = null;
let port: MessagePort | null = null;
/** The decoded Silero model, once loaded; shared by every VadCore of this worker (one is active at a time). */
let model: SileroModel | null = null;
/** A weights fetch is in flight. */
let loading = false;

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

/** Fetches and decodes the weights once; a failure is reported, and the next `init` tries again. */
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
        core.reset(msg.epoch, msg.vad, msg.restoreFloorDb, msg.pregate);
      } catch (err) {
        postError('vad', err);
      }
      break;
    case 'process':
      try {
        post({
          t: 'processed',
          id: msg.id,
          pcm: msg.pcm,
          envelope: emptyEnvelope(),
          durationSec: msg.pcm.length / msg.sampleRate / msg.preset.pitchRatio,
        });
      } catch (err) {
        postError('fx', err);
      }
      break;
  }
}

self.addEventListener('message', onMainMessage);
