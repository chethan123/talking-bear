/**
 * Juni on screen (plan §4.6, §7 M4; issue #81): the full-viewport canvas stage that replaced the M1 circle. It
 * owns the canvas, the rig, the pose buffers, the director, the layers, the springs and the frame loop.
 *
 * **Per frame** (loop.ts drives it):
 * - `substep(dt)`, at 120 Hz: director tick, `springs.step(dt)`, the layer weights' ramp, then the always-running
 *   layers (blink, breathing, gaze, ear twitch, mood) into a zeroed layer buffer. The previous substep's buffer is
 *   kept, so the frame can interpolate between the two with the stepper's alpha.
 * - `draw(t, alpha)`: the director's `evaluate` (base crossfade + session clip), plus the interpolated layers
 *   (which carry the gaze and ear springs: those layers are their only writers), then the mouth layer sampling
 *   the processed envelope at `clipTimeNow + L` with `now` = the rAF time, the mouth channels × `mouthCloseScale`,
 *   then reduced motion, then `render`.
 *
 * **Director ← session.** `onAnim(ev)` reduces the director at the app clock's time (`deps.now()`). The director
 * clock is seconds on the `performance.now()` timebase, which rAF timestamps share; it never steps back. `anim`
 * inputs output nothing, so `onAnim` keeps `directorReduce`.
 *
 * **Director → session** (#93). Every other director input goes through `directorStep`: the 120 Hz tick in
 * `substep` (a queued reaction starts on a tick), and the gestures and releases of the pointer input below. The
 * step's new state is stored first, then its outputs are routed: `toSession` → `deps.dispatch`
 * (`session.dispatch`), `haptic` → `deps.haptics.play`, `mood` → the mood layer's `bump`. `session.dispatch` can
 * feed `anim` effects (`talkEnd`) straight back into the director, which must see the new state.
 *
 * **Mouth ← processed envelope.** The effect runner reports each replay's scheduled start through
 * `onPlayStarted(id, startCtxTime)` (the player's `PlayHandle.startCtxTime`), right before the session's
 * `anim talk{id}`. When the director has accepted `talk{id}` and that start is known, the mouth layer gets
 * `engine.getProcessed(id).envelope` and the start. It keeps its own reference to the envelope (mouth features,
 * not audio) until the mouth has closed after talkEnd, then drops it.
 *
 * **Throttling** (`minFrameMs`): 30 fps while the director is Idle or Dozing and nothing moves but breathing and
 * blinks, 15 fps while Asleep and nothing moves but breathing; every frame otherwise. "Moves" is: a clip, a
 * spring with |v| > 1e-3, a layer other than breathing and blink still changing its output (the gaze iris eases
 * with a 15 ms time constant and is no spring; ear twitch and mood too), the 150 ms base crossfade, a live mouth
 * clip, or a layer weight still ramping.
 *
 * **Reduced motion** (`setReducedMotion`; main.ts passes `prefers-reduced-motion: reduce` OR Gentle mode): the
 * squash, sway and wobble channels (`BodySquash`, `BodyLean`, `HeadSquishX/Y`, `TuftRot`, `KerchiefA/B`, and the
 * clip's part of `HeadRot`) × 0.3, every spring ζ ≥ 0.9; blinks, mouth and gaze are kept.
 *
 * **Input** (#93): the pointer adapter (#87) on the canvas, with `hit` = `hitTest` (#85) over the bone matrices
 * of the last drawn pose and the view in **CSS px** (`fitView` of the canvas's CSS size: the adapter's points
 * are CSS px relative to the canvas, never backing-store px). `adapter.tick()` runs in every drawn frame, so a
 * long-press fires without movement. Routing, by the session state (`deps.state()`):
 * - **Asleep, Error, Paused:** every `pointerdown` dispatches `tapBear` ("a tap anywhere").
 * - **Awake** (MicDenied included): a background `tap down` turns the gaze to the point for `LOOK_HOLD_S`, and a
 *   background stroke's moves keep it on the finger. A gesture with a reaction (`reactionFor`, #90) goes to the
 *   director as `{k:'gesture'}` at the director clock; its region is the cooldown key (hug and all-over:
 *   `belly`; a pinch: its first cheek), and a stroke carries `dirX`. A `stroke end` or `longPress end` releases
 *   what that contact started (`{k:'release', region, gesture}`).
 * - **Every state:** the last pointer up (`onRawUp` with `active === 0`, a `pointercancel` included) releases
 *   everything (`{k:'release'}`): pinch, hug, tickle and all-over have no end gesture. `pointerdown` notes the
 *   `down` activation and a `pointerup` the `up` one for the haptics (never a cancel: it grants no activation).
 * Reduced motion also sets the director's `gentle` (gentle clips, no P4 escalation without one).
 *
 * **Allocation.** This module's own code allocates nothing per frame: every buffer is preallocated, the loop's
 * callbacks are created once, and the doubles kept between frames live in a `Float64Array`. A quiet director tick
 * returns `directorStep`'s shared frozen result (no outputs, nothing to route); `adapter.tick()` returns at once
 * with no pointer down; the hit-test bone matrices are only marked stale per frame and recomputed on the next
 * pointer sample. Director transitions (events, gestures, a clip's end) allocate a new director state and their
 * outputs; that is per event, not per frame. Not free yet: once a reaction has bumped the mood, `mood.ts` boxes
 * ≈ 48 B per frame until it decays, which #229 fixes (`mood.ts` is outside #93).
 */
import type { AnimEvent, SessionEvent, StateName } from '../app/events.ts';
import { AWAKE } from '../app/machine.ts';
import type { OutputClockCtx } from '../audio/output-clock.ts';
import type { Envelope } from '../dsp/types.ts';
import { attachPointerAdapter } from '../input/pointer-adapter.ts';
import type { Gesture, PointerSample } from '../input/recognizer.ts';
import type { RegionId } from '../input/region-ids.ts';
import { hitTest, REGIONS } from '../input/regions.ts';
import type { Haptics } from '../platform/haptics.ts';
import type { Visibility } from '../platform/visibility.ts';
import { reactionFor } from '../reactions/table.ts';
import { DISPLAY_LATENCY_MS } from './constants.ts';
import { directorReduce, directorStep, evaluate, initialDirector, mouthCloseScale } from './director.ts';
import type { DirectorState, DirInput, DirOut, GestureInput } from './director.ts';
import { createBlink, createBreathing, createEarTwitch, createGaze, createMood } from './layers/index.ts';
import type { AnimContext, LayerWeights, LookAt } from './layers/index.ts';
import { MouthLayer } from './layers/mouth.ts';
import { ASLEEP_FPS, createFrameLoop, IDLE_FPS } from './loop.ts';
import type { FrameStats } from './loop.ts';
import { Ch, CH_COUNT, createPose } from './pose.ts';
import type { Pose } from './pose.ts';
import { createContext, fitView, render, resizeCanvas } from './renderer.ts';
import type { View } from './renderer.ts';
import { BONE_COUNT, boneIndex, boneMatrices, createRig, MAT } from './rig.ts';
import { mulberry32 } from './rng.ts';
import { SpringBank } from './springs.ts';
import { configureSprings, SPRING, SPRING_COUNT } from './springs-map.ts';

/** Reduced motion scales the squash, sway and wobble channels by this (plan §4.6.6). */
export const REDUCED_MOTION_SCALE = 0.3;
/** Reduced motion's floor on every spring's damping ratio (plan §4.6.6). */
export const REDUCED_MOTION_MIN_ZETA = 0.9;
/** A spring moving faster than this (|v|, units/s) keeps the loop at full rate. */
export const SPRING_REST_SPEED = 1e-3;
/**
 * A layer channel whose value changed by more than this between the last two substeps (in its own units: design
 * units, radians, 0–1) keeps the loop at full rate.
 */
export const LAYER_REST_DELTA = 1e-4;
/** The director's base crossfade (plan §3.5): the loop runs at full rate while one is in progress. */
const BASE_FADE_S = 0.15;
/** Layer weights ramp to a new state's values over this long, like the base crossfade. */
export const WEIGHT_RAMP_S = 0.15;
/** Frames `frameLog()` keeps (X-A2 logging). */
export const FRAME_LOG_SIZE = 600;
/** How long the gaze holds a background touch's point (s): a tap's, or a background stroke's latest move (#93). */
export const LOOK_HOLD_S = 2;
/** The X-A2 override `?L=<ms>` is clamped to this range. */
export const LATENCY_OVERRIDE_MAX_MS = 200;
/** Default seed of the layers' RNG; main.ts passes a random one. */
const DEFAULT_SEED = 0x5eed;

/**
 * The layer channels whose motion keeps the loop at full rate: every channel except the breathing layer's
 * (`BodySquash`, `BellyJiggle`) and the blink layer's (`LidL`, `LidR`), which plan §4.6.6 lets run throttled.
 */
const WATCHED_LAYER_CHANNELS: readonly number[] = Array.from({ length: CH_COUNT }, (_, ch) => ch).filter(
  (ch) => ch !== Ch.BodySquash && ch !== Ch.BellyJiggle && ch !== Ch.LidL && ch !== Ch.LidR,
);

/** The channels reduced motion scales by `REDUCED_MOTION_SCALE` (besides the clip's part of `HeadRot`). */
const REDUCED_CHANNELS: readonly number[] = [
  Ch.BodySquash,
  Ch.BodyLean,
  Ch.HeadSquishX,
  Ch.HeadSquishY,
  Ch.TuftRot,
  Ch.KerchiefA,
  Ch.KerchiefB,
];

/** The weights of the always-running layers in a director state: only breathing while Asleep; no gaze while Dozing. */
const WEIGHTS_ASLEEP: Readonly<LayerWeights> = { blink: 0, breathing: 1, gaze: 0, ears: 0 };
const WEIGHTS_DOZING: Readonly<LayerWeights> = { blink: 1, breathing: 1, gaze: 0, ears: 1 };
const WEIGHTS_AWAKE: Readonly<LayerWeights> = { blink: 1, breathing: 1, gaze: 1, ears: 1 };

function weightsFor(s: DirectorState): Readonly<LayerWeights> {
  if (s.name === 'Asleep') return WEIGHTS_ASLEEP;
  if (s.name === 'Dozing') return WEIGHTS_DOZING;
  return WEIGHTS_AWAKE;
}

/**
 * The display-latency compensation L from a `?L=<ms>` query (X-A2, plan §4.6.2): the number clamped to
 * [0, `LATENCY_OVERRIDE_MAX_MS`], or `DISPLAY_LATENCY_MS` when there is no `L` or it isn't a finite number.
 */
export function latencyFromQuery(search: string): number {
  const raw = new URLSearchParams(search).get('L');
  if (raw === null || raw.trim() === '') return DISPLAY_LATENCY_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return DISPLAY_LATENCY_MS;
  return Math.min(LATENCY_OVERRIDE_MAX_MS, Math.max(0, ms));
}

/** One drawn frame of the X-A2 log. */
export interface FrameLogEntry {
  /** The frame's rAF timestamp, ms (the `performance.now()` timebase). */
  rafT: number;
  /** The mouth layer's clip time (s, L included) for this frame; null without a mouth clip. */
  clipTime: number | null;
  /** The envelope frame index the mouth used; −1 outside the clip or without one. */
  envIndex: number;
}

export interface BearViewDeps {
  visibility: Pick<Visibility, 'current' | 'subscribe'>;
  /** Monotonic milliseconds on the `performance.now()` timebase (the app clock): director time for events and input. */
  now(): number;
  /** The session's current state: routes the pointer input (wake taps; gestures only while awake). */
  state(): StateName;
  /** `session.dispatch`: wake taps (`tapBear`) and the director's `toSession` reactions. */
  dispatch(e: SessionEvent): void;
  /** The haptics (`createHaptics`): the director's `haptic` patterns and the pointer activations; none without. */
  haptics?: Pick<Haptics, 'play' | 'noteActivation'>;
  /** The audio engine's parts the mouth reads (`Engine` satisfies it). */
  engine: {
    /** The processed result of replay `id` while it is stored (`Engine.getProcessed`). */
    getProcessed(id: number): { envelope: Envelope } | undefined;
    /** The output clock's context: the `AudioContext`, or null before it exists. */
    context(): OutputClockCtx | null;
  };
  /** Seed of the layers' RNG (blinks, saccades, ear twitches). */
  seed?: number;
  /** The display-latency compensation L in ms; defaults to `DISPLAY_LATENCY_MS`. */
  latencyMs?: number;
  /** Defaults to `requestAnimationFrame`; tests inject a fake. */
  requestFrame?: (cb: FrameRequestCallback) => number;
  /** Defaults to `cancelAnimationFrame`. */
  cancelFrame?: (id: number) => void;
  /** Milliseconds for the frame-time stats; defaults to `performance.now()`. */
  perfNow?: () => number;
  /** Defaults to `window.devicePixelRatio`. */
  devicePixelRatio?: () => number;
}

export interface BearView {
  readonly canvas: HTMLCanvasElement;
  /** A session `anim` effect. */
  onAnim(ev: AnimEvent): void;
  /** The effect runner started replay `id`; its first sample is scheduled at context time `startCtxTime`. */
  onPlayStarted(id: number, startCtxTime: number): void;
  /** Reduced motion on or off (`prefers-reduced-motion: reduce` or Gentle mode). */
  setReducedMotion(on: boolean): void;
  readonly reducedMotion: boolean;
  /** The director's current state. */
  director(): Readonly<DirectorState>;
  /**
   * A recognised gesture, as the pointer adapter hands it over (exposed for tests). While the session is awake, a
   * background tap or stroke moves the gaze, a gesture with a reaction goes to the director, and a stroke or
   * long-press end releases what its contact started.
   */
  gesture(g: Gesture): void;
  /**
   * The centre of region `id`'s first `REGIONS` entry in viewport CSS px, from the bone matrices of the last drawn
   * pose (e2e: `__bearTest.regionCenter`). Throws a RangeError for an id without a region (`background`).
   */
  regionCenter(id: RegionId): { x: number; y: number };
  /** The point the gaze holds after a background touch (design units), or null. */
  lookAt(): Readonly<LookAt> | null;
  /** The pose of the last drawn frame (the live buffer: read it, never write it). */
  pose(): Readonly<Pose>;
  /** The loop's frame-time p95 and fps over its last 120 drawn frames, into `out` (a new object by default). */
  frameStats(out?: FrameStats): FrameStats;
  /** The last `FRAME_LOG_SIZE` drawn frames, oldest first (X-A2 logging). */
  frameLog(): FrameLogEntry[];
  /**
   * E2E screenshots: stops the frame loop for good, sizes the canvas to `cssWidth × cssHeight` CSS px at DPR 1
   * (class `stage--fixed`, no inline size), fits the design box and renders `pose` once.
   */
  showPose(pose: Pose, cssWidth: number, cssHeight: number): void;
  /** Stops the loop, detaches the pointer adapter, removes the listeners and the canvas. */
  dispose(): void;
}

// Slots of the double state kept between frames.
/** Director clock, s: never steps back. */
const NOW = 0;
/** rAF timestamp of the frame being drawn, ms: the mouth layer's `now`. */
const FRAME_T = 1;
/** `startCtxTime` of the replay `playId`. */
const PLAY_START = 2;
/** The last frame's alpha, for a redraw outside the loop (resize). */
const ALPHA = 3;
/** Director time (s) at which the background gaze lets go. */
const LOOK_UNTIL = 4;
/** The latest pointer sample's position, CSS px relative to the canvas. */
const SAMPLE_X = 5;
const SAMPLE_Y = 6;
/** The session states in which any `pointerdown` wakes the bear (Paused never sees one while visible). */
const TAP_TO_WAKE: ReadonlySet<StateName> = new Set<StateName>(['Asleep', 'Error', 'Paused']);

export function mountBearView(root: HTMLElement, deps: BearViewDeps): BearView {
  const { engine } = deps;
  const dpr = deps.devicePixelRatio ?? ((): number => window.devicePixelRatio || 1);

  const canvas = document.createElement('canvas');
  canvas.className = 'stage';
  root.append(canvas);
  const g = createContext(canvas);
  const rig = createRig();
  const view: View = { scale: 0, ox: 0, oy: 0 };
  /** `view` in CSS px of the canvas: hit tests, `regionCenter` and the gaze map pointer points through it. */
  const cssView: View = { scale: 1, ox: 0, oy: 0 };

  const T = new Float64Array(7);
  T[NOW] = deps.now() / 1000;

  // ---- director, layers, springs, mouth ------------------------------------------------------------------
  let dir: DirectorState = initialDirector(T[NOW]);
  const tickIn: { k: 'tick'; now: number } = { k: 'tick', now: 0 };
  const springs = new SpringBank(SPRING_COUNT);
  configureSprings(springs);
  const weights: LayerWeights = { ...WEIGHTS_ASLEEP };
  const ctx: AnimContext = { rng: mulberry32(deps.seed ?? DEFAULT_SEED), weights, lookAt: null, springs };
  const blink = createBlink();
  const breathing = createBreathing();
  const gaze = createGaze({ headRot: SPRING.headRot, headTilt: SPRING.headTilt });
  const ears = createEarTwitch({ earL: SPRING.earL, earR: SPRING.earR });
  const mood = createMood();
  const mouth = new MouthLayer(deps.latencyMs ?? DISPLAY_LATENCY_MS);
  const mouthNow = (): number => T[FRAME_T]!;

  /** The layers' contribution at the previous and the latest substep. */
  const prevLayers = createPose();
  const curLayers = createPose();
  /** The pose being drawn. */
  const pose = createPose();
  /** The director's pose without its clip (reduced motion's `HeadRot`). */
  const noClipPose = createPose();
  let noClipOf: DirectorState | null = null;
  let noClipDir: DirectorState = dir;

  let reduced = false;
  let posed = false;
  /** The replay the effect runner started last; −1 before any. */
  let playId = -1;
  /** The replay whose envelope the mouth layer holds; −1 = none. */
  let mouthId = -1;

  // ---- X-A2 frame log: a preallocated ring ------------------------------------------------------------------
  const logT = new Float64Array(FRAME_LOG_SIZE);
  const logClip = new Float64Array(FRAME_LOG_SIZE);
  const logIndex = new Float64Array(FRAME_LOG_SIZE);
  let logged = 0;

  /** Moves the director clock to `sec` unless that would step back; returns the clock. */
  function advanceNow(sec: number): number {
    if (sec > T[NOW]!) T[NOW] = sec;
    return T[NOW]!;
  }

  /** `dir` without its clip, cached per director state so it allocates only when the state changes. */
  function withoutClip(s: DirectorState): DirectorState {
    if (s !== noClipOf) {
      noClipOf = s;
      noClipDir = s.clip === null ? s : { ...s, clip: null };
    }
    return noClipDir;
  }

  /** Moves each layer weight toward the director state's value by at most dt / WEIGHT_RAMP_S. */
  function rampWeights(dt: number): void {
    const target = weightsFor(dir);
    const step = dt / WEIGHT_RAMP_S;
    weights.blink = toward(weights.blink, target.blink, step);
    weights.breathing = toward(weights.breathing, target.breathing, step);
    weights.gaze = toward(weights.gaze, target.gaze, step);
    weights.ears = toward(weights.ears, target.ears, step);
  }

  function weightsRamping(): boolean {
    const target = weightsFor(dir);
    return (
      weights.blink !== target.blink ||
      weights.breathing !== target.breathing ||
      weights.gaze !== target.gaze ||
      weights.ears !== target.ears
    );
  }

  /** Whether a watched layer channel changed by more than `LAYER_REST_DELTA` over the last substep. */
  function layersMoving(): boolean {
    for (let k = 0; k < WATCHED_LAYER_CHANNELS.length; k++) {
      const ch = WATCHED_LAYER_CHANNELS[k]!;
      const d = curLayers[ch]! - prevLayers[ch]!;
      if (d > LAYER_REST_DELTA || d < -LAYER_REST_DELTA) return true;
    }
    return false;
  }

  function springsMoving(): boolean {
    const v = springs.vel;
    for (let i = 0; i < v.length; i++) {
      const x = v[i]!;
      if (x > SPRING_REST_SPEED || x < -SPRING_REST_SPEED) return true;
    }
    return false;
  }

  /** Starts the mouth on the replay the director is talking for, once its start is known. */
  function startMouth(): void {
    const talk = dir.talk;
    if (talk === null || talk.id !== playId || mouthId === playId) return;
    const p = engine.getProcessed(playId);
    if (p === undefined) return;
    mouth.setClip(p.envelope, T[PLAY_START]!);
    mouthId = playId;
  }

  // ---- the frame -------------------------------------------------------------------------------------------
  function substep(dt: number): void {
    tickIn.now = T[NOW]!;
    // A queued reaction starts on a tick, which outputs it like a gesture (#93). A quiet tick returns the shared
    // frozen result, with nothing to route.
    const r = directorStep(dir, tickIn);
    dir = r.state;
    if (r.out.length !== 0) route(r.out);
    springs.step(dt);
    rampWeights(dt);
    prevLayers.set(curLayers);
    curLayers.fill(0);
    if (weights.blink > 0) blink.update(dt, curLayers, ctx);
    if (weights.breathing > 0) breathing.update(dt, curLayers, ctx);
    if (weights.gaze > 0) gaze.update(dt, curLayers, ctx);
    if (weights.ears > 0) ears.update(dt, curLayers, ctx);
    mood.update(dt, curLayers, ctx);
  }

  /** Writes the frame's pose at director time `now` with layer interpolation `alpha` into `pose`. */
  function compose(now: number, alpha: number): void {
    evaluate(dir, now, pose);
    if (reduced && dir.clip !== null) {
      evaluate(withoutClip(dir), now, noClipPose);
      const base = noClipPose[Ch.HeadRot]!;
      pose[Ch.HeadRot] = base + (pose[Ch.HeadRot]! - base) * REDUCED_MOTION_SCALE;
    }
    for (let i = 0; i < CH_COUNT; i++) {
      const a = prevLayers[i]!;
      pose[i] = pose[i]! + a + (curLayers[i]! - a) * alpha;
    }
    const audio = engine.context();
    if (mouthId !== -1 && audio !== null) mouth.update(pose, audio, mouthNow);
    else zeroMouth(pose);
    const close = mouthCloseScale(now, dir.mouthCloseStart);
    if (close !== 1) {
      pose[Ch.Jaw] = pose[Ch.Jaw]! * close;
      pose[Ch.MouthW] = pose[Ch.MouthW]! * close;
      pose[Ch.MouthRound] = pose[Ch.MouthRound]! * close;
      pose[Ch.Teeth] = pose[Ch.Teeth]! * close;
    }
    // The mouth has closed after talkEnd: drop the envelope.
    if (mouthId !== -1 && dir.talk === null && close === 0) {
      mouth.setClip(null, 0);
      mouthId = -1;
    }
    if (reduced) {
      for (let k = 0; k < REDUCED_CHANNELS.length; k++) {
        const ch = REDUCED_CHANNELS[k]!;
        pose[ch] = pose[ch]! * REDUCED_MOTION_SCALE;
      }
    }
  }

  function logFrame(t: number): void {
    const slot = logged % FRAME_LOG_SIZE;
    logT[slot] = t;
    logClip[slot] = mouthId === -1 ? Number.NaN : mouth.clipTime;
    logIndex[slot] = mouthId === -1 ? -1 : mouth.envIndex;
    logged++;
  }

  const loop = createFrameLoop(
    {
      beginFrame(t) {
        T[FRAME_T] = t;
        advanceNow(t / 1000);
        if (ctx.lookAt !== null && T[NOW]! >= T[LOOK_UNTIL]!) ctx.lookAt = null;
        adapter.tick();
      },
      substep,
      draw(t, alpha) {
        T[ALPHA] = alpha;
        compose(T[NOW]!, alpha);
        bonesStale = true;
        render(g, rig, pose, view);
        logFrame(t);
      },
      minFrameMs() {
        const s = dir;
        const moving =
          s.clip !== null ||
          mouthId !== -1 ||
          T[NOW]! - s.fadeStart < BASE_FADE_S ||
          springsMoving() ||
          layersMoving() ||
          weightsRamping();
        if (moving) return 0;
        if (s.name === 'Asleep') return 1000 / ASLEEP_FPS;
        if (s.name === 'Idle' || s.name === 'Dozing') return 1000 / IDLE_FPS;
        return 0;
      },
    },
    {
      visibility: deps.visibility,
      requestFrame: deps.requestFrame,
      cancelFrame: deps.cancelFrame,
      perfNow: deps.perfNow,
    },
  );

  // ---- canvas size -----------------------------------------------------------------------------------------
  /** Redraws the current pose outside the loop (a resize clears the backing store). */
  function redraw(): void {
    const t = deps.now();
    T[FRAME_T] = t;
    compose(advanceNow(t / 1000), T[ALPHA]!);
    bonesStale = true;
    render(g, rig, pose, view);
  }

  function resize(): void {
    if (posed) return;
    // Read both CSS sizes first: without a CSS size, a canvas's layout size follows its width/height attributes.
    const cssW = Math.max(1, canvas.clientWidth);
    const cssH = Math.max(1, canvas.clientHeight);
    resizeCanvas(canvas, cssW, cssH, dpr());
    fitView(canvas.width, canvas.height, view);
    fitView(cssW, cssH, cssView);
    redraw();
  }

  // ---- input (#93): pointer adapter → recogniser → reactions table → director → session ------------------------
  /** The bone matrices of the last drawn pose for hit tests; stale once a frame is drawn, recomputed on demand. */
  const hitBones = new Float32Array(BONE_COUNT * MAT);
  let bonesStale = true;
  /** The gaze target of a background touch (design units), `ctx.lookAt` while held. */
  const look: LookAt = { x: 0, y: 0 };
  /** The pointer id of the latest sample; the background stroke's pointer the gaze follows (null: none). */
  let sampleId = 0;
  let trackId: number | null = null;

  function bones(): Float32Array {
    if (bonesStale) {
      boneMatrices(rig, pose, hitBones);
      bonesStale = false;
    }
    return hitBones;
  }

  /** The region under a point in CSS px relative to the canvas, as the adapter's samples are. */
  function hit(x: number, y: number): RegionId {
    return hitTest(x, y, bones(), cssView);
  }

  /** The director clock for a pointer input (s): the app clock, never stepping back. */
  function inputNow(): number {
    return advanceNow(deps.now() / 1000);
  }

  /** The gaze looks at a canvas point (CSS px) until `LOOK_HOLD_S` after `now`. */
  function lookAtCss(x: number, y: number, now: number): void {
    look.x = (x - cssView.ox) / cssView.scale;
    look.y = (y - cssView.oy) / cssView.scale;
    ctx.lookAt = look;
    T[LOOK_UNTIL] = now + LOOK_HOLD_S;
    loop.invalidate();
  }

  /** Routes a director step's outputs, in order, without keeping `out`. */
  function route(out: readonly DirOut[]): void {
    for (let i = 0; i < out.length; i++) {
      const o = out[i]!;
      switch (o.k) {
        case 'toSession':
          deps.dispatch(o.ev);
          break;
        case 'haptic':
          deps.haptics?.play(o.pattern);
          break;
        case 'mood':
          if (o.joy !== undefined) mood.bump('joy', o.joy);
          if (o.annoy !== undefined) mood.bump('annoy', o.annoy);
          break;
      }
    }
  }

  /** A pointer input's director step: the new state is stored before its outputs are routed. */
  function stepDirector(input: DirInput): void {
    const r = directorStep(dir, input);
    dir = r.state;
    route(r.out);
    loop.invalidate();
  }

  /** A background tap turns the gaze to it; a background stroke's moves keep it on the finger (`onSample`). */
  function backgroundGaze(ges: Extract<Gesture, { g: 'tap' | 'stroke' }>, now: number): void {
    if (ges.g === 'tap') {
      if (ges.phase === 'down') lookAtCss(ges.x, ges.y, now);
    } else if (ges.phase === 'start') {
      trackId = sampleId;
      lookAtCss(T[SAMPLE_X]!, T[SAMPLE_Y]!, now);
    } else if (ges.phase === 'end') {
      trackId = null;
    }
  }

  function onGesture(ges: Gesture): void {
    if (!AWAKE.has(deps.state())) return;
    const now = inputNow();
    if ((ges.g === 'tap' || ges.g === 'stroke') && ges.region === 'background') backgroundGaze(ges, now);
    const r = reactionFor(ges);
    if (r !== null) {
      const input: GestureInput = { k: 'gesture', r, region: regionOf(ges), gesture: ges.g, now };
      if (ges.g === 'stroke') input.dirX = Math.cos(ges.dir) >= 0 ? 1 : -1;
      stepDirector(input);
    } else if ((ges.g === 'stroke' || ges.g === 'longPress') && ges.phase === 'end') {
      stepDirector({ k: 'release', now, region: ges.region, gesture: ges.g });
    }
  }

  const adapter = attachPointerAdapter(canvas, {
    hit,
    onGesture,
    onRawDown() {
      deps.haptics?.noteActivation('down');
      if (TAP_TO_WAKE.has(deps.state())) deps.dispatch({ t: 'tapBear' });
    },
    onRawUp(e) {
      if (!e.cancel) deps.haptics?.noteActivation('up');
      if (e.active === 0) stepDirector({ k: 'release', now: inputNow() });
    },
    onSample(smp: PointerSample) {
      sampleId = smp.id;
      T[SAMPLE_X] = smp.x;
      T[SAMPLE_Y] = smp.y;
      if (smp.id !== trackId) return;
      if (smp.type === 'move') lookAtCss(smp.x, smp.y, inputNow());
      else if (smp.type === 'up' || smp.type === 'cancel') trackId = null;
    },
  });

  function regionCenter(id: RegionId): { x: number; y: number } {
    const r = REGIONS.find((d) => d.id === id);
    if (r === undefined) throw new RangeError(`regionCenter: no hit region ${id}`);
    const m = bones();
    const o = boneIndex(r.bone) * MAT;
    const x = m[o]! * r.cx + m[o + 2]! * r.cy + m[o + 4]!;
    const y = m[o + 1]! * r.cx + m[o + 3]! * r.cy + m[o + 5]!;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + cssView.ox + cssView.scale * x, y: rect.top + cssView.oy + cssView.scale * y };
  }

  window.addEventListener('resize', resize);
  resize();
  loop.start();

  return {
    canvas,
    onAnim(ev) {
      const now = advanceNow(deps.now() / 1000);
      const input: DirInput = { k: 'anim', ev, now };
      dir = directorReduce(dir, input);
      if (ev.e === 'talk') startMouth();
      loop.invalidate();
    },
    onPlayStarted(id, startCtxTime) {
      playId = id;
      T[PLAY_START] = startCtxTime;
      startMouth();
    },
    setReducedMotion(on) {
      reduced = on;
      configureSprings(springs, on ? REDUCED_MOTION_MIN_ZETA : 0);
      dir = directorReduce(dir, { k: 'setGentle', on });
      loop.invalidate();
    },
    get reducedMotion() {
      return reduced;
    },
    director: () => dir,
    gesture: onGesture,
    regionCenter,
    lookAt: () => ctx.lookAt ?? null,
    pose: () => pose,
    frameStats(out = { p95Ms: Number.NaN, fps: Number.NaN, frames: 0 }) {
      return loop.stats(out);
    },
    frameLog() {
      const n = Math.min(logged, FRAME_LOG_SIZE);
      const out: FrameLogEntry[] = [];
      for (let k = logged - n; k < logged; k++) {
        const slot = k % FRAME_LOG_SIZE;
        const clip = logClip[slot]!;
        out.push({
          rafT: logT[slot]!,
          clipTime: Number.isNaN(clip) ? null : clip,
          envIndex: logIndex[slot]!,
        });
      }
      return out;
    },
    showPose(p, cssWidth, cssHeight) {
      posed = true;
      loop.stop();
      canvas.classList.add('stage--fixed');
      resizeCanvas(canvas, cssWidth, cssHeight, 1);
      fitView(canvas.width, canvas.height, view);
      fitView(cssWidth, cssHeight, cssView);
      render(g, rig, p, view);
    },
    dispose() {
      loop.dispose();
      adapter.detach();
      window.removeEventListener('resize', resize);
      canvas.remove();
    },
  };
}

/**
 * The region of a gesture's reaction, the director's cooldown key: the region-less gestures get a fixed one (hug
 * and all-over: `belly`; a pinch: its first cheek; ORCH-NOTE 5955249579 item 4). `cancel` has no reaction.
 */
function regionOf(ges: Gesture): RegionId {
  switch (ges.g) {
    case 'hug':
    case 'allOver':
      return 'belly';
    case 'pinch':
      return ges.regions[0];
    case 'cancel':
      return 'background';
    default:
      return ges.region;
  }
}

/** `x` moved toward `target` by at most `step`. */
function toward(x: number, target: number, step: number): number {
  const d = target - x;
  return d > step ? x + step : d < -step ? x - step : target;
}

function zeroMouth(p: Pose): void {
  p[Ch.Jaw] = 0;
  p[Ch.MouthW] = 0;
  p[Ch.MouthRound] = 0;
  p[Ch.Teeth] = 0;
}
