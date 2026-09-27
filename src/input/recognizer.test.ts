import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AGAINST_FUR_DEG,
  ALL_OVER_POINTERS,
  FLICK_MAX_MS,
  FLICK_MIN_SPEED,
  FLICK_WINDOW_MS,
  LONG_PRESS_MS,
  MULTI_POKE_MS,
  MULTI_POKE_PX,
  NO_GESTURES,
  PINCH_SHRINK,
  SLOP,
  STROKE_MAX_SPEED,
  STROKE_MIN_PATH,
  STROKE_MIN_SPEED,
  STROKE_REVERSAL_MS,
  STROKE_UPDATE_MS,
  TAP_MAX_MS,
  TAP_TICKLE_MS,
  TAP_TICKLE_GROUPS,
  TAP_TICKLE_TAPS,
  TICKLE_REVERSALS,
  TICKLE_SEG_MAX_PX,
  TICKLE_SEG_MIN_PX,
  TICKLE_WINDOW_MS,
  initialRecState,
  recognize,
} from './recognizer.ts';
import type { Gesture, PointerSample, RecState } from './recognizer.ts';
import { REGION_IDS } from './region-ids.ts';
import type { RegionId } from './region-ids.ts';

// ---- helpers ------------------------------------------------------------------------------------------------
// Expectations below use literal numbers from issue #86 / plan §4.6.3, never the exported constants, so a
// changed constant fails a test.

type Hit = (x: number, y: number) => RegionId;
/** Every point hits `r`. */
const on =
  (r: RegionId): Hit =>
  () =>
    r;
/** x < 500 hits `left`, the rest `right`. */
const split =
  (left: RegionId, right: RegionId): Hit =>
  (x) =>
    x < 500 ? left : right;
/** x < 300 hits the belly, x < 600 the left foot, the rest the right foot. */
const bellyFeet: Hit = (x) => (x < 300 ? 'belly' : x < 600 ? 'footL' : 'footR');
/** A 50 px grid over every region id, so random traces visit every region. */
const grid: Hit = (x, y) => REGION_IDS[(((Math.floor(x / 50) + 3 * Math.floor(y / 50)) % 17) + 17) % 17]!;

const dn = (t: number, x: number, y: number, id = 1): PointerSample => ({ id, t, x, y, type: 'down' });
const mv = (t: number, x: number, y: number, id = 1): PointerSample => ({ id, t, x, y, type: 'move' });
const up = (t: number, x: number, y: number, id = 1): PointerSample => ({ id, t, x, y, type: 'up' });
const cancel = (t: number, id = 1): PointerSample => ({ id, t, x: 0, y: 0, type: 'cancel' });
const tick = (t: number): PointerSample => ({ id: 0, t, x: 0, y: 0, type: 'tick' });

/** `n` equal moves from (x0, y0) to (x1, y1), one every `stepMs` after t0. */
function line(
  id: number,
  t0: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  n: number,
  stepMs: number,
) {
  const out: PointerSample[] = [];
  for (let k = 1; k <= n; k++)
    out.push(mv(t0 + k * stepMs, x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, id));
  return out;
}

/** Moves along a polyline, ≈ `pxPerStep` px every `stepMs` after t0; every corner is sampled exactly. */
function path(
  id: number,
  t0: number,
  pts: readonly (readonly [number, number])[],
  pxPerStep: number,
  stepMs: number,
) {
  const out: PointerSample[] = [];
  let t = t0;
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1]!;
    const [bx, by] = pts[k]!;
    const n = Math.round(Math.hypot(bx - ax, by - ay) / pxPerStep);
    for (let j = 1; j <= n; j++) {
      t += stepMs;
      out.push(mv(t, ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n, id));
    }
  }
  return out;
}

/** A back-and-forth scrub along x: x0 → x0 + first, then `legs` legs alternating to x0 ∓ amp. */
function zigzag(x0: number, y: number, first: number, amp: number, legs: number, end: number) {
  const pts: [number, number][] = [
    [x0, y],
    [x0 + first, y],
  ];
  for (let k = 0; k < legs; k++) pts.push([k % 2 === 0 ? x0 - amp : x0 + amp, y]);
  pts.push([end, y]);
  return pts;
}

/** The samples in time order (stable: equal times keep their listed order). */
const byTime = (...xs: PointerSample[]) => xs.toSorted((a, b) => a.t - b.t);

function ticks(from: number, to: number, step: number) {
  const out: PointerSample[] = [];
  for (let t = from; t <= to; t += step) out.push(tick(t));
  return out;
}

interface Step {
  sample: PointerSample;
  out: Gesture[];
}
function run(samples: readonly PointerSample[], hit: Hit, s0: RecState = initialRecState()) {
  let s = s0;
  const steps: Step[] = [];
  for (const sample of samples) {
    const [next, out] = recognize(s, sample, hit);
    steps.push({ sample, out });
    s = next;
  }
  return { steps, all: steps.flatMap((st) => st.out), state: s };
}

/** `g` or `g:phase`, for compact sequence checks. */
const kind = (g: Gesture): string => ('phase' in g ? `${g.g}:${g.phase}` : g.g);
const kinds = (gs: readonly Gesture[]) => gs.map(kind);
/** The distinct kinds, consecutive repeats collapsed (stroke updates). */
const shape = (gs: readonly Gesture[]) => kinds(gs).filter((k, i, a) => i === 0 || a[i - 1] !== k);
/** Times of the samples that emitted a gesture of kind `k`. */
const timesOf = (steps: readonly Step[], k: string) =>
  steps.filter((st) => st.out.some((g) => kind(g) === k)).map((st) => st.sample.t);
const find = <K extends Gesture['g']>(gs: readonly Gesture[], g: K, phase?: string) =>
  gs.find(
    (x): x is Extract<Gesture, { g: K }> => x.g === g && (phase === undefined || kind(x) === `${g}:${phase}`),
  );

function deepFreeze<T>(o: T): T {
  if (typeof o === 'object' && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// ---- scenario builders ------------------------------------------------------------------------------------------

/** Does a 3 s straight belly drag at `pxPer100ms` px per 100 ms (10 ms samples) start a stroke? */
function startsStroke(pxPer100ms: number) {
  const trace = [dn(0, 0, 0), ...line(1, 0, 0, 0, pxPer100ms * 3, 0, 30, 10)];
  return kinds(run(trace, on('belly')).all).includes('stroke:start');
}

/** A 120 px drag at 300 px/s from (500, 400), `deg` degrees clockwise from straight up the screen. */
function strokeToward(deg: number) {
  const r = (deg * Math.PI) / 180;
  return [dn(0, 500, 400), ...line(1, 0, 500, 400, 500 + Math.sin(r) * 120, 400 - Math.cos(r) * 120, 20, 20)];
}
const strokeStart = (trace: readonly PointerSample[], hit: Hit) =>
  find(run(trace, hit).all, 'stroke', 'start');

/** A ±8 px belly scrub with 3 corners after the first (4 reversals), 4 px every `stepMs`. */
const scrubEvery = (stepMs: number) =>
  kinds(run([dn(0, 500, 500), ...path(1, 0, zigzag(500, 500, 8, 8, 3, 500), 4, stepMs)], on('belly')).all);

/** A belly scrub with a 20 px first leg, then 3 legs of `leg` px (4 reversals). */
const scrubLegs = (leg: number) =>
  kinds(
    run([dn(0, 500, 500), ...path(1, 0, zigzag(500, 500, 20, leg - 20, 3, 500), 4, 10)], on('belly')).all,
  );

/** Three 50 ms belly taps with ups at 50 ms, 500 ms and `last`. */
const threeTapsEndingAt = (last: number) =>
  kinds(
    run(
      [
        dn(0, 500, 500),
        up(50, 500, 500),
        dn(450, 500, 500),
        up(500, 500, 500),
        dn(last - 50, 500, 500),
        up(last, 500, 500),
      ],
      on('belly'),
    ).all,
  );

/**
 * A steady scrub along x from the down point (500, 500): `legs` legs of `leg` px, each `periodMs` long in
 * `movesPerLeg` moves; then the pointer rests while ticks (every 16 ms from the start) run on to 2 s after the
 * last corner. Every corner but the last is a reversal, so the last reversal is at `(legs − 1) · periodMs`.
 */
function steadyScrub(leg: number, periodMs: number, legs: number, movesPerLeg = 5) {
  const moves: PointerSample[] = [];
  for (let k = 1; k <= legs; k++) {
    const from = k % 2 === 1 ? 500 : 500 + leg;
    const to = k % 2 === 1 ? 500 + leg : 500;
    for (let j = 1; j <= movesPerLeg; j++) {
      const f = j / movesPerLeg;
      moves.push(mv((k - 1) * periodMs + f * periodMs, from + (to - from) * f, 500));
    }
  }
  const trace = byTime(dn(0, 500, 500), ...moves, ...ticks(16, legs * periodMs + 2000, 16));
  return { trace, lastReversal: (legs - 1) * periodMs };
}

/** A 110 ms drag right at `pxPer10ms` px every 10 ms from (500, 500). */
const flickAt = (pxPer10ms: number) => [
  dn(0, 500, 500),
  ...line(1, 0, 500, 500, 500 + 10 * pxPer10ms, 500, 10, 10),
  up(110, 500 + 11 * pxPer10ms, 500),
];

/** A 1500 px/s drag right from (500, 500) (above the stroke range), lifted at `end`. */
const flickEndingAt = (end: number) => [
  dn(0, 500, 500),
  ...line(1, 0, 500, 500, 860, 500, 24, 10),
  up(end, 860 + 1.5 * (end - 240), 500),
];

// ---- constants ------------------------------------------------------------------------------------------------

describe('thresholds', () => {
  it('match issue #86 / plan §4.6.3', () => {
    expect({
      SLOP,
      TAP_MAX_MS,
      MULTI_POKE_MS,
      MULTI_POKE_PX,
      LONG_PRESS_MS,
      STROKE_MIN_SPEED,
      STROKE_MAX_SPEED,
      STROKE_MIN_PATH,
      STROKE_UPDATE_MS,
      STROKE_REVERSAL_MS,
      TICKLE_REVERSALS,
      TICKLE_WINDOW_MS,
      TICKLE_SEG_MIN_PX,
      TICKLE_SEG_MAX_PX,
      TAP_TICKLE_TAPS,
      TAP_TICKLE_MS,
      TAP_TICKLE_GROUPS,
      FLICK_MIN_SPEED,
      FLICK_WINDOW_MS,
      FLICK_MAX_MS,
      PINCH_SHRINK,
      AGAINST_FUR_DEG,
      ALL_OVER_POINTERS,
    }).toEqual({
      SLOP: 10,
      TAP_MAX_MS: 400,
      MULTI_POKE_MS: 300,
      MULTI_POKE_PX: 100,
      LONG_PRESS_MS: 500,
      STROKE_MIN_SPEED: 40,
      STROKE_MAX_SPEED: 1200,
      STROKE_MIN_PATH: 120,
      STROKE_UPDATE_MS: 50,
      STROKE_REVERSAL_MS: 300,
      TICKLE_REVERSALS: 4,
      TICKLE_WINDOW_MS: 600,
      TICKLE_SEG_MIN_PX: 4,
      TICKLE_SEG_MAX_PX: 40,
      TAP_TICKLE_TAPS: 3,
      TAP_TICKLE_MS: 900,
      TAP_TICKLE_GROUPS: [['belly'], ['footL', 'footR']],
      FLICK_MIN_SPEED: 800,
      FLICK_WINDOW_MS: 80,
      FLICK_MAX_MS: 250,
      PINCH_SHRINK: 16,
      AGAINST_FUR_DEG: 60,
      ALL_OVER_POINTERS: 3,
    });
  });
});

// ---- allocation and purity ------------------------------------------------------------------------------------

describe('NO_GESTURES and idle ticks', () => {
  it('NO_GESTURES is one frozen empty array', () => {
    expect(NO_GESTURES).toEqual([]);
    expect(Object.isFrozen(NO_GESTURES)).toBe(true);
  });

  it('an idle tick returns the same state object and NO_GESTURES', () => {
    const s = initialRecState();
    const [s1, g1] = recognize(s, tick(1000), on('belly'));
    expect(s1).toBe(s);
    expect(g1).toBe(NO_GESTURES);
    // A pending pointer before the long-press time: still idle.
    const [s2] = recognize(s, dn(0, 10, 10), on('belly'));
    const [s3, g3] = recognize(s2, tick(499), on('belly'));
    expect(s3).toBe(s2);
    expect(g3).toBe(NO_GESTURES);
  });

  it('samples for pointers that are not down change nothing', () => {
    const [s] = recognize(initialRecState(), dn(0, 10, 10), on('belly'));
    for (const smp of [mv(10, 20, 20, 9), up(20, 20, 20, 9), cancel(30, 9)]) {
      const [next, out] = recognize(s, smp, on('belly'));
      expect(next).toBe(s);
      expect(out).toBe(NO_GESTURES);
    }
  });

  it('a call that emits nothing returns NO_GESTURES', () => {
    const { steps } = run([dn(0, 100, 100), mv(10, 101, 100), mv(20, 102, 100)], on('belly'));
    expect(steps[1]!.out).toBe(NO_GESTURES);
    expect(steps[2]!.out).toBe(NO_GESTURES);
  });
});

// ---- validation 1: one positive example per gesture -----------------------------------------------------------

describe('tap', () => {
  it('down reacts at once; up within < 400 ms and < 10 px confirms it, at the down point', () => {
    const { all } = run([dn(0, 100, 100), up(120, 103, 104)], on('nose'));
    expect(all).toEqual([
      { g: 'tap', phase: 'down', region: 'nose', x: 100, y: 100, count: 1 },
      { g: 'tap', phase: 'up', region: 'nose', x: 100, y: 100, count: 1 },
    ]);
  });

  it('an up at 399 ms is a tap; at 400 ms it is not', () => {
    expect(kinds(run([dn(0, 100, 100), up(399, 100, 100)], on('nose')).all)).toEqual(['tap:down', 'tap:up']);
    expect(kinds(run([dn(0, 100, 100), up(400, 100, 100)], on('nose')).all)).toEqual(['tap:down']);
  });

  it('9.9 px of movement is a tap; 10 px is not', () => {
    expect(kinds(run([dn(0, 100, 100), mv(100, 109.9, 100), up(200, 109.9, 100)], on('nose')).all)).toEqual([
      'tap:down',
      'tap:up',
    ]);
    expect(kinds(run([dn(0, 100, 100), mv(100, 110, 100), up(200, 110, 100)], on('nose')).all)).toEqual([
      'tap:down',
    ]);
  });

  it('the region is the one under the down point', () => {
    const { all } = run([dn(0, 495, 100), up(50, 504, 100)], split('cheekL', 'cheekR'));
    expect(all.map((g) => ('region' in g ? g.region : null))).toEqual(['cheekL', 'cheekL']);
  });
});

describe('multi-poke', () => {
  it('double poke: the next down ≤ 300 ms after the up and ≤ 100 px away counts 2; a third counts 3', () => {
    const { all } = run(
      [
        dn(0, 100, 100),
        up(50, 100, 100),
        dn(350, 200, 100),
        up(400, 200, 100),
        dn(700, 200, 100),
        up(750, 200, 100),
      ],
      on('nose'),
    );
    expect(all.map((g) => (g.g === 'tap' ? `${g.phase}${g.count}` : g.g))).toEqual([
      'down1',
      'up1',
      'down2',
      'up2',
      'down3',
      'up3',
    ]);
  });

  it('301 ms or 101 px later starts again at 1', () => {
    const late = run([dn(0, 100, 100), up(50, 100, 100), dn(351, 100, 100)], on('nose')).all;
    const far = run([dn(0, 100, 100), up(50, 100, 100), dn(350, 201, 100)], on('nose')).all;
    expect(late.at(-1)).toMatchObject({ g: 'tap', phase: 'down', count: 1 });
    expect(far.at(-1)).toMatchObject({ g: 'tap', phase: 'down', count: 1 });
  });

  it('the distance is measured from the previous tap’s down point, not its up point', () => {
    // 100 px from the down point, 109 px from the up point: chains.
    const near = run([dn(0, 100, 100), up(50, 91, 100), dn(300, 200, 100)], on('nose')).all;
    expect(near.at(-1)).toMatchObject({ phase: 'down', count: 2 });
    // 101 px from the down point, 92 px from the up point: does not.
    const far = run([dn(0, 100, 100), up(50, 109, 100), dn(300, 201, 100)], on('nose')).all;
    expect(far.at(-1)).toMatchObject({ phase: 'down', count: 1 });
  });

  it('chains only on the same region: eye, eye, nose → the nose counts 1', () => {
    const { all } = run(
      [dn(0, 440, 100), up(40, 440, 100), dn(200, 460, 100), up(240, 460, 100), dn(400, 520, 100)],
      split('eyeL', 'nose'),
    );
    expect(all.filter((g) => g.g === 'tap' && g.phase === 'down')).toEqual([
      { g: 'tap', phase: 'down', region: 'eyeL', x: 440, y: 100, count: 1 },
      { g: 'tap', phase: 'down', region: 'eyeL', x: 460, y: 100, count: 2 },
      { g: 'tap', phase: 'down', region: 'nose', x: 520, y: 100, count: 1 },
    ]);
  });

  it('only a confirmed tap chains: a dead-zone press, a stroke, a long-press or a flick does not', () => {
    const dead = [dn(0, 100, 100), up(450, 100, 100)];
    const stroke = [dn(0, 100, 100), ...line(1, 0, 100, 100, 160, 100, 10, 20), up(220, 160, 100)];
    const long = [dn(0, 100, 100), tick(500), up(600, 100, 100)];
    const flick = [dn(0, 100, 100), ...line(1, 0, 100, 100, 250, 100, 10, 10), up(110, 265, 100)];
    for (const first of [dead, stroke, long, flick]) {
      const last = first.at(-1)!;
      const { all } = run([...first, dn(last.t + 100, 100, 100)], on('nose'));
      expect(all.at(-1)).toMatchObject({ g: 'tap', phase: 'down', count: 1 });
    }
  });
});

describe('long-press', () => {
  it('a tick at ≥ 500 ms with < 10 px of movement starts it once; the up ends it', () => {
    const { steps, all } = run(
      [dn(0, 100, 100), ...ticks(16, 496, 16), tick(499), tick(500), tick(516), tick(700), up(800, 104, 100)],
      on('earL'),
    );
    expect(all).toEqual([
      { g: 'tap', phase: 'down', region: 'earL', x: 100, y: 100, count: 1 },
      { g: 'longPress', region: 'earL', phase: 'start' },
      { g: 'longPress', region: 'earL', phase: 'end' },
    ]);
    expect(timesOf(steps, 'longPress:start')).toEqual([500]);
  });

  it('a move at ≥ 500 ms within slop starts it too', () => {
    const { steps } = run([dn(0, 100, 100), mv(499, 103, 100), mv(500, 104, 100)], on('earL'));
    expect(timesOf(steps, 'longPress:start')).toEqual([500]);
  });

  it('9 px of drift still long-presses; 10 px does not', () => {
    expect(kinds(run([dn(0, 100, 100), mv(100, 109, 100), tick(500)], on('belly')).all)).toEqual([
      'tap:down',
      'longPress:start',
    ]);
    expect(kinds(run([dn(0, 100, 100), mv(100, 110, 100), tick(500)], on('belly')).all)).toEqual([
      'tap:down',
    ]);
  });

  it('owns the contact: later movement starts no stroke, and the up emits only its end', () => {
    const trace = [
      dn(0, 100, 100),
      tick(500),
      ...line(1, 500, 100, 100, 300, 100, 20, 10),
      up(720, 300, 100),
    ];
    expect(kinds(run(trace, on('belly')).all)).toEqual(['tap:down', 'longPress:start', 'longPress:end']);
  });

  it('an up is never a long-press trigger: no tick after 500 ms, no long-press', () => {
    expect(kinds(run([dn(0, 100, 100), up(600, 100, 100)], on('belly')).all)).toEqual(['tap:down']);
  });

  it('each pointer long-presses on its own time, with its own region', () => {
    const trace = [
      dn(0, 100, 100, 1),
      dn(200, 800, 100, 2),
      tick(500),
      tick(600),
      tick(700),
      up(800, 100, 100, 1),
    ];
    const { steps } = run(trace, split('pawL', 'pawR'));
    expect(steps.slice(2).map((st) => st.out)).toEqual([
      [{ g: 'longPress', region: 'pawL', phase: 'start' }],
      NO_GESTURES,
      [{ g: 'longPress', region: 'pawR', phase: 'start' }],
      [{ g: 'longPress', region: 'pawL', phase: 'end' }],
    ]);
  });
});

describe('stroke', () => {
  // headTop, 6 px every 20 ms (300 px/s) to the right.
  const pet = [dn(0, 400, 300), ...line(1, 0, 400, 300, 580, 300, 30, 20), up(620, 586, 300)];

  it('starts once movement exceeds 10 px at 40–1200 px/s, updates every ≥ 50 ms, ends on up (→ pet)', () => {
    const { steps, all } = run(pet, on('headTop'));
    expect(shape(all)).toEqual(['tap:down', 'stroke:start', 'stroke:update', 'stroke:end']);
    expect(find(all, 'stroke', 'start')).toEqual({
      g: 'stroke',
      region: 'headTop',
      phase: 'start',
      pathPx: 12,
      dir: 0,
      against: false,
    });
    expect(timesOf(steps, 'stroke:start')).toEqual([40]);
    expect(timesOf(steps, 'stroke:update')).toEqual([100, 160, 220, 280, 340, 400, 460, 520, 580]);
    // The reactions table's pet threshold (pathPx ≥ 120) is reached during the stroke.
    const updates = all.filter((g) => kind(g) === 'stroke:update');
    expect(updates.some((g) => g.g === 'stroke' && g.pathPx >= 120)).toBe(true);
    expect(find(all, 'stroke', 'end')).toMatchObject({ pathPx: 186, dir: 0, against: false });
  });

  it('updates come every 50 ms with 10 ms samples', () => {
    const trace = [dn(0, 400, 300), ...line(1, 0, 400, 300, 700, 300, 100, 10)];
    const t = timesOf(run(trace, on('belly')).steps, 'stroke:update');
    expect(t.slice(0, 4)).toEqual([90, 140, 190, 240]); // start at 40 ms (12 px)
  });

  it('pathPx counts only the path inside the stroke’s region', () => {
    const { all } = run(pet, split('headTop', 'background'));
    expect(find(all, 'stroke', 'end')).toMatchObject({ region: 'headTop', pathPx: 96 });
  });

  it('speed bounds: 40.5 and exactly 1200 px/s start a stroke; 39.5 and 1210 do not', () => {
    expect(startsStroke(4.05)).toBe(true);
    expect(startsStroke(120)).toBe(true);
    expect(startsStroke(3.95)).toBe(false);
    expect(startsStroke(121)).toBe(false);
  });

  it('a fast swipe that slows into range starts a stroke then', () => {
    const trace = [dn(0, 0, 0), ...line(1, 0, 0, 0, 150, 0, 10, 10), ...line(1, 100, 150, 0, 200, 0, 10, 10)];
    // The 80 ms average falls from 1250 px/s (120 ms) to 1125 px/s (130 ms).
    const { steps } = run(trace, on('belly'));
    expect(timesOf(steps, 'stroke:start')).toEqual([130]);
  });

  it('against the fur: within ±60° of straight up on headTop', () => {
    expect(strokeStart(strokeToward(0), on('headTop'))).toMatchObject({ against: true });
    expect(strokeStart(strokeToward(0), on('headTop'))!.dir).toBeCloseTo(-Math.PI / 2, 9);
    expect(strokeStart(strokeToward(59), on('headTop'))).toMatchObject({ against: true });
    expect(strokeStart(strokeToward(-59), on('headTop'))).toMatchObject({ against: true });
    expect(strokeStart(strokeToward(61), on('headTop'))).toMatchObject({ against: false });
    expect(strokeStart(strokeToward(-61), on('headTop'))).toMatchObject({ against: false });
    expect(strokeStart(strokeToward(180), on('headTop'))).toMatchObject({ against: false });
    expect(strokeStart(strokeToward(0), on('belly'))).toMatchObject({ against: false });
  });

  it('at most 1 reversal per 300 ms: reversals 300 ms apart keep the stroke', () => {
    const pts = [
      [300, 300],
      [360, 300],
      [300, 300],
      [360, 300],
    ] as const;
    const { steps, all } = run(
      [dn(0, 300, 300), ...path(1, 0, pts, 6, 30), up(930, 360, 300)],
      on('headTop'),
    );
    expect(shape(all)).toEqual(['tap:down', 'stroke:start', 'stroke:update', 'stroke:end']);
    expect(timesOf(steps, 'stroke:end')).toEqual([930]);
  });

  it('two reversals 299 ms apart turn it into tickle handling: the stroke ends there, the up adds nothing', () => {
    const pts = [
      [300, 300],
      [360, 300],
      [300, 300],
      [360, 300],
    ] as const;
    const { steps, all } = run(
      [dn(0, 300, 300), ...path(1, 0, pts, 6, 29.9), up(930, 360, 300)],
      on('headTop'),
    );
    expect(shape(all)).toEqual(['tap:down', 'stroke:start', 'stroke:update', 'stroke:end']);
    const [endT] = timesOf(steps, 'stroke:end');
    expect(endT).toBeLessThan(930);
    expect(steps.at(-1)!.out).toBe(NO_GESTURES);
  });
});

describe('tickle', () => {
  it('by reversals: 4 reversals within 600 ms of 4–40 px segments', () => {
    // Within slop (±8 px), so no stroke: 508 → 492 → 508 → 492, then back to 500.
    const trace = [dn(0, 500, 500), ...path(1, 0, zigzag(500, 500, 8, 8, 3, 500), 4, 10), up(170, 500, 500)];
    const { steps, all } = run(trace, on('belly'));
    expect(all).toEqual([
      { g: 'tap', phase: 'down', region: 'belly', x: 500, y: 500, count: 1 },
      { g: 'tickle', region: 'belly' },
    ]);
    expect(timesOf(steps, 'tickle')).toEqual([150]);
  });

  it('from a stroke: the stroke ends, then the tickle follows', () => {
    const trace = [dn(0, 500, 500), ...path(1, 0, zigzag(500, 500, 20, 20, 3, 500), 4, 10)];
    expect(shape(run(trace, on('belly')).all)).toEqual([
      'tap:down',
      'stroke:start',
      'stroke:update',
      'stroke:end',
      'tickle',
    ]);
  });

  it('at most once per 600 ms while the scrub continues', () => {
    const trace = [dn(0, 500, 500), ...path(1, 0, zigzag(500, 500, 8, 8, 60, 500), 4, 10)];
    const t = timesOf(run(trace, on('belly')).steps, 'tickle');
    expect(t).toEqual([150, 750, 1350, 1950]);
  });

  it('a sustained scrub re-tickles every 600–650 ms (on ticks too) and stops < 600 ms after its last reversal', () => {
    for (const [leg, periodMs] of [
      [8, 150],
      [8, 175],
      [20, 150],
      [20, 175],
      [20, 200],
      [36, 150],
      [36, 175],
      [36, 200],
    ] as const) {
      const { trace, lastReversal } = steadyScrub(leg, periodMs, 20);
      const t = timesOf(run(trace, on('belly')).steps, 'tickle');
      expect(t.length, `${leg} px / ${periodMs} ms`).toBeGreaterThanOrEqual(4);
      const gaps = t.slice(1).map((x, k) => x - t[k]!);
      expect(Math.min(...gaps), `${leg} px / ${periodMs} ms`).toBeGreaterThanOrEqual(600);
      expect(Math.max(...gaps), `${leg} px / ${periodMs} ms`).toBeLessThanOrEqual(650);
      expect(t.at(-1)!, `${leg} px / ${periodMs} ms`).toBeLessThan(lastReversal + 600);
    }
  });

  it('ticks keep the cadence when moves are sparse (one move per 170 ms leg)', () => {
    // Re-emitting only on moves would give gaps of 680 ms here (4 legs).
    for (const leg of [20, 36]) {
      const { trace, lastReversal } = steadyScrub(leg, 170, 20, 1);
      const t = timesOf(run(trace, on('belly')).steps, 'tickle');
      expect(t.length, `${leg} px`).toBeGreaterThanOrEqual(4);
      const gaps = t.slice(1).map((x, k) => x - t[k]!);
      expect(Math.min(...gaps), `${leg} px`).toBeGreaterThanOrEqual(600);
      expect(Math.max(...gaps), `${leg} px`).toBeLessThanOrEqual(650);
      expect(t.at(-1)!, `${leg} px`).toBeLessThan(lastReversal + 600);
    }
  });

  it('a still finger in tickle handling never long-presses', () => {
    // The in-slop scrub tickles at 150 ms; the finger then rests to 800 ms (last reversal at 140 ms).
    const trace = [
      dn(0, 500, 500),
      ...path(1, 0, zigzag(500, 500, 8, 8, 3, 500), 4, 10),
      ...ticks(176, 800, 16),
    ];
    expect(kinds(run(trace, on('belly')).all)).toEqual(['tap:down', 'tickle']);
  });

  it('the 4 reversals may span exactly 600 ms, not 612', () => {
    // 4 px every 50 ms: corners at 100, 300, 500, 700 ms (span 600); with 51 ms at 102 … 714 (span 612).
    expect(scrubEvery(50)).toEqual(['tap:down', 'tickle']);
    expect(scrubEvery(51)).toEqual(['tap:down']);
  });

  it('segments of exactly 4 px count; 3.9 px is jitter (and stays a tap)', () => {
    const pts4 = [
      [500, 500],
      [504, 500],
      [500, 500],
      [504, 500],
      [500, 500],
      [504, 500],
    ] as const;
    expect(kinds(run([dn(0, 500, 500), ...path(1, 0, pts4, 4, 10)], on('belly')).all)).toEqual([
      'tap:down',
      'tickle',
    ]);
    const pts39 = pts4.map(([x, y]) => [x === 504 ? 503.9 : x, y] as const);
    expect(
      kinds(run([dn(0, 500, 500), ...path(1, 0, pts39, 4, 10), up(60, 500, 500)], on('belly')).all),
    ).toEqual(['tap:down', 'tap:up']);
  });

  it('segments of exactly 40 px count; 41 px do not', () => {
    expect(scrubLegs(40)).toContain('tickle');
    expect(scrubLegs(41)).not.toContain('tickle');
  });

  it('by taps: 3 tap ups within 900 ms on the belly', () => {
    const taps = [dn(0, 500, 500), up(50, 500, 500), dn(300, 500, 500), up(350, 500, 500), dn(600, 500, 500)];
    const { steps } = run([...taps, up(650, 500, 500)], on('belly'));
    expect(kinds(steps.at(-1)!.out)).toEqual(['tap:up', 'tickle']);
    expect(steps.at(-1)!.out[1]).toEqual({ g: 'tickle', region: 'belly' });
  });

  it('by taps: the 3 ups may span exactly 900 ms, not 901', () => {
    expect(threeTapsEndingAt(950)).toContain('tickle');
    expect(threeTapsEndingAt(951)).not.toContain('tickle');
  });

  it('by taps: feet count together, the tickle reports the last tap’s region; the nose never tickles', () => {
    const feet = [dn(0, 400, 900), up(50, 400, 900), dn(200, 600, 900), up(250, 600, 900), dn(400, 400, 900)];
    expect(run([...feet, up(450, 400, 900)], split('footL', 'footR')).all.at(-1)).toEqual({
      g: 'tickle',
      region: 'footL',
    });
    expect(kinds(run([...feet, up(450, 400, 900)], on('nose')).all)).not.toContain('tickle');
  });

  it('by taps: the belly and the feet count separately', () => {
    const mixed = [dn(0, 200, 900), up(50, 200, 900), dn(150, 400, 900), up(200, 400, 900)];
    expect(kinds(run([...mixed, dn(300, 700, 900), up(350, 700, 900)], bellyFeet).all)).not.toContain(
      'tickle',
    );
    // footL, belly, footR, belly, footL: the feet reach 3 ups (50, 350, 650 ms); the belly only 2.
    const xs = [400, 200, 700, 200, 400];
    const taps = xs.flatMap((x, k) => [dn(k * 150, x, 900), up(k * 150 + 50, x, 900)]);
    const { steps, all } = run(taps, bellyFeet);
    expect(timesOf(steps, 'tickle')).toEqual([650]);
    expect(find(all, 'tickle')).toEqual({ g: 'tickle', region: 'footL' });
  });

  it('by taps: only tap ups count, not a dead-zone release or a stroke up', () => {
    const two = [dn(0, 500, 500), up(50, 500, 500), dn(100, 500, 500), up(150, 500, 500)];
    const dead = [...two, dn(200, 500, 500), up(650, 500, 500)];
    const stroke = [
      ...two,
      dn(200, 500, 500),
      ...line(1, 200, 500, 500, 560, 500, 10, 20),
      up(420, 560, 500),
    ];
    expect(kinds(run(dead, on('belly')).all)).not.toContain('tickle');
    expect(kinds(run(stroke, on('belly')).all)).not.toContain('tickle');
    expect(kinds(run([...two, dn(200, 500, 500), up(250, 500, 500)], on('belly')).all)).toContain('tickle');
  });

  it('by taps: every further tap up with 3 in the window tickles again', () => {
    const taps: PointerSample[] = [];
    for (let k = 0; k < 5; k++) taps.push(dn(k * 200, 500, 500), up(k * 200 + 50, 500, 500));
    expect(timesOf(run(taps, on('belly')).steps, 'tickle')).toEqual([450, 650, 850]);
  });
});

describe('flick', () => {
  // 15 px every 10 ms (1500 px/s, above the stroke range) to the right, up after 110 ms.
  const fast = [dn(0, 500, 500), ...line(1, 0, 500, 500, 650, 500, 10, 10), up(110, 665, 500)];

  it('moved ≥ 10 px, < 250 ms, release speed ≥ 800 px/s over the last 80 ms', () => {
    expect(run(fast, on('headTop')).all).toEqual([
      { g: 'tap', phase: 'down', region: 'headTop', x: 500, y: 500, count: 1 },
      { g: 'flick', region: 'headTop', vx: 1500, vy: 0 },
    ]);
  });

  it('exactly 800 px/s flicks (after a stroke: stroke end, then flick); 799 does not', () => {
    const { all } = run(flickAt(8), on('headTop'));
    expect(shape(all)).toEqual(['tap:down', 'stroke:start', 'stroke:update', 'stroke:end', 'flick']);
    expect(all.at(-1)).toEqual({ g: 'flick', region: 'headTop', vx: 800, vy: 0 });
    expect(kinds(run(flickAt(7.99), on('headTop')).all)).not.toContain('flick');
  });

  it('a flick at 700 px/s is not a flick (it is a short stroke)', () => {
    const slow = [dn(0, 500, 500), ...line(1, 0, 500, 500, 570, 500, 10, 10), up(110, 577, 500)];
    expect(shape(run(slow, on('headTop')).all)).toEqual([
      'tap:down',
      'stroke:start',
      'stroke:update',
      'stroke:end',
    ]);
  });

  it('a 249 ms gesture flicks; a 250 ms one does not', () => {
    expect(kinds(run(flickEndingAt(249), on('headTop')).all)).toEqual(['tap:down', 'flick']);
    expect(kinds(run(flickEndingAt(250), on('headTop')).all)).toEqual(['tap:down']);
  });

  it('needs ≥ 10 px of movement: a fast 9 px release is a tap, 10 px a flick', () => {
    expect(kinds(run([dn(0, 500, 500), mv(5, 504.5, 500), up(10, 509, 500)], on('headTop')).all)).toEqual([
      'tap:down',
      'tap:up',
    ]);
    expect(kinds(run([dn(0, 500, 500), mv(5, 505, 500), up(10, 510, 500)], on('headTop')).all)).toEqual([
      'tap:down',
      'flick',
    ]);
  });

  it('keeps the whole 80 ms window with 1000 Hz samples', () => {
    const trace = [dn(0, 0, 0)];
    for (let t = 1; t < 150; t++) trace.push(mv(t, t <= 100 ? 5 * t : 500 + 15 * (t - 100), 0));
    trace.push(up(150, 1250, 0));
    // 900 px between 70 ms (x = 350) and 150 ms (x = 1250): 11 250 px/s.
    expect(find(run(trace, on('headTop')).all, 'flick')).toEqual({
      g: 'flick',
      region: 'headTop',
      vx: 11250,
      vy: 0,
    });
  });

  it('measures over the last 80 ms; the position then is the latest sample at or before it', () => {
    // The pointer rested at (530, 500) from 20 ms (no events) and moved 80 px down by the up at 120 ms.
    const { all } = run([dn(0, 500, 500), mv(20, 530, 500), up(120, 530, 580)], on('headTop'));
    expect(find(all, 'flick')).toEqual({ g: 'flick', region: 'headTop', vx: 0, vy: 1000 });
    // 64 px in the last 80 ms is exactly 800 px/s; 63 px is not a flick.
    expect(
      find(run([dn(0, 500, 500), mv(20, 500, 500), up(100, 564, 500)], on('headTop')).all, 'flick'),
    ).toEqual({ g: 'flick', region: 'headTop', vx: 800, vy: 0 });
    expect(
      kinds(run([dn(0, 500, 500), mv(20, 500, 500), up(100, 563, 500)], on('headTop')).all),
    ).not.toContain('flick');
  });
});

describe('two pointers', () => {
  const cheeks = split('cheekL', 'cheekR');

  it('pinch: started on cheekL and cheekR, the span shrinks > 16 px (once)', () => {
    const trace = [
      dn(0, 400, 470, 1),
      dn(20, 600, 470, 2),
      mv(40, 408, 470, 1),
      mv(60, 592, 470, 2), // span 184: shrunk 16, not yet
      mv(80, 409, 470, 1), // span 183: shrunk 17
      mv(100, 420, 470, 1),
      up(120, 420, 470, 1),
      up(140, 592, 470, 2),
    ];
    const { steps, all } = run(trace, cheeks);
    expect(all).toEqual([
      { g: 'tap', phase: 'down', region: 'cheekL', x: 400, y: 470, count: 1 },
      { g: 'tap', phase: 'down', region: 'cheekR', x: 600, y: 470, count: 1 },
      { g: 'pinch', regions: ['cheekL', 'cheekR'], spanRatio: 0.915 },
    ]);
    expect(timesOf(steps, 'pinch')).toEqual([80]);
  });

  it('pinch in either order reports [cheekL, cheekR]', () => {
    const trace = [dn(0, 600, 470, 1), dn(20, 400, 470, 2), mv(40, 580, 470, 1)];
    expect(find(run(trace, cheeks).all, 'pinch')).toEqual({
      g: 'pinch',
      regions: ['cheekL', 'cheekR'],
      spanRatio: 0.9,
    });
  });

  it('hug: started on flankL and flankR, converging > 16 px', () => {
    const trace = [dn(0, 300, 1050, 1), dn(10, 700, 1050, 2), mv(30, 309, 1050, 1), mv(40, 691, 1050, 2)];
    expect(kinds(run(trace, split('flankL', 'flankR')).all)).toEqual(['tap:down', 'tap:down', 'hug']);
    const spread = [dn(0, 300, 1050, 1), dn(10, 700, 1050, 2), mv(30, 292, 1050, 1), mv(40, 708, 1050, 2)];
    expect(kinds(run(spread, split('flankL', 'flankR')).all)).toEqual(['tap:down', 'tap:down']);
  });

  it('the pair claims both contacts: an in-flight stroke ends, no tap up, stroke or flick follows', () => {
    const trace = [
      dn(0, 300, 470, 1),
      ...line(1, 0, 300, 470, 360, 470, 10, 20), // pointer 1 strokes cheekL
      dn(210, 600, 470, 2), // span 240
      ...line(1, 200, 360, 470, 300, 470, 10, 20), // pointer 1 moves away: no pinch
      up(420, 300, 470, 1),
      up(430, 600, 470, 2),
    ];
    const { steps, all } = run(trace, cheeks);
    expect(shape(all)).toEqual(['tap:down', 'stroke:start', 'stroke:update', 'stroke:end', 'tap:down']);
    expect(kinds(steps.find((st) => st.sample.t === 210 && st.sample.type === 'down')!.out)).toEqual([
      'stroke:end',
      'tap:down',
    ]);
  });

  it('a pair ends when a pointer lifts; a new pair can pinch again', () => {
    const trace = [
      dn(0, 400, 470, 1),
      dn(10, 600, 470, 2),
      mv(20, 420, 470, 1), // pinch
      up(30, 600, 470, 2),
      dn(40, 600, 470, 3),
      mv(50, 440, 470, 1), // span 160 from 180: pinch again
    ];
    expect(kinds(run(trace, cheeks).all)).toEqual(['tap:down', 'tap:down', 'pinch', 'tap:down', 'pinch']);
  });

  it('other pairs stay independent: one pointer strokes while the other taps', () => {
    const trace = byTime(
      dn(0, 100, 300, 1),
      ...line(1, 0, 100, 300, 160, 300, 10, 20),
      dn(100, 800, 800, 2),
      up(150, 800, 800, 2),
      up(220, 160, 300, 1),
    );
    const hit = split('headTop', 'nose');
    const { all } = run(trace, hit);
    // Pointer 1: start at 40 ms, updates at 100 and 160 ms, end at 220 ms; pointer 2 taps at 100–150 ms.
    expect(shape(all)).toEqual([
      'tap:down',
      'stroke:start',
      'stroke:update',
      'tap:down',
      'tap:up',
      'stroke:update',
      'stroke:end',
    ]);
    expect(find(all, 'tap', 'up')).toMatchObject({ region: 'nose' });
    // cheekL + flankR is no pair either: converging emits no pinch or hug.
    const mixed = split('cheekL', 'flankR');
    const conv = [dn(0, 400, 470, 1), dn(10, 600, 470, 2), mv(20, 450, 470, 1), mv(30, 550, 470, 2)];
    expect(kinds(run(conv, mixed).all)).not.toContain('pinch');
    expect(kinds(run(conv, mixed).all)).not.toContain('hug');
  });

  it('two pointers on the same cheek or the same flank are no pair: no pinch, no hug', () => {
    const conv = [dn(0, 400, 470, 1), dn(10, 600, 470, 2), mv(20, 450, 470, 1), mv(30, 550, 470, 2)];
    expect(kinds(run(conv, on('cheekL')).all)).not.toContain('pinch');
    expect(kinds(run(conv, on('cheekR')).all)).not.toContain('pinch');
    expect(kinds(run(conv, on('flankL')).all)).not.toContain('hug');
    expect(kinds(run(conv, on('flankR')).all)).not.toContain('hug');
  });

  it('a cancelled pair pointer ends the pair: no pinch afterwards', () => {
    const trace = [dn(0, 400, 470, 1), dn(10, 600, 470, 2), cancel(20, 2), mv(30, 480, 470, 1)];
    expect(kinds(run(trace, cheeks).all)).toEqual(['tap:down', 'tap:down', 'cancel']);
  });
});

describe('three or more pointers', () => {
  it('allOver once per contact; the 3rd and later pointers emit no tap', () => {
    const trace = [
      dn(0, 100, 100, 1),
      dn(10, 200, 100, 2),
      dn(20, 300, 100, 3),
      dn(30, 400, 100, 4),
      mv(40, 450, 100, 4),
      up(50, 400, 100, 4),
      up(60, 300, 100, 3), // 2 still down: latched
      dn(70, 300, 100, 5),
      up(80, 300, 100, 5),
      up(90, 200, 100, 2),
      up(100, 100, 100, 1),
    ];
    expect(kinds(run(trace, on('belly')).all)).toEqual(['tap:down', 'tap:down', 'allOver']);
  });

  it('re-arms once at most one pointer is left down (e.g. a resting thumb)', () => {
    const trace = [
      dn(0, 10, 10, 1), // the thumb
      dn(10, 200, 100, 2),
      dn(20, 300, 100, 3),
      up(30, 200, 100, 2),
      up(40, 300, 100, 3),
      dn(1000, 200, 100, 4),
      dn(1010, 300, 100, 5),
    ];
    expect(kinds(run(trace, on('belly')).all)).toEqual([
      'tap:down',
      'tap:down',
      'allOver',
      'tap:down',
      'allOver',
    ]);
  });

  it('claims every contact: in-flight long-press and stroke end, then allOver', () => {
    const trace = [
      dn(0, 100, 100, 1),
      tick(500), // pointer 1 long-presses
      dn(510, 300, 100, 2),
      ...line(2, 510, 300, 100, 360, 100, 10, 10), // pointer 2 strokes
      dn(620, 500, 100, 3),
      mv(630, 700, 100, 2),
      up(640, 100, 100, 1),
    ];
    const { steps } = run(trace, on('belly'));
    expect(kinds(steps.find((st) => st.sample.t === 620)!.out)).toEqual([
      'longPress:end',
      'stroke:end',
      'allOver',
    ]);
    expect(steps.slice(-2).map((st) => st.out)).toEqual([NO_GESTURES, NO_GESTURES]);
  });
});

describe('cancel', () => {
  it('emits cancel and nothing more for that pointer: no end phases, no tap, no flick', () => {
    const trace = [dn(0, 100, 100), tick(500), cancel(600), tick(700), mv(710, 300, 100), up(720, 300, 100)];
    const { steps, all } = run(trace, on('belly'));
    expect(kinds(all)).toEqual(['tap:down', 'longPress:start', 'cancel']);
    expect(steps.slice(3).map((st) => st.out)).toEqual([NO_GESTURES, NO_GESTURES, NO_GESTURES]);
  });

  it('breaks the multi-poke chain and the tap-tickle run', () => {
    const chain = [dn(0, 100, 100), up(50, 100, 100), dn(100, 100, 100), cancel(120), dn(200, 100, 100)];
    expect(run(chain, on('nose')).all.at(-1)).toMatchObject({ phase: 'down', count: 1 });
    // Without the cancel, the ups at 50, 150 and 350 ms would tickle.
    const taps = [dn(0, 500, 500), up(50, 500, 500), dn(100, 500, 500), up(150, 500, 500), dn(200, 500, 500)];
    taps.push(cancel(210), dn(300, 500, 500), up(350, 500, 500));
    expect(kinds(run(taps, on('belly')).all)).not.toContain('tickle');
  });

  it('a cancelled pointer leaves the state: it counts toward neither all-over nor a pair', () => {
    const three = [dn(0, 100, 100, 1), dn(10, 300, 100, 2), cancel(20, 2), dn(30, 500, 100, 3)];
    expect(kinds(run(three, on('belly')).all)).toEqual(['tap:down', 'tap:down', 'cancel', 'tap:down']);
    // A cheekL contact is cancelled; a later cheekR contact converging on where it was is a plain stroke.
    const pair = [dn(0, 400, 470, 1), cancel(10, 1), dn(20, 600, 470, 2), mv(120, 560, 470, 2)];
    expect(kinds(run(pair, split('cheekL', 'cheekR')).all)).toEqual([
      'tap:down',
      'cancel',
      'tap:down',
      'stroke:start',
    ]);
  });

  it('a second down for a pointer that is already down cancels the stale contact first', () => {
    expect(kinds(run([dn(0, 100, 100), dn(100, 300, 300)], on('belly')).all)).toEqual([
      'tap:down',
      'cancel',
      'tap:down',
    ]);
  });
});

// ---- validation 2: near misses (the issue's list) ---------------------------------------------------------------

describe('near misses', () => {
  it('moving 11 px is not a tap', () => {
    const { all } = run([dn(0, 100, 100), mv(40, 111, 100), up(80, 111, 100)], on('nose'));
    expect(kinds(all)).not.toContain('tap:up');
  });

  it('holding 499 ms is not a long-press; a release at 450 ms without movement emits nothing on up', () => {
    const held = run([dn(0, 100, 100), ...ticks(16, 496, 16), tick(499), up(499, 100, 100)], on('belly'));
    expect(kinds(held.all)).toEqual(['tap:down']);
    const dead = run([dn(0, 100, 100), ...ticks(16, 448, 16), up(450, 100, 100)], on('belly'));
    expect(kinds(dead.all)).toEqual(['tap:down']);
    expect(dead.steps.at(-1)!.out).toBe(NO_GESTURES);
  });

  it('a flick at 700 px/s is not a flick', () => {
    const slow = [dn(0, 500, 500), ...line(1, 0, 500, 500, 570, 500, 10, 10), up(110, 577, 500)];
    expect(kinds(run(slow, on('headTop')).all)).not.toContain('flick');
  });

  it('3 reversals are not a tickle', () => {
    const trace = [dn(0, 500, 500), ...path(1, 0, zigzag(500, 500, 8, 8, 2, 500), 4, 10), up(130, 500, 500)];
    expect(kinds(run(trace, on('belly')).all)).toEqual(['tap:down']);
  });
});

// ---- validation 3: properties -------------------------------------------------------------------------------------

type Op = { k: 'move'; dt: number; dx: number; dy: number } | { k: 'tick'; dt: number };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    k: fc.constant('move' as const),
    dt: fc.integer({ min: 0, max: 120 }),
    dx: fc.double({ min: -40, max: 40, noNaN: true }),
    dy: fc.double({ min: -40, max: 40, noNaN: true }),
  }),
  fc.record({ k: fc.constant('tick' as const), dt: fc.integer({ min: 0, max: 250 }) }),
);

/** Appends `ops` for pointer 1 from (t, x, y); returns the samples and the end point. */
function play(ops: readonly Op[], t0: number, x0: number, y0: number) {
  let t = t0;
  let x = x0;
  let y = y0;
  const out: PointerSample[] = [];
  for (const op of ops) {
    t += op.dt;
    if (op.k === 'tick') out.push(tick(t));
    else {
      x += op.dx;
      y += op.dy;
      out.push(mv(t, x, y));
    }
  }
  return { out, t, x, y };
}

describe('properties', () => {
  it('pointercancel: after a cancel only `cancel` is emitted, whatever follows (single pointer)', () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 40 }),
        fc.array(opArb, { maxLength: 20 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (before, after, withUp, x0, y0) => {
          const a = play(before, 0, x0, y0);
          const b = play(after, a.t + 5, a.x, a.y);
          const trace = [dn(0, x0, y0), ...a.out, cancel(a.t + 5), ...b.out];
          if (withUp) trace.push(up(b.t + 10, b.x, b.y));
          const { steps } = run(trace, grid);
          const at = 1 + a.out.length;
          expect(steps[at]!.out).toEqual([{ g: 'cancel' }]);
          for (const st of steps.slice(at + 1)) expect(st.out).toBe(NO_GESTURES);
        },
      ),
    );
  });

  it('taps are position-invariant within slop: down/up < 10 px apart within < 400 ms always tap', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -2000, max: 4000, noNaN: true }),
        fc.double({ min: -2000, max: 4000, noNaN: true }),
        fc.double({ min: 0, max: 9.999, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 399 }),
        (x, y, r, theta, t0, dt) => {
          const { all } = run(
            [dn(t0, x, y), up(t0 + dt, x + r * Math.cos(theta), y + r * Math.sin(theta))],
            grid,
          );
          const tap = { g: 'tap', region: grid(x, y), x, y, count: 1 };
          expect(all).toEqual([
            { ...tap, phase: 'down' },
            { ...tap, phase: 'up' },
          ]);
        },
      ),
    );
  });

  const sampleArb: fc.Arbitrary<PointerSample> = fc.record({
    id: fc.integer({ min: 1, max: 4 }),
    t: fc.integer({ min: 0, max: 60 }),
    x: fc.double({ min: 0, max: 1000, noNaN: true }),
    y: fc.double({ min: 0, max: 1000, noNaN: true }),
    type: fc.constantFrom('down', 'move', 'move', 'move', 'move', 'up', 'cancel', 'tick'),
  });
  /** Random multi-pointer traces; `t` is a delta, accumulated. */
  const traceArb = fc.array(sampleArb, { maxLength: 80 }).map((xs) => {
    let t = 0;
    return xs.map((s) => ({ ...s, t: (t += s.t) }));
  });

  it('is pure: never mutates its input state, and is deterministic (random multi-pointer traces)', () => {
    fc.assert(
      fc.property(traceArb, (trace) => {
        let s = deepFreeze(initialRecState());
        const outs: Gesture[][] = [];
        for (const smp of trace) {
          const [next, out] = recognize(s, smp, grid); // a mutation of a frozen state throws
          if (out.length === 0) expect(out).toBe(NO_GESTURES);
          outs.push(out);
          s = deepFreeze(next);
        }
        expect(run(trace, grid).steps.map((st) => st.out)).toEqual(outs);
      }),
    );
  });

  it('single-pointer gestures are well formed', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), fc.constantFrom('up', 'cancel'), (ops, end) => {
        const a = play(ops, 0, 500, 500);
        const last = end === 'up' ? up(a.t + 10, a.x, a.y) : cancel(a.t + 10);
        const ks = kinds(run([dn(0, 500, 500), ...a.out, last, tick(a.t + 2000)], grid).all);
        expect(ks[0]).toBe('tap:down');
        const rest = ks.slice(1);
        // Every start has exactly one end (or the cancel), nothing of that kind follows it.
        for (const g of ['stroke', 'longPress']) {
          const starts = rest.filter((k) => k === `${g}:start`).length;
          const ends = rest.filter((k) => k === `${g}:end`).length;
          expect(starts).toBeLessThanOrEqual(1);
          expect(ends).toBeLessThanOrEqual(starts);
          if (end === 'up') expect(ends).toBe(starts);
          const iEnd = rest.indexOf(`${g}:end`);
          if (iEnd >= 0) expect(rest.slice(iEnd + 1).some((k) => k.startsWith(`${g}:`))).toBe(false);
          const iUpd = rest.indexOf(`${g}:update`);
          if (iUpd >= 0) expect(iUpd).toBeGreaterThan(rest.indexOf(`${g}:start`));
        }
        // A long-press excludes every other single-pointer gesture.
        if (rest.includes('longPress:start')) {
          expect(rest.filter((k) => !k.startsWith('longPress:') && k !== 'cancel')).toEqual([]);
        }
        // A tap up is the whole story of its contact.
        if (rest.includes('tap:up')) expect(rest).toEqual(['tap:up']);
        // A cancel is last.
        if (end === 'cancel') expect(rest.at(-1)).toBe('cancel');
        else expect(rest).not.toContain('cancel');
      }),
    );
  });
});
