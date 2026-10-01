// Structured-clone message protocol between the main thread, the capture worklet and the DSP worker
// (plan §3.3). All audio buffers are transferred, never copied: build the transfer list with `transferList`.
// Every message that belongs to a listen carries its epoch; the reducer ignores stale epochs/ids (plan §3.1).

import type { SegEvent } from '../dsp/segmenter.ts';
import type { Envelope, VoicePreset } from '../dsp/types.ts';

export type MainToWorklet =
  | { t: 'arm'; epoch: number } // start the 16 kHz VAD feed
  | { t: 'disarm'; epoch: number } // stop it; the ring keeps recording
  | { t: 'take'; epoch: number; id: number; fromFrame: number; toFrame: number } // deferred until currentFrame ≥ toFrame
  // Hands the worklet its end of the worklet↔worker channel (transferred). A later init replaces the port,
  // which is how the worker gets restarted.
  | { t: 'init'; port: MessagePort };
// Sent over the MessagePort handed to both at startup (the `init` messages).
export type WorkletToWorker = {
  t: 'frame';
  epoch: number;
  firstFrame: number; // ctx-rate index of pcm16k[0], group delay removed
  pcm16k: Float32Array; // 512 samples at VAD_RATE
};
export type WorkletToMain =
  | { t: 'armed'; epoch: number; armFrame: number }
  | {
      t: 'clipChunk';
      epoch: number;
      id: number;
      seq: number;
      last: boolean;
      pcm: Float32Array;
      sampleRate: number;
    }
  | { t: 'takeFailed'; epoch: number; id: number; reason: 'evicted' };
export type MainToWorker =
  // New listen: reset the segmenter, the LSTM and the history. `pregate`: skip Silero inference while the energy
  // gate is closed and the segmenter idle (plan §4.2.3; off unless true).
  | { t: 'reset'; epoch: number; vad: 'silero' | 'energy'; restoreFloorDb?: number; pregate?: boolean }
  | { t: 'process'; id: number; pcm: Float32Array; sampleRate: number; preset: VoicePreset }
  // The context sample rate and the worker's end of the worklet↔worker channel (transferred).
  | { t: 'init'; ctxRate: number; port: MessagePort };
export type WorkerToMain =
  | { t: 'seg'; epoch: number; ev: SegEvent } // frames in ctx-rate indices
  | { t: 'level'; epoch: number; frame: number; db: number; floorDb: number } // ~30 Hz, UI/debug
  | { t: 'floorSnapshot'; epoch: number; floorDb: number } // taken at onset, restored at re-arm
  | { t: 'vadStats'; p95Ms: number }
  | { t: 'vadReady'; backend: 'silero' } // the worker's Silero model is loaded and set
  | { t: 'processed'; id: number; pcm: Float32Array; envelope: Envelope; durationSec: number }
  | { t: 'error'; where: 'vad' | 'fx'; message: string };

/** Every message of the protocol, in any direction. */
export type AudioMessage = MainToWorklet | WorkletToWorker | WorkletToMain | MainToWorker | WorkerToMain;

export type Transfer = Transferable[];

/**
 * The objects `msg` must transfer: the `pcm` / `pcm16k` buffers, the `port` of `init`, and the envelope
 * track buffers of `processed`. Pass the result as the transfer list of `postMessage`.
 *
 * A view's whole underlying `ArrayBuffer` is transferred (and detached), so never send a view of a buffer
 * you keep using. A buffer shared by several views is listed once, because a duplicate entry makes
 * `postMessage` throw `DataCloneError`. A `SharedArrayBuffer` is shared, not transferred, so it is skipped.
 */
export function transferList(msg: AudioMessage): Transfer {
  const out: Transfer = [];
  switch (msg.t) {
    case 'init':
      out.push(msg.port);
      break;
    case 'frame':
      addBuffer(out, msg.pcm16k);
      break;
    case 'clipChunk':
    case 'process':
      addBuffer(out, msg.pcm);
      break;
    case 'processed':
      addBuffer(out, msg.pcm);
      addBuffer(out, msg.envelope.jaw);
      addBuffer(out, msg.envelope.width);
      addBuffer(out, msg.envelope.round);
      addBuffer(out, msg.envelope.teeth);
      break;
    case 'arm':
    case 'disarm':
    case 'take':
    case 'armed':
    case 'takeFailed':
    case 'reset':
    case 'seg':
    case 'level':
    case 'floorSnapshot':
    case 'vadStats':
    case 'vadReady':
    case 'error':
      break;
    default:
      return unknownMessage(msg);
  }
  return out;
}

function addBuffer(out: Transfer, view: Float32Array): void {
  const buffer = view.buffer;
  if (buffer instanceof ArrayBuffer && !out.includes(buffer)) out.push(buffer);
}

// A new message kind must get a case above: this call stops type-checking until it does.
function unknownMessage(msg: never): never {
  throw new TypeError(`transferList: unknown message kind ${String((msg as { t?: unknown }).t)}`);
}
