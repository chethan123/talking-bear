// The engine in a real Chromium (Vitest Browser Mode): real AudioContext, capture worklet (loaded from the Vite
// dev server), DSP worker and the fake microphone (--use-fake-device-for-media-stream: a 400 Hz beep every
// 500 ms). One engine is shared by the tests below, which run in order.
//
// Test-only patches on this page, installed before the engine exists and removed in afterAll: `Worker` records
// every instance and terminate() call, `getUserMedia` records constraints and streams, and `enumerateDevices`
// can return a scripted list. The engine itself has no test hooks.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PRESETS } from '../dsp/types.ts';
import { createEngine, type Engine, type EngineEvent } from './engine.ts';
import { CONSTRAINTS } from './mic.ts';

const OriginalWorker = globalThis.Worker;
const workers: RecordingWorker[] = [];

class RecordingWorker extends OriginalWorker {
  terminated = false;
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
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

const log: EngineEvent[] = [];
const waiters = new Set<() => void>();

function onEvent(e: EngineEvent): void {
  log.push(e);
  for (const wake of waiters) wake(); // a waiter removes itself; deleting during Set iteration is safe
}

function isType<T extends EngineEvent['t']>(e: EngineEvent, t: T): e is EventOf<T> {
  return e.t === t;
}

/** Event types seen from `from` on, with counts (level events are frequent). */
function seen(from: number): string {
  const counts = new Map<string, number>();
  for (const e of log.slice(from)) counts.set(e.t, (counts.get(e.t) ?? 0) + 1);
  return [...counts].map(([t, n]) => `${t}×${n}`).join(', ') || 'nothing';
}

function count(t: EngineEvent['t'], from: number): number {
  return log.slice(from).filter((e) => e.t === t).length;
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

let engine: Engine;
let sr = 0;
let armFrame = 0;

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
  engine.closeMic();
  for (const w of workers) w.terminate();
  globalThis.Worker = OriginalWorker;
  await engine.context()?.close();
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

  test('3: arm(1) emits armed{1, …}, and level events arrive within 1500 ms', async () => {
    const from = log.length;
    const t0 = performance.now();
    engine.arm(1);
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
    const expected = sr / sr / PRESETS.cub.pitchRatio;
    expect(Math.abs(event.durationSec - expected)).toBeLessThanOrEqual(1e-9);
    const result = engine.getProcessed(2);
    expect(result?.pcm.length).toBe(sr);
    expect(result?.sampleRate).toBe(sr);
    expect(result?.durationSec).toBe(event.durationSec);
    expect(result?.envelope.hopMs).toBe(10);
    expect(engine.getClip(1, 2)).toBeUndefined(); // transferred away
    const before = log.length;
    engine.process(99, PRESETS.cub);
    expect(log.slice(before)).toStrictEqual([{ t: 'fxError', id: 99 }]);
  }, 10_000);

  test('7: devicechange emits inputsChanged only when the set of audio input ids changes', async () => {
    const real = await realEnumerateDevices();

    // Another kind, and an audio input without an id: the set of input ids is unchanged.
    scriptedDevices = [...real, deviceInfo('videoinput', 'extra-camera'), deviceInfo('audioinput', '')];
    let from = log.length;
    fireDeviceChange();
    await sleep(200);
    expect(count('inputsChanged', from)).toBe(0);

    // A new input id.
    scriptedDevices = [...real, deviceInfo('audioinput', 'extra-usb-mic')];
    from = log.length;
    fireDeviceChange();
    await waitFor('inputsChanged', from, 2000);
    await sleep(100);
    expect(count('inputsChanged', from)).toBe(1);

    // The same list again: nothing.
    from = log.length;
    fireDeviceChange();
    await sleep(200);
    expect(count('inputsChanged', from)).toBe(0);

    // Back to the real list: one change.
    scriptedDevices = null;
    from = log.length;
    fireDeviceChange();
    await waitFor('inputsChanged', from, 2000);
    await sleep(100);
    expect(count('inputsChanged', from)).toBe(1);
  }, 10_000);

  test("8: the context's error event emits ctxError", () => {
    const ctx = engine.context();
    if (ctx === null) throw new Error('no context');
    const from = log.length;
    ctx.dispatchEvent(new Event('error'));
    expect(log.slice(from)).toStrictEqual([{ t: 'ctxError' }]);
  });

  test('9: closeMic() leaves every track ended', () => {
    engine.closeMic();
    expect(streams.length).toBeGreaterThan(0);
    for (const s of streams) for (const t of s.getTracks()) expect(t.readyState).toBe('ended');
    for (const bad of ['ctxResumeFailed', 'workerFailed', 'vadError'] as const) {
      expect(count(bad, 0), `${bad} during tests 1–9`).toBe(0);
    }
  });

  test('10: after restartWorker() + arm(2), level events with epoch 2 arrive', async () => {
    const old = lastWorker();
    const from = log.length;
    engine.restartWorker();
    expect(workers).toHaveLength(2);
    expect(old.terminated).toBe(true);
    engine.arm(2);
    await waitFor('armed', from, 3000, (e) => e.epoch === 2);
    await waitFor('level', from, 3000, (e) => e.epoch === 2);
    const levels = log.slice(from).filter((e) => isType(e, 'level'));
    expect(levels.every((e) => isType(e, 'level') && e.epoch === 2)).toBe(true);
  }, 10_000);

  test('11: resume() recreates the worker after it failed (T17 D25), and only then', async () => {
    const failed = lastWorker();
    const workerCount = workers.length;
    let from = log.length;
    failed.dispatchEvent(new Event('error'));
    expect(log.slice(from)).toStrictEqual([{ t: 'workerFailed' }]);

    await engine.resume();
    expect(workers).toHaveLength(workerCount + 1);
    expect(failed.terminated).toBe(true);
    await waitFor('ctxRunning', from, 1000);
    from = log.length;
    engine.arm(3);
    await waitFor('level', from, 3000, (e) => e.epoch === 3);

    // No failure since: resume() keeps the worker.
    await engine.resume();
    expect(workers).toHaveLength(workerCount + 1);

    // messageerror counts as a failure too.
    const failedAgain = lastWorker();
    from = log.length;
    failedAgain.dispatchEvent(new MessageEvent('messageerror'));
    expect(log.slice(from)).toStrictEqual([{ t: 'workerFailed' }]);
    await engine.resume();
    expect(workers).toHaveLength(workerCount + 2);
    expect(failedAgain.terminated).toBe(true);
  }, 10_000);

  test('12: suspend() suspends the context; resume() runs it again and emits ctxRunning', async () => {
    const ctx = engine.context();
    if (ctx === null) throw new Error('no context');
    await engine.suspend();
    expect(ctx.state).toBe('suspended');
    const from = log.length;
    await engine.resume();
    expect(ctx.state).toBe('running');
    expect(log.slice(from)).toContainEqual({ t: 'ctxRunning', sampleRate: sr });
  }, 10_000);
});
