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
import { Ch } from './pose.ts';
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

    // Each frame leaves the context as it found it: every save() restored, globalAlpha back to 1.
    const counts = countSaves();
    try {
      for (const name of NAMES) {
        counts.saves = 0;
        counts.restores = 0;
        g.globalAlpha = 0.4;
        render(g, rig, POSES[name], view);
        expect(counts.saves, name).toBeGreaterThanOrEqual(2); // at least the two sclera clips
        expect(counts.restores, name).toBe(counts.saves);
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
       * Measures until 3 consecutive runs are clean or `max` runs are done. Clean is |growth| < BOUND: right
       * after a forced GC the reading can also drop by a few bytes (CI's Chromium read −16 B on clean runs),
       * while an allocation shows as growth (≥ 60 KB for one boxed number per frame).
       */
      const settle = (poses: readonly Pose[], max: number): { ok: boolean; history: number[] } => {
        const history: number[] = [];
        let streak = 0;
        while (streak < 3 && history.length < max) {
          const growth = measure(poses, doNothing);
          history.push(growth);
          streak = Math.abs(growth) < BOUND ? streak + 1 : 0;
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
      // every measured frame: one boxed number per frame is then 5 000 × ≥ 12 B = 60 KB, far over the bound.
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
});
