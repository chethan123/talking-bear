/**
 * The app's one frame loop (plan §4.6.6; issue #81): a single `requestAnimationFrame` callback per frame that
 *
 * 1. computes `frameDt = (t − last) / 1000` from the rAF timestamps of the last drawn frame and this one;
 * 2. runs the fixed-step physics on it, `stepper.run(dt => scene.substep(dt))` with each chunk in
 *    `stepper.io[IO_FRAME_DT]` (director tick, springs, layers: 120 Hz whatever the display rate), fed in chunks of
 *    at most `MAX_FRAME_DT` (50 ms);
 * 3. lets the scene evaluate the pose and render it (`scene.draw`), with alpha in `frame[FRAME_ALPHA]`.
 *
 * **Throttling.** Before drawing, the loop asks `scene.minFrameMs()`: 0 draws every rAF; `1000 / IDLE_FPS` and
 * `1000 / ASLEEP_FPS` draw only once that much time has passed since the last drawn frame (less `FRAME_SLACK_MS`
 * of vsync jitter, so a 60 Hz display draws every 2nd and every 4th frame). It stays dt-based: the drawn frame's
 * `frameDt` is the whole time since the previous drawn frame, so a throttled frame loses no animation time (15 fps
 * is 66.7 ms per frame, more than the stepper's 50 ms clamp, hence the chunks). Only a stall is clamped: the time
 * fed is capped at the throttle interval in force plus `MAX_FRAME_DT`, which for an unthrottled frame is the
 * stepper's own 50 ms clamp, and for a throttled one the same 50 ms of stall allowance on top of the interval it
 * skipped by design (the interval in force is the larger of this tick's and the previous tick's `minFrameMs()`, so
 * a forced frame right after a throttled stretch keeps that stretch's time too). `invalidate()` makes the next rAF
 * draw whatever the throttle (an event changed the scene).
 *
 * **Hidden page.** While `visibility.current()` is `'hidden'` no rAF is scheduled; the loop resumes on the next
 * visibility event that finds the page visible, and that first frame has `frameDt = 0`.
 *
 * **Stats.** The main-thread time of each drawn frame (`perfNow()` around steps 2–3) and its rAF time go into two
 * preallocated rings of the last `STATS_FRAMES` drawn frames; `stats()` reports their p95 and the fps.
 *
 * **Allocation.** The loop's own code allocates nothing per frame (nothing retained, no object made): `tick` and
 * the substep callback are created once, and the doubles the loop keeps between frames live in a preallocated
 * `Float64Array` (a double held in a closure variable can be boxed again on every write). No double crosses a call
 * here either: the frame time goes into the stepper and alpha comes back through `stepper.io`, and alpha reaches
 * `draw` in `frame`, because V8 boxes a double passed to or returned from a call it doesn't inline as a new heap
 * number. `?:` choices between a double and an imported constant or a call's return are avoided too: they can
 * keep a tagged value that boxes the double (#229). `stats()` may allocate; it is for the debug overlay, a few
 * times a second.
 */
import type { Visibility } from '../platform/visibility.ts';
import { IO_ALPHA, IO_FRAME_DT, MAX_FRAME_DT, Stepper } from './stepper.ts';

/** Frame rate while the bear is idle and nothing but breathing and blinks moves (plan §4.6.6). */
export const IDLE_FPS = 30;
/** Frame rate while the bear is asleep and only breathing moves (plan §4.6.6). */
export const ASLEEP_FPS = 15;
/** vsync jitter tolerance of the throttle, in ms. */
export const FRAME_SLACK_MS = 2;
/** Drawn frames the stats cover: the p95 frame time and the fps are over the last 120 drawn frames. */
export const STATS_FRAMES = 120;

/** Slot of the `frame` array `LoopScene.draw` receives: alpha ∈ [0, 1), how far the render time is past the last substep. */
export const FRAME_ALPHA = 0;

/** What the loop drives. Every method is called from the rAF callback and must not allocate. */
export interface LoopScene {
  /** Called first in every drawn frame with its rAF timestamp `t` (ms), before any substep. */
  beginFrame(t: number): void;
  /** One fixed physics substep of `dt` seconds (`SUBSTEP`): director tick, springs, layers. */
  substep(dt: number): void;
  /**
   * Evaluates and renders the frame at rAF time `t` (ms); `frame[FRAME_ALPHA]` ∈ [0, 1) is how far past the last
   * substep (alpha). A slot, not a double argument: V8 boxes a double passed to a call it doesn't inline, and it
   * doesn't inline `draw` while the loop throttles (#229).
   */
  draw(t: number, frame: Readonly<Float64Array>): void;
  /** The shortest interval between drawn frames for the scene's current state, in ms: 0 draws every rAF. */
  minFrameMs(): number;
}

export interface LoopDeps {
  visibility: Pick<Visibility, 'current' | 'subscribe'>;
  /** Defaults to `requestAnimationFrame`; tests inject a fake. */
  requestFrame?: (cb: FrameRequestCallback) => number;
  /** Defaults to `cancelAnimationFrame`. */
  cancelFrame?: (id: number) => void;
  /** Milliseconds for the frame-time stats; defaults to `performance.now()`. */
  perfNow?: () => number;
}

export interface FrameStats {
  /** p95 (nearest rank) of the main-thread time per drawn frame, in ms; NaN before the first drawn frame. */
  p95Ms: number;
  /** Drawn frames per second over the same frames; NaN before the second drawn frame. */
  fps: number;
  /** How many drawn frames the numbers cover (≤ `STATS_FRAMES`). */
  frames: number;
}

export interface FrameLoop {
  /** Starts scheduling frames (a no-op while it already is); while the page is hidden it waits for `visible`. */
  start(): void;
  /** Stops scheduling frames until the next `start()`. */
  stop(): void;
  /** Makes the next rAF draw whatever the throttle. */
  invalidate(): void;
  /** Whether a rAF is currently scheduled. */
  readonly scheduled: boolean;
  /** Writes the frame-time p95 and the fps over the last `STATS_FRAMES` drawn frames into `out`; returns it. */
  stats(out: FrameStats): FrameStats;
  /** Stops for good and unsubscribes from the visibility. */
  dispose(): void;
}

// Slots of the loop's double state.
/** rAF time of the last drawn frame, ms; −1 = none since the loop (re)started. */
const LAST = 0;
/** `scene.minFrameMs()` as read by the previous tick, ms. */
const MIN = 1;

export function createFrameLoop(scene: LoopScene, deps: LoopDeps): FrameLoop {
  const { visibility } = deps;
  const requestFrame = deps.requestFrame ?? ((cb: FrameRequestCallback): number => requestAnimationFrame(cb));
  const cancelFrame = deps.cancelFrame ?? ((id: number): void => cancelAnimationFrame(id));
  const perfNow = deps.perfNow ?? ((): number => performance.now());

  const stepper = new Stepper();
  const io = stepper.io;
  const substep = (dt: number): void => scene.substep(dt);
  const f = new Float64Array(2);
  /** What `scene.draw` reads alpha from (`FRAME_ALPHA`). */
  const frame = new Float64Array(1);
  f[LAST] = -1;
  let wanted = false;
  let force = false;
  let rafId = 0;

  // Stats rings: per drawn frame, its main-thread time and its rAF time.
  const work = new Float64Array(STATS_FRAMES);
  const drawnAt = new Float64Array(STATS_FRAMES);
  let drawn = 0;

  function tick(t: number): void {
    rafId = 0;
    if (!wanted || visibility.current() === 'hidden') return;
    rafId = requestFrame(tick);
    const last = f[LAST]!;
    const prevMin = f[MIN]!;
    // Read back from its slot, so every `?:` below chooses between doubles: one choosing between a call's return and
    // a computed double can stay tagged and box the double (measured at Idle 30 fps, #229).
    f[MIN] = scene.minFrameMs();
    const min = f[MIN];
    if (last >= 0 && !force && min > 0 && t - last < min - FRAME_SLACK_MS) return;
    force = false;
    const t0 = perfNow();
    f[LAST] = t;
    scene.beginFrame(t);
    // The whole time since the last drawn frame, capped at the throttle interval in force plus one stall clamp,
    // fed to the stepper in chunks it doesn't clamp (≤ 3 at 15 fps).
    let owed = last >= 0 ? (t - last) / 1000 : 0;
    const cap = (min > prevMin ? min : prevMin) / 1000 + MAX_FRAME_DT;
    if (owed > cap) owed = cap;
    // `stepper.run` is `stepper.advance` with its double input and output in `io` slots. Each chunk,
    // min(owed, MAX_FRAME_DT), is stored by branch: a `?:` between the double and the imported constant stays tagged
    // in both of V8's optimising tiers and boxes the double every frame (measured, #229).
    if (owed < MAX_FRAME_DT) io[IO_FRAME_DT] = owed;
    else io[IO_FRAME_DT] = MAX_FRAME_DT;
    stepper.run(substep);
    for (owed -= MAX_FRAME_DT; owed > 0; owed -= MAX_FRAME_DT) {
      if (owed < MAX_FRAME_DT) io[IO_FRAME_DT] = owed;
      else io[IO_FRAME_DT] = MAX_FRAME_DT;
      stepper.run(substep);
    }
    frame[FRAME_ALPHA] = io[IO_ALPHA]!;
    scene.draw(t, frame);
    const slot = drawn % STATS_FRAMES;
    work[slot] = perfNow() - t0;
    drawnAt[slot] = t;
    drawn++;
  }

  /** Schedules or cancels the next rAF to match `wanted` and the page visibility. */
  function sync(): void {
    if (wanted && visibility.current() !== 'hidden') {
      if (rafId === 0) {
        f[LAST] = -1;
        rafId = requestFrame(tick);
      }
    } else if (rafId !== 0) {
      cancelFrame(rafId);
      rafId = 0;
    }
  }

  const unsubscribe = visibility.subscribe(sync);

  return {
    start() {
      wanted = true;
      sync();
    },
    stop() {
      wanted = false;
      sync();
    },
    invalidate() {
      force = true;
    },
    get scheduled() {
      return rafId !== 0;
    },
    stats(out) {
      const n = Math.min(drawn, STATS_FRAMES);
      out.frames = n;
      if (n === 0) {
        out.p95Ms = Number.NaN;
        out.fps = Number.NaN;
        return out;
      }
      // Slots 0 … n − 1 hold the last n frames (the ring fills from slot 0).
      const part = work.subarray(0, n).toSorted();
      out.p95Ms = part[Math.ceil(0.95 * n) - 1]!;
      const newest = drawnAt[(drawn - 1) % STATS_FRAMES]!;
      const oldest = drawnAt[(drawn - n) % STATS_FRAMES]!;
      out.fps = n >= 2 && newest > oldest ? ((n - 1) * 1000) / (newest - oldest) : Number.NaN;
      return out;
    },
    dispose() {
      wanted = false;
      sync();
      unsubscribe();
    },
  };
}
