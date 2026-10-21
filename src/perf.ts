// Performance marks and measures for the plan §4.10 timing budgets that only the device can check (issue #122).
// They show in a remote DevTools trace, in `performance.getEntriesByName`, and in the debug overlay (`?debug=1`).
//
// - `first-frame` = measure('boot-start' → 'first-bear-frame'); budget ≤ 500 ms on a warm start on D1. main.ts marks
//   `boot-start` as the first statement of its module body, so after its static imports have been fetched and
//   evaluated: the measure is boot (main.ts's own code) → the bear's first frame, as #122 specifies, not navigation →
//   frame. BearView marks `first-bear-frame` right after its frame loop's first `render`, the frame the browser
//   presents first; it calls `markFirstBearFrame` from that frame only.
// - `tap-to-listening` = measure('tap' → 'listening'); budget ≤ 300 ms with the permission already granted. BearView
//   marks `tap` as it dispatches `tapBear`, and keeps it pending only if the tap took the session into Waking (the
//   granted path; a tap into NeedsParent or MicDenied is cancelled at once). The effect runner marks `listening` on
//   every `arm` effect, which only the entry into Listening emits, and cancels a pending tap on `closeMic`, which the
//   entry into Asleep, Paused and Error emits, so a wake that never reached Listening measures nothing. A pending tap
//   is measured by the first Listening entry after it; later entries (every loop) only mark.
//
// Each name keeps one timeline entry: a mark or measure clears the earlier entries of its name first, so a long
// session doesn't grow the performance timeline. The last value of each measure is also kept here, in two numbers
// the debug overlay copies on its text refresh (`readPerfMeasures`). Where `performance` has no User Timing, every
// function is a no-op; a measure whose start mark is missing (a BearView mounted without main.ts, as in the Browser
// Mode tests) records nothing.

/** The mark names (#122). */
export const PERF_MARK = Object.freeze({
  bootStart: 'boot-start',
  firstBearFrame: 'first-bear-frame',
  tap: 'tap',
  listening: 'listening',
} as const);

/** The measure names (#122). */
export const PERF_MEASURE = Object.freeze({
  firstFrame: 'first-frame',
  tapToListening: 'tap-to-listening',
} as const);

/** The last value of each measure, in ms; NaN until it has been measured. */
export interface PerfMeasures {
  firstFrameMs: number;
  tapToListeningMs: number;
}

type Timing = Pick<Performance, 'mark' | 'measure' | 'clearMarks' | 'clearMeasures' | 'getEntriesByName'>;

function userTiming(): Timing | null {
  if (typeof performance === 'undefined') return null;
  const p = performance;
  return typeof p.mark === 'function' &&
    typeof p.measure === 'function' &&
    typeof p.clearMarks === 'function' &&
    typeof p.clearMeasures === 'function' &&
    typeof p.getEntriesByName === 'function'
    ? p
    : null;
}

const timing = userTiming();
let firstMarked = false;
let tapPending = false;
let firstFrameMs = Number.NaN;
let tapToListeningMs = Number.NaN;

/** Marks `name`, replacing its earlier entries; false where it could not. */
function mark(name: string): boolean {
  if (timing === null) return false;
  try {
    timing.clearMarks(name);
    timing.mark(name);
    return true;
  } catch {
    return false;
  }
}

/** Measures `start` → `end` as `name`, replacing its earlier entries: the duration in ms, or NaN. */
function measure(name: string, start: string, end: string): number {
  if (timing === null) return Number.NaN;
  try {
    if (timing.getEntriesByName(start, 'mark').length === 0) return Number.NaN;
    timing.clearMeasures(name);
    return timing.measure(name, start, end).duration;
  } catch {
    return Number.NaN;
  }
}

/** main.ts, first statement: the start of `first-frame`. */
export function markBootStart(): void {
  mark(PERF_MARK.bootStart);
}

/** BearView, after its frame loop's first `render`: ends `first-frame`. Only the first call counts. */
export function markFirstBearFrame(): void {
  if (firstMarked) return;
  firstMarked = true;
  if (mark(PERF_MARK.firstBearFrame)) {
    firstFrameMs = measure(PERF_MEASURE.firstFrame, PERF_MARK.bootStart, PERF_MARK.firstBearFrame);
  }
}

/** BearView, as it dispatches `tapBear`: the start of `tap-to-listening`, pending until Listening or `cancelTap`. */
export function markTap(): void {
  if (mark(PERF_MARK.tap)) tapPending = true;
}

/** The pending tap will not reach Listening (it did not wake the mic, or the wake ended): it measures nothing. */
export function cancelTap(): void {
  tapPending = false;
}

/** The effect runner, on entering Listening (the `arm` effect): ends a pending `tap-to-listening`. */
export function markListening(): void {
  if (!mark(PERF_MARK.listening) || !tapPending) return;
  tapPending = false;
  const d = measure(PERF_MEASURE.tapToListening, PERF_MARK.tap, PERF_MARK.listening);
  if (Number.isFinite(d)) tapToListeningMs = d;
}

/** Copies the last value of each measure into `out` (NaN: none yet) and returns it. */
export function readPerfMeasures(out: PerfMeasures): PerfMeasures {
  out.firstFrameMs = firstFrameMs;
  out.tapToListeningMs = tapToListeningMs;
  return out;
}
