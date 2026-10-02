// The effect runner's `onPlayStarted` report (issue #81): a `play{id}` effect that starts a replay reports the
// player's scheduled start, synchronously, before the transition's next effect (`anim talk{id}`). Node, with
// minimal fakes; the rest of the runner is covered through the session in session.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../test/fake-clock.ts';
import type { Engine } from '../audio/engine.ts';
import type { PlayHandle } from '../audio/player.ts';
import { emptyEnvelope } from '../dsp/types.ts';
import { createEffectRunner, type EffectDeps } from './effects.ts';
import type { SessionEvent } from './events.ts';
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
