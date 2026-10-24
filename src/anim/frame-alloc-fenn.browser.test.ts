/**
 * The transient-allocation smoke of the rAF frame on Fenn (duck plan T126, R1): frame-alloc.browser.test.ts's method,
 * phases, windows and bound, with Fenn on stage. Read that file's doc for the method, the five phases and why the
 * bound is 24 B/frame; only the character and its taps differ here.
 *
 * - Fenn's rig is a second `createRig` shape through the same factory, his mouth is kind 'parts' (no lips branch),
 *   and his cast and reactions table are his own (`FENN.cast`, `FENN.reactionFor`), so the frame runs other data
 *   through the same code, which V8 may have specialised for one character.
 * - Phase 0 and 3: a left-eye tap, `blinkPeepL` (clip hardBlinkL, 1.0 s, sfx peep), which bumps `annoy` by 0.2.
 * - Phase 2: a tuft tap (`headTop`), Juni's tuftBoing, whose kick rings the tuft spring (Fenn's head tuft).
 * - Phase 4: an eye tap cut 0.5 s in by a tuft tap.
 *
 * **Its own file and its own Vitest process**, like the Juni smoke: `pnpm test:browser` runs frame-alloc.browser.test.ts
 * alone, then this file alone, then the rest of the browser project without both (package.json). Keep this file to
 * this one test.
 */
import { afterEach, expect, test } from 'vitest';
import type { OutputClockCtx } from '../audio/output-clock.ts';
import type { Envelope } from '../dsp/types.ts';
import { mountBearView } from './bear-view.ts';
import { FENN } from '../characters/fenn.ts';
import type { Gesture } from '../input/recognizer.ts';
import type { BearView } from './bear-view.ts';
import { Ch } from './pose.ts';

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
/** The reaction phase: a head-top tap (tuftBoing) every `RING_PERIOD` vsyncs, `RING_TAPS` of them as warm-up. */
const RING_PERIOD = 60;
const RING_TAPS = 100;
/** Frames per reaction window, each starting right after a tap: inside tuftBoing's 0.8 s clip. */
const N_RING = 45;
/** A tap on Fenn's tuft (`headTop`): tuftBoing, a one-shot clip whose kick rings the tuft spring (#89, #221). */
const TUFT_TAP: Gesture = { g: 'tap', phase: 'down', region: 'headTop', x: 0, y: 0, count: 1 };
/** A tap on Fenn's left eye: blinkPeepL, the one-shot P2 clip hardBlinkL of 1.0 s, which bumps `annoy` by 0.2. */
const EYE_TAP: Gesture = { g: 'tap', phase: 'down', region: 'eyeL', x: 0, y: 0, count: 1 };
/**
 * The mood phase (#281): an eye tap every `MOOD_PERIOD` vsyncs (2 s: hardBlink's 1.0 s clip and the 0.8 s cooldown fit,
 * so no tap cuts a clip), `MOOD_TAPS` of them as warm-up (6000 vsyncs, like the reaction phase's).
 */
const MOOD_PERIOD = 120;
const MOOD_TAPS = 50;
/** The cut phase (#281): the first tuft tap comes this many vsyncs (0.5 s) into hardBlink's 1.0 s clip and cuts it. */
const CUT_LEAD = 30;
/** Phase 0 (#281): vsyncs after the session's first eye tap, before talking (1.5 s: its 1.0 s clip has ended). */
const FIRST_REACTION_FRAMES = 90;
/** The bound on view − control, in bytes per frame, for every phase: the Juni smoke's (see its doc for why 24). */
const BOUND = 24;

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
  `Fenn: a talking frame (mouth live) and reacting frames (a spring ringing; a bumped mood; after a cut) each allocate at most ${BOUND} B more than the fake rAF harness alone`,
  { timeout: 120_000 },
  () => {
    const gc: unknown = Reflect.get(globalThis, 'gc');
    if (typeof gc !== 'function')
      throw new Error('needs Chromium with --js-flags=--expose-gc (vitest.config.ts)');

    /** blinkPeepL reactions the director accepted: each one bumped `annoy` (its `mood` output). */
    let hardBlinks = 0;
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
      dispatch: (e) => {
        if (e.t === 'reaction' && e.name === 'blinkPeepL') hardBlinks++;
      },
      engine: { getProcessed: (id) => (id === 1 ? processed : undefined), context: () => output },
      seed: 1234,
      requestFrame: viewFrames.request,
      cancelFrame: viewFrames.cancel,
      perfNow: () => 0,
      character: FENN,
    });
    views.push(view);
    view.onAnim({ e: 'idle' });
    // Phase 0 (#281): the session's first reaction, hardBlinkL (which also bumps `annoy`), over before talking starts.
    view.gesture(EYE_TAP);
    for (let k = 0; k < FIRST_REACTION_FRAMES; k++) vsync(viewFrames, viewClock);
    expect(view.director().clip).toBeNull();
    expect(view.director().reaction).toBeNull();
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
    /** Bytes per frame over `n` frames after a forced GC; NaN if a reading dropped (a GC ran inside them). */
    const measureWindow = (run: () => void, n: number): number => {
      gc();
      readings[0] = usedJSHeapSize();
      for (let k = 1; k <= n; k++) {
        run();
        readings[k] = usedJSHeapSize();
      }
      for (let k = 1; k <= n; k++) if (readings[k]! < readings[k - 1]!) return Number.NaN;
      return (readings[n]! - readings[0]) / n;
    };
    /**
     * `measureWindow(run, n)`, measured again while a GC runs inside it, at most ATTEMPTS times; `before` runs before
     * each attempt, outside it.
     */
    const measure = (run: () => void, n = N, before?: () => void): number => {
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        before?.();
        const bytes = measureWindow(run, n);
        if (!Number.isNaN(bytes)) return bytes;
      }
      throw new Error(
        `a GC ran inside each of ${ATTEMPTS} windows of ${n} frames — the frame allocates enough to scavenge inside every window; treat this as a regression, not noise`,
      );
    };

    // Phase 0's windows (#281): short talking windows right after the warm-up, before the talking windows.
    const firstControlBytes: number[] = [];
    const firstViewBytes: number[] = [];
    for (let w = 0; w < WINDOWS; w++) {
      firstControlBytes.push(measure(runControl, N_RING));
      firstViewBytes.push(measure(runView, N_RING));
    }
    const firstPerFrame = Math.min(...firstViewBytes) - Math.min(...firstControlBytes);

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

    // The reaction phase (#229): the same view, after talkEnd, playing tuftBoing with the tuft spring ringing.
    view.onAnim({ e: 'talkEnd' });
    let sinceTap = 0;
    const runViewCounted = (): void => {
      sinceTap++;
      vsync(viewFrames, viewClock);
    };
    /** `period` vsyncs after the last tap (its clip has ended, its cooldown passed), makes `g`, outside any window. */
    const tapAfter = (g: Gesture, period: number): void => {
      const wait = period - sinceTap;
      for (let k = 0; k < wait; k++) {
        runViewCounted();
        runControl();
      }
      view.gesture(g);
      sinceTap = 0;
    };
    /** A tuft tap `RING_PERIOD` vsyncs after the last tap. */
    const tap = (): void => {
      tapAfter(TUFT_TAP, RING_PERIOD);
    };
    /** An eye tap `MOOD_PERIOD` vsyncs after the last tap. */
    const eyeTap = (): void => {
      tapAfter(EYE_TAP, MOOD_PERIOD);
    };
    for (let k = 0; k < RING_TAPS; k++) tap();
    const ringControlBytes: number[] = [];
    const ringViewBytes: number[] = [];
    for (let w = 0; w < WINDOWS; w++) {
      ringControlBytes.push(measure(runControl, N_RING));
      ringViewBytes.push(measure(runViewCounted, N_RING, tap));
      // Still reacting, every vsync drew, and the tuft spring rings (TuftRot is the spring alone: the clip has no track).
      expect(view.director().clip?.name).toBe('tuftBoing');
      expect(view.frameLog().at(-1)?.rafT).toBe(viewClock.t);
      expect(Math.abs(view.pose()[Ch.TuftRot]!)).toBeGreaterThan(0);
    }
    const ringPerFrame = Math.min(...ringViewBytes) - Math.min(...ringControlBytes);

    // The mood phase (#281): hardBlinkL every 2 s, each bumping `annoy` (no cut: the last clip has ended).
    const blinksBefore = hardBlinks;
    for (let k = 0; k < MOOD_TAPS; k++) eyeTap();
    const moodControlBytes: number[] = [];
    const moodViewBytes: number[] = [];
    for (let w = 0; w < WINDOWS; w++) {
      moodControlBytes.push(measure(runControl, N_RING));
      moodViewBytes.push(measure(runViewCounted, N_RING, eyeTap));
      expect(view.director().clip?.name).toBe('hardBlinkL');
      expect(view.director().prevClip).toBeNull();
      expect(view.frameLog().at(-1)?.rafT).toBe(viewClock.t);
    }
    // Every eye tap was accepted, so every one bumped the mood (measure() retries add taps, never remove them).
    expect(hardBlinks - blinksBefore).toBeGreaterThanOrEqual(MOOD_TAPS + WINDOWS);
    const moodPerFrame = Math.min(...moodViewBytes) - Math.min(...moodControlBytes);

    // The cut phase (#281): an eye tap, and 0.5 s into hardBlinkL a tuft tap cuts it (#240: the session's first cut, so
    // hardBlinkL becomes the first `prevClip`); then the reaction phase's warm-up and windows again.
    tapAfter(EYE_TAP, MOOD_PERIOD);
    tapAfter(TUFT_TAP, CUT_LEAD);
    expect(view.director().clip?.name).toBe('tuftBoing');
    expect(view.director().prevClip?.name).toBe('hardBlinkL');
    for (let k = 1; k < RING_TAPS; k++) tap();
    const cutControlBytes: number[] = [];
    const cutViewBytes: number[] = [];
    for (let w = 0; w < WINDOWS; w++) {
      cutControlBytes.push(measure(runControl, N_RING));
      cutViewBytes.push(measure(runViewCounted, N_RING, tap));
      expect(view.director().clip?.name).toBe('tuftBoing');
      expect(view.frameLog().at(-1)?.rafT).toBe(viewClock.t);
      expect(Math.abs(view.pose()[Ch.TuftRot]!)).toBeGreaterThan(0);
    }
    const cutPerFrame = Math.min(...cutViewBytes) - Math.min(...cutControlBytes);

    const report =
      `B/frame: view ${list(viewBytes)}; control ${list(controlBytes)}; ` +
      `view − control ${perFrame.toFixed(1)} (bound ${BOUND}); positive control ${positive.toFixed(1)}; ` +
      `reaction view ${list(ringViewBytes)}; control ${list(ringControlBytes)}; ` +
      `view − control ${ringPerFrame.toFixed(1)} (bound ${BOUND}); ` +
      `mood view ${list(moodViewBytes)}; control ${list(moodControlBytes)}; ` +
      `view − control ${moodPerFrame.toFixed(1)} (bound ${BOUND}); ` +
      `hardBlink-cut view ${list(cutViewBytes)}; control ${list(cutControlBytes)}; ` +
      `view − control ${cutPerFrame.toFixed(1)} (bound ${BOUND}); ` +
      `after-first-reaction view ${list(firstViewBytes)}; control ${list(firstControlBytes)}; ` +
      `view − control ${firstPerFrame.toFixed(1)} (bound ${BOUND})`;
    console.log(`[I214 smoke, Fenn] ${report}`);
    expect(perFrame, report).toBeLessThanOrEqual(BOUND);
    expect(ringPerFrame, report).toBeLessThanOrEqual(BOUND);
    expect(moodPerFrame, report).toBeLessThanOrEqual(BOUND);
    expect(cutPerFrame, report).toBeLessThanOrEqual(BOUND);
    expect(firstPerFrame, report).toBeLessThanOrEqual(BOUND);
    expect(positive, report).toBeGreaterThan(BOUND);
  },
);
