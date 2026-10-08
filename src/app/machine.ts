// The session state machine: a pure reducer `reduce(state, event, config) → { state, effects }` implementing
// plan §3.4 (rows 1–46, 3b, 3c, 35b, 40b, entry/exit actions) with the clarifications C1–C12 of issue #28.
// Pure: no I/O, no time, never mutates its input. Handlers return the same state object when nothing changes.
//
// Effect order for a transition: (1) the old state's exit actions, (2) the row's effects, (3) the new state's
// entry actions (`disarm` first when leaving ARMED), (4) derived effects: `wakeLock` (C1), then `ui` (C2).
// `reduce` then appends `applyUpdate` last when a hide event leaves the machine in Asleep or Paused (C11), and an
// Asleep tap or settings retry after another tab's update emits only `applyUpdate` (#277, row 3c).
//
// Noisy room (#116, plan §4.4, and the ORCH-NOTE on #116): `noiseFloor` sets `tooNoisy` (floor > −35 dBFS), which
// Listening shows as a badge. Three consecutive capped takes with a voiced ratio below 0.3 raise the worker's
// margins by 3 dB (to 6 at most), then switch to hold-to-talk: `seg` events are ignored in Listening and
// Recording, and the hold button's `holdStart` / `holdEnd` record instead (rows 13b, 20b, 20c). A nap clears it.

import { ONSET_BLOCK_MS } from '../audio/constants.ts';
import type { SegEvent } from '../dsp/segmenter.ts';
import { PRESETS } from '../dsp/types.ts';
import {
  DEFAULT_CONFIG,
  type AnimEvent,
  type Effect,
  type EventType,
  type Overlay,
  type Permission,
  type SessionConfig,
  type SessionEvent,
  type SessionState,
  type StateName,
  type TimerName,
} from './events.ts';

/** Mic stream open (plan §3.4 groups). */
export const MIC_OPEN: ReadonlySet<StateName> = new Set<StateName>([
  'Waking',
  'Listening',
  'Recording',
  'Processing',
  'Playing',
  'SfxGated',
  'Cooldown',
]);
/** Awake = mic-open states plus MicDenied. */
export const AWAKE: ReadonlySet<StateName> = new Set<StateName>([...MIC_OPEN, 'MicDenied']);
/** The VAD feed is armed. */
export const ARMED: ReadonlySet<StateName> = new Set<StateName>(['Listening', 'Recording']);
/** Mic gated: the VAD feed is stopped. */
export const GATED: ReadonlySet<StateName> = new Set<StateName>([
  'Processing',
  'Playing',
  'SfxGated',
  'Cooldown',
]);
/** The screen wake lock is held (C1). */
export const WAKE_LOCK_HELD: ReadonlySet<StateName> = new Set<StateName>([...MIC_OPEN, 'NeedsParent']);

/** Plan §3.4: the recording watchdog is `maxUtterance + 2 s`. */
const RECORDING_WATCHDOG_EXTRA_MS = 2000;
/** #116, plan §4.4: a `noiseFloor` above this (dBFS) means too noisy. */
export const TOO_NOISY_FLOOR_DB = -35;
/** #116: a capped take whose voiced ratio is below this counts as noise. */
export const NOISY_VOICED_RATIO = 0.3;
/** #116: this many consecutive noisy caps raise the margins (or, at the top boost, switch to hold-to-talk). */
export const NOISY_CAPS = 3;
/** #116: each raise adds this many dB (0 → 3 → 6). */
export const MARGIN_STEP_DB = 3;
const HIDE_EVENTS: ReadonlySet<EventType> = new Set<EventType>(['hidden', 'pagehide', 'freeze']);

export function initialSessionState(permission: Permission): SessionState {
  return {
    name: 'Asleep',
    permission,
    epoch: 0,
    armFrame: null,
    onsetFrame: null,
    floorDb: undefined,
    takeId: 0,
    playingId: null,
    micReq: 0,
    micGranted: false,
    ctxRunning: false,
    sampleRate: 48000,
    micMuted: false,
    reselectPending: false,
    workerRestarts: 0,
    noisyCaps: 0,
    tooNoisy: false,
    marginBoostDb: 0,
    holdToTalk: false,
    sfxSeq: 0,
    sfxEndedSeq: 0,
    micDeniedSfx: false,
    updateReady: false,
    updateActivated: false,
    preset: PRESETS.cub,
  };
}

/**
 * The overlay a state shows (C2). Listening: the mic-muted badge, else the hold-to-talk button in hold-to-talk
 * mode, else the too-noisy badge (#116). Recording keeps the hold button while it is held (ORCH-NOTE on #116).
 */
export function overlayFor(s: Pick<SessionState, 'name' | 'micMuted' | 'tooNoisy' | 'holdToTalk'>): Overlay {
  switch (s.name) {
    case 'Asleep':
      return 'tapToWake';
    case 'NeedsParent':
      return 'parentPermission';
    case 'MicDenied':
      return 'micHelp';
    case 'Error':
      return 'error';
    case 'Listening':
      return s.micMuted ? 'micMuted' : s.holdToTalk ? 'holdToTalk' : s.tooNoisy ? 'tooNoisy' : null;
    case 'Recording':
      return s.holdToTalk ? 'holdToTalk' : null;
    default:
      return null;
  }
}

type Out = { state: SessionState; effects: Effect[] };
type EventOf<E extends EventType> = Extract<SessionEvent, { t: E }>;
/** A row handler for events of type `E`. It receives the event narrowed to `E`. */
export type Handler<E extends EventType = EventType> = (
  s: SessionState,
  e: EventOf<E>,
  cfg: SessionConfig,
) => { state: SessionState; effects: Effect[] };
type Row = { readonly [E in EventType]: Handler<E> | 'ignore' };

// ---- effect constructors (fresh objects every call) ----------------------------------------------------
const timer = (name: TimerName, ms: number): Effect => ({ k: 'timer', name, ms });
const cancel = (name: TimerName | '*'): Effect => ({ k: 'cancelTimer', name });
const anim = (ev: AnimEvent): Effect => ({ k: 'anim', ev });
const framesOf = (ms: number, sampleRate: number): number => Math.round((ms * sampleRate) / 1000);
const sfxAudible = (s: SessionState): boolean => s.sfxSeq > s.sfxEndedSeq; // C5

// ---- state helpers ---------------------------------------------------------------------------------------
/** `s` with `p` applied; `s` itself when `p` changes nothing. */
function patch(s: SessionState, p: Partial<SessionState>): SessionState {
  const next: SessionState = { ...s, ...p };
  // Spreading keeps the key order of `s`, so the values line up index by index.
  const before = Object.values(s);
  const after = Object.values(next);
  if (before.length !== after.length) return next;
  return before.some((v, i) => !Object.is(v, after[i])) ? next : s;
}

const same = (s: SessionState): Out => ({ state: s, effects: [] });

/** C1 then C2: derived from the group and overlay change between `prev` and `next`. */
function derived(prev: SessionState, next: SessionState): Effect[] {
  const fx: Effect[] = [];
  const held = WAKE_LOCK_HELD.has(next.name);
  if (WAKE_LOCK_HELD.has(prev.name) !== held) fx.push({ k: 'wakeLock', on: held });
  const show = overlayFor(next);
  if (overlayFor(prev) !== show) fx.push({ k: 'ui', show });
  return fx;
}

/** A row that stays in the same state: no exit or entry actions; derived effects still apply (row 18). */
function stay(s: SessionState, p: Partial<SessionState> = {}, rowEffects: Effect[] = []): Out {
  const next = patch(s, p);
  return { state: next, effects: [...rowEffects, ...derived(s, next)] };
}

function exitActions(from: StateName): Effect[] {
  switch (from) {
    case 'Listening':
      return [cancel('sleep'), cancel('doze')];
    case 'Recording':
      return [cancel('recording')];
    case 'Waking':
      return [cancel('waking')];
    case 'Processing':
      return [cancel('processing')];
    case 'Cooldown':
      return [cancel('cooldown')];
    case 'NeedsParent':
    case 'MicDenied':
    case 'Error':
      return [cancel('sleep')];
    case 'Playing':
      return [anim({ e: 'talkEnd' })];
    default: // Asleep, SfxGated, Paused
      return [];
  }
}

function entryActions(to: StateName, st: SessionState, cfg: SessionConfig): [SessionState, Effect[]] {
  switch (to) {
    case 'Listening': {
      const epoch = st.epoch + 1;
      // #116: the arm carries the worker's raised margins when there are any, as it carries a known floor.
      const boost = st.marginBoostDb;
      const arm: Effect =
        st.floorDb === undefined
          ? boost > 0
            ? { k: 'arm', epoch, marginBoostDb: boost }
            : { k: 'arm', epoch }
          : boost > 0
            ? { k: 'arm', epoch, restoreFloorDb: st.floorDb, marginBoostDb: boost }
            : { k: 'arm', epoch, restoreFloorDb: st.floorDb };
      return [
        { ...st, epoch, armFrame: null, onsetFrame: null },
        [arm, timer('sleep', cfg.tSleepMs), timer('doze', cfg.tDozeMs), anim({ e: 'idle' })],
      ];
    }
    case 'Recording':
      // In hold-to-talk mode the timer is the cap itself (row 20c): fired 2 s later, the take would start
      // 12.3 s back, beyond the 12 s ring (ORCH-NOTE on #116).
      return [
        st,
        [timer('recording', st.holdToTalk ? cfg.maxUtteranceMs : cfg.maxUtteranceMs + RECORDING_WATCHDOG_EXTRA_MS)],
      ];
    case 'Processing':
      return [st, [timer('processing', cfg.processingMs)]];
    case 'Cooldown':
      return [st, [timer('cooldown', cfg.cooldownMs)]];
    case 'Waking': {
      const micReq = st.micReq + 1;
      return [
        // #116: a new stream (or input) is a new measurement, so the too-noisy flag starts clear.
        { ...st, micReq, micGranted: false, tooNoisy: false },
        [{ k: 'openMic', req: micReq }, timer('waking', cfg.wakingMs)],
      ];
    }
    case 'Asleep':
    case 'Paused':
    case 'Error': {
      const fx: Effect[] = [cancel('*'), { k: 'stopPlayback' }, { k: 'closeMic' }, { k: 'suspendCtx' }];
      if (to === 'Asleep') fx.push(anim({ e: 'sleep' }));
      if (to === 'Error') fx.push(timer('sleep', cfg.tSleepMs));
      // stopPlayback silences everything. closeMic ends the stream and the next openMic applies the input
      // policy, so a pending re-selection is dropped: no arm may happen while one is outstanding (§4.9.1).
      // Approved deviation D3 (issue #28 ORCH-ANSWER).
      const next: SessionState = {
        ...st,
        ctxRunning: false,
        micGranted: false,
        playingId: null,
        sfxEndedSeq: st.sfxSeq,
        micDeniedSfx: false,
        reselectPending: false,
      };
      // Only a nap (Asleep) resets the noisy mode (#116, ORCH-NOTE on #116: tooNoisy too).
      return [
        to === 'Error'
          ? next
          : to === 'Paused'
            ? { ...next, workerRestarts: 0 }
            : { ...next, workerRestarts: 0, noisyCaps: 0, marginBoostDb: 0, holdToTalk: false, tooNoisy: false },
        fx,
      ];
    }
    case 'MicDenied':
    case 'NeedsParent':
      return [st, [timer('sleep', cfg.tSleepMs)]];
    default: // Playing, SfxGated
      return [st, []];
  }
}

/**
 * Leave `s.name` for `to`: exit actions, `rowEffects`, entry actions, derived effects. `rowPatch` is applied
 * before the entry actions. `to === s.name` without `reenter` is a same-state row (no exit or entry).
 * Every row uses this.
 *
 * @internal – test-only; app code calls reduce(). Exported for the entry/exit tests (issue #28 Validation 2).
 */
export function transitionTo(
  s: SessionState,
  to: StateName,
  cfg: SessionConfig,
  rowEffects: Effect[] = [],
  rowPatch: Partial<SessionState> = {},
  reenter = false,
): Out {
  if (to === s.name && !reenter) return stay(s, rowPatch, rowEffects);
  const effects = [...exitActions(s.name), ...rowEffects];
  const exited: SessionState = {
    ...s,
    ...(s.name === 'Playing' ? { playingId: null } : {}),
    ...rowPatch,
    name: to,
  };
  if (ARMED.has(s.name) && !ARMED.has(to)) effects.push({ k: 'disarm', epoch: s.epoch });
  const [entered, entryFx] = entryActions(to, exited, cfg);
  effects.push(...entryFx, ...derived(s, entered));
  return { state: entered, effects };
}

/** A handler that goes to `to` with no row effects. */
const goTo =
  (to: StateName) =>
  (s: SessionState, _e: unknown, cfg: SessionConfig): Out =>
    transitionTo(s, to, cfg);

// ---- handlers ------------------------------------------------------------------------------------------
/**
 * Rows 1–3, 39, 42: wake by permission. Row 42 uses it too (approved deviation D4), so a tap never opens the
 * mic while permission is `prompt`: the mic is never requested straight from a child's tap (§4.5).
 */
function wakeByPermission(s: SessionState, cfg: SessionConfig, p: Partial<SessionState> = {}): Out {
  switch (s.permission) {
    case 'granted':
      return transitionTo(s, 'Waking', cfg, [{ k: 'resumeCtx' }, anim({ e: 'wake' })], p);
    case 'prompt':
      return transitionTo(s, 'NeedsParent', cfg, [{ k: 'resumeCtx' }], p);
    default: // denied
      return transitionTo(s, 'MicDenied', cfg, [{ k: 'resumeCtx' }, anim({ e: 'wake' })], p);
  }
}
/** Row 39 (Paused + visible): wake by permission (as rows 1–3). */
const onWakeTap = (s: SessionState, _e: unknown, cfg: SessionConfig): Out => wakeByPermission(s, cfg);
/**
 * Asleep + tapBear (rows 1–3, 3c) and Asleep + settingsRetry (3b, 3c). If another tab activated the update, this
 * page runs old code whose lazy URLs the new worker no longer serves, so it reloads (`applyUpdate`) instead of
 * waking. The flag is kept until C11, so a second pointerdown before the reload commits reloads again and never
 * wakes on old code (#277).
 */
const onAsleepWake = (s: SessionState, _e: unknown, cfg: SessionConfig): Out =>
  s.updateActivated ? stay(s, {}, [{ k: 'applyUpdate' }]) : wakeByPermission(s, cfg);
/** Row 42: tap to retry from Error starts a fresh wake, as row 1 does (approved deviations D4, D25). */
const onErrorTap = (s: SessionState, _e: unknown, cfg: SessionConfig): Out =>
  wakeByPermission(s, cfg, { workerRestarts: 0 });

/** Row 10: MicDenied → Waking, as row 1. */
const retryFromMicDenied = (s: SessionState, cfg: SessionConfig, p: Partial<SessionState> = {}): Out =>
  transitionTo(s, 'Waking', cfg, [{ k: 'resumeCtx' }, anim({ e: 'wake' })], p);

// Field updates that apply in every state (C5, C6, C8, C10, C11).
const onPermissionChanged: Handler<'permissionChanged'> = (s, e) => stay(s, { permission: e.state });
const onCtxRunning: Handler<'ctxRunning'> = (s, e) => stay(s, { ctxRunning: true, sampleRate: e.sampleRate });
const onArmed: Handler<'armed'> = (s, e) =>
  e.epoch === s.epoch ? stay(s, { armFrame: e.armFrame }) : same(s);
const onFloorSnapshot: Handler<'floorSnapshot'> = (s, e) =>
  e.epoch === s.epoch ? stay(s, { floorDb: e.floorDb }) : same(s);
const onSfxEnded: Handler<'sfxAtSpeakerEnded'> = (s, e) =>
  stay(s, { sfxEndedSeq: Math.max(s.sfxEndedSeq, e.seq) });
const onTrackMuted: Handler<'trackMuted'> = (s) => stay(s, { micMuted: true }); // row 18 in Listening
const onTrackUnmuted: Handler<'trackUnmuted'> = (s) => stay(s, { micMuted: false });
/** Row 18b (#116): every state records the flag; Listening's overlay follows it (C2). */
const onNoiseFloor: Handler<'noiseFloor'> = (s, e) => stay(s, { tooNoisy: e.floorDb > TOO_NOISY_FLOOR_DB });
/** C11; #277: `activated` (another tab's update) is sticky until C11, so a later plain `updateReady` keeps it. */
const onUpdateReady: Handler<'updateReady'> = (s, e) =>
  stay(s, e.activated === true ? { updateReady: true, updateActivated: true } : { updateReady: true });
/** M3 settings (issue #66): the preset of the next `process`, in every state; the same state if it is equal. */
const onSettingsChanged: Handler<'settingsChanged'> = (s, e) =>
  e.preset.id === s.preset.id && e.preset.pitchRatio === s.preset.pitchRatio
    ? same(s)
    : stay(s, { preset: e.preset });
/** C11: already asleep or paused; `reduce` appends `applyUpdate` if an update is ready. */
const onHideAsleepOrPaused = (s: SessionState): Out => same(s);

// Waking (rows 6–9, C6, C7).
function wakingFlag(s: SessionState, p: Partial<SessionState>, cfg: SessionConfig): Out {
  const next = { ...s, ...p };
  if (next.micGranted && next.ctxRunning) {
    // Row 6, C5. A MicDenied sfx that has already left the speaker still gets its cooldown before the
    // first arm (§4.4.3, §4.4.5; approved deviation D22).
    const to = sfxAudible(s) ? 'SfxGated' : s.micDeniedSfx ? 'Cooldown' : 'Listening';
    return transitionTo(s, to, cfg, [], { ...p, micDeniedSfx: false });
  }
  return stay(s, p); // row 7
}
const wakingMicGranted: Handler<'micGranted'> = (s, e, cfg) =>
  e.req === s.micReq ? wakingFlag(s, { micGranted: true }, cfg) : same(s);
const wakingCtxRunning: Handler<'ctxRunning'> = (s, e, cfg) =>
  wakingFlag(s, { ctxRunning: true, sampleRate: e.sampleRate }, cfg);
const wakingMicDenied: Handler<'micDenied'> = (s, e, cfg) =>
  e.req === s.micReq
    ? transitionTo(s, 'MicDenied', cfg, [{ k: 'closeMic' }, anim({ e: 'shrug' })], { permission: 'denied' })
    : same(s);
const wakingNoDevice: Handler<'noDevice'> = (s, e, cfg) =>
  e.req === s.micReq ? transitionTo(s, 'MicDenied', cfg, [{ k: 'closeMic' }, anim({ e: 'shrug' })]) : same(s);
const wakingTimer: Handler<'timer'> = (s, e, cfg) =>
  e.name === 'waking' ? transitionTo(s, 'Error', cfg) : same(s);

// MicDenied (rows 10–12).
const micDeniedPermission: Handler<'permissionChanged'> = (s, e, cfg) =>
  e.state === 'granted'
    ? retryFromMicDenied(s, cfg, { permission: 'granted' })
    : stay(s, { permission: e.state });
const micDeniedRetry: Handler<'settingsRetry'> = (s, _e, cfg) => retryFromMicDenied(s, cfg);

/** Rows 5, 12, 43: the sleep timer goes to Asleep. */
const sleepTimerToAsleep: Handler<'timer'> = (s, e, cfg) =>
  e.name === 'sleep' ? transitionTo(s, 'Asleep', cfg) : same(s);

// Reactions (rows 11, 14, 15, 23, 27, 29–33, 36, 37; C4). Every emitted sfx gets seq = ++sfxSeq.
const reactionAnim = (e: EventOf<'reaction'>): Effect =>
  anim({ e: 'reaction', name: e.name, priority: e.priority });
const animOnlyReaction: Handler<'reaction'> = (s, e) => stay(s, {}, [reactionAnim(e)]); // rows 23, 27
const micDeniedReaction: Handler<'reaction'> = (s, e, cfg) =>
  e.sfx === null
    ? stay(s, {}, [reactionAnim(e), timer('sleep', cfg.tSleepMs)])
    : stay(s, { sfxSeq: s.sfxSeq + 1, micDeniedSfx: true }, [
        { k: 'sfx', id: e.sfx, seq: s.sfxSeq + 1 },
        reactionAnim(e),
        timer('sleep', cfg.tSleepMs),
      ]); // row 11
const listeningReaction: Handler<'reaction'> = (s, e, cfg) =>
  e.sfx === null
    ? stay(s, {}, [reactionAnim(e), timer('sleep', cfg.tSleepMs), timer('doze', cfg.tDozeMs)]) // row 15
    : transitionTo(s, 'SfxGated', cfg, [{ k: 'sfx', id: e.sfx, seq: s.sfxSeq + 1 }, reactionAnim(e)], {
        sfxSeq: s.sfxSeq + 1,
      }); // row 14
const playingReaction: Handler<'reaction'> = (s, e, cfg) => {
  if (e.priority < 3) return stay(s, {}, [reactionAnim(e)]); // row 31: the director renders an additive flinch
  if (e.sfx === null) {
    return transitionTo(s, 'Cooldown', cfg, [{ k: 'stopPlayback' }, reactionAnim(e)], {
      sfxEndedSeq: s.sfxSeq,
    }); // row 30
  }
  return transitionTo(
    s,
    'SfxGated',
    cfg,
    [{ k: 'stopPlayback' }, { k: 'sfx', id: e.sfx, seq: s.sfxSeq + 1 }, reactionAnim(e)],
    { sfxEndedSeq: s.sfxSeq, sfxSeq: s.sfxSeq + 1 }, // C9: stopPlayback ends every earlier sfx first
  ); // row 29
};
const sfxGatedReaction: Handler<'reaction'> = (s, e) =>
  e.sfx === null
    ? stay(s, {}, [reactionAnim(e)]) // row 33
    : stay(s, { sfxSeq: s.sfxSeq + 1 }, [{ k: 'sfx', id: e.sfx, seq: s.sfxSeq + 1 }]); // row 32: sfx only (C4)
const cooldownReaction: Handler<'reaction'> = (s, e, cfg) =>
  e.sfx === null
    ? stay(s, {}, [reactionAnim(e)]) // row 37
    : transitionTo(s, 'SfxGated', cfg, [{ k: 'sfx', id: e.sfx, seq: s.sfxSeq + 1 }], {
        sfxSeq: s.sfxSeq + 1,
      }); // row 36: sfx only (C4)

// Listening (rows 13, 16–19, 40).
const listeningSeg: Handler<'seg'> = (s, e, cfg) =>
  !s.holdToTalk && e.epoch === s.epoch && e.ev.kind === 'start'
    ? transitionTo(s, 'Recording', cfg, [anim({ e: 'attentive' })], { onsetFrame: e.ev.frame })
    : same(s); // row 13; in hold-to-talk mode every seg is ignored (#116)
/** Row 13b (#116): the hold button starts a take in hold-to-talk mode, as row 13 does. */
const listeningHoldStart: Handler<'holdStart'> = (s, e, cfg) =>
  s.holdToTalk
    ? transitionTo(s, 'Recording', cfg, [anim({ e: 'attentive' })], { onsetFrame: e.frame })
    : same(s);
const listeningTimer: Handler<'timer'> = (s, e, cfg) => {
  // Row 16. Re-arming doze keeps both Listening timers armed (§4.9.1; approved deviation D6).
  if (e.name === 'doze') return stay(s, {}, [anim({ e: 'doze' }), timer('doze', cfg.tDozeMs)]);
  if (e.name === 'sleep') return transitionTo(s, 'Asleep', cfg); // row 17 (anim sleep is the Asleep entry)
  return same(s);
};
// Row 19: re-enter, only after a mute. An unmute while already unmuted changes nothing (approved deviation D24).
const listeningUnmuted: Handler<'trackUnmuted'> = (s, _e, cfg) =>
  s.micMuted ? transitionTo(s, 'Listening', cfg, [], { micMuted: false, floorDb: undefined }, true) : same(s);
// Row 40. A floor measured on the previous input is not restored on the new one (approved deviation D26).
const armedInputsChanged: Handler<'inputsChanged'> = (s, _e, cfg) =>
  transitionTo(s, 'Waking', cfg, [{ k: 'closeMic' }, { k: 'reselectInput' }], { floorDb: undefined });
const gatedInputsChanged: Handler<'inputsChanged'> = (s) => stay(s, { reselectPending: true }); // row 40b

// Recording (rows 20–22, 20b, 20c).
/** Row 20's take, to Processing: `[max(onset − pre-roll, armFrame), lastSpeechFrame + tail]` (C8). */
function takeTo(s: SessionState, lastSpeechFrame: number, cfg: SessionConfig, p: Partial<SessionState>): Out {
  const rate = s.sampleRate;
  const onset = s.onsetFrame ?? lastSpeechFrame; // Recording is only entered with an onset (rows 13, 13b)
  const fromFrame = Math.max(
    onset - framesOf(cfg.preRollMs, rate),
    s.armFrame ?? onset - framesOf(ONSET_BLOCK_MS, rate),
  );
  const toFrame = lastSpeechFrame + framesOf(cfg.tailMs, rate);
  const id = s.takeId + 1;
  return transitionTo(
    s,
    'Processing',
    cfg,
    [{ k: 'take', epoch: s.epoch, id, fromFrame, toFrame }, anim({ e: 'thinking' })],
    { takeId: id, ...p },
  );
}
/**
 * Row 20's noisy counter (#116, plan §4.4): a capped end with a voiced ratio below 0.3 counts, any other end resets
 * it. At NOISY_CAPS the margins rise by MARGIN_STEP_DB (and the count restarts) until 6 dB; then hold-to-talk.
 */
function noisyPatch(s: SessionState, ev: Extract<SegEvent, { kind: 'end' }>): Partial<SessionState> {
  const noisy = ev.reason === 'maxLength' && ev.voicedRatio !== undefined && ev.voicedRatio < NOISY_VOICED_RATIO;
  const noisyCaps = noisy ? s.noisyCaps + 1 : 0;
  if (noisyCaps < NOISY_CAPS) return { noisyCaps };
  if (s.marginBoostDb === 0) return { noisyCaps: 0, marginBoostDb: MARGIN_STEP_DB };
  if (s.marginBoostDb === MARGIN_STEP_DB) return { noisyCaps: 0, marginBoostDb: 2 * MARGIN_STEP_DB };
  return { noisyCaps, holdToTalk: true };
}
/** The cap in ctx frames: round(maxUtteranceMs / 1000 · sampleRate). */
const capFrames = (s: SessionState, cfg: SessionConfig): number => framesOf(cfg.maxUtteranceMs, s.sampleRate);
/** Row 20b (#116): the release ends a hold-to-talk take, clamped to [onset, onset + cap] (ORCH-NOTE on #116). */
const recordingHoldEnd: Handler<'holdEnd'> = (s, e, cfg) => {
  if (!s.holdToTalk) return same(s);
  const onset = s.onsetFrame ?? e.frame;
  return takeTo(s, Math.min(Math.max(e.frame, onset), onset + capFrames(s, cfg)), cfg, {});
};
const recordingSeg: Handler<'seg'> = (s, e, cfg) => {
  if (s.holdToTalk || e.epoch !== s.epoch) return same(s); // in hold-to-talk mode every seg is ignored (#116)
  switch (e.ev.kind) {
    case 'end':
      return takeTo(s, e.ev.lastSpeechFrame, cfg, noisyPatch(s, e.ev)); // row 20
    case 'misfire':
      return transitionTo(s, 'Listening', cfg, [anim({ e: 'earTwitch' })]); // row 21
    default: // a second start
      return same(s);
  }
};
const recordingMuted: Handler<'trackMuted'> = (s, _e, cfg) =>
  transitionTo(s, 'Listening', cfg, [anim({ e: 'earTwitch' })], { micMuted: true }); // row 22

// Processing and Playing (rows 24–28, C9).
const toCooldownConfused = (s: SessionState, cfg: SessionConfig): Out =>
  transitionTo(s, 'Cooldown', cfg, [anim({ e: 'confused' })]); // row 26
const processingClipReady: Handler<'clipReady'> = (s, e) =>
  e.epoch === s.epoch && e.id === s.takeId
    ? stay(s, {}, [{ k: 'process', id: e.id, preset: s.preset }])
    : same(s);
const processingProcessed: Handler<'processed'> = (s, e, cfg) =>
  e.id === s.takeId
    ? transitionTo(s, 'Playing', cfg, [{ k: 'play', id: e.id }, anim({ e: 'talk', id: e.id })], {
        playingId: e.id,
      })
    : same(s);
const processingTakeFailed: Handler<'takeFailed'> = (s, e, cfg) =>
  e.epoch === s.epoch && e.id === s.takeId ? toCooldownConfused(s, cfg) : same(s);
const processingFxError: Handler<'fxError'> = (s, e, cfg) =>
  e.id === s.takeId ? toCooldownConfused(s, cfg) : same(s);
const processingTimer: Handler<'timer'> = (s, e, cfg) =>
  e.name === 'processing' ? toCooldownConfused(s, cfg) : same(s);
const playingEnded: Handler<'playbackAtSpeakerEnded'> = (s, e, cfg) =>
  e.id === s.playingId ? transitionTo(s, 'Cooldown', cfg) : same(s); // row 28

// SfxGated and Cooldown (rows 34, 35, 35b).
const sfxGatedSfxEnded: Handler<'sfxAtSpeakerEnded'> = (s, e, cfg) => {
  const p = { sfxEndedSeq: Math.max(s.sfxEndedSeq, e.seq) };
  return e.seq === s.sfxSeq ? transitionTo(s, 'Cooldown', cfg, [], p) : stay(s, p); // row 34
};
const cooldownTimer: Handler<'timer'> = (s, e, cfg) => {
  if (e.name !== 'cooldown') return same(s);
  if (s.reselectPending) {
    return transitionTo(s, 'Waking', cfg, [{ k: 'closeMic' }, { k: 'reselectInput' }], {
      reselectPending: false,
      floorDb: undefined, // D26: the saved floor belongs to the previous input
    }); // row 35b
  }
  return transitionTo(s, sfxAudible(s) ? 'SfxGated' : 'Listening', cfg); // row 35, C5
};

// Worker failure (rows 45, 46, C7, C12).
function workerFailure(s: SessionState, cfg: SessionConfig): Out {
  if (s.workerRestarts > 0) return transitionTo(s, 'Error', cfg); // row 46
  const workerRestarts = s.workerRestarts + 1;
  const restart: Effect = { k: 'restartWorker' };
  if (s.name === 'Waking') return stay(s, { workerRestarts }, [restart]); // C7
  const confused = anim({ e: 'confused' });
  if (s.name === 'Cooldown') {
    return stay(s, { workerRestarts }, [restart, confused, timer('cooldown', cfg.cooldownMs)]); // row 45, no entry
  }
  if (s.name === 'Playing' || s.name === 'SfxGated') {
    // Abort the replay and every sfx too, so the cooldown (and a row 35b reselect) never starts while audio
    // is still audible (plan §4.4, §4.9.1, row 40b). Approved deviations D2 (Playing) and D23 (SfxGated).
    return transitionTo(s, 'Cooldown', cfg, [{ k: 'stopPlayback' }, restart, confused], {
      workerRestarts,
      sfxEndedSeq: s.sfxSeq,
    });
  }
  return transitionTo(s, 'Cooldown', cfg, [restart, confused], { workerRestarts }); // row 45
}
const onWorkerFailed: Handler<'workerFailed'> = (s, _e, cfg) => workerFailure(s, cfg);
const recordingTimer: Handler<'timer'> = (s, e, cfg) => {
  if (e.name !== 'recording') return same(s);
  // Row 20c (#116): in hold-to-talk mode the timer is the cap, a forced holdEnd: no restart, no Cooldown.
  if (s.holdToTalk) return takeTo(s, (s.onsetFrame ?? s.armFrame ?? 0) + capFrames(s, cfg), cfg, {});
  return workerFailure(s, cfg); // rows 45/46: the recording watchdog
};

/**
 * Every (state, event) pair, handled explicitly (plan §3.3 design rule 5). `'ignore'` returns the same state
 * object and no effects. A missing pair is a compile error.
 */
export const TABLE: { readonly [S in StateName]: Row } = {
  Asleep: {
    tapBear: onAsleepWake, // rows 1–3, 3c
    parentContinue: 'ignore',
    settingsRetry: onAsleepWake, // 3b, 3c: the parent's retry wakes (or reloads) exactly as the tap does
    permissionChanged: onPermissionChanged,
    micGranted: 'ignore',
    micDenied: 'ignore',
    noDevice: 'ignore',
    ctxRunning: onCtxRunning,
    ctxResumeFailed: 'ignore',
    ctxError: 'ignore',
    armed: onArmed,
    seg: 'ignore',
    floorSnapshot: onFloorSnapshot,
    clipReady: 'ignore',
    takeFailed: 'ignore',
    processed: 'ignore',
    fxError: 'ignore',
    playbackAtSpeakerEnded: 'ignore',
    sfxAtSpeakerEnded: onSfxEnded,
    reaction: 'ignore',
    timer: 'ignore',
    trackMuted: onTrackMuted,
    trackUnmuted: onTrackUnmuted,
    trackEnded: 'ignore',
    inputsChanged: 'ignore',
    workerFailed: 'ignore',
    hidden: onHideAsleepOrPaused,
    pagehide: onHideAsleepOrPaused,
    freeze: onHideAsleepOrPaused,
    visible: 'ignore',
    updateReady: onUpdateReady,
    settingsChanged: onSettingsChanged,
    noiseFloor: onNoiseFloor,
    holdStart: 'ignore',
    holdEnd: 'ignore',
  },
  NeedsParent: {
    tapBear: 'ignore',
    parentContinue: goTo('Waking'), // row 4
    settingsRetry: 'ignore',
    permissionChanged: onPermissionChanged,
    micGranted: 'ignore',
    micDenied: 'ignore',
    noDevice: 'ignore',
    ctxRunning: onCtxRunning,
    ctxResumeFailed: 'ignore',
    ctxError: 'ignore',
    armed: onArmed,
    seg: 'ignore',
    floorSnapshot: onFloorSnapshot,
    clipReady: 'ignore',
    takeFailed: 'ignore',
    processed: 'ignore',
    fxError: 'ignore',
    playbackAtSpeakerEnded: 'ignore',
    sfxAtSpeakerEnded: onSfxEnded,
    reaction: 'ignore',
    timer: sleepTimerToAsleep, // row 5
    trackMuted: onTrackMuted,
    trackUnmuted: onTrackUnmuted,
    trackEnded: 'ignore',
    inputsChanged: 'ignore',
    workerFailed: 'ignore',
    hidden: goTo('Asleep'), // row 5
    pagehide: goTo('Asleep'),
    freeze: goTo('Asleep'),
    visible: 'ignore',
    updateReady: onUpdateReady,
    settingsChanged: onSettingsChanged,
    noiseFloor: onNoiseFloor,
    holdStart: 'ignore',
    holdEnd: 'ignore',
  },
  Waking: {
    tapBear: 'ignore',
    parentContinue: 'ignore',
    settingsRetry: 'ignore',
    permissionChanged: onPermissionChanged,
    micGranted: wakingMicGranted, // rows 6, 7
    micDenied: wakingMicDenied, // row 8
    noDevice: wakingNoDevice, // row 8
    ctxRunning: wakingCtxRunning, // rows 6, 7
    ctxResumeFailed: goTo('Error'), // row 9
    ctxError: goTo('Error'), // row 41
    armed: onArmed,
    seg: 'ignore',
    floorSnapshot: onFloorSnapshot,
    clipReady: 'ignore',
    takeFailed: 'ignore',
    processed: 'ignore',
    fxError: 'ignore',
    playbackAtSpeakerEnded: 'ignore',
    sfxAtSpeakerEnded: onSfxEnded,
    reaction: 'ignore',
    timer: wakingTimer, // row 9
    trackMuted: onTrackMuted,
    trackUnmuted: onTrackUnmuted,
    trackEnded: goTo('Error'), // row 41
    inputsChanged: 'ignore',
    workerFailed: onWorkerFailed, // C7, row 46
    hidden: goTo('Paused'), // row 38
    pagehide: goTo('Paused'),
    freeze: goTo('Paused'),
    visible: 'ignore',
    updateReady: onUpdateReady,
    settingsChanged: onSettingsChanged,
    noiseFloor: onNoiseFloor,
    holdStart: 'ignore',
    holdEnd: 'ignore',
  },
  MicDenied: {
    tapBear: 'ignore',
    parentContinue: 'ignore',
    settingsRetry: micDeniedRetry, // row 10
    permissionChanged: micDeniedPermission, // row 10
    micGranted: 'ignore',
    micDenied: 'ignore',
    noDevice: 'ignore',
    ctxRunning: onCtxRunning,
    ctxResumeFailed: 'ignore',
    ctxError: goTo('Error'), // row 41
    armed: onArmed,
    seg: 'ignore',
    floorSnapshot: onFloorSnapshot,
    clipReady: 'ignore',
    takeFailed: 'ignore',
    processed: 'ignore',
    fxError: 'ignore',
    playbackAtSpeakerEnded: 'ignore',
    sfxAtSpeakerEnded: onSfxEnded,
    reaction: micDeniedReaction, // row 11
    timer: sleepTimerToAsleep, // row 12
    trackMuted: onTrackMuted,
    trackUnmuted: onTrackUnmuted,
    trackEnded: goTo('Error'), // row 41
    inputsChanged: 'ignore',
    workerFailed: 'ignore',
    hidden: goTo('Paused'), // row 38
    pagehide: goTo('Paused'),
    freeze: goTo('Paused'),
    visible: 'ignore',
    updateReady: onUpdateReady,
    settingsChanged: onSettingsChanged,
    noiseFloor: onNoiseFloor,
    holdStart: 'ignore',
    holdEnd: 'ignore',
  },
  Listening: {
    tapBear: 'ignore',
    parentContinue: 'ignore',
    settingsRetry: 'ignore',
    permissionChanged: onPermissionChanged,
    micGranted: 'ignore',
    micDenied: 'ignore',
    noDevice: 'ignore',
    ctxRunning: onCtxRunning,
    ctxResumeFailed: 'ignore',
    ctxError: goTo('Error'), // row 41
    armed: onArmed,
    seg: listeningSeg, // row 13
    floorSnapshot: onFloorSnapshot,
    clipReady: 'ignore',
    takeFailed: 'ignore',
    processed: 'ignore',
    fxError: 'ignore',
    playbackAtSpeakerEnded: 'ignore',
    sfxAtSpeakerEnded: onSfxEnded,
    reaction: listeningReaction, // rows 14, 15
    timer: listeningTimer, // rows 16, 17
    trackMuted: onTrackMuted, // row 18
    trackUnmuted: listeningUnmuted, // row 19
    trackEnded: goTo('Error'), // row 41
    inputsChanged: armedInputsChanged, // row 40
    workerFailed: onWorkerFailed, // rows 45, 46
    hidden: goTo('Paused'), // row 38
    pagehide: goTo('Paused'),
    freeze: goTo('Paused'),
    visible: 'ignore',
    updateReady: onUpdateReady,
    settingsChanged: onSettingsChanged,
    noiseFloor: onNoiseFloor,
    holdStart: listeningHoldStart, // row 13b
    holdEnd: 'ignore',
  },
  Recording: {
    tapBear: 'ignore',
    parentContinue: 'ignore',
    settingsRetry: 'ignore',
    permissionChanged: onPermissionChanged,
    micGranted: 'ignore',
    micDenied: 'ignore',
    noDevice: 'ignore',
    ctxRunning: onCtxRunning,
    ctxResumeFailed: 'ignore',
    ctxError: goTo('Error'), // row 41
    armed: onArmed,
    seg: recordingSeg, // rows 20, 21
    floorSnapshot: onFloorSnapshot,
    clipReady: 'ignore',
    takeFailed: 'ignore',
    processed: 'ignore',
    fxError: 'ignore',
    playbackAtSpeakerEnded: 'ignore',
    sfxAtSpeakerEnded: onSfxEnded,
    reaction: animOnlyReaction, // row 23
    timer: recordingTimer, // rows 45, 46
    trackMuted: recordingMuted, // row 22
    trackUnmuted: onTrackUnmuted,
    trackEnded: goTo('Error'), // row 41
    inputsChanged: armedInputsChanged, // row 40
    workerFailed: onWorkerFailed, // rows 45, 46
    hidden: goTo('Paused'), // row 38
    pagehide: goTo('Paused'),
    freeze: goTo('Paused'),
    visible: 'ignore',
    updateReady: onUpdateReady,
    settingsChanged: onSettingsChanged,
    noiseFloor: onNoiseFloor,
    holdStart: 'ignore',
    holdEnd: recordingHoldEnd, // row 20b
  },
  Processing: {
    tapBear: 'ignore',
    parentContinue: 'ignore',
    settingsRetry: 'ignore',
    permissionChanged: onPermissionChanged,
    micGranted: 'ignore',
    micDenied: 'ignore',
    noDevice: 'ignore',
    ctxRunning: onCtxRunning,
    ctxResumeFailed: 'ignore',
    ctxError: goTo('Error'), // row 41
    armed: onArmed,
    seg: 'ignore',
    floorSnapshot: onFloorSnapshot,
    clipReady: processingClipReady, // row 24
    takeFailed: processingTakeFailed, // row 26
    processed: processingProcessed, // row 25
    fxError: processingFxError, // row 26
    playbackAtSpeakerEnded: 'ignore',
    sfxAtSpeakerEnded: onSfxEnded,
    reaction: animOnlyReaction, // row 27
    timer: processingTimer, // row 26
    trackMuted: onTrackMuted,
    trackUnmuted: onTrackUnmuted,
    trackEnded: goTo('Error'), // row 41
    inputsChanged: gatedInputsChanged, // row 40b
    workerFailed: onWorkerFailed, // rows 45, 46
    hidden: goTo('Paused'), // row 38
    pagehide: goTo('Paused'),
    freeze: goTo('Paused'),
    visible: 'ignore',
    updateReady: onUpdateReady,
    settingsChanged: onSettingsChanged,
    noiseFloor: onNoiseFloor,
    holdStart: 'ignore',
    holdEnd: 'ignore',
  },
  Playing: {
    tapBear: 'ignore',
    parentContinue: 'ignore',
    settingsRetry: 'ignore',
    permissionChanged: onPermissionChanged,
    micGranted: 'ignore',
    micDenied: 'ignore',
    noDevice: 'ignore',
    ctxRunning: onCtxRunning,
    ctxResumeFailed: 'ignore',
    ctxError: goTo('Error'), // row 41
    armed: onArmed,
    seg: 'ignore',
    floorSnapshot: onFloorSnapshot,
    clipReady: 'ignore',
    takeFailed: 'ignore',
    processed: 'ignore',
    fxError: 'ignore',
    playbackAtSpeakerEnded: playingEnded, // row 28
    sfxAtSpeakerEnded: onSfxEnded,
    reaction: playingReaction, // rows 29–31
    timer: 'ignore',
    trackMuted: onTrackMuted,
    trackUnmuted: onTrackUnmuted,
    trackEnded: goTo('Error'), // row 41
    inputsChanged: gatedInputsChanged, // row 40b
    workerFailed: onWorkerFailed, // rows 45, 46
    hidden: goTo('Paused'), // row 38
    pagehide: goTo('Paused'),
    freeze: goTo('Paused'),
    visible: 'ignore',
    updateReady: onUpdateReady,
    settingsChanged: onSettingsChanged,
    noiseFloor: onNoiseFloor,
    holdStart: 'ignore',
    holdEnd: 'ignore',
  },
  SfxGated: {
    tapBear: 'ignore',
    parentContinue: 'ignore',
    settingsRetry: 'ignore',
    permissionChanged: onPermissionChanged,
    micGranted: 'ignore',
    micDenied: 'ignore',
    noDevice: 'ignore',
    ctxRunning: onCtxRunning,
    ctxResumeFailed: 'ignore',
    ctxError: goTo('Error'), // row 41
    armed: onArmed,
    seg: 'ignore',
    floorSnapshot: onFloorSnapshot,
    clipReady: 'ignore',
    takeFailed: 'ignore',
    processed: 'ignore',
    fxError: 'ignore',
    playbackAtSpeakerEnded: 'ignore',
    sfxAtSpeakerEnded: sfxGatedSfxEnded, // row 34
    reaction: sfxGatedReaction, // rows 32, 33
    timer: 'ignore',
    trackMuted: onTrackMuted,
    trackUnmuted: onTrackUnmuted,
    trackEnded: goTo('Error'), // row 41
    inputsChanged: gatedInputsChanged, // row 40b
    workerFailed: onWorkerFailed, // rows 45, 46
    hidden: goTo('Paused'), // row 38
    pagehide: goTo('Paused'),
    freeze: goTo('Paused'),
    visible: 'ignore',
    updateReady: onUpdateReady,
    settingsChanged: onSettingsChanged,
    noiseFloor: onNoiseFloor,
    holdStart: 'ignore',
    holdEnd: 'ignore',
  },
  Cooldown: {
    tapBear: 'ignore',
    parentContinue: 'ignore',
    settingsRetry: 'ignore',
    permissionChanged: onPermissionChanged,
    micGranted: 'ignore',
    micDenied: 'ignore',
    noDevice: 'ignore',
    ctxRunning: onCtxRunning,
    ctxResumeFailed: 'ignore',
    ctxError: goTo('Error'), // row 41
    armed: onArmed,
    seg: 'ignore',
    floorSnapshot: onFloorSnapshot,
    clipReady: 'ignore',
    takeFailed: 'ignore',
    processed: 'ignore',
    fxError: 'ignore',
    playbackAtSpeakerEnded: 'ignore',
    sfxAtSpeakerEnded: onSfxEnded,
    reaction: cooldownReaction, // rows 36, 37
    timer: cooldownTimer, // rows 35, 35b
    trackMuted: onTrackMuted,
    trackUnmuted: onTrackUnmuted,
    trackEnded: goTo('Error'), // row 41
    inputsChanged: gatedInputsChanged, // row 40b
    workerFailed: onWorkerFailed, // rows 45, 46
    hidden: goTo('Paused'), // row 38
    pagehide: goTo('Paused'),
    freeze: goTo('Paused'),
    visible: 'ignore',
    updateReady: onUpdateReady,
    settingsChanged: onSettingsChanged,
    noiseFloor: onNoiseFloor,
    holdStart: 'ignore',
    holdEnd: 'ignore',
  },
  Paused: {
    tapBear: 'ignore',
    parentContinue: 'ignore',
    settingsRetry: 'ignore',
    permissionChanged: onPermissionChanged,
    micGranted: 'ignore',
    micDenied: 'ignore',
    noDevice: 'ignore',
    ctxRunning: onCtxRunning,
    ctxResumeFailed: 'ignore',
    ctxError: 'ignore',
    armed: onArmed,
    seg: 'ignore',
    floorSnapshot: onFloorSnapshot,
    clipReady: 'ignore',
    takeFailed: 'ignore',
    processed: 'ignore',
    fxError: 'ignore',
    playbackAtSpeakerEnded: 'ignore',
    sfxAtSpeakerEnded: onSfxEnded,
    reaction: 'ignore',
    timer: 'ignore',
    trackMuted: onTrackMuted,
    trackUnmuted: onTrackUnmuted,
    trackEnded: 'ignore',
    inputsChanged: 'ignore',
    workerFailed: 'ignore',
    hidden: onHideAsleepOrPaused,
    pagehide: onHideAsleepOrPaused,
    freeze: onHideAsleepOrPaused,
    visible: onWakeTap, // row 39: as rows 1 / 2 / 3
    updateReady: onUpdateReady,
    settingsChanged: onSettingsChanged,
    noiseFloor: onNoiseFloor,
    holdStart: 'ignore',
    holdEnd: 'ignore',
  },
  Error: {
    tapBear: onErrorTap, // row 42
    parentContinue: 'ignore',
    settingsRetry: 'ignore',
    permissionChanged: onPermissionChanged,
    micGranted: 'ignore',
    micDenied: 'ignore',
    noDevice: 'ignore',
    ctxRunning: onCtxRunning,
    ctxResumeFailed: 'ignore',
    ctxError: 'ignore',
    armed: onArmed,
    seg: 'ignore',
    floorSnapshot: onFloorSnapshot,
    clipReady: 'ignore',
    takeFailed: 'ignore',
    processed: 'ignore',
    fxError: 'ignore',
    playbackAtSpeakerEnded: 'ignore',
    sfxAtSpeakerEnded: onSfxEnded,
    reaction: 'ignore',
    timer: sleepTimerToAsleep, // row 43
    trackMuted: onTrackMuted,
    trackUnmuted: onTrackUnmuted,
    trackEnded: 'ignore',
    inputsChanged: 'ignore',
    workerFailed: 'ignore',
    hidden: goTo('Asleep'), // row 43
    pagehide: goTo('Asleep'),
    freeze: goTo('Asleep'),
    visible: 'ignore',
    updateReady: onUpdateReady,
    settingsChanged: onSettingsChanged,
    noiseFloor: onNoiseFloor,
    holdStart: 'ignore',
    holdEnd: 'ignore',
  },
};

function handlerFor<E extends EventType>(name: StateName, t: E): Handler<E> | 'ignore' {
  return TABLE[name][t];
}

/** The session reducer. Pure: it never mutates `s`, does no I/O and reads no clock. */
export function reduce(
  s: SessionState,
  e: SessionEvent,
  cfg: SessionConfig = DEFAULT_CONFIG,
): { state: SessionState; effects: Effect[] } {
  const handler = handlerFor(s.name, e.t);
  if (handler === 'ignore') return { state: s, effects: [] };
  const out = handler(s, e, cfg);
  const next = out.state;
  if (HIDE_EVENTS.has(e.t) && (next.name === 'Asleep' || next.name === 'Paused') && next.updateReady) {
    // C11 / plan §4.7: apply the update synchronously in the hide dispatch, after everything has stopped.
    return {
      state: { ...next, updateReady: false, updateActivated: false },
      effects: [...out.effects, { k: 'applyUpdate' }],
    };
  }
  return out;
}
