/**
 * The gesture recogniser (plan §4.6.3, issue #86): a pure reducer over `PointerSample` streams. The DOM
 * adapter (#87) feeds it every down, move, up and cancel, plus a `tick` every animation frame so long-press
 * fires without movement. Time comes only from the samples: no clock, no timers, no DOM.
 *
 * `recognize` never mutates its input. A call that emits nothing returns the shared frozen `NO_GESTURES`;
 * a tick that changes nothing (no long-press or sustained tickle is due) also returns the input state object
 * itself, so an idle tick allocates no gestures array and no state.
 *
 * **One contact** (one pointer from down to up) reports every gesture with the region under its down point.
 * It starts `pending` and moves on to one of these modes; a `stroke` can still turn into `tickle` handling
 * (and tentative tickle handling into a `stroke` or a `longPress`), and any contact can still be `claimed`:
 * - `longPress`: a tick or move ≥ 500 ms after down with < 10 px of movement. It owns the contact: later
 *   moves change nothing, and the up emits `longPress end`.
 * - `stroke`: movement > 10 px at a windowed speed in [40, 1200] px/s. `update` every ≥ 50 ms of moves;
 *   `pathPx` sums the move segments that end inside the contact's region; the up emits `stroke end`.
 * - `tickle` handling: two reversals less than 300 ms apart (a stroke emits `end` first). `tickle` is
 *   emitted once ≥ 4 reversals whose segments are 4–40 px fall within 600 ms. While the scrub continues (the
 *   latest reversal is < 600 ms old), a move or tick re-emits it every 600 ms, so a sustained tickle arrives
 *   at a steady ~600 ms cadence instead of waiting for the next reversal. Tickle handling entered from
 *   `pending` is tentative until its first `tickle`, because the tap, long-press and stroke rules have no
 *   reversal exception: a small wiggle inside the slop still ends as a `tap up`, becomes a `longPress` once
 *   its run has lapsed (no reversal for 600 ms), or starts a `stroke` once it moves > 10 px at stroke speed.
 * - `claimed` by a multi-pointer gesture (pinch/hug pair, all-over): any stroke or long-press ends at once,
 *   and nothing else is emitted for that contact.
 * The up sample is a last move (it can complete a reversal or a tickle). A `pending` or `stroke` up may add a
 * `flick` (moved ≥ 10 px, < 250 ms, release speed ≥ 800 px/s over the last 80 ms); a `pending` or tentative
 * up within < 400 ms and < 10 px is a `tap up`. Anything else ends silently (the 400–500 ms dead zone
 * included).
 *
 * **Multi-poke:** `count` chains only from a confirmed `tap up`: the next down ≤ 300 ms after that up, ≤ 100 px
 * from that tap's down point and on the same region (AOSP double-tap is per view) gets its count + 1. The next
 * down consumes the chain whatever it hits (a chained tap passes it on through its own up), and any other up
 * or a cancel breaks it.
 *
 * **Tickle by taps:** ≥ 3 `tap up`s within 900 ms on the belly, or on the feet (both feet count together).
 */
import type { RegionId } from './region-ids.ts';

export interface PointerSample {
  id: number;
  t: number /* ms */;
  x: number;
  y: number;
  type: 'down' | 'move' | 'up' | 'cancel' | 'tick';
  pointerType?: 'touch' | 'mouse' | 'pen';
}
export type Gesture =
  | { g: 'tap'; phase: 'down' | 'up'; region: RegionId; x: number; y: number; count: number } // 'down' = react now; 'up' = confirmed
  | { g: 'longPress'; region: RegionId; phase: 'start' | 'end' }
  | {
      g: 'stroke';
      region: RegionId;
      phase: 'start' | 'update' | 'end';
      pathPx: number;
      dir: number /* rad */;
      against: boolean;
    }
  | { g: 'tickle'; region: RegionId }
  | { g: 'flick'; region: RegionId; vx: number; vy: number }
  | { g: 'pinch'; regions: [RegionId, RegionId]; spanRatio: number }
  | { g: 'hug' }
  | { g: 'allOver' }
  | { g: 'cancel' };

// ---- thresholds (CSS px, ms; plan §4.6.3) -------------------------------------------------------------------
/** Touch slop: a tap moves < SLOP; a stroke moves > SLOP; a flick moves ≥ SLOP. */
export const SLOP = 10;
/** A tap's up comes < TAP_MAX_MS after its down. */
export const TAP_MAX_MS = 400;
/** Multi-poke: the next down ≤ MULTI_POKE_MS after a tap's up … */
export const MULTI_POKE_MS = 300;
/** … and ≤ MULTI_POKE_PX from that tap's down point. */
export const MULTI_POKE_PX = 100;
/** Long-press: held ≥ LONG_PRESS_MS with < SLOP movement. */
export const LONG_PRESS_MS = 500;
/** Stroke start speed range (px/s, inclusive). */
export const STROKE_MIN_SPEED = 40;
export const STROKE_MAX_SPEED = 1200;
/** Path length at which the reactions table turns a stroke into a pet (#90); reported, not used here. */
export const STROKE_MIN_PATH = 120;
/** A stroke emits `update` at most this often (ms). */
export const STROKE_UPDATE_MS = 50;
/** A stroke allows at most 1 reversal per STROKE_REVERSAL_MS; two reversals closer than this → tickle. */
export const STROKE_REVERSAL_MS = 300;
/** Tickle: TICKLE_REVERSALS reversals within TICKLE_WINDOW_MS, each segment TICKLE_SEG_MIN_PX–TICKLE_SEG_MAX_PX. */
export const TICKLE_REVERSALS = 4;
export const TICKLE_WINDOW_MS = 600;
export const TICKLE_SEG_MIN_PX = 4;
export const TICKLE_SEG_MAX_PX = 40;
/** Tickle by taps: TAP_TICKLE_TAPS `tap up`s within TAP_TICKLE_MS inside one group (the belly; the feet). */
export const TAP_TICKLE_TAPS = 3;
export const TAP_TICKLE_MS = 900;
export const TAP_TICKLE_GROUPS: readonly (readonly RegionId[])[] = [['belly'], ['footL', 'footR']];
/** Flick: release speed ≥ FLICK_MIN_SPEED px/s over the last FLICK_WINDOW_MS, total duration < FLICK_MAX_MS. */
export const FLICK_MIN_SPEED = 800;
export const FLICK_WINDOW_MS = 80;
export const FLICK_MAX_MS = 250;
/** Pinch and hug: the two-pointer span shrinks by more than PINCH_SHRINK px. */
export const PINCH_SHRINK = 16;
/** A `headTop` stroke is `against` the fur within ±AGAINST_FUR_DEG of straight up the screen. */
export const AGAINST_FUR_DEG = 60;
/** This many simultaneous pointers make an all-over tickle. */
export const ALL_OVER_POINTERS = 3;

/** The frozen empty array behind `NO_GESTURES`, typed for `recognize`'s return. */
const NONE: Gesture[] = [];
Object.freeze(NONE);
/** The one gestures array returned by every call that emits nothing (shared and frozen). */
export const NO_GESTURES: readonly Gesture[] = NONE;

/**
 * A safety bound on the velocity history only. The history is trimmed by time: it holds the last
 * FLICK_WINDOW_MS of samples plus one (81 at 1000 Hz), so the cap matters only above ~6 kHz.
 */
const HIST_MAX = 512;
/** Straight up the screen (CSS y grows downward). */
const UP = -Math.PI / 2;
const AGAINST_RAD = (AGAINST_FUR_DEG * Math.PI) / 180;

type Hit = (x: number, y: number) => RegionId;
type Mode = 'pending' | 'stroke' | 'tickle' | 'longPress' | 'claimed';

interface Pt {
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

/** One pointer from down to up. */
interface Track {
  readonly id: number;
  /** The region under the down point; every gesture of this contact reports it. */
  readonly region: RegionId;
  readonly t0: number;
  readonly x0: number;
  readonly y0: number;
  /** The multi-poke count of this contact's `tap down`. */
  readonly count: number;
  readonly mode: Mode;
  readonly x: number;
  readonly y: number;
  /** The largest distance from the down point so far. */
  readonly maxDist: number;
  /** Path length of the move segments that end inside `region`. */
  readonly pathPx: number;
  /** Windowed velocity at the latest sample (px/s). */
  readonly vx: number;
  readonly vy: number;
  /** Direction of the latest non-zero velocity (rad, CSS axes: 0 = right, −π/2 = up). */
  readonly dir: number;
  /** Time of the latest stroke `start` or `update`. */
  readonly strokeT: number;
  /** Time of the latest `tickle` this contact emitted. */
  readonly tickleT: number;
  /** Recent samples in time order, the latest last: the velocity window plus one sample before it. */
  readonly hist: readonly Pt[];
  /** Reversal tracker: the anchor (the previous reversal point, or the down point) … */
  readonly ax: number;
  readonly ay: number;
  /** … the current segment's extreme point and its time … */
  readonly ex: number;
  readonly ey: number;
  readonly et: number;
  /** … and the unit direction anchor → extreme ((0, 0) until the pointer has moved TICKLE_SEG_MIN_PX). */
  readonly ux: number;
  readonly uy: number;
  /** Time of the latest reversal. */
  readonly revT: number;
  /** Times of the current run of tickle-sized reversals, within TICKLE_WINDOW_MS of the latest. */
  readonly revs: readonly number[];
  /** Tickle handling was entered from `pending` (not from a stroke): it can be tentative. */
  readonly fromPending: boolean;
}

/** A pinch or hug candidate: exactly two pointers are down, started on cheekL/cheekR or flankL/flankR. */
interface Pair {
  readonly kind: 'pinch' | 'hug';
  /** Their span when the second pointer went down. */
  readonly span0: number;
  readonly fired: boolean;
}

export interface RecState {
  /** The pointers that are down, in down order. */
  readonly pointers: readonly Track[];
  /** The latest confirmed tap (its up time, down point, region and count), until the next down consumes it. */
  readonly lastTap: {
    readonly t: number;
    readonly x: number;
    readonly y: number;
    readonly region: RegionId;
    readonly count: number;
  } | null;
  /** Times of recent `tap up`s, one list per TAP_TICKLE_GROUPS entry. */
  readonly tapTickle: readonly (readonly number[])[];
  /** Non-null only while exactly the two pair pointers are down. */
  readonly pair: Pair | null;
  /** The all-over latch: set when ALL_OVER_POINTERS pointers are down; cleared at ≤ 1 pointer. */
  readonly allOver: boolean;
}

/** No recent taps in any tap-tickle group. */
const NO_TAPS: readonly (readonly number[])[] = TAP_TICKLE_GROUPS.map(() => []);

export function initialRecState(): RecState {
  return { pointers: [], lastTap: null, tapTickle: NO_TAPS, pair: null, allOver: false };
}

/** Feeds one sample. Pure: `s` is never mutated, and a call that emits nothing returns `NO_GESTURES`. */
export function recognize(s: RecState, sample: PointerSample, hit: Hit): [RecState, Gesture[]] {
  if (sample.type === 'tick') return tick(s, sample.t);
  const i = indexOf(s, sample.id);
  // A move, up or cancel for a pointer that is not down (e.g. a hovering mouse) changes nothing.
  if (i < 0 && sample.type !== 'down') return [s, NONE];
  const out: Gesture[] = [];
  let next: RecState;
  switch (sample.type) {
    case 'down':
      // A down for a pointer that is already down: the stale contact is cancelled first.
      next = down(i < 0 ? s : cancel(s, i, out), sample, hit, out);
      break;
    case 'move':
      next = move(s, i, sample, hit, out);
      break;
    case 'up':
      next = up(s, i, sample, hit, out);
      break;
    case 'cancel':
      next = cancel(s, i, out);
      break;
  }
  return [next, out.length === 0 ? NONE : out];
}

function indexOf(s: RecState, id: number): number {
  for (let i = 0; i < s.pointers.length; i++) if (s.pointers[i]!.id === id) return i;
  return -1;
}

function without(pointers: readonly Track[], i: number): Track[] {
  return pointers.filter((_, k) => k !== i);
}

/**
 * Tickle handling entered from `pending` that has not tickled yet. The issue's "more than 1 reversal per 300 ms"
 * switch belongs to the stroke rule, and a wiggle before any stroke is neither a stroke nor a tickle: the
 * contact still obeys the tap rule on up, the long-press rule once its reversal run has lapsed, and the stroke
 * rule. Tickle handling entered from a stroke is never tentative, so a scrub cannot flap back into a stroke.
 */
function tentative(p: Track): boolean {
  return p.mode === 'tickle' && p.fromPending && p.tickleT === -Infinity;
}

/** Held ≥ LONG_PRESS_MS within the slop: pending, or tentative with no reversal for TICKLE_WINDOW_MS. */
function longPressDue(p: Track, t: number): boolean {
  return (
    (p.mode === 'pending' || (tentative(p) && t - p.revT >= TICKLE_WINDOW_MS)) &&
    p.maxDist < SLOP &&
    t - p.t0 >= LONG_PRESS_MS
  );
}

/**
 * A contact in tickle handling tickles when its current run has ≥ TICKLE_REVERSALS reversals within
 * TICKLE_WINDOW_MS, its latest reversal is < TICKLE_WINDOW_MS old (the scrub continues), and its previous
 * tickle is ≥ TICKLE_WINDOW_MS old.
 */
function tickleDue(p: Track, t: number): boolean {
  return (
    p.mode === 'tickle' &&
    p.revs.length >= TICKLE_REVERSALS &&
    t - p.revT < TICKLE_WINDOW_MS &&
    t - p.tickleT >= TICKLE_WINDOW_MS
  );
}

/**
 * A tick fires due long-presses and sustained tickles. An idle tick returns `s` itself and `NO_GESTURES`,
 * allocating neither.
 */
function tick(s: RecState, t: number): [RecState, Gesture[]] {
  let due = false;
  for (let i = 0; i < s.pointers.length; i++) {
    const p = s.pointers[i]!;
    if (longPressDue(p, t) || tickleDue(p, t)) due = true;
  }
  if (!due) return [s, NONE];
  const out: Gesture[] = [];
  const pointers = s.pointers.map((p): Track => {
    if (longPressDue(p, t)) {
      out.push({ g: 'longPress', region: p.region, phase: 'start' });
      return { ...p, mode: 'longPress' };
    }
    if (tickleDue(p, t)) {
      out.push({ g: 'tickle', region: p.region });
      return { ...p, tickleT: t };
    }
    return p;
  });
  return [{ ...s, pointers }, out];
}

function newTrack(smp: PointerSample, region: RegionId, count: number): Track {
  const { id, t, x, y } = smp;
  return {
    id,
    region,
    t0: t,
    x0: x,
    y0: y,
    count,
    mode: 'pending',
    x,
    y,
    maxDist: 0,
    pathPx: 0,
    vx: 0,
    vy: 0,
    dir: 0,
    strokeT: t,
    tickleT: -Infinity,
    hist: [{ t, x, y }],
    ax: x,
    ay: y,
    ex: x,
    ey: y,
    et: t,
    ux: 0,
    uy: 0,
    revT: -Infinity,
    revs: [],
    fromPending: false,
  };
}

function pairKind(a: RegionId, b: RegionId): Pair['kind'] | null {
  if ((a === 'cheekL' && b === 'cheekR') || (a === 'cheekR' && b === 'cheekL')) return 'pinch';
  if ((a === 'flankL' && b === 'flankR') || (a === 'flankR' && b === 'flankL')) return 'hug';
  return null;
}

function isAgainst(region: RegionId, dir: number): boolean {
  if (region !== 'headTop') return false;
  const d = dir - UP;
  return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) <= AGAINST_RAD;
}

function strokeGesture(p: Track, phase: 'start' | 'update' | 'end'): Gesture {
  return {
    g: 'stroke',
    region: p.region,
    phase,
    pathPx: p.pathPx,
    dir: p.dir,
    against: isAgainst(p.region, p.dir),
  };
}

/** Hands a contact to a multi-pointer gesture: its stroke or long-press ends now, and it emits nothing more. */
function claim(p: Track, out: Gesture[]): Track {
  if (p.mode === 'claimed') return p;
  if (p.mode === 'stroke') out.push(strokeGesture(p, 'end'));
  else if (p.mode === 'longPress') out.push({ g: 'longPress', region: p.region, phase: 'end' });
  return { ...p, mode: 'claimed' };
}

function down(s: RecState, smp: PointerSample, hit: Hit, out: Gesture[]): RecState {
  const region = hit(smp.x, smp.y);
  const lt = s.lastTap;
  const chained =
    lt !== null &&
    lt.region === region &&
    smp.t - lt.t <= MULTI_POKE_MS &&
    Math.hypot(smp.x - lt.x, smp.y - lt.y) <= MULTI_POKE_PX;
  const track = newTrack(smp, region, chained ? lt.count + 1 : 1);
  const n = s.pointers.length + 1;
  if (n >= ALL_OVER_POINTERS) {
    const pointers = s.pointers.map((p) => claim(p, out));
    if (!s.allOver) out.push({ g: 'allOver' });
    pointers.push({ ...track, mode: 'claimed' });
    return { ...s, pointers, lastTap: null, pair: null, allOver: true };
  }
  const tapDown: Gesture = { g: 'tap', phase: 'down', region, x: smp.x, y: smp.y, count: track.count };
  const other = s.pointers[0];
  const kind = other === undefined ? null : pairKind(other.region, region);
  if (other === undefined || kind === null) {
    out.push(tapDown);
    return { ...s, pointers: [...s.pointers, track], lastTap: null };
  }
  const first = claim(other, out);
  out.push(tapDown);
  return {
    ...s,
    pointers: [first, { ...track, mode: 'claimed' }],
    lastTap: null,
    pair: { kind, span0: Math.hypot(other.x - smp.x, other.y - smp.y), fired: false },
  };
}

/** Position, movement, path, velocity window and direction after a move or up sample. */
function advance(p: Track, smp: PointerSample, hit: Hit): Track {
  const { t, x, y } = smp;
  const maxDist = Math.max(p.maxDist, Math.hypot(x - p.x0, y - p.y0));
  if (p.mode !== 'pending' && p.mode !== 'stroke' && !tentative(p)) return { ...p, x, y, maxDist };
  const pathPx = hit(x, y) === p.region ? p.pathPx + Math.hypot(x - p.x, y - p.y) : p.pathPx;
  // Velocity over the last FLICK_WINDOW_MS. The position then is the latest sample at or before it: a pointer
  // reports every movement, so it did not move between samples. A younger contact measures from its down point.
  const w = t - FLICK_WINDOW_MS;
  let k = -1;
  while (k + 1 < p.hist.length && p.hist[k + 1]!.t <= w) k++;
  const ref = p.hist[Math.max(k, 0)]!;
  const dt = k >= 0 ? FLICK_WINDOW_MS : t - ref.t;
  const vx = dt > 0 ? ((x - ref.x) * 1000) / dt : 0;
  const vy = dt > 0 ? ((y - ref.y) * 1000) / dt : 0;
  const hist = p.hist.slice(Math.max(k, 0, p.hist.length + 1 - HIST_MAX));
  hist.push({ t, x, y });
  const dir = vx !== 0 || vy !== 0 ? Math.atan2(vy, vx) : p.dir;
  return { ...p, x, y, maxDist, pathPx, hist, vx, vy, dir };
}

/**
 * Direction reversals: a segment runs from the anchor to its extreme point; moving back ≥ TICKLE_SEG_MIN_PX
 * against the segment's direction is a reversal at the extreme point, which becomes the next anchor.
 */
function reversals(p: Track, t: number, x: number, y: number, out: Gesture[]): Track {
  if (p.ux === 0 && p.uy === 0) {
    const d = Math.hypot(x - p.ax, y - p.ay);
    return d < TICKLE_SEG_MIN_PX ? p : { ...p, ex: x, ey: y, et: t, ux: (x - p.ax) / d, uy: (y - p.ay) / d };
  }
  const ahead = (x - p.ex) * p.ux + (y - p.ey) * p.uy;
  if (ahead > 0) {
    const d = Math.hypot(x - p.ax, y - p.ay);
    return { ...p, ex: x, ey: y, et: t, ux: (x - p.ax) / d, uy: (y - p.ay) / d };
  }
  if (-ahead < TICKLE_SEG_MIN_PX) return p;
  const at = p.et;
  const len = Math.hypot(p.ex - p.ax, p.ey - p.ay); // ≥ TICKLE_SEG_MIN_PX by construction
  const d = Math.hypot(x - p.ex, y - p.ey);
  let q: Track = {
    ...p,
    ax: p.ex,
    ay: p.ey,
    ex: x,
    ey: y,
    et: t,
    ux: (x - p.ex) / d,
    uy: (y - p.ey) / d,
    revT: at,
    revs: len <= TICKLE_SEG_MAX_PX ? [...p.revs.filter((r) => at - r <= TICKLE_WINDOW_MS), at] : [],
  };
  if (at - p.revT < STROKE_REVERSAL_MS && q.mode !== 'tickle') {
    if (q.mode === 'stroke') out.push(strokeGesture(q, 'end'));
    q = { ...q, mode: 'tickle', fromPending: q.mode === 'pending' };
  }
  return q;
}

function move(s: RecState, i: number, smp: PointerSample, hit: Hit, out: Gesture[]): RecState {
  let p = advance(s.pointers[i]!, smp, hit);
  if (p.mode === 'pending' || p.mode === 'stroke' || p.mode === 'tickle')
    p = reversals(p, smp.t, smp.x, smp.y, out);
  if (tickleDue(p, smp.t)) {
    out.push({ g: 'tickle', region: p.region });
    p = { ...p, tickleT: smp.t };
  } else if (longPressDue(p, smp.t)) {
    p = { ...p, mode: 'longPress' };
    out.push({ g: 'longPress', region: p.region, phase: 'start' });
  } else if (p.mode === 'pending' || tentative(p)) {
    const speed = Math.hypot(p.vx, p.vy);
    if (p.maxDist > SLOP && speed >= STROKE_MIN_SPEED && speed <= STROKE_MAX_SPEED) {
      p = { ...p, mode: 'stroke', strokeT: smp.t };
      out.push(strokeGesture(p, 'start'));
    }
  } else if (p.mode === 'stroke' && smp.t - p.strokeT >= STROKE_UPDATE_MS) {
    p = { ...p, strokeT: smp.t };
    out.push(strokeGesture(p, 'update'));
  }
  const pointers = s.pointers.slice();
  pointers[i] = p;
  let pair = s.pair;
  if (pair !== null && !pair.fired) {
    // While a pair exists, exactly its two pointers are down.
    const o = pointers[1 - i]!;
    const span = Math.hypot(p.x - o.x, p.y - o.y);
    if (pair.span0 - span > PINCH_SHRINK) {
      out.push(
        pair.kind === 'pinch'
          ? { g: 'pinch', regions: ['cheekL', 'cheekR'], spanRatio: span / pair.span0 }
          : { g: 'hug' },
      );
      pair = { ...pair, fired: true };
    }
  }
  return { ...s, pointers, pair };
}

function flick(p: Track, dt: number, out: Gesture[]): void {
  if (p.maxDist >= SLOP && dt < FLICK_MAX_MS && Math.hypot(p.vx, p.vy) >= FLICK_MIN_SPEED) {
    out.push({ g: 'flick', region: p.region, vx: p.vx, vy: p.vy });
  }
}

function up(s: RecState, i: number, smp: PointerSample, hit: Hit, out: Gesture[]): RecState {
  let p = advance(s.pointers[i]!, smp, hit);
  // The release point is a last move: it can complete a reversal, and with it a tickle.
  if (p.mode === 'pending' || p.mode === 'stroke' || p.mode === 'tickle')
    p = reversals(p, smp.t, smp.x, smp.y, out);
  if (tickleDue(p, smp.t)) {
    out.push({ g: 'tickle', region: p.region });
    p = { ...p, tickleT: smp.t };
  }
  const dt = smp.t - p.t0;
  let tapped = false;
  if (p.mode === 'pending' || tentative(p)) {
    if (dt < TAP_MAX_MS && p.maxDist < SLOP) {
      tapped = true;
      out.push({ g: 'tap', phase: 'up', region: p.region, x: p.x0, y: p.y0, count: p.count });
    } else if (p.mode === 'pending') {
      flick(p, dt, out);
    }
  } else if (p.mode === 'stroke') {
    out.push(strokeGesture(p, 'end'));
    flick(p, dt, out);
  } else if (p.mode === 'longPress') {
    out.push({ g: 'longPress', region: p.region, phase: 'end' });
  }
  let tapTickle = s.tapTickle;
  const group = tapped ? TAP_TICKLE_GROUPS.findIndex((regions) => regions.includes(p.region)) : -1;
  if (group >= 0) {
    const times = [...s.tapTickle[group]!.filter((tt) => smp.t - tt <= TAP_TICKLE_MS), smp.t];
    tapTickle = s.tapTickle.map((ts, k) => (k === group ? times : ts));
    if (times.length >= TAP_TICKLE_TAPS) out.push({ g: 'tickle', region: p.region });
  }
  const pointers = without(s.pointers, i);
  return {
    pointers,
    lastTap: tapped ? { t: smp.t, x: p.x0, y: p.y0, region: p.region, count: p.count } : null,
    tapTickle,
    // A pair's two pointers are the only ones down, so any up ends it.
    pair: null,
    allOver: s.allOver && pointers.length > 1,
  };
}

function cancel(s: RecState, i: number, out: Gesture[]): RecState {
  out.push({ g: 'cancel' });
  const pointers = without(s.pointers, i);
  return {
    pointers,
    lastTap: null,
    tapTickle: NO_TAPS,
    pair: null,
    allOver: s.allOver && pointers.length > 1,
  };
}
