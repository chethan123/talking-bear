/**
 * BearView in Vitest Browser Mode (issue #81): the canvas stage, the director fed by session `anim` events, the
 * mouth fed by the processed envelope, the frame loop (fixed step, idle and asleep throttling, hidden-page pause),
 * reduced motion, `showPose`, the M1 tap input, the frame stats with the debug overlay, and the allocation smoke.
 *
 * Every test drives the loop with a fake frame scheduler and a fake clock: `step(t)` runs the pending rAF
 * callbacks like one vsync at `t` ms, and the app clock (`now`) reads the same `t`. styles.css is not imported, so
 * the canvas keeps its intrinsic 300 × 150 CSS size unless a test adopts a sheet.
 */
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { FakeClock } from '../../test/fake-clock.ts';
import type { AnimEvent, SessionEvent, StateName } from '../app/events.ts';
import { AWAKE } from '../app/machine.ts';
import type { OutputClockCtx } from '../audio/output-clock.ts';
import type { Envelope } from '../dsp/types.ts';
import type { VisEvent } from '../platform/visibility.ts';
import { DEBUG_REFRESH_MS, formatFrameStats, mountDebugOverlay } from '../ui/debug-overlay.ts';
import {
  DOUBLE_TAP_MS,
  FRAME_LOG_SIZE,
  latencyFromQuery,
  mountBearView,
  REDUCED_MOTION_MIN_ZETA,
  REDUCED_MOTION_SCALE,
  type BearView,
  type BearViewDeps,
} from './bear-view.ts';
import { DISPLAY_LATENCY_MS } from './constants.ts';
import { EAR_SPRING, GAZE_SPRING } from './layers/index.ts';
import { envelopeIndex, mouthFromEnvelope } from './layers/mouth.ts';
import { ASLEEP_FPS, IDLE_FPS, STATS_FRAMES, type FrameStats } from './loop.ts';
import { Ch, createPose } from './pose.ts';
import { POSES } from './poses.ts';
import { createContext, fitView, MAX_DPR, render } from './renderer.ts';
import { createRig } from './rig.ts';
import { SpringBank } from './springs.ts';
import { configureSprings, SPRING, SPRING_COUNT, SPRING_PARAMS } from './springs-map.ts';

const DEG = Math.PI / 180;
/** One 60 Hz vsync, in ms. */
const VSYNC = 1000 / 60;

// The reduced-motion tests need a clip that writes `HeadRot` and the squash and wobble channels no session clip
// writes yet (M5's reaction clips will): give `confused` a HeadRot track (0 → 0.2 rad at 0.45 s → 0) and small
// HeadSquishX/Y, TuftRot and KerchiefA/B tracks on top of its own tracks.
vi.mock('./clips/session.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./clips/session.ts')>();
  const { Ch: channels } = await import('./pose.ts'); // vi.mock is hoisted above this file's imports
  const confused = mod.SESSION_CLIPS.confused;
  return {
    ...mod,
    SESSION_CLIPS: {
      ...mod.SESSION_CLIPS,
      confused: {
        ...confused,
        tracks: [
          ...confused.tracks,
          {
            ch: channels.HeadRot,
            keys: [
              { t: 0, v: 0 },
              { t: 0.45, v: 0.2 },
              { t: confused.duration, v: 0 },
            ],
          },
          ...(
            [
              [channels.HeadSquishX, 0.05],
              [channels.HeadSquishY, -0.05],
              [channels.TuftRot, 0.1],
              [channels.KerchiefA, 0.1],
              [channels.KerchiefB, -0.1],
            ] as const
          ).map(([ch, peak]) => ({
            ch,
            keys: [
              { t: 0, v: 0 },
              { t: 0.45, v: peak },
              { t: confused.duration, v: 0 },
            ],
          })),
        ],
      },
    },
  };
});

// ---- fakes -------------------------------------------------------------------------------------------------

/** A fake frame scheduler: `step(t)` runs the pending callbacks, like one vsync at time `t`. */
function fakeFrames(): {
  pending: Map<number, FrameRequestCallback>;
  request: (cb: FrameRequestCallback) => number;
  cancel: (id: number) => void;
  step: (t: number) => void;
} {
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  return {
    pending,
    request: (cb) => {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    cancel: (id) => {
      pending.delete(id);
    },
    step: (t) => {
      const due = Array.from(pending.values());
      pending.clear();
      for (const cb of due) cb(t);
    },
  };
}

/** A fake Visibility: `set(v)` changes current() and notifies like a real visibility change. */
function fakeVisibility(): { vis: BearViewDeps['visibility']; set: (v: 'visible' | 'hidden') => void } {
  let current: 'visible' | 'hidden' = 'visible';
  const subs = new Set<(e: VisEvent) => void>();
  return {
    vis: {
      current: () => current,
      subscribe: (cb) => {
        subs.add(cb);
        return () => {
          subs.delete(cb);
        };
      },
    },
    set: (v) => {
      current = v;
      for (const cb of subs) cb(v);
    },
  };
}

/**
 * An output clock whose last timestamp pairs context time `contextTime` with performance time `performanceTime`
 * (ms): at rAF time t the output is at contextTime + (t − performanceTime) / 1000. The timestamp object is
 * preallocated (a real context returns a new one per call).
 */
function fakeOutput(contextTime: number, performanceTime: number): OutputClockCtx {
  const ts = { contextTime, performanceTime };
  return { currentTime: contextTime, outputLatency: 0, getOutputTimestamp: () => ts };
}

/** An envelope of `n` 10 ms frames: jaw(i), width 0.25, round 0.5, teeth 0. */
function envelope(n: number, jaw: (i: number) => number): Envelope {
  const env: Envelope = {
    hopMs: 10,
    jaw: new Float32Array(n),
    width: new Float32Array(n).fill(0.25),
    round: new Float32Array(n).fill(0.5),
    teeth: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) env.jaw[i] = jaw(i);
  return env;
}

interface Harness {
  view: BearView;
  frames: ReturnType<typeof fakeFrames>;
  visibility: ReturnType<typeof fakeVisibility>;
  dispatch: Mock<(e: SessionEvent) => void>;
  /** The app clock, ms; `stepTo` moves it with the frames. */
  clock: { t: number };
  /** The session state the pointer input reads. */
  session: { state: StateName };
  /** Stored processed results by replay id, and the output clock (null: no context). */
  audio: { processed: Map<number, { envelope: Envelope }>; ctx: OutputClockCtx | null };
  /** Runs one vsync at `t` ms (the clock reads `t` too). */
  stepTo(t: number): void;
  /** Runs `n` vsyncs `period` ms apart after the clock's time; returns the last frame time. */
  run(n: number, period?: number): number;
  /** A session `anim` event at the clock's time. */
  anim(ev: AnimEvent): void;
}

const mounted: BearView[] = [];
let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  for (const v of mounted.splice(0)) v.dispose();
  root.remove();
  vi.restoreAllMocks();
});

function harness(over: Partial<BearViewDeps> = {}, start = 1000): Harness {
  const frames = fakeFrames();
  const visibility = fakeVisibility();
  const dispatch = vi.fn<(e: SessionEvent) => void>();
  const clock = { t: start };
  const session: { state: StateName } = { state: 'Asleep' };
  const audio: Harness['audio'] = { processed: new Map(), ctx: null };
  const view = mountBearView(root, {
    visibility: visibility.vis,
    now: () => clock.t,
    state: () => session.state,
    dispatch,
    engine: { getProcessed: (id) => audio.processed.get(id), context: () => audio.ctx },
    seed: 1234,
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    perfNow: () => 0,
    ...over,
  });
  mounted.push(view);
  const h: Harness = {
    view,
    frames,
    visibility,
    dispatch,
    clock,
    session,
    audio,
    stepTo(t) {
      clock.t = t;
      frames.step(t);
    },
    run(n, period = VSYNC) {
      for (let i = 0; i < n; i++) h.stepTo(clock.t + period);
      return clock.t;
    },
    anim(ev) {
      view.onAnim(ev);
    },
  };
  return h;
}

/** Wakes the director into Idle without the wake clip (as the session's `idle` does from Asleep). */
function toIdle(h: Harness): void {
  h.anim({ e: 'idle' });
}

/** Asleep → Idle → Attentive → Thinking. */
function toThinking(h: Harness): void {
  toIdle(h);
  h.anim({ e: 'attentive' });
  h.anim({ e: 'thinking' });
}

/** Drawn frames so far (the frame log grows by one per drawn frame until it is full). */
function drawnFrames(h: Harness): number {
  return h.view.frameLog().length;
}

// ---- canvas ------------------------------------------------------------------------------------------------

describe('the canvas stage', () => {
  test('mounts one canvas.stage, backing store = CSS size × min(devicePixelRatio, 2), and schedules one rAF', () => {
    const h = harness();
    expect(root.querySelectorAll('canvas.stage')).toHaveLength(1);
    const c = h.view.canvas;
    const dpr = Math.min(devicePixelRatio, MAX_DPR);
    expect(c.width).toBe(Math.round(c.clientWidth * dpr));
    expect(c.height).toBe(Math.round(c.clientHeight * dpr));
    expect(c.getContext('2d')?.getContextAttributes().alpha).toBe(false);
    expect(h.frames.pending.size).toBe(1);
    expect(root.querySelectorAll('[style]').length).toBe(0);
  });

  test('caps the backing-store scale at 2 and re-fits on resize', () => {
    // A CSS size, as styles.css gives the stage in the app (a constructed sheet: no style attribute).
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.stage { width: 200px; height: 100px; }');
    const before = [...document.adoptedStyleSheets];
    document.adoptedStyleSheets = [...before, sheet];
    try {
      const h = harness({ devicePixelRatio: () => 3 });
      expect([h.view.canvas.width, h.view.canvas.height]).toEqual([400, 200]);
      sheet.replaceSync('.stage { width: 300px; height: 120px; }');
      window.dispatchEvent(new Event('resize'));
      expect([h.view.canvas.width, h.view.canvas.height]).toEqual([600, 240]);
      expect(root.querySelectorAll('[style]').length).toBe(0);
    } finally {
      document.adoptedStyleSheets = before;
    }
  });

  test('dispose cancels the frame and removes the canvas', () => {
    const h = harness();
    h.view.dispose();
    mounted.splice(0);
    expect(h.frames.pending.size).toBe(0);
    expect(root.querySelector('canvas')).toBeNull();
  });
});

// ---- director ← session ---------------------------------------------------------------------------------

describe('the director is fed by the session anim events', () => {
  test('each anim event moves the director at the app clock time; ticks end the wake clip', () => {
    const h = harness();
    expect(h.view.director().name).toBe('Asleep');
    h.clock.t = 2000;
    h.anim({ e: 'wake' });
    expect(h.view.director()).toMatchObject({ name: 'Waking', since: 2, clip: { name: 'wake', start: 2 } });
    h.run(80); // 1.33 s: the 1.2 s wake clip has ended
    expect(h.view.director()).toMatchObject({ name: 'Idle', clip: null });
    for (const [ev, name] of [
      [{ e: 'attentive' }, 'Attentive'],
      [{ e: 'thinking' }, 'Thinking'],
      [{ e: 'talk', id: 4 }, 'Talking'],
      [{ e: 'talkEnd' }, 'Idle'],
      [{ e: 'doze' }, 'Dozing'],
      [{ e: 'sleep' }, 'Asleep'],
    ] as const) {
      h.run(1);
      h.anim(ev);
      expect(h.view.director().name, ev.e).toBe(name);
      expect(h.view.director().since, ev.e).toBe(h.clock.t / 1000);
    }
  });

  test('the director clock never steps back: an event dated before the last frame is dated at it', () => {
    const h = harness();
    h.stepTo(5000);
    h.clock.t = 4990; // the app clock behind the last rAF time
    h.anim({ e: 'idle' });
    expect(h.view.director().since).toBe(5);
  });

  test('the drawn pose is the director pose: Attentive leans the body 3°', () => {
    const h = harness();
    toIdle(h);
    h.anim({ e: 'attentive' });
    h.run(30);
    expect(h.view.pose()[Ch.BodyLean]).toBeCloseTo(3 * DEG, 6);
    expect(h.view.pose()[Ch.HeadTilt]).toBeCloseTo(8 * DEG, 2); // + the gaze head follow (≤ 0.036 rad), 0 before a saccade
  });
});

// ---- mouth ← processed envelope -------------------------------------------------------------------------

describe('the mouth is fed by the processed envelope', () => {
  const START = 50; // the replay's startCtxTime
  /** Output clock: context time 50 at performance time 10 000 ms, so clip time = (t − 10 000) / 1000. */
  const PERF0 = 10_000;
  const ramp = envelope(200, (i) => Math.min(1, i / 100));

  function talking(h: Harness, env: Envelope, order: 'startFirst' | 'talkFirst' = 'startFirst'): void {
    h.audio.ctx = fakeOutput(START, PERF0);
    h.audio.processed.set(7, { envelope: env });
    h.clock.t = PERF0 - 100;
    toThinking(h);
    if (order === 'startFirst') h.view.onPlayStarted(7, START);
    h.anim({ e: 'talk', id: 7 });
    if (order === 'talkFirst') h.view.onPlayStarted(7, START);
  }

  test('samples the envelope at clipTimeNow(rAF time) + L, and logs rafT, clipTime and envIndex', () => {
    const h = harness();
    talking(h, ramp);
    const pose = createPose();
    const before = drawnFrames(h);
    for (let k = 0; k < 60; k++) {
      const t = PERF0 + 3 + k * VSYNC;
      if (k === 30) {
        // The app clock runs 5 ms ahead of this frame's rAF time: the mouth samples at the rAF time (D6).
        h.clock.t = t + 5;
        h.frames.step(t);
      } else h.stepTo(t);
      const clipTime = (t - PERF0) / 1000 + DISPLAY_LATENCY_MS / 1000;
      mouthFromEnvelope(ramp, clipTime, pose);
      expect(h.view.pose()[Ch.Jaw], `frame ${k}`).toBeCloseTo(pose[Ch.Jaw]!, 6);
      expect(h.view.pose()[Ch.MouthW]).toBeCloseTo(0.25, 6);
      expect(h.view.pose()[Ch.MouthRound]).toBeCloseTo(0.5, 6);
      const last = h.view.frameLog().at(-1);
      expect(last?.rafT).toBe(t);
      expect(last?.clipTime).toBeCloseTo(clipTime, 9);
      expect(last?.envIndex).toBe(envelopeIndex(ramp, clipTime));
    }
    expect(drawnFrames(h) - before).toBe(60); // Talking: every rAF is drawn
  });

  test('works when the start is reported after the talk event', () => {
    const h = harness();
    talking(h, ramp, 'talkFirst');
    h.stepTo(PERF0 + 500);
    expect(h.view.pose()[Ch.Jaw]).toBeCloseTo(0.54, 5); // clip time 0.54 s: frame 54 of the ramp
  });

  test('the latencyMs option is L', () => {
    const h = harness({ latencyMs: 0 });
    talking(h, ramp);
    h.stepTo(PERF0 + 500);
    expect(h.view.frameLog().at(-1)?.clipTime).toBeCloseTo(0.5, 9);
    expect(h.view.pose()[Ch.Jaw]).toBeCloseTo(0.5, 5);
  });

  test('no mouth without a reported start, without a processed result or without a context', () => {
    for (const missing of ['start', 'processed', 'context'] as const) {
      const h = harness();
      h.audio.ctx = missing === 'context' ? null : fakeOutput(START, PERF0);
      if (missing !== 'processed') h.audio.processed.set(7, { envelope: ramp });
      h.clock.t = PERF0;
      toThinking(h);
      if (missing !== 'start') h.view.onPlayStarted(7, START);
      h.anim({ e: 'talk', id: 7 });
      h.stepTo(PERF0 + 500);
      expect(h.view.director().name, missing).toBe('Talking');
      expect(h.view.pose()[Ch.Jaw], missing).toBe(0);
      expect(h.view.frameLog().at(-1), missing).toMatchObject({ clipTime: null, envIndex: -1 });
      h.view.dispose();
      mounted.splice(0);
    }
  });

  test('a start for another replay is not used', () => {
    const h = harness();
    h.audio.ctx = fakeOutput(START, PERF0);
    h.audio.processed.set(7, { envelope: ramp });
    h.clock.t = PERF0;
    toThinking(h);
    h.audio.processed.set(6, { envelope: ramp });
    h.view.onPlayStarted(6, START);
    h.anim({ e: 'talk', id: 7 });
    h.stepTo(PERF0 + 500);
    expect(h.view.pose()[Ch.Jaw]).toBe(0);
  });

  test('talkEnd closes the mouth over 200 ms (× mouthCloseScale), then drops the envelope', () => {
    const h = harness({ latencyMs: 0 });
    talking(
      h,
      envelope(300, () => 0.8),
    );
    h.stepTo(PERF0 + 1000);
    expect(h.view.pose()[Ch.Jaw]).toBeCloseTo(0.8, 6);
    h.anim({ e: 'talkEnd' }); // at the clock's 11 000 ms
    h.stepTo(PERF0 + 1100);
    expect(h.view.pose()[Ch.Jaw]).toBeCloseTo(0.4, 5);
    expect(h.view.pose()[Ch.MouthRound]).toBeCloseTo(0.25, 5);
    expect(h.view.frameLog().at(-1)?.clipTime).toBeCloseTo(1.1, 9);
    h.stepTo(PERF0 + 1190);
    expect(h.view.pose()[Ch.Jaw]).toBeCloseTo(0.04, 5);
    h.stepTo(PERF0 + 1201); // 201 ms after talkEnd: shut, and the envelope is dropped
    expect(h.view.pose()[Ch.Jaw]).toBe(0);
    expect(h.view.frameLog().at(-1)).toMatchObject({ clipTime: null, envIndex: -1 });
    h.stepTo(PERF0 + 1220);
    expect(h.view.frameLog().at(-1)).toMatchObject({ clipTime: null, envIndex: -1 });
    expect(h.view.pose()[Ch.Jaw]).toBe(0);
  });
});

describe('the closing mouth after talkEnd', () => {
  test('keeps every rAF drawn while it closes, then Idle throttles to 30 fps again', () => {
    const PERF0 = 10_000;
    const h = harness({ latencyMs: 0 });
    h.audio.ctx = fakeOutput(50, PERF0);
    h.audio.processed.set(7, { envelope: envelope(300, () => 0.8) });
    h.clock.t = PERF0 - 100;
    toThinking(h);
    h.view.onPlayStarted(7, 50);
    h.anim({ e: 'talk', id: 7 });
    h.stepTo(PERF0 + 1000);
    h.anim({ e: 'talkEnd' }); // Idle; the base crossfade ends at +150 ms, the mouth closes by +200 ms
    const period = 1000 / 120;
    const drawn: boolean[] = [];
    for (let i = 1; i <= 72; i++) {
      const before = drawnFrames(h);
      h.stepTo(PERF0 + 1000 + i * period);
      drawn.push(drawnFrames(h) > before);
    }
    // +8.3 … +200 ms: every vsync drawn (after +150 ms only because the mouth is still closing).
    expect(drawn.slice(0, 24)).toEqual(Array.from({ length: 24 }, () => true));
    // +258 … +592 ms: 30 fps at 120 Hz.
    expect(drawn.slice(30, 70).filter(Boolean)).toHaveLength(10);
  });
});

describe('latencyFromQuery (?L=<ms>, X-A2)', () => {
  test('overrides DISPLAY_LATENCY_MS, clamped to 0–200; anything else keeps the default', () => {
    expect(latencyFromQuery('')).toBe(DISPLAY_LATENCY_MS);
    expect(latencyFromQuery('?debug=1')).toBe(DISPLAY_LATENCY_MS);
    expect(latencyFromQuery('?L=')).toBe(DISPLAY_LATENCY_MS);
    expect(latencyFromQuery('?L=abc')).toBe(DISPLAY_LATENCY_MS);
    expect(latencyFromQuery('?L=Infinity')).toBe(DISPLAY_LATENCY_MS);
    expect(latencyFromQuery('?L=0')).toBe(0);
    expect(latencyFromQuery('?L=55')).toBe(55);
    expect(latencyFromQuery('?debug=1&L=12.5')).toBe(12.5);
    expect(latencyFromQuery('?L=-5')).toBe(0);
    expect(latencyFromQuery('?L=250')).toBe(200);
  });
});

// ---- the frame loop -------------------------------------------------------------------------------------

describe('the frame loop', () => {
  test('Asleep with nothing moving draws at 15 fps on a 60 Hz display, dt-based', () => {
    const h = harness();
    h.run(30); // past the start-up crossfade
    const before = drawnFrames(h);
    h.run(120);
    expect(drawnFrames(h) - before).toBe((120 * ASLEEP_FPS) / 60);
    const log = h.view.frameLog();
    expect(log.at(-1)!.rafT - log.at(-2)!.rafT).toBeCloseTo(4 * VSYNC, 6);
  });

  test('Idle with nothing moving but breathing and blinks draws at 30 fps; at 120 Hz too', () => {
    const h = harness();
    toIdle(h);
    h.run(18); // 0.3 s: the crossfade and the weight ramp are over, the first saccade is ≥ 1.5 s away
    let before = drawnFrames(h);
    h.run(30);
    expect(drawnFrames(h) - before).toBe((30 * IDLE_FPS) / 60);
    before = drawnFrames(h);
    h.run(60, 1000 / 120);
    expect(drawnFrames(h) - before).toBe((60 * IDLE_FPS) / 120);
  });

  test('Dozing with nothing moving draws at 30 fps', () => {
    const h = harness();
    toIdle(h);
    h.anim({ e: 'doze' });
    h.run(18); // 0.3 s: crossfade and weight ramp over
    expect(h.view.director().name).toBe('Dozing');
    const before = drawnFrames(h);
    h.run(30);
    expect(drawnFrames(h) - before).toBe((30 * IDLE_FPS) / 60);
  });

  test('a moving spring draws every rAF: the head follow after the first saccade, then 30 fps once it settles', () => {
    const h = harness(); // seed 1234
    toIdle(h);
    h.run(18);
    // One flag per vsync for 5.5 s: drawn or not. The first saccade comes 1.5–4 s after Idle and the next ≥ 1.5 s
    // after it; the first ear twitch 6–15 s after Idle. So the only spring that moves here is the gaze's head
    // follow, after the first saccade.
    const VSYNCS = 330;
    const QUIET = 90; // 1.5 s: no second saccade before start + QUIET
    const drawn: boolean[] = [];
    const headRot: number[] = [];
    for (let i = 0; i < VSYNCS; i++) {
      const before = drawnFrames(h);
      h.run(1);
      drawn.push(drawnFrames(h) > before);
      headRot.push(h.view.pose()[Ch.HeadRot]!);
    }
    // At rest every other vsync is drawn, so two drawn in a row mean something moves.
    const moving = (i: number): boolean => i > 0 && drawn[i]! && drawn[i - 1]!;
    const start = drawn.findIndex((_, i) => moving(i));
    expect(start, 'frames drawn every rAF after the first saccade').toBeGreaterThan(0);
    expect((18 + start) * VSYNC, 'they start ≥ 1.5 s after Idle').toBeGreaterThanOrEqual(1500 - VSYNC);
    expect(start + QUIET, 'the window covers the settle').toBeLessThanOrEqual(VSYNCS);
    let last = start;
    for (let i = start; i < start + QUIET; i++) if (moving(i)) last = i;
    expect(last - start, 'the head follow moves for several frames').toBeGreaterThan(10);
    expect(Math.abs(headRot[last]! - headRot[start - 1]!), 'the head turned').toBeGreaterThan(1e-4);
    // Settled (every |v| ≤ 1e-3): back to every other vsync until the next saccade.
    const after = drawn.slice(last + 1, last + 31);
    expect(last + 31, 'the settled stretch is inside the quiet window').toBeLessThanOrEqual(start + QUIET);
    expect(after.filter(Boolean)).toHaveLength(15);
  });

  test('Dozing runs no gaze (D5): no saccade moves the iris or the head, while Idle at the same seed does', () => {
    const idle = harness(); // seed 1234
    const dozing = harness();
    toIdle(idle);
    toIdle(dozing);
    dozing.anim({ e: 'doze' });
    let idleIris = 0;
    let dozingGaze = 0;
    for (let i = 0; i < 300; i++) {
      // 5 s: the first saccade is due 1.5–4 s after the gaze starts
      idle.run(1);
      dozing.run(1);
      const p = idle.view.pose();
      const q = dozing.view.pose();
      idleIris = Math.max(idleIris, Math.abs(p[Ch.IrisX]!) + Math.abs(p[Ch.IrisY]!));
      dozingGaze = Math.max(
        dozingGaze,
        Math.abs(q[Ch.IrisX]!),
        Math.abs(q[Ch.IrisY]!),
        Math.abs(q[Ch.HeadRot]!),
      );
    }
    expect(dozing.view.director().name).toBe('Dozing');
    expect(idleIris, 'Idle looks around within 5 s').toBeGreaterThan(0.1);
    expect(dozingGaze, 'Dozing: iris and head follow stay at 0').toBe(0);
    expect(dozing.view.pose()[Ch.HeadTilt]).toBeCloseTo(-3 * DEG, 6); // the dozing base, no head follow
  });

  test('a throttled frame loses no animation time: Asleep at 15 fps breathes exactly like Asleep drawn every rAF', () => {
    const throttled = harness();
    const every = harness();
    const vsync = (): void => {
      throttled.run(1);
      every.run(1);
      every.anim({ e: 'doze' }); // ignored while Asleep, but the next rAF is drawn
    };
    for (let i = 0; i < 600; i++) vsync(); // 10 s at 60 Hz
    let before = drawnFrames(throttled);
    for (let i = 0; i < 120; i++) vsync();
    expect(drawnFrames(throttled) - before, 'the throttled view draws at 15 fps').toBe(30);
    // End on a frame the throttled view draws, so both poses are of the same rAF time.
    before = drawnFrames(throttled);
    while (drawnFrames(throttled) === before) vsync();
    expect(every.view.director().name).toBe('Asleep');
    for (const ch of [Ch.BellyJiggle, Ch.BodySquash]) {
      expect(Math.abs(throttled.view.pose()[ch]! - every.view.pose()[ch]!), `channel ${ch}`).toBeLessThan(
        1e-4,
      );
    }
  });

  test('a saccade that starts in a frame’s last substep draws every rAF until the iris settles (D17)', () => {
    // 120 Hz vsyncs, so a frame drawn right after the previous one runs exactly one substep.
    const PERIOD = 1000 / 120;
    // Probe (same seed): force every vsync and find the first frame whose pose shows the iris move. The drawn
    // layers lag one substep (alpha ≈ 0 at one substep per frame), so the saccade ran in the frame before it.
    const probe = harness(); // seed 1234
    toIdle(probe);
    let shown = -1;
    for (let i = 1; i <= 600 && shown < 0; i++) {
      probe.run(1, PERIOD);
      probe.anim({ e: 'idle' }); // ignored in Idle, but the next rAF is drawn
      if (Math.abs(probe.view.pose()[Ch.IrisX]!) + Math.abs(probe.view.pose()[Ch.IrisY]!) > 1e-6) shown = i;
    }
    expect(shown, 'a saccade within 5 s').toBeGreaterThan(1);
    const saccade = shown - 1;
    // The view under test replays the probe's frames up to the saccade's frame, whose only (so last) substep
    // steps the springs before the gaze retargets them: every spring velocity is still 0 after it.
    const h = harness();
    toIdle(h);
    for (let i = 1; i <= saccade; i++) {
      h.run(1, PERIOD);
      if (i < saccade) h.anim({ e: 'idle' });
    }
    const drawn: boolean[] = [];
    for (let i = 0; i < 168; i++) {
      // 1.4 s: the next saccade is ≥ 1.5 s after this one
      const before = drawnFrames(h);
      h.run(1, PERIOD);
      drawn.push(drawnFrames(h) > before);
    }
    expect(drawn.slice(0, 4), 'every rAF right after the saccade').toEqual([true, true, true, true]);
    let last = 0;
    for (let i = 1; i < drawn.length; i++) if (drawn[i] && drawn[i - 1]) last = i;
    expect(last + 41, 'it settles well before the next saccade').toBeLessThanOrEqual(drawn.length);
    expect(drawn.slice(last + 1, last + 41).filter(Boolean), 'then 30 fps again').toHaveLength(10);
  });

  test('a moving state draws every rAF: the base crossfade, a clip, Attentive', () => {
    const h = harness();
    h.run(30);
    let before = drawnFrames(h);
    toIdle(h); // starts the 150 ms crossfade asleep → idle
    h.run(8);
    expect(drawnFrames(h) - before).toBe(8);
    h.run(30);
    before = drawnFrames(h);
    h.anim({ e: 'earTwitch' }); // a 0.35 s clip
    h.run(20);
    expect(drawnFrames(h) - before).toBe(20);
    h.anim({ e: 'attentive' });
    h.run(30);
    before = drawnFrames(h);
    h.run(60);
    expect(drawnFrames(h) - before).toBe(60);
  });

  test('an event draws at the next rAF whatever the throttle', () => {
    const h = harness();
    h.run(30);
    let before = drawnFrames(h);
    while (drawnFrames(h) === before) h.run(1); // just after a drawn frame: the next 3 are throttled
    before = drawnFrames(h);
    h.run(1);
    expect(drawnFrames(h)).toBe(before);
    h.anim({ e: 'doze' }); // ignored while Asleep: the scene still counts as at rest
    expect(h.view.director().name).toBe('Asleep');
    h.run(1);
    expect(drawnFrames(h)).toBe(before + 1);
    h.run(1);
    expect(drawnFrames(h)).toBe(before + 1);
  });

  test('stops scheduling while hidden; the first frame after visible has dt = 0', () => {
    const h = harness();
    toIdle(h);
    h.run(30);
    h.visibility.set('hidden');
    expect(h.frames.pending.size).toBe(0);
    const before = drawnFrames(h);
    const pose = Float32Array.from(h.view.pose());
    h.clock.t += 10_000;
    h.frames.step(h.clock.t); // nothing pending: nothing runs
    expect(drawnFrames(h)).toBe(before);
    h.visibility.set('visible');
    expect(h.frames.pending.size).toBe(1);
    h.run(1);
    expect(drawnFrames(h)).toBe(before + 1);
    // No substep ran: the layers are where they were. The director pose (idle base) hasn't changed either.
    expect(Array.from(h.view.pose())).toEqual(Array.from(pose));
  });

  test('the fixed step runs ≤ 6 substeps per frame: a 1 s frame advances the layers by 50 ms', () => {
    const a = harness();
    const b = harness();
    for (const h of [a, b]) {
      toIdle(h);
      h.anim({ e: 'attentive' }); // every frame drawn
      h.run(30, 1000 / 120); // one substep per frame: no remainder
    }
    a.run(1, 1000); // clamped to 50 ms: 6 substeps
    b.run(6, 1000 / 120); // 6 substeps
    // The same layer time and the same director pose (Attentive, crossfade over): the same breathing.
    for (const ch of [Ch.BellyJiggle, Ch.BodySquash]) {
      expect(a.view.pose()[ch]).toBeCloseTo(b.view.pose()[ch]!, 6);
    }
    // Without the clamp, a's breathing would be 1 s (a quarter cycle) ahead.
    expect(a.view.pose()[Ch.BellyJiggle]).not.toBe(0);
  });
});

// ---- reduced motion -------------------------------------------------------------------------------------

describe('reduced motion', () => {
  test('scales BodySquash, BodyLean, HeadSquish*, TuftRot, Kerchief* × 0.3; keeps blinks, gaze and mouth', () => {
    const a = harness();
    const b = harness();
    b.view.setReducedMotion(true);
    expect(b.view.reducedMotion).toBe(true);
    for (const h of [a, b]) {
      toIdle(h);
      h.anim({ e: 'attentive' });
      h.run(400); // 6.7 s: saccades, blinks and breathing
      h.anim({ e: 'confused' }); // this file's mock: squish, tuft and kerchief tracks peak at 0.45 s
      h.run(27);
    }
    expect(REDUCED_MOTION_SCALE).toBe(0.3);
    const pa = a.view.pose();
    const pb = b.view.pose();
    // Attentive's 3° lean (no clip or layer writes BodyLean) is 0.9° in reduced motion.
    expect(pa[Ch.BodyLean]).toBeCloseTo(3 * DEG, 6);
    expect(pb[Ch.BodyLean]).toBeCloseTo(0.9 * DEG, 6);
    for (const ch of [
      Ch.BodySquash,
      Ch.BodyLean,
      Ch.HeadSquishX,
      Ch.HeadSquishY,
      Ch.TuftRot,
      Ch.KerchiefA,
      Ch.KerchiefB,
    ]) {
      expect(Math.abs(pa[ch]!), `channel ${ch} moves in the plain view`).toBeGreaterThan(1e-3);
      expect(pb[ch], `channel ${ch}`).toBeCloseTo(pa[ch]! * REDUCED_MOTION_SCALE, 7);
    }
    for (const ch of [Ch.LidL, Ch.LidR, Ch.IrisX, Ch.IrisY, Ch.Jaw, Ch.BellyJiggle, Ch.BrowL]) {
      expect(pb[ch], `channel ${ch}`).toBe(pa[ch]);
    }
  });

  test("scales the clip's part of HeadRot only, not the base's", () => {
    const a = harness();
    const b = harness();
    b.view.setReducedMotion(true);
    for (const h of [a, b]) {
      toThinking(h); // base HeadRot 4°
      h.run(12); // 0.2 s: crossfade over; the gaze's first saccade is ≥ 1.5 s away, its springs rest at 0
      h.anim({ e: 'confused' }); // HeadRot +0.2 rad at 0.45 s (this file's mock)
      h.run(27); // 0.45 s
    }
    expect(a.view.pose()[Ch.HeadRot]).toBeCloseTo(4 * DEG + 0.2, 5);
    expect(b.view.pose()[Ch.HeadRot]).toBeCloseTo(4 * DEG + 0.2 * REDUCED_MOTION_SCALE, 5);
  });

  test('forces every spring ζ ≥ 0.9, and restores the layer constants when off', () => {
    const h = harness();
    const set = vi.spyOn(SpringBank.prototype, 'set');
    h.view.setReducedMotion(true);
    expect(set.mock.calls).toEqual(
      SPRING_PARAMS.map((p, i) => [i, p.freqHz, Math.max(p.zeta, REDUCED_MOTION_MIN_ZETA)]),
    );
    expect(set.mock.calls.every(([, , zeta]) => zeta >= 0.9)).toBe(true);
    set.mockClear();
    h.view.setReducedMotion(false);
    expect(set.mock.calls).toEqual(SPRING_PARAMS.map((p, i) => [i, p.freqHz, p.zeta]));
  });
});

describe('springs-map', () => {
  test('one distinct index per spring, the count, and the layers’ constants', () => {
    const indices = Object.values(SPRING);
    expect(new Set(indices).size).toBe(indices.length);
    expect(indices.toSorted((x, y) => x - y)).toEqual(Array.from({ length: SPRING_COUNT }, (_, i) => i));
    expect(SPRING_COUNT).toBe(Object.keys(SPRING).length);
    expect(SPRING_PARAMS[SPRING.headRot]).toBe(GAZE_SPRING);
    expect(SPRING_PARAMS[SPRING.headTilt]).toBe(GAZE_SPRING);
    expect(SPRING_PARAMS[SPRING.earL]).toBe(EAR_SPRING);
    expect(SPRING_PARAMS[SPRING.earR]).toBe(EAR_SPRING);
    const bank = new SpringBank(SPRING_COUNT);
    const set = vi.spyOn(bank, 'set');
    configureSprings(bank);
    expect(set.mock.calls).toEqual([
      [0, 2, 0.8],
      [1, 2, 0.8],
      [2, 6, 0.35],
      [3, 6, 0.35],
      [4, 4, 0.25],
      [5, 5, 0.3],
      [6, 2.5, 0.2],
      [7, 2.8, 0.2],
      [8, 3, 0.3],
      [9, 6, 0.4],
    ]);
  });
});

// ---- showPose ---------------------------------------------------------------------------------------------

describe('showPose (e2e screenshots)', () => {
  test('stops the loop and renders the pose once at 500 × 700, DPR 1, scale 0.5, with no style attribute', () => {
    const h = harness({ devicePixelRatio: () => 2 });
    h.run(10);
    h.view.showPose(POSES.talkOpen, 500, 700);
    const c = h.view.canvas;
    expect(c.classList.contains('stage--fixed')).toBe(true);
    expect(c.hasAttribute('style')).toBe(false);
    expect([c.width, c.height]).toEqual([500, 700]);
    expect(h.frames.pending.size).toBe(0);

    // The same pixels as the renderer drawing the pose directly at the fitted view (#75's screenshot setup).
    const ref = document.createElement('canvas');
    ref.width = 500;
    ref.height = 700;
    const g = createContext(ref);
    const view = fitView(500, 700, { scale: 0, ox: 0, oy: 0 });
    expect(view).toEqual({ scale: 0.5, ox: 0, oy: 0 });
    render(g, createRig(), POSES.talkOpen, view);
    const want = g.getImageData(0, 0, 500, 700).data;
    const differing = (): number => {
      const got = h.view.canvas.getContext('2d')!.getImageData(0, 0, 500, 700).data;
      expect(got.length).toBe(want.length);
      let diff = 0;
      for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) diff++;
      return diff;
    };
    expect(differing()).toBe(0);

    // Nothing redraws it: no frame, no event, no resize.
    const before = drawnFrames(h);
    h.anim({ e: 'wake' });
    h.run(10);
    window.dispatchEvent(new Event('resize'));
    expect(drawnFrames(h)).toBe(before);
    expect([c.width, c.height]).toEqual([500, 700]);
    expect(differing()).toBe(0);
  });
});

// ---- input ------------------------------------------------------------------------------------------------

describe('pointer input (the M1 tap behaviour)', () => {
  test('tapBear when Asleep or Error, poke / poke2 when awake, nothing otherwise', () => {
    const h = harness();
    const down = (t: number, x: number, y: number): void => {
      h.clock.t = t;
      h.view.canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }));
    };
    const poke: SessionEvent = { t: 'reaction', name: 'poke', priority: 2, sfx: 'testBeep' };
    const poke2: SessionEvent = { t: 'reaction', name: 'poke2', priority: 3, sfx: 'testBeep' };

    for (const s of ['Asleep', 'Error'] as const) {
      h.session.state = s;
      h.dispatch.mockClear();
      down(0, 10, 10);
      down(100, 10, 10);
      expect(h.dispatch.mock.calls, s).toEqual([[{ t: 'tapBear' }], [{ t: 'tapBear' }]]);
    }
    for (const s of ['NeedsParent', 'Paused'] as const) {
      h.session.state = s;
      h.dispatch.mockClear();
      down(0, 10, 10);
      expect(h.dispatch, s).not.toHaveBeenCalled();
    }
    expect(AWAKE.size).toBe(8);
    let t = 10_000;
    for (const s of AWAKE) {
      h.session.state = s;
      h.dispatch.mockClear();
      down((t += 1000), 10, 10);
      expect(h.dispatch.mock.calls, s).toEqual([[poke]]);
    }

    h.session.state = 'Listening';
    const taps: [number, number, number, SessionEvent][] = [
      [100_000, 10, 10, poke],
      [100_200, 70, 70, poke2], // 200 ms, 84.9 px
      [100_300, 70, 70, poke], // the pair was complete
      [100_650, 70, 70, poke], // 350 ms later
      [100_700, 200, 70, poke], // 130 px away
      [101_001, 200, 70, poke], // 301 ms later
      [101_100, 200, 70, poke2],
      [102_000, 0, 0, poke],
      [102_000 + DOUBLE_TAP_MS, 100, 0, poke2], // exactly 300 ms and 100 px
    ];
    h.dispatch.mockClear();
    for (const [time, x, y] of taps) down(time, x, y);
    expect(h.dispatch.mock.calls).toEqual(taps.map(([, , , e]) => [e]));
  });
});

// ---- stats and the debug overlay --------------------------------------------------------------------------

describe('frame stats and the debug overlay', () => {
  test('p95 of the main-thread time per drawn frame and the fps, over the last 120 drawn frames', () => {
    // Frame k (1-based) takes k ms: perfNow() is read at its start and end.
    let reads = 0;
    let frame = 0;
    const h = harness({
      perfNow: () => {
        reads++;
        if (reads % 2 === 1) {
          frame++;
          return 0;
        }
        return frame;
      },
    });
    expect(h.view.frameStats()).toEqual({ p95Ms: Number.NaN, fps: Number.NaN, frames: 0 });
    toIdle(h);
    h.anim({ e: 'attentive' }); // every rAF drawn
    h.run(150);
    // The last 120 frames took 31 … 150 ms: the nearest-rank p95 is the 114th smallest, 144 ms.
    expect(h.view.frameStats()).toEqual({ p95Ms: 144, fps: expect.closeTo(60, 6), frames: STATS_FRAMES });
  });

  test('formatFrameStats', () => {
    expect(formatFrameStats({ p95Ms: 1.84, fps: 59.6, frames: 120 })).toBe('frame p95 1.8 ms · 60 fps');
    expect(formatFrameStats({ p95Ms: Number.NaN, fps: Number.NaN, frames: 0 })).toBe(
      'frame p95 – ms · – fps',
    );
  });

  test('the overlay shows the stats, refreshes every 250 ms, sets no style attribute and unmounts', () => {
    const clock = new FakeClock();
    let stats: FrameStats = { p95Ms: 2.25, fps: 30, frames: 50 };
    const overlay = mountDebugOverlay(root, {
      frameStats: (out) => Object.assign(out, stats),
      clock,
    });
    const box = root.querySelector('.debug-overlay');
    expect(box?.textContent).toBe('frame p95 2.3 ms · 30 fps');
    stats = { p95Ms: 3, fps: 60, frames: 120 };
    clock.advance(DEBUG_REFRESH_MS - 1);
    expect(box?.textContent).toBe('frame p95 2.3 ms · 30 fps');
    clock.advance(1);
    expect(box?.textContent).toBe('frame p95 3.0 ms · 60 fps');
    expect(root.querySelectorAll('[style]').length).toBe(0);
    overlay.dispose();
    expect(root.querySelector('.debug-overlay')).toBeNull();
    expect(clock.pending()).toBe(0);
  });
});

// ---- allocation smoke -------------------------------------------------------------------------------------

/** `performance.memory.usedJSHeapSize` (Chromium; precise with --enable-precise-memory-info). */
function usedJSHeapSize(): number {
  const memory: unknown = Reflect.get(performance, 'memory');
  const bytes: unknown =
    typeof memory === 'object' && memory !== null ? Reflect.get(memory, 'usedJSHeapSize') : undefined;
  if (typeof bytes !== 'number') throw new Error('no performance.memory.usedJSHeapSize');
  return bytes;
}

describe('allocation smoke', () => {
  test('600 frames with a fake clock grow usedJSHeapSize by < 2 MB after a forced GC', () => {
    const gc: unknown = Reflect.get(globalThis, 'gc');
    if (typeof gc !== 'function')
      throw new Error('needs Chromium with --js-flags=--expose-gc (vitest.config.ts)');
    const FRAMES = 600;
    const BOUND = 2 * 1024 * 1024;
    const h = harness({}, 0);
    // A talking bear, the busiest frame: director clip, every layer, the mouth on a live envelope.
    h.audio.ctx = fakeOutput(0, 0);
    h.audio.processed.set(1, { envelope: envelope(100_000, (i) => 0.5 + 0.5 * Math.sin(i / 7)) });
    toThinking(h);
    h.view.onPlayStarted(1, 0);
    h.anim({ e: 'talk', id: 1 });
    h.anim({ e: 'earTwitch' });
    const measure = (extra: (k: number) => void): number => {
      gc();
      const before = usedJSHeapSize();
      for (let k = 0; k < FRAMES; k++) {
        h.stepTo(h.clock.t + VSYNC);
        extra(k);
      }
      gc();
      return usedJSHeapSize() - before;
    };
    // Warm-up: let V8 optimise the frame (its interpreter boxes doubles), and fill the frame log ring.
    for (let i = 0; i < 5; i++) measure(() => undefined);
    expect(h.view.director().name).toBe('Talking');
    expect(h.view.frameLog()).toHaveLength(FRAME_LOG_SIZE);
    const growth = measure(() => undefined);
    expect(h.view.frameLog().at(-1)?.envIndex).toBeGreaterThan(0);
    expect(growth, `heap growth over ${FRAMES} frames: ${growth} B`).toBeLessThan(BOUND);
    // Positive control: 4 KB kept per frame is seen.
    const kept: Float64Array[] = [];
    const leak = measure(() => {
      kept.push(new Float64Array(512));
    });
    expect(kept).toHaveLength(FRAMES);
    expect(leak).toBeGreaterThanOrEqual(BOUND);
  });
});
