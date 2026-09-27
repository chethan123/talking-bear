// Deterministic `Clock` for Node tests (plan §3.1, §4.9.1). Test-only: never imported by the app.
import type { Clock } from '../src/app/clock.ts';

interface Timer {
  readonly id: number;
  readonly due: number;
  readonly cb: () => void;
}

/**
 * A manual clock. Time moves only in `advance(ms)`, which runs every timer that falls due within the
 * window in due-time order (ties in creation order), including timers scheduled by those callbacks.
 * During a callback, `now()` is that timer's due time.
 */
export class FakeClock implements Clock {
  #now: number;
  #nextId = 1;
  readonly #timers = new Map<number, Timer>();

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  /** Like the browser, a negative or NaN delay counts as 0. Ids start at 1 and are never reused. */
  setTimeout(cb: () => void, ms: number): number {
    const id = this.#nextId++;
    this.#timers.set(id, { id, due: this.#now + (ms > 0 ? ms : 0), cb });
    return id;
  }

  clearTimeout(id: number): void {
    this.#timers.delete(id);
  }

  /** Number of timers still pending. */
  pending(): number {
    return this.#timers.size;
  }

  /** Moves time forward by `ms` (≥ 0), running every timer due up to and including `now() + ms`. */
  advance(ms: number): void {
    if (!(ms >= 0)) throw new RangeError(`advance(ms) needs ms >= 0, got ${ms}`);
    const end = this.#now + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const t of this.#timers.values()) {
        if (
          t.due <= end &&
          (next === undefined || t.due < next.due || (t.due === next.due && t.id < next.id))
        ) {
          next = t;
        }
      }
      if (next === undefined) break;
      this.#timers.delete(next.id);
      this.#now = next.due;
      next.cb();
    }
    this.#now = end;
  }
}
