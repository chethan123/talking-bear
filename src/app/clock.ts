/**
 * Wall-clock time for UI timers (doze, sleep, processing timeout, waking), injected so tests are
 * deterministic (plan §3.1, §4.9.1). Audio timing never uses it: that runs on capture frames and
 * `AudioContext` time. Node tests use `FakeClock` from `test/fake-clock.ts`.
 */
export interface Clock {
  /** Milliseconds on a monotonic clock (`performance.now()` in the app). */
  now(): number;
  /** Runs `cb` once after `ms` milliseconds; returns an id for `clearTimeout`. */
  setTimeout(cb: () => void, ms: number): number;
  /** Cancels a pending timer; unknown and already-fired ids are ignored. */
  clearTimeout(id: number): void;
}

/** The app's clock: `performance.now` and the global timers. */
export const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (cb, ms) => {
    // Browsers return a number. Node returns a Timeout whose primitive value is its id, which Node's
    // clearTimeout also accepts, so ids are plain numbers in both.
    const handle: unknown = globalThis.setTimeout(cb, ms);
    return Number(handle);
  },
  clearTimeout: (id) => globalThis.clearTimeout(id),
};
