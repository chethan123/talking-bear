import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitView } from '../src/anim/renderer.ts';
import { POSES } from '../src/anim/poses.ts';
import { BONE_COUNT, boneMatrices, createRig, MAT } from '../src/anim/rig.ts';
import { STROKE_MIN_PATH } from '../src/input/recognizer.ts';
import type { Gesture, PointerSample } from '../src/input/recognizer.ts';
import { hitTest } from '../src/input/regions.ts';
import { evaluate, FORMAT, main, neutralHit, predict, PRIORITY, replay, VERSION } from './gesture-eval.ts';
import type { Age, GestureFile, GestureTrial, Intended } from './gesture-eval.ts';

// ---- synthetic traces -------------------------------------------------------------------------------------------

type Canvas = GestureFile['canvas'];
/** Design units = CSS px: fitView(1000, 1400) is the identity view. */
const UNIT: Canvas = { cssWidth: 1000, cssHeight: 1400, dpr: 1 };
/** fitView(720, 1100): scale 0.72, ox 0, oy 46. */
const PHONE: Canvas = { cssWidth: 720, cssHeight: 1100, dpr: 2.625 };

/** A neutral-pose design point → CSS px on `canvas` (the neutral bones are the identity). */
function css(canvas: Canvas, x: number, y: number): [number, number] {
  const v = fitView(canvas.cssWidth, canvas.cssHeight, { scale: 0, ox: 0, oy: 0 });
  return [v.scale * x + v.ox, v.scale * y + v.oy];
}

/** Design points: inside nose, belly and pawL; a horizontal line across the forehead (all headTop). */
const NOSE: [number, number] = [500, 470];
const BELLY: [number, number] = [500, 930];
const PAW: [number, number] = [328, 876];
const FOREHEAD_Y = 250;
const FOREHEAD_X0 = 380;
const FOREHEAD_X1 = 620;

function smp(type: 'down' | 'move' | 'up', id: number, t: number, x: number, y: number): PointerSample {
  return { id, t, x, y, type, pointerType: 'touch' };
}

/** Down and up at one point, `ms` apart. */
function tap(p: [number, number], t0: number, id = 1, ms = 60): PointerSample[] {
  return [smp('down', id, t0, p[0], p[1]), smp('up', id, t0 + ms, p[0], p[1])];
}

/** A held pointer: down, a frame tick every 16 ms while it is held (as the adapter feeds them), up at `ms`. */
function hold(p: [number, number], t0: number, ms: number, id = 1): PointerSample[] {
  const out = [smp('down', id, t0, p[0], p[1])];
  for (let t = t0 + 16; t < t0 + ms; t += 16) out.push({ id: -1, t, x: 0, y: 0, type: 'tick' });
  out.push(smp('up', id, t0 + ms, p[0], p[1]));
  return out;
}

/** Moves every 10 ms in a straight line from `a` to `b` over `ms` (down at `a`), without the up. */
function line(a: [number, number], b: [number, number], t0: number, ms: number, id: number): PointerSample[] {
  const out = [smp('down', id, t0, a[0], a[1])];
  for (let k = 1; k * 10 <= ms; k++) {
    const f = (k * 10) / ms;
    out.push(smp('move', id, t0 + k * 10, a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])));
  }
  return out;
}

/** Moves every 10 ms in a triangle wave along x, ±`amp` px every 40 ms, from the pointer's latest point. */
function wave(from: PointerSample, ms: number, amp: number): PointerSample[] {
  const out: PointerSample[] = [];
  for (let k = 1; k * 10 <= ms; k++) {
    const phase = (k * 10) % 80;
    const off = phase <= 40 ? (phase / 40) * amp : ((80 - phase) / 40) * amp;
    out.push(smp('move', from.id, from.t + k * 10, from.x + off, from.y));
  }
  return out;
}

/** Ends a contact: up 10 ms after its latest sample, at its latest point. */
function lift(samples: PointerSample[]): PointerSample[] {
  const last = samples[samples.length - 1]!;
  return [...samples, smp('up', last.id, last.t + 10, last.x, last.y)];
}

function stroke(c: Canvas, t0: number, id = 1): PointerSample[] {
  return lift(line(css(c, FOREHEAD_X0, FOREHEAD_Y), css(c, FOREHEAD_X1, FOREHEAD_Y), t0, 400, id));
}

function scrub(c: Canvas, t0: number, id = 1): PointerSample[] {
  const [x, y] = css(c, ...BELLY);
  const down = smp('down', id, t0, x, y);
  return lift([down, ...wave(down, 400, 20)]);
}

function trial(participant: string, age: Age, intended: Intended, samples: PointerSample[]): GestureTrial {
  return { participant, age, intended, samples };
}

function file(canvas: Canvas, trials: GestureTrial[]): GestureFile {
  return { format: FORMAT, version: VERSION, canvas, trials };
}

const adultTrial = (intended: Intended, s: PointerSample[]): GestureTrial =>
  trial('P1', 'adult', intended, s);
const childTrial = (intended: Intended, s: PointerSample[]): GestureTrial =>
  trial('P2', 'child', intended, s);

/** P1, adult, on UNIT: 11 trials, 4 correct. */
function adultFile(): GestureFile {
  const nose = css(UNIT, ...NOSE);
  const belly = css(UNIT, ...BELLY);
  const paw = css(UNIT, ...PAW);
  const longStroke = line(css(UNIT, FOREHEAD_X0, FOREHEAD_Y), css(UNIT, FOREHEAD_X1, FOREHEAD_Y), 0, 400, 1);
  return file(UNIT, [
    // tap → tap
    adultTrial('tap', tap(nose, 0)),
    // tap → none: held 450 ms, in the dead zone between a tap (< 400 ms) and a long-press (≥ 500 ms)
    adultTrial('tap', hold(nose, 0, 450)),
    // tap → tickle: three quick taps on the belly (tickle by taps; tickle > tap)
    adultTrial('tap', [...tap(belly, 0, 1), ...tap(belly, 250, 2), ...tap(belly, 500, 3)]),
    // long-press → long-press
    adultTrial('long-press', hold(paw, 0, 700)),
    // long-press → tap: released at 300 ms
    adultTrial('long-press', hold(paw, 0, 300)),
    // pet → pet: 240 px across the forehead in 400 ms
    adultTrial('pet', stroke(UNIT, 0)),
    // pet → none: a 60 px stroke (< STROKE_MIN_PATH)
    adultTrial('pet', lift(line(css(UNIT, 450, FOREHEAD_Y), css(UNIT, 510, FOREHEAD_Y), 0, 100, 1))),
    // pet → tickle: the 240 px stroke turns into a scrub (stroke end ≥ 120 px, then tickle; tickle > pet)
    adultTrial('pet', lift([...longStroke, ...wave(longStroke[longStroke.length - 1]!, 400, -20)])),
    // tickle → tickle
    adultTrial('tickle', scrub(UNIT, 0)),
    // tickle → long-press: a tap, then a long-press 200 ms later (long-press > tap)
    adultTrial('tickle', [...tap(nose, 0, 1), ...hold(paw, 260, 700, 2)]),
    // long-press → pet: a long-press, then a stroke 200 ms later (pet > long-press)
    adultTrial('long-press', [...hold(paw, 0, 700, 1), ...stroke(UNIT, 900, 2)]),
  ]);
}

/** P2, child, on PHONE: 4 trials, all correct. */
function childFile(): GestureFile {
  return file(PHONE, [
    childTrial('tap', tap(css(PHONE, ...NOSE), 0)),
    childTrial('pet', stroke(PHONE, 0)),
    childTrial('tickle', scrub(PHONE, 0)),
    childTrial('long-press', hold(css(PHONE, ...PAW), 0, 700)),
  ]);
}

// ---- files and output -------------------------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'gesture-eval-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, data: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
  return path;
}

let out: string[] = [];
let err: string[] = [];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---- tests --------------------------------------------------------------------------------------------------

/** Stands in for the DOM's `Path2D`, which Node lacks: `createRig` builds them, `boneMatrices` never touches them. */
class FakePath2D {
  readonly d: string;
  constructor(d: string) {
    this.d = d;
  }
}

const g = {
  tapDown: { g: 'tap', phase: 'down', region: 'nose', x: 1, y: 1, count: 1 },
  tapUp: { g: 'tap', phase: 'up', region: 'nose', x: 1, y: 1, count: 1 },
  lpStart: { g: 'longPress', region: 'pawL', phase: 'start' },
  lpEnd: { g: 'longPress', region: 'pawL', phase: 'end' },
  stroke: (phase: 'start' | 'update' | 'end', pathPx: number): Gesture => ({
    g: 'stroke',
    region: 'headTop',
    phase,
    pathPx,
    dir: 0,
    against: false,
  }),
  tickle: { g: 'tickle', region: 'belly' },
} satisfies Record<string, Gesture | ((...a: never[]) => Gesture)>;
const CLASS_GESTURE: Record<Intended, Gesture> = {
  tap: g.tapUp,
  'long-press': g.lpStart,
  pet: g.stroke('end', STROKE_MIN_PATH),
  tickle: g.tickle,
};

describe('predict: the issue’s gesture → class table', () => {
  it('maps each emitted gesture to its class, and anything else to none', () => {
    expect(predict([])).toBe('none');
    expect(predict([g.tapDown])).toBe('none');
    expect(predict([g.tapDown, g.tapUp])).toBe('tap');
    expect(predict([g.lpStart])).toBe('long-press');
    expect(predict([g.lpEnd])).toBe('none');
    expect(STROKE_MIN_PATH).toBe(120);
    expect(predict([g.stroke('end', 120)])).toBe('pet');
    expect(predict([g.stroke('start', 130)])).toBe('pet');
    expect(predict([g.stroke('update', 119.99), g.stroke('end', 119.99)])).toBe('none');
    expect(predict([g.tickle])).toBe('tickle');
    // Region-agnostic, as the issue's table: a long stroke on the belly is a pet too (plan §4.6.4 "Pet (belly)").
    expect(
      predict([{ g: 'stroke', region: 'belly', phase: 'end', pathPx: 150, dir: 0, against: false }]),
    ).toBe('pet');
    const others: Gesture[] = [
      { g: 'flick', region: 'headTop', vx: 900, vy: 0 },
      { g: 'pinch', regions: ['cheekL', 'cheekR'], spanRatio: 0.5 },
      { g: 'hug' },
      { g: 'allOver' },
      { g: 'cancel' },
    ];
    expect(predict(others)).toBe('none');
  });

  it('uses the highest priority: tickle > pet > long-press > tap, in either order', () => {
    expect(PRIORITY).toEqual(['tickle', 'pet', 'long-press', 'tap']);
    for (let hi = 0; hi < PRIORITY.length; hi++) {
      for (let lo = hi + 1; lo < PRIORITY.length; lo++) {
        const a = CLASS_GESTURE[PRIORITY[hi]!];
        const b = CLASS_GESTURE[PRIORITY[lo]!];
        expect(predict([a, b])).toBe(PRIORITY[hi]);
        expect(predict([b, a])).toBe(PRIORITY[hi]);
      }
    }
    expect(predict([g.tapUp, g.lpStart, g.stroke('end', 200), g.tickle])).toBe('tickle');
  });
});

describe('replay', () => {
  it('feeds the recorded frame ticks: a still long-press needs them', () => {
    const hit = neutralHit(UNIT);
    const held = hold(css(UNIT, ...PAW), 0, 700);
    expect(predict(replay(held, hit))).toBe('long-press');
    expect(
      predict(
        replay(
          held.filter((s) => s.type !== 'tick'),
          hit,
        ),
      ),
    ).toBe('none');
  });

  it('hit-tests on the file’s canvas: the same three taps tickle the belly on one canvas and not on another', () => {
    const taps = [...tap(BELLY, 0, 1), ...tap(BELLY, 250, 2), ...tap(BELLY, 500, 3)];
    const one = (canvas: Canvas) =>
      evaluate([{ name: 'x', data: file(canvas, [trial('P1', 'adult', 'tap', taps)]) }]);
    expect(one(UNIT).results[0]!.predicted).toBe('tickle');
    // On a 400 × 400 canvas the bear is 286 px tall: (500, 930) is background, and three taps there are taps.
    expect(one({ cssWidth: 400, cssHeight: 400, dpr: 1 }).results[0]!.predicted).toBe('tap');
  });

  it('replays each trial from a fresh recogniser state', () => {
    const belly = css(UNIT, ...BELLY);
    // Two belly taps (ups at 60 and 310 ms), then a trial whose tap is up at 950 ms (≥ 600 ms after the last up):
    // one shared state would see three taps within 900 ms (60 → 950) and call the second trial a tickle.
    const data = file(UNIT, [
      trial('P1', 'adult', 'tap', [...tap(belly, 0, 1), ...tap(belly, 250, 2)]),
      trial('P1', 'adult', 'tap', tap(belly, 910, 3, 40)),
    ]);
    expect(evaluate([{ name: 'x', data }]).results.map((r) => r.predicted)).toEqual(['tap', 'tap']);
  });

  it('uses the page’s geometry: the neutral pose of the real rig, fitted to the canvas', () => {
    vi.stubGlobal('Path2D', FakePath2D);
    const bones = boneMatrices(createRig(), POSES.neutral, new Float32Array(BONE_COUNT * MAT));
    const view = fitView(PHONE.cssWidth, PHONE.cssHeight, { scale: 0, ox: 0, oy: 0 });
    const hit = neutralHit(PHONE);
    const seen = new Set<string>();
    for (let y = 0; y <= PHONE.cssHeight; y += 4) {
      for (let x = 0; x <= PHONE.cssWidth; x += 4) {
        const want = hitTest(x, y, bones, view);
        expect(hit(x, y)).toBe(want);
        seen.add(want);
      }
    }
    expect(seen.size).toBe(17);
  });
});

describe('evaluate and the report', () => {
  it('gives the exact confusion matrix, per-class, overall and per-age accuracy', () => {
    const e = evaluate([
      { name: 'a.json', data: adultFile() },
      { name: 'b.json', data: childFile() },
    ]);
    // Rows: tap, long-press, pet, tickle. Columns: tap, long-press, pet, tickle, none.
    expect(e.matrix).toEqual([
      [2, 0, 0, 1, 1],
      [1, 2, 1, 0, 0],
      [0, 0, 2, 1, 1],
      [0, 1, 0, 2, 0],
    ]);
    expect(e.overall).toEqual({ trials: 15, correct: 8 });
    expect(e.byAge).toEqual({ adult: { trials: 11, correct: 4 }, child: { trials: 4, correct: 4 } });
  });

  it('prints the matrix, the accuracies and every misclassified trial', () => {
    const a = write('a.json', adultFile());
    const b = write('b.json', childFile());
    expect(main([a, b])).toBe(0);
    expect(err).toEqual([]);
    expect(out.slice(0, 11)).toEqual([
      'gesture-eval: 2 files, 15 trials: P1 (adult, 11 trials), P2 (child, 4 trials)',
      '',
      'intended \\ predicted  tap  long-press  pet  tickle  none  trials  accuracy',
      'tap                     2           0    0       1     1       4    50.0 %',
      'long-press              1           2    1       0     0       4    50.0 %',
      'pet                     0           0    2       1     1       4    50.0 %',
      'tickle                  0           1    0       2     0       3    66.7 %',
      '',
      'overall (tap, long-press, pet, tickle): 53.3 % (8/15)',
      'adult: 36.4 % (4/11) · child: 100.0 % (4/4)',
      'misclassified: 7',
    ]);
    const misses = out.slice(11).map((l) => l.slice(0, l.indexOf(': ', l.indexOf('predicted'))));
    expect(misses).toEqual([
      `  ${a} trial 2 (P1, adult): intended tap, predicted none`,
      `  ${a} trial 3 (P1, adult): intended tap, predicted tickle`,
      `  ${a} trial 5 (P1, adult): intended long-press, predicted tap`,
      `  ${a} trial 7 (P1, adult): intended pet, predicted none`,
      `  ${a} trial 8 (P1, adult): intended pet, predicted tickle`,
      `  ${a} trial 10 (P1, adult): intended tickle, predicted long-press`,
      `  ${a} trial 11 (P1, adult): intended long-press, predicted pet`,
    ]);
    expect(out[12]).toBe(
      `  ${a} trial 3 (P1, adult): intended tap, predicted tickle: tap down belly, tap up belly, tap down belly ×2, tap up belly ×2, tap down belly ×3, tap up belly ×3, tickle belly`,
    );
  });
});

/** 10 tap trials, 9 of them correct: exactly 90 %. */
function ninety(): string {
  const nose = css(UNIT, ...NOSE);
  const trials = Array.from({ length: 9 }, () => trial('P3', 'adult', 'tap', tap(nose, 0)));
  trials.push(trial('P3', 'adult', 'tap', hold(nose, 0, 450)));
  return write('ninety.json', file(UNIT, trials));
}

describe('--min and exit codes', () => {
  it('exits 0 at or above the minimum and 1 below it', () => {
    const f = ninety();
    expect(main([f])).toBe(0);
    expect(main([f, '--min', '0.9'])).toBe(0);
    expect(out.at(-1)).toBe('--min 0.9: overall 90.0 % ≥ 90.0 %: PASS');
    expect(main([f, '--min', '0.91'])).toBe(1);
    expect(err.at(-1)).toBe('--min 0.91: overall 90.0 % is below 91.0 %: FAIL');
    expect(main(['--min', '0.9', write('ab.json', adultFile())])).toBe(1);
    expect(main([write('b.json', childFile()), '--min', '1'])).toBe(0);
    expect(main([write('a.json', adultFile()), '--min', '0'])).toBe(0);
  });

  it('scores correct ÷ trials, not the mean of the per-class accuracies', () => {
    // 9 correct taps and 1 pet trial predicted none (a 60 px stroke): 9/10 = 90 % overall, while the mean of the
    // per-class accuracies (tap 100 %, pet 0 %) would be 50 %.
    const nose = css(UNIT, ...NOSE);
    const trials = Array.from({ length: 9 }, () => trial('P4', 'adult', 'tap', tap(nose, 0)));
    trials.push(
      trial(
        'P4',
        'adult',
        'pet',
        lift(line(css(UNIT, 450, FOREHEAD_Y), css(UNIT, 510, FOREHEAD_Y), 0, 100, 1)),
      ),
    );
    const data = file(UNIT, trials);
    const e = evaluate([{ name: 'x', data }]);
    expect(e.matrix).toEqual([
      [9, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 1],
      [0, 0, 0, 0, 0],
    ]);
    const rows = e.matrix
      .map((row, r) => ({ n: row.reduce((a, b) => a + b, 0), ok: row[r]! }))
      .filter((x) => x.n > 0);
    expect(rows.reduce((a, x) => a + x.ok / x.n, 0) / rows.length).toBe(0.5);
    expect(main([write('mixed.json', data), '--min', '0.9'])).toBe(0);
    expect(out).toContain('overall (tap, long-press, pet, tickle): 90.0 % (9/10)');
    expect(out.at(-1)).toBe('--min 0.9: overall 90.0 % ≥ 90.0 %: PASS');
  });

  it('exits 2 on a usage error', () => {
    const f = ninety();
    for (const args of [
      [],
      ['--min', '0.9'],
      [f, '--min'],
      [f, '--min', ''],
      [f, '--min', '1.5'],
      [f, '--min', '-0.1'],
      [f, '--min', 'x'],
      [f, '--min', '0.5', '--min', '0.6'],
      [f, '--max', '1'],
    ]) {
      err = [];
      expect(main(args)).toBe(2);
      expect(err.join('\n')).toContain('usage: node scripts/gesture-eval.ts');
    }
  });

  it('exits 2 on a file it can’t read or that isn’t a valid trace file, naming the problem', () => {
    const good = (): GestureFile => file(UNIT, [trial('P1', 'adult', 'tap', tap(NOSE, 0))]);
    /** `good()` with its one trial's fields replaced (as raw JSON, so they can be invalid). */
    const withTrial = (patch: Record<string, unknown>): unknown => ({
      ...good(),
      trials: [{ ...good().trials[0]!, ...patch }],
    });
    const cases: [unknown, string][] = [
      ['{', 'JSON'],
      [[], 'expected a JSON object'],
      [{ ...good(), format: 'other' }, 'format'],
      [{ ...good(), version: 2 }, 'version'],
      [{ ...good(), canvas: undefined }, 'canvas'],
      [{ ...good(), canvas: { cssWidth: 0, cssHeight: 10, dpr: 1 } }, 'canvas.cssWidth'],
      [{ ...good(), canvas: { cssWidth: 10, cssHeight: 10 } }, 'canvas.dpr'],
      [{ ...good(), trials: {} }, 'trials'],
      [withTrial({ participant: 'Alice' }), 'trials[0].participant'],
      [withTrial({ age: 'teen' }), 'trials[0].age'],
      [withTrial({ intended: 'wave' }), 'trials[0].intended'],
      [withTrial({ samples: {} }), 'trials[0].samples'],
      [withTrial({ samples: [{ id: 1, t: '5', x: 0, y: 0, type: 'down' }] }), 'trials[0].samples[0].t'],
      [withTrial({ samples: [{ id: 1, t: 5, x: 0, y: 0, type: 'hover' }] }), 'trials[0].samples[0].type'],
      [
        withTrial({ samples: [{ id: 1, t: 5, x: 0, y: 0, type: 'down', pointerType: 'eye' }] }),
        'trials[0].samples[0].pointerType',
      ],
    ];
    expect(main([write('good.json', good())])).toBe(0);
    for (const [data, needle] of cases) {
      err = [];
      const path = write('bad.json', data);
      expect(main([path])).toBe(2);
      expect(err.join('\n')).toContain(`gesture-eval: ${path}: `);
      expect(err.join('\n')).toContain(needle);
    }
    err = [];
    expect(main([join(dir, 'missing.json')])).toBe(2);
    expect(err.join('\n')).toContain('missing.json');
    err = [];
    expect(main([write('empty.json', file(UNIT, []))])).toBe(2);
    expect(err).toEqual(['gesture-eval: the files hold no trials']);
  });
});
