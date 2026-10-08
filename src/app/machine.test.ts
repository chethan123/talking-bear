import { describe, expect, it } from 'vitest';

import { PRESETS } from '../dsp/types.ts';
import {
  DEFAULT_CONFIG,
  type Effect,
  type EventType,
  type Overlay,
  type Priority,
  type SessionEvent,
  type SessionState,
  type StateName,
  type TimerName,
} from './events.ts';
import {
  ARMED,
  AWAKE,
  GATED,
  MIC_OPEN,
  TABLE,
  WAKE_LOCK_HELD,
  initialSessionState,
  overlayFor,
  reduce,
  transitionTo,
} from './machine.ts';

type EventOf<E extends EventType> = Extract<SessionEvent, { t: E }>;

// ---- helpers ---------------------------------------------------------------------------------------------

/** Recursive Object.freeze (Validation 5). */
function deepFreeze<T>(o: T): T {
  if (typeof o === 'object' && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Every reducer call goes through here: the input state and event are deep-frozen first (Validation 5). */
function run(s: SessionState, e: SessionEvent) {
  return reduce(deepFreeze(s), deepFreeze(e));
}

const STATES: StateName[] = [
  'Asleep',
  'NeedsParent',
  'Waking',
  'MicDenied',
  'Listening',
  'Recording',
  'Processing',
  'Playing',
  'SfxGated',
  'Cooldown',
  'Paused',
  'Error',
];

// Representative counters: every current epoch / req / id / seq is distinct from its stale neighbour.
const EPOCH = 7;
const REQ = 3;
const TAKE = 5;
const SEQ = 2;
const FLOOR = -50;

/** A plausible state for `name`, with `over` applied last. */
function stateIn(name: StateName, over: Partial<SessionState> = {}): SessionState {
  const micOpen = MIC_OPEN.has(name) && name !== 'Waking';
  return {
    ...initialSessionState('granted'),
    name,
    epoch: EPOCH,
    micReq: REQ,
    takeId: TAKE,
    sfxSeq: SEQ,
    sfxEndedSeq: SEQ,
    floorDb: FLOOR,
    micGranted: micOpen,
    ctxRunning: micOpen || name === 'MicDenied' || name === 'NeedsParent',
    armFrame: ARMED.has(name) ? 96_000 : null,
    onsetFrame: name === 'Recording' ? 144_000 : null,
    playingId: name === 'Playing' ? TAKE : null,
    ...over,
  };
}

/** Asserts the exact next name, the exact effects in order, and that exactly `changes` changed. */
function expectStep(
  s: SessionState,
  e: SessionEvent,
  name: StateName,
  effects: Effect[],
  changes: Partial<SessionState> = {},
) {
  const r = run(s, e);
  expect(r.state.name).toBe(name);
  expect(r.effects).toStrictEqual(effects);
  expect(r.state).toStrictEqual({ ...s, ...changes, name });
  return r;
}

function expectIgnored(s: SessionState, e: SessionEvent) {
  const r = run(s, e);
  expect(r.state).toBe(s);
  expect(r.effects).toStrictEqual([]);
}

// ---- effect shorthands (literal values from issue #28 DEFAULT_CONFIG) -----------------------------------
const cancel = (name: TimerName | '*'): Effect => ({ k: 'cancelTimer', name });
const timer = (name: TimerName, ms: number): Effect => ({ k: 'timer', name, ms });
type PlainAnim =
  | 'wake'
  | 'sleep'
  | 'doze'
  | 'idle'
  | 'attentive'
  | 'thinking'
  | 'talkEnd'
  | 'confused'
  | 'earTwitch'
  | 'shrug';
const anim = (e: PlainAnim): Effect => ({ k: 'anim', ev: { e } });
const wakeLock = (on: boolean): Effect => ({ k: 'wakeLock', on });
const ui = (show: Overlay): Effect => ({ k: 'ui', show });
const RESUME: Effect = { k: 'resumeCtx' };
const CLOSE_MIC: Effect = { k: 'closeMic' };
const STOP: Effect = { k: 'stopPlayback' };
const RESELECT: Effect = { k: 'reselectInput' };
const RESTART: Effect = { k: 'restartWorker' };
const openMic = (req: number): Effect => ({ k: 'openMic', req });
const disarm = (epoch: number): Effect => ({ k: 'disarm', epoch });
const sfx = (seq: number): Effect => ({ k: 'sfx', id: 'testBeep', seq });

const SLEEP_T = timer('sleep', 120_000);
const DOZE_T = timer('doze', 45_000);
const WAKING_T = timer('waking', 5_000);
const COOLDOWN_T = timer('cooldown', 250);
const PROCESSING_T = timer('processing', 2_000);
const RECORDING_T = timer('recording', 12_000);

/** Entry actions of Listening for the new `epoch`. */
const listenEntry = (epoch: number, floorDb?: number): Effect[] => [
  floorDb === undefined ? { k: 'arm', epoch } : { k: 'arm', epoch, restoreFloorDb: floorDb },
  SLEEP_T,
  DOZE_T,
  anim('idle'),
];
const wakingEntry = (req: number): Effect[] => [openMic(req), WAKING_T];
const STOP_ALL: Effect[] = [cancel('*'), STOP, CLOSE_MIC, { k: 'suspendCtx' }];
const ASLEEP_ENTRY: Effect[] = [...STOP_ALL, anim('sleep')];
const PAUSED_ENTRY: Effect[] = STOP_ALL;
const ERROR_ENTRY: Effect[] = [...STOP_ALL, SLEEP_T];

/** The exit actions of each state (issue #28 exit table). */
const EXIT: Record<StateName, Effect[]> = {
  Asleep: [],
  NeedsParent: [cancel('sleep')],
  Waking: [cancel('waking')],
  MicDenied: [cancel('sleep')],
  Listening: [cancel('sleep'), cancel('doze')],
  Recording: [cancel('recording')],
  Processing: [cancel('processing')],
  Playing: [anim('talkEnd')],
  SfxGated: [],
  Cooldown: [cancel('cooldown')],
  Paused: [],
  Error: [cancel('sleep')],
};

/** Field changes of entering Asleep / Paused / Error from `s`. */
function stopFields(s: SessionState, to: 'Asleep' | 'Paused' | 'Error'): Partial<SessionState> {
  return {
    ctxRunning: false,
    micGranted: false,
    playingId: null,
    sfxEndedSeq: s.sfxSeq,
    micDeniedSfx: false,
    reselectPending: false,
    workerRestarts: to === 'Error' ? s.workerRestarts : 0,
  };
}

const reaction = (priority: Priority, withSfx: boolean): EventOf<'reaction'> => ({
  t: 'reaction',
  name: 'poke',
  priority,
  sfx: withSfx ? 'testBeep' : null,
});
const reactionAnim = (priority: Priority): Effect => ({
  k: 'anim',
  ev: { e: 'reaction', name: 'poke', priority },
});
const tmr = (name: TimerName): EventOf<'timer'> => ({ t: 'timer', name });
const seg = (epoch: number, ev: EventOf<'seg'>['ev']): SessionEvent => ({ t: 'seg', epoch, ev });

/** C11: where hidden / pagehide / freeze leave each state. */
const hideTarget = (name: StateName): StateName =>
  AWAKE.has(name) ? 'Paused' : name === 'NeedsParent' || name === 'Error' ? 'Asleep' : name;

// ---- Validation 1: one it() per plan row -------------------------------------------------------------------
describe('plan §3.4 rows', () => {
  it('row 1: Asleep + tapBear [granted] → Waking', () => {
    expectStep(
      stateIn('Asleep'),
      { t: 'tapBear' },
      'Waking',
      [RESUME, anim('wake'), ...wakingEntry(REQ + 1), wakeLock(true), ui(null)],
      { micReq: REQ + 1, micGranted: false },
    );
  });

  it('row 2: Asleep + tapBear [prompt] → NeedsParent', () => {
    expectStep(stateIn('Asleep', { permission: 'prompt' }), { t: 'tapBear' }, 'NeedsParent', [
      RESUME,
      SLEEP_T,
      wakeLock(true),
      ui('parentPermission'),
    ]);
  });

  it('row 3: Asleep + tapBear [denied] → MicDenied', () => {
    expectStep(stateIn('Asleep', { permission: 'denied' }), { t: 'tapBear' }, 'MicDenied', [
      RESUME,
      anim('wake'),
      SLEEP_T,
      ui('micHelp'),
    ]);
  });

  it('row 4: NeedsParent + parentContinue → Waking', () => {
    expectStep(
      stateIn('NeedsParent', { permission: 'prompt' }),
      { t: 'parentContinue' },
      'Waking',
      [cancel('sleep'), ...wakingEntry(REQ + 1), ui(null)],
      { micReq: REQ + 1, micGranted: false },
    );
  });

  it('row 5: NeedsParent + timer sleep | hidden → Asleep', () => {
    const s = stateIn('NeedsParent', { permission: 'prompt' });
    for (const e of [tmr('sleep'), { t: 'hidden' } as const]) {
      expectStep(
        s,
        e,
        'Asleep',
        [cancel('sleep'), ...ASLEEP_ENTRY, wakeLock(false), ui('tapToWake')],
        stopFields(s, 'Asleep'),
      );
    }
  });

  it('row 6: Waking + micGranted | ctxRunning with the other flag set → Listening', () => {
    const afterCtx = stateIn('Waking', { ctxRunning: true });
    expectStep(
      afterCtx,
      { t: 'micGranted', req: REQ },
      'Listening',
      [cancel('waking'), ...listenEntry(EPOCH + 1, FLOOR)],
      { micGranted: true, epoch: EPOCH + 1, armFrame: null, onsetFrame: null },
    );
    const afterMic = stateIn('Waking', { micGranted: true });
    expectStep(
      afterMic,
      { t: 'ctxRunning', sampleRate: 44_100 },
      'Listening',
      [cancel('waking'), ...listenEntry(EPOCH + 1, FLOOR)],
      { ctxRunning: true, sampleRate: 44_100, epoch: EPOCH + 1, armFrame: null, onsetFrame: null },
    );
  });

  it('row 7: Waking + micGranted | ctxRunning with the other flag not set → Waking', () => {
    const s = stateIn('Waking');
    expectStep(s, { t: 'micGranted', req: REQ }, 'Waking', [], { micGranted: true });
    expectStep(s, { t: 'ctxRunning', sampleRate: 48_000 }, 'Waking', [], { ctxRunning: true });
  });

  it('row 8: Waking + micDenied | noDevice → MicDenied', () => {
    const s = stateIn('Waking');
    const fx = [cancel('waking'), CLOSE_MIC, anim('shrug'), SLEEP_T, wakeLock(false), ui('micHelp')];
    expectStep(s, { t: 'micDenied', req: REQ }, 'MicDenied', fx, { permission: 'denied' });
    expectStep(s, { t: 'noDevice', req: REQ }, 'MicDenied', fx);
  });

  it('row 9: Waking + ctxResumeFailed | timer waking → Error', () => {
    const s = stateIn('Waking', { ctxRunning: true });
    for (const e of [{ t: 'ctxResumeFailed' } as const, tmr('waking')]) {
      expectStep(
        s,
        e,
        'Error',
        [cancel('waking'), ...ERROR_ENTRY, wakeLock(false), ui('error')],
        stopFields(s, 'Error'),
      );
    }
  });

  it('row 10: MicDenied + permissionChanged(granted) | settingsRetry → Waking (as row 1)', () => {
    const s = stateIn('MicDenied', { permission: 'denied' });
    const fx = [cancel('sleep'), RESUME, anim('wake'), ...wakingEntry(REQ + 1), wakeLock(true), ui(null)];
    expectStep(s, { t: 'permissionChanged', state: 'granted' }, 'Waking', fx, {
      permission: 'granted',
      micReq: REQ + 1,
      micGranted: false,
    });
    expectStep(s, { t: 'settingsRetry' }, 'Waking', fx, { micReq: REQ + 1, micGranted: false });
  });

  it('row 11: MicDenied + reaction → MicDenied, including sfx; restarts timer sleep', () => {
    const s = stateIn('MicDenied', { permission: 'denied' });
    expectStep(s, reaction(2, true), 'MicDenied', [sfx(SEQ + 1), reactionAnim(2), SLEEP_T], {
      sfxSeq: SEQ + 1,
      micDeniedSfx: true, // D22
    });
    expectStep(s, reaction(2, false), 'MicDenied', [reactionAnim(2), SLEEP_T]);
  });

  it('row 12: MicDenied + timer sleep → Asleep', () => {
    const s = stateIn('MicDenied', { permission: 'denied' });
    expectStep(
      s,
      tmr('sleep'),
      'Asleep',
      [cancel('sleep'), ...ASLEEP_ENTRY, ui('tapToWake')],
      stopFields(s, 'Asleep'),
    );
  });

  it('row 13: Listening + seg.start → Recording', () => {
    expectStep(
      stateIn('Listening'),
      seg(EPOCH, { kind: 'start', frame: 150_000 }),
      'Recording',
      [cancel('sleep'), cancel('doze'), anim('attentive'), RECORDING_T],
      { onsetFrame: 150_000 },
    );
  });

  it('row 14: Listening + reaction{sfx} → SfxGated', () => {
    expectStep(
      stateIn('Listening'),
      reaction(2, true),
      'SfxGated',
      [cancel('sleep'), cancel('doze'), sfx(SEQ + 1), reactionAnim(2), disarm(EPOCH)],
      { sfxSeq: SEQ + 1 },
    );
  });

  it('row 15: Listening + reaction{no sfx} → Listening; restarts timer sleep and doze', () => {
    expectStep(stateIn('Listening'), reaction(2, false), 'Listening', [reactionAnim(2), SLEEP_T, DOZE_T]);
  });

  it('row 16: Listening + timer doze → Listening', () => {
    expectStep(stateIn('Listening'), tmr('doze'), 'Listening', [anim('doze'), DOZE_T]);
  });

  it('row 17: Listening + timer sleep → Asleep', () => {
    const s = stateIn('Listening');
    expectStep(
      s,
      tmr('sleep'),
      'Asleep',
      [cancel('sleep'), cancel('doze'), disarm(EPOCH), ...ASLEEP_ENTRY, wakeLock(false), ui('tapToWake')],
      stopFields(s, 'Asleep'),
    );
  });

  it('row 18: Listening + trackMuted → Listening with ui micMuted; timers keep running', () => {
    expectStep(stateIn('Listening'), { t: 'trackMuted' }, 'Listening', [ui('micMuted')], { micMuted: true });
  });

  it('row 19: Listening + trackUnmuted → re-enter Listening (new epoch, floor reset)', () => {
    expectStep(
      stateIn('Listening', { micMuted: true }),
      { t: 'trackUnmuted' },
      'Listening',
      [cancel('sleep'), cancel('doze'), ...listenEntry(EPOCH + 1), ui(null)],
      { micMuted: false, floorDb: undefined, epoch: EPOCH + 1, armFrame: null, onsetFrame: null },
    );
    // D24: an unmute while already unmuted changes nothing.
    expectIgnored(stateIn('Listening'), { t: 'trackUnmuted' });
  });

  it('row 20: Recording + seg.end → Processing with the clamped take', () => {
    const s = stateIn('Recording'); // armFrame 96 000, onsetFrame 144 000, 48 kHz
    const end = (reason: 'silence' | 'maxLength') =>
      seg(EPOCH, { kind: 'end', frame: 220_000, lastSpeechFrame: 190_000, reason, voicedRatio: 0.8 });
    const fx = [
      cancel('recording'),
      { k: 'take', epoch: EPOCH, id: TAKE + 1, fromFrame: 144_000 - 14_400, toFrame: 190_000 + 7_200 },
      anim('thinking'),
      disarm(EPOCH),
      PROCESSING_T,
    ] satisfies Effect[];
    expectStep(s, end('silence'), 'Processing', fx, { takeId: TAKE + 1 });
    expectStep(s, end('maxLength'), 'Processing', fx, { takeId: TAKE + 1 }); // voiced: not a noisy cap (#116)
  });

  it('row 21: Recording + seg.misfire → Listening', () => {
    expectStep(
      stateIn('Recording'),
      seg(EPOCH, { kind: 'misfire', frame: 150_000 }),
      'Listening',
      [cancel('recording'), anim('earTwitch'), ...listenEntry(EPOCH + 1, FLOOR)],
      { epoch: EPOCH + 1, armFrame: null, onsetFrame: null },
    );
  });

  it('row 22: Recording + trackMuted → Listening (abort)', () => {
    expectStep(
      stateIn('Recording'),
      { t: 'trackMuted' },
      'Listening',
      [cancel('recording'), anim('earTwitch'), ...listenEntry(EPOCH + 1, FLOOR), ui('micMuted')],
      { micMuted: true, epoch: EPOCH + 1, armFrame: null, onsetFrame: null },
    );
  });

  it('row 23: Recording + reaction → Recording, animation only (no sfx)', () => {
    expectStep(stateIn('Recording'), reaction(3, true), 'Recording', [reactionAnim(3)]);
  });

  it('row 24: Processing + clipReady → process{id, preset}', () => {
    const s = stateIn('Processing');
    const r = expectStep(s, { t: 'clipReady', epoch: EPOCH, id: TAKE }, 'Processing', [
      { k: 'process', id: TAKE, preset: PRESETS.cub },
    ]);
    expect(r.state).toBe(s);
  });

  it('row 25: Processing + processed → Playing', () => {
    expectStep(
      stateIn('Processing'),
      { t: 'processed', id: TAKE, durationSec: 1.5 },
      'Playing',
      [cancel('processing'), { k: 'play', id: TAKE }, { k: 'anim', ev: { e: 'talk', id: TAKE } }],
      { playingId: TAKE },
    );
  });

  it('row 26: Processing + takeFailed | fxError | timer processing → Cooldown', () => {
    const s = stateIn('Processing');
    const events: SessionEvent[] = [
      { t: 'takeFailed', epoch: EPOCH, id: TAKE },
      { t: 'fxError', id: TAKE },
      tmr('processing'),
    ];
    for (const e of events) {
      expectStep(s, e, 'Cooldown', [cancel('processing'), anim('confused'), COOLDOWN_T]);
    }
  });

  it('row 27: Processing + reaction → Processing, animation only', () => {
    expectStep(stateIn('Processing'), reaction(4, true), 'Processing', [reactionAnim(4)]);
  });

  it('row 28: Playing + playbackAtSpeakerEnded → Cooldown', () => {
    expectStep(
      stateIn('Playing'),
      { t: 'playbackAtSpeakerEnded', id: TAKE },
      'Cooldown',
      [anim('talkEnd'), COOLDOWN_T],
      { playingId: null },
    );
  });

  it('row 29: Playing + reaction{priority ≥ 3, sfx} → SfxGated', () => {
    expectStep(
      stateIn('Playing'),
      reaction(3, true),
      'SfxGated',
      [anim('talkEnd'), STOP, sfx(SEQ + 1), reactionAnim(3)],
      { playingId: null, sfxEndedSeq: SEQ, sfxSeq: SEQ + 1 },
    );
  });

  it('row 30: Playing + reaction{priority ≥ 3, no sfx} → Cooldown', () => {
    expectStep(
      stateIn('Playing'),
      reaction(4, false),
      'Cooldown',
      [anim('talkEnd'), STOP, reactionAnim(4), COOLDOWN_T],
      { playingId: null, sfxEndedSeq: SEQ },
    );
  });

  it('row 31: Playing + reaction{priority < 3} → Playing, flinch only, no sfx', () => {
    expectStep(stateIn('Playing'), reaction(2, true), 'Playing', [reactionAnim(2)]);
    expectStep(stateIn('Playing'), reaction(1, false), 'Playing', [reactionAnim(1)]);
  });

  it('row 32: SfxGated + reaction{sfx} → SfxGated with the sfx only; the gate follows the newest sfx', () => {
    expectStep(stateIn('SfxGated', { sfxEndedSeq: SEQ - 1 }), reaction(2, true), 'SfxGated', [sfx(SEQ + 1)], {
      sfxSeq: SEQ + 1,
    });
  });

  it('row 33: SfxGated + reaction{no sfx} → SfxGated', () => {
    expectStep(stateIn('SfxGated', { sfxEndedSeq: SEQ - 1 }), reaction(2, false), 'SfxGated', [
      reactionAnim(2),
    ]);
  });

  it('row 34: SfxGated + sfxAtSpeakerEnded for the latest sfx → Cooldown', () => {
    const s = stateIn('SfxGated', { sfxEndedSeq: SEQ - 2 });
    expectStep(s, { t: 'sfxAtSpeakerEnded', seq: SEQ }, 'Cooldown', [COOLDOWN_T], { sfxEndedSeq: SEQ });
    // An older sfx leaving the speaker does not open the gate.
    expectStep(s, { t: 'sfxAtSpeakerEnded', seq: SEQ - 1 }, 'SfxGated', [], { sfxEndedSeq: SEQ - 1 });
  });

  it('row 35: Cooldown + timer cooldown → Listening (new epoch, floor restore)', () => {
    expectStep(
      stateIn('Cooldown'),
      tmr('cooldown'),
      'Listening',
      [cancel('cooldown'), ...listenEntry(EPOCH + 1, FLOOR)],
      { epoch: EPOCH + 1, armFrame: null, onsetFrame: null },
    );
  });

  it('row 35b: Cooldown + timer cooldown [reselectPending] → Waking', () => {
    expectStep(
      stateIn('Cooldown', { reselectPending: true }),
      tmr('cooldown'),
      'Waking',
      [cancel('cooldown'), CLOSE_MIC, RESELECT, ...wakingEntry(REQ + 1)],
      { reselectPending: false, micReq: REQ + 1, micGranted: false, floorDb: undefined }, // D26
    );
  });

  it('row 36: Cooldown + reaction{sfx} → SfxGated with the sfx only', () => {
    expectStep(stateIn('Cooldown'), reaction(2, true), 'SfxGated', [cancel('cooldown'), sfx(SEQ + 1)], {
      sfxSeq: SEQ + 1,
    });
  });

  it('row 37: Cooldown + reaction{no sfx} → Cooldown', () => {
    expectStep(stateIn('Cooldown'), reaction(2, false), 'Cooldown', [reactionAnim(2)]);
  });

  it('row 38: any awake state + hidden | pagehide | freeze → Paused', () => {
    for (const from of AWAKE) {
      for (const t of ['hidden', 'pagehide', 'freeze'] as const) {
        const s = stateIn(from, { micMuted: from === 'Listening' });
        expectStep(
          s,
          { t },
          'Paused',
          [
            ...EXIT[from],
            ...(ARMED.has(from) ? [disarm(EPOCH)] : []),
            ...PAUSED_ENTRY,
            ...(MIC_OPEN.has(from) ? [wakeLock(false)] : []),
            ...(overlayFor(s) === null ? [] : [ui(null)]),
          ],
          stopFields(s, 'Paused'),
        );
      }
    }
  });

  it('row 39: Paused + visible → Waking / NeedsParent / MicDenied by permission (as rows 1 / 2 / 3)', () => {
    expectStep(
      stateIn('Paused'),
      { t: 'visible' },
      'Waking',
      [RESUME, anim('wake'), ...wakingEntry(REQ + 1), wakeLock(true)],
      { micReq: REQ + 1, micGranted: false },
    );
    expectStep(stateIn('Paused', { permission: 'prompt' }), { t: 'visible' }, 'NeedsParent', [
      RESUME,
      SLEEP_T,
      wakeLock(true),
      ui('parentPermission'),
    ]);
    expectStep(stateIn('Paused', { permission: 'denied' }), { t: 'visible' }, 'MicDenied', [
      RESUME,
      anim('wake'),
      SLEEP_T,
      ui('micHelp'),
    ]);
  });

  it('row 40: Listening | Recording + inputsChanged → Waking (reselect, reopen)', () => {
    for (const from of ['Listening', 'Recording'] as const) {
      expectStep(
        stateIn(from),
        { t: 'inputsChanged' },
        'Waking',
        [...EXIT[from], CLOSE_MIC, RESELECT, disarm(EPOCH), ...wakingEntry(REQ + 1)],
        { micReq: REQ + 1, micGranted: false, floorDb: undefined }, // ctxRunning stays true (C6); D26
      );
    }
  });

  it('row 40b: gated states + inputsChanged → unchanged, reselectPending set', () => {
    for (const from of GATED) {
      expectStep(stateIn(from), { t: 'inputsChanged' }, from, [], { reselectPending: true });
    }
  });

  it('row 41: any awake state + ctxError | trackEnded → Error', () => {
    for (const from of AWAKE) {
      for (const t of ['ctxError', 'trackEnded'] as const) {
        const s = stateIn(from);
        expectStep(
          s,
          { t },
          'Error',
          [
            ...EXIT[from],
            ...(ARMED.has(from) ? [disarm(EPOCH)] : []),
            ...ERROR_ENTRY,
            ...(MIC_OPEN.has(from) ? [wakeLock(false)] : []),
            ui('error'),
          ],
          stopFields(s, 'Error'),
        );
      }
    }
  });

  it('row 42: Error + tapBear → Waking (as row 1)', () => {
    expectStep(
      stateIn('Error'),
      { t: 'tapBear' },
      'Waking',
      [cancel('sleep'), RESUME, anim('wake'), ...wakingEntry(REQ + 1), wakeLock(true), ui(null)],
      { micReq: REQ + 1, micGranted: false },
    );
  });

  it('row 43: Error + timer sleep | hidden → Asleep', () => {
    const s = stateIn('Error', { workerRestarts: 1 });
    for (const e of [tmr('sleep'), { t: 'hidden' } as const]) {
      expectStep(
        s,
        e,
        'Asleep',
        [cancel('sleep'), ...ASLEEP_ENTRY, ui('tapToWake')],
        stopFields(s, 'Asleep'),
      );
    }
  });

  it('row 44: stale epoch / id / req events are ignored', () => {
    const cases: [StateName, SessionEvent][] = [
      ['Listening', seg(EPOCH - 1, { kind: 'start', frame: 1 })],
      ['Recording', seg(EPOCH - 1, { kind: 'end', frame: 2, lastSpeechFrame: 1, reason: 'silence' })],
      ['Recording', seg(EPOCH - 1, { kind: 'misfire', frame: 1 })],
      ['Processing', { t: 'clipReady', epoch: EPOCH - 1, id: TAKE }],
      ['Processing', { t: 'clipReady', epoch: EPOCH, id: TAKE - 1 }],
      ['Processing', { t: 'takeFailed', epoch: EPOCH - 1, id: TAKE }],
      ['Processing', { t: 'takeFailed', epoch: EPOCH, id: TAKE - 1 }],
      ['Processing', { t: 'processed', id: TAKE - 1, durationSec: 1 }],
      ['Processing', { t: 'fxError', id: TAKE - 1 }],
      ['Playing', { t: 'playbackAtSpeakerEnded', id: TAKE - 1 }],
      ['Waking', { t: 'micGranted', req: REQ - 1 }],
      ['Waking', { t: 'micDenied', req: REQ - 1 }],
      ['Waking', { t: 'noDevice', req: REQ - 1 }],
      ['Listening', { t: 'armed', epoch: EPOCH - 1, armFrame: 1 }],
      ['Recording', { t: 'floorSnapshot', epoch: EPOCH - 1, floorDb: -30 }],
    ];
    for (const [name, e] of cases) expectIgnored(stateIn(name, { ctxRunning: true }), e);
  });

  it('row 45: first worker failure in a mic-open state → Cooldown (restart once)', () => {
    const into = (
      from: StateName,
      row: Effect[],
      extra: Partial<SessionState> = {},
      over: Partial<SessionState> = {},
    ) =>
      expectStep(
        stateIn(from, over),
        { t: 'workerFailed' },
        'Cooldown',
        [...EXIT[from], ...row, ...(ARMED.has(from) ? [disarm(EPOCH)] : []), COOLDOWN_T],
        { workerRestarts: 1, ...extra },
      );
    into('Listening', [RESTART, anim('confused')]);
    into('Recording', [RESTART, anim('confused')]);
    into('Processing', [RESTART, anim('confused')]);
    into('Playing', [STOP, RESTART, anim('confused')], { playingId: null, sfxEndedSeq: SEQ });
    // D23: an audible sfx is stopped too, so the cooldown never starts while it plays.
    into('SfxGated', [STOP, RESTART, anim('confused')], { sfxEndedSeq: SEQ }, { sfxEndedSeq: SEQ - 1 });
    // Cooldown stays in Cooldown: no exit or entry, the row's own timer cooldown restarts the wait.
    expectStep(
      stateIn('Cooldown'),
      { t: 'workerFailed' },
      'Cooldown',
      [RESTART, anim('confused'), COOLDOWN_T],
      {
        workerRestarts: 1,
      },
    );
    // The recording watchdog counts as a worker failure.
    expectStep(
      stateIn('Recording'),
      tmr('recording'),
      'Cooldown',
      [cancel('recording'), RESTART, anim('confused'), disarm(EPOCH), COOLDOWN_T],
      { workerRestarts: 1 },
    );
  });

  it('row 46: a second worker failure in one wake → Error', () => {
    for (const from of MIC_OPEN) {
      const s = stateIn(from, { workerRestarts: 1 });
      expectStep(
        s,
        { t: 'workerFailed' },
        'Error',
        [
          ...EXIT[from],
          ...(ARMED.has(from) ? [disarm(EPOCH)] : []),
          ...ERROR_ENTRY,
          wakeLock(false),
          ui('error'),
        ],
        stopFields(s, 'Error'),
      );
    }
    const s = stateIn('Recording', { workerRestarts: 1 });
    expectStep(
      s,
      tmr('recording'),
      'Error',
      [cancel('recording'), disarm(EPOCH), ...ERROR_ENTRY, wakeLock(false), ui('error')],
      stopFields(s, 'Error'),
    );
  });
});

// ---- Validation 2: entry/exit ------------------------------------------------------------------------------
describe('entry and exit actions', () => {
  it('entering Asleep from each awake state stops everything and shows tapToWake', () => {
    for (const from of AWAKE) {
      const s = deepFreeze(stateIn(from));
      const r = transitionTo(s, 'Asleep', DEFAULT_CONFIG);
      expect(r.state.name).toBe('Asleep');
      expect(r.effects).toStrictEqual([
        ...EXIT[from],
        ...(ARMED.has(from) ? [disarm(EPOCH)] : []),
        cancel('*'),
        STOP,
        CLOSE_MIC,
        { k: 'suspendCtx' },
        anim('sleep'),
        // C1: MicDenied does not hold the wake lock, so there is nothing to release.
        ...(from === 'MicDenied' ? [] : [wakeLock(false)]),
        ui('tapToWake'),
      ]);
      expect(r.state).toStrictEqual({ ...s, ...stopFields(s, 'Asleep'), name: 'Asleep' });
    }
  });

  it('a transition runs exit, row, entry, then derived effects; disarm is the first entry action', () => {
    const r = transitionTo(deepFreeze(stateIn('Listening', { micMuted: true })), 'Error', DEFAULT_CONFIG, [
      RESTART,
    ]);
    expect(r.effects).toStrictEqual([
      cancel('sleep'),
      cancel('doze'),
      RESTART,
      disarm(EPOCH),
      ...ERROR_ENTRY,
      wakeLock(false),
      ui('error'),
    ]);
  });

  it('same-state rows run no exit or entry actions', () => {
    const r = transitionTo(deepFreeze(stateIn('Cooldown')), 'Cooldown', DEFAULT_CONFIG, [RESTART]);
    expect(r.effects).toStrictEqual([RESTART]);
  });
});

// ---- Validation 3: clarifications ----------------------------------------------------------------------------
describe('clarifications C1–C12', () => {
  it('C1: wakeLock is derived from WAKE_LOCK_HELD changes only', () => {
    let s = stateIn('Asleep', { permission: 'prompt' });
    let r = run(s, { t: 'tapBear' });
    expect(r.effects.filter((f) => f.k === 'wakeLock')).toStrictEqual([wakeLock(true)]);
    s = r.state;
    r = run(s, { t: 'parentContinue' }); // NeedsParent → Waking: held → held
    expect(r.effects.some((f) => f.k === 'wakeLock')).toBe(false);
    s = r.state;
    r = run(s, { t: 'micDenied', req: s.micReq }); // Waking → MicDenied: released
    expect(r.effects.filter((f) => f.k === 'wakeLock')).toStrictEqual([wakeLock(false)]);
    s = r.state;
    r = run(s, tmr('sleep')); // MicDenied → Asleep: neither holds it
    expect(r.effects.some((f) => f.k === 'wakeLock')).toBe(false);
  });

  it('C2: overlayFor and derived ui effects', () => {
    const expected: Record<StateName, Overlay> = {
      Asleep: 'tapToWake',
      NeedsParent: 'parentPermission',
      Waking: null,
      MicDenied: 'micHelp',
      Listening: null,
      Recording: null,
      Processing: null,
      Playing: null,
      SfxGated: null,
      Cooldown: null,
      Paused: null,
      Error: 'error',
    };
    const plain = { tooNoisy: false, holdToTalk: false };
    for (const name of STATES) {
      expect(overlayFor({ name, micMuted: false, ...plain })).toBe(expected[name]);
      expect(overlayFor({ name, micMuted: true, ...plain })).toBe(
        name === 'Listening' ? 'micMuted' : expected[name],
      );
      // #116: Listening shows muted > hold-to-talk > too noisy; Recording keeps the hold button.
      for (const micMuted of [false, true]) {
        for (const tooNoisy of [false, true]) {
          for (const holdToTalk of [false, true]) {
            const want =
              name === 'Listening'
                ? micMuted
                  ? 'micMuted'
                  : holdToTalk
                    ? 'holdToTalk'
                    : tooNoisy
                      ? 'tooNoisy'
                      : null
                : name === 'Recording' && holdToTalk
                  ? 'holdToTalk'
                  : expected[name];
            expect(overlayFor({ name, micMuted, tooNoisy, holdToTalk }), name).toBe(want);
          }
        }
      }
    }
    // Entering Listening while muted shows the badge; leaving Listening hides it.
    expect(run(stateIn('Cooldown', { micMuted: true }), tmr('cooldown')).effects.at(-1)).toStrictEqual(
      ui('micMuted'),
    );
    const onset = run(stateIn('Listening', { micMuted: true }), seg(EPOCH, { kind: 'start', frame: 1 }));
    expect(onset.effects.at(-1)).toStrictEqual(ui(null));
    // A mute outside Listening changes no overlay; a repeated mute in Listening is a no-op.
    expect(run(stateIn('Processing'), { t: 'trackMuted' }).effects).toStrictEqual([]);
    expectIgnored(stateIn('Listening', { micMuted: true }), { t: 'trackMuted' });
  });

  it('C3: tapBear is handled only in Asleep and Error', () => {
    for (const name of STATES) {
      expect(TABLE[name].tapBear === 'ignore').toBe(name !== 'Asleep' && name !== 'Error');
    }
  });

  it('C4: reactions — ignored while not awake or waking; sfx seq numbering; anim shape', () => {
    for (const name of ['Waking', 'NeedsParent', 'Asleep', 'Paused', 'Error'] as const) {
      expect(TABLE[name].reaction).toBe('ignore');
    }
    let s = stateIn('MicDenied', { permission: 'denied' });
    let r = run(s, reaction(2, true));
    expect(r.effects[0]).toStrictEqual(sfx(SEQ + 1));
    s = r.state;
    r = run(s, reaction(4, true));
    expect(r.effects).toStrictEqual([
      sfx(SEQ + 2),
      { k: 'anim', ev: { e: 'reaction', name: 'poke', priority: 4 } },
      SLEEP_T,
    ]);
    expect(r.state.sfxSeq).toBe(SEQ + 2);
  });

  it('C5: sfx audibility gates rows 6 and 35 into SfxGated; sfxAtSpeakerEnded is a max in every state', () => {
    for (const name of STATES) {
      if (name === 'SfxGated') continue; // row 34
      const s = stateIn(name, { sfxSeq: 6, sfxEndedSeq: 4 });
      expect(run(s, { t: 'sfxAtSpeakerEnded', seq: 5 }).state.sfxEndedSeq).toBe(5);
      expectIgnored(s, { t: 'sfxAtSpeakerEnded', seq: 3 });
    }
    // A MicDenied reaction sound is still audible when Waking completes: gate instead of arming.
    let s = stateIn('MicDenied', { permission: 'denied' });
    s = run(s, reaction(2, true)).state;
    s = run(s, { t: 'settingsRetry' }).state;
    s = run(s, { t: 'ctxRunning', sampleRate: 48_000 }).state;
    let r = run(s, { t: 'micGranted', req: s.micReq });
    expect(r.state.name).toBe('SfxGated');
    expect(r.effects).toStrictEqual([cancel('waking')]);
    r = run(r.state, { t: 'sfxAtSpeakerEnded', seq: r.state.sfxSeq });
    expect(r.state.name).toBe('Cooldown');
    r = run(r.state, tmr('cooldown'));
    expect(r.state.name).toBe('Listening');
    expect(r.effects.some((f) => f.k === 'arm')).toBe(true);
    // Row 35 with an audible sfx (after a worker failure in SfxGated).
    expectStep(stateIn('Cooldown', { sfxEndedSeq: SEQ - 1 }), tmr('cooldown'), 'SfxGated', [
      cancel('cooldown'),
    ]);
  });

  it('C6: ctxRunning is recorded in every state; Waking completes in either order', () => {
    for (const name of STATES) {
      const r = run(stateIn(name, { ctxRunning: false, sampleRate: 48_000 }), {
        t: 'ctxRunning',
        sampleRate: 44_100,
      });
      expect(r.state.ctxRunning).toBe(true);
      expect(r.state.sampleRate).toBe(44_100);
    }
    const w = stateIn('Waking');
    const viaCtx = run(run(w, { t: 'ctxRunning', sampleRate: 48_000 }).state, { t: 'micGranted', req: REQ });
    const viaMic = run(run(w, { t: 'micGranted', req: REQ }).state, { t: 'ctxRunning', sampleRate: 48_000 });
    expect(viaCtx.state).toStrictEqual(viaMic.state);
    expect(viaCtx.state.name).toBe('Listening');
    // Rows 40 and 35b re-enter Waking with the context still running.
    expect(run(stateIn('Listening'), { t: 'inputsChanged' }).state.ctxRunning).toBe(true);
    expect(run(stateIn('Cooldown', { reselectPending: true }), tmr('cooldown')).state.ctxRunning).toBe(true);
  });

  it('C7: a first worker failure in Waking stays in Waking; the second goes to Error', () => {
    const s = stateIn('Waking');
    const first = expectStep(s, { t: 'workerFailed' }, 'Waking', [RESTART], { workerRestarts: 1 });
    expect(run(first.state, { t: 'workerFailed' }).state.name).toBe('Error');
  });

  it('C8: take range, armed and floorSnapshot', () => {
    const endAt = (last: number) =>
      seg(EPOCH, { kind: 'end', frame: last + 1, lastSpeechFrame: last, reason: 'silence' });
    const takeOf = (s: SessionState) => run(s, endAt(200_000)).effects.find((f) => f.k === 'take');
    // armFrame later than onset − pre-roll clamps the start.
    expect(takeOf(stateIn('Recording', { armFrame: 140_000 }))).toMatchObject({ fromFrame: 140_000 });
    // No armed yet: keep 100 ms of pre-roll.
    expect(takeOf(stateIn('Recording', { armFrame: null }))).toMatchObject({ fromFrame: 144_000 - 4_800 });
    // 44.1 kHz context: 300 ms = 13 230 frames, 150 ms = 6 615 frames.
    expect(takeOf(stateIn('Recording', { sampleRate: 44_100, armFrame: 0 }))).toStrictEqual({
      k: 'take',
      epoch: EPOCH,
      id: TAKE + 1,
      fromFrame: 144_000 - 13_230,
      toFrame: 200_000 + 6_615,
    });
    // armed / floorSnapshot with the current epoch are stored in any state; stale ones are ignored.
    for (const name of STATES) {
      const s = stateIn(name, { armFrame: null });
      expect(run(s, { t: 'armed', epoch: EPOCH, armFrame: 123 }).state.armFrame).toBe(123);
      expect(run(s, { t: 'floorSnapshot', epoch: EPOCH, floorDb: -41 }).state.floorDb).toBe(-41);
      expectIgnored(s, { t: 'armed', epoch: EPOCH + 1, armFrame: 123 });
      expectIgnored(s, { t: 'floorSnapshot', epoch: EPOCH - 1, floorDb: -41 });
    }
  });

  it('C9: processing chain guards, playingId, and stopPlayback ending earlier sfx first', () => {
    const p = stateIn('Processing');
    expectIgnored(p, { t: 'clipReady', epoch: EPOCH, id: TAKE + 1 });
    expectIgnored(p, { t: 'fxError', id: TAKE + 1 });
    const playing = run(p, { t: 'processed', id: TAKE, durationSec: 2 }).state;
    expect(playing.playingId).toBe(TAKE);
    expectIgnored(playing, { t: 'playbackAtSpeakerEnded', id: TAKE + 1 });
    // Every way out of Playing clears playingId.
    const outs: SessionEvent[] = [
      { t: 'playbackAtSpeakerEnded', id: TAKE },
      reaction(3, true),
      reaction(3, false),
      { t: 'hidden' },
      { t: 'ctxError' },
      { t: 'workerFailed' },
    ];
    for (const e of outs) expect(run(playing, e).state.playingId).toBeNull();
    // stopPlayback sets sfxEndedSeq = sfxSeq before the row's new sfx.
    const r = run(stateIn('Playing', { sfxSeq: 9, sfxEndedSeq: 8 }), reaction(3, true));
    expect(r.state.sfxEndedSeq).toBe(9);
    expect(r.state.sfxSeq).toBe(10);
    expect(r.effects).toContainEqual(sfx(10));
  });

  it('C10: permission and mute bookkeeping', () => {
    for (const name of STATES) {
      const s = stateIn(name, { permission: 'prompt' });
      expect(run(s, { t: 'permissionChanged', state: 'denied' }).state.permission).toBe('denied');
      expect(run(s, { t: 'permissionChanged', state: 'granted' }).state.permission).toBe('granted');
      expect(run(s, { t: 'trackMuted' }).state.micMuted).toBe(true);
      expect(run(stateIn(name, { micMuted: true }), { t: 'trackUnmuted' }).state.micMuted).toBe(false);
    }
    expect(
      run(stateIn('MicDenied', { permission: 'denied' }), { t: 'permissionChanged', state: 'prompt' }).state,
    ).toMatchObject({ name: 'MicDenied', permission: 'prompt' });
    expect(run(stateIn('Waking'), { t: 'micDenied', req: REQ }).state.permission).toBe('denied');
    expect(run(stateIn('Waking'), { t: 'noDevice', req: REQ }).state.permission).toBe('granted');
    expect(
      run(stateIn('Listening', { micMuted: true }), { t: 'trackUnmuted' }).state.floorDb,
    ).toBeUndefined();
  });

  it('C11: visibility, updateReady and applyUpdate', () => {
    for (const name of STATES) {
      expect(run(stateIn(name), { t: 'updateReady' }).state.updateReady).toBe(true);
      expect(TABLE[name].visible === 'ignore').toBe(name !== 'Paused');
      for (const t of ['hidden', 'pagehide', 'freeze'] as const) {
        const plain = run(stateIn(name), { t });
        expect(plain.state.name).toBe(hideTarget(name));
        expect(plain.effects.some((f) => f.k === 'applyUpdate')).toBe(false);
        for (const flags of [{ updateReady: true }, { updateReady: true, updateActivated: true }]) {
          const ready = run(stateIn(name, flags), { t });
          expect(ready.effects.at(-1)).toStrictEqual({ k: 'applyUpdate' });
          expect(ready.effects.slice(0, -1)).toStrictEqual(plain.effects);
          expect(ready.state).toStrictEqual({ ...plain.state, updateReady: false, updateActivated: false });
        }
      }
    }
    // Already asleep: hidden has no effect but the update.
    expect(run(stateIn('Asleep', { updateReady: true }), { t: 'hidden' }).effects).toStrictEqual([
      { k: 'applyUpdate' },
    ]);
    expectIgnored(stateIn('Asleep'), { t: 'hidden' });
    // Falling asleep by timer never applies the update.
    const bySleep = run(stateIn('Listening', { updateReady: true }), tmr('sleep'));
    expect(bySleep.state).toMatchObject({ name: 'Asleep', updateReady: true });
    expect(bySleep.effects.some((f) => f.k === 'applyUpdate')).toBe(false);
  });

  it('C3–C12: events owned by specific rows are ignored everywhere else (plan decision D20)', () => {
    const handledIn: Partial<Record<EventType, StateName[]>> = {
      parentContinue: ['NeedsParent'],
      settingsRetry: ['Asleep', 'MicDenied'],
      micGranted: ['Waking'],
      micDenied: ['Waking'],
      noDevice: ['Waking'],
      ctxResumeFailed: ['Waking'],
      seg: ['Listening', 'Recording'],
      holdStart: ['Listening'],
      holdEnd: ['Recording'],
      clipReady: ['Processing'],
      takeFailed: ['Processing'],
      processed: ['Processing'],
      fxError: ['Processing'],
      playbackAtSpeakerEnded: ['Playing'],
      visible: ['Paused'],
      timer: [
        'NeedsParent',
        'Waking',
        'MicDenied',
        'Listening',
        'Recording',
        'Processing',
        'Cooldown',
        'Error',
      ],
    };
    for (const t of EVENT_TYPES) {
      const states = handledIn[t];
      if (states === undefined) continue;
      for (const name of STATES) {
        expect(TABLE[name][t] === 'ignore', `${name} × ${t}`).toBe(!states.includes(name));
      }
    }
    // Field updates apply in every state (C5, C6, C8, C10, C11), so they are never 'ignore'.
    const everywhere: EventType[] = [
      'permissionChanged',
      'ctxRunning',
      'armed',
      'floorSnapshot',
      'sfxAtSpeakerEnded',
      'trackMuted',
      'trackUnmuted',
      'updateReady',
      'hidden',
      'pagehide',
      'freeze',
      'noiseFloor',
    ];
    for (const t of everywhere) for (const name of STATES) expect(TABLE[name][t]).not.toBe('ignore');
  });

  it('C12: devices and failures', () => {
    for (const name of STATES) {
      const handles = ARMED.has(name) || GATED.has(name);
      expect(TABLE[name].inputsChanged === 'ignore').toBe(!handles);
      expect(TABLE[name].workerFailed === 'ignore').toBe(!MIC_OPEN.has(name));
      expect(TABLE[name].ctxError === 'ignore').toBe(!AWAKE.has(name));
      expect(TABLE[name].trackEnded === 'ignore').toBe(!AWAKE.has(name));
      if (name !== 'Recording') expectIgnored(stateIn(name), tmr('recording'));
    }
    // Row 35b: closeMic, reselectInput, then the Waking entry.
    const r = run(stateIn('Cooldown', { reselectPending: true }), tmr('cooldown'));
    expect(r.effects.map((f) => f.k)).toStrictEqual([
      'cancelTimer',
      'closeMic',
      'reselectInput',
      'openMic',
      'timer',
    ]);
  });
});

// ---- Plan decisions: approved deviations D2–D4, D6, D22–D26 (ORCH-ANSWERs on #28); literal rows 32/36 ----
describe('plan decisions', () => {
  it('rows 32 and 36 emit no anim (C4: as in the plan)', () => {
    for (const from of ['SfxGated', 'Cooldown'] as const) {
      for (const priority of [1, 2, 3, 4] as const) {
        const r = run(stateIn(from), reaction(priority, true));
        expect(r.state.name).toBe('SfxGated');
        expect(r.effects.some((f) => f.k === 'anim')).toBe(false);
      }
    }
  });

  it('D2: a worker failure while Playing stops the replay before the cooldown; no arm until timer cooldown', () => {
    // A reaction sound is still audible as well (sfxSeq > sfxEndedSeq): stopPlayback silences it too.
    const s = stateIn('Playing', { sfxSeq: SEQ + 1 });
    const r = run(s, { t: 'workerFailed' });
    const stopAt = r.effects.findIndex((f) => f.k === 'stopPlayback');
    const cooldownAt = r.effects.findIndex((f) => f.k === 'timer' && f.name === 'cooldown');
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(cooldownAt).toBeGreaterThan(stopAt);
    expect(r.effects[cooldownAt]).toStrictEqual(COOLDOWN_T);
    expect(r.effects.some((f) => f.k === 'arm')).toBe(false);
    expect(r.state).toMatchObject({
      name: 'Cooldown',
      playingId: null,
      sfxSeq: SEQ + 1,
      sfxEndedSeq: SEQ + 1,
    });
    // Nothing else re-arms from this Cooldown; only the cooldown timer does, into Listening.
    for (const e of [reaction(2, false), { t: 'sfxAtSpeakerEnded', seq: SEQ } as const, tmr('sleep')]) {
      expect(run(r.state, e).effects.some((f) => f.k === 'arm')).toBe(false);
    }
    const rearm = run(r.state, tmr('cooldown'));
    expect(rearm.state.name).toBe('Listening');
    expect(rearm.effects.some((f) => f.k === 'arm')).toBe(true);
  });

  it('D3: entering Asleep, Paused or Error drops a pending input re-selection', () => {
    for (const e of [{ t: 'hidden' } as const, { t: 'ctxError' } as const]) {
      const r = run(stateIn('Cooldown', { reselectPending: true }), e);
      expect(r.state.reselectPending).toBe(false);
    }
    const asleep = transitionTo(
      deepFreeze(stateIn('Processing', { reselectPending: true })),
      'Asleep',
      DEFAULT_CONFIG,
    );
    expect(asleep.state.reselectPending).toBe(false);
    // …so the next wake arms without a stale reselect.
    let s = run(stateIn('Cooldown', { reselectPending: true }), { t: 'hidden' }).state;
    s = run(s, { t: 'visible' }).state;
    s = run(s, { t: 'ctxRunning', sampleRate: 48_000 }).state;
    const r = run(s, { t: 'micGranted', req: s.micReq });
    expect(r.state).toMatchObject({ name: 'Listening', reselectPending: false });
  });

  it('D4: tapping in Error wakes by permission, never prompting from a child tap', () => {
    const prompt = run(stateIn('Error', { permission: 'prompt' }), { t: 'tapBear' });
    expect(prompt.state.name).toBe('NeedsParent');
    expect(prompt.effects.some((f) => f.k === 'openMic')).toBe(false);
    expect(run(stateIn('Error', { permission: 'denied' }), { t: 'tapBear' }).state.name).toBe('MicDenied');
  });

  it('D6: the doze timer re-arms when it fires, so Listening keeps both timers armed', () => {
    const r = run(stateIn('Listening'), tmr('doze'));
    expect(r.state.name).toBe('Listening');
    expect(r.effects).toContainEqual(DOZE_T);
    expect(r.effects.some((f) => f.k === 'cancelTimer')).toBe(false); // the sleep timer keeps running
  });

  it('D22: a MicDenied sfx that already left the speaker still gets its cooldown before the first arm', () => {
    let s = run(initialSessionState('denied'), { t: 'tapBear' }).state; // row 3 → MicDenied
    s = run(s, reaction(2, true)).state; // row 11: sfx seq 1
    expect(s).toMatchObject({ name: 'MicDenied', sfxSeq: 1, micDeniedSfx: true });
    s = run(s, { t: 'ctxRunning', sampleRate: 48_000 }).state;
    s = run(s, { t: 'settingsRetry' }).state; // row 10 → Waking
    s = run(s, { t: 'sfxAtSpeakerEnded', seq: 1 }).state; // the sfx left the speaker while Waking
    const r = expectStep(s, { t: 'micGranted', req: s.micReq }, 'Cooldown', [cancel('waking'), COOLDOWN_T], {
      micGranted: true,
      micDeniedSfx: false,
    });
    const rearm = run(r.state, tmr('cooldown'));
    expect(rearm.state.name).toBe('Listening');
    expect(rearm.effects.some((f) => f.k === 'arm')).toBe(true);
    // Entering Asleep, Paused or Error clears the flag.
    expect(run(stateIn('MicDenied', { micDeniedSfx: true }), { t: 'hidden' }).state.micDeniedSfx).toBe(false);
  });

  it('D23: a worker failure in SfxGated stops the sfx before the cooldown; a pending reselect waits for it', () => {
    let s = stateIn('SfxGated', { sfxEndedSeq: SEQ - 1 }); // an sfx is audible
    s = run(s, { t: 'inputsChanged' }).state; // row 40b
    const r = run(s, { t: 'workerFailed' });
    const stopAt = r.effects.findIndex((f) => f.k === 'stopPlayback');
    const cooldownAt = r.effects.findIndex((f) => f.k === 'timer' && f.name === 'cooldown');
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(cooldownAt).toBeGreaterThan(stopAt);
    expect(r.state).toMatchObject({ name: 'Cooldown', reselectPending: true, sfxEndedSeq: SEQ, sfxSeq: SEQ });
    const reselect = run(r.state, tmr('cooldown')); // row 35b
    expect(reselect.state.name).toBe('Waking');
    expect(reselect.effects.map((f) => f.k)).toContain('reselectInput');
    // Without a pending reselect the same path reaches Listening, arming only on the cooldown timer.
    const plain = run(stateIn('SfxGated', { sfxEndedSeq: SEQ - 1 }), { t: 'workerFailed' });
    expect(plain.effects.some((f) => f.k === 'arm')).toBe(false);
    const listen = run(plain.state, tmr('cooldown'));
    expect(listen.state.name).toBe('Listening');
    expect(listen.effects.some((f) => f.k === 'arm')).toBe(true);
  });

  it('D25: tapping to retry from Error starts a fresh wake (workerRestarts reset)', () => {
    const error = run(stateIn('Listening', { workerRestarts: 1 }), { t: 'workerFailed' }).state; // row 46
    expect(error).toMatchObject({ name: 'Error', workerRestarts: 1 });
    let s = run(error, { t: 'tapBear' }).state; // row 42, permission granted
    expect(s).toMatchObject({ name: 'Waking', workerRestarts: 0 });
    s = run(s, { t: 'ctxRunning', sampleRate: 48_000 }).state;
    s = run(s, { t: 'micGranted', req: s.micReq }).state;
    expect(s.name).toBe('Listening');
    const r = run(s, { t: 'workerFailed' }); // a single failure now restarts the worker (row 45), not Error
    expect(r.state).toMatchObject({ name: 'Cooldown', workerRestarts: 1 });
    expect(r.effects).toContainEqual(RESTART);
    for (const permission of ['prompt', 'denied'] as const) {
      expect(
        run(stateIn('Error', { permission, workerRestarts: 1 }), { t: 'tapBear' }).state.workerRestarts,
      ).toBe(0);
    }
  });

  it('D26: after an input reselect, the next arm restores no floor from the previous input', () => {
    const viaRow40 = run(stateIn('Listening'), { t: 'inputsChanged' }).state;
    const viaRow35b = run(stateIn('Cooldown', { reselectPending: true }), tmr('cooldown')).state;
    for (const waking of [viaRow40, viaRow35b]) {
      expect(waking).toMatchObject({ name: 'Waking', floorDb: undefined });
      const r = run(waking, { t: 'micGranted', req: waking.micReq });
      expect(r.state.name).toBe('Listening');
      expect(r.effects.find((f) => f.k === 'arm')).toStrictEqual({ k: 'arm', epoch: r.state.epoch });
    }
  });
});

// ---- #266: "Try the microphone again" from Asleep (the sleep timer fired while the settings sheet was open) ----
describe("#266: settingsRetry from Asleep (the parent's retry wakes as the tap does)", () => {
  it('Asleep + settingsRetry gives the same state and effects as Asleep + tapBear, for every permission', () => {
    for (const permission of ['granted', 'prompt', 'denied'] as const) {
      for (const v of variants('Asleep')) {
        const s: SessionState = { ...v, permission };
        const tap = run(s, { t: 'tapBear' });
        const retry = run(s, { t: 'settingsRetry' });
        expect(retry.state, permission).toStrictEqual(tap.state);
        expect(retry.effects, permission).toStrictEqual(tap.effects);
        // Not ignored: a wake, or (#277, another tab's update) only the reload, which keeps the state object.
        if (s.updateActivated) expect(retry.effects, permission).toStrictEqual([{ k: 'applyUpdate' }]);
        else expect(retry.state, permission).not.toBe(s);
      }
    }
  });

  it('Asleep + settingsRetry: granted → Waking (row 1, the normal wake), prompt → NeedsParent (row 2), denied → MicDenied (row 3)', () => {
    expectStep(
      stateIn('Asleep'),
      { t: 'settingsRetry' },
      'Waking',
      [RESUME, anim('wake'), ...wakingEntry(REQ + 1), wakeLock(true), ui(null)],
      { micReq: REQ + 1, micGranted: false },
    );
    expectStep(stateIn('Asleep', { permission: 'prompt' }), { t: 'settingsRetry' }, 'NeedsParent', [
      RESUME,
      SLEEP_T,
      wakeLock(true),
      ui('parentPermission'),
    ]);
    expectStep(stateIn('Asleep', { permission: 'denied' }), { t: 'settingsRetry' }, 'MicDenied', [
      RESUME,
      anim('wake'),
      SLEEP_T,
      ui('micHelp'),
    ]);
  });

  it('MicDenied + settingsRetry is unchanged: Waking for every permission (row 10)', () => {
    for (const permission of ['denied', 'prompt', 'granted'] as const) {
      expectStep(
        stateIn('MicDenied', { permission }),
        { t: 'settingsRetry' },
        'Waking',
        [cancel('sleep'), RESUME, anim('wake'), ...wakingEntry(REQ + 1), wakeLock(true), ui(null)],
        { micReq: REQ + 1, micGranted: false },
      );
    }
  });

  it('every other state still ignores settingsRetry', () => {
    const ignoring = STATES.filter((n) => TABLE[n].settingsRetry === 'ignore');
    expect(ignoring).toStrictEqual([
      'NeedsParent',
      'Waking',
      'Listening',
      'Recording',
      'Processing',
      'Playing',
      'SfxGated',
      'Cooldown',
      'Paused',
      'Error',
    ]);
    for (const name of ignoring) for (const s of variants(name)) expectIgnored(s, { t: 'settingsRetry' });
  });

  it('the #266 sequence: MicDenied, the sleep timer fires while the sheet is open, then the parent retries', () => {
    const denied = run(stateIn('Waking'), { t: 'micDenied', req: REQ }).state; // row 8
    expect(denied).toMatchObject({ name: 'MicDenied', permission: 'denied' });
    const asleep = run(denied, tmr('sleep')).state; // row 12, while the modal sheet blocks every tap
    expect(asleep).toMatchObject({ name: 'Asleep', permission: 'denied' });

    // (a) The parent allowed the mic in site settings (the permission module reports it): the retry wakes.
    const allowed = run(asleep, { t: 'permissionChanged', state: 'granted' }).state;
    expect(allowed).toMatchObject({ name: 'Asleep', permission: 'granted' });
    let r = run(allowed, { t: 'settingsRetry' });
    expect(r.state.name).toBe('Waking');
    expect(r.effects).toContainEqual(openMic(allowed.micReq + 1));
    r = run(r.state, { t: 'ctxRunning', sampleRate: 48_000 });
    r = run(r.state, { t: 'micGranted', req: r.state.micReq });
    expect(r.state.name).toBe('Listening');
    expect(r.effects.some((f) => f.k === 'arm')).toBe(true);

    // (b) The parent reset it to "ask": the parent sheet, whose Continue puts Chrome's prompt up (row 4).
    r = run(run(asleep, { t: 'permissionChanged', state: 'prompt' }).state, { t: 'settingsRetry' });
    expect(r.state.name).toBe('NeedsParent');
    expect(r.effects.some((f) => f.k === 'openMic')).toBe(false);
    r = run(r.state, { t: 'parentContinue' });
    expect(r.state.name).toBe('Waking');
    expect(r.effects).toContainEqual(openMic(asleep.micReq + 1));

    // (c) Still denied: MicDenied again, as after a tap (row 3); a second retry there runs row 10.
    r = run(asleep, { t: 'settingsRetry' });
    expect(r.state.name).toBe('MicDenied');
    expect(r.effects.some((f) => f.k === 'openMic')).toBe(false);
    r = run(r.state, { t: 'settingsRetry' });
    expect(r.state.name).toBe('Waking');
    expect(r.effects).toContainEqual(openMic(asleep.micReq + 1));
  });
});

/** #277: a state in which another tab activated the update (both flags set). */
function flagged(name: StateName, over: Partial<SessionState> = {}): SessionState {
  return stateIn(name, { updateReady: true, updateActivated: true, ...over });
}

// ---- #277: a visible Asleep page another tab updated reloads at its next wake (row 3c) ---------------------------
describe('#277: an Asleep wake after another tab activated the update reloads instead', () => {
  const PERMISSIONS = ['granted', 'prompt', 'denied'] as const;
  const APPLY: Effect[] = [{ k: 'applyUpdate' }];

  it('updateReady{activated} sets both flags in every state; a later plain updateReady keeps the flag', () => {
    for (const name of STATES) {
      const a = run(stateIn(name), { t: 'updateReady', activated: true });
      expect(a.effects).toStrictEqual([]);
      expect(a.state).toStrictEqual({ ...stateIn(name), updateReady: true, updateActivated: true });
      const p = run(stateIn(name), { t: 'updateReady' });
      expect(p.effects).toStrictEqual([]);
      expect(p.state).toStrictEqual({ ...stateIn(name), updateReady: true });
      expect(p.state.updateActivated).toBe(false);
      // Its own onNeedRefresh of an even newer version: the page still runs old code.
      expectIgnored(a.state, { t: 'updateReady' });
      expectIgnored(a.state, { t: 'updateReady', activated: true });
    }
  });

  it('Asleep + tapBear with the flag → applyUpdate only, the same state, no wake effects (Validation 2a)', () => {
    for (const permission of PERMISSIONS) {
      const s = flagged('Asleep', { permission });
      expectStep(s, { t: 'tapBear' }, 'Asleep', APPLY);
      expect(run(s, { t: 'tapBear' }).state).toBe(s);
    }
  });

  it('Asleep + settingsRetry with the flag → applyUpdate only, as the tap (Decision 1)', () => {
    for (const permission of PERMISSIONS) {
      const s = flagged('Asleep', { permission });
      expectStep(s, { t: 'settingsRetry' }, 'Asleep', APPLY);
      expect(run(s, { t: 'settingsRetry' }).state).toBe(s);
    }
  });

  it('without the flag, Asleep + tapBear is rows 1–3, with or without its own update ready (Validation 2b)', () => {
    for (const updateReady of [false, true]) {
      expectStep(
        stateIn('Asleep', { updateReady }),
        { t: 'tapBear' },
        'Waking',
        [RESUME, anim('wake'), ...wakingEntry(REQ + 1), wakeLock(true), ui(null)],
        { micReq: REQ + 1, micGranted: false },
      );
      expectStep(stateIn('Asleep', { updateReady, permission: 'prompt' }), { t: 'tapBear' }, 'NeedsParent', [
        RESUME,
        SLEEP_T,
        wakeLock(true),
        ui('parentPermission'),
      ]);
      expectStep(stateIn('Asleep', { updateReady, permission: 'denied' }), { t: 'tapBear' }, 'MicDenied', [
        RESUME,
        anim('wake'),
        SLEEP_T,
        ui('micHelp'),
      ]);
    }
  });

  it('the flag changes nothing but the Asleep wake: every state × every event type (Validation 2c)', () => {
    let pairs = 0;
    for (const name of STATES) {
      const withFlag = flagged(name);
      const plain = stateIn(name, { updateReady: true });
      for (const t of EVENT_TYPES) {
        if (name === 'Asleep' && (t === 'tapBear' || t === 'settingsRetry')) continue;
        for (const e of SAMPLES[t](plain) as SessionEvent[]) {
          const x = run(withFlag, e);
          const y = run(plain, e);
          const label = `${name} + ${JSON.stringify(e)}`;
          expect(x.effects, label).toStrictEqual(y.effects);
          expect({ ...x.state, updateActivated: false }, label).toStrictEqual({
            ...y.state,
            updateActivated: false,
          });
          expect(x.state.updateActivated, label).toBe(!x.effects.some((f) => f.k === 'applyUpdate'));
          pairs++;
        }
      }
    }
    expect(pairs).toBeGreaterThan(STATES.length * (EVENT_TYPES.length - 1));
  });

  it('before the reload commits, a second tap or retry reloads again and never wakes; C11 then clears the flag', () => {
    const s = flagged('Asleep');
    let r = run(s, { t: 'tapBear' });
    r = run(r.state, { t: 'tapBear' }); // a second pointerdown (two fingers, a quick double tap)
    expect(r.effects).toStrictEqual(APPLY);
    expect(r.state).toBe(s);
    r = run(r.state, { t: 'settingsRetry' });
    expect(r.effects).toStrictEqual(APPLY);
    expect(r.state).toBe(s);
    r = run(r.state, { t: 'hidden' }); // C11
    expect(r.effects).toStrictEqual(APPLY);
    expect(r.state).toStrictEqual({ ...s, updateReady: false, updateActivated: false });
    expectStep(
      r.state,
      { t: 'tapBear' },
      'Waking',
      [RESUME, anim('wake'), ...wakingEntry(REQ + 1), wakeLock(true), ui(null)],
      { micReq: REQ + 1, micGranted: false },
    ); // row 1
  });
});

// ---- #116: noisy room (too-noisy hint, margin raises) and hold-to-talk ---------------------------------------
/** #116: a current seg end of Recording (lastSpeechFrame 190 000), with or without a voiced ratio. */
const end116 = (reason: 'silence' | 'maxLength', voicedRatio?: number): SessionEvent =>
  seg(
    EPOCH,
    voicedRatio === undefined
      ? { kind: 'end', frame: 220_000, lastSpeechFrame: 190_000, reason }
      : { kind: 'end', frame: 220_000, lastSpeechFrame: 190_000, reason, voicedRatio },
  );
/** Row 20's effects from Recording (onset 144 000, armFrame 96 000, 48 kHz) for a take to `toFrame`. */
const takeFx116 = (toFrame: number, ui0: Effect[] = []): Effect[] => [
  cancel('recording'),
  { k: 'take', epoch: EPOCH, id: TAKE + 1, fromFrame: 129_600, toFrame },
  anim('thinking'),
  disarm(EPOCH),
  PROCESSING_T,
  ...ui0,
];

describe('#116: noisy room and hold-to-talk', () => {
  /** Hold-to-talk mode at the top boost, in a noisy room. */
  const HOLD = { holdToTalk: true, tooNoisy: true, marginBoostDb: 6, noisyCaps: 3 } as const;
  /** Hold-mode Recording entry: the timer is the cap itself (ORCH-NOTE on #116). */
  const RECORDING_CAP_T = timer('recording', 10_000);
  it('row 18b: noiseFloor sets tooNoisy above −35 dBFS; Listening shows the badge', () => {
    const quiet = stateIn('Listening');
    expectStep(quiet, { t: 'noiseFloor', floorDb: -20 }, 'Listening', [ui('tooNoisy')], { tooNoisy: true });
    expectStep(quiet, { t: 'noiseFloor', floorDb: -34.9 }, 'Listening', [ui('tooNoisy')], { tooNoisy: true });
    expectIgnored(quiet, { t: 'noiseFloor', floorDb: -35 });
    expectIgnored(quiet, { t: 'noiseFloor', floorDb: Number.NaN });
    const noisy = stateIn('Listening', { tooNoisy: true });
    expectStep(noisy, { t: 'noiseFloor', floorDb: -50 }, 'Listening', [ui(null)], { tooNoisy: false });
    expectIgnored(noisy, { t: 'noiseFloor', floorDb: -30 });
    // Muted: the flag changes, the mic-muted badge stays.
    expectStep(stateIn('Listening', { micMuted: true }), { t: 'noiseFloor', floorDb: -20 }, 'Listening', [], {
      tooNoisy: true,
    });
    // Every other state only records the flag.
    for (const name of STATES) {
      if (name === 'Listening') continue;
      expectStep(stateIn(name), { t: 'noiseFloor', floorDb: -20 }, name, [], { tooNoisy: true });
    }
  });

  it('row 20: the noisy counter counts capped ends with a voiced ratio below 0.3; any other end resets it', () => {
    const s = stateIn('Recording', { noisyCaps: 1 });
    const capsAfter = (e: SessionEvent): number => run(s, e).state.noisyCaps;
    expect(capsAfter(end116('maxLength', 0.29))).toBe(2);
    expect(capsAfter(end116('maxLength', 0))).toBe(2);
    expect(capsAfter(end116('maxLength', 0.3))).toBe(0);
    expect(capsAfter(end116('silence', 0.1))).toBe(0);
    expect(capsAfter(end116('maxLength', Number.NaN))).toBe(0);
    expect(capsAfter(end116('maxLength'))).toBe(0); // unknown ratio
    // A misfire is not an end: the counter stays.
    expect(run(s, seg(EPOCH, { kind: 'misfire', frame: 150_000 })).state.noisyCaps).toBe(1);
  });

  it('row 20: the third noisy cap raises the margins by 3 dB (twice), then switches to hold-to-talk', () => {
    const fx = takeFx116(190_000 + 7_200);
    const noisy = end116('maxLength', 0.1);
    expectStep(stateIn('Recording', { noisyCaps: 2 }), noisy, 'Processing', fx, {
      takeId: TAKE + 1,
      noisyCaps: 0,
      marginBoostDb: 3,
    });
    expectStep(stateIn('Recording', { noisyCaps: 2, marginBoostDb: 3 }), noisy, 'Processing', fx, {
      takeId: TAKE + 1,
      noisyCaps: 0,
      marginBoostDb: 6,
    });
    expectStep(stateIn('Recording', { noisyCaps: 2, marginBoostDb: 6 }), noisy, 'Processing', fx, {
      takeId: TAKE + 1,
      noisyCaps: 3,
      holdToTalk: true,
    });
    // Three loops from scratch: Recording → Processing three times reaches boost 3.
    let st = stateIn('Recording');
    for (let i = 0; i < 3; i++) st = run({ ...st, name: 'Recording' }, noisy).state;
    expect(st).toMatchObject({ noisyCaps: 0, marginBoostDb: 3, holdToTalk: false });
  });

  it('entering Listening arms with the boost (only when > 0) and shows the hold button in hold-to-talk mode', () => {
    const armOf = (over: Partial<SessionState>): Effect | undefined =>
      run(stateIn('Cooldown', over), tmr('cooldown')).effects.find((f) => f.k === 'arm');
    expect(armOf({})).toStrictEqual({ k: 'arm', epoch: EPOCH + 1, restoreFloorDb: FLOOR });
    expect(armOf({ marginBoostDb: 3 })).toStrictEqual({
      k: 'arm',
      epoch: EPOCH + 1,
      restoreFloorDb: FLOOR,
      marginBoostDb: 3,
    });
    expect(armOf({ marginBoostDb: 6, floorDb: undefined })).toStrictEqual({
      k: 'arm',
      epoch: EPOCH + 1,
      marginBoostDb: 6,
    });
    expectStep(
      stateIn('Cooldown', HOLD),
      tmr('cooldown'),
      'Listening',
      [
        cancel('cooldown'),
        { k: 'arm', epoch: EPOCH + 1, restoreFloorDb: FLOOR, marginBoostDb: 6 },
        SLEEP_T,
        DOZE_T,
        anim('idle'),
        ui('holdToTalk'),
      ],
      { epoch: EPOCH + 1, armFrame: null, onsetFrame: null },
    );
  });

  it('hold-to-talk mode ignores every seg event in Listening and Recording', () => {
    for (const name of ['Listening', 'Recording'] as const) {
      const s = stateIn(name, HOLD);
      for (const e of SAMPLES.seg(s)) expectIgnored(s, e);
      for (const e of STALE.seg(s)) expectIgnored(s, e);
    }
  });

  it('row 13b: holdStart in hold-to-talk mode → Recording at its frame, with the cap as the recording timer', () => {
    expectStep(
      stateIn('Listening', HOLD),
      { t: 'holdStart', frame: 150_000 },
      'Recording',
      [cancel('sleep'), cancel('doze'), anim('attentive'), RECORDING_CAP_T],
      { onsetFrame: 150_000 },
    );
    expectIgnored(stateIn('Listening'), { t: 'holdStart', frame: 150_000 });
  });

  it('row 20b: holdEnd → Processing with row 20 take, the release clamped to [onset, onset + cap]', () => {
    const s = stateIn('Recording', HOLD); // onset 144 000, armFrame 96 000
    expectStep(s, { t: 'holdEnd', frame: 200_000 }, 'Processing', takeFx116(207_200, [ui(null)]), {
      takeId: TAKE + 1,
    });
    expectStep(s, { t: 'holdEnd', frame: 100_000 }, 'Processing', takeFx116(144_000 + 7_200, [ui(null)]), {
      takeId: TAKE + 1,
    });
    expectStep(
      s,
      { t: 'holdEnd', frame: 144_000 + 600_000 },
      'Processing',
      takeFx116(144_000 + 480_000 + 7_200, [ui(null)]),
      { takeId: TAKE + 1 },
    );
    expectIgnored(stateIn('Recording'), { t: 'holdEnd', frame: 200_000 });
  });

  it('row 20c: timer recording in hold-to-talk mode is a forced holdEnd at the cap: no restart, no Cooldown', () => {
    for (const workerRestarts of [0, 1]) {
      const r = expectStep(
        stateIn('Recording', { ...HOLD, workerRestarts }),
        tmr('recording'),
        'Processing',
        takeFx116(631_200, [ui(null)]),
        { takeId: TAKE + 1 },
      );
      expect(r.effects.some((f) => f.k === 'restartWorker')).toBe(false);
    }
    // Recording is only entered with an onset; without one the cap counts from the arm, then from 0.
    const take = (over: Partial<SessionState>): Effect | undefined =>
      run(stateIn('Recording', { ...HOLD, ...over }), tmr('recording')).effects.find((f) => f.k === 'take');
    expect(take({ onsetFrame: null })).toMatchObject({ toFrame: 96_000 + 480_000 + 7_200 });
    expect(take({ onsetFrame: null, armFrame: null })).toMatchObject({ toFrame: 480_000 + 7_200 });
    const r = run(stateIn('Recording', { ...HOLD, onsetFrame: null }), { t: 'holdEnd', frame: 200_000 });
    expect(r.effects.find((f) => f.k === 'take')).toMatchObject({
      fromFrame: 200_000 - 14_400,
      toFrame: 207_200,
    });
  });

  it('entering Asleep resets noisy mode and tooNoisy; Paused and Error keep them; Waking clears tooNoisy', () => {
    for (const from of AWAKE) {
      const s = stateIn(from, HOLD);
      expect(transitionTo(s, 'Asleep', DEFAULT_CONFIG).state).toMatchObject({
        noisyCaps: 0,
        marginBoostDb: 0,
        holdToTalk: false,
        tooNoisy: false,
      });
      expect(transitionTo(s, 'Paused', DEFAULT_CONFIG).state).toMatchObject(HOLD);
      expect(transitionTo(s, 'Error', DEFAULT_CONFIG).state).toMatchObject(HOLD);
    }
    const toWaking: [StateName, SessionEvent, Partial<SessionState>][] = [
      ['Error', { t: 'tapBear' }, {}], // row 42
      ['Paused', { t: 'visible' }, {}], // row 39
      ['Listening', { t: 'inputsChanged' }, {}], // row 40
      ['Cooldown', tmr('cooldown'), { reselectPending: true }], // row 35b
    ];
    for (const [from, e, over] of toWaking) {
      const r = run(stateIn(from, { ...HOLD, ...over }), e);
      expect(r.state.name).toBe('Waking');
      expect(r.state).toMatchObject({ tooNoisy: false, holdToTalk: true, marginBoostDb: 6 });
    }
  });
});

// ---- Validation 4 and 5: the full (state × event) cross product ------------------------------------------------
/** Representative current events for every event type. A missing type is a compile error. */
const SAMPLES: { [E in EventType]: (s: SessionState) => EventOf<E>[] } = {
  tapBear: () => [{ t: 'tapBear' }],
  parentContinue: () => [{ t: 'parentContinue' }],
  settingsRetry: () => [{ t: 'settingsRetry' }],
  permissionChanged: () =>
    (['granted', 'prompt', 'denied'] as const).map((state) => ({ t: 'permissionChanged', state })),
  micGranted: (s) => [{ t: 'micGranted', req: s.micReq }],
  micDenied: (s) => [{ t: 'micDenied', req: s.micReq }],
  noDevice: (s) => [{ t: 'noDevice', req: s.micReq }],
  ctxRunning: () => [{ t: 'ctxRunning', sampleRate: 44_100 }],
  ctxResumeFailed: () => [{ t: 'ctxResumeFailed' }],
  ctxError: () => [{ t: 'ctxError' }],
  armed: (s) => [{ t: 'armed', epoch: s.epoch, armFrame: 99_000 }],
  seg: (s) => [
    { t: 'seg', epoch: s.epoch, ev: { kind: 'start', frame: 150_000 } },
    {
      t: 'seg',
      epoch: s.epoch,
      ev: { kind: 'end', frame: 250_000, lastSpeechFrame: 200_000, reason: 'silence', voicedRatio: 0.8 },
    },
    {
      t: 'seg',
      epoch: s.epoch,
      ev: { kind: 'end', frame: 250_000, lastSpeechFrame: 200_000, reason: 'maxLength', voicedRatio: 0.8 },
    },
    {
      t: 'seg',
      epoch: s.epoch,
      ev: { kind: 'end', frame: 250_000, lastSpeechFrame: 200_000, reason: 'maxLength', voicedRatio: 0.1 },
    },
    { t: 'seg', epoch: s.epoch, ev: { kind: 'misfire', frame: 150_000 } },
  ],
  floorSnapshot: (s) => [{ t: 'floorSnapshot', epoch: s.epoch, floorDb: -44 }],
  clipReady: (s) => [{ t: 'clipReady', epoch: s.epoch, id: s.takeId }],
  takeFailed: (s) => [{ t: 'takeFailed', epoch: s.epoch, id: s.takeId }],
  processed: (s) => [{ t: 'processed', id: s.takeId, durationSec: 1.2 }],
  fxError: (s) => [{ t: 'fxError', id: s.takeId }],
  playbackAtSpeakerEnded: (s) => [{ t: 'playbackAtSpeakerEnded', id: s.playingId ?? s.takeId }],
  sfxAtSpeakerEnded: (s) => [
    { t: 'sfxAtSpeakerEnded', seq: s.sfxSeq },
    { t: 'sfxAtSpeakerEnded', seq: Math.max(0, s.sfxSeq - 1) },
  ],
  reaction: () => [reaction(1, false), reaction(2, true), reaction(3, true), reaction(4, false)],
  timer: () => (['cooldown', 'sleep', 'doze', 'processing', 'waking', 'recording'] as const).map(tmr),
  trackMuted: () => [{ t: 'trackMuted' }],
  trackUnmuted: () => [{ t: 'trackUnmuted' }],
  trackEnded: () => [{ t: 'trackEnded' }],
  inputsChanged: () => [{ t: 'inputsChanged' }],
  workerFailed: () => [{ t: 'workerFailed' }],
  hidden: () => [{ t: 'hidden' }],
  pagehide: () => [{ t: 'pagehide' }],
  freeze: () => [{ t: 'freeze' }],
  visible: () => [{ t: 'visible' }],
  updateReady: () => [{ t: 'updateReady' }, { t: 'updateReady', activated: true }],
  settingsChanged: () => [
    { t: 'settingsChanged', preset: PRESETS.chipmunk },
    { t: 'settingsChanged', preset: { id: 'custom', pitchRatio: 1.85 } },
  ],
  noiseFloor: () => [
    { t: 'noiseFloor', floorDb: -50 },
    { t: 'noiseFloor', floorDb: -20 },
  ],
  holdStart: () => [{ t: 'holdStart', frame: 150_000 }],
  holdEnd: () => [{ t: 'holdEnd', frame: 200_000 }],
};

/** Stale variants of the events that carry an epoch, id or req (row 44); [] for the others. */
const STALE: { [E in EventType]: (s: SessionState) => EventOf<E>[] } = {
  tapBear: () => [],
  parentContinue: () => [],
  settingsRetry: () => [],
  permissionChanged: () => [],
  micGranted: (s) => [{ t: 'micGranted', req: s.micReq - 1 }],
  micDenied: (s) => [{ t: 'micDenied', req: s.micReq - 1 }],
  noDevice: (s) => [{ t: 'noDevice', req: s.micReq - 1 }],
  ctxRunning: () => [],
  ctxResumeFailed: () => [],
  ctxError: () => [],
  armed: (s) => [{ t: 'armed', epoch: s.epoch - 1, armFrame: 99_000 }],
  seg: (s) => SAMPLES.seg(s).map((e) => ({ ...e, epoch: s.epoch - 1 })),
  floorSnapshot: (s) => [{ t: 'floorSnapshot', epoch: s.epoch - 1, floorDb: -44 }],
  clipReady: (s) => [
    { t: 'clipReady', epoch: s.epoch - 1, id: s.takeId },
    { t: 'clipReady', epoch: s.epoch, id: s.takeId - 1 },
  ],
  takeFailed: (s) => [
    { t: 'takeFailed', epoch: s.epoch - 1, id: s.takeId },
    { t: 'takeFailed', epoch: s.epoch, id: s.takeId - 1 },
  ],
  processed: (s) => [{ t: 'processed', id: s.takeId - 1, durationSec: 1.2 }],
  fxError: (s) => [{ t: 'fxError', id: s.takeId - 1 }],
  playbackAtSpeakerEnded: (s) => [{ t: 'playbackAtSpeakerEnded', id: (s.playingId ?? s.takeId) - 1 }],
  sfxAtSpeakerEnded: () => [],
  reaction: () => [],
  timer: () => [],
  trackMuted: () => [],
  trackUnmuted: () => [],
  trackEnded: () => [],
  inputsChanged: () => [],
  workerFailed: () => [],
  hidden: () => [],
  pagehide: () => [],
  freeze: () => [],
  visible: () => [],
  updateReady: () => [],
  settingsChanged: () => [],
  noiseFloor: () => [],
  holdStart: () => [],
  holdEnd: () => [],
};

const EVENT_TYPES: EventType[] = [
  'tapBear',
  'parentContinue',
  'settingsRetry',
  'permissionChanged',
  'micGranted',
  'micDenied',
  'noDevice',
  'ctxRunning',
  'ctxResumeFailed',
  'ctxError',
  'armed',
  'seg',
  'floorSnapshot',
  'clipReady',
  'takeFailed',
  'processed',
  'fxError',
  'playbackAtSpeakerEnded',
  'sfxAtSpeakerEnded',
  'reaction',
  'timer',
  'trackMuted',
  'trackUnmuted',
  'trackEnded',
  'inputsChanged',
  'workerFailed',
  'hidden',
  'pagehide',
  'freeze',
  'visible',
  'updateReady',
  'settingsChanged',
  'noiseFloor',
  'holdStart',
  'holdEnd',
];

/** Two variants per state: plain, and one with every flag and counter set. */
function variants(name: StateName): SessionState[] {
  return [
    stateIn(name),
    stateIn(name, {
      permission: 'prompt',
      micMuted: true,
      reselectPending: GATED.has(name),
      workerRestarts: 1,
      updateReady: true,
      sfxEndedSeq: name === 'SfxGated' || name === 'Cooldown' ? SEQ - 1 : SEQ,
      micDeniedSfx: name === 'MicDenied' || name === 'Waking',
      floorDb: undefined,
      noisyCaps: 2,
      marginBoostDb: 3,
      tooNoisy: true,
    }),
    stateIn(name, { updateReady: true, updateActivated: true }), // #277: another tab activated the update
    // #116: hold-to-talk mode at the top boost, in a noisy room.
    stateIn(name, { holdToTalk: true, tooNoisy: true, marginBoostDb: 6, noisyCaps: 3 }),
  ];
}

/** Invariants every result must satisfy (plan §3.4, §4.9.1, C1, C2, C11). */
function checkInvariants(s: SessionState, e: SessionEvent, effects: Effect[], next: SessionState) {
  const wl = effects.filter((f) => f.k === 'wakeLock');
  const heldChanged = WAKE_LOCK_HELD.has(s.name) !== WAKE_LOCK_HELD.has(next.name);
  expect(wl).toStrictEqual(heldChanged ? [wakeLock(WAKE_LOCK_HELD.has(next.name))] : []);
  const shown = effects.filter((f) => f.k === 'ui');
  expect(shown).toStrictEqual(overlayFor(s) === overlayFor(next) ? [] : [ui(overlayFor(next))]);
  for (const f of effects) {
    if (f.k === 'arm') {
      expect(next.name).toBe('Listening');
      expect(f.epoch).toBe(next.epoch);
      expect(f.marginBoostDb ?? 0).toBe(next.marginBoostDb); // #116: present only when > 0
      if (f.marginBoostDb !== undefined) expect(f.marginBoostDb).toBeGreaterThan(0);
    }
    if (f.k === 'sfx')
      expect(next.name === 'SfxGated' || (s.name === 'MicDenied' && next.name === 'MicDenied')).toBe(true);
    if (f.k === 'applyUpdate') expect(effects.at(-1)).toBe(f);
  }
  expect(effects.some((f) => f.k === 'disarm')).toBe(ARMED.has(s.name) && !ARMED.has(next.name));
  expect(effects.some((f) => f.k === 'openMic')).toBe(next.name === 'Waking' && next.micReq !== s.micReq);
  if (effects.some((f) => f.k === 'applyUpdate')) {
    if (s.name === 'Asleep' && s.updateActivated && (e.t === 'tapBear' || e.t === 'settingsRetry')) {
      // #277, row 3c: an Asleep wake after another tab's update only reloads, and keeps the state.
      expect(effects).toStrictEqual([{ k: 'applyUpdate' }]);
      expect(next).toBe(s);
    } else {
      // C11
      expect(['hidden', 'pagehide', 'freeze']).toContain(e.t);
      expect(['Asleep', 'Paused']).toContain(next.name);
    }
  }
  if (next.updateActivated) expect(next.updateReady).toBe(true);
  // #116: hold-to-talk mode ignores every seg, and its recording timer is the cap, never a worker restart.
  if (s.holdToTalk && e.t === 'seg') {
    expect(next).toBe(s);
    expect(effects).toStrictEqual([]);
  }
  if (s.holdToTalk && e.t === 'timer' && e.name === 'recording') {
    expect(effects.some((f) => f.k === 'restartWorker')).toBe(false);
  }
}

describe('cross product (state × event)', () => {
  it('TABLE lists exactly every state and every event type', () => {
    expect(EVENT_TYPES.toSorted()).toStrictEqual(Object.keys(SAMPLES).toSorted());
    expect(Object.keys(TABLE).toSorted()).toStrictEqual([...STATES].toSorted());
    for (const name of STATES)
      expect(Object.keys(TABLE[name]).toSorted()).toStrictEqual([...EVENT_TYPES].toSorted());
  });

  it('every pair: no throw on frozen input; ignore → same object and no effects; invariants hold', () => {
    let pairs = 0;
    for (const name of STATES) {
      for (const s of variants(name)) {
        for (const t of EVENT_TYPES) {
          const events: SessionEvent[] = SAMPLES[t](s);
          expect(events.length).toBeGreaterThan(0);
          for (const e of events) {
            const r = run(s, e);
            pairs++;
            if (TABLE[name][t] === 'ignore') {
              expect(r.state).toBe(s);
              expect(r.effects).toStrictEqual([]);
            }
            checkInvariants(s, e, r.effects, r.state);
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(STATES.length * EVENT_TYPES.length * 2);
  });

  it('every stale variant (epoch, id or req) returns the same state object and no effects (row 44)', () => {
    let stale = 0;
    for (const name of STATES) {
      for (const s of variants(name)) {
        for (const t of EVENT_TYPES) {
          for (const e of STALE[t](s) as SessionEvent[]) {
            expectIgnored(s, e);
            stale++;
          }
        }
      }
    }
    expect(stale).toBe(STATES.length * 4 * 17); // 17 stale events per state: seg has 5 since #116
  });

  it('reduce never mutates its input (the frozen input is unchanged)', () => {
    for (const name of STATES) {
      const s = stateIn(name);
      const copy = structuredClone(s);
      for (const t of EVENT_TYPES) for (const e of SAMPLES[t](s)) run(s, e);
      expect(s).toStrictEqual(copy);
    }
  });
});

describe('settingsChanged (M3, issue #66)', () => {
  const CUSTOM: SessionState['preset'] = { id: 'custom', pitchRatio: 0.85 };

  it('in every state, updates only the preset, with no effects', () => {
    for (const name of STATES) {
      for (const s of variants(name)) {
        for (const preset of [PRESETS.chipmunk, PRESETS.bigbear, CUSTOM]) {
          const r = run(s, { t: 'settingsChanged', preset });
          expect(r.effects).toStrictEqual([]);
          expect(r.state).toStrictEqual({ ...s, preset });
          expect(r.state.preset).toBe(preset);
        }
      }
    }
  });

  it('a preset equal to the current one (even as another object) returns the same state object', () => {
    for (const name of STATES) {
      const s = stateIn(name, { preset: { id: 'custom', pitchRatio: 1.85 } });
      expectIgnored(s, { t: 'settingsChanged', preset: { id: 'custom', pitchRatio: 1.85 } });
      expectIgnored(stateIn(name), { t: 'settingsChanged', preset: PRESETS.cub });
    }
  });

  it('a different custom pitch is a change', () => {
    const s = stateIn('Listening', { preset: { id: 'custom', pitchRatio: 1.85 } });
    expect(run(s, { t: 'settingsChanged', preset: CUSTOM }).state.preset).toBe(CUSTOM);
  });

  it('the next take is processed with the new preset', () => {
    const s = run(stateIn('Processing'), { t: 'settingsChanged', preset: PRESETS.chipmunk }).state;
    const r = run(s, { t: 'clipReady', epoch: EPOCH, id: TAKE });
    expect(r.effects).toStrictEqual([{ k: 'process', id: TAKE, preset: PRESETS.chipmunk }]);
  });
});

describe('initial state and config', () => {
  it('initialSessionState is Asleep with zero counters, the cub preset and 48 kHz', () => {
    expect(initialSessionState('prompt')).toStrictEqual({
      name: 'Asleep',
      permission: 'prompt',
      epoch: 0,
      armFrame: null,
      onsetFrame: null,
      floorDb: undefined,
      takeId: 0,
      playingId: null,
      micReq: 0,
      micGranted: false,
      ctxRunning: false,
      sampleRate: 48_000,
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
    });
  });

  it('DEFAULT_CONFIG matches issue #28', () => {
    expect(DEFAULT_CONFIG).toStrictEqual({
      tSleepMs: 120_000,
      tDozeMs: 45_000,
      cooldownMs: 250,
      wakingMs: 5_000,
      processingMs: 2_000,
      maxUtteranceMs: 10_000,
      preRollMs: 300,
      tailMs: 150,
    });
  });

  it('groups match plan §3.4', () => {
    expect([...MIC_OPEN]).toStrictEqual([
      'Waking',
      'Listening',
      'Recording',
      'Processing',
      'Playing',
      'SfxGated',
      'Cooldown',
    ]);
    expect([...AWAKE]).toStrictEqual([...MIC_OPEN, 'MicDenied']);
    expect([...ARMED]).toStrictEqual(['Listening', 'Recording']);
    expect([...GATED]).toStrictEqual(['Processing', 'Playing', 'SfxGated', 'Cooldown']);
    expect([...WAKE_LOCK_HELD]).toStrictEqual([...MIC_OPEN, 'NeedsParent']);
  });
});
