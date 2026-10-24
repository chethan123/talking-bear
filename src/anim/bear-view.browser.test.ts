/**
 * BearView in Vitest Browser Mode (issue #81): the canvas stage, the director fed by session `anim` events, the
 * mouth fed by the processed envelope, the frame loop (fixed step, idle and asleep throttling, hidden-page pause),
 * reduced motion, the reaction clips in the frame (#221: spring kicks, secondary springs, the clip's mouth),
 * `showPose`, the pointer input and its reactions (#93), the frame stats with the debug overlay, and the allocation
 * smoke.
 *
 * Every test drives the loop with a fake frame scheduler and a fake clock: `step(t)` runs the pending rAF
 * callbacks like one vsync at `t` ms, and the app clock (`now`) reads the same `t`. styles.css is not imported, so
 * the canvas keeps its intrinsic 300 × 150 CSS size unless a test adopts a sheet.
 */
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { FakeClock } from '../../test/fake-clock.ts';
import type { AnimEvent, SessionEvent, SfxId, StateName } from '../app/events.ts';
import { AWAKE, TOO_LOUD_REACTION } from '../app/machine.ts';
import type { OutputClockCtx } from '../audio/output-clock.ts';
import type { Envelope } from '../dsp/types.ts';
import type { Gesture } from '../input/recognizer.ts';
import type { RegionId } from '../input/region-ids.ts';
import { compileRegions, hitTest } from '../input/regions.ts';
import type { VisEvent } from '../platform/visibility.ts';
import { DEBUG_REFRESH_MS, formatFrameStats, mountDebugOverlay } from '../ui/debug-overlay.ts';
import {
  FRAME_LOG_SIZE,
  latencyFromQuery,
  LOOK_HOLD_S,
  MIC_DENIED_MIME,
  MIC_DENIED_MIME_S,
  mountBearView,
  REDUCED_MOTION_MIN_ZETA,
  REDUCED_MOTION_SCALE,
  TOO_LOUD_CLIP,
  type BearView,
  type BearViewDeps,
} from './bear-view.ts';
import { sampleClip } from './clip.ts';
import type { Clip } from './clip.ts';
import { MIME_CLIPS, REACTION_CLIPS } from './clips/reactions.ts';
import { SESSION_CLIPS } from './clips/session.ts';
import { DISPLAY_LATENCY_MS } from './constants.ts';
import { evaluate } from './director.ts';
import { EAR_SPRING, GAZE_SPRING } from './layers/index.ts';
import { envelopeIndex, mouthFromEnvelope } from './layers/mouth.ts';
import { ASLEEP_FPS, IDLE_FPS, STATS_FRAMES, type FrameStats } from './loop.ts';
import { Ch, createPose } from './pose.ts';
import { POSES } from './poses.ts';
import { createContext, fitView, MAX_DPR, render } from './renderer.ts';
import { boneIndex, boneMatrices, createRig, MAT } from './rig.ts';
import { SpringBank } from './springs.ts';
import { MAX_FRAME_DT, Stepper } from './stepper.ts';
import { configureSprings, SPRING, SPRING_COUNT, SPRING_PARAMS } from './springs-map.ts';
import { FENN } from '../characters/fenn.ts';
import { JUNI } from '../characters/juni.ts';

/** Juni's rig without paths, for bone and part indices (call-site edit for T121's `createRig(spec)`). */
const JUNI_RIG = createRig(JUNI, { paths: false });
const JUNI_REGIONS = compileRegions(JUNI_RIG);
/** Juni's hit regions, priority order (they moved from `regions.ts` to `JUNI.regions`). */
const REGIONS = JUNI.regions;

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
    character: JUNI,
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

/**
 * The only inline style under `root` is the pointer adapter's hygiene on the stage canvas (#87, set through CSSOM,
 * which CSP `style-src 'self'` doesn't govern): exactly `touch-action` and `user-select`, both `none`.
 */
function expectOnlyAdapterStyles(canvas: HTMLCanvasElement): void {
  expect(Array.from(canvas.style).toSorted()).toEqual(['touch-action', 'user-select']);
  expect(canvas.style.getPropertyValue('touch-action')).toBe('none');
  expect(canvas.style.getPropertyValue('user-select')).toBe('none');
  expect(Array.from(root.querySelectorAll('[style]'))).toEqual([canvas]);
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
    expectOnlyAdapterStyles(c);
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
      expectOnlyAdapterStyles(h.view.canvas);
    } finally {
      document.adoptedStyleSheets = before;
    }
  });

  test('the canvas is role=img named "Juni the bear" (#118)', () => {
    const h = harness();
    expect(h.view.canvas.getAttribute('role')).toBe('img');
    expect(h.view.canvas.getAttribute('aria-label')).toBe('Juni the bear');
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

// ---- reaction clips in the frame (#221) -----------------------------------------------------------------------

/** `n` vsyncs `period` ms apart on both views; each must draw every one; then `onFrame(k)`. */
function runBoth(a: Harness, b: Harness, n: number, period: number, onFrame: (k: number) => void): void {
  for (let k = 0; k < n; k++) {
    const na = drawnFrames(a);
    const nb = drawnFrames(b);
    a.run(1, period);
    b.run(1, period);
    expect(drawnFrames(a) - na, `frame ${k}: the view drew`).toBe(1);
    expect(drawnFrames(b) - nb, `frame ${k}: the control drew`).toBe(1);
    onFrame(k);
  }
}

/** The reaction's part of channel `ch`: view `a`'s pose minus the control `b`'s. */
function delta(a: Harness, b: Harness, ch: number): number {
  return a.view.pose()[ch]! - b.view.pose()[ch]!;
}

/** Peak |position| of `spring` after `clip`'s kicks on it, at the app's 1/120 s substep, every ζ ≥ `minZeta`. */
function simPeak(clip: Clip, spring: number, minZeta: number): number {
  const bank = new SpringBank(SPRING_COUNT);
  configureSprings(bank, minZeta);
  const kicks = (clip.impulses ?? []).filter((imp) => imp.spring === spring);
  let peak = 0;
  for (let n = 0; n < 240; n++) {
    for (const imp of kicks) if (imp.t >= n / 120 && imp.t < (n + 1) / 120) bank.impulse(spring, imp.dv);
    bank.step(1 / 120);
    peak = Math.max(peak, Math.abs(bank.pos[spring]!));
  }
  return peak;
}

describe('reaction clips in the frame (#221)', () => {
  /** 120 Hz vsyncs: one substep per frame, so the frames read every substep's spring position. */
  const P120 = 1000 / 120;
  const FLICK: Gesture = { g: 'flick', region: 'headTop', vx: 900, vy: 0 };
  const TUFT_TAP: Gesture = { g: 'tap', phase: 'down', region: 'headTop', x: 0, y: 0, count: 1 };
  const BELLY_TAP: Gesture = { g: 'tap', phase: 'down', region: 'belly', x: 0, y: 0, count: 1 };
  const KERCHIEF_TAP: Gesture = { g: 'tap', phase: 'down', region: 'neckerchief', x: 0, y: 0, count: 1 };
  const TICKLE: Gesture = { g: 'tickle', region: 'belly' };
  const PINCH: Gesture = { g: 'pinch', regions: ['cheekL', 'cheekR'], spanRatio: 0.8 };
  const ALL_OVER: Gesture = { g: 'allOver' };
  const MOUTH: readonly number[] = [Ch.Jaw, Ch.MouthW, Ch.MouthRound, Ch.Teeth];
  /** Scratch poses for the clip, envelope and director samples. */
  const sample = createPose();
  const expected = createPose();

  /**
   * Two awake views at the same seed, both in Attentive (every frame drawn) and past its 150 ms base fade, so that
   * they draw the same frames and differ only by what a test does to the first.
   */
  function pair(): [Harness, Harness] {
    const a = awake();
    const b = awake();
    for (const h of [a, b]) {
      h.anim({ e: 'attentive' });
      h.run(30, P120);
    }
    return [a, b];
  }

  /** For 0.8 s at 60 Hz after a belly tickle: the giggle's Jaw track is the pose's Jaw, the rest of the mouth 0. */
  function expectGiggleJaw(h: Harness): void {
    h.view.gesture(TICKLE);
    expect(h.view.director().clip?.name).toBe('giggle');
    const start = h.view.director().clip!.start;
    let max = 0;
    for (let k = 0; k < 48; k++) {
      h.run(1);
      sampleClip(REACTION_CLIPS.giggle, h.clock.t / 1000 - start, sample);
      const p = h.view.pose();
      expect(Math.abs(p[Ch.Jaw]! - sample[Ch.Jaw]!), `frame ${k}: Jaw`).toBeLessThanOrEqual(1e-6);
      for (const ch of [Ch.MouthW, Ch.MouthRound, Ch.Teeth])
        expect(Math.abs(p[ch]!), `frame ${k}: ${ch}`).toBe(0);
      max = Math.max(max, p[Ch.Jaw]!);
    }
    expect(max, 'the jaw opens').toBeGreaterThan(0.3);
  }

  /** A view with a held squish (a cheek pinch, in Idle) about to talk: Thinking, the replay stored as id 7. */
  function squishThenThinking(h: Harness, perf0: number): void {
    h.session.state = 'Listening';
    h.clock.t = perf0 - 500;
    toIdle(h);
    h.run(5);
    h.view.gesture(PINCH);
    expect(h.view.director()).toMatchObject({ name: 'Sustained', clip: { name: 'squish' } });
    h.run(12); // 0.2 s: the pucker is held
    h.anim({ e: 'attentive' });
    h.anim({ e: 'thinking' });
  }

  test('wobble (a head-top flick) moves HeadRot: the head spring peaks at 8–12°', () => {
    const [a, b] = pair();
    a.view.gesture(FLICK);
    expect(a.view.director().clip?.name).toBe('wobble');
    let peak = 0;
    runBoth(a, b, 72, P120, () => {
      peak = Math.max(peak, Math.abs(delta(a, b, Ch.HeadRot)));
    });
    expect(peak).toBeGreaterThanOrEqual(8 * DEG);
    expect(peak).toBeLessThanOrEqual(12 * DEG);
    const sim = simPeak(REACTION_CLIPS.wobble, SPRING.head, 0);
    expect(Math.abs(peak - sim), `peak ${peak}, simulated ${sim}`).toBeLessThanOrEqual(0.02 * sim);
  });

  test('tuftBoing (a head-top tap) moves TuftRot; springs at rest add exactly nothing', () => {
    const [a, b] = pair();
    a.view.gesture(TUFT_TAP);
    expect(a.view.director().clip?.name).toBe('tuftBoing');
    expect(REACTION_CLIPS.tuftBoing.tracks.map((tr) => tr.ch)).not.toContain(Ch.TuftRot);
    let peak = 0;
    runBoth(a, b, 120, P120, (k) => {
      peak = Math.max(peak, Math.abs(delta(a, b, Ch.TuftRot)));
      for (const ch of [Ch.TuftRot, Ch.KerchiefA, Ch.KerchiefB, Ch.NoseY]) {
        expect(Math.abs(b.view.pose()[ch]!), `frame ${k}: the control's channel ${ch}`).toBe(0);
      }
    });
    const sim = simPeak(REACTION_CLIPS.tuftBoing, SPRING.tuft, 0);
    expect(Math.abs(peak - sim), `peak ${peak}, simulated ${sim}`).toBeLessThanOrEqual(0.02 * sim);
  });

  test('bellyBoing (a belly tap) moves BellyJiggle beyond its squash track', () => {
    const [a, b] = pair();
    a.view.gesture(BELLY_TAP);
    expect(a.view.director().clip?.name).toBe('bellyBoing');
    expect(REACTION_CLIPS.bellyBoing.tracks.map((tr) => tr.ch)).toStrictEqual([Ch.BodySquash]);
    const start = a.view.director().clip!.start;
    let peak = 0;
    runBoth(a, b, 72, P120, (k) => {
      sampleClip(REACTION_CLIPS.bellyBoing, a.clock.t / 1000 - start, sample);
      expect(
        Math.abs(delta(a, b, Ch.BodySquash) - sample[Ch.BodySquash]!),
        `frame ${k}: BodySquash is the squash track`,
      ).toBeLessThanOrEqual(1e-6);
      peak = Math.max(peak, Math.abs(delta(a, b, Ch.BellyJiggle)));
    });
    const sim = simPeak(REACTION_CLIPS.bellyBoing, SPRING.belly, 0);
    expect(Math.abs(peak - sim), `peak ${peak}, simulated ${sim}`).toBeLessThanOrEqual(0.02 * sim);
  });

  test('giggle (a belly tickle) opens the jaw when not talking: its Jaw track passes through', () => {
    expectGiggleJaw(awake());
  });

  test("…also after a replay has ended: the mouth's close scale is the replay's alone", () => {
    const PERF0 = 10_000;
    const h = harness({ latencyMs: 0 });
    h.audio.ctx = fakeOutput(50, PERF0);
    h.audio.processed.set(7, { envelope: envelope(300, () => 0.8) });
    h.session.state = 'Listening';
    h.clock.t = PERF0 - 100;
    toThinking(h);
    h.view.onPlayStarted(7, 50);
    h.anim({ e: 'talk', id: 7 });
    h.stepTo(PERF0 + 1000);
    expect(h.view.pose()[Ch.Jaw]).toBeCloseTo(0.8, 6);
    h.anim({ e: 'talkEnd' });
    h.stepTo(PERF0 + 1300);
    expect(h.view.frameLog().at(-1), 'the envelope is dropped').toMatchObject({
      clipTime: null,
      envIndex: -1,
    });
    expect(h.view.director()).toMatchObject({
      name: 'Idle',
      talk: null,
      mouthCloseStart: (PERF0 + 1000) / 1000,
    });
    expectGiggleJaw(h);
  });

  test('while Talking a held squish leaves the replay’s mouth unchanged; before the mouth starts it stays closed', () => {
    const START = 50;
    const PERF0 = 10_000;
    const ramp = envelope(200, (i) => Math.min(1, i / 100));
    for (const started of [true, false]) {
      const h = harness();
      h.audio.ctx = fakeOutput(START, PERF0);
      h.audio.processed.set(7, { envelope: ramp });
      squishThenThinking(h, PERF0);
      if (started) h.view.onPlayStarted(7, START);
      h.anim({ e: 'talk', id: 7 });
      expect(h.view.director(), `started ${started}`).toMatchObject({
        name: 'Talking',
        clip: { name: 'squish' },
      });
      for (let k = 0; k < 60; k++) {
        const t = PERF0 + 3 + k * VSYNC;
        h.stepTo(t);
        if (started) mouthFromEnvelope(ramp, (t - PERF0) / 1000 + DISPLAY_LATENCY_MS / 1000, expected);
        else expected.fill(0);
        const p = h.view.pose();
        for (const ch of MOUTH) {
          expect(
            Math.abs(p[ch]! - expected[ch]!),
            `started ${started}, frame ${k}, channel ${ch}`,
          ).toBeLessThanOrEqual(1e-6);
        }
        expect(p[Ch.HeadSquishX], 'the squish plays on').toBeCloseTo(-0.12, 5);
      }
      h.view.dispose();
      mounted.splice(0);
    }
  });

  test("after talkEnd a held squish's mouth fades in as the replay's mouth closes", () => {
    const PERF0 = 10_000;
    const h = harness({ latencyMs: 0 });
    h.audio.ctx = fakeOutput(50, PERF0);
    h.audio.processed.set(7, { envelope: envelope(300, () => 0.8) }); // jaw 0.8, width 0.25, round 0.5, teeth 0
    squishThenThinking(h, PERF0);
    h.view.onPlayStarted(7, 50);
    h.anim({ e: 'talk', id: 7 });
    h.stepTo(PERF0 + 1000);
    expect(h.view.pose()[Ch.MouthRound], "the replay's mouth").toBeCloseTo(0.5, 6);
    h.anim({ e: 'talkEnd' }); // at the clock's 11 000 ms: the replay's mouth closes over 200 ms
    expect(h.view.director()).toMatchObject({ name: 'Sustained', clip: { name: 'squish' } });
    h.stepTo(PERF0 + 1100); // halfway: replay × 0.5 + squish × 0.5
    let p = h.view.pose();
    expect(p[Ch.MouthRound]).toBeCloseTo(0.5 * 0.5 + 1 * 0.5, 5);
    expect(p[Ch.Jaw]).toBeCloseTo(0.4, 5);
    expect(p[Ch.MouthW]).toBeCloseTo(0.125, 5);
    h.stepTo(PERF0 + 1201); // shut: the squish's mouth alone, and the envelope is dropped
    p = h.view.pose();
    expect([p[Ch.Jaw], p[Ch.MouthW], p[Ch.MouthRound], p[Ch.Teeth]]).toEqual([0, 0, 1, 0]);
    expect(h.view.frameLog().at(-1)).toMatchObject({ clipTime: null, envIndex: -1 });
    h.stepTo(PERF0 + 1220);
    p = h.view.pose();
    expect([p[Ch.Jaw], p[Ch.MouthW], p[Ch.MouthRound], p[Ch.Teeth]]).toEqual([0, 0, 1, 0]);
  });

  test('a mouth-bearing clip cutting another fades the mouth over 100 ms (#240)', () => {
    const h = awake();
    h.view.gesture(PINCH);
    h.run(36, P120); // 0.3 s: the squish's pucker is held at 1
    h.view.gesture(ALL_OVER);
    const d = h.view.director();
    expect(d.clip?.name).toBe('giggle');
    expect(d.prevClip?.name).toBe('squish');
    const cut = d.clip!.start;
    for (let k = 0; k < 18; k++) {
      h.run(1, P120);
      const t = h.clock.t / 1000;
      const p = h.view.pose();
      evaluate(h.view.director(), t, expected, true, JUNI.cast);
      for (const ch of MOUTH) {
        expect(
          Math.abs(p[ch]! - expected[ch]!),
          `frame ${k}, channel ${ch}: evaluate's mouth`,
        ).toBeLessThanOrEqual(1e-6);
      }
      const u = Math.min(1, (t - cut) / 0.1);
      const w = 1 - u * u * (3 - 2 * u);
      sampleClip(REACTION_CLIPS.giggle, t - cut, sample);
      expect(Math.abs(p[Ch.MouthRound]! - w), `frame ${k}: the pucker fades out`).toBeLessThanOrEqual(1e-6);
      expect(
        Math.abs(p[Ch.Jaw]! - sample[Ch.Jaw]! * (1 - w)),
        `frame ${k}: the giggle fades in`,
      ).toBeLessThanOrEqual(1e-6);
      if (t >= cut + 0.1) expect(Math.abs(p[Ch.MouthRound]!), `frame ${k}`).toBe(0);
    }
  });

  test("reduced motion: wobble's HeadRot peak is ≤ 0.35 × normal, the head spring × 0.3", () => {
    const [a, b] = pair();
    const [c, d] = pair();
    c.view.setReducedMotion(true);
    d.view.setReducedMotion(true);
    a.view.gesture(FLICK);
    c.view.gesture(FLICK);
    expect(c.view.director().clip?.name).toBe('wobbleGentle');
    let normal = 0;
    let reduced = 0;
    for (let k = 0; k < 72; k++) {
      runBoth(a, b, 1, P120, () => {
        normal = Math.max(normal, Math.abs(delta(a, b, Ch.HeadRot)));
      });
      runBoth(c, d, 1, P120, () => {
        reduced = Math.max(reduced, Math.abs(delta(c, d, Ch.HeadRot)));
      });
    }
    expect(reduced).toBeGreaterThan(0);
    expect(reduced).toBeLessThanOrEqual(0.35 * normal);
    const sim =
      REDUCED_MOTION_SCALE * simPeak(REACTION_CLIPS.wobbleGentle, SPRING.head, REDUCED_MOTION_MIN_ZETA);
    expect(Math.abs(reduced - sim), `peak ${reduced}, simulated ${sim}`).toBeLessThanOrEqual(0.02 * sim);
  });

  test('each kick applies once, in the first frame it is due; a replaced clip drops its pending kicks', () => {
    const impulse = vi.spyOn(SpringBank.prototype, 'impulse');
    const kicksOn = (spring: number): [number, number][] => impulse.mock.calls.filter(([i]) => i === spring);
    // (a) Once, through a frame of 6 substeps and 300 more frames.
    const h = awake();
    impulse.mockClear();
    h.view.gesture(TUFT_TAP);
    expect(kicksOn(SPRING.tuft), 'no frame yet').toHaveLength(0);
    h.run(1, 50);
    const tuftKick = REACTION_CLIPS.tuftBoing.impulses![0]!;
    expect(kicksOn(SPRING.tuft)).toStrictEqual([[SPRING.tuft, tuftKick.dv]]);
    h.run(300);
    expect(kicksOn(SPRING.tuft)).toHaveLength(1);
    // (b) Each kick in the first frame where now − start ≥ t: the tap 3 ms off the vsync grid, so no frame lands on
    // a kick's time.
    const g = awake();
    const t0 = g.clock.t;
    g.clock.t = t0 + 3;
    g.view.gesture(KERCHIEF_TAP);
    g.clock.t = t0; // the frames keep their grid
    expect(g.view.director().clip?.name).toBe('kerchiefAdjust');
    const start = g.view.director().clip!.start;
    const kicks = REACTION_CLIPS.kerchiefAdjust.impulses!;
    expect(kicks.map((imp) => [imp.spring, imp.t])).toStrictEqual([
      [SPRING.kerchiefA, 0.45],
      [SPRING.kerchiefB, 0.5],
    ]);
    impulse.mockClear();
    const landed = new Map<number, number[]>(); // spring → the elapsed time of each frame that kicked it
    const elapsed: number[] = [];
    for (let k = 0; k < 60; k++) {
      const before = impulse.mock.calls.length;
      g.run(1);
      const e = g.clock.t / 1000 - start; // as bear-view computes it: the director clock is the rAF time
      elapsed.push(e);
      for (const [i] of impulse.mock.calls.slice(before)) landed.set(i, [...(landed.get(i) ?? []), e]);
    }
    for (const imp of kicks) {
      const due = elapsed.find((e) => e >= imp.t);
      expect(due, `kick at ${imp.t}`).toBeDefined();
      expect(due! - imp.t, `kick at ${imp.t}: off the grid`).toBeGreaterThan(1e-4);
      expect(landed.get(imp.spring), `kick at ${imp.t}`).toStrictEqual([due]);
    }
    // (c) A clip interrupted before its kicks: none of them ever applies; the new clip's does, once.
    const [a, b] = pair();
    impulse.mockClear();
    a.view.gesture(KERCHIEF_TAP);
    runBoth(a, b, 18, VSYNC, () => undefined); // 0.3 s, before the tails' kicks at 0.45 and 0.5 s
    a.view.gesture(NOSE_TAP); // sneeze (P2) interrupts kerchiefAdjust (P2)
    expect(a.view.director().clip?.name).toBe('sneeze');
    expect(a.view.director().prevClip?.name).toBe('kerchiefAdjust');
    runBoth(a, b, 180, VSYNC, (k) => {
      for (const ch of [Ch.KerchiefA, Ch.KerchiefB])
        expect(Math.abs(delta(a, b, ch)), `frame ${k}: ${ch}`).toBe(0);
    });
    expect(kicksOn(SPRING.kerchiefA)).toHaveLength(0);
    expect(kicksOn(SPRING.kerchiefB)).toHaveLength(0);
    expect(kicksOn(SPRING.nose)).toStrictEqual([[SPRING.nose, REACTION_CLIPS.sneeze.impulses![0]!.dv]]);
  });

  test('a moving secondary spring keeps the loop at full rate after its clip has ended (D17)', () => {
    // An Idle pair: the control throttles to 30 fps whenever nothing it watches moves.
    const a = awake();
    const b = awake();
    a.view.gesture(TUFT_TAP);
    // Only vsyncs where `a` drew on this one and the previous one count: truly at full rate, not throttled out of
    // phase with the control.
    let fullRate = 0;
    let prevDrew = false;
    for (let k = 0; k < 120; k++) {
      const na = drawnFrames(a);
      const nb = drawnFrames(b);
      a.run(1);
      b.run(1);
      const drew = drawnFrames(a) > na;
      const ringing = delta(a, b, Ch.TuftRot) !== 0;
      if (a.view.director().clip === null && drew && prevDrew && drawnFrames(b) === nb && ringing) fullRate++;
      prevDrew = drew;
    }
    expect(a.view.director().name).toBe('Idle');
    expect(fullRate, 'consecutive vsyncs the ringing tuft alone kept drawn').toBeGreaterThanOrEqual(5);
  });

  test('after a kicked clip has ended, the next clip gets its kicks', () => {
    const impulse = vi.spyOn(SpringBank.prototype, 'impulse');
    const h = awake();
    h.view.gesture(TUFT_TAP);
    h.run(60); // 1 s at 60 Hz: tuftBoing (0.8 s) has ended, its kick applied
    expect(h.view.director().clip).toBeNull();
    impulse.mockClear();
    h.view.gesture(BELLY_TAP);
    expect(h.view.director().clip?.name).toBe('bellyBoing');
    h.run(1);
    expect(impulse.mock.calls.filter(([i]) => i === SPRING.belly)).toStrictEqual([
      [SPRING.belly, REACTION_CLIPS.bellyBoing.impulses![0]!.dv],
    ]);
  });

  test('a secondary spring is drawn at the frame alpha between its last two substeps, like the layers (90 Hz)', () => {
    const P90 = 1000 / 90;
    // Attentive before the first frame: every frame is drawn, so each frame's time since the last one is known.
    const h = harness();
    h.session.state = 'Listening';
    toIdle(h);
    h.anim({ e: 'attentive' });
    // The reference: the app's springs, stepped by a stepper fed the same frame times as the view's loop.
    const bank = new SpringBank(SPRING_COUNT);
    configureSprings(bank);
    const prev = new Float32Array(SPRING_COUNT);
    const stepper = new Stepper();
    const kick = REACTION_CLIPS.tuftBoing.impulses![0]!;
    let kickDue = false;
    const substep = (dt: number): void => {
      if (kickDue) bank.impulse(kick.spring, kick.dv);
      kickDue = false;
      prev.set(bank.pos);
      bank.step(dt);
    };
    let last = -1;
    let between = 0;
    for (let k = 0; k < 150; k++) {
      if (k === 30) {
        h.view.gesture(TUFT_TAP);
        expect(h.view.director().clip?.name).toBe('tuftBoing');
        kickDue = true; // the view applies it in the first substep after the tap
      }
      const t = h.clock.t + P90;
      const drawn = drawnFrames(h);
      h.stepTo(t);
      expect(drawnFrames(h) - drawn, `frame ${k} is drawn`).toBe(1);
      // As loop.ts feeds its stepper: nothing on the first frame, then the time since the last drawn frame.
      const owed = last >= 0 ? (t - last) / 1000 : 0;
      last = t;
      const alpha = stepper.advance(owed < MAX_FRAME_DT ? owed : MAX_FRAME_DT, substep);
      const a = prev[SPRING.tuft]!;
      const cur = bank.pos[SPRING.tuft]!;
      const want = a + (cur - a) * alpha;
      expect(Math.abs(h.view.pose()[Ch.TuftRot]! - want), `frame ${k}, alpha ${alpha}`).toBeLessThanOrEqual(
        1e-6,
      );
      if (Math.abs(cur - want) > 1e-3) between++;
    }
    expect(between, 'frames drawn visibly between the last two substeps').toBeGreaterThanOrEqual(20);
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
  test('stops the loop and renders the pose once at 500 × 700, DPR 1, scale 0.5, with no inline size', () => {
    const h = harness({ devicePixelRatio: () => 2 });
    h.run(10);
    h.view.showPose(POSES.talkOpen, 500, 700);
    const c = h.view.canvas;
    expect(c.classList.contains('stage--fixed')).toBe(true);
    expectOnlyAdapterStyles(c);
    expect([c.width, c.height]).toEqual([500, 700]);
    expect(h.frames.pending.size).toBe(0);

    // The same pixels as the renderer drawing the pose directly at the fitted view (#75's screenshot setup).
    const ref = document.createElement('canvas');
    ref.width = 500;
    ref.height = 700;
    const g = createContext(ref);
    const view = fitView(500, 700, { scale: 0, ox: 0, oy: 0 });
    expect(view).toEqual({ scale: 0.5, ox: 0, oy: 0 });
    render(g, createRig(JUNI), POSES.talkOpen, view);
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

/** The stage's CSS size in the #93 input tests (a constructed sheet): its CSS view is scale 0.4, ox = oy = 0. */
const STAGE_W = 400;
const STAGE_H = 560;

/** A synthetic touch pointer event on the stage at viewport point (x, y). */
function pointer(
  h: Harness,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  x: number,
  y: number,
  pointerId = 1,
): void {
  h.view.canvas.dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, pointerId, pointerType: 'touch', bubbles: true }),
  );
}

/** A synthetic touch tap (pointerdown, then pointerup) at viewport point `p`. */
function tapAt(h: Harness, p: { x: number; y: number }, pointerId = 1): void {
  pointer(h, 'pointerdown', p.x, p.y, pointerId);
  pointer(h, 'pointerup', p.x, p.y, pointerId);
}

/** A viewport point on the background: 1 CSS px right of the stage's left edge, `dy` px below its top. */
function background(h: Harness, dy = 400): { x: number; y: number } {
  const r = h.view.canvas.getBoundingClientRect();
  return { x: r.left + 1, y: r.top + dy };
}

/** The region under viewport point `p`, by an independent hit test over the drawn pose at the stage's CSS view. */
function hitAt(h: Harness, p: { x: number; y: number }): RegionId {
  const r = h.view.canvas.getBoundingClientRect();
  const bones = boneMatrices(createRig(JUNI), h.view.pose(), new Float32Array(JUNI_RIG.boneCount * MAT));
  return hitTest(
    p.x - r.left,
    p.y - r.top,
    bones,
    fitView(STAGE_W, STAGE_H, { scale: 0, ox: 0, oy: 0 }),
    JUNI_REGIONS,
  );
}

function fakeHaptics(): {
  play: Mock<(pattern: number[]) => boolean>;
  noteActivation: Mock<(kind: 'down' | 'up') => void>;
} {
  return { play: vi.fn<(pattern: number[]) => boolean>(() => true), noteActivation: vi.fn() };
}

/** A reaction event as the director outputs it to the session. */
function reaction(name: string, priority: 1 | 2 | 3 | 4, sfx: SfxId | null): SessionEvent {
  return { t: 'reaction', name, priority, sfx };
}

const NOSE_TAP: Gesture = { g: 'tap', phase: 'down', region: 'nose', x: 0, y: 0, count: 1 };

/** A view in session state `state` with the director in Idle (no wake clip) and a few frames drawn. */
function awake(over: Partial<BearViewDeps> = {}, state: StateName = 'Listening'): Harness {
  const h = harness(over);
  h.session.state = state;
  toIdle(h);
  h.run(5);
  return h;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The director's reaction after `g` in a fresh awake view. */
function accepted(g: Gesture): unknown {
  const h = awake();
  h.view.gesture(g);
  return h.view.director().reaction;
}

/** A headTop stroke update long enough to pet, in direction `dir` (rad). */
function petStroke(dir: number): Gesture {
  return { g: 'stroke', region: 'headTop', phase: 'update', pathPx: 200, dir, against: false };
}

/**
 * A view in Attentive (every frame drawn, so two views draw the same frames) for 2 s after a left-eye tap
 * (`blink`) or nothing: its brow and the time since.
 */
function browAfter(blink: boolean): { brow: number; dt: number } {
  const h = awake({}, 'Recording');
  h.anim({ e: 'attentive' });
  h.run(5);
  if (blink) h.view.gesture({ g: 'tap', phase: 'down', region: 'eyeL', x: 0, y: 0, count: 1 });
  const t = h.clock.t;
  h.run(120);
  return { brow: h.view.pose()[Ch.BrowL]!, dt: (h.clock.t - t) / 1000 };
}

describe('pointer input and reactions (#93)', () => {
  let sheets: CSSStyleSheet[] = [];
  beforeEach(() => {
    // The stage's CSS size, as styles.css gives it in the app (a constructed sheet: no style attribute).
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`.stage { display: block; width: ${STAGE_W}px; height: ${STAGE_H}px; }`);
    sheets = [...document.adoptedStyleSheets];
    document.adoptedStyleSheets = [...sheets, sheet];
  });
  afterEach(() => {
    document.adoptedStyleSheets = sheets;
  });

  test('hits are tested in CSS px over the current bone matrices, also at DPR 2', () => {
    const h = awake({ devicePixelRatio: () => 2 });
    expect([h.view.canvas.width, h.view.canvas.height]).toEqual([2 * STAGE_W, 2 * STAGE_H]);
    h.run(30);
    for (const id of ['nose', 'cheekL', 'belly', 'flankR'] as const) {
      expect(hitAt(h, h.view.regionCenter(id)), id).toBe(id);
    }
    tapAt(h, h.view.regionCenter('nose'), 1);
    tapAt(h, h.view.regionCenter('cheekL'), 2);
    expect(h.dispatch.mock.calls).toEqual([
      [reaction('sneeze', 2, 'sneeze')],
      [reaction('cheekPuffL', 2, 'pop')],
    ]);
  });

  test('Asleep, Error and Paused: a pointerdown anywhere dispatches tapBear; NeedsParent and awake: never', () => {
    for (const s of ['Asleep', 'Error', 'Paused'] as const) {
      const h = harness();
      h.session.state = s;
      h.run(2);
      pointer(h, 'pointerdown', background(h).x, background(h).y, 1);
      pointer(h, 'pointerup', background(h).x, background(h).y, 1);
      const nose = h.view.regionCenter('nose');
      pointer(h, 'pointerdown', nose.x, nose.y, 2);
      expect(h.dispatch.mock.calls, s).toEqual([[{ t: 'tapBear' }], [{ t: 'tapBear' }]]);
    }
    const parent = harness();
    parent.session.state = 'NeedsParent';
    tapAt(parent, parent.view.regionCenter('nose'));
    expect(parent.dispatch).not.toHaveBeenCalled();
    expect(AWAKE.size).toBe(8);
    for (const s of AWAKE) {
      const h = awake({}, s);
      tapAt(h, background(h));
      expect(h.dispatch, s).not.toHaveBeenCalledWith({ t: 'tapBear' });
    }
  });

  test('awake states route a gesture with a reaction to the director: toSession → dispatch, haptic → haptics.play', () => {
    for (const s of AWAKE) {
      const haptics = fakeHaptics();
      const h = awake({ haptics }, s);
      h.clock.t += 5;
      h.view.gesture(NOSE_TAP);
      expect(h.dispatch.mock.calls, s).toEqual([[reaction('sneeze', 2, 'sneeze')]]);
      expect(haptics.play.mock.calls, s).toEqual([[[12]]]);
      expect(h.view.director(), s).toMatchObject({
        name: 'Reacting',
        reaction: { r: { name: 'sneeze' }, start: h.clock.t / 1000, region: 'nose', gesture: 'tap' },
      });
    }
    // Not awake: nothing reaches the director, even when it is in Idle (Error's entry sends no anim, so in the
    // app the director stays Idle while the session is in Error).
    for (const s of ['Asleep', 'NeedsParent', 'Error', 'Paused'] as const) {
      const haptics = fakeHaptics();
      const h = harness({ haptics });
      h.anim({ e: 'wake' });
      h.anim({ e: 'idle' });
      h.run(5);
      h.session.state = s;
      const before = h.view.director();
      expect(before.name, s).toBe('Idle');
      h.clock.t += 5;
      h.view.gesture(NOSE_TAP);
      h.view.gesture({ g: 'tap', phase: 'down', region: 'background', x: 0, y: 100, count: 1 });
      expect(h.view.director(), s).toBe(before);
      expect(h.dispatch, s).not.toHaveBeenCalled();
      expect(haptics.play, s).not.toHaveBeenCalled();
      expect(h.view.lookAt(), s).toBeNull();
    }
  });

  test('a gesture without a reaction sends the director nothing', () => {
    const h = awake();
    const before = h.view.director();
    const none: Gesture[] = [
      { g: 'tap', phase: 'up', region: 'nose', x: 0, y: 0, count: 1 },
      { g: 'flick', region: 'nose', vx: 900, vy: 0 },
      { g: 'tap', phase: 'down', region: 'flankL', x: 0, y: 0, count: 1 },
      { g: 'cancel' },
    ];
    for (const g of none) h.view.gesture(g);
    expect(h.view.director()).toBe(before);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  test('gesture fields: hug and all-over → belly, a pinch → its first cheek, a stroke → dirX', () => {
    expect(accepted({ g: 'hug' })).toMatchObject({ r: { name: 'hug' }, region: 'belly', gesture: 'hug' });
    expect(accepted({ g: 'allOver' })).toMatchObject({
      r: { name: 'giggle' },
      region: 'belly',
      gesture: 'allOver',
    });
    expect(accepted({ g: 'pinch', regions: ['cheekR', 'cheekL'], spanRatio: 0.8 })).toMatchObject({
      r: { name: 'squish' },
      region: 'cheekR',
      gesture: 'pinch',
    });
    expect(accepted(petStroke(Math.PI))).toMatchObject({
      r: { name: 'pet' },
      clip: 'petMirrored',
      region: 'headTop',
      gesture: 'stroke',
    });
    expect(accepted(petStroke(0))).toMatchObject({ r: { name: 'pet' }, clip: 'pet' });
  });

  test('release identity: a stroke or long-press end releases its own reaction; the last pointer up, everything', () => {
    const h = awake();
    h.view.gesture({ g: 'longPress', region: 'headTop', phase: 'start' });
    expect(h.view.director().reaction).toMatchObject({ r: { name: 'headPress' }, release: null });
    h.clock.t += 100;
    h.view.gesture({ g: 'longPress', region: 'belly', phase: 'start' });
    expect(h.view.director().reaction).toMatchObject({ r: { name: 'bellyRub' }, release: null });
    h.clock.t += 100;
    h.view.gesture({ g: 'longPress', region: 'headTop', phase: 'end' });
    expect(h.view.director().reaction).toMatchObject({ r: { name: 'bellyRub' }, release: null });
    h.clock.t += 100;
    h.view.gesture({ g: 'longPress', region: 'belly', phase: 'end' });
    expect(h.view.director().reaction).toMatchObject({ r: { name: 'bellyRub' }, release: h.clock.t / 1000 });

    const blush = awake();
    blush.view.gesture({ g: 'stroke', region: 'cheekL', phase: 'start', pathPx: 12, dir: 0, against: false });
    expect(blush.view.director().reaction).toMatchObject({ r: { name: 'blush' }, release: null });
    blush.clock.t += 200;
    blush.view.gesture({ g: 'stroke', region: 'cheekL', phase: 'end', pathPx: 40, dir: 0, against: false });
    expect(blush.view.director().reaction).toMatchObject({
      r: { name: 'blush' },
      release: blush.clock.t / 1000,
    });

    // All up: two contacts on the background (their tap downs have no reaction) over a held squish.
    const all = awake();
    all.view.gesture({ g: 'pinch', regions: ['cheekL', 'cheekR'], spanRatio: 0.8 });
    expect(all.view.director().reaction).toMatchObject({ r: { name: 'squish' }, release: null });
    all.dispatch.mockClear();
    const a = background(all, 300);
    const b = background(all, 400);
    pointer(all, 'pointerdown', a.x, a.y, 1);
    pointer(all, 'pointerdown', b.x, b.y, 2);
    pointer(all, 'pointerup', a.x, a.y, 1);
    expect(all.dispatch).not.toHaveBeenCalled();
    expect(all.view.director().reaction).toMatchObject({ r: { name: 'squish' }, release: null });
    pointer(all, 'pointerup', b.x, b.y, 2);
    expect(all.dispatch.mock.calls).toEqual([[reaction('squish', 3, 'pop')]]);

    // The last pointer up may be a pointercancel: it releases everything too.
    const cancelled = awake();
    cancelled.view.gesture({ g: 'pinch', regions: ['cheekL', 'cheekR'], spanRatio: 0.8 });
    cancelled.dispatch.mockClear();
    const c = background(cancelled, 300);
    pointer(cancelled, 'pointerdown', c.x, c.y, 1);
    pointer(cancelled, 'pointercancel', c.x, c.y, 1);
    expect(cancelled.dispatch.mock.calls).toEqual([[reaction('squish', 3, 'pop')]]);
  });

  test('director ticks route their outputs: a queued reaction that starts on a tick is dispatched then', () => {
    const haptics = fakeHaptics();
    const h = awake({ haptics });
    const t0 = h.clock.t;
    h.view.gesture({ g: 'longPress', region: 'belly', phase: 'start' });
    h.clock.t = t0 + 100;
    h.view.gesture(NOSE_TAP); // P2 under the held P3: queued
    expect(h.dispatch.mock.calls).toEqual([[reaction('bellyRub', 3, 'sigh')]]);
    expect(h.view.director().queued).toMatchObject({ r: { name: 'sneeze' } });
    // A lone pointerup (no matching down) reaches onRawUp with active 0: every contact is up.
    h.clock.t = t0 + 150;
    const p = background(h);
    pointer(h, 'pointerup', p.x, p.y, 7);
    expect(h.view.director().reaction).toMatchObject({ r: { name: 'bellyRub' }, release: (t0 + 150) / 1000 });
    h.dispatch.mockClear();
    haptics.play.mockClear();
    while (h.clock.t < t0 + 700) h.run(1);
    expect(h.dispatch.mock.calls).toEqual([[reaction('sneeze', 2, 'sneeze')]]);
    expect(haptics.play.mock.calls).toEqual([[[12]]]);
    expect(h.view.director().reaction).toMatchObject({ r: { name: 'sneeze' } });
  });

  test('the step stores the new state before routing: a talkEnd fed back by dispatch sees it', () => {
    const h = harness();
    h.session.state = 'Playing';
    toThinking(h);
    h.anim({ e: 'talk', id: 1 });
    h.run(5);
    expect(h.view.director().name).toBe('Talking');
    // The session stops the replay for a P3+ reaction, and its talkEnd reaches the director at once.
    h.dispatch.mockImplementation((e) => {
      if (e.t === 'reaction' && e.priority >= 3) h.view.onAnim({ e: 'talkEnd' });
    });
    h.clock.t += 50;
    h.view.gesture({ g: 'longPress', region: 'belly', phase: 'start' });
    expect(h.view.director()).toMatchObject({ name: 'Sustained', reaction: { r: { name: 'bellyRub' } } });
  });

  test('mood outputs bump the mood layer: a hard blink leaves the brows down, decaying with τ = 8 s', () => {
    const withBlink = browAfter(true);
    const control = browAfter(false);
    const want = -0.2 * 3 * Math.exp(-withBlink.dt / 8);
    expect(Math.abs(withBlink.brow - control.brow - want)).toBeLessThan(0.02);
  });

  test('a background tap turns the gaze to it for LOOK_HOLD_S; a background stroke keeps it on the finger', async () => {
    const h = awake();
    h.stepTo(2000);
    // Eye height at the stage's left edge: the design point (0, 385).
    h.view.gesture({ g: 'tap', phase: 'down', region: 'background', x: 0, y: 385 * 0.4, count: 1 });
    expect(h.view.lookAt()).toEqual({ x: 0, y: 385 });
    h.run(10);
    expect(h.view.pose()[Ch.IrisX]).toBeLessThan(-9);
    h.stepTo(2000 + LOOK_HOLD_S * 1000 - 1);
    expect(h.view.lookAt()).not.toBeNull();
    // At ≥ the hold's end (a later frame: Idle draws at 30 fps, so a frame 1 ms later would be skipped).
    h.stepTo(2000 + LOOK_HOLD_S * 1000 + 50);
    expect(h.view.lookAt()).toBeNull();

    // A real stroke on the background (event timestamps are real time): 6 moves of 10 px, 20 ms apart.
    const r = h.view.canvas.getBoundingClientRect();
    const x0 = r.left + 2;
    const y0 = r.top + 400;
    pointer(h, 'pointerdown', x0, y0, 3);
    for (let k = 1; k <= 6; k++) {
      await sleep(20);
      pointer(h, 'pointermove', x0 + 10 * k, y0, 3);
    }
    const look = h.view.lookAt();
    expect(look?.x).toBeCloseTo(62 / 0.4, 6);
    expect(look?.y).toBeCloseTo(400 / 0.4, 6);
    pointer(h, 'pointerup', x0 + 60, y0, 3);
    // The same pointer id again, on the belly: a small move no longer moves the gaze.
    const belly = h.view.regionCenter('belly');
    pointer(h, 'pointerdown', belly.x, belly.y, 3);
    pointer(h, 'pointermove', belly.x + 4, belly.y, 3);
    expect(h.view.lookAt()?.x).toBeCloseTo(62 / 0.4, 6);
    pointer(h, 'pointerup', belly.x + 4, belly.y, 3);
  });

  test('the gaze maps a background point through the CSS view, also at DPR 2', () => {
    const h = awake({ devicePixelRatio: () => 2 });
    expect([h.view.canvas.width, h.view.canvas.height]).toEqual([2 * STAGE_W, 2 * STAGE_H]);
    // The stage's CSS view is still scale 0.4: eye height at its left edge is the design point (0, 385).
    h.view.gesture({ g: 'tap', phase: 'down', region: 'background', x: 0, y: 385 * 0.4, count: 1 });
    expect(h.view.lookAt()).toEqual({ x: 0, y: 385 });
  });

  test('reduced motion sets the director gentle', () => {
    const h = awake();
    expect(h.view.director().gentle).toBe(false);
    h.view.setReducedMotion(true);
    expect(h.view.director().gentle).toBe(true);
    h.view.setReducedMotion(false);
    expect(h.view.director().gentle).toBe(false);
  });

  test('regionCenter: every region centre, in viewport CSS px, hits that region; background has none', () => {
    const h = awake();
    h.run(30);
    // Per character (duck plan T123): the ids the mounted character (Juni) has a region for.
    const ids = new Set(JUNI.regions.map((r) => r.id));
    expect(ids.size).toBe(16);
    expect(ids.has('background')).toBe(false);
    for (const id of ids) expect(hitAt(h, h.view.regionCenter(id)), id).toBe(id);
    expect(() => h.view.regionCenter('background')).toThrow(RangeError);
  });

  test('regionCenter and the hits follow the drawn pose: the bones are refreshed after a frame', () => {
    const h = awake({}, 'Recording');
    h.run(30);
    const before = h.view.regionCenter('nose');
    expect(hitAt(h, before)).toBe('nose');
    // Attentive tilts the head 8°: after its 150 ms crossfade the nose has moved.
    h.anim({ e: 'attentive' });
    h.run(30);
    const after = h.view.regionCenter('nose');
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(2);
    expect(hitAt(h, after)).toBe('nose');
    // The adapter hits the moved nose too.
    tapAt(h, after);
    expect(h.dispatch).toHaveBeenCalledWith(reaction('sneeze', 2, 'sneeze'));
  });

  test("regionCenter is the forward map of the region's first entry, offset by the canvas's viewport position", () => {
    const offset = new CSSStyleSheet();
    offset.replaceSync('.t82-offset { margin-left: 200px; margin-top: 30px; }');
    const sheets0 = [...document.adoptedStyleSheets];
    document.adoptedStyleSheets = [...sheets0, offset];
    root.classList.add('t82-offset');
    try {
      const h = awake();
      h.run(30);
      const rect = h.view.canvas.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(200);
      const bones = boneMatrices(createRig(JUNI), h.view.pose(), new Float32Array(JUNI_RIG.boneCount * MAT));
      const view = fitView(STAGE_W, STAGE_H, { scale: 0, ox: 0, oy: 0 });
      for (const id of ['nose', 'headTop'] as const) {
        // headTop has a second entry on the tuft bone, after the head's: the first one is the centre.
        const r = REGIONS.find((d) => d.id === id)!;
        const o = boneIndex(JUNI_RIG, r.bone) * MAT;
        const x = bones[o]! * r.cx + bones[o + 2]! * r.cy + bones[o + 4]!;
        const y = bones[o + 1]! * r.cx + bones[o + 3]! * r.cy + bones[o + 5]!;
        const c = h.view.regionCenter(id);
        expect(Math.abs(c.x - rect.left - (view.ox + view.scale * x)), id).toBeLessThan(1e-6);
        expect(Math.abs(c.y - rect.top - (view.oy + view.scale * y)), id).toBeLessThan(1e-6);
      }
    } finally {
      root.classList.remove('t82-offset');
      document.adoptedStyleSheets = sheets0;
    }
  });

  test('activation: pointerdown notes down, pointerup notes up, pointercancel notes nothing', () => {
    const haptics = fakeHaptics();
    const h = awake({ haptics });
    const p = background(h);
    pointer(h, 'pointerdown', p.x, p.y, 1);
    expect(haptics.noteActivation.mock.calls).toEqual([['down']]);
    pointer(h, 'pointerup', p.x, p.y, 1);
    expect(haptics.noteActivation.mock.calls).toEqual([['down'], ['up']]);
    pointer(h, 'pointerdown', p.x, p.y, 2);
    pointer(h, 'pointercancel', p.x, p.y, 2);
    expect(haptics.noteActivation.mock.calls).toEqual([['down'], ['up'], ['down']]);

    // Two fingers: the first one's pointerup is noted while the second is still down.
    const two = fakeHaptics();
    const t = awake({ haptics: two });
    const q = background(t, 300);
    pointer(t, 'pointerdown', q.x, q.y, 1);
    pointer(t, 'pointerdown', q.x, q.y + 40, 2);
    pointer(t, 'pointerup', q.x, q.y, 1);
    expect(two.noteActivation.mock.calls).toEqual([['down'], ['down'], ['up']]);
    pointer(t, 'pointerup', q.x, q.y + 40, 2);
    expect(two.noteActivation.mock.calls).toEqual([['down'], ['down'], ['up'], ['up']]);

    // Asleep: the wake tap's pointerdown is noted as well as dispatching tapBear.
    const asleep = fakeHaptics();
    const z = harness({ haptics: asleep });
    const w = background(z);
    pointer(z, 'pointerdown', w.x, w.y, 1);
    expect(asleep.noteActivation.mock.calls).toEqual([['down']]);
    expect(z.dispatch.mock.calls).toEqual([[{ t: 'tapBear' }]]);
  });

  test('dispose detaches the pointer adapter: no listener, no inline style', () => {
    const h = harness();
    const c = h.view.canvas;
    h.view.dispose();
    mounted.splice(mounted.indexOf(h.view), 1);
    root.append(c);
    const p = { x: c.getBoundingClientRect().left + 10, y: c.getBoundingClientRect().top + 10 };
    pointer(h, 'pointerdown', p.x, p.y, 1);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(c.style.length).toBe(0);
    c.remove();
  });

  test('adapter.tick runs in the frame: a held finger becomes a long-press without moving', async () => {
    const h = awake();
    const belly = h.view.regionCenter('belly');
    pointer(h, 'pointerdown', belly.x, belly.y, 1);
    // The recogniser's time is the events' and the adapter's tick clock (performance.now()): wait for real.
    await sleep(550);
    h.run(3);
    expect(h.dispatch).toHaveBeenCalledWith(reaction('bellyRub', 3, 'sigh'));
    pointer(h, 'pointerup', belly.x, belly.y, 1);
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

// ---- T126: remounting on a character swap ---------------------------------------------------------------------

describe('remount on a character swap (T126)', () => {
  test('the new canvas takes the old one’s place: root’s first child, before what was mounted after it', () => {
    const first = harness();
    const later = document.createElement('div');
    root.append(later);
    expect(root.firstElementChild).toBe(first.view.canvas);
    first.view.dispose();
    mounted.splice(0);
    const second = harness({ character: FENN });
    expect(root.firstElementChild).toBe(second.view.canvas);
    expect(second.view.canvas.nextElementSibling).toBe(later);
    expect(root.querySelectorAll('canvas')).toHaveLength(1);
    expect(second.view.canvas.getAttribute('aria-label')).toBe('Fenn the duckling');
  });

  /**
   * R3 of the duck plan: a remount must not leak the old view (its rig, director, listeners, rAF callback). V8's
   * warm-up retains heap of its own over the first mounts of a session (feedback and optimised code for the mount
   * path): rounds of 20 mount/dispose pairs from a cold start retained 232 924, 0, 41 156, 3 612, then 10 256, 0, 0, 0
   * B, then 0 in every round. So `WARMUP_SWAPS` uncounted swaps come first; then the baseline after 1 swap, and 20
   * swaps after it. A positive control keeps the disposed views reachable.
   */
  test('20 swaps, then a forced GC, retain no more heap than 1 swap + 64 KB', () => {
    const gc: unknown = Reflect.get(globalThis, 'gc');
    if (typeof gc !== 'function')
      throw new Error('needs Chromium with --js-flags=--expose-gc (vitest.config.ts)');
    const SWAPS = 20;
    const BOUND = 64 * 1024;
    const WARMUP_SWAPS = 60;
    /** Frames each mounted view draws before the next swap: wake, a reaction, the loop running, sleep. */
    const FRAMES = 60;
    // One scheduler, clock and visibility for every view, as in main.ts: a view that kept its visibility listener,
    // its rAF callback or its resize listener after dispose() would stay reachable through them.
    const frames = fakeFrames();
    const visibility = fakeVisibility();
    const clock = { t: 1000 };
    const deps = (character: BearViewDeps['character']): BearViewDeps => ({
      visibility: visibility.vis,
      now: () => clock.t,
      state: () => 'Asleep',
      dispatch: () => undefined,
      engine: { getProcessed: () => undefined, context: () => null },
      seed: 1234,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      perfNow: () => 0,
      character,
    });
    const exercise = (v: BearView): void => {
      v.onAnim({ e: 'wake' });
      v.onAnim({ e: 'idle' });
      v.gesture({ g: 'tap', phase: 'down', region: 'eyeL', x: 0, y: 0, count: 1 });
      for (let k = 0; k < FRAMES; k++) {
        clock.t += VSYNC;
        frames.step(clock.t);
      }
      v.onAnim({ e: 'sleep' });
      window.dispatchEvent(new Event('resize'));
    };
    let view = mountBearView(root, deps(JUNI));
    exercise(view);
    let swaps = 0;
    /** The next swap: Fenn after an odd number of swaps, Juni after an even one. */
    const swap = (keep?: BearView[]): void => {
      view.dispose();
      keep?.push(view);
      swaps++;
      view = mountBearView(root, deps(swaps % 2 === 1 ? FENN : JUNI));
      exercise(view);
    };
    const retained = (): number => {
      gc();
      gc();
      return usedJSHeapSize();
    };
    // The views mounted here are disposed by `swap` and, last, by `finally`; the harness's `mounted` holds none.
    try {
      for (let i = 0; i < WARMUP_SWAPS; i++) swap();
      swap(); // the 1 swap: Fenn
      const baseline = retained();
      for (let i = 0; i < SWAPS; i++) swap(); // back on Fenn
      const after = retained();
      expect(root.querySelectorAll('canvas')).toHaveLength(1);
      expect(view.canvas.getAttribute('aria-label')).toBe('Fenn the duckling');
      expect(frames.pending.size).toBe(1); // only the current view's frame is scheduled
      // Positive control: the same swaps keeping every disposed view reachable.
      const kept: BearView[] = [];
      const before = retained();
      for (let i = 0; i < SWAPS; i++) swap(kept);
      const leaked = retained() - before;
      expect(kept).toHaveLength(SWAPS);
      const report = `retained after 1 swap ${baseline} B, after ${SWAPS} more ${after} B (Δ ${after - baseline} B, bound ${BOUND}); positive control (disposed views kept) Δ ${leaked} B`;
      console.log(`[T126 remount] ${report}`);
      expect(after - baseline, report).toBeLessThanOrEqual(BOUND);
      expect(leaked, report).toBeGreaterThan(BOUND);
    } finally {
      view.dispose();
    }
  });
});

// ---- #115: the cupped-ear mime in MicDenied ------------------------------------------------------------------------

/** Runs `seconds` of 60 Hz frames, calling `each` after every frame with the director's state. */
function runFor(
  h: Harness,
  seconds: number,
  each: (d: ReturnType<BearView['director']>) => void = () => {},
): void {
  const n = Math.round((seconds * 1000) / VSYNC);
  for (let i = 0; i < n; i++) {
    h.run(1);
    each(h.view.director());
  }
}

/** The start times (s) of every cuppedEar clip the director played over `seconds` of frames. */
function mimeStarts(
  h: Harness,
  seconds: number,
  each?: (d: ReturnType<BearView['director']>) => void,
): number[] {
  const starts = new Set<number>();
  runFor(h, seconds, (d) => {
    if (d.clip?.name === 'cuppedEar') starts.add(d.clip.start);
    each?.(d);
  });
  return [...starts];
}

describe('#115: the cupped-ear mime in MicDenied', () => {
  const CUP_S = MIME_CLIPS.cuppedEar.duration;
  /** One drawn frame's slack (s): the mime starts on the first substep at or after it is due. */
  const SLACK = 0.05;

  test('the mime is the cuppedEar clip, every 10 s', () => {
    expect(MIC_DENIED_MIME).toBe('cuppedEar');
    expect(MIC_DENIED_MIME_S).toBe(10);
  });

  test('entering from Asleep: it waits out the wake clip, then plays at once and every 10 s; nothing reaches the session', () => {
    const h = harness();
    h.session.state = 'MicDenied';
    h.anim({ e: 'wake' }); // rows 2–3: Asleep → MicDenied wakes the bear
    const t0 = h.clock.t / 1000;
    const starts = mimeStarts(h, 25, (d) => {
      if (d.name === 'Waking') expect(d.clip?.name).toBe('wake');
    });
    const wakeEnd = t0 + SESSION_CLIPS.wake.duration;
    expect(starts).toHaveLength(3);
    expect(starts[0]).toBeGreaterThanOrEqual(wakeEnd);
    expect(starts[0]).toBeLessThan(wakeEnd + SLACK);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(MIC_DENIED_MIME_S);
      expect(starts[i]! - starts[i - 1]!).toBeLessThan(MIC_DENIED_MIME_S + SLACK);
    }
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  test('it plays as a reaction: Reacting with the cupped ear, then Idle', () => {
    const h = harness();
    h.session.state = 'MicDenied';
    toIdle(h);
    h.run(3); // the first frame after mount only starts the stepper
    const d = h.view.director();
    expect(d.name).toBe('Reacting');
    expect(d.clip?.name).toBe('cuppedEar');
    expect(d.reaction?.r.priority).toBe(2);
    runFor(h, CUP_S + 0.1);
    expect(h.view.director().name).toBe('Idle');
    expect(h.view.director().clip).toBeNull();
  });

  test("it never cuts a session clip: MicDenied's shrug plays out first", () => {
    const h = harness();
    toIdle(h);
    h.run(5);
    h.session.state = 'MicDenied';
    h.anim({ e: 'shrug' }); // rows 8–9: Waking → MicDenied shrugs
    const shrug = h.view.director().clip;
    expect(shrug?.name).toBe('shrug');
    const end = shrug!.start + SESSION_CLIPS.shrug.duration;
    const starts = mimeStarts(h, 3, (d) => {
      if (h.clock.t / 1000 < end) expect(d.clip?.name).toBe('shrug');
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toBeGreaterThanOrEqual(end);
    expect(starts[0]).toBeLessThan(end + SLACK);
  });

  test('leaving MicDenied stops it, and re-entering plays it at once', () => {
    const h = harness();
    h.session.state = 'MicDenied';
    toIdle(h);
    expect(mimeStarts(h, CUP_S + 0.2)).toHaveLength(1);
    expect(h.view.director().clip).toBeNull();
    h.session.state = 'Listening'; // no anim event
    runFor(h, 30, (d) => expect(d.clip?.name).not.toBe('cuppedEar'));
    h.session.state = 'MicDenied';
    h.run(1);
    expect(h.view.director().clip?.name).toBe('cuppedEar');
  });

  test('to Asleep: no mime while asleep', () => {
    const h = harness();
    h.session.state = 'MicDenied';
    toIdle(h);
    runFor(h, CUP_S + 0.2);
    h.anim({ e: 'sleep' });
    h.session.state = 'Asleep';
    runFor(h, 30, (d) => expect(d.clip?.name).not.toBe('cuppedEar'));
  });

  test('never outside MicDenied: 30 s in Listening', () => {
    const h = awake();
    runFor(h, 30, (d) => expect(d.clip?.name).not.toBe('cuppedEar'));
  });

  test('in Dozing the next mime wakes the bear: Dozing → Reacting → Idle', () => {
    const h = harness();
    h.session.state = 'MicDenied';
    toIdle(h);
    const first = mimeStarts(h, CUP_S + 0.2);
    expect(first).toHaveLength(1);
    h.anim({ e: 'doze' });
    expect(h.view.director().name).toBe('Dozing');
    const next = first[0]! + MIC_DENIED_MIME_S;
    const starts = mimeStarts(h, MIC_DENIED_MIME_S, (d) => {
      if (h.clock.t / 1000 < next) expect(d.name).toBe('Dozing');
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toBeGreaterThanOrEqual(next);
    expect(starts[0]).toBeLessThan(next + SLACK);
    // Played to its end, the bear stays awake in Idle.
    const rest = starts[0]! + CUP_S + 0.1 - h.clock.t / 1000;
    if (rest > 0) runFor(h, rest);
    expect(h.view.director().name).toBe('Idle');
  });
});

// ---- #117: the session's tooLoud reaction ---------------------------------------------------------------------------

describe("#117: the session's tooLoud reaction", () => {
  const LOUD = { e: 'reaction', name: 'tooLoud', priority: 2 } as const;

  test('TOO_LOUD_CLIP and TOO_LOUD_REACTION are tooLoud', () => {
    expect(TOO_LOUD_CLIP).toBe('tooLoud');
    expect(TOO_LOUD_REACTION).toBe('tooLoud');
  });

  test("row 28's effects (talkEnd, then the reaction) play tooLoud as a P2 reaction, then Idle; nothing reaches the session", () => {
    const h = harness();
    h.session.state = 'Playing';
    toThinking(h);
    h.anim({ e: 'talk', id: 1 });
    h.run(3);
    expect(h.view.director().name).toBe('Talking');
    h.session.state = 'Cooldown';
    h.anim({ e: 'talkEnd' });
    h.anim(LOUD);
    const d = h.view.director();
    expect(d.name).toBe('Reacting');
    expect(d.clip?.name).toBe('tooLoud');
    expect(d.reaction?.r.priority).toBe(2);
    runFor(h, MIME_CLIPS.tooLoud.duration + 0.1);
    expect(h.view.director().name).toBe('Idle');
    expect(h.view.director().clip).toBeNull();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  test('reduced motion (or Gentle mode) plays tooLoudGentle', () => {
    const h = harness();
    h.session.state = 'Cooldown';
    h.view.setReducedMotion(true);
    toIdle(h);
    h.anim(LOUD);
    expect(h.view.director().clip?.name).toBe('tooLoudGentle');
  });

  test('any other session reaction stays ignored (#91)', () => {
    const h = harness();
    h.session.state = 'Listening';
    toIdle(h);
    const before = h.view.director();
    h.anim({ e: 'reaction', name: 'sneeze', priority: 2 });
    expect(h.view.director()).toBe(before);
  });
});
