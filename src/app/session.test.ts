// Session store + effect interpreter (issue #34). Node: a fake engine built on the real createMicManager with a
// controllable fake getUserMedia, fake player / sfx / wake lock / visibility / permission, and FakeClock. The
// `visible`-ordering tests also use the real createVisibility and createMicPermission over fake DOM objects.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../test/fake-clock.ts';
import type { Engine, EngineEvent } from '../audio/engine.ts';
import { CONSTRAINTS, createMicManager, type MicManager } from '../audio/mic.ts';
import type { SfxId } from '../audio/sfx-ids.ts';
import { emptyEnvelope, PRESETS } from '../dsp/types.ts';
import {
  createMicPermission,
  type MicPermissionState,
  type PermissionStatusLike,
} from '../platform/permissions.ts';
import { createVisibility, type VisEvent, type Visibility } from '../platform/visibility.ts';
import { createEffectRunner, NOISY_ROOM_CONSTRAINTS } from './effects.ts';
import {
  DEFAULT_CONFIG,
  type AnimEvent,
  type Effect,
  type Overlay,
  type Permission,
  type SessionConfig,
  type SessionEvent,
  type SessionState,
  type StateName,
} from './events.ts';
import { initialSessionState, MIC_OPEN } from './machine.ts';
import {
  createSession,
  type LevelEvent,
  type Player,
  type Session,
  type SessionDeps,
  type Sfx,
} from './session.ts';
import { DEFAULT_SETTINGS, type Settings } from './settings.ts';

// ---- helpers -----------------------------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`no element ${i}`);
  return x;
}

/** Lets every pending promise continuation and 0 ms task run (FakeClock timers don't move). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Runs queued microtasks only: no task (timer, I/O) can run in between. */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function spyError() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- fakes -------------------------------------------------------------------------------------------------

class FakeTrack extends EventTarget {
  muted = false;
  readyState: 'live' | 'ended' = 'live';
  stopCalls = 0;
  stop(): void {
    this.stopCalls++;
    this.readyState = 'ended';
  }
}

/** The mic manager and engine only call getTracks() / getAudioTracks() on a stream. */
function isStreamLike(v: object): v is MediaStream {
  return 'getTracks' in v && 'getAudioTracks' in v;
}
/** The runner only calls createBuffer() on the context. */
function isAudioContext(v: object): v is AudioContext {
  return 'createBuffer' in v;
}
/** The runner only passes the bus on to the factories. */
function isAudioNode(v: object): v is AudioNode {
  return 'connect' in v;
}

interface GumCall {
  /** The constraints this getUserMedia call was made with. */
  constraints: MediaStreamConstraints;
  /** Resolves this getUserMedia call with a stream of `n` new live tracks, and returns them. */
  resolve(n?: number): FakeTrack[];
  reject(err: unknown): void;
}

function fakeGum(): {
  gum: (c: MediaStreamConstraints) => Promise<MediaStream>;
  calls: GumCall[];
  tracks: FakeTrack[];
  live: () => FakeTrack[];
} {
  const calls: GumCall[] = [];
  const tracks: FakeTrack[] = [];
  const gum = (constraints: MediaStreamConstraints): Promise<MediaStream> =>
    new Promise<MediaStream>((resolve, reject) => {
      calls.push({
        constraints,
        resolve(n = 2) {
          const ts = Array.from({ length: n }, () => new FakeTrack());
          tracks.push(...ts);
          const shape = { getTracks: () => [...ts], getAudioTracks: () => [...ts] };
          if (!isStreamLike(shape)) throw new Error('unreachable: the fake stream has both methods');
          resolve(shape);
          return ts;
        },
        reject,
      });
    });
  return { gum, calls, tracks, live: () => tracks.filter((t) => t.readyState === 'live') };
}

class FakeBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly data: Float32Array;
  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = new Float32Array(length);
  }
  getChannelData(channel: number): Float32Array {
    if (channel !== 0) throw new RangeError('the fake buffer is mono');
    return this.data;
  }
}

class FakeCtx {
  readonly created: FakeBuffer[] = [];
  failCreate = false;
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    if (this.failCreate) throw new DOMException('fake createBuffer failure', 'NotSupportedError');
    const b = new FakeBuffer(channels, length, sampleRate);
    this.created.push(b);
    return b;
  }
}

type Processed = NonNullable<ReturnType<Engine['getProcessed']>>;

interface FakeEngine {
  engine: Engine;
  gum: ReturnType<typeof fakeGum>;
  ctx: FakeCtx & AudioContext;
  bus: AudioNode;
  /** Routes engine events to this session (as main.ts's relay does). */
  connect(s: Session): void;
  emit(e: EngineEvent): void;
  /** Stores a processed result, as the worker's reply would. */
  finishProcess(id: number, pcm: Float32Array, sampleRate: number): void;
  /** false: context() and masterBus() return null (no graph yet). */
  setOutput(on: boolean): void;
  hooks: { onTake: ((epoch: number, id: number) => void) | null; armThrows: number };
  presets: unknown[];
}

/** An Engine on the real mic manager; every call is recorded in `timeline`. */
function fakeEngine(timeline: string[]): FakeEngine {
  const gum = fakeGum();
  const mic: MicManager = createMicManager(gum.gum);
  let session: Session | null = null;
  const emit = (e: EngineEvent): void => {
    session?.onEngineEvent(e);
  };
  let processed: { id: number; result: Processed } | null = null;
  let output = true;
  const ctx = new FakeCtx();
  if (!isAudioContext(ctx)) throw new Error('unreachable: the fake context has createBuffer');
  const bus = { connect: (): void => undefined };
  if (!isAudioNode(bus)) throw new Error('unreachable: the fake bus has connect');
  const hooks: FakeEngine['hooks'] = { onTake: null, armThrows: 0 };
  const presets: unknown[] = [];

  // As T21's engine: a stale result is dropped (its tracks were stopped by the mic manager).
  function onMicResult(r: Awaited<ReturnType<MicManager['open']>>): void {
    switch (r.t) {
      case 'stale':
        return;
      case 'micGranted':
        if (mic.current() !== r.stream) return;
        emit({ t: 'micGranted', req: r.req });
        emit(r.stream.getAudioTracks().some((t) => t.muted) ? { t: 'trackMuted' } : { t: 'trackUnmuted' });
        return;
      default:
        emit(r);
    }
  }
  mic.onTrackEvent((e) => {
    emit(e === 'mute' ? { t: 'trackMuted' } : e === 'unmute' ? { t: 'trackUnmuted' } : { t: 'trackEnded' });
  });

  const engine: Engine = {
    resume() {
      timeline.push('resume');
      return Promise.resolve();
    },
    suspend() {
      timeline.push('suspend');
      return Promise.resolve();
    },
    openMic(req, extra) {
      timeline.push(extra === undefined ? `openMic ${req}` : `openMic ${req} ${JSON.stringify(extra)}`);
      void mic.open(req, extra).then(onMicResult);
    },
    closeMic() {
      timeline.push('closeMic');
      mic.close();
      processed = null;
    },
    arm(epoch, restoreFloorDb, marginBoostDb) {
      const boost = marginBoostDb === undefined ? '' : ` +${marginBoostDb}`;
      timeline.push(
        `${restoreFloorDb === undefined ? `arm ${epoch}` : `arm ${epoch} ${restoreFloorDb}`}${boost}`,
      );
      if (hooks.armThrows > 0) {
        hooks.armThrows--;
        throw new Error('fake arm failure');
      }
    },
    disarm(epoch) {
      timeline.push(`disarm ${epoch}`);
    },
    take(epoch, id, fromFrame, toFrame) {
      timeline.push(`take ${epoch} ${id} ${fromFrame} ${toFrame}`);
      hooks.onTake?.(epoch, id);
    },
    process(id, preset) {
      timeline.push(`process ${id} ${preset.id}`);
      presets.push(preset);
    },
    getProcessed(id) {
      return processed !== null && processed.id === id ? processed.result : undefined;
    },
    releaseProcessed(id) {
      timeline.push(`release ${id}`);
      if (processed !== null && processed.id === id) processed = null;
    },
    getClip: () => undefined,
    restartWorker() {
      timeline.push('restartWorker');
    },
    reselectInput() {
      timeline.push('reselectInput');
    },
    context: () => (output ? ctx : null),
    masterBus: () => (output ? bus : null),
  };

  return {
    engine,
    gum,
    ctx,
    bus,
    connect(s) {
      session = s;
    },
    emit,
    finishProcess(id, pcm, sampleRate) {
      processed = {
        id,
        result: { pcm, sampleRate, envelope: emptyEnvelope(), durationSec: pcm.length / sampleRate },
      };
    },
    setOutput(on) {
      output = on;
    },
    hooks,
    presets,
  };
}

interface FakePlay {
  buffer: AudioBuffer;
  rate: number;
  done: Deferred<'ended' | 'stopped'>;
}

function fakePlayer(): { player: Player; plays: FakePlay[]; stops: () => number } {
  const plays: FakePlay[] = [];
  let current: FakePlay | null = null;
  let stops = 0;
  const player: Player = {
    play(buffer, playbackRate) {
      current?.done.resolve('stopped'); // like the real player: a new clip stops the current one
      const p: FakePlay = { buffer, rate: playbackRate, done: deferred() };
      plays.push(p);
      current = p;
      return { startCtxTime: 0, durationSec: 0, done: p.done.promise };
    },
    stop() {
      stops++;
      current?.done.resolve('stopped');
      current = null;
    },
  };
  return { player, plays, stops: () => stops };
}

function fakeSfx(): { sfx: Sfx; plays: SfxId[]; waits: Deferred<void>[]; stopAlls: () => number } {
  const plays: SfxId[] = [];
  const waits: Deferred<void>[] = [];
  const pending = new Set<Deferred<void>>();
  let stopAlls = 0;
  const sfx: Sfx = {
    play(id) {
      plays.push(id);
      return { endCtxTime: 0 };
    },
    stopAll() {
      stopAlls++;
      for (const w of pending) w.reject('stopped');
      pending.clear();
    },
    allEnded() {
      const d = deferred<void>();
      const w: Deferred<void> = {
        promise: d.promise,
        resolve: (v) => {
          pending.delete(w);
          d.resolve(v);
        },
        reject: (err) => {
          pending.delete(w);
          d.reject(err);
        },
      };
      waits.push(w);
      pending.add(w);
      return d.promise;
    },
  };
  return { sfx, plays, waits, stopAlls: () => stopAlls };
}

function fakeVisibility(): { vis: Visibility; emit(e: VisEvent): void } {
  const subs = new Set<(e: VisEvent) => void>();
  let state: 'visible' | 'hidden' = 'visible';
  const emit = (e: VisEvent): void => {
    if (e === 'visible' || e === 'hidden') state = e;
    for (const cb of Array.from(subs)) cb(e);
  };
  const vis: Visibility = {
    current: () => state,
    subscribe(cb) {
      const entry = (e: VisEvent): void => cb(e);
      subs.add(entry);
      return () => {
        subs.delete(entry);
      };
    },
    simulate: emit,
  };
  return { vis, emit };
}

function fakePermission(initial: Permission): {
  permission: SessionDeps['permission'];
  change(v: MicPermissionState): void;
  failQueries(err: Error): void;
} {
  let value: MicPermissionState = initial;
  let failure: Error | null = null;
  const subs = new Set<(s: MicPermissionState) => void>();
  return {
    permission: {
      query: () => (failure === null ? Promise.resolve(value) : Promise.reject(failure)),
      subscribe(cb) {
        const entry = (s: MicPermissionState): void => cb(s);
        subs.add(entry);
        return () => {
          subs.delete(entry);
        };
      },
    },
    change(v) {
      value = v;
      for (const cb of Array.from(subs)) cb(v);
    },
    failQueries(err) {
      failure = err;
    },
  };
}

// ---- the session harness -----------------------------------------------------------------------------------

interface Transition {
  from: StateName;
  to: StateName;
  e: SessionEvent;
}

interface Harness {
  session: Session;
  eng: FakeEngine;
  player: ReturnType<typeof fakePlayer>;
  sfx: ReturnType<typeof fakeSfx>;
  vis: ReturnType<typeof fakeVisibility>;
  perm: ReturnType<typeof fakePermission>;
  clock: FakeClock;
  /** Engine calls, anim effects and onTransition calls, in order. */
  timeline: string[];
  transitions: Transition[];
  wake: boolean[];
  anims: AnimEvent[];
  ui: Overlay[];
  applyUpdates: () => number;
  makePlayerCalls: [AudioContext, AudioNode][];
  makeSfxCalls: [AudioContext, AudioNode][];
  /** Validation 1's invariant, checked after every dispatch: no track is live outside the mic-open states. */
  violations: string[];
}

function setup(
  opts: {
    permission?: Permission;
    visibility?: Visibility;
    permissionDep?: SessionDeps['permission'];
    cfg?: SessionConfig;
    settings?: () => Settings;
  } = {},
): Harness {
  const timeline: string[] = [];
  const clock = new FakeClock();
  const eng = fakeEngine(timeline);
  const player = fakePlayer();
  const sfx = fakeSfx();
  const vis = fakeVisibility();
  const perm = fakePermission(opts.permission ?? 'granted');
  const transitions: Transition[] = [];
  const wake: boolean[] = [];
  const anims: AnimEvent[] = [];
  const ui: Overlay[] = [];
  let applyUpdates = 0;
  const makePlayerCalls: [AudioContext, AudioNode][] = [];
  const makeSfxCalls: [AudioContext, AudioNode][] = [];
  const violations: string[] = [];
  const deps: SessionDeps = {
    engine: eng.engine,
    makePlayer(ctx, bus) {
      makePlayerCalls.push([ctx, bus]);
      return player.player;
    },
    makeSfx(ctx, bus) {
      makeSfxCalls.push([ctx, bus]);
      return sfx.sfx;
    },
    wakeLock: {
      set(on) {
        wake.push(on);
      },
    },
    visibility: opts.visibility ?? vis.vis,
    permission: opts.permissionDep ?? perm.permission,
    clock,
    cfg: opts.cfg,
    settings: opts.settings,
    onAnim(ev) {
      anims.push(ev);
      timeline.push(`anim ${ev.e}`);
    },
    onUi(o) {
      ui.push(o);
    },
    onApplyUpdate() {
      applyUpdates++;
      timeline.push('applyUpdate');
    },
    onTransition(from, to, e) {
      transitions.push({ from, to, e });
      timeline.push(`onTransition ${from}>${to} ${e.t}`);
    },
  };
  const session = createSession(initialSessionState(opts.permission ?? 'granted'), deps);
  eng.connect(session);
  session.subscribe((s) => {
    const live = eng.gum.live().length;
    if (!MIC_OPEN.has(s.name) && live > 0) violations.push(`${s.name}: ${live} live track(s)`);
  });
  return {
    session,
    eng,
    player,
    sfx,
    vis,
    perm,
    clock,
    timeline,
    transitions,
    wake,
    anims,
    ui,
    applyUpdates: () => applyUpdates,
    makePlayerCalls,
    makeSfxCalls,
    violations,
  };
}

const stateOf = (h: Harness): StateName => h.session.state().name;
const eventsOf = (ts: readonly Transition[]): SessionEvent['t'][] => ts.map((t) => t.e.t);
const fmt = (t: Transition): string =>
  `${t.from}>${t.to} ${t.e.t}${t.e.t === 'permissionChanged' ? `=${t.e.state}` : ''}`;

/** tapBear (granted) → Waking; the gum resolves; ctxRunning → Listening. */
async function toListening(h: Harness): Promise<void> {
  h.session.dispatch({ t: 'tapBear' });
  expect(stateOf(h)).toBe('Waking');
  at(h.eng.gum.calls, h.eng.gum.calls.length - 1).resolve(1);
  await flush();
  h.eng.emit({ t: 'ctxRunning', sampleRate: 48_000 });
  expect(stateOf(h)).toBe('Listening');
}

const ramp = (n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => i / n);

/** From Listening: armed, seg start, seg end, clipReady, processed (with a stored result) → Playing. */
function toPlaying(h: Harness, withResult = true, clipped = false): { id: number; pcm: Float32Array } {
  const epoch = h.session.state().epoch;
  h.eng.emit({ t: 'armed', epoch, armFrame: 1000 });
  h.eng.emit({ t: 'seg', epoch, ev: { kind: 'start', frame: 48_000 } });
  expect(stateOf(h)).toBe('Recording');
  h.eng.emit({
    t: 'seg',
    epoch,
    ev: { kind: 'end', frame: 110_000, lastSpeechFrame: 96_000, reason: 'silence' },
  });
  expect(stateOf(h)).toBe('Processing');
  const id = h.session.state().takeId;
  h.eng.emit({ t: 'clipReady', epoch, id });
  const pcm = ramp(4800);
  if (withResult) h.eng.finishProcess(id, pcm, 48_000);
  h.eng.emit({ t: 'processed', id, durationSec: 0.0625, clipped });
  return { id, pcm };
}

// ---- Validation 1 (plan §7 M1 effect-runner test) -------------------------------------------------------------

describe('Validation 1: getUserMedia resolving after the mic was released', () => {
  it('after hidden (Paused): every returned track is stopped at once, and none is live outside mic-open', async () => {
    const h = setup();
    h.session.dispatch({ t: 'tapBear' });
    expect(stateOf(h)).toBe('Waking');
    expect(h.timeline).toContain('openMic 1');
    h.vis.emit('hidden');
    expect(stateOf(h)).toBe('Paused');
    expect(h.timeline).toContain('closeMic');
    expect(h.timeline).toContain('suspend');
    const tracks = at(h.eng.gum.calls, 0).resolve(2);
    await microtasks(); // before any task could run
    for (const t of tracks) {
      expect(t.stopCalls).toBe(1);
      expect(t.readyState).toBe('ended');
    }
    await flush();
    expect(eventsOf(h.transitions)).not.toContain('micGranted');
    expect(stateOf(h)).toBe('Paused');
    expect(h.eng.gum.live()).toEqual([]);
    expect(h.violations).toEqual([]);
  });

  it('after timer waking (Error): every returned track is stopped at once, and none is live outside mic-open', async () => {
    const h = setup();
    h.session.dispatch({ t: 'tapBear' });
    expect(stateOf(h)).toBe('Waking');
    h.clock.advance(DEFAULT_CONFIG.wakingMs);
    expect(stateOf(h)).toBe('Error');
    expect(h.timeline).toContain('closeMic');
    const tracks = at(h.eng.gum.calls, 0).resolve(2);
    await microtasks();
    for (const t of tracks) {
      expect(t.stopCalls).toBe(1);
      expect(t.readyState).toBe('ended');
    }
    await flush();
    expect(eventsOf(h.transitions)).not.toContain('micGranted');
    expect(stateOf(h)).toBe('Error');
    expect(h.eng.gum.live()).toEqual([]);
    expect(h.violations).toEqual([]);
  });
});

// ---- Validation 2: the full loop ---------------------------------------------------------------------------

describe('Validation 2: the full loop with fakes', () => {
  it('Listening → Recording → Processing → Playing → Cooldown → Listening with epoch 2; release when playback settles', async () => {
    const h = setup();
    await toListening(h);
    expect(h.session.state().epoch).toBe(1);
    expect(h.timeline).toContain('arm 1');
    expect(h.wake).toEqual([true]);

    const { id, pcm } = toPlaying(h);
    expect(id).toBe(1);
    expect(h.timeline).toContain('process 1 cub');
    expect(stateOf(h)).toBe('Playing');

    // The AudioBuffer: mono, the processed sample rate, the processed samples.
    const buffer = at(h.eng.ctx.created, 0);
    expect([buffer.numberOfChannels, buffer.length, buffer.sampleRate]).toEqual([1, 4800, 48_000]);
    expect(buffer.data).toEqual(pcm);
    // The player is created once, from the engine's context and master bus, and plays at rate 1: the voice
    // chain already pitched the clip (M3, issue #66).
    expect(h.makePlayerCalls).toHaveLength(1);
    expect(at(h.makePlayerCalls, 0)[0]).toBe(h.eng.ctx);
    expect(at(h.makePlayerCalls, 0)[1]).toBe(h.eng.bus);
    const play = at(h.player.plays, 0);
    expect(play.buffer).toBe(buffer);
    expect(play.rate).toBe(1);
    // While Playing (after the anim talk effect too), the processed result is still there.
    expect(h.anims).toContainEqual({ e: 'talk', id: 1 });
    expect(h.eng.engine.getProcessed(1)).toBeDefined();
    expect(h.timeline).not.toContain('release 1');

    play.done.resolve('ended');
    await flush();
    expect(h.timeline).toContain('release 1');
    expect(h.eng.engine.getProcessed(1)).toBeUndefined();
    expect(stateOf(h)).toBe('Cooldown');
    expect(h.transitions.at(-1)?.e).toEqual({ t: 'playbackAtSpeakerEnded', id: 1 });

    h.clock.advance(249);
    expect(stateOf(h)).toBe('Cooldown');
    h.clock.advance(1);
    expect(stateOf(h)).toBe('Listening');
    expect(h.session.state().epoch).toBe(2);
    expect(h.timeline).toContain('arm 2');
    expect(h.violations).toEqual([]);
  });

  it("done resolving 'stopped' dispatches nothing, and releases the processed result", async () => {
    const h = setup();
    await toListening(h);
    toPlaying(h);
    expect(stateOf(h)).toBe('Playing');
    at(h.player.plays, 0).done.resolve('stopped');
    await flush();
    expect(stateOf(h)).toBe('Playing');
    expect(eventsOf(h.transitions)).not.toContain('playbackAtSpeakerEnded');
    expect(h.timeline).toContain('release 1');
    expect(h.eng.engine.getProcessed(1)).toBeUndefined();
  });

  it('a play with no processed result ends the replay at once (Playing has no timer)', async () => {
    const h = setup();
    await toListening(h);
    const errors = spyError();
    toPlaying(h, false);
    expect(eventsOf(h.transitions).slice(-2)).toEqual(['processed', 'playbackAtSpeakerEnded']);
    expect(h.transitions.at(-2)?.to).toBe('Playing');
    expect(stateOf(h)).toBe('Cooldown');
    expect(h.player.plays).toEqual([]);
    const release = h.timeline.indexOf('release 1');
    expect(release).toBeGreaterThan(-1);
    expect(release).toBeLessThan(h.timeline.indexOf('onTransition Playing>Cooldown playbackAtSpeakerEnded'));
    expect(errors).not.toHaveBeenCalled();
  });

  it('a play that throws while building the buffer is logged, releases, and ends the replay', async () => {
    const h = setup();
    await toListening(h);
    const errors = spyError();
    h.eng.ctx.failCreate = true;
    toPlaying(h);
    expect(errors).toHaveBeenCalledWith('effects: play failed', expect.any(DOMException));
    expect(h.timeline).toContain('release 1');
    expect(h.eng.engine.getProcessed(1)).toBeUndefined();
    expect(stateOf(h)).toBe('Cooldown');
    expect(h.player.plays).toEqual([]);
  });
});

// ---- #117: a clipped take ------------------------------------------------------------------------------------

describe('#117: a clipped take', () => {
  it('after the replay, anim talkEnd then tooLoud (P2), no sfx and no ui; the cooldown is the unclipped 250 ms; the next unclipped take plays none', async () => {
    const h = setup();
    await toListening(h);
    toPlaying(h, true, true);
    expect(stateOf(h)).toBe('Playing');
    const n = h.anims.length;
    at(h.player.plays, 0).done.resolve('ended');
    await flush();
    expect(stateOf(h)).toBe('Cooldown');
    expect(h.anims.slice(n)).toEqual([{ e: 'talkEnd' }, { e: 'reaction', name: 'tooLoud', priority: 2 }]);
    expect(h.sfx.plays).toEqual([]);
    h.clock.advance(249);
    expect(stateOf(h)).toBe('Cooldown');
    h.clock.advance(1);
    expect(stateOf(h)).toBe('Listening');
    expect(h.session.state().epoch).toBe(2);

    // The next take is not clipped: lastClipped resets on its processed, so its replay ends without tooLoud.
    toPlaying(h);
    expect(stateOf(h)).toBe('Playing');
    const m = h.anims.length;
    at(h.player.plays, 1).done.resolve('ended');
    await flush();
    expect(stateOf(h)).toBe('Cooldown');
    expect(h.anims.slice(m)).toEqual([{ e: 'talkEnd' }]);
    expect(h.sfx.plays).toEqual([]);
    expect(h.violations).toEqual([]);
  });
});

// ---- Validation 3: Q1 sleep --------------------------------------------------------------------------------

describe('Validation 3: Q1 sleep', () => {
  it('from Listening, clock.advance(120_000) → Asleep: closeMic, suspend, wake lock set(false)', async () => {
    const h = setup();
    await toListening(h);
    h.timeline.length = 0;
    h.clock.advance(120_000);
    expect(stateOf(h)).toBe('Asleep');
    expect(h.anims.filter((a) => a.e === 'doze')).toHaveLength(2); // 45 s and 90 s
    expect(h.timeline).toContain('closeMic');
    expect(h.timeline).toContain('suspend');
    expect(h.wake.at(-1)).toBe(false);
    expect(h.eng.gum.live()).toEqual([]);
    expect(h.clock.pending()).toBe(0);
    expect(h.violations).toEqual([]);
  });
});

// ---- settings (#113): the sleep timeout and the noisy-room toggle -------------------------------------------

/** A mutable settings source, as main.ts passes the store's `get`. */
function settingsSource(patch: Partial<Settings> = {}): {
  get: () => Settings;
  set(p: Partial<Settings>): void;
} {
  let current: Settings = { ...DEFAULT_SETTINGS, ...patch };
  return {
    get: () => current,
    set(p) {
      current = { ...current, ...p };
    },
  };
}

describe('settings (#113)', () => {
  it('the sleep timeout from the settings is used on the next Listening entry', async () => {
    const st = settingsSource({ sleepTimeoutSec: 60 });
    const h = setup({ settings: st.get });
    await toListening(h);
    h.clock.advance(59_999);
    expect(stateOf(h)).toBe('Listening');
    h.clock.advance(1);
    expect(stateOf(h)).toBe('Asleep');
    // Changed while asleep: the next Listening entry starts the sleep timer with it.
    st.set({ sleepTimeoutSec: 300 });
    await toListening(h);
    h.clock.advance(299_999);
    expect(stateOf(h)).toBe('Listening');
    h.clock.advance(1);
    expect(stateOf(h)).toBe('Asleep');
    expect(h.violations).toEqual([]);
  });

  it('a change while Listening leaves the running sleep timer alone; the next timer start uses it', async () => {
    const st = settingsSource({ sleepTimeoutSec: 120 });
    const h = setup({ settings: st.get });
    await toListening(h);
    st.set({ sleepTimeoutSec: 60 });
    h.clock.advance(60_000);
    expect(stateOf(h)).toBe('Listening'); // started at 120 s
    // A reaction in Listening restarts the sleep timer (row 15): now with 60 s.
    h.session.dispatch({ t: 'reaction', name: 'poke', priority: 2, sfx: null });
    h.clock.advance(59_999);
    expect(stateOf(h)).toBe('Listening');
    h.clock.advance(1);
    expect(stateOf(h)).toBe('Asleep');
  });

  it('only tSleepMs comes from the settings: the other cfg timings are kept', async () => {
    const cfg: SessionConfig = { ...DEFAULT_CONFIG, tSleepMs: 999_000, tDozeMs: 25_000 };
    const h = setup({ cfg, settings: settingsSource({ sleepTimeoutSec: 60 }).get });
    await toListening(h);
    h.clock.advance(60_000);
    expect(stateOf(h)).toBe('Asleep');
    expect(h.anims.filter((a) => a.e === 'doze')).toHaveLength(2); // 25 s and 50 s
  });

  it('noisy room adds noiseSuppression: true to the next openMic, and only to it', async () => {
    const st = settingsSource();
    const h = setup({ settings: st.get });
    await toListening(h);
    expect(h.timeline).toContain('openMic 1');
    expect(at(h.eng.gum.calls, 0).constraints).toStrictEqual({ audio: { ...CONSTRAINTS } });
    // Turned on while the mic is open: nothing re-opens it.
    st.set({ noisyRoomNs: true });
    expect(h.eng.gum.calls).toHaveLength(1);
    // The next mic open (hide → visible → Waking) carries it.
    h.vis.emit('hidden');
    expect(stateOf(h)).toBe('Paused');
    h.vis.emit('visible');
    await flush();
    expect(stateOf(h)).toBe('Waking');
    expect(h.timeline).toContain('openMic 2 {"noiseSuppression":true}');
    expect(at(h.eng.gum.calls, 1).constraints).toStrictEqual({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false },
    });
    // Off again: the plan §4.1.1 constraints only.
    st.set({ noisyRoomNs: false });
    h.vis.emit('hidden');
    h.vis.emit('visible');
    await flush();
    expect(h.timeline).toContain('openMic 3');
    expect(at(h.eng.gum.calls, 2).constraints).toStrictEqual({ audio: { ...CONSTRAINTS } });
    expect(h.violations).toEqual([]);
  });

  it('the runner reads noisyRoomNs at each openMic; off (or without settings) openMic gets the req only', () => {
    const st = settingsSource();
    const r = runnerHarness(st.get);
    const openMic = vi.spyOn(r.eng.engine, 'openMic');
    r.run({ k: 'openMic', req: 7 });
    st.set({ noisyRoomNs: true });
    r.run({ k: 'openMic', req: 8 });
    expect(openMic.mock.calls).toStrictEqual([[7], [8, { noiseSuppression: true }]]);
    expect(at(at(openMic.mock.calls, 1), 1)).toBe(NOISY_ROOM_CONSTRAINTS);
    expect(Object.isFrozen(NOISY_ROOM_CONSTRAINTS)).toBe(true);
    const plain = runnerHarness();
    const plainOpen = vi.spyOn(plain.eng.engine, 'openMic');
    plain.run({ k: 'openMic', req: 9 });
    expect(plainOpen.mock.calls).toStrictEqual([[9]]);
  });
});

// ---- Validation 4: timers ----------------------------------------------------------------------------------

function runnerHarness(settings?: () => Settings): {
  run: (fx: Effect) => void;
  dispatched: SessionEvent[];
  clock: FakeClock;
  eng: FakeEngine;
  timeline: string[];
  player: ReturnType<typeof fakePlayer>;
  sfx: ReturnType<typeof fakeSfx>;
  makePlayerCalls: () => number;
  makeSfxCalls: () => number;
  wake: boolean[];
  anims: AnimEvent[];
  ui: Overlay[];
  applyUpdates: () => number;
} {
  const timeline: string[] = [];
  const eng = fakeEngine(timeline);
  const clock = new FakeClock();
  const dispatched: SessionEvent[] = [];
  const player = fakePlayer();
  const sfx = fakeSfx();
  let makePlayerCalls = 0;
  let makeSfxCalls = 0;
  const wake: boolean[] = [];
  const anims: AnimEvent[] = [];
  const ui: Overlay[] = [];
  let applyUpdates = 0;
  const state = initialSessionState('granted');
  const runner = createEffectRunner(
    {
      engine: eng.engine,
      makePlayer: () => {
        makePlayerCalls++;
        return player.player;
      },
      makeSfx: () => {
        makeSfxCalls++;
        return sfx.sfx;
      },
      wakeLock: {
        set(on) {
          wake.push(on);
        },
      },
      clock,
      onAnim: (ev) => anims.push(ev),
      onUi: (o) => ui.push(o),
      onApplyUpdate: () => {
        applyUpdates++;
      },
      settings,
    },
    { dispatch: (e) => dispatched.push(e), state: (): SessionState => state },
  );
  return {
    run: (fx) => runner.run(fx),
    dispatched,
    clock,
    eng,
    timeline,
    player,
    sfx,
    makePlayerCalls: () => makePlayerCalls,
    makeSfxCalls: () => makeSfxCalls,
    wake,
    anims,
    ui,
    applyUpdates: () => applyUpdates,
  };
}

describe('Validation 4: named timers', () => {
  it('replacing a named timer cancels the old one, and a fired timer does not fire again', () => {
    const r = runnerHarness();
    r.run({ k: 'timer', name: 'sleep', ms: 1000 });
    r.run({ k: 'timer', name: 'sleep', ms: 3000 });
    expect(r.clock.pending()).toBe(1);
    r.clock.advance(1000);
    expect(r.dispatched).toEqual([]);
    r.clock.advance(2000);
    expect(r.dispatched).toEqual([{ t: 'timer', name: 'sleep' }]);
    expect(r.clock.pending()).toBe(0);
    r.run({ k: 'cancelTimer', name: 'sleep' }); // already fired: a no-op
    r.clock.advance(10_000);
    expect(r.dispatched).toHaveLength(1);
  });

  it("cancelTimer{name} clears that timer only, and cancelTimer '*' clears all", () => {
    const r = runnerHarness();
    r.run({ k: 'timer', name: 'doze', ms: 100 });
    r.run({ k: 'timer', name: 'cooldown', ms: 100 });
    r.run({ k: 'timer', name: 'waking', ms: 100 });
    r.run({ k: 'cancelTimer', name: 'cooldown' });
    expect(r.clock.pending()).toBe(2);
    r.clock.advance(100);
    expect(r.dispatched).toEqual([
      { t: 'timer', name: 'doze' },
      { t: 'timer', name: 'waking' },
    ]);
    r.dispatched.length = 0;
    r.run({ k: 'timer', name: 'doze', ms: 100 });
    r.run({ k: 'timer', name: 'cooldown', ms: 200 });
    r.run({ k: 'timer', name: 'processing', ms: 300 });
    r.run({ k: 'cancelTimer', name: '*' });
    expect(r.clock.pending()).toBe(0);
    r.clock.advance(10_000);
    expect(r.dispatched).toEqual([]);
  });

  it('through the session: a reaction in Listening restarts the sleep timer (the old one never fires)', async () => {
    const h = setup();
    await toListening(h);
    h.clock.advance(100_000);
    expect(stateOf(h)).toBe('Listening');
    h.session.dispatch({ t: 'reaction', name: 'poke', priority: 2, sfx: null }); // row 15
    h.clock.advance(20_000); // t = 120 s: the original sleep timer's due time
    expect(stateOf(h)).toBe('Listening');
    h.clock.advance(99_999);
    expect(stateOf(h)).toBe('Listening');
    h.clock.advance(1); // t = 220 s
    expect(stateOf(h)).toBe('Asleep');
  });
});

describe('play effect (runner)', () => {
  it('the AudioBuffer is mono at the processed sample rate, not the context rate', () => {
    const r = runnerHarness();
    r.eng.finishProcess(9, ramp(100), 24_000);
    r.run({ k: 'play', id: 9 });
    const b = at(r.eng.ctx.created, 0);
    expect([b.numberOfChannels, b.length, b.sampleRate]).toEqual([1, 100, 24_000]);
    expect(b.data).toEqual(ramp(100));
  });

  it('the player is created once across replays', () => {
    const r = runnerHarness();
    r.eng.finishProcess(1, ramp(10), 48_000);
    r.run({ k: 'play', id: 1 });
    r.eng.finishProcess(2, ramp(10), 48_000);
    r.run({ k: 'play', id: 2 });
    expect(r.player.plays).toHaveLength(2);
    expect(r.makePlayerCalls()).toBe(1);
  });

  it('a rejected done is logged, releases the result and ends the replay', async () => {
    const r = runnerHarness();
    const errors = spyError();
    r.eng.finishProcess(1, ramp(10), 48_000);
    r.run({ k: 'play', id: 1 });
    expect(r.timeline).not.toContain('release 1');
    at(r.player.plays, 0).done.reject(new Error('player failed'));
    await flush();
    expect(errors).toHaveBeenCalledWith('effects: playback failed', expect.any(Error));
    expect(r.timeline).toContain('release 1');
    expect(r.eng.engine.getProcessed(1)).toBeUndefined();
    expect(r.dispatched).toEqual([{ t: 'playbackAtSpeakerEnded', id: 1 }]);
  });
});

/** From Listening: armed, seg start, seg end → Processing for take 1. */
function toProcessing(h: Harness): number {
  h.eng.emit({ t: 'armed', epoch: 1, armFrame: 1000 });
  h.eng.emit({ t: 'seg', epoch: 1, ev: { kind: 'start', frame: 48_000 } });
  h.eng.emit({
    t: 'seg',
    epoch: 1,
    ev: { kind: 'end', frame: 110_000, lastSpeechFrame: 96_000, reason: 'silence' },
  });
  expect(stateOf(h)).toBe('Processing');
  return h.session.state().takeId;
}

describe('a processed result the reducer does not replay is released at once', () => {
  it('a late reply after the processing watchdog (Cooldown): released, never played', async () => {
    const h = setup();
    await toListening(h);
    const id = toProcessing(h);
    h.eng.emit({ t: 'clipReady', epoch: 1, id });
    h.clock.advance(DEFAULT_CONFIG.processingMs);
    expect(stateOf(h)).toBe('Cooldown');
    h.eng.finishProcess(id, ramp(4800), 48_000);
    h.eng.emit({ t: 'processed', id, durationSec: 0.1, clipped: false });
    expect(stateOf(h)).toBe('Cooldown');
    expect(h.player.plays).toEqual([]);
    expect(h.timeline).toContain(`release ${id}`);
    expect(h.eng.engine.getProcessed(id)).toBeUndefined();
  });

  it('a stale id while Processing another take: released, and the current take is left alone', async () => {
    const h = setup();
    await toListening(h);
    const id = toProcessing(h);
    h.eng.finishProcess(id + 100, ramp(10), 48_000);
    h.eng.emit({ t: 'processed', id: id + 100, durationSec: 0.1, clipped: false });
    expect(stateOf(h)).toBe('Processing');
    expect(h.timeline).toContain(`release ${id + 100}`);
    expect(h.eng.engine.getProcessed(id + 100)).toBeUndefined();
    expect(h.timeline).not.toContain(`release ${id}`);
  });
});

// ---- Validation 5: sfx ---------------------------------------------------------------------------------------

describe('Validation 5: sfx end tracking', () => {
  for (const order of ['older first', 'newer first'] as const) {
    it(`two sfx effects before allEnded resolves → exactly one sfxAtSpeakerEnded{seq: 2} (${order})`, async () => {
      const h = setup();
      await toListening(h);
      h.session.dispatch({ t: 'reaction', name: 'poke', priority: 2, sfx: 'testBeep' }); // row 14
      expect(stateOf(h)).toBe('SfxGated');
      h.session.dispatch({ t: 'reaction', name: 'poke', priority: 2, sfx: 'testBeep' }); // row 32
      expect(h.session.state().sfxSeq).toBe(2);
      expect(h.sfx.plays).toEqual(['testBeep', 'testBeep']);
      expect(h.sfx.waits).toHaveLength(2);
      expect(h.makeSfxCalls).toHaveLength(1);
      const [older, newer] = [at(h.sfx.waits, 0), at(h.sfx.waits, 1)];
      for (const w of order === 'older first' ? [older, newer] : [newer, older]) {
        w.resolve();
        await flush();
      }
      const ended = h.transitions.filter((t) => t.e.t === 'sfxAtSpeakerEnded');
      expect(ended.map((t) => t.e)).toEqual([{ t: 'sfxAtSpeakerEnded', seq: 2 }]);
      expect(stateOf(h)).toBe('Cooldown');
    });
  }

  it('a wait overtaken by a newer sfx reports nothing; the newest reports the highest seq', async () => {
    const r = runnerHarness();
    r.run({ k: 'sfx', id: 'testBeep', seq: 1 });
    r.run({ k: 'sfx', id: 'testBeep', seq: 2 });
    at(r.sfx.waits, 0).resolve();
    await flush();
    expect(r.dispatched).toEqual([]);
    at(r.sfx.waits, 1).resolve();
    await flush();
    expect(r.dispatched).toEqual([{ t: 'sfxAtSpeakerEnded', seq: 2 }]);
  });

  it('after stopPlayback: the rejection is ignored, a late pre-stop resolution reports nothing, the next sfx reports its seq', async () => {
    const r = runnerHarness();
    const errors = spyError();
    r.run({ k: 'sfx', id: 'testBeep', seq: 1 });
    r.run({ k: 'stopPlayback' });
    expect(r.sfx.stopAlls()).toBe(1);
    await flush();
    expect(r.dispatched).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    r.run({ k: 'sfx', id: 'testBeep', seq: 2 });
    at(r.sfx.waits, 1).resolve();
    await flush();
    expect(r.dispatched).toEqual([{ t: 'sfxAtSpeakerEnded', seq: 2 }]);

    // A wait that resolved just before a stopPlayback and a newer sfx, delivered after them.
    r.run({ k: 'sfx', id: 'testBeep', seq: 3 });
    at(r.sfx.waits, 2).resolve();
    r.run({ k: 'stopPlayback' });
    r.run({ k: 'sfx', id: 'testBeep', seq: 4 });
    await flush();
    expect(r.dispatched).toEqual([{ t: 'sfxAtSpeakerEnded', seq: 2 }]);
    at(r.sfx.waits, 3).resolve();
    await flush();
    expect(r.dispatched).toEqual([
      { t: 'sfxAtSpeakerEnded', seq: 2 },
      { t: 'sfxAtSpeakerEnded', seq: 4 },
    ]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('with no output yet, an sfx reports at once through the same monotonic guard', () => {
    const r = runnerHarness();
    r.eng.setOutput(false);
    r.run({ k: 'sfx', id: 'testBeep', seq: 1 });
    expect(r.dispatched).toEqual([{ t: 'sfxAtSpeakerEnded', seq: 1 }]);
    expect(r.makeSfxCalls()).toBe(0);
    r.run({ k: 'sfx', id: 'testBeep', seq: 1 });
    expect(r.dispatched).toHaveLength(1);
  });

  it("a current wait rejecting with something other than 'stopped' is logged and reported", async () => {
    const r = runnerHarness();
    const errors = spyError();
    r.run({ k: 'sfx', id: 'testBeep', seq: 1 });
    at(r.sfx.waits, 0).reject(new Error('poll failed'));
    await flush();
    expect(errors).toHaveBeenCalledWith('effects: sfx wait failed', expect.any(Error));
    expect(r.dispatched).toEqual([{ t: 'sfxAtSpeakerEnded', seq: 1 }]);
  });

  it('stopPlayback before any play or sfx creates neither the player nor the sfx scheduler', () => {
    const h = setup();
    h.session.dispatch({ t: 'tapBear' });
    h.vis.emit('hidden'); // Paused entry: stopPlayback
    expect(stateOf(h)).toBe('Paused');
    expect(h.makePlayerCalls).toEqual([]);
    expect(h.makeSfxCalls).toEqual([]);
  });
});

// ---- Validation 6: re-entrancy and the order of a step ------------------------------------------------------

describe('Validation 6: re-entrancy', () => {
  it('an event dispatched from inside an effect is processed after the current effects and listeners', async () => {
    const h = setup();
    await toListening(h);
    h.session.addTransitionListener((from, to, e) => h.timeline.push(`listener ${from}>${to} ${e.t}`));
    h.session.subscribe((s) => h.timeline.push(`subscriber ${s.name}`));
    // As T21's engine does for a take it can't serve: takeFailed, synchronously, from inside take().
    h.eng.hooks.onTake = (epoch, id) => {
      h.timeline.push(`state ${h.session.state().name}`);
      h.eng.emit({ t: 'takeFailed', epoch, id });
    };
    h.eng.emit({ t: 'armed', epoch: 1, armFrame: 1000 });
    h.eng.emit({ t: 'seg', epoch: 1, ev: { kind: 'start', frame: 48_000 } });
    expect(stateOf(h)).toBe('Recording');
    h.timeline.length = 0;
    h.eng.emit({
      t: 'seg',
      epoch: 1,
      ev: { kind: 'end', frame: 110_000, lastSpeechFrame: 96_000, reason: 'silence' },
    });
    const fromFrame = 48_000 - Math.round((DEFAULT_CONFIG.preRollMs * 48_000) / 1000);
    const toFrame = 96_000 + Math.round((DEFAULT_CONFIG.tailMs * 48_000) / 1000);
    expect(h.timeline).toEqual([
      `take 1 1 ${fromFrame} ${toFrame}`,
      'state Processing', // the new state is stored before the effects run
      'anim thinking',
      'disarm 1',
      'onTransition Recording>Processing seg',
      'listener Recording>Processing seg',
      'subscriber Processing',
      'anim confused',
      'onTransition Processing>Cooldown takeFailed',
      'listener Processing>Cooldown takeFailed',
      'subscriber Cooldown',
    ]);
    expect(stateOf(h)).toBe('Cooldown');
  });
});

// ---- effect mapping, errors and wiring -----------------------------------------------------------------------

describe('effect mapping', () => {
  it('each engine effect calls the matching engine method with its exact arguments', () => {
    const r = runnerHarness();
    const cases: [Effect, string][] = [
      [{ k: 'openMic', req: 7 }, 'openMic 7'],
      [{ k: 'closeMic' }, 'closeMic'],
      [{ k: 'resumeCtx' }, 'resume'],
      [{ k: 'suspendCtx' }, 'suspend'],
      [{ k: 'restartWorker' }, 'restartWorker'],
      [{ k: 'arm', epoch: 3, restoreFloorDb: -50 }, 'arm 3 -50'],
      [{ k: 'arm', epoch: 4 }, 'arm 4'],
      [{ k: 'arm', epoch: 5, restoreFloorDb: -50, marginBoostDb: 3 }, 'arm 5 -50 +3'], // #116
      [{ k: 'disarm', epoch: 4 }, 'disarm 4'],
      [{ k: 'take', epoch: 1, id: 2, fromFrame: 100, toFrame: 200 }, 'take 1 2 100 200'],
      [{ k: 'process', id: 5, preset: PRESETS.chipmunk }, 'process 5 chipmunk'],
      [{ k: 'reselectInput' }, 'reselectInput'],
    ];
    for (const [fx, call] of cases) {
      r.timeline.length = 0;
      r.run(fx);
      expect(r.timeline, fx.k).toEqual([call]);
    }
    expect(r.eng.presets).toEqual([PRESETS.chipmunk]);
    expect(at(r.eng.presets, 0)).toBe(PRESETS.chipmunk);
    expect(r.dispatched).toEqual([]);
  });

  it('wakeLock, anim, ui and applyUpdate reach their callbacks', () => {
    const r = runnerHarness();
    r.run({ k: 'wakeLock', on: true });
    r.run({ k: 'wakeLock', on: false });
    r.run({ k: 'anim', ev: { e: 'idle' } });
    r.run({ k: 'ui', show: 'micHelp' });
    r.run({ k: 'ui', show: null });
    r.run({ k: 'applyUpdate' });
    expect(r.wake).toEqual([true, false]);
    expect(r.anims).toEqual([{ e: 'idle' }]);
    expect(r.ui).toEqual(['micHelp', null]);
    expect(r.applyUpdates()).toBe(1);
  });

  it("through the session: ui → onUi (tapBear with 'prompt' → parentPermission)", () => {
    const h = setup({ permission: 'prompt' });
    h.session.dispatch({ t: 'tapBear' });
    expect(stateOf(h)).toBe('NeedsParent');
    expect(h.ui).toEqual(['parentPermission']);
    expect(h.timeline.filter((l) => l.startsWith('openMic'))).toEqual([]);
  });

  it('through the session: applyUpdate → onApplyUpdate, after the mic is closed (updateReady, then hidden)', async () => {
    const h = setup();
    await toListening(h);
    h.session.dispatch({ t: 'updateReady' });
    expect(h.applyUpdates()).toBe(0);
    h.vis.emit('hidden');
    expect(stateOf(h)).toBe('Paused');
    expect(h.applyUpdates()).toBe(1);
    expect(h.timeline.indexOf('closeMic')).toBeLessThan(h.timeline.indexOf('applyUpdate'));
  });

  it('through the session: stopPlayback reaches player.stop() and sfx.stopAll()', async () => {
    const h = setup();
    await toListening(h);
    toPlaying(h);
    expect(stateOf(h)).toBe('Playing');
    h.session.dispatch({ t: 'reaction', name: 'poke2', priority: 3, sfx: 'testBeep' }); // row 29
    expect(stateOf(h)).toBe('SfxGated');
    expect(h.player.stops()).toBe(1);
    expect(h.sfx.plays).toEqual(['testBeep']);
    h.vis.emit('hidden');
    expect(stateOf(h)).toBe('Paused');
    expect(h.player.stops()).toBe(2);
    expect(h.sfx.stopAlls()).toBe(1);
    await flush();
    expect(h.timeline).toContain('release 1'); // the replay was stopped: its result is gone
    expect(eventsOf(h.transitions)).not.toContain('sfxAtSpeakerEnded');
  });
});

describe('errors', () => {
  it('an effect that throws is logged; the remaining effects and later events still run', async () => {
    const h = setup();
    const errors = spyError();
    h.eng.hooks.armThrows = 1;
    await toListening(h);
    expect(errors).toHaveBeenCalledWith('effects: arm failed', expect.any(Error));
    const arm = h.timeline.indexOf('arm 1');
    expect(h.timeline.indexOf('anim idle')).toBeGreaterThan(arm); // the entry effects after arm still ran
    expect(h.clock.pending()).toBe(2); // sleep and doze
    h.session.dispatch({ t: 'reaction', name: 'poke', priority: 2, sfx: null });
    expect(h.transitions.at(-1)?.e.t).toBe('reaction');
  });

  it('a throwing transition listener or subscriber is logged and does not stall the queue', () => {
    const h = setup();
    const errors = spyError();
    const seen: string[] = [];
    h.session.addTransitionListener(() => {
      throw new Error('listener');
    });
    h.session.addTransitionListener((_f, to) => seen.push(`listener ${to}`));
    h.session.subscribe(() => {
      throw new Error('subscriber');
    });
    h.session.subscribe((s) => seen.push(`subscriber ${s.name}`));
    h.session.dispatch({ t: 'tapBear' });
    h.clock.advance(DEFAULT_CONFIG.wakingMs);
    expect(stateOf(h)).toBe('Error');
    expect(seen).toEqual(['listener Waking', 'subscriber Waking', 'listener Error', 'subscriber Error']);
    expect(errors).toHaveBeenCalledWith('session: transition listener failed', expect.any(Error));
    expect(errors).toHaveBeenCalledWith('session: subscriber failed', expect.any(Error));
  });
});

describe('wiring', () => {
  it('engine level, vadError, vadReady, vadStats and traceBatch go only to subscribeLevel listeners; other engine events are dispatched', async () => {
    const h = setup();
    await toListening(h);
    const errors = spyError();
    const got: LevelEvent[] = [];
    h.session.subscribeLevel((e) => got.push(e));
    const count = h.transitions.length;
    const level: LevelEvent = { t: 'level', epoch: 1, frame: 480, db: -40, floorDb: -60 };
    const vadError: LevelEvent = { t: 'vadError', message: 'x' };
    const ready: LevelEvent = { t: 'vadReady', backend: 'silero' };
    const stats: LevelEvent = { t: 'vadStats', p95Ms: 4.5 };
    const trace: LevelEvent = {
      t: 'traceBatch',
      epoch: 1,
      hop0Frame: 480,
      sil0Frame: Number.NaN,
      rawDb: new Float32Array(25),
      bandDb: new Float32Array(25),
      voicing: new Float32Array(25),
      sileroP: new Float32Array(0),
      inferMs: new Float32Array(0),
    };
    h.eng.emit(level);
    h.eng.emit(vadError);
    h.eng.emit(ready);
    h.eng.emit(stats);
    h.eng.emit(trace);
    expect(got).toEqual([level, vadError, ready, stats, trace]);
    expect(h.transitions).toHaveLength(count);
    expect(errors).not.toHaveBeenCalled();
    h.eng.emit({ t: 'armed', epoch: 1, armFrame: 1234 });
    expect(h.transitions.at(-1)?.e).toEqual({ t: 'armed', epoch: 1, armFrame: 1234 });
    expect(h.session.state().armFrame).toBe(1234);
  });

  it('#116: Listening levels become one noiseFloor per second, and a loud floor shows the too-noisy badge', async () => {
    const h = setup();
    await toListening(h);
    const epoch = h.session.state().epoch;
    const count = h.transitions.length;
    for (let i = 0; i < 40; i++) {
      if (i > 0) h.clock.advance(30); // 1.17 s of levels, ≈ 33 per second
      h.eng.emit({ t: 'level', epoch, frame: 480 * i, db: -24 - (i % 3), floorDb: -70 });
    }
    expect(h.transitions.slice(count).map((t) => t.e)).toEqual([{ t: 'noiseFloor', floorDb: -26 }]);
    expect(h.session.state().tooNoisy).toBe(true);
    expect(h.ui.at(-1)).toBe('tooNoisy');
  });

  it('visibility hidden, pagehide and freeze are dispatched; resume is ignored', async () => {
    for (const e of ['hidden', 'pagehide', 'freeze'] as const) {
      const h = setup();
      await toListening(h);
      h.vis.emit(e);
      expect(h.transitions.at(-1)?.e).toEqual({ t: e });
      expect(stateOf(h)).toBe('Paused');
    }
    const h = setup();
    await toListening(h);
    const count = h.transitions.length;
    h.vis.emit('resume');
    await flush();
    expect(h.transitions).toHaveLength(count);
  });

  it('permission changes are dispatched as permissionChanged (MicDenied → Waking on granted)', () => {
    const h = setup({ permission: 'denied' });
    h.session.dispatch({ t: 'tapBear' });
    expect(stateOf(h)).toBe('MicDenied');
    h.perm.change('granted');
    expect(h.transitions.at(-1)?.e).toEqual({ t: 'permissionChanged', state: 'granted' });
    expect(stateOf(h)).toBe('Waking');
    expect(h.timeline).toContain('openMic 1');
  });

  it('the unsubscribe functions stop delivery', async () => {
    const h = setup();
    const seen: string[] = [];
    const offT = h.session.addTransitionListener(() => seen.push('t'));
    const offS = h.session.subscribe(() => seen.push('s'));
    const offL = h.session.subscribeLevel(() => seen.push('l'));
    h.session.dispatch({ t: 'updateReady' });
    h.eng.emit({ t: 'vadError', message: 'x' });
    expect(seen).toEqual(['t', 's', 'l']);
    offT();
    offS();
    offL();
    h.session.dispatch({ t: 'updateReady' });
    h.eng.emit({ t: 'vadError', message: 'x' });
    await flush();
    expect(seen).toEqual(['t', 's', 'l']);
  });
});

// ---- visible after the permission re-query (T17 F7) -----------------------------------------------------------

class FakeDoc extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

class FakeStatus extends EventTarget {
  state: MicPermissionState;
  constructor(state: MicPermissionState) {
    super();
    this.state = state;
  }
}

/** `navigator.permissions` whose queries stay pending until the test answers them. */
function fakeNav(): {
  nav: { permissions: { query(desc: { name: 'microphone' }): Promise<PermissionStatusLike> } };
  queries: Deferred<PermissionStatusLike>[];
  answer(i: number, state: MicPermissionState): FakeStatus;
} {
  const queries: Deferred<PermissionStatusLike>[] = [];
  return {
    nav: {
      permissions: {
        query: () => {
          const d = deferred<PermissionStatusLike>();
          queries.push(d);
          return d.promise;
        },
      },
    },
    queries,
    answer(i, state) {
      const s = new FakeStatus(state);
      at(queries, i).resolve(s);
      return s;
    },
  };
}

/**
 * The real visibility and permission modules. 'normal': built like main.ts (the permission first, then
 * `p0 = await permission.query()`, then the session). 'reversed': the session subscribes to visibility first,
 * through a proxy that forwards to a real createMicPermission built after createSession.
 */
async function realSetup(order: 'normal' | 'reversed'): Promise<
  Harness & {
    realVis: Visibility;
    nav: ReturnType<typeof fakeNav>;
    boot: FakeStatus;
    sessionQueries: () => number;
  }
> {
  const realVis = createVisibility(new FakeDoc(), new EventTarget());
  const nav = fakeNav();
  let real: ReturnType<typeof createMicPermission> | null = null;
  const pendingSubs: ((s: MicPermissionState) => void)[] = [];
  let sessionQueries = 0;
  const proxy: SessionDeps['permission'] = {
    query: () => {
      sessionQueries++;
      if (real === null) throw new Error('queried before the permission exists');
      return real.query();
    },
    subscribe: (cb) => {
      if (real !== null) return real.subscribe(cb);
      pendingSubs.push(cb);
      return () => undefined;
    },
  };
  const bootPermission = async (): Promise<FakeStatus> => {
    const p = createMicPermission(nav.nav, realVis);
    real = p;
    const q = p.query();
    const boot = nav.answer(nav.queries.length - 1, 'granted');
    expect(await q).toBe('granted');
    for (const cb of pendingSubs) p.subscribe(cb);
    return boot;
  };
  let boot: FakeStatus;
  let h: Harness;
  if (order === 'normal') {
    boot = await bootPermission();
    h = setup({ visibility: realVis, permissionDep: proxy });
  } else {
    h = setup({ visibility: realVis, permissionDep: proxy });
    boot = await bootPermission();
  }
  expect(nav.queries).toHaveLength(1);
  return { ...h, realVis, nav, boot, sessionQueries: () => sessionQueries };
}

describe('visible is dispatched after the permission re-query', () => {
  for (const order of ['normal', 'reversed'] as const) {
    for (const first of ['module', 'session'] as const) {
      it(`${order} subscription order, ${first} query answered first: permissionChanged{prompt} before visible → NeedsParent, no openMic`, async () => {
        const h = await realSetup(order);
        await toListening(h);
        h.realVis.simulate('hidden');
        expect(stateOf(h)).toBe('Paused');
        const mark = h.transitions.length;
        h.realVis.simulate('visible');
        await Promise.resolve();
        // The module's own re-query (in its visibility subscriber) and the session's (one microtask later).
        expect(h.nav.queries).toHaveLength(3);
        expect(h.sessionQueries()).toBe(1);
        expect(h.transitions).toHaveLength(mark);
        const [moduleQ, sessionQ] = [1, 2];
        for (const i of first === 'module' ? [moduleQ, sessionQ] : [sessionQ, moduleQ]) {
          h.nav.answer(i, 'prompt');
          await flush();
        }
        expect(h.transitions.slice(mark).map(fmt)).toEqual([
          'Paused>Paused permissionChanged=prompt',
          'Paused>NeedsParent visible',
        ]);
        expect(h.timeline.filter((l) => l.startsWith('openMic'))).toEqual(['openMic 1']);
        expect(h.eng.gum.calls).toHaveLength(1);
        expect(h.violations).toEqual([]);
      });
    }
  }

  it('an unchanged permission: no permissionChanged, and visible wakes the bear (openMic 2)', async () => {
    const h = await realSetup('normal');
    await toListening(h);
    h.realVis.simulate('hidden');
    const mark = h.transitions.length;
    h.realVis.simulate('visible');
    await Promise.resolve();
    h.nav.answer(1, 'granted');
    h.nav.answer(2, 'granted');
    await flush();
    expect(h.transitions.slice(mark).map(fmt)).toEqual(['Paused>Waking visible']);
    expect(h.timeline).toContain('openMic 2');
  });

  it('a change event while the query is pending wins over the stale query result', async () => {
    const h = await realSetup('normal');
    await toListening(h);
    h.realVis.simulate('hidden');
    const mark = h.transitions.length;
    h.realVis.simulate('visible');
    await Promise.resolve();
    h.boot.state = 'denied';
    h.boot.dispatchEvent(new Event('change'));
    expect(h.transitions.slice(mark).map(fmt)).toEqual(['Paused>Paused permissionChanged=denied']);
    h.nav.answer(1, 'granted');
    h.nav.answer(2, 'granted');
    await flush();
    expect(h.transitions.slice(mark).map(fmt)).toEqual([
      'Paused>Paused permissionChanged=denied',
      'Paused>MicDenied visible',
    ]);
    expect(h.timeline.filter((l) => l.startsWith('openMic'))).toEqual(['openMic 1']);
  });

  it('a hide before the query settles drops that visible; the next visible wakes once', async () => {
    const h = await realSetup('normal');
    await toListening(h);
    h.realVis.simulate('hidden');
    const mark = h.transitions.length;
    h.realVis.simulate('visible');
    h.realVis.simulate('hidden');
    await Promise.resolve();
    expect(h.nav.queries).toHaveLength(2); // only the module's: the session skipped its query
    expect(h.sessionQueries()).toBe(0);
    h.nav.answer(1, 'granted');
    await flush();
    expect(h.transitions.slice(mark).map(fmt)).toEqual(['Paused>Paused hidden']);
    h.realVis.simulate('visible');
    await Promise.resolve();
    h.nav.answer(2, 'granted');
    h.nav.answer(3, 'granted');
    await flush();
    expect(h.transitions.slice(mark).map(fmt)).toEqual(['Paused>Paused hidden', 'Paused>Waking visible']);
    expect(h.timeline.filter((l) => l.startsWith('openMic'))).toEqual(['openMic 1', 'openMic 2']);
  });

  it('a rejected query is logged and still dispatches visible (the last known permission wakes the bear)', async () => {
    const h = setup();
    await toListening(h);
    h.vis.emit('hidden');
    expect(stateOf(h)).toBe('Paused');
    const errors = spyError();
    h.perm.failQueries(new Error('query failed'));
    h.vis.emit('visible');
    await flush();
    expect(errors).toHaveBeenCalledWith('session: permission query failed', expect.any(Error));
    expect(stateOf(h)).toBe('Waking');
    expect(h.timeline).toContain('openMic 2');
  });
});
