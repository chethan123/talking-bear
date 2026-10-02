/**
 * The transient-allocation smoke of the talking frame (issue #214), in Vitest Browser Mode.
 *
 * T70's allocation smoke (bear-view.browser.test.ts) bounds the heap a frame *retains*, after a forced GC, so
 * garbage that a scavenge frees leaves no trace there. This test bounds the garbage itself: every byte a talking
 * frame allocates, short-lived or not, read from `performance.memory.usedJSHeapSize` (byte-exact with
 * `--enable-precise-memory-info`, vitest.config.ts) over a window of frames with no GC inside it.
 *
 * **Method.**
 * - The view: one talking `BearView` (director Talking, every layer on, the mouth on a live envelope: the fake
 *   output clock advances with the rAF time). The control: the same fake rAF scheduler and clock with a frame
 *   callback that only asks for the next frame. One `vsync` function drives both.
 * - Warm-up: `WARMUP_FRAMES` vsyncs of each, so that V8 has compiled the frame in its mid tier (Maglev), which
 *   runs it for the first ~10 000–20 000 frames of a session and boxes doubles where its optimising tier doesn't.
 * - A window: `gc()`, then `N` vsyncs, reading `usedJSHeapSize` before the first and after each one; bytes per
 *   frame = (last − first) / N. Allocation only adds to the reading, so a reading that drops means a GC ran inside
 *   the window: that window is discarded and measured again, at most `ATTEMPTS` times.
 * - `WINDOWS` windows of each, interleaved (control, then view); per frame = the smallest view window − the
 *   smallest control window. In practice the reading is the first view window after the warm-up: later view
 *   windows drift up as V8 changes tiers (80.5, 83.0, 87.1, 81.1, 129.3 B in one run). Control windows spike now
 *   and then (to 400+ B), which would make a paired difference negative, so each side takes its own minimum.
 *   Every window is at least the real allocation, so the reading never undercounts it.
 *
 * **Its own file and its own Vitest process.** Test files of one run share a renderer process and a V8 isolate
 * (each gets an iframe of the same page), so code another file ran leaves its JIT state behind: after
 * bear-view.browser.test.ts, whose tests mount dozens of views, the director tick boxes once more per substep
 * and the same frame reads ≈ 76.5 B instead of ≈ 52.5 (#229). `pnpm test:browser` therefore runs this file alone
 * in a first `vitest run` (package.json), like the app's single view. Keep this file to this one test.
 */
import { afterEach, expect, test } from 'vitest';
import type { OutputClockCtx } from '../audio/output-clock.ts';
import type { Envelope } from '../dsp/types.ts';
import { mountBearView } from './bear-view.ts';
import type { BearView } from './bear-view.ts';

/** One 60 Hz vsync, in ms. */
const VSYNC = 1000 / 60;
/** The rAF time of the view's first frame, ms; the fake output clock is at context time 0 then. */
const START_MS = 1000;
/** Vsyncs of the view and of the control before the first window. */
const WARMUP_FRAMES = 5000;
/** Frames per window. */
const N = 600;
/** Windows of the control and of the view, interleaved; each side counts its smallest. */
const WINDOWS = 5;
/** Attempts per window when a GC runs inside it. */
const ATTEMPTS = 3;
/**
 * The bound on view − control, in bytes per frame (ORCH-ANSWERs on #214: ≈ 1.4 × the worst of 10 runs, rounded
 * up to a multiple of 8, at most 72).
 *
 * - Readings at #214's head, local Chromium 141: 52.5 in each of 10 solo runs, and 52.5 in each of 3 full
 *   `pnpm test:browser` runs with Vitest's results cache deleted (CI's file order). 1.4 × 52.5 = 73.5 → 80 →
 *   capped at 72. CI (`verify`, Chrome for Testing 153, PR #235 at 0038e97): 39.2 (view 68.4, 67.2, 70.8, 74.2,
 *   69.0; control 30.5, 28.0, 28.0, 28.0, 28.0; positive control 271.1).
 * - Today's main, before #214, reads ≈ 600 (603.3, 603.0).
 * - The 52.5 left is boxing at call boundaries outside the modules #214 fixed: loop.ts `tick` passing `chunk` and
 *   `alpha` (≈ 25), `stepper.advance`'s returned alpha (≈ 12.6), bear-view's `logFrame` reading
 *   `mouth.clipTime` (≈ 12.2), rng.ts event calls (≈ 2). Run in one Vitest process after
 *   bear-view.browser.test.ts, the director tick adds ≈ 24 (76.5). #229 removes these and brings the bound to 32.
 * - What it catches (negative controls, B/frame): a fresh `[x, y]` per drawn part in `render` 2057.8, a fresh
 *   closure per frame passed as the mouth's `now` 100.5, one small object plus one boxed double per frame in the
 *   mouth 80.5, a private double field written per substep in gaze 76.5. So it detects ≥ 2 boxed doubles per
 *   frame locally; one (+12 B) passes. On CI, which reads lower (39.2), it takes ≥ 3 (+36 B).
 */
const BOUND = 72;

/** The garbage of the positive control: written once per frame, so each one dies at the next frame. */
let sink: unknown = null;

interface FakeFrames {
  request: (cb: FrameRequestCallback) => number;
  cancel: (id: number) => void;
  /** Runs the pending callback, if any, like one vsync at `t` ms. */
  step: (t: number) => void;
}

/** A fake rAF scheduler holding the one pending callback the frame loop keeps. */
function fakeFrames(): FakeFrames {
  let pending: FrameRequestCallback | null = null;
  let id = 0;
  return {
    request: (cb) => {
      pending = cb;
      id++;
      return id;
    },
    cancel: (cancelled) => {
      if (cancelled === id) pending = null;
    },
    step: (t) => {
      const cb = pending;
      pending = null;
      if (cb !== null) cb(t);
    },
  };
}

/** The app clock of one scheduler, ms. */
interface Clock {
  t: number;
}

/** One vsync: the clock moves one 60 Hz period and the scheduler runs its pending callback at the new time. */
function vsync(frames: FakeFrames, clock: Clock): void {
  clock.t += VSYNC;
  frames.step(clock.t);
}

/** An envelope of `n` 10 ms frames whose four tracks keep moving (the mouth opens, rounds, shows its teeth). */
function talkingEnvelope(n: number): Envelope {
  const env: Envelope = {
    hopMs: 10,
    jaw: new Float32Array(n),
    width: new Float32Array(n),
    round: new Float32Array(n),
    teeth: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    env.jaw[i] = 0.5 + 0.5 * Math.sin(i / 7);
    env.width[i] = 0.5 + 0.5 * Math.sin(i / 13);
    env.round[i] = 0.5 + 0.5 * Math.sin(i / 17);
    env.teeth[i] = 0.5 + 0.5 * Math.sin(i / 11);
  }
  return env;
}

/** `xs` with one decimal each, comma-separated: the report line. */
function list(xs: readonly number[]): string {
  return xs.map((x) => x.toFixed(1)).join(', ');
}

/** `performance.memory.usedJSHeapSize` (Chromium; byte-exact with --enable-precise-memory-info). */
function usedJSHeapSize(): number {
  const memory: unknown = Reflect.get(performance, 'memory');
  const bytes: unknown =
    typeof memory === 'object' && memory !== null ? Reflect.get(memory, 'usedJSHeapSize') : undefined;
  if (typeof bytes !== 'number') throw new Error('no performance.memory.usedJSHeapSize');
  return bytes;
}

const views: BearView[] = [];

afterEach(() => {
  for (const v of views.splice(0)) v.dispose();
  document.body.replaceChildren();
});

test(
  `a talking frame (mouth live) allocates at most ${BOUND} B more than the fake rAF harness alone`,
  { timeout: 120_000 },
  () => {
    const gc: unknown = Reflect.get(globalThis, 'gc');
    if (typeof gc !== 'function')
      throw new Error('needs Chromium with --js-flags=--expose-gc (vitest.config.ts)');

    // The view: talking, with the mouth on a live envelope. At rAF time t the output is at context time
    // (t − START_MS) / 1000, and the replay started at context time 0.
    const viewFrames = fakeFrames();
    const viewClock: Clock = { t: START_MS - VSYNC };
    const ts = { contextTime: 0, performanceTime: START_MS };
    const output: OutputClockCtx = { currentTime: 0, outputLatency: 0, getOutputTimestamp: () => ts };
    const processed = { envelope: talkingEnvelope(60_000) };
    const root = document.createElement('div');
    document.body.append(root);
    const view = mountBearView(root, {
      visibility: { current: () => 'visible', subscribe: () => () => undefined },
      now: () => viewClock.t,
      state: () => 'Playing',
      dispatch: () => undefined,
      engine: { getProcessed: (id) => (id === 1 ? processed : undefined), context: () => output },
      seed: 1234,
      requestFrame: viewFrames.request,
      cancelFrame: viewFrames.cancel,
      perfNow: () => 0,
    });
    views.push(view);
    view.onAnim({ e: 'idle' });
    view.onAnim({ e: 'attentive' });
    view.onAnim({ e: 'thinking' });
    view.onPlayStarted(1, 0);
    view.onAnim({ e: 'talk', id: 1 });

    // The control: the same scheduler and clock; its frame callback only asks for the next frame.
    const controlFrames = fakeFrames();
    const controlClock: Clock = { t: START_MS - VSYNC };
    const idle = (): void => {
      controlFrames.request(idle);
    };
    controlFrames.request(idle);

    const runView = (): void => {
      vsync(viewFrames, viewClock);
    };
    const runControl = (): void => {
      vsync(controlFrames, controlClock);
    };
    const runViewWithGarbage = (): void => {
      vsync(viewFrames, viewClock);
      sink = new Float64Array(8);
    };

    for (let k = 0; k < WARMUP_FRAMES; k++) {
      runView();
      runControl();
    }

    const readings = new Float64Array(N + 1);
    /** Bytes per frame over one window after a forced GC; NaN if a reading dropped (a GC ran inside it). */
    const measureWindow = (run: () => void): number => {
      gc();
      readings[0] = usedJSHeapSize();
      for (let k = 1; k <= N; k++) {
        run();
        readings[k] = usedJSHeapSize();
      }
      for (let k = 1; k <= N; k++) if (readings[k]! < readings[k - 1]!) return Number.NaN;
      return (readings[N]! - readings[0]) / N;
    };
    /** `measureWindow(run)`, measured again while a GC runs inside it, at most ATTEMPTS times. */
    const measure = (run: () => void): number => {
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const bytes = measureWindow(run);
        if (!Number.isNaN(bytes)) return bytes;
      }
      throw new Error(`a GC ran inside each of ${ATTEMPTS} windows of ${N} frames`);
    };

    const envBefore = view.frameLog().at(-1)?.envIndex ?? -1;
    const controlBytes: number[] = [];
    const viewBytes: number[] = [];
    for (let w = 0; w < WINDOWS; w++) {
      controlBytes.push(measure(runControl));
      viewBytes.push(measure(runView));
    }
    // Each side counts its smallest window: every window is at least the real allocation (see the file doc).
    const control = Math.min(...controlBytes);
    const perFrame = Math.min(...viewBytes) - control;
    // Still talking, the mouth still moving through the envelope, and every vsync drew a frame.
    const last = view.frameLog().at(-1);
    expect(view.director().name).toBe('Talking');
    expect(last?.rafT).toBe(viewClock.t);
    expect(last?.envIndex).toBeGreaterThan(envBefore + 2 * N);
    // Positive control: the meter sees garbage that dies at once (one small typed array per frame).
    const positive = measure(runViewWithGarbage) - control;
    expect(sink).toBeInstanceOf(Float64Array);
    const report =
      `B/frame: view ${list(viewBytes)}; control ${list(controlBytes)}; ` +
      `view − control ${perFrame.toFixed(1)} (bound ${BOUND}); positive control ${positive.toFixed(1)}`;
    console.log(`[I214 smoke] ${report}`);
    expect(perFrame, report).toBeLessThanOrEqual(BOUND);
    expect(positive, report).toBeGreaterThan(BOUND);
  },
);
