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
  });

  it('row 20: Recording + seg.end → Processing with the clamped take', () => {
    const s = stateIn('Recording'); // armFrame 96 000, onsetFrame 144 000, 48 kHz
    const end = (reason: 'silence' | 'maxLength') =>
      seg(EPOCH, { kind: 'end', frame: 220_000, lastSpeechFrame: 190_000, reason });
    const fx = [
      cancel('recording'),
      { k: 'take', epoch: EPOCH, id: TAKE + 1, fromFrame: 144_000 - 14_400, toFrame: 190_000 + 7_200 },
      anim('thinking'),
      disarm(EPOCH),
      PROCESSING_T,
    ] satisfies Effect[];
    expectStep(s, end('silence'), 'Processing', fx, { takeId: TAKE + 1 });
    expectStep(s, end('maxLength'), 'Processing', fx, { takeId: TAKE + 1, capHits: 1 });
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
      { reselectPending: false, micReq: REQ + 1, micGranted: false },
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
        { micReq: REQ + 1, micGranted: false }, // ctxRunning stays true (C6)
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
    const into = (from: StateName, row: Effect[], extra: Partial<SessionState> = {}) =>
      expectStep(
        stateIn(from),
        { t: 'workerFailed' },
        'Cooldown',
        [...EXIT[from], ...row, ...(ARMED.has(from) ? [disarm(EPOCH)] : []), COOLDOWN_T],
        { workerRestarts: 1, ...extra },
      );
    into('Listening', [RESTART, anim('confused')]);
    into('Recording', [RESTART, anim('confused')]);
    into('Processing', [RESTART, anim('confused')]);
    into('Playing', [STOP, RESTART, anim('confused')], { playingId: null, sfxEndedSeq: SEQ });
    into('SfxGated', [RESTART, anim('confused')]);
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
