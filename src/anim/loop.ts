/**
 * The app's one frame loop (plan §4.6.6; issue #81): a single `requestAnimationFrame` callback per frame that
 *
 * 1. computes `frameDt = (t − last) / 1000` from the rAF timestamps of the last drawn frame and this one;
 * 2. runs the fixed-step physics, `stepper.advance(frameDt, dt => scene.substep(dt))` (director tick, springs,
 *    layers: 120 Hz whatever the display rate, dt clamped to 50 ms);
 * 3. lets the scene evaluate the pose and render it (`scene.draw`).
 *
 * **Throttling.** Before drawing, the loop asks `scene.minFrameMs()`: 0 draws every rAF; `1000 / IDLE_FPS` and
 * `1000 / ASLEEP_FPS` draw only once that much time has passed since the last drawn frame (less `FRAME_SLACK_MS`
 * of vsync jitter, so a 60 Hz display draws every 2nd and every 4th frame). It stays dt-based: the drawn frame's
 * `frameDt` is the whole time since the previous drawn frame. `invalidate()` makes the next rAF draw whatever the
 * throttle (an event changed the scene).
 *
 * **Hidden page.** While `visibility.current()` is `'hidden'` no rAF is scheduled; the loop resumes on the next
 * visibility event that finds the page visible, and that first frame has `frameDt = 0`.
 *
 * **Stats.** The main-thread time of each drawn frame (`perfNow()` around steps 2–3) and its rAF time go into two
 * preallocated rings of the last `STATS_FRAMES` drawn frames; `stats()` reports their p95 and the fps.
 *
 * **Allocation.** Nothing allocates per frame: `tick` and the substep callback are created once, and the doubles
 * the loop keeps between frames live in a preallocated `Float64Array` (a double held in a closure variable can be
 * boxed again on every write). `stats()` may allocate; it is for the debug overlay, a few times a second.
 */
import type { Visibility } from '../platform/visibility.ts';
import { Stepper } from './stepper.ts';

/** Frame rate while the bear is idle and nothing but breathing and blinks moves (plan §4.6.6). */
export const IDLE_FPS = 30;
/** Frame rate while the bear is asleep and only breathing moves (plan §4.6.6). */
export const ASLEEP_FPS = 15;
/** vsync jitter tolerance of the throttle, in ms. */
export const FRAME_SLACK_MS = 2;
/** Drawn frames the stats cover: the p95 frame time and the fps are over the last 120 drawn frames. */
export const STATS_FRAMES = 120;

/** What the loop drives. Every method is called from the rAF callback and must not allocate. */
export interface LoopScene {
  /** Called first in every drawn frame with its rAF timestamp `t` (ms), before any substep. */
  beginFrame(t: number): void;
  /** One fixed physics substep of `dt` seconds (`SUBSTEP`): director tick, springs, layers. */
  substep(dt: number): void;
  /** Evaluates and renders the frame at rAF time `t` (ms); `alpha` ∈ [0, 1) is how far past the last substep. */
  draw(t: number, alpha: number): void;
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

export function createFrameLoop(scene: LoopScene, deps: LoopDeps): FrameLoop {
  const { visibility } = deps;
  const requestFrame = deps.requestFrame ?? ((cb: FrameRequestCallback): number => requestAnimationFrame(cb));
  const cancelFrame = deps.cancelFrame ?? ((id: number): void => cancelAnimationFrame(id));
  const perfNow = deps.perfNow ?? ((): number => performance.now());

  const stepper = new Stepper();
  const substep = (dt: number): void => scene.substep(dt);
  const f = new Float64Array(1);
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
    if (last >= 0 && !force) {
      const min = scene.minFrameMs();
      if (min > 0 && t - last < min - FRAME_SLACK_MS) return;
    }
    force = false;
    const t0 = perfNow();
    f[LAST] = t;
    scene.beginFrame(t);
    const alpha = stepper.advance(last >= 0 ? (t - last) / 1000 : 0, substep);
    scene.draw(t, alpha);
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
