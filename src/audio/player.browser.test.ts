import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createMasterBus } from './bus.ts';
import { outputContextTimeNow } from './output-clock.ts';
import { createPlayer } from './player.ts';
import { createSfx, M1_SYNTHS, type SfxSynth } from './sfx.ts';

/** An output timestamp read through `ctx.getOutputTimestamp()`, and when it was read. */
interface TimestampRead {
  ts: AudioTimestamp;
  readAt: number;
}

let ctx: AudioContext;
/** The last output timestamp anything read from `ctx`; cleared just before each play. */
let lastRead: TimestampRead | undefined;

/**
 * `outputContextTimeNow` at the moment a `done` / `allEnded()` promise resolved (`resolvedAt`), from
 * `r`, the value of `lastRead` at that moment.
 *
 * It first proves that the code under test judged a real output timestamp during this play: one was
 * read after `t0` (taken just before the play, with `lastRead` cleared) and no later than `resolvedAt`,
 * and it is not the "no timestamp yet" fallback. It then extrapolates that timestamp to `resolvedAt`,
 * which is ≥ the value the code judged, because `performance.now()` only moves forward. A fresh
 * `getOutputTimestamp()` is not used: it can step back by a few ms when a new timestamp arrives, which
 * would make the assertion depend on timing.
 */
function outputContextTimeAtResolution(r: TimestampRead | undefined, t0: number, resolvedAt: number): number {
  expect(r, 'the code read a real output timestamp').toBeDefined();
  expect(r?.ts.performanceTime, 'the code read a real output timestamp').toBeGreaterThan(0);
  expect(r?.readAt, 'read after the play started').toBeGreaterThanOrEqual(t0);
  expect(r?.readAt, 'read before the promise resolved').toBeLessThanOrEqual(resolvedAt);
  const ts = r?.ts ?? {};
  return outputContextTimeNow(
    { currentTime: ctx.currentTime, outputLatency: ctx.outputLatency, getOutputTimestamp: () => ts },
    () => resolvedAt,
  );
}

/** Diagnostic only, for failure messages: a fresh reading of the output clock. */
function freshReading(): string {
  return `fresh outputContextTimeNow ${outputContextTimeNow(ctx)}`;
}

function silence(seconds: number): AudioBuffer {
  return new AudioBuffer({
    length: Math.round(seconds * ctx.sampleRate),
    sampleRate: ctx.sampleRate,
    numberOfChannels: 1,
  });
}

beforeAll(async () => {
  // The browser project launches Chromium with --autoplay-policy=no-user-gesture-required.
  ctx = new AudioContext({ latencyHint: 'interactive' });
  const read = ctx.getOutputTimestamp.bind(ctx);
  ctx.getOutputTimestamp = () => {
    const ts = read();
    lastRead = { ts, readAt: performance.now() };
    return ts;
  };
  await ctx.resume();
});

afterAll(async () => {
  await ctx.close();
});

/** A unit constant source from time 0 into `bus.input`. */
function unitInto(off: OfflineAudioContext, bus: ReturnType<typeof createMasterBus>): void {
  const src = new ConstantSourceNode(off, { offset: 1 });
  src.connect(bus.input);
  src.start(0);
}

describe('master bus', () => {
  test('the master gain is 0.7', () => {
    const bus = createMasterBus(ctx);
    expect(bus.input.gain.value).toBeCloseTo(0.7, 6);
    bus.output.disconnect();
  });

  test('a unit signal into the bus reaches the destination at 0.7 (Quiet off)', async () => {
    // 0.3 s, and only the last 128 samples are checked, so a Quiet gain ramping with τ = 20 ms (M3) has
    // settled by then.
    const sampleRate = 48000;
    const off = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(0.3 * sampleRate),
      sampleRate,
    });
    const bus = createMasterBus(off);
    bus.setQuiet(false); // Quiet mode is on by default (M3); off ramps to gain 1 with τ = 20 ms, settled after 15 τ
    const src = new ConstantSourceNode(off, { offset: 1 });
    src.connect(bus.input);
    src.start(0);
    const rendered = await off.startRendering();
    const data = rendered.getChannelData(0);
    for (const x of data.subarray(data.length - 128)) expect(x).toBeCloseTo(0.7, 6);
  });

  // Quiet mode (plan §4.3.4, issue #66): another −6 dB after the 0.7 master gain, as the bus's last node.
  const QUIET = 10 ** (-6 / 20);
  const OFFLINE_RATE = 48000;

  /** A 0.3 s, 48 kHz, mono offline context. */
  function offline(): OfflineAudioContext {
    return new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(0.3 * OFFLINE_RATE),
      sampleRate: OFFLINE_RATE,
    });
  }

  test('Quiet mode is on from creation: a unit signal reaches the destination at 0.7 · 10^(−6/20)', async () => {
    const off = offline();
    const bus = createMasterBus(off);
    unitInto(off, bus);
    const data = (await off.startRendering()).getChannelData(0);
    for (const x of data.subarray(data.length - 128)) expect(x).toBeCloseTo(0.7 * QUIET, 6);
  });

  test("output is the bus's last node; a tap after it hears the post-Quiet level", async () => {
    const off = offline();
    const bus = createMasterBus(off);
    expect(bus.output).not.toBe(bus.input);
    // Wired as the engine's insertOutputTap does: output → tap → destination.
    const tap = new GainNode(off, { gain: 1 });
    bus.output.disconnect(off.destination);
    bus.output.connect(tap);
    tap.connect(off.destination);
    unitInto(off, bus);
    const data = (await off.startRendering()).getChannelData(0);
    for (const x of data.subarray(data.length - 128)) expect(x).toBeCloseTo(0.7 * QUIET, 6); // ≈ 0.350831
  });

  test('setQuiet ramps with τ = 20 ms', async () => {
    const off = offline();
    const bus = createMasterBus(off);
    unitInto(off, bus);
    let t0 = Number.NaN;
    const switched = off.suspend(0.1).then(() => {
      t0 = off.currentTime;
      bus.setQuiet(false);
      return off.resume();
    });
    const data = (await off.startRendering()).getChannelData(0);
    await switched;
    const at = Math.round(t0 * OFFLINE_RATE);
    expect(data[at - 1]).toBeCloseTo(0.7 * QUIET, 6);
    // One time constant later the gain has covered 1 − 1/e of the way from 10^(−6/20) to 1.
    expect(data[Math.round((t0 + 0.02) * OFFLINE_RATE)]).toBeCloseTo(
      0.7 * (1 - (1 - QUIET) * Math.exp(-1)),
      2,
    );
  });

  test('createMasterBus(ctx, false) starts with Quiet off', async () => {
    const off = offline();
    const bus = createMasterBus(off, false);
    unitInto(off, bus);
    const data = (await off.startRendering()).getChannelData(0);
    for (const x of data.subarray(0, 128)) expect(x).toBeCloseTo(0.7, 6);
  });
});

describe('player', () => {
  test("a 0.2 s buffer at rate 1.6 resolves 'ended' after it has left the speaker, < 1000 ms after play", async () => {
    const bus = createMasterBus(ctx);
    const player = createPlayer(ctx, bus.input);
    const buffer = silence(0.2);
    lastRead = undefined;
    const t0 = performance.now();
    const handle = player.play(buffer, 1.6);
    const result = await handle.done;
    const resolvedAt = performance.now();
    const atResolution = outputContextTimeAtResolution(lastRead, t0, resolvedAt);
    const fresh = freshReading();
    expect(result).toBe('ended');
    expect(handle.durationSec).toBeCloseTo(0.125, 12);
    expect(atResolution, fresh).toBeGreaterThanOrEqual(handle.startCtxTime + 0.125);
    expect(resolvedAt - t0).toBeLessThan(1000);
    bus.output.disconnect();
  });

  test("stop() right after play resolves 'stopped' within 100 ms", async () => {
    const bus = createMasterBus(ctx);
    const player = createPlayer(ctx, bus.input);
    const t0 = performance.now();
    const handle = player.play(silence(0.2), 1.6);
    player.stop();
    const result = await handle.done;
    expect(result).toBe('stopped');
    expect(performance.now() - t0).toBeLessThan(100);
    bus.output.disconnect();
  });

  test("play() stops the current clip first: its handle resolves 'stopped'", async () => {
    const bus = createMasterBus(ctx);
    const player = createPlayer(ctx, bus.input);
    const first = player.play(silence(0.2), 1.6);
    const second = player.play(silence(0.2), 1.6);
    expect(await first.done).toBe('stopped');
    player.stop();
    expect(await second.done).toBe('stopped');
    bus.output.disconnect();
  });
});

describe('sfx', () => {
  test('two beeps 50 ms apart, allEnded() called after the first: resolves once, after the later end', async () => {
    const bus = createMasterBus(ctx);
    const sfx = createSfx(ctx, bus.input, M1_SYNTHS);
    lastRead = undefined;
    const first = sfx.play('testBeep');
    let resolutions = 0;
    let resolvedAt = Number.NaN;
    let readAtResolution: TimestampRead | undefined;
    const all = sfx.allEnded().then(() => {
      resolutions++;
      resolvedAt = performance.now();
      readAtResolution = lastRead;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolutions).toBe(0); // the first beep is still playing
    lastRead = undefined;
    const t0 = performance.now();
    const second = sfx.play('testBeep');
    await all;
    const atResolution = outputContextTimeAtResolution(readAtResolution, t0, resolvedAt);
    const fresh = freshReading();
    expect(resolutions).toBe(1);
    expect(second.endCtxTime).toBeGreaterThan(first.endCtxTime);
    expect(atResolution, fresh).toBeGreaterThanOrEqual(second.endCtxTime);
    bus.output.disconnect();
  });

  test("stopAll() rejects a pending allEnded() with 'stopped'; a later allEnded() waits out the cut", async () => {
    const bus = createMasterBus(ctx);
    const sfx = createSfx(ctx, bus.input, M1_SYNTHS);
    sfx.play('testBeep');
    const pending = sfx.allEnded();
    const tCut = performance.now();
    sfx.stopAll();
    await expect(pending).rejects.toBe('stopped');
    await expect(sfx.allEnded()).resolves.toBeUndefined();
    // The cut counts as the sfx's end, so the minimum wait (≥ 50 ms) applies from it.
    expect(performance.now() - tCut).toBeGreaterThanOrEqual(50);
    bus.output.disconnect();
  });

  test('a synth that rings 8 ms past its returned duration is not cut to silence at that duration', async () => {
    const sampleRate = 48000;
    const off = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(0.2 * sampleRate),
      sampleRate,
    });
    let atDuration: Promise<void> = Promise.resolve();
    // Holds 0.5 from `when` to `when + 0.058` but reports 0.05; a silent probe ends at the reported end.
    const ringing: SfxSynth = (c, out, when) => {
      const tone = new ConstantSourceNode(c, { offset: 0.5 });
      tone.connect(out);
      tone.start(when);
      tone.stop(when + 0.058);
      const probe = new ConstantSourceNode(c, { offset: 0 });
      probe.connect(out);
      atDuration = new Promise((r) => probe.addEventListener('ended', () => r(), { once: true }));
      probe.start(when);
      probe.stop(when + 0.05);
      return 0.05;
    };
    // An offline context renders the graph; allEnded() is not used, so its output timestamp can be empty.
    // The never-resolving sleep keeps the ring-out disconnect out of this render.
    const offCtx = Object.assign(off, { getOutputTimestamp: () => ({}) });
    const sfx = createSfx(
      offCtx,
      off.destination,
      { ...M1_SYNTHS, testBeep: ringing },
      () => new Promise(() => {}),
    );
    const { endCtxTime } = sfx.play('testBeep'); // when 0.02, end 0.07
    // Pause at the first render-quantum boundary after the end, once the `ended` events have been handled.
    const pauseAt = ((Math.floor((endCtxTime * sampleRate) / 128) + 1) * 128) / sampleRate;
    const paused = off.suspend(pauseAt).then(async () => {
      await atDuration;
      await new Promise((r) => setTimeout(r, 0));
      await off.resume();
    });
    const data = (await off.startRendering()).getChannelData(0);
    await paused;
    const ringOut = data.subarray(
      Math.round(pauseAt * sampleRate),
      Math.round((endCtxTime + 0.007) * sampleRate),
    );
    expect(ringOut.length).toBeGreaterThan(0);
    for (const x of ringOut) expect(x).toBeCloseTo(0.5, 6);
  });

  test('testBeep: 880 Hz sine, 150 ms, 5 ms attack, 50 ms release, peak 0.25', async () => {
    const sampleRate = 48000;
    const off = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(0.2 * sampleRate),
      sampleRate,
    });
    expect(M1_SYNTHS.testBeep(off, off.destination, 0)).toBe(0.15);
    const data = (await off.startRendering()).getChannelData(0);
    const span = (from: number, to: number): Float32Array =>
      data.subarray(Math.round(from * sampleRate), Math.round(to * sampleRate));
    const peak = (from: number, to: number): number => {
      let p = 0;
      for (const x of span(from, to)) p = Math.max(p, Math.abs(x));
      return p;
    };
    expect(peak(0, 0.2)).toBeLessThanOrEqual(0.25 + 1e-6);
    expect(peak(0, 0.0025)).toBeLessThanOrEqual(0.125 + 1e-6); // half way up the linear attack
    expect(peak(0.004, 0.005)).toBeGreaterThan(0.19); // end of the 5 ms attack (0.2 → 0.25)
    expect(peak(0.005, 0.1)).toBeGreaterThan(0.249); // full level between attack and release
    expect(peak(0.1245, 0.1255)).toBeCloseTo(0.125, 2); // half way down the 50 ms linear release
    expect(peak(0.14, 0.15)).toBeLessThanOrEqual(0.05 + 1e-6); // last 10 ms of the release
    expect(peak(0.145, 0.148)).toBeGreaterThan(0.005); // the release reaches 0 only at 150 ms
    expect(peak(0.15, 0.2)).toBe(0); // silent after 150 ms
    let crossings = 0;
    let prev = Number.NaN;
    for (const x of span(0.01, 0.09)) {
      if ((prev < 0 && x >= 0) || (prev >= 0 && x < 0)) crossings++;
      prev = x;
    }
    // 80 ms of 880 Hz has 140.8 zero crossings.
    expect(Math.abs(crossings - 140.8)).toBeLessThanOrEqual(2);
  });
});
