// The effect runner's `onPlayStarted` report (issue #81): a `play{id}` effect that starts a replay reports the
// player's scheduled start, synchronously, before the transition's next effect (`anim talk{id}`). The noise floor
// estimate (#116): engine `level`s become at most one `noiseFloor` per second while Listening. Node, with minimal
// fakes; the rest of the runner is covered through the session in session.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../test/fake-clock.ts';
import type { Engine } from '../audio/engine.ts';
import type { PlayHandle } from '../audio/player.ts';
import { emptyEnvelope } from '../dsp/types.ts';
import { createEffectRunner, NOISE_FLOOR_WINDOW_MS, type EffectDeps, type EffectRunner } from './effects.ts';
import type { SessionEvent, SessionState } from './events.ts';
import { initialSessionState } from './machine.ts';
import type { Player, Sfx } from './session.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The runner only calls createBuffer() on the context. */
function isAudioContext(v: object): v is AudioContext {
  return 'createBuffer' in v;
}
/** The runner only passes the bus on to the factories. */
function isAudioNode(v: object): v is AudioNode {
  return 'connect' in v;
}
/** The runner only fills channel 0 of the buffer and hands it to the player. */
function isAudioBuffer(v: object): v is AudioBuffer {
  return 'getChannelData' in v;
}

const noop = (): void => {};

/** A context whose createBuffer() returns a one-channel buffer stand-in. */
function fakeContext(): AudioContext {
  const ctx = {
    createBuffer(_channels: number, length: number): AudioBuffer {
      const data = new Float32Array(length);
      const buffer = { getChannelData: () => data };
      if (!isAudioBuffer(buffer)) throw new Error('unreachable');
      return buffer;
    },
  };
  if (!isAudioContext(ctx)) throw new Error('unreachable');
  return ctx;
}

function fakeBus(): AudioNode {
  const bus = { connect: noop };
  if (!isAudioNode(bus)) throw new Error('unreachable');
  return bus;
}

/** The runner only calls context(), masterBus(), getProcessed() and releaseProcessed() on the engine. */
function isEngine(v: object): v is Engine {
  return 'getProcessed' in v && 'releaseProcessed' in v && 'context' in v && 'masterBus' in v;
}

/**
 * An engine whose output exists and which holds the processed result of replay `id` (null: none). Only the
 * methods the runner's play path calls are built, so a new `Engine` method doesn't break this file.
 */
function fakeEngine(id: number | null): { engine: Engine; released: number[] } {
  const ctx = fakeContext();
  const bus = fakeBus();
  const released: number[] = [];
  const result = {
    pcm: new Float32Array(480),
    sampleRate: 48_000,
    envelope: emptyEnvelope(),
    durationSec: 0.01,
  };
  const engine = {
    getProcessed: (want: number) => (id !== null && want === id ? result : undefined),
    releaseProcessed: (rid: number) => {
      released.push(rid);
    },
    context: () => ctx,
    masterBus: () => bus,
  };
  if (!isEngine(engine)) throw new Error('unreachable');
  return { engine, released };
}

/** A player whose play() returns a handle starting at `startCtxTime` that never settles. */
function fakePlayer(startCtxTime: number): Player & { plays: number } {
  const p = {
    plays: 0,
    play(): PlayHandle {
      p.plays++;
      return { startCtxTime, durationSec: 1, done: new Promise<'ended' | 'stopped'>(noop) };
    },
    stop: noop,
  };
  return p;
}

function fakeSfx(): Sfx {
  return { play: () => ({ endCtxTime: 0 }), stopAll: noop, allEnded: () => Promise.resolve() };
}

function deps(engine: Engine, player: Player, extra: Partial<EffectDeps>): EffectDeps {
  return {
    engine,
    makePlayer: () => player,
    makeSfx: fakeSfx,
    wakeLock: { set: noop },
    clock: new FakeClock(),
    ...extra,
  };
}

describe('onPlayStarted (#81)', () => {
  it('reports the replay id and the player handle startCtxTime, before the next effect runs', () => {
    const calls: string[] = [];
    const { engine, released } = fakeEngine(7);
    const player = fakePlayer(12.345);
    const dispatched: SessionEvent[] = [];
    const runner = createEffectRunner(
      deps(engine, player, {
        onPlayStarted: (id, start) => calls.push(`started ${id} @ ${start}`),
        onAnim: (ev) => calls.push(`anim ${ev.e}`),
      }),
      { dispatch: (e) => dispatched.push(e), state: () => initialSessionState('granted') },
    );
    runner.run({ k: 'play', id: 7 });
    expect(calls).toEqual(['started 7 @ 12.345']);
    runner.run({ k: 'anim', ev: { e: 'talk', id: 7 } });
    expect(calls).toEqual(['started 7 @ 12.345', 'anim talk']);
    expect(player.plays).toBe(1);
    // The replay is still playing: nothing ended it, nothing released it.
    expect(dispatched).toEqual([]);
    expect(released).toEqual([]);
  });

  it('is not called when nothing is played (no processed result): the replay ends at once', () => {
    const onPlayStarted = vi.fn<(id: number, start: number) => void>();
    const { engine } = fakeEngine(null);
    const player = fakePlayer(1);
    const dispatched: SessionEvent[] = [];
    const runner = createEffectRunner(deps(engine, player, { onPlayStarted }), {
      dispatch: (e) => dispatched.push(e),
      state: () => initialSessionState('granted'),
    });
    runner.run({ k: 'play', id: 3 });
    expect(onPlayStarted).not.toHaveBeenCalled();
    expect(player.plays).toBe(0);
    expect(dispatched).toEqual([{ t: 'playbackAtSpeakerEnded', id: 3 }]);
  });

  it('a throwing listener is logged and the replay plays on', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(noop);
    const { engine, released } = fakeEngine(5);
    const player = fakePlayer(2);
    const dispatched: SessionEvent[] = [];
    const runner = createEffectRunner(
      deps(engine, player, {
        onPlayStarted: () => {
          throw new Error('boom');
        },
      }),
      { dispatch: (e) => dispatched.push(e), state: () => initialSessionState('granted') },
    );
    runner.run({ k: 'play', id: 5 });
    expect(player.plays).toBe(1);
    expect(error).toHaveBeenCalledWith('effects: onPlayStarted failed', expect.any(Error));
    expect(dispatched).toEqual([]);
    expect(released).toEqual([]);
  });

  it('is optional: a play without it still starts the replay', () => {
    const { engine } = fakeEngine(9);
    const player = fakePlayer(3);
    const runner = createEffectRunner(deps(engine, player, {}), {
      dispatch: noop,
      state: () => initialSessionState('granted'),
    });
    runner.run({ k: 'play', id: 9 });
    expect(player.plays).toBe(1);
  });
});

describe('noise floor estimate (#116)', () => {
  /** A runner whose session sits in `state` (mutable through the returned object), with a FakeClock. */
  function harness(initial: Partial<SessionState> = {}): {
    runner: EffectRunner;
    clock: FakeClock;
    floors: number[];
    times: number[];
    set(p: Partial<SessionState>): void;
  } {
    const clock = new FakeClock();
    const floors: number[] = [];
    const times: number[] = [];
    let state: SessionState = { ...initialSessionState('granted'), name: 'Listening', epoch: 4, ...initial };
    const { engine } = fakeEngine(null);
    const runner = createEffectRunner(deps(engine, fakePlayer(0), { clock }), {
      dispatch: (e) => {
        if (e.t !== 'noiseFloor') throw new Error(`unexpected ${e.t}`);
        floors.push(e.floorDb);
        times.push(clock.now());
      },
      state: () => state,
    });
    return {
      runner,
      clock,
      floors,
      times,
      set: (p) => {
        state = { ...state, ...p };
      },
    };
  }

  /** Feeds `n` levels 30 ms apart (the worker's ≈ 33 Hz), the clock advancing before each but the first. */
  function feedLevels(h: ReturnType<typeof harness>, n: number, db: (i: number) => number, floorDb = -60, epoch = 4) {
    for (let i = 0; i < n; i++) {
      if (i > 0) h.clock.advance(30);
      h.runner.level({ epoch, db: db(i), floorDb });
    }
  }

  it('dispatches nothing before a window spans 1 s, then max(window minimum, gate floor) once', () => {
    expect(NOISE_FLOOR_WINDOW_MS).toBe(1000);
    const h = harness();
    feedLevels(h, 34, (i) => -24 - (i % 4), -60); // 33 · 30 ms = 990 ms: still open
    expect(h.floors).toEqual([]);
    h.clock.advance(10);
    h.runner.level({ epoch: 4, db: -25, floorDb: -60 }); // 1000 ms after the window opened
    expect(h.floors).toEqual([-27]);
    // A gate floor above the window minimum wins.
    feedLevels(h, 35, () => -30, -28);
    expect(h.floors).toEqual([-27, -28]);
  });

  it('a NaN gate floor (not initialised yet) leaves the window minimum', () => {
    const h = harness();
    feedLevels(h, 35, (i) => -40 + i / 10, Number.NaN);
    expect(h.floors).toEqual([-40]);
  });

  it('digital silence counts as −100 dBFS: a silent input after noise clears the flag', () => {
    const h = harness();
    feedLevels(h, 35, () => -24);
    expect(h.floors).toEqual([-24]);
    h.clock.advance(30);
    feedLevels(h, 41, () => -120, -60); // 1.2 s of digital silence
    expect(h.floors).toHaveLength(2);
    expect(h.floors[1]).toBeLessThanOrEqual(-35);
    expect(h.floors[1]).toBe(-60); // the gate floor, above the silence level
    h.clock.advance(30);
    feedLevels(h, 35, () => Number.NaN, Number.NaN);
    expect(h.floors[2]).toBe(-100);
  });

  it('only Listening levels of the current epoch count; leaving Listening or a new epoch restarts the window', () => {
    const h = harness();
    feedLevels(h, 20, () => -24); // 570 ms
    h.set({ name: 'Recording' });
    feedLevels(h, 40, () => -24); // never counted, and the window closes
    h.set({ name: 'Listening' });
    feedLevels(h, 20, () => -24); // a fresh window: 570 ms only
    expect(h.floors).toEqual([]);
    feedLevels(h, 40, () => -24, -60, 3); // a stale epoch closes it again
    expect(h.floors).toEqual([]);
    h.set({ epoch: 5 });
    feedLevels(h, 20, () => -24, -60, 4); // the old epoch's levels: ignored
    feedLevels(h, 20, () => -24, -60, 5); // 570 ms of the new epoch
    expect(h.floors).toEqual([]);
    h.clock.advance(30);
    feedLevels(h, 15, () => -24, -60, 5); // now 1.02 s
    expect(h.floors).toEqual([-24]);
  });

  it('at most one noiseFloor per second over a steady stream', () => {
    const h = harness();
    feedLevels(h, 167, () => -24); // 4.98 s of levels
    expect(h.floors.length).toBe(4);
    for (let i = 1; i < h.times.length; i++) {
      expect(h.times[i]! - h.times[i - 1]!).toBeGreaterThanOrEqual(NOISE_FLOOR_WINDOW_MS);
    }
  });

  it('the arm effect passes marginBoostDb to engine.arm', () => {
    const calls: unknown[][] = [];
    const { engine } = fakeEngine(null);
    const withArm: Engine = { ...engine, arm: (...a: unknown[]) => void calls.push(a) };
    const runner = createEffectRunner(deps(withArm, fakePlayer(0), {}), {
      dispatch: noop,
      state: () => initialSessionState('granted'),
    });
    runner.run({ k: 'arm', epoch: 3, restoreFloorDb: -50, marginBoostDb: 6 });
    runner.run({ k: 'arm', epoch: 4 });
    expect(calls).toEqual([
      [3, -50, 6],
      [4, undefined, undefined],
    ]);
  });
});
