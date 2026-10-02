/**
 * Renderer tests in Vitest Browser Mode (issue #75): the canvas setup, one screenshot per key pose, and the
 * checks that `render` allocates nothing per frame.
 *
 * The screenshots are rendered once each, with no rAF loop: `render` is a pure function of the pose, so a fixed
 * pose is a fixed seed and time. Baselines live in `__screenshots__/renderer.browser.test.ts/`; regenerate them
 * with `pnpm test:browser --update` on Linux after a Playwright or Chromium bump. Never loosen the comparison.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { POSES } from './poses.ts';
import type { PoseName } from './poses.ts';
import { PARTS } from '../art/bear-parts.gen.ts';
import { Ch, createPose } from './pose.ts';
import type { Pose } from './pose.ts';
import { BG_BOTTOM, BG_TOP, createContext, fitView, render, resizeCanvas } from './renderer.ts';
import type { View } from './renderer.ts';
import { BONE_COUNT, boneMatrices, createRig, MAT, partIndex, partMatrix } from './rig.ts';

const CSS_WIDTH = 500;
const CSS_HEIGHT = 700;
/** Every key pose, in `POSES` order. */
const NAMES = Object.keys(POSES).filter((name): name is PoseName => name in POSES);

beforeAll(async () => {
  // The default tester viewport (414 px wide) can't hold the 500 × 700 canvas: enlarge it, never shrink the canvas.
  await page.viewport(CSS_WIDTH + 100, CSS_HEIGHT + 100);
});

/** A canvas of `cssWidth × cssHeight` CSS px at DPR 1, alone in the page, with its context and fitted view. */
function mount(
  cssWidth: number,
  cssHeight: number,
): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; view: View } {
  const canvas = document.createElement('canvas');
  resizeCanvas(canvas, cssWidth, cssHeight, 1);
  document.body.replaceChildren(canvas);
  const g = createContext(canvas);
  const view = fitView(canvas.width, canvas.height, { scale: 0, ox: 0, oy: 0 });
  return { canvas, g, view };
}

describe('canvas setup', () => {
  test('resizeCanvas: backing store = CSS size × min(devicePixelRatio, 2)', () => {
    const canvas = document.createElement('canvas');
    for (const [dpr, width, height] of [
      [1, 500, 700],
      [1.5, 750, 1050],
      [2, 1000, 1400],
      [2.625, 1000, 1400],
      [3, 1000, 1400],
    ] as const) {
      resizeCanvas(canvas, 500, 700, dpr);
      expect([canvas.width, canvas.height], `dpr ${dpr}`).toEqual([width, height]);
    }
  });

  test('fitView fits the 1000 × 1400 design box, centred', () => {
    const view: View = { scale: 0, ox: 0, oy: 0 };
    expect(fitView(500, 700, view)).toEqual({ scale: 0.5, ox: 0, oy: 0 });
    expect(fitView(800, 700, view)).toEqual({ scale: 0.5, ox: 150, oy: 0 });
    expect(fitView(500, 1000, view)).toEqual({ scale: 0.5, ox: 0, oy: 150 });
    expect(fitView(1000, 1400, view)).toBe(view);
  });

  test("createContext asks for getContext('2d', { alpha: false })", () => {
    const g = createContext(document.createElement('canvas'));
    expect(g.getContextAttributes().alpha).toBe(false);
  });
});

describe('key poses match their baselines', () => {
  for (const name of NAMES) {
    test(name, async () => {
      expect(window.devicePixelRatio).toBe(1);
      const { canvas, g, view } = mount(CSS_WIDTH, CSS_HEIGHT);
      expect([canvas.width, canvas.height]).toEqual([500, 700]);
      expect(view).toEqual({ scale: 0.5, ox: 0, oy: 0 });
      render(g, createRig(), POSES[name], view);
      await expect.element(canvas).toMatchScreenshot(name);
    });
  }
});

type Constructor = new (...args: never[]) => object;

/** Wraps `original` so that every `new` of it, including those inside its static `from` and `of`, calls `onNew`. */
function countingConstructor<C extends Constructor>(original: C, onNew: () => void): C {
  return new Proxy(original, {
    construct(target, args: never[], newTarget: Constructor): object {
      onNew();
      return Reflect.construct(target, args, newTarget);
    },
  });
}

/** `%TypedArray%.prototype`, which every typed array class inherits its methods from. */
const TYPED_ARRAY_PROTOTYPE = Reflect.getPrototypeOf(Float32Array.prototype) ?? Float32Array.prototype;
/** Its methods that return a new typed array. */
const TYPED_ARRAY_METHODS = ['slice', 'map', 'filter', 'subarray', 'toReversed', 'toSorted', 'with'] as const;
/** `CanvasRenderingContext2D` methods that return a new object. */
const CANVAS_METHODS = [
  'createLinearGradient',
  'createRadialGradient',
  'createConicGradient',
  'createPattern',
  'createImageData',
  'getImageData',
  'getTransform',
  'getLineDash',
  'measureText',
] as const;

/**
 * Runs `fn` and counts the allocations it makes through the array and canvas globals (the pattern of
 * src/dsp/voicing.test.ts, plus the canvas): every `new` of `Array`, `ArrayBuffer`, `Float32Array`,
 * `Float64Array`, `Path2D` or `DOMMatrix` (static `from` and `of` included, and `new` through a typed array's
 * `constructor`), and every call of an allocating `%TypedArray%.prototype` or `CanvasRenderingContext2D`
 * method. Everything is restored afterwards.
 */
function countAllocations(fn: () => void): number {
  let count = 0;
  const onNew = (): void => {
    count++;
  };
  const saved: { obj: object; key: string; desc: PropertyDescriptor }[] = [];
  const patch = (obj: object, key: string, value: unknown): void => {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc === undefined) throw new Error(`nothing to patch at ${key}`);
    saved.push({ obj, key, desc });
    Object.defineProperty(obj, key, { ...desc, value });
  };
  const countCalls = (obj: object, name: string): void => {
    const original: unknown = Reflect.get(obj, name);
    if (typeof original !== 'function') throw new Error(`no method ${name}`);
    patch(obj, name, function (this: unknown, ...args: unknown[]): unknown {
      count++;
      return Reflect.apply(original, this, args);
    });
  };
  const float32 = countingConstructor(Float32Array, onNew);
  const float64 = countingConstructor(Float64Array, onNew);
  patch(Float32Array.prototype, 'constructor', float32);
  patch(Float64Array.prototype, 'constructor', float64);
  patch(globalThis, 'Array', countingConstructor(Array, onNew));
  patch(globalThis, 'ArrayBuffer', countingConstructor(ArrayBuffer, onNew));
  patch(globalThis, 'Float32Array', float32);
  patch(globalThis, 'Float64Array', float64);
  patch(globalThis, 'Path2D', countingConstructor(Path2D, onNew));
  patch(globalThis, 'DOMMatrix', countingConstructor(DOMMatrix, onNew));
  for (const name of TYPED_ARRAY_METHODS) countCalls(TYPED_ARRAY_PROTOTYPE, name);
  for (const name of CANVAS_METHODS) countCalls(CanvasRenderingContext2D.prototype, name);
  try {
    fn();
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) {
      const { obj, key, desc } = saved[i]!;
      Object.defineProperty(obj, key, desc);
    }
  }
  return count;
}

function doNothing(): void {}

/** A neutral pose with the mouth channels `Jaw` and `Teeth` set. */
function mouth(jaw: number, teeth: number): Pose {
  const p = createPose();
  p[Ch.Jaw] = jaw;
  p[Ch.Teeth] = teeth;
  return p;
}

/** `performance.memory.usedJSHeapSize` (Chromium; precise with --enable-precise-memory-info). */
function usedJSHeapSize(): number {
  const memory: unknown = Reflect.get(performance, 'memory');
  const bytes: unknown =
    typeof memory === 'object' && memory !== null ? Reflect.get(memory, 'usedJSHeapSize') : undefined;
  if (typeof bytes !== 'number') throw new Error('no performance.memory.usedJSHeapSize');
  return bytes;
}

/**
 * Counts `save()` and `restore()` calls on every 2D context until `stop()`. It patches the prototype, as
 * `countAllocations` does: own-property wrappers on the context (and deleting them afterwards) would turn it
 * into a dictionary-mode object, pollute `render`'s inline caches, and make later heap readings dirty.
 */
function countSaves(): { saves: number; restores: number; stop: () => void } {
  const proto = CanvasRenderingContext2D.prototype;
  const saveDesc = Object.getOwnPropertyDescriptor(proto, 'save');
  const restoreDesc = Object.getOwnPropertyDescriptor(proto, 'restore');
  const save: unknown = saveDesc?.value;
  const restore: unknown = restoreDesc?.value;
  if (
    saveDesc === undefined ||
    restoreDesc === undefined ||
    typeof save !== 'function' ||
    typeof restore !== 'function'
  ) {
    throw new Error('no CanvasRenderingContext2D.prototype.save/restore');
  }
  const counts = {
    saves: 0,
    restores: 0,
    stop: (): void => {
      Object.defineProperty(proto, 'save', saveDesc);
      Object.defineProperty(proto, 'restore', restoreDesc);
    },
  };
  Object.defineProperty(proto, 'save', {
    ...saveDesc,
    value: function (this: unknown): void {
      counts.saves++;
      Reflect.apply(save, this, []);
    },
  });
  Object.defineProperty(proto, 'restore', {
    ...restoreDesc,
    value: function (this: unknown): void {
      counts.restores++;
      Reflect.apply(restore, this, []);
    },
  });
  return counts;
}

describe('render allocates nothing per frame', () => {
  test('the counter sees Path2D, gradient, matrix and typed-array allocations (positive control)', () => {
    const { g } = mount(100, 140);
    expect(countAllocations(() => void new Path2D('M 0 0 L 1 1'))).toBe(1);
    expect(countAllocations(() => void g.createLinearGradient(0, 0, 0, 1))).toBe(1);
    expect(countAllocations(() => void g.getTransform())).toBeGreaterThan(0);
    expect(countAllocations(() => void new Float64Array(4))).toBe(1);
  });

  test('no Path2D, gradient, matrix or array per frame; one gradient per resize; save/restore balanced', () => {
    const { canvas, g, view } = mount(100, 140);
    const rig = createRig();
    render(g, rig, POSES.neutral, view); // the first frame at this size builds the background gradient
    const frames = countAllocations(() => {
      for (let k = 0; k < 3; k++) for (const name of NAMES) render(g, rig, POSES[name], view);
    });
    expect(frames).toBe(0);

    // Each frame leaves the context as it found it: every save() restored, globalAlpha back to 1. The exact
    // save count also tells which drawMouth branch ran: 2 is the sclera clips alone, 3 adds the mouth clip
    // (drawn when the tongue or the teeth show). So the cases include each threshold, just off it on both
    // sides and exactly on it (pose channels are float32: see TONGUE_MIN / TEETH_MIN in renderer.ts).
    const gallery: Record<PoseName, number> = {
      neutral: 2,
      blink: 2,
      listening: 2,
      talkOpen: 3,
      talkRound: 3,
      asleep: 2,
      squish: 2,
      dizzy: 3,
    };
    const cases: (readonly [string, Pose, number])[] = NAMES.map(
      (name) => [name, POSES[name], gallery[name]] as const,
    );
    cases.push(
      ['open mouth, no tongue or teeth (Jaw 0.1)', mouth(0.1, 0), 2],
      ['teeth, no tongue (Jaw 0.1, Teeth 0.6)', mouth(0.1, 0.6), 3],
      ['just under both thresholds (Jaw 0.149, Teeth 0.299)', mouth(0.149, 0.299), 2],
      ['exactly on both thresholds (Jaw 0.15, Teeth 0.3)', mouth(0.15, 0.3), 2],
      ['tongue just over (Jaw 0.151)', mouth(0.151, 0), 3],
      ['teeth just over (Jaw 0.1, Teeth 0.301)', mouth(0.1, 0.301), 3],
    );
    const counts = countSaves();
    try {
      for (const [name, pose, saves] of cases) {
        counts.saves = 0;
        counts.restores = 0;
        g.globalAlpha = 0.4;
        render(g, rig, pose, view);
        expect(counts.saves, name).toBe(saves);
        expect(counts.restores, name).toBe(saves);
        expect(g.globalAlpha, name).toBe(1);
      }
    } finally {
      counts.stop();
    }

    resizeCanvas(canvas, 120, 168, 1);
    fitView(canvas.width, canvas.height, view);
    const afterResize = countAllocations(() => {
      render(g, rig, POSES.neutral, view);
      render(g, rig, POSES.dizzy, view);
    });
    expect(afterResize).toBe(1);
  });

  test(
    'usedJSHeapSize stays flat once warm: round-robin warm-up, then 3 clean 5 000-frame runs per pose',
    { timeout: 240_000 },
    () => {
      const gc: unknown = Reflect.get(globalThis, 'gc');
      if (typeof gc !== 'function')
        throw new Error('needs Chromium with --js-flags=--expose-gc (vitest.config.ts)');
      const { g, view } = mount(100, 140);
      const rig = createRig();
      const FRAMES = 5000;
      const BOUND = 16 * 1024;
      /** Heap growth over `FRAMES` frames (frame k draws `poses[k % poses.length]`, then `extra(k)`), after a GC. */
      const measure = (poses: readonly Pose[], extra: (k: number) => void): number => {
        gc();
        const before = usedJSHeapSize();
        for (let k = 0; k < FRAMES; k++) {
          render(g, rig, poses[k % poses.length]!, view);
          extra(k);
        }
        return usedJSHeapSize() - before;
      };
      /**
       * Measures until 3 consecutive runs are clean or `max` runs are done. Clean is −1 KB < growth < BOUND:
       * right after a forced GC the reading can drop by a few bytes (CI's Chromium read −16 B on clean runs,
       * this sandbox −156 B), while a larger drop means memory was freed during the run, which could hide an
       * allocation, so it counts as inconclusive, not clean.
       */
      const settle = (poses: readonly Pose[], max: number): { ok: boolean; history: number[] } => {
        const history: number[] = [];
        let streak = 0;
        while (streak < 3 && history.length < max) {
          const growth = measure(poses, doNothing);
          history.push(growth);
          streak = growth > -1024 && growth < BOUND ? streak + 1 : 0;
        }
        return { ok: streak === 3, history };
      };
      // V8 needs tens of thousands of frames to finish optimising `render` (until then it boxes doubles), so
      // warm up round-robin over every pose until 3 runs in a row are clean, up to 40 runs.
      const warm = settle(
        NAMES.map((name) => POSES[name]),
        40,
      );
      expect(warm.ok, `round-robin heap growth per run (bytes): ${warm.history.join(', ')}`).toBe(true);
      // Then each pose on its own, so a branch only one pose takes (teeth, tongue, stars, blush, lids) runs on
      // every measured frame. One boxed number per frame measured about 12 to 28 KB per 5 000-frame run (a
      // single run can dip under the 16 KB bound), so what makes the kill reliable is the rule that 3
      // consecutive runs must be clean: an allocating pose never gets there.
      const perPose = NAMES.map((name) => ({ name, ...settle([POSES[name]], 10) }));
      const report = perPose.map((p) => `${p.name}: ${p.history.join(', ')}`).join('; ');
      expect(
        perPose.every((p) => p.ok),
        `per-pose heap growth per run (bytes): ${report}`,
      ).toBe(true);
      // Positive control: one small object kept per frame, retained (a scavenge can't free it), is seen.
      // Preallocated, so growing the array is not what the meter sees (not new Array(n): unicorn/no-new-array).
      const kept = Array.from<unknown>({ length: FRAMES });
      const leak = measure(
        NAMES.map((name) => POSES[name]),
        (k) => {
          kept[k] = { k: k + 0.5 };
        },
      );
      expect(kept.filter((x) => x !== undefined)).toHaveLength(FRAMES);
      expect(leak).toBeGreaterThanOrEqual(BOUND);
    },
  );
});

/** `#RRGGBB` → [r, g, b]. */
function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

/** The [r, g, b] of canvas pixel (x, y). */
function pixel(g: CanvasRenderingContext2D, x: number, y: number): number[] {
  return Array.from(g.getImageData(x, y, 1, 1).data.subarray(0, 3));
}

function expectRgbNear(
  actual: readonly number[],
  expected: readonly number[],
  tolerance: number,
  what: string,
): void {
  for (let k = 0; k < 3; k++) {
    expect(
      Math.abs(actual[k]! - expected[k]!),
      `${what}: [${actual.join(', ')}] vs [${expected.join(', ')}]`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

/** The run of non-sclera pixels (blue < 200: iris #E3A43A, pupil #1A1216) through canvas pixel (x, y), as [first, last] x. */
function irisRun(g: CanvasRenderingContext2D, x: number, y: number): [number, number] {
  const row = g.getImageData(0, y, CSS_WIDTH, 1).data;
  const inside = (px: number): boolean => row[4 * px + 2]! < 200;
  expect(inside(x), 'the probe pixel is iris or pupil').toBe(true);
  let first = x;
  while (first > 0 && inside(first - 1)) first--;
  let last = x;
  while (last < CSS_WIDTH - 1 && inside(last + 1)) last++;
  return [first, last];
}

describe('blush and context reset (pixel checks, no screenshot)', () => {
  test('the squish blush is 0.35·#F2A07B over what lies under it; render resets a dirty context', () => {
    const { g, view } = mount(CSS_WIDTH, CSS_HEIGHT);
    const rig = createRig();
    const squish = POSES.squish;
    expect(squish[Ch.Blush]).toBe(1);
    const noBlush = squish.slice();
    noBlush[Ch.Blush] = 0;
    // The posed centres of blushL and blushR in canvas pixels: bbox centre → partMatrix → view.
    const bones = boneMatrices(rig, squish, new Float32Array(BONE_COUNT * MAT));
    const m = new Float64Array(MAT);
    const centres = ['blushL', 'blushR'].map((id): readonly [number, number] => {
      const part = partIndex(id);
      const [x0, y0, x1, y1] = PARTS[part]!.bbox;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      partMatrix(rig, squish, bones, part, m);
      const x = m[0]! * cx + m[2]! * cy + m[4]!;
      const y = m[1]! * cx + m[3]! * cy + m[5]!;
      return [Math.floor(view.scale * x + view.ox), Math.floor(view.scale * y + view.oy)];
    });

    // A dirty context: black everywhere, then a stray alpha and transform left behind.
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = '#000000';
    g.fillRect(0, 0, CSS_WIDTH, CSS_HEIGHT);
    g.globalAlpha = 0.25;
    g.setTransform(0.1, 0, 0, 0.1, 0, 0);

    render(g, rig, noBlush, view);
    expectRgbNear(pixel(g, 2, 2), rgb(BG_TOP), 3, 'top-left background');
    expectRgbNear(pixel(g, CSS_WIDTH - 3, CSS_HEIGHT - 3), rgb(BG_BOTTOM), 3, 'bottom-right background');
    const under = centres.map(([x, y]) => pixel(g, x, y));

    render(g, rig, squish, view);
    const blush = rgb('#F2A07B');
    centres.forEach(([x, y], i) => {
      const base = under[i]!;
      const expected = blush.map((c, k) => Math.round(0.35 * c + 0.65 * base[k]!));
      expect(Math.abs(expected[0]! - base[0]!), 'the blush visibly changes the pixel').toBeGreaterThan(10);
      expectRgbNear(pixel(g, x, y), expected, 2, `blush centre ${i === 0 ? 'L' : 'R'} at (${x}, ${y})`);
    });
  });

  test('the tongue shows only when Jaw > 0.15 and the teeth only when Teeth > 0.3', () => {
    const { g, view } = mount(CSS_WIDTH, CSS_HEIGHT);
    const rig = createRig();
    /** The canvas pixel over design point (x, y) in jaw space, which is design space here (no bone moves). */
    const at = (x: number, y: number): number[] =>
      pixel(g, Math.floor(view.scale * x + view.ox), Math.floor(view.scale * y + view.oy));
    // The tongue ellipse is centred at (500, 525 + 0.8·open), open = 110·Jaw: pink just over the threshold,
    // the mouth interior just under it.
    for (const [jaw, colour] of [
      [0.151, '#E07A7A'],
      [0.149, '#5A1E2E'],
    ] as const) {
      render(g, rig, mouth(jaw, 0), view);
      expectRgbNear(at(500, 525 + 0.8 * 110 * Math.fround(jaw)), rgb(colour), 2, `Jaw ${jaw}: tongue centre`);
    }
    // At Jaw 0.7 the teeth's visible band runs from the top lip curve (y ≈ 534) to y ≈ 547, and the tongue
    // starts below y ≈ 560: (500, 541) is white with teeth and the mouth interior without.
    for (const [teeth, colour] of [
      [0.301, '#FFFFFF'],
      [0.299, '#5A1E2E'],
    ] as const) {
      render(g, rig, mouth(0.7, teeth), view);
      expectRgbNear(at(500, 541), rgb(colour), 2, `Teeth ${teeth}: teeth centre`);
    }
  });

  test('the iris, pupil and highlight are clipped to the sclera', () => {
    const rig = createRig();
    // The iris is a circle (centre and radius from its bbox), the sclera an ellipse (from its bbox).
    const [ix0, iy0, ix1, iy1] = PARTS[partIndex('irisL')]!.bbox;
    const [sx0, sy0, sx1, sy1] = PARTS[partIndex('scleraL')]!.bbox;
    const r = (ix1 - ix0) / 2;
    const shifted = createPose();
    shifted[Ch.IrisX] = 10;
    shifted[Ch.IrisY] = -10;
    const m = new Float64Array(MAT);
    partMatrix(
      rig,
      shifted,
      boneMatrices(rig, shifted, new Float32Array(BONE_COUNT * MAT)),
      partIndex('irisL'),
      m,
    );
    const icx = (ix0 + ix1) / 2;
    const icy = (iy0 + iy1) / 2;
    const cx = m[0]! * icx + m[2]! * icy + m[4]!;
    const cy = m[1]! * icx + m[3]! * icy + m[5]!;
    // A point 0.95·r up and to the right of the shifted iris centre: inside the iris, just outside the sclera.
    const qx = cx + 0.95 * r * Math.SQRT1_2;
    const qy = cy - 0.95 * r * Math.SQRT1_2;
    const inSclera = ((2 * qx - sx0 - sx1) / (sx1 - sx0)) ** 2 + ((2 * qy - sy0 - sy1) / (sy1 - sy0)) ** 2;
    expect(inSclera, 'the probe point is outside the sclera').toBeGreaterThan(1.04);
    // Zoom ×4 onto the point, so the sliver of iris outside the sclera is several pixels wide.
    const { g } = mount(CSS_WIDTH, CSS_HEIGHT);
    const view: View = { scale: 4, ox: CSS_WIDTH / 2 - 4 * qx, oy: CSS_HEIGHT / 2 - 4 * qy };
    render(g, rig, createPose(), view);
    const fur = pixel(g, CSS_WIDTH / 2, CSS_HEIGHT / 2);
    expectRgbNear(fur, rgb('#2F7A6D'), 2, 'the probe point is head fur with the iris centred');
    render(g, rig, shifted, view);
    expectRgbNear(
      pixel(g, CSS_WIDTH / 2, CSS_HEIGHT / 2),
      fur,
      2,
      'the iris outside the sclera is clipped away',
    );
  });

  test('IrisConverge 6 moves the left iris +6 and the right iris −6 in screen x, at the neutral pose (#222)', () => {
    const rig = createRig();
    const SCALE = 4;
    const converged = createPose();
    converged[Ch.IrisConverge] = 6;
    for (const [id, shift] of [
      ['irisL', 6],
      ['irisR', -6],
    ] as const) {
      // Zoom ×4 onto the iris's rest centre, at the canvas centre: 1 design unit = 4 px.
      const [x0, y0, x1, y1] = PARTS[partIndex(id)]!.bbox;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const { g } = mount(CSS_WIDTH, CSS_HEIGHT);
      const view: View = { scale: SCALE, ox: CSS_WIDTH / 2 - SCALE * cx, oy: CSS_HEIGHT / 2 - SCALE * cy };
      const px = CSS_WIDTH / 2;
      const py = CSS_HEIGHT / 2;
      render(g, rig, createPose(), view);
      const [n0, n1] = irisRun(g, px, py);
      render(g, rig, converged, view);
      const [c0, c1] = irisRun(g, px, py);
      // Neutral: the run is the whole iris (diameter 60 units = 240 px), centred on its rest centre.
      expect(Math.abs(n1 + 1 - n0 - SCALE * (x1 - x0)), `${id}: neutral iris width`).toBeLessThanOrEqual(2);
      expect(Math.abs((n0 + n1 + 1) / 2 - px), `${id}: neutral iris centre`).toBeLessThanOrEqual(1);
      // Converged: the same width (not clipped by the sclera), its centre moved by shift design units in screen x.
      expect(c1 - c0, `${id}: converged iris width`).toBe(n1 - n0);
      const moved = ((c0 + c1 + 1) / 2 - (n0 + n1 + 1) / 2) / SCALE;
      expect(Math.abs(moved - shift), `${id}: moved ${moved} design units`).toBeLessThanOrEqual(0.25);
    }
  });

  test('render applies the view offset: centred fits on 700×700 (ox 100) and 500×900 (oy 100)', () => {
    const rig = createRig();
    const pose = POSES.talkOpen;
    const bones = boneMatrices(rig, pose, new Float32Array(BONE_COUNT * MAT));
    const m = new Float64Array(MAT);
    for (const [width, height, ox, oy] of [
      [700, 700, 100, 0],
      [500, 900, 0, 100],
    ] as const) {
      const { g, view } = mount(width, height);
      expect(view).toEqual({ scale: 0.5, ox, oy });
      render(g, rig, pose, view);
      /** The canvas pixel over the posed bbox centre of `id`. */
      const centreOf = (id: string): number[] => {
        const part = partIndex(id);
        const [x0, y0, x1, y1] = PARTS[part]!.bbox;
        const x = (x0 + x1) / 2;
        const y = (y0 + y1) / 2;
        partMatrix(rig, pose, bones, part, m);
        const px = m[0]! * x + m[2]! * y + m[4]!;
        const py = m[1]! * x + m[3]! * y + m[5]!;
        return pixel(g, Math.floor(view.scale * px + view.ox), Math.floor(view.scale * py + view.oy));
      };
      const where = `${width}×${height}`;
      // Parts go through the part loop's setTransform; the mouth goes through setBoneTransform.
      expectRgbNear(centreOf('pupilL'), rgb('#1A1216'), 2, `${where}: pupilL centre`);
      expectRgbNear(centreOf('noseTip'), rgb('#2B1D2A'), 2, `${where}: noseTip centre`);
      const tongueY = 525 + 0.8 * 110 * Math.fround(pose[Ch.Jaw]!);
      const tongue = pixel(g, Math.floor(0.5 * 500 + ox), Math.floor(0.5 * tongueY + oy));
      expectRgbNear(tongue, rgb('#E07A7A'), 2, `${where}: tongue centre`);
    }
  });
});
