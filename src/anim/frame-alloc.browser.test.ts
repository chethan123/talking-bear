/**
 * The transient-allocation smoke of the rAF frame (issues #214, #229, #281), in Vitest Browser Mode.
 *
 * T70's allocation smoke (bear-view.browser.test.ts) bounds the heap a frame *retains*, after a forced GC, so
 * garbage that a scavenge frees leaves no trace there. This test bounds the garbage itself: every byte a frame
 * allocates, short-lived or not, read from `performance.memory.usedJSHeapSize` (byte-exact with
 * `--enable-precise-memory-info`, vitest.config.ts) over a window of frames with no GC inside it.
 *
 * **Method.**
 * - The view: one talking `BearView` (director Talking, every layer on, the mouth on a live envelope: the fake
 *   output clock advances with the rAF time). The control: the same fake rAF scheduler and clock with a frame
 *   callback that only asks for the next frame. One `vsync` function drives both, so the harness's own allocation
 *   (12 B/frame: `clock.t` passed to the fake scheduler) is in both and cancels.
 * - Warm-up: `WARMUP_FRAMES` vsyncs of each, so that V8 has compiled the frame in its mid tier (Maglev), which
 *   runs it for the first ~10 000–20 000 frames of a session and boxes doubles where its optimising tier doesn't.
 * - A window: `gc()`, then `N` vsyncs, reading `usedJSHeapSize` before the first and after each one; bytes per
 *   frame = (last − first) / N. Allocation only adds to the reading, so a reading that drops means a GC ran inside
 *   the window: that window is discarded and measured again, at most `ATTEMPTS` times.
 * - `WINDOWS` windows of each, interleaved (control, then view); per frame = the smallest view window − the
 *   smallest control window. Later view windows drift up as V8 changes tiers inside them (one run after #229:
 *   31.6, 35.0, 38.2, 32.1, 85.7 B; one late window reads ≈ 86 in most runs); control windows spike now and then,
 *   which would make a paired difference negative, so each side takes its own minimum. Every window is at least
 *   the real allocation, so the reading never undercounts it. (A control spike is one frame of ≈ 130–440 KB, about
 *   once in a few thousand control windows, with or without reactions: not the frame's, and unattributed; with V8's
 *   concurrent recompilation off #281 saw 0 in 4 000 windows, against 2 in 5 600 with it on.)
 *
 * **Five phases, one view** (#229, #281).
 * 0. The session's first reaction (#281): right after `idle`, an eye tap plays hardBlinkL (which bumps `annoy`), and
 *    `FIRST_REACTION_FRAMES` vsyncs later its clip and reaction are over (asserted), before talking starts. After
 *    the talking warm-up, `WINDOWS` short windows (`N_RING` frames) of the talking frame, before phase 1's. Before
 *    #281 the hidden classes of that first reaction's `clip` and `reaction` objects died with them, and the first
 *    window's `gc()` dropped the optimized `evaluateFrom`, `tick` and `step` that had embedded them: 2256 B/frame,
 *    also with only the cut clips anchored. See director.ts, "Hidden classes".
 * 1. Talking, as above. The mood is bumped since phase 0 (`annoy` decays with τ 8 s and never reaches 0), and these
 *    are a session's first ≈ 10 000 frames, where V8's mid tier runs `Mood.update`: main's mood.ts before #229 (class
 *    fields, which that tier boxes on every write) reads 26.6 here, a narrow fail (2.6 B), like NC1's.
 * 2. Reacting with a spring ringing: after `talkEnd`, a head-top tap plays tuftBoing, a one-shot clip whose kick
 *    rings the tuft spring (#89, #221). `RING_TAPS` taps one every `RING_PERIOD` vsyncs warm the path; then each
 *    view window of `N_RING` frames starts right after a tap made outside it, once the previous clip has ended and
 *    its 800 ms cooldown is over, so the whole window lies inside the 0.8 s clip with the spring ringing. It covers
 *    the director tick with a one-shot clip, `evaluate` with a clip, the kick cursor and the secondary springs. One
 *    kick per window passes two doubles to `springs.impulse` (≈ 0.5 B/frame, per event), which the reading includes.
 * 3. Reacting with a bumped mood (#281; tuftBoing bumps none): a left-eye tap every `MOOD_PERIOD` vsyncs plays
 *    hardBlinkL (1.0 s), and each accepted one bumps `annoy` by 0.2 (it settles near 0.9); no tap cuts a clip.
 *    `MOOD_TAPS` taps warm the path (hardBlinkL's tracks and eases are new to `sampleClip`); each view window starts
 *    right after an eye tap. It covers the mood layer writing larger non-zero values at V8's optimising tier, which
 *    writes even the pre-#229 class fields in place (0.4–3.4 with them, as with today's mood.ts); phase 1 catches
 *    their mid-tier box.
 * 4. Reacting after a cut (#281): an eye tap, then `CUT_LEAD` vsyncs (0.5 s) into hardBlinkL's 1.0 s clip a tuft
 *    tap cuts it, the session's first cut crossfade (#240), so hardBlinkL is the first `prevClip`; then phase 2's
 *    warm-up and windows again. Before #281 that first `prevClip`'s hidden class died with its objects, and the
 *    first window's `gc()` dropped the optimized `evaluateFrom` that had embedded it: every window then read ≈ 3548
 *    (`evaluateFrom` unoptimized) or ≈ 32 B/frame (mid tier, `sampleClip` not inlined).
 *
 * **Its own file and its own Vitest process.** Test files of one run share a renderer process and a V8 isolate
 * (each gets an iframe of the same page), so code another file ran leaves its JIT state behind: before #229, after
 * bear-view.browser.test.ts the director tick boxed once more per substep and the talking frame read ≈ 76.5 B
 * instead of ≈ 52.5. `pnpm test:browser` therefore runs this file alone in a first `vitest run` (package.json),
 * like the app's single view. Keep this file to this one test.
 */
import { afterEach, expect, test } from 'vitest';
import type { OutputClockCtx } from '../audio/output-clock.ts';
import type { Envelope } from '../dsp/types.ts';
import { mountBearView } from './bear-view.ts';
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
/** A tap on the tuft: tuftBoing, a one-shot clip whose kick rings the tuft spring (#89, #221). */
const TUFT_TAP: Gesture = { g: 'tap', phase: 'down', region: 'headTop', x: 0, y: 0, count: 1 };
/** A tap on the left eye: hardBlinkL, a one-shot P2 clip of 1.0 s that bumps `annoy` by 0.2 (#90, #281). */
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
/**
 * The bound on view − control, in bytes per frame, for every phase (#229, #281; #214 had 72 for the talking frame).
 *
 * - **Why 24, not the issue's 32.** At 32 every must-fail control passes: NC1 27.6, NC2 31.6 and the near-bound
 *   control 31.6 (below). 24 is the worst local reading after #229 (3.6), plus one boxed double (≈ 13 B) as a
 *   conservative margin for CI's Chrome for Testing, × 1.4, rounded up to a multiple of 8: (3.6 + 13) × 1.4 = 23.2.
 * - **Readings after #229**, local Chromium 141, talking / reaction: 10 solo runs 3.6 / 1.2 (one 3.5 / 1.2); 3 full
 *   `pnpm test:browser` runs with Vitest's results cache deleted 3.6 / 1.2; 3 runs after bear-view.browser.test.ts
 *   in the same process 3.6, 3.5, 3.6 / 1.2; 3 runs beside one busy loop per core 3.6 / 1.2, 3.6 / 13.8 (every
 *   reaction view window one box higher), 2.6 / 1.2. Positive control 187.9–268.8.
 * - **Readings after #281**, local Chromium 141, first reaction / talking / reaction / mood / cut: 3 solo runs
 *   0.0 / 2.6 / 1.2 / 3.4 / 1.2, 0.0 / 4.1 / 1.2 / 0.4 / 1.2, 0.0 / 2.6 / 1.2 / 0.4 / 1.2; positive control
 *   190.5–241.9. Phase 0's mood bump moves the talking reading from 3.6 to 2.6–4.1.
 * - **Before #229.** Local: 52.5 (3 runs); 38.5 at 20k frames, 36.9 at 30k (the TurboFan steady state). CI
 *   (`verify`, Chrome for Testing 153, 2026-10-02): e6eedd9 39.2, 36f7674 39.2, be1fbd0 52.4, 26cdabf 40.4, e2850e8
 *   39.2, e8995a8 39.2, 126892a 39.2, 3590bd3 41.0, 70c906c 39.2 (jobs 110891434021, 110898093153, 110912655108,
 *   110917462305, 110923956156, 110929673168, 110942294096, 110960091935, 110964641295). CI never read above local,
 *   and its usual mode (≈ 39) matches the local steady state, so the one box above is a margin, not a measured offset.
 * - **What it catches** (temporary edits, talking / reaction, B/frame): NC1, `stepper.advance` back to returning a
 *   fresh alpha (main's body, the `?:` clamp, called twice by `tick`), 27.6 / 13.2; NC2, a closure per frame in
 *   `tick`, 31.6 / 29.2; NC3, one small object plus one boxed double per frame in the mouth layer, 31.6 / 1.2; NC4,
 *   the director tick back to `isOver(s, a, now)` and `clipEnd` returns, 3.6 / 49.2. The detection floor: one boxed
 *   double per frame passes (loop.ts calling the wrapper `advance` 15.6 / 13.2; the `clipTime` getter back in the
 *   frame log 14.6–15.6 / 13.2); two fail. NC1 fails by only 3.6.
 * - **What #281's windows catch** (first reaction / talking / reaction / mood / cut): NC5, director.ts before #281,
 *   2256.0 / 40.6 / 1.2 / 0.4 / 31.6 and 2256.0 / 21.0 / 1.2 / 0.4 / 31.6 (the cut window reads ≈ 3548 in the
 *   issue's other mode); only the cut clips anchored (#281's first plan), 2256.0 / 53.0 / 1.2 / 0.4 / 1.2 and
 *   2256.0 / 3.7 / 1.2 / 0.4 / 5.0; NC6, the mood layer keeping a small object per update while the mood is
 *   non-zero, 88.0 / 90.6 / 89.2 / 91.4 / 89.2 (2 runs); main's mood.ts before #229, 24.0 / 26.6 / 1.2 / 3.4 / 1.2
 *   and 24.0 / 26.6 / 1.2 / 0.4 / 1.2.
 * - **Inlining-dependent.** `compose`'s `mouthCloseScale(now, …)` takes and returns a double; V8 inlines it here, so
 *   it measures 0. A V8 that didn't would add one box, inside the margin.
 * - **Stop rule** (#229): after GitHub Actions resumes, stop and comment on #229 only if an `[I214 smoke]` reading
 *   exceeds 12 B on two of the first three CI `verify` runs, or exceeds 24 B on any. CI after #229: pending.
 */
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
  `a talking frame (mouth live) and reacting frames (a spring ringing; a bumped mood; after a cut) each allocate at most ${BOUND} B more than the fake rAF harness alone`,
  { timeout: 120_000 },
  () => {
    const gc: unknown = Reflect.get(globalThis, 'gc');
    if (typeof gc !== 'function')
      throw new Error('needs Chromium with --js-flags=--expose-gc (vitest.config.ts)');

    /** hardBlinkL reactions the director accepted: each one bumped `annoy` (its `mood` output). */
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
        if (e.t === 'reaction' && e.name === 'hardBlinkL') hardBlinks++;
      },
      engine: { getProcessed: (id) => (id === 1 ? processed : undefined), context: () => output },
      seed: 1234,
      requestFrame: viewFrames.request,
      cancelFrame: viewFrames.cancel,
      perfNow: () => 0,
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
    console.log(`[I214 smoke] ${report}`);
    expect(perFrame, report).toBeLessThanOrEqual(BOUND);
    expect(ringPerFrame, report).toBeLessThanOrEqual(BOUND);
    expect(moodPerFrame, report).toBeLessThanOrEqual(BOUND);
    expect(cutPerFrame, report).toBeLessThanOrEqual(BOUND);
    expect(firstPerFrame, report).toBeLessThanOrEqual(BOUND);
    expect(positive, report).toBeGreaterThan(BOUND);
  },
);
