/**
 * The output clock (plan §3.3, §4.5): which context time is at the output device right now.
 * DOM-free: it takes the minimal part of `AudioContext` it reads, so Node tests can pass a fake.
 */

/** The part of `AudioContext` the output clock reads; `AudioContext` satisfies it. */
export interface OutputClockCtx {
  currentTime: number;
  outputLatency?: number;
  getOutputTimestamp(): { contextTime?: number; performanceTime?: number };
}

/**
 * Context time whose audio is at the output device right now.
 *
 * `getOutputTimestamp()` pairs a context time with the `performance.now()` time at which it reaches the
 * output device, so the output latency is already included [V spec]; this extrapolates it to `now()`.
 * Until the context has a timestamp (`performanceTime` 0 or missing), it falls back to
 * `currentTime − outputLatency`.
 */
export function outputContextTimeNow(
  ctx: OutputClockCtx,
  now: () => number = () => performance.now(),
): number {
  const ts = ctx.getOutputTimestamp();
  if (!ts.performanceTime || ts.contextTime === undefined) return ctx.currentTime - (ctx.outputLatency ?? 0);
  return ts.contextTime + (now() - ts.performanceTime) / 1000;
}

/** The shortest wait after a source's `ended` event before its audio counts as having left the speaker. */
export const MIN_END_WAIT_SEC = 0.05;

/**
 * Milliseconds to wait after `ended`, at least: `1000 · max(outputLatency, 50 ms)`. The floor covers
 * Chrome reporting zero delay when AAudio's timestamp call fails (plan §4.4 point 2).
 */
export function minEndWaitMs(ctx: Pick<OutputClockCtx, 'outputLatency'>): number {
  return 1000 * Math.max(ctx.outputLatency || 0, MIN_END_WAIT_SEC);
}

/** Seconds of the clip that have reached the output device (plan §3.3). */
export function clipTimeNow(ctx: OutputClockCtx, scheduledStartCtxTime: number, now?: () => number): number {
  return outputContextTimeNow(ctx, now) - scheduledStartCtxTime;
}
