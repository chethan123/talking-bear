/// <reference lib="webworker" />
// DSP worker glue (plan §3.1, §3.3). Wires the main thread's messages and the worklet's MessagePort to a
// VadCore, and answers `process` (M1: the clip is echoed unchanged; the voice chain replaces this in M3).
// Every handler is wrapped, so an exception becomes an `error` message instead of killing the worker.

import {
  transferList,
  type MainToWorker,
  type WorkerToMain,
  type WorkletToWorker,
} from '../audio/messages.ts';
import { emptyEnvelope } from '../dsp/types.ts';
import { VadCore } from './vad-core.ts';

declare const self: DedicatedWorkerGlobalScope;

let core: VadCore | null = null;
let port: MessagePort | null = null;

function post(msg: WorkerToMain): void {
  self.postMessage(msg, transferList(msg));
}

function postError(where: 'vad' | 'fx', err: unknown): void {
  post({ t: 'error', where, message: err instanceof Error ? err.message : String(err) });
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
        core.reset(msg.epoch, msg.vad, msg.restoreFloorDb);
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
