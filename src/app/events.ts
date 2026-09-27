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
export type Overlay = 'tapToWake' | 'parentPermission' | 'micHelp' | 'micMuted' | 'tooNoisy' | 'error' | null;

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
  | { t: 'processed'; id: number; durationSec: number }
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
  | { t: 'updateReady' };
export type EventType = SessionEvent['t'];

// Plan §3.3, plus `seq` on sfx and `applyUpdate`.
export type Effect =
  | { k: 'openMic'; req: number }
  | { k: 'closeMic' } // invalidates every pending openMic request
  | { k: 'resumeCtx' }
  | { k: 'suspendCtx' }
  | { k: 'restartWorker' }
  | { k: 'arm'; epoch: number; restoreFloorDb?: number }
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
  capHits: number;
  sfxSeq: number;
  sfxEndedSeq: number;
  updateReady: boolean;
  preset: VoicePreset;
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
