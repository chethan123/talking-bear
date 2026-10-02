// The engine in a real Chromium (Vitest Browser Mode): real AudioContext, capture worklet (loaded from the Vite
// dev server), DSP worker and the fake microphone (--use-fake-device-for-media-stream: a 400 Hz beep every
// 500 ms). One engine is shared by tests 1–15, which run in order; tests 16–20 use fresh engines.
//
// Test-only patches on this page, installed before the engines exist and removed in afterAll: `Worker` records
// every instance and terminate() call (and can be told to fail its next construction), `getUserMedia` records
// constraints and streams, and `enumerateDevices` can return a scripted list. Some tests also wrap a prototype
// method for the duration of one call (patchMethod). The engine itself has no test hooks.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PRESETS } from '../dsp/types.ts';
import { CHUNK_MAX } from './constants.ts';
import { createEngine, type Engine, type EngineEvent } from './engine.ts';
import { CONSTRAINTS } from './mic.ts';

const OriginalWorker = globalThis.Worker;
const workers: RecordingWorker[] = [];
/** When set, the next `new Worker` throws (the real worker it had to create first is terminated). */
let failNextWorker = false;

class RecordingWorker extends OriginalWorker {
  terminated = false;
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    if (failNextWorker) {
      failNextWorker = false;
      super.terminate();
      throw new DOMException('test: worker creation failed', 'SecurityError');
    }
    workers.push(this);
  }
  override terminate(): void {
    this.terminated = true;
    super.terminate();
  }
}

const md = navigator.mediaDevices;
const realGetUserMedia = md.getUserMedia.bind(md);
const realEnumerateDevices = md.enumerateDevices.bind(md);
const gumConstraints: (MediaStreamConstraints | undefined)[] = [];
const streams: MediaStream[] = [];
/** When set, enumerateDevices() resolves to this list instead of the real one. */
let scriptedDevices: MediaDeviceInfo[] | null = null;

type EventOf<T extends EngineEvent['t']> = Extract<EngineEvent, { t: T }>;

function isType<T extends EngineEvent['t']>(e: EngineEvent, t: T): e is EventOf<T> {
  return e.t === t;
}

/** An engine's event log, with waiting helpers. */
function createRecorder(): {
  log: EngineEvent[];
  onEvent: (e: EngineEvent) => void;
  waitFor: <T extends EngineEvent['t']>(
    t: T,
    from: number,
    ms: number,
    pred?: (e: EventOf<T>) => boolean,
  ) => Promise<{ event: EventOf<T>; index: number }>;
  count: (t: EngineEvent['t'], from: number) => number;
} {
  const log: EngineEvent[] = [];
  const waiters = new Set<() => void>();

  /** Event types seen from `from` on, with counts (level events are frequent). */
  function seen(from: number): string {
    const counts = new Map<string, number>();
    for (const e of log.slice(from)) counts.set(e.t, (counts.get(e.t) ?? 0) + 1);
    return [...counts].map(([t, n]) => `${t}×${n}`).join(', ') || 'nothing';
  }

  /** The first event of type `t` at index ≥ `from` that satisfies `pred`, waiting up to `ms`. */
  async function waitFor<T extends EngineEvent['t']>(
    t: T,
    from: number,
    ms: number,
    pred: (e: EventOf<T>) => boolean = () => true,
  ): Promise<{ event: EventOf<T>; index: number }> {
    const deadline = performance.now() + ms;
    for (;;) {
      for (let i = from; i < log.length; i++) {
        const e = log[i];
        if (e !== undefined && isType(e, t) && pred(e)) return { event: e, index: i };
      }
      const left = deadline - performance.now();
      if (left <= 0) throw new Error(`no matching ${t} within ${ms} ms; saw ${seen(from)}`);
      await new Promise<void>((resolve) => {
        const done = (): void => {
          waiters.delete(done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, left);
        waiters.add(done);
      });
    }
  }

  return {
    log,
    onEvent: (e) => {
      log.push(e);
      for (const wake of waiters) wake(); // a waiter removes itself; deleting during Set iteration is safe
    },
    waitFor,
    count: (t, from) => log.slice(from).filter((e) => e.t === t).length,
  };
}

type Call = (self: unknown, args: unknown[]) => unknown;

/** Replaces the own method `key` of `target` with `wrap(original)`; returns the function that restores it. */
function patchMethod(target: object, key: string, wrap: (original: Call) => Call): () => void {
  const desc = Object.getOwnPropertyDescriptor(target, key);
  const original: unknown = desc?.value;
  if (desc === undefined || typeof original !== 'function') throw new Error(`${key} is not an own method`);
  const call: Call = (self, args) => Reflect.apply(original, self, args);
  const replacement = wrap(call);
  Object.defineProperty(target, key, {
    ...desc,
    value: function (this: unknown, ...args: unknown[]): unknown {
      return replacement(this, args);
    },
  });
  return () => {
    Object.defineProperty(target, key, desc);
  };
}

/** The `t` of a posted message. */
function messageType(msg: unknown): string {
  return typeof msg === 'object' && msg !== null && 't' in msg && typeof msg.t === 'string' ? msg.t : '?';
}

/** Records every Worker and MessagePort postMessage made while `run` executes, as `worker:<t>` / `port:<t>`. */
function recordPosts(run: () => void): string[] {
  const posts: string[] = [];
  const record =
    (where: string) =>
    (original: Call): Call =>
    (self, args) => {
      posts.push(`${where}:${messageType(args[0])}`);
      return original(self, args);
    };
  const restoreWorker = patchMethod(OriginalWorker.prototype, 'postMessage', record('worker'));
  const restorePort = patchMethod(MessagePort.prototype, 'postMessage', record('port'));
  try {
    run();
  } finally {
    restorePort();
    restoreWorker();
  }
  return posts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function peak(x: Float32Array): number {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

function deviceInfo(kind: MediaDeviceKind, deviceId: string): MediaDeviceInfo {
  return { deviceId, groupId: '', kind, label: '', toJSON: () => ({ deviceId, kind }) };
}

function fireDeviceChange(): void {
  md.dispatchEvent(new Event('devicechange'));
}

function lastWorker(): RecordingWorker {
  const w = workers.at(-1);
  if (w === undefined) throw new Error('no worker was created');
  return w;
}

function withoutLevels(events: readonly EngineEvent[]): EngineEvent[] {
  return events.filter((e) => e.t !== 'level');
}

const { log, onEvent, waitFor, count } = createRecorder();
let engine: Engine;
/** Engines of tests 16–20, closed in afterAll. */
const freshEngines: Engine[] = [];
let sr = 0;
let armFrame = 0;

function freshEngine(connectWorkletOutput = false): ReturnType<typeof createRecorder> & { engine: Engine } {
  const rec = createRecorder();
  const e = createEngine({ connectWorkletOutput, onEvent: rec.onEvent });
  freshEngines.push(e);
  return { ...rec, engine: e };
}

/** Fires devicechange with `devices` enumerated (null: the real list) and checks the inputsChanged count. */
async function expectInputChanges(devices: MediaDeviceInfo[] | null, changes: 0 | 1): Promise<void> {
  scriptedDevices = devices;
  const from = log.length;
  fireDeviceChange();
  if (changes === 1) await waitFor('inputsChanged', from, 2000);
  await sleep(changes === 1 ? 100 : 200);
  expect(count('inputsChanged', from)).toBe(changes);
}

beforeAll(() => {
  globalThis.Worker = RecordingWorker;
  md.getUserMedia = async (c?: MediaStreamConstraints): Promise<MediaStream> => {
    gumConstraints.push(c);
    const s = await realGetUserMedia(c);
    streams.push(s);
    return s;
  };
  md.enumerateDevices = (): Promise<MediaDeviceInfo[]> =>
    scriptedDevices === null ? realEnumerateDevices() : Promise.resolve(scriptedDevices);
  engine = createEngine({ connectWorkletOutput: false, onEvent });
});

afterAll(async () => {
  for (const e of [engine, ...freshEngines]) {
    e.closeMic();
    await e.context()?.close();
  }
  for (const w of workers) w.terminate();
  globalThis.Worker = OriginalWorker;
  Reflect.deleteProperty(md, 'getUserMedia');
  Reflect.deleteProperty(md, 'enumerateDevices');
});

describe('engine (Browser Mode, fake media)', () => {
  test('1: resume() emits ctxRunning and builds the graph', async () => {
    const from = log.length;
    await engine.resume();
    const { event } = await waitFor('ctxRunning', from, 5000);
    const ctx = engine.context();
    if (ctx === null) throw new Error('context() is null after resume()');
    sr = ctx.sampleRate;
    expect(event.sampleRate).toBe(sr);
    expect(ctx.state).toBe('running');
    const bus = engine.masterBus();
    if (!(bus instanceof GainNode)) throw new Error('masterBus() is not the 0.7 GainNode');
    expect(bus.gain.value).toBeCloseTo(0.7, 6);
    expect(workers).toHaveLength(1);
  }, 10_000);

  test('2: openMic(1) emits micGranted{1}, with the §4.1.1 constraints and the initial mute state', async () => {
    const from = log.length;
    engine.openMic(1);
    const { index } = await waitFor('micGranted', from, 5000, (e) => e.req === 1);
    expect(gumConstraints.at(-1)).toStrictEqual({ audio: { ...CONSTRAINTS } });
    const track = streams.at(-1)?.getAudioTracks()[0];
    if (track === undefined) throw new Error('no audio track was recorded');
    expect(log[index + 1]).toStrictEqual({ t: track.muted ? 'trackMuted' : 'trackUnmuted' });
  }, 10_000);

  test('3: arm(1) posts reset to the worker before arm to the worklet, emits armed{1, …}, and level events arrive within 1500 ms', async () => {
    const from = log.length;
    const t0 = performance.now();
    const posts = recordPosts(() => {
      engine.arm(1);
    });
    expect(posts).toStrictEqual(['worker:reset', 'port:arm']);
    const armed = await waitFor('armed', from, 1500, (e) => e.epoch === 1);
    expect(Number.isSafeInteger(armed.event.armFrame)).toBe(true);
    armFrame = armed.event.armFrame;
    await waitFor('level', from, 1500 - (performance.now() - t0), (e) => e.epoch === 1);
    expect(performance.now() - t0).toBeLessThanOrEqual(1500);
  }, 10_000);

  test('4: take(1, 1, armFrame, armFrame + 0.5·sr) emits clipReady with exactly 0.5·sr samples', async () => {
    const n = Math.round(0.5 * sr);
    const from = log.length;
    engine.take(1, 1, armFrame, armFrame + n);
    await waitFor('clipReady', from, 3000, (e) => e.epoch === 1 && e.id === 1);
    expect(engine.getClip(1, 1)?.length).toBe(n);
    expect(count('takeFailed', from)).toBe(0);
  }, 10_000);

  test('5: a later 1 s take carries the fake mic signal and replaces the previous clip', async () => {
    const from = log.length;
    engine.take(1, 2, armFrame + sr, armFrame + 2 * sr);
    await waitFor('clipReady', from, 4000, (e) => e.epoch === 1 && e.id === 2);
    expect(engine.getClip(1, 1)).toBeUndefined();
    const clip = engine.getClip(1, 2);
    expect(clip?.length).toBe(sr);
    expect(peak(clip ?? new Float32Array(0))).toBeGreaterThanOrEqual(0.1);
  }, 10_000);

  test('6: process() round-trips the clip through the worker; a wrong id gives fxError', async () => {
    const from = log.length;
    engine.process(2, PRESETS.cub);
    const { event } = await waitFor('processed', from, 3000, (e) => e.id === 2);
    const result = engine.getProcessed(2);
    if (result === undefined) throw new Error('no processed result for id 2');
    // The worker ran the voice chain (M3): the 1 s take, trimmed around the beeps, then resampled by 1/p, at
    // the context rate.
    expect(result.sampleRate).toBe(sr);
    expect(result.durationSec).toBe(event.durationSec);
    expect(result.durationSec).toBe(result.pcm.length / sr);
    expect(result.pcm.length).toBeGreaterThan(0);
    expect(result.pcm.length).toBeLessThanOrEqual(Math.round(sr / PRESETS.cub.pitchRatio));
    expect(result.envelope.hopMs).toBe(10);
    expect(result.envelope.jaw.length).toBeGreaterThan(0);
    expect(engine.getClip(1, 2)).toBeUndefined(); // transferred away
    const before = log.length;
    engine.process(99, PRESETS.cub);
    expect(log.slice(before)).toStrictEqual([{ t: 'fxError', id: 99 }]);
  }, 10_000);

  test('7: take() with a non-safe-integer argument fails synchronously and posts nothing', () => {
    const cases: [number, number, number, number][] = [
      [1, 1.5, 0, 10],
      [Number.NaN, 3, 0, 10],
      [1, 3, 0.5, 10],
      [1, 3, 0, Number.POSITIVE_INFINITY],
      [1, 3, 0, 2 ** 53],
    ];
    for (const [epoch, id, fromFrame, toFrame] of cases) {
      const from = log.length;
      const posts = recordPosts(() => {
        engine.take(epoch, id, fromFrame, toFrame);
      });
      expect(posts, `take(${epoch}, ${id}, ${fromFrame}, ${toFrame})`).toStrictEqual([]);
      expect(log.slice(from)).toStrictEqual([{ t: 'takeFailed', epoch, id }]);
    }
  });

  test('8: a take longer than CHUNK_MAX is assembled from its chunks in seq order', async () => {
    const n = Math.round(1.5 * sr);
    expect(n).toBeGreaterThan(CHUNK_MAX); // two chunks
    let from = log.length;
    engine.take(1, 10, armFrame, armFrame + n);
    await waitFor('clipReady', from, 5000, (e) => e.epoch === 1 && e.id === 10);
    const big = engine.getClip(1, 10);
    if (big === undefined) throw new Error('no clip for take 10');
    expect(big.length).toBe(n);
    // The same frames again, starting inside the first chunk: a one-chunk take that must match the tail.
    const offset = 50_000;
    from = log.length;
    engine.take(1, 11, armFrame + offset, armFrame + n);
    await waitFor('clipReady', from, 3000, (e) => e.epoch === 1 && e.id === 11);
    const tail = engine.getClip(1, 11);
    if (tail === undefined) throw new Error('no clip for take 11');
    expect(tail.length).toBe(n - offset);
    expect(Array.from(big.subarray(offset))).toStrictEqual(Array.from(tail));
    expect(engine.getClip(1, 10)).toBeUndefined();
  }, 15_000);

  test("9: the worker's error{fx} becomes fxError{the last process id}, and error{vad} becomes vadError", () => {
    engine.process(42, PRESETS.cub); // no clip with id 42: an early fxError{42}, and 42 is the last process id
    expect(engine.getClip(1, 11)).toBeDefined(); // a mismatched process() leaves the clip alone
    const w = lastWorker();
    const from = log.length;
    w.dispatchEvent(new MessageEvent('message', { data: { t: 'error', where: 'fx', message: 'x' } }));
    w.dispatchEvent(new MessageEvent('message', { data: { t: 'error', where: 'vad', message: 'y' } }));
    expect(withoutLevels(log.slice(from))).toStrictEqual([
      { t: 'fxError', id: 42 },
      { t: 'vadError', message: 'y' },
    ]);
  });

  test('10: devicechange emits inputsChanged only when the set of audio input ids changes', async () => {
    const real = await realEnumerateDevices();
    // Another kind, and an audio input without an id: the set of input ids is unchanged.
    await expectInputChanges(
      [...real, deviceInfo('videoinput', 'extra-camera'), deviceInfo('audioinput', '')],
      0,
    );
    // A new input id.
    await expectInputChanges([...real, deviceInfo('audioinput', 'usb-a')], 1);
    // The same list again: nothing.
    await expectInputChanges([...real, deviceInfo('audioinput', 'usb-a')], 0);
    // A different id in its place: same size, different set (plan §4.5: never compare by count or position).
    await expectInputChanges([...real, deviceInfo('audioinput', 'usb-b')], 1);
    // Back to the real list: one change.
    await expectInputChanges(null, 1);
  }, 10_000);

  test("11: the context's error event emits ctxError", () => {
    const ctx = engine.context();
    if (ctx === null) throw new Error('no context');
    const from = log.length;
    ctx.dispatchEvent(new Event('error'));
    expect(log.slice(from)).toStrictEqual([{ t: 'ctxError' }]);
  });

  test('12: closeMic() ends every track and drops the clip and the processed audio', () => {
    expect(engine.getClip(1, 11)).toBeDefined();
    expect(engine.getProcessed(2)).toBeDefined();
    engine.closeMic();
    expect(streams.length).toBeGreaterThan(0);
    for (const s of streams) for (const t of s.getTracks()) expect(t.readyState).toBe('ended');
    expect(engine.getClip(1, 11)).toBeUndefined();
    expect(engine.getProcessed(2)).toBeUndefined();
    for (const bad of ['ctxResumeFailed', 'workerFailed'] as const) {
      expect(count(bad, 0), `${bad} during tests 1–12`).toBe(0);
    }
    expect(withoutLevels(log).filter((e) => e.t === 'vadError')).toStrictEqual([
      { t: 'vadError', message: 'y' },
    ]);
  });

  test('13: after restartWorker() + arm(2), level events with epoch 2 arrive', async () => {
    const old = lastWorker();
    const workerCount = workers.length;
    const from = log.length;
    engine.restartWorker();
    expect(workers).toHaveLength(workerCount + 1);
    expect(old.terminated).toBe(true);
    engine.arm(2);
    await waitFor('armed', from, 3000, (e) => e.epoch === 2);
    await waitFor('level', from, 3000, (e) => e.epoch === 2);
    const levels = log.slice(from).filter((e) => isType(e, 'level'));
    expect(levels.every((e) => isType(e, 'level') && e.epoch === 2)).toBe(true);
  }, 10_000);

  test('14: a failed worker reports once, and resume() recreates it (T17 D25), and only then', async () => {
    // error and messageerror from the same worker: one workerFailed.
    const failed = lastWorker();
    let workerCount = workers.length;
    let from = log.length;
    failed.dispatchEvent(new Event('error'));
    failed.dispatchEvent(new MessageEvent('messageerror'));
    expect(log.slice(from)).toStrictEqual([{ t: 'workerFailed' }]);

    // The recreation itself fails: that is a new failure, reported, and resume() still runs the context.
    failNextWorker = true;
    from = log.length;
    await engine.resume();
    expect(failed.terminated).toBe(true);
    expect(workers).toHaveLength(workerCount);
    expect(withoutLevels(log.slice(from))).toStrictEqual([
      { t: 'workerFailed' },
      { t: 'ctxRunning', sampleRate: sr },
    ]);

    // The next resume() recreates it, and the new worker serves the next epoch.
    await engine.resume();
    expect(workers).toHaveLength(workerCount + 1);
    from = log.length;
    engine.arm(3);
    await waitFor('level', from, 3000, (e) => e.epoch === 3);

    // No failure since: resume() keeps the worker.
    workerCount = workers.length;
    await engine.resume();
    expect(workers).toHaveLength(workerCount);

    // messageerror alone counts as a failure too.
    const failedAgain = lastWorker();
    from = log.length;
    failedAgain.dispatchEvent(new MessageEvent('messageerror'));
    expect(log.slice(from)).toStrictEqual([{ t: 'workerFailed' }]);
    await engine.resume();
    expect(workers).toHaveLength(workerCount + 1);
    expect(failedAgain.terminated).toBe(true);

    // restartWorker() on a healthy worker whose replacement can't be created reports it.
    failNextWorker = true;
    workerCount = workers.length;
    from = log.length;
    engine.restartWorker();
    expect(log.slice(from)).toStrictEqual([{ t: 'workerFailed' }]);
    expect(workers).toHaveLength(workerCount);
    await engine.resume();
    expect(workers).toHaveLength(workerCount + 1);
  }, 15_000);

  test('15: suspend() and resume(); a suspend() that lands while ctx.resume() is pending wins', async () => {
    const ctx = engine.context();
    if (ctx === null) throw new Error('no context');
    await engine.suspend();
    expect(ctx.state).toBe('suspended');
    let from = log.length;
    await engine.resume();
    expect(ctx.state).toBe('running');
    expect(log.slice(from)).toContainEqual({ t: 'ctxRunning', sampleRate: sr });

    // The race is scripted on this instance: ctx.resume() stays pending until a suspend() has landed. (A real
    // ctx.resume() overtaken by a suspend() may never settle in Chrome, or may settle with the context running.)
    await engine.suspend();
    const pending: { settle?: () => void } = {};
    let suspendCalls = 0;
    const suspendContext = ctx.suspend.bind(ctx);
    ctx.resume = (): Promise<void> =>
      new Promise<void>((resolve) => {
        pending.settle = resolve;
      });
    ctx.suspend = (): Promise<void> => {
      suspendCalls++;
      return suspendContext();
    };
    from = log.length;
    try {
      const resuming = engine.resume();
      for (let i = 0; pending.settle === undefined && i < 100; i++) await sleep(1);
      if (pending.settle === undefined) throw new Error('resume() never reached ctx.resume()');
      await engine.suspend();
      pending.settle();
      await resuming;
    } finally {
      Reflect.deleteProperty(ctx, 'resume');
      Reflect.deleteProperty(ctx, 'suspend');
    }
    expect(count('ctxRunning', from)).toBe(0);
    expect(suspendCalls).toBe(2); // the suspend() itself, then the engine's re-suspend after the raced resume
    expect(ctx.state).toBe('suspended');
  }, 10_000);

  test('16: the worklet output reaches destination only with connectWorkletOutput (plan §3.2)', async () => {
    const edges: boolean[] = [];
    const restore = patchMethod(AudioNode.prototype, 'connect', (original) => (self, args) => {
      if (self instanceof AudioWorkletNode) edges.push(args[0] === self.context.destination);
      return original(self, args);
    });
    try {
      await freshEngine(false).engine.resume();
      expect(edges).toStrictEqual([]);
      await freshEngine(true).engine.resume();
      expect(edges).toStrictEqual([true]);
    } finally {
      restore();
    }
  }, 10_000);

  test('17: a mic granted before the graph that then fails to connect gives noDevice{req}, and the mic is closed', async () => {
    const b = freshEngine();
    b.engine.openMic(7);
    await b.waitFor('micGranted', 0, 5000, (e) => e.req === 7);
    const stream = streams.at(-1);
    const track = stream?.getAudioTracks()[0];
    if (stream === undefined || track === undefined) throw new Error('no stream was recorded');
    const restore = patchMethod(AudioContext.prototype, 'createMediaStreamSource', () => () => {
      throw new DOMException('test: cannot connect', 'InvalidStateError');
    });
    try {
      await b.engine.resume();
    } finally {
      restore();
    }
    expect(withoutLevels(b.log)).toStrictEqual([
      { t: 'micGranted', req: 7 },
      { t: track.muted ? 'trackMuted' : 'trackUnmuted' },
      { t: 'noDevice', req: 7 },
      { t: 'ctxRunning', sampleRate: sr },
    ]);
    for (const t of stream.getTracks()) expect(t.readyState).toBe('ended');
  }, 10_000);

  test('18: a processed reply that arrives after closeMic() is dropped', async () => {
    const d = freshEngine();
    await d.engine.resume();
    d.engine.openMic(1);
    await d.waitFor('micGranted', 0, 5000);
    d.engine.arm(1);
    const { event } = await d.waitFor('armed', 0, 3000, (e) => e.epoch === 1);
    const n = Math.round(0.1 * sr);
    d.engine.take(1, 2, event.armFrame, event.armFrame + n);
    await d.waitFor('clipReady', 0, 3000, (e) => e.id === 2);
    const from = d.log.length;
    d.engine.process(2, PRESETS.cub);
    d.engine.closeMic(); // before the worker's reply
    await sleep(300);
    expect(d.count('processed', from)).toBe(0);
    expect(d.engine.getProcessed(2)).toBeUndefined();
  }, 10_000);

  test('19: releaseProcessed(id) drops the processed result of that id only', async () => {
    const d = freshEngine();
    await d.engine.resume();
    d.engine.openMic(1);
    await d.waitFor('micGranted', 0, 5000);
    d.engine.arm(1);
    const { event } = await d.waitFor('armed', 0, 3000, (e) => e.epoch === 1);
    d.engine.take(1, 2, event.armFrame, event.armFrame + Math.round(0.1 * sr));
    await d.waitFor('clipReady', 0, 3000, (e) => e.id === 2);
    d.engine.process(2, PRESETS.cub);
    await d.waitFor('processed', 0, 3000, (e) => e.id === 2);
    expect(d.engine.getProcessed(2)).toBeDefined();
    d.engine.releaseProcessed(3);
    expect(d.engine.getProcessed(2)).toBeDefined();
    d.engine.releaseProcessed(2);
    expect(d.engine.getProcessed(2)).toBeUndefined();
  }, 10_000);

  test('20: setTrace(true) delivers traceBatch events within 1 s; a restarted worker keeps tracing; setTrace(false) stops them', async () => {
    const rec = createRecorder();
    const e = createEngine({ connectWorkletOutput: false, onEvent: rec.onEvent });
    freshEngines.push(e);
    await e.resume();
    e.openMic(1);
    await rec.waitFor('micGranted', 0, 5000);
    e.arm(1);
    await rec.waitFor('armed', 0, 3000, (ev) => ev.epoch === 1);

    let from = rec.log.length;
    const t0 = performance.now();
    e.setTrace(true);
    const first = await rec.waitFor('traceBatch', from, 1000, (ev) => ev.epoch === 1);
    expect(performance.now() - t0).toBeLessThanOrEqual(1000);
    const b = first.event;
    expect(b.rawDb).toHaveLength(25);
    expect(b.bandDb).toHaveLength(25);
    expect(b.voicing).toHaveLength(25);
    for (const db of b.rawDb) expect(Number.isFinite(db) && db >= -120, `rawDb ${db}`).toBe(true);
    for (const v of b.voicing) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // Either backend: Silero frames carry a p and a time each; without Silero both are empty and sil0Frame NaN.
    expect(b.inferMs).toHaveLength(b.sileroP.length);
    expect(Number.isNaN(b.sil0Frame)).toBe(b.sileroP.length === 0);
    const second = await rec.waitFor('traceBatch', first.index + 1, 1000, (ev) => ev.epoch === 1);
    const hops25 = (25 * sr) / 100;
    expect(Math.abs(second.event.hop0Frame - b.hop0Frame - hops25)).toBeLessThanOrEqual(1);

    // A new worker gets the setting after its init: no second setTrace(true).
    from = rec.log.length;
    e.restartWorker();
    e.arm(2);
    await rec.waitFor('traceBatch', from, 1500, (ev) => ev.epoch === 2);

    // Off: the partial batch (and any batch already on its way) may still arrive, then nothing.
    e.setTrace(false);
    await sleep(600);
    from = rec.log.length;
    await sleep(600);
    expect(rec.count('traceBatch', from)).toBe(0);
  }, 15_000);
});
