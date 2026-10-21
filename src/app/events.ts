// Session events, effects and state for the pure session reducer in machine.ts (plan §3.3, §3.4; issue #28).
// The reducer consumes `SessionEvent`s and returns `Effect`s; the effect runner (effects.ts) executes them.

import type { SfxId } from '../audio/sfx-ids.ts';
import type { SegEvent } from '../dsp/segmenter.ts';
import type { VoicePreset } from '../dsp/types.ts';
import { MAX_UTTERANCE_MS, PREROLL_MS, TAIL_MS } from '../audio/constants.ts';

export type StateName =
  | 'Asleep'
  | 'NeedsParent'
  | 'Waking'
  | 'MicDenied'
  | 'Listening'
  | 'Recording'
  | 'Processing'
  | 'Playing'
  | 'SfxGated'
  | 'Cooldown'
  | 'Paused'
  | 'Error';
export type Permission = 'granted' | 'prompt' | 'denied';
export type TimerName = 'cooldown' | 'sleep' | 'doze' | 'processing' | 'waking' | 'recording';
export type { SfxId }; // single declaration in src/audio/sfx-ids.ts; extended in M5
export type Priority = 1 | 2 | 3 | 4;
export type AnimEvent =
  | { e: 'wake' }
  | { e: 'sleep' }
  | { e: 'doze' }
  | { e: 'idle' }
  | { e: 'attentive' }
  | { e: 'thinking' }
  | { e: 'talk'; id: number }
  | { e: 'talkEnd' }
  | { e: 'confused' }
  | { e: 'earTwitch' }
  | { e: 'shrug' }
  | { e: 'reaction'; name: string; priority: Priority };
export type Overlay =
  | 'tapToWake'
  | 'parentPermission'
  | 'micHelp'
  | 'micMuted'
  | 'tooNoisy'
  | 'holdToTalk' // #116: the hold-to-talk button (Listening and Recording in hold-to-talk mode)
  | 'error'
  | null;

export type SessionEvent =
  | { t: 'tapBear' }
  | { t: 'parentContinue' }
  | { t: 'settingsRetry' }
  | { t: 'permissionChanged'; state: Permission }
  | { t: 'micGranted'; req: number }
  | { t: 'micDenied'; req: number }
  | { t: 'noDevice'; req: number }
  | { t: 'ctxRunning'; sampleRate: number }
  | { t: 'ctxResumeFailed' }
  | { t: 'ctxError' }
  | { t: 'armed'; epoch: number; armFrame: number }
  | { t: 'seg'; epoch: number; ev: SegEvent }
  | { t: 'floorSnapshot'; epoch: number; floorDb: number }
  | { t: 'clipReady'; epoch: number; id: number }
  | { t: 'takeFailed'; epoch: number; id: number }
  // `clipped`: the worker's clipping flag (plan §4.4): the take had ≥ 0.1 % of its samples at |x| > 0.99 (#117).
  | { t: 'processed'; id: number; durationSec: number; clipped: boolean }
  | { t: 'fxError'; id: number }
  | { t: 'playbackAtSpeakerEnded'; id: number }
  | { t: 'sfxAtSpeakerEnded'; seq: number }
  | { t: 'reaction'; name: string; priority: Priority; sfx: SfxId | null }
  | { t: 'timer'; name: TimerName }
  | { t: 'trackMuted' }
  | { t: 'trackUnmuted' }
  | { t: 'trackEnded' }
  | { t: 'inputsChanged' }
  | { t: 'workerFailed' }
  | { t: 'hidden' }
  | { t: 'pagehide' }
  | { t: 'freeze' }
  | { t: 'visible' }
  | { t: 'updateReady'; activated?: true } // activated: another tab activated the update (#277)
  // M3 settings (issue #66): the voice preset the next `process` uses. Every state updates `preset`, no effects.
  | { t: 'settingsChanged'; preset: VoicePreset }
  // #116, #289, plan §4.4: the background level estimate (effects.ts: at most once per second, from Listening
  // levels and from Recording levels after NOISE_FLOOR_RECORDING_HOLDOFF_MS); every state updates `tooNoisy`.
  | { t: 'noiseFloor'; floorDb: number }
  // #116: the hold-to-talk button pressed / released, at ctx frame `frame` (the capture worklet's frame clock).
  | { t: 'holdStart'; frame: number }
  | { t: 'holdEnd'; frame: number };
export type EventType = SessionEvent['t'];

// Plan §3.3, plus `seq` on sfx and `applyUpdate`.
export type Effect =
  | { k: 'openMic'; req: number }
  | { k: 'closeMic' } // invalidates every pending openMic request
  | { k: 'resumeCtx' }
  | { k: 'suspendCtx' }
  | { k: 'restartWorker' }
  | { k: 'arm'; epoch: number; restoreFloorDb?: number; marginBoostDb?: number } // marginBoostDb: only when > 0
  | { k: 'disarm'; epoch: number }
  | { k: 'take'; epoch: number; id: number; fromFrame: number; toFrame: number }
  | { k: 'process'; id: number; preset: VoicePreset }
  | { k: 'play'; id: number }
  | { k: 'stopPlayback' } // stops the replay and every sfx
  | { k: 'timer'; name: TimerName; ms: number } // replaces any pending timer with that name
  | { k: 'cancelTimer'; name: TimerName | '*' }
  | { k: 'wakeLock'; on: boolean }
  | { k: 'anim'; ev: AnimEvent }
  | { k: 'sfx'; id: SfxId; seq: number }
  | { k: 'reselectInput' }
  | { k: 'ui'; show: Overlay }
  | { k: 'applyUpdate' };

export interface SessionState {
  name: StateName;
  permission: Permission;
  epoch: number;
  armFrame: number | null;
  onsetFrame: number | null;
  floorDb: number | undefined;
  takeId: number;
  playingId: number | null;
  micReq: number;
  micGranted: boolean;
  ctxRunning: boolean;
  sampleRate: number;
  micMuted: boolean;
  reselectPending: boolean;
  workerRestarts: number;
  /**
   * #116, plan §4.4: consecutive capped takes with a low voiced ratio (row 20's noisy counter), and capped energy
   * misfires with one (row 21, #289). At 3 the margins rise (`marginBoostDb`), then hold-to-talk takes over.
   */
  noisyCaps: number;
  /** #116: the latest `noiseFloor` was above −35 dBFS; Listening and Recording show the too-noisy badge (#289). */
  tooNoisy: boolean;
  /** #116: the dB the worker adds to its energy margins and proximity X, carried by every Listening `arm`. */
  marginBoostDb: 0 | 3 | 6;
  /** #116: hold-to-talk mode: `seg` events are ignored and the hold button records. Entering Asleep clears it. */
  holdToTalk: boolean;
  sfxSeq: number;
  sfxEndedSeq: number;
  /** A MicDenied reaction played an sfx since the last Waking completion (D22). */
  micDeniedSfx: boolean;
  updateReady: boolean;
  /**
   * Another tab activated the update: this page runs old code, so an Asleep wake reloads it instead (#277).
   * Implies `updateReady`; only C11 clears it.
   */
  updateActivated: boolean;
  preset: VoicePreset;
  /** #117: the latest accepted `processed` take was clipped; row 28 then adds the tooLoud reaction. */
  lastClipped: boolean;
}

export interface SessionConfig {
  tSleepMs: number;
  tDozeMs: number;
  cooldownMs: number;
  wakingMs: number;
  processingMs: number;
  maxUtteranceMs: number;
  preRollMs: number;
  tailMs: number;
}

// The shared audio constants are the single source for the three audio values (same numbers as issue #28).
export const DEFAULT_CONFIG: SessionConfig = {
  tSleepMs: 120_000, // Q1: sleep after 2 min with no speech or touch
  tDozeMs: 45_000, // Q1: doze visuals from 45 s
  cooldownMs: 250,
  wakingMs: 5_000,
  processingMs: 2_000,
  maxUtteranceMs: MAX_UTTERANCE_MS,
  preRollMs: PREROLL_MS,
  tailMs: TAIL_MS,
};
