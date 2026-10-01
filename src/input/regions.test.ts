import fc from 'fast-check';
import { GCProfiler, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { PART, PARTS } from '../art/bear-parts.gen.ts';
import { Ch, CH_COUNT, createPose } from '../anim/pose.ts';
import type { Pose } from '../anim/pose.ts';
import { BONE_COUNT, boneIndex, boneMatrices, createRig, MAT } from '../anim/rig.ts';
import { REGION_IDS } from './region-ids.ts';
import type { RegionId } from './region-ids.ts';
import { hitTest, REGIONS } from './regions.ts';
import type { RegionDef } from './regions.ts';

/** Stands in for the DOM's `Path2D`, which Node lacks: `createRig` builds them, `boneMatrices` never touches them. */
class FakePath2D {
  readonly d: string;
  constructor(d: string) {
    this.d = d;
  }
}
vi.stubGlobal('Path2D', FakePath2D);

type View = { scale: number; ox: number; oy: number };

const rig = createRig();
/** The real rig's bone matrices for `pose`. */
function bonesOf(pose: Pose): Float32Array {
  return boneMatrices(rig, pose, new Float32Array(BONE_COUNT * MAT));
}
function poseWith(ch: number, v: number): Pose {
  const p = createPose();
  p[ch] = v;
  return p;
}

const NEUTRAL = bonesOf(createPose());
const UNIT: View = { scale: 1, ox: 0, oy: 0 };

/** Rest-pose design point (`x`, `y`) on `bone` → CSS px, through the posed bone matrix and `view` (the forward map). */
function toCss(bones: Float32Array, bone: string, x: number, y: number, view: View): [number, number] {
  const o = boneIndex(bone) * MAT;
  const dx = bones[o]! * x + bones[o + 2]! * y + bones[o + 4]!;
  const dy = bones[o + 1]! * x + bones[o + 3]! * y + bones[o + 5]!;
  return [view.scale * dx + view.ox, view.scale * dy + view.oy];
}

/** Priority rank of an id: the index of its first region in `REGIONS`, `background` last. */
function rank(id: RegionId): number {
  const i = REGIONS.findIndex((r) => r.id === id);
  return i < 0 ? REGIONS.length : i;
}

/** A unique name for a region: `id@bone` (`headTop` has two regions). */
function label(r: RegionDef): string {
  return `${r.id}@${r.bone}`;
}

/** The neutral-pose answer with `view` = UNIT, straight from the table: the index of the first region whose padded ellipse holds the point, or −1. */
function neutralOracle(x: number, y: number, pad: number): number {
  return REGIONS.findIndex((r) => ((x - r.cx) / (r.rx + pad)) ** 2 + ((y - r.cy) / (r.ry + pad)) ** 2 <= 1);
}

/** The id of `REGIONS[i]`, or `background` for −1. */
function idAt(i: number): RegionId {
  return i < 0 ? 'background' : REGIONS[i]!.id;
}

/**
 * True if region `q`'s padded ellipse holds the CSS point (`x`, `y`) in this pose and view. It repeats
 * `hitTest`'s inverse, so it serves only to tell the two `headTop` regions apart in the property test.
 */
function holds(bones: Float32Array, view: View, pad: number, q: RegionDef, x: number, y: number): boolean {
  const o = boneIndex(q.bone) * MAT;
  const [a, b, c, d, e, f] = [
    bones[o]!,
    bones[o + 1]!,
    bones[o + 2]!,
    bones[o + 3]!,
    bones[o + 4]!,
    bones[o + 5]!,
  ];
  const qx = (x - view.ox) / view.scale - e;
  const qy = (y - view.oy) / view.scale - f;
  const det = a * d - b * c;
  const u = ((d * qx - c * qy) / det - q.cx) / (q.rx + pad / view.scale);
  const v = ((a * qy - b * qx) / det - q.cy) / (q.ry + pad / view.scale);
  return u * u + v * v <= 1;
}

/** The 4 points on the axes of `r`'s ellipse, its radii grown by `grow` (design units) or multiplied by `factor`. */
function axisPoints(r: RegionDef, grow: number, factor = 1): [string, number, number][] {
  const ex = (r.rx + grow) * factor;
  const ey = (r.ry + grow) * factor;
  return [
    ['left', r.cx - ex, r.cy],
    ['right', r.cx + ex, r.cy],
    ['top', r.cx, r.cy - ey],
    ['bottom', r.cx, r.cy + ey],
  ];
}

/** The part each region (by `label`) stands for: its centre must lie on that art (the part's bbox; a mirrored copy mirrored). */
const ART: Readonly<Record<string, string>> = {
  'eyeL@head': 'scleraL',
  'eyeR@head': 'scleraR',
  'nose@nose': 'noseTip',
  'earL@earL': 'earLFur',
  'earR@earR': 'earRFur',
  'cheekL@head': 'headFur',
  'cheekR@head': 'headFur',
  'neckerchief@neckerchief': 'kerchiefBand',
  'pawL@pawL': 'pawFurL',
  'pawR@pawR': 'pawFurR',
  'footL@footL': 'soleL',
  'footR@footR': 'soleR',
  'belly@belly': 'bellyPatch',
  'headTop@head': 'headFur',
  'headTop@tuft': 'tuftFur',
  'flankL@body': 'bodyFur',
  'flankR@body': 'bodyFur',
};
/** `PARTS[id]`'s bbox in design units, after its mirror. */
function artBox(id: string): [number, number, number, number] {
  const p = PARTS[PART[id]!]!;
  const [x0, y0, x1, y1] = p.bbox;
  return p.mirror ? [1000 - x1, y0, 1000 - x0, y1] : [x0, y0, x1, y1];
}

describe('REGIONS', () => {
  it("is issue #85's table in priority order, with the paws moved onto the art and a tuft region added", () => {
    expect(REGIONS.map((r) => [r.id, r.bone, r.cx, r.cy, r.rx, r.ry])).toEqual([
      ['eyeL', 'head', 405, 385, 45, 52],
      ['eyeR', 'head', 595, 385, 45, 52],
      ['nose', 'nose', 500, 470, 45, 35],
      ['earL', 'earL', 285, 195, 90, 90],
      ['earR', 'earR', 715, 195, 90, 90],
      ['cheekL', 'head', 340, 470, 70, 55],
      ['cheekR', 'head', 660, 470, 70, 55],
      ['neckerchief', 'neckerchief', 500, 640, 170, 50],
      ['pawL', 'pawL', 328, 876, 60, 60],
      ['pawR', 'pawR', 672, 876, 60, 60],
      ['footL', 'footL', 350, 1270, 110, 85],
      ['footR', 'footR', 650, 1270, 110, 85],
      ['belly', 'belly', 500, 930, 190, 220],
      ['headTop', 'head', 500, 400, 290, 235],
      ['headTop', 'tuft', 506, 144, 88, 82],
      ['flankL', 'body', 300, 1050, 90, 150],
      ['flankR', 'body', 700, 1050, 90, 150],
    ]);
  });

  it('holds every RegionId except background once (headTop twice: head, then tuft), each on a rig bone, frozen', () => {
    expect(
      REGIONS.filter((r) => r.id !== 'headTop')
        .map((r) => r.id)
        .toSorted(),
    ).toEqual(REGION_IDS.filter((id) => id !== 'background' && id !== 'headTop').toSorted());
    const heads = REGIONS.flatMap((r, i) => (r.id === 'headTop' ? [[i, r.bone]] : []));
    expect(heads).toEqual([
      [13, 'head'],
      [14, 'tuft'],
    ]);
    for (const r of REGIONS) {
      expect(() => boneIndex(r.bone)).not.toThrow();
      expect(Object.isFrozen(r)).toBe(true);
    }
    expect(Object.isFrozen(REGIONS)).toBe(true);
  });

  it.each(REGIONS.map((r) => [label(r), r] as const))('%s: the centre lies on its art', (name, r) => {
    const part = ART[name];
    if (part === undefined) throw new Error(`no art for ${name}`);
    const [x0, y0, x1, y1] = artBox(part);
    expect(r.cx).toBeGreaterThanOrEqual(x0);
    expect(r.cx).toBeLessThanOrEqual(x1);
    expect(r.cy).toBeGreaterThanOrEqual(y0);
    expect(r.cy).toBeLessThanOrEqual(y1);
  });

  it("the issue table's paw centres (255, 940) / (745, 940) miss the paw art, which is why they moved", () => {
    const [lx0, ly0, lx1, ly1] = artBox('pawFurL');
    expect(255 < lx0 || 255 > lx1 || 940 < ly0 || 940 > ly1).toBe(true);
    const [rx0, ry0, rx1, ry1] = artBox('pawFurR');
    expect(745 < rx0 || 745 > rx1 || 940 < ry0 || 940 > ry1).toBe(true);
  });
});

describe('validation 1: neutral pose, view {scale: 1, ox: 0, oy: 0}', () => {
  it('the neutral pose gives the identity for every bone (the rest pose is the design)', () => {
    for (let i = 0; i < BONE_COUNT; i++) {
      expect(Array.from(NEUTRAL.subarray(i * MAT, i * MAT + MAT), (v) => v + 0)).toEqual([1, 0, 0, 1, 0, 0]);
    }
  });

  for (const pad of [0, 12]) {
    it.each(REGIONS.map((r) => [label(r), r] as const))(
      `pad ${pad}: the centre of %s hits it`,
      (_name, r) => {
        expect(hitTest(r.cx, r.cy, NEUTRAL, UNIT, pad)).toBe(r.id);
      },
    );

    // "The next region in priority order": the first other region whose padded ellipse holds the point (a
    // later one, unless an earlier region already covers that spot, e.g. the neckerchief under the head's
    // bottom edge), else background. Never "index + 1".
    it(`pad ${pad}: points just outside each padded ellipse hit the first other region that holds them, or background`, () => {
      REGIONS.forEach((r, i) => {
        const unique = REGIONS.filter((q) => q.id === r.id).length === 1;
        for (const [side, x, y] of axisPoints(r, pad + 0.5)) {
          const got = hitTest(x, y, NEUTRAL, UNIT, pad);
          const want = neutralOracle(x, y, pad);
          expect(want, `${label(r)} ${side}`).not.toBe(i);
          expect(got, `${label(r)} ${side}`).toBe(idAt(want));
          if (unique) expect(got, `${label(r)} ${side}`).not.toBe(r.id);
        }
      });
    });

    it(`pad ${pad}: points just inside each padded ellipse hit that region or one before it`, () => {
      REGIONS.forEach((r, i) => {
        for (const [side, x, y] of axisPoints(r, pad - 0.5)) {
          const got = hitTest(x, y, NEUTRAL, UNIT, pad);
          expect(rank(got), `${label(r)} ${side}: ${got}`).toBeLessThanOrEqual(i);
          expect(got, `${label(r)} ${side}`).toBe(idAt(neutralOracle(x, y, pad)));
        }
      });
    });
  }

  // A few of the cases above, spelled out (pad 12: 12.5 design units beyond each radius).
  it.each([
    ['nose', 'right', 557.5, 470, 'headTop'],
    ['eyeL', 'bottom', 405, 449.5, 'cheekL'],
    ['cheekR', 'left', 577.5, 470, 'headTop'],
    ['pawL', 'right', 400.5, 876, 'belly'],
    ['pawL', 'left', 255.5, 876, 'background'],
    ['footL', 'top', 350, 1172.5, 'flankL'],
    ['belly', 'top', 500, 697.5, 'neckerchief'],
    ['headTop@head', 'bottom', 500, 647.5, 'neckerchief'],
    ['headTop@head', 'top', 500, 152.5, 'headTop'],
    ['headTop@tuft', 'top', 506, 49.5, 'background'],
    ['headTop@tuft', 'left', 405.5, 144, 'background'],
    ['headTop@tuft', 'bottom', 506, 238.5, 'headTop'],
    ['flankR', 'bottom', 700, 1212.5, 'footR'],
  ] as const)('pad 12: just outside %s (%s), (%d, %d) → %s', (_id, _side, x, y, want) => {
    expect(hitTest(x, y, NEUTRAL, UNIT, 12)).toBe(want);
  });

  it('a point exactly on the padded ellipse counts as inside', () => {
    // Identity bone matrices and a unit view keep these exact: u² + v² is exactly 1.
    expect(hitTest(545, 470, NEUTRAL, UNIT, 0)).toBe('nose');
    expect(hitTest(500, 505, NEUTRAL, UNIT, 0)).toBe('nose');
    expect(hitTest(557, 470, NEUTRAL, UNIT, 12)).toBe('nose');
    expect(hitTest(500, 517, NEUTRAL, UNIT, 12)).toBe('nose');
  });

  it('a far-away point is background', () => {
    expect(hitTest(-50, -50, NEUTRAL, UNIT, 12)).toBe('background');
    expect(hitTest(1200, 700, NEUTRAL, UNIT, 12)).toBe('background');
  });
});

describe('validation 2: motion (HeadRot = 0.3, pad 0)', () => {
  const bones = bonesOf(poseWith(Ch.HeadRot, 0.3));

  it.each([
    ['eyeL', 405],
    ['eyeR', 595],
  ] as const)(
    '%s moves with the head: the rotated centre hits it, the unrotated one no longer does',
    (id, cx) => {
      const [x, y] = toCss(bones, 'head', cx, 385, UNIT);
      // The rig rotates the head 0.3 rad clockwise (y down) about its pivot (500, 600).
      expect(x).toBeCloseTo(500 + Math.cos(0.3) * (cx - 500) - Math.sin(0.3) * (385 - 600), 2);
      expect(y).toBeCloseTo(600 + Math.sin(0.3) * (cx - 500) + Math.cos(0.3) * (385 - 600), 2);
      expect(Math.hypot(x - cx, y - 385)).toBeGreaterThan(60);
      expect(hitTest(x, y, bones, UNIT, 0)).toBe(id);
      expect(hitTest(cx, 385, bones, UNIT, 0)).not.toBe(id);
    },
  );

  it('with the neutral pose the unrotated centre still hits the eye (the control)', () => {
    expect(hitTest(405, 385, NEUTRAL, UNIT, 0)).toBe('eyeL');
    expect(hitTest(595, 385, NEUTRAL, UNIT, 0)).toBe('eyeR');
  });
});

describe('the tuft (plan §4.6.4 "Head top / tuft")', () => {
  const head = REGIONS[13]!;
  const tuft = REGIONS[14]!;
  /** Points on the tuftFur art 8 to 10 units below the tips of its three spikes (apexes ≈ (439, 99), (519, 62), (592, 108)). */
  const TIPS = [
    [443, 106],
    [519, 72],
    [586, 114],
  ] as const;

  it.each([0, 12])(
    'pad %d: the tuft tips hit headTop, through the tuft region (outside the head region)',
    (pad) => {
      const [x0, y0, x1, y1] = artBox('tuftFur');
      for (const [x, y] of TIPS) {
        expect(x >= x0 && x <= x1 && y >= y0 && y <= y1, `${x}, ${y} on the tuftFur bbox`).toBe(true);
        expect(holds(NEUTRAL, UNIT, pad, head, x, y), `${x}, ${y} outside the head region`).toBe(false);
        expect(hitTest(x, y, NEUTRAL, UNIT, pad), `${x}, ${y}`).toBe('headTop');
      }
    },
  );

  it('steals no earlier region: none of their centres lies in the padded tuft, and each still hits itself', () => {
    // Pads 0, 12 and 30 design units (30: the 12 px pad at a phone view scale of 0.4).
    for (const pad of [0, 12, 30]) {
      for (const r of REGIONS.slice(0, 14)) {
        expect(holds(NEUTRAL, UNIT, pad, tuft, r.cx, r.cy), `${label(r)} pad ${pad}`).toBe(false);
        expect(hitTest(r.cx, r.cy, NEUTRAL, UNIT, pad), `${label(r)} pad ${pad}`).toBe(r.id);
      }
    }
  });

  it('moves with the tuft bone: under TuftRot = −0.5 the swung point hits headTop and the old one no longer does', () => {
    const bones = bonesOf(poseWith(Ch.TuftRot, -0.5));
    // A point on the tuft region's right axis, 0.9 of the way out.
    const [rx, ry] = [tuft.cx + 0.9 * tuft.rx, tuft.cy];
    const [x, y] = toCss(bones, 'tuft', rx, ry, UNIT);
    // The rig rotates the tuft 0.5 rad anticlockwise (y down) about its pivot (500, 170).
    expect(x).toBeCloseTo(500 + Math.cos(-0.5) * (rx - 500) - Math.sin(-0.5) * (ry - 170), 2);
    expect(y).toBeCloseTo(170 + Math.sin(-0.5) * (rx - 500) + Math.cos(-0.5) * (ry - 170), 2);
    expect(Math.hypot(x - rx, y - ry)).toBeGreaterThan(40);
    expect(hitTest(x, y, bones, UNIT, 0)).toBe('headTop');
    expect(hitTest(rx, ry, bones, UNIT, 0)).toBe('background');
    expect(hitTest(rx, ry, NEUTRAL, UNIT, 0)).toBe('headTop');
  });
});

describe('every region follows its bone and the view (property)', () => {
  const channel = fc.float({ min: Math.fround(-0.4), max: Math.fround(0.4), noNaN: true });
  const arb = fc.record({
    pose: fc.array(channel, { minLength: CH_COUNT, maxLength: CH_COUNT }),
    scale: fc.double({ min: 0.25, max: 2, noNaN: true }),
    ox: fc.double({ min: -400, max: 400, noNaN: true }),
    oy: fc.double({ min: -400, max: 400, noNaN: true }),
    pad: fc.double({ min: 0, max: 24, noNaN: true }),
  });

  it('in any pose and view: a point inside a padded region hits it or an earlier one; a point outside never hits it', () => {
    fc.assert(
      fc.property(arb, ({ pose, scale, ox, oy, pad }) => {
        const bones = bonesOf(Float32Array.from(pose));
        const view = { scale, ox, oy };
        const padDesign = pad / scale;
        REGIONS.forEach((r, i) => {
          const [x, y] = toCss(bones, r.bone, r.cx, r.cy, view);
          expect(rank(hitTest(x, y, bones, view, pad)), `${label(r)} centre`).toBeLessThanOrEqual(i);
          for (const [side, px, py] of axisPoints(r, padDesign, 0.98)) {
            const [cx, cy] = toCss(bones, r.bone, px, py, view);
            expect(rank(hitTest(cx, cy, bones, view, pad)), `${label(r)} ${side} inside`).toBeLessThanOrEqual(
              i,
            );
          }
          for (const [side, px, py] of axisPoints(r, padDesign, 1.02)) {
            const [cx, cy] = toCss(bones, r.bone, px, py, view);
            // Outside this region, the point may still hit its id only through the id's other region (headTop).
            const viaOther = REGIONS.some(
              (q, j) => j !== i && q.id === r.id && holds(bones, view, pad, q, cx, cy),
            );
            if (!viaOther)
              expect(hitTest(cx, cy, bones, view, pad), `${label(r)} ${side} outside`).not.toBe(r.id);
          }
        });
      }),
      // A fixed seed: the same 200 poses and views every run (some wrong-bone mutants are caught only here).
      { numRuns: 200, seed: 85 },
    );
  });

  it('each centre hits itself at a portrait-phone view (412 × 915 CSS px: scale 0.412) with the default 12 px pad', () => {
    const view = { scale: 0.412, ox: 0, oy: (915 - 1400 * 0.412) / 2 };
    for (const r of REGIONS) {
      const [x, y] = toCss(NEUTRAL, r.bone, r.cx, r.cy, view);
      expect(hitTest(x, y, NEUTRAL, view), label(r)).toBe(r.id);
    }
  });

  it('a bone collapsed to zero scale hits nothing (EarFoldL = 2 folds the left ear flat)', () => {
    const bones = bonesOf(poseWith(Ch.EarFoldL, 2));
    expect(hitTest(285, 195, bones, UNIT, 12)).not.toBe('earL');
    expect(hitTest(715, 195, bones, UNIT, 12)).toBe('earR');
  });

  it('throws on a bone matrix array that is too short', () => {
    expect(() => hitTest(0, 0, new Float32Array(BONE_COUNT * MAT - 1), UNIT)).toThrow(RangeError);
  });
});

describe('validation 3: padding', () => {
  const nose = REGIONS.find((r) => r.id === 'nose')!;

  it('a point 10 CSS px outside the nose ellipse hits the nose with pad 12, not with pad 0 (view scale 1)', () => {
    for (const [side, x, y] of axisPoints(nose, 10)) {
      expect(hitTest(x, y, NEUTRAL, UNIT, 12), side).toBe('nose');
      expect(hitTest(x, y, NEUTRAL, UNIT, 0), side).not.toBe('nose');
    }
  });

  it('the pad is in CSS px: at view scale 0.5 with an offset, 10 CSS px outside the nose still hits it with pad 12', () => {
    const view = { scale: 0.5, ox: 40, oy: 20 };
    const [cx, cy] = toCss(NEUTRAL, 'nose', nose.cx, nose.cy, view);
    const ex = nose.rx * view.scale + 10;
    const ey = nose.ry * view.scale + 10;
    for (const [x, y] of [
      [cx - ex, cy],
      [cx + ex, cy],
      [cx, cy - ey],
      [cx, cy + ey],
    ] as const) {
      expect(hitTest(x, y, NEUTRAL, view, 12)).toBe('nose');
      expect(hitTest(x, y, NEUTRAL, view, 0)).not.toBe('nose');
    }
  });

  it('padCssPx defaults to 12', () => {
    for (const [side, x, y] of axisPoints(nose, 10)) expect(hitTest(x, y, NEUTRAL, UNIT), side).toBe('nose');
  });
});

/** The `gc` function, exposed once at runtime with Node built-ins only (the technique of src/anim/clip.test.ts and rig.test.ts). */
let exposedGc: (() => void) | undefined;

/** Runs a full garbage collection. */
function forceGc(): void {
  if (exposedGc === undefined) {
    setFlagsFromString('--expose-gc');
    const gc: unknown = runInNewContext('gc');
    if (typeof gc !== 'function') throw new Error('gc() is not available');
    exposedGc = (): void => {
      gc();
    };
  }
  exposedGc();
}

/**
 * `heapUsed` growth in bytes over `fn`, measured from a freshly collected heap. If any GC ran during `fn`,
 * the reading is meaningless (a scavenge frees the garbage it should count), so it returns +Infinity.
 */
function heapGrowth(fn: () => void): number {
  forceGc();
  const profiler = new GCProfiler();
  profiler.start();
  const before = process.memoryUsage().heapUsed;
  fn();
  const growth = process.memoryUsage().heapUsed - before;
  return profiler.stop().statistics.length > 0 ? Number.POSITIVE_INFINITY : growth;
}

/**
 * Bytes `fn` allocated on the V8 heap, GCs included: the `heapUsed` growth from a freshly collected heap plus
 * what every GC during `fn` freed. Unlike `heapGrowth` it is finite even when the garbage triggers scavenges.
 */
function allocatedBytes(fn: () => void): number {
  forceGc();
  const profiler = new GCProfiler();
  profiler.start();
  const before = process.memoryUsage().heapUsed;
  fn();
  let bytes = process.memoryUsage().heapUsed - before;
  for (const gc of profiler.stop().statistics) {
    bytes += gc.beforeGC.heapStatistics.usedHeapSize - gc.afterGC.heapStatistics.usedHeapSize;
  }
  return bytes;
}

describe('validation 4: no allocation', () => {
  const LIMIT = 1_048_576;
  const bones = bonesOf(poseWith(Ch.HeadRot, 0.1));
  const view = { scale: 0.5, ox: 10, oy: 20 };
  // A 25 × 35 grid over the canvas and a margin around it: every region and the background get hit.
  const POINTS = new Float64Array(2 * 25 * 35);
  for (let i = 0; i < 25; i++) {
    for (let j = 0; j < 35; j++) {
      POINTS[2 * (i * 35 + j)] = -20 + i * 23;
      POINTS[2 * (i * 35 + j) + 1] = -20 + j * 22;
    }
  }
  const N = POINTS.length / 2;
  let hits = 0;

  /** 100 000 `hitTest` calls over the grid. */
  const hundredThousand = (): void => {
    for (let k = 0; k < 100_000; k++) {
      const j = 2 * (k % N);
      if (hitTest(POINTS[j]!, POINTS[j + 1]!, bones, view) !== 'background') hits++;
    }
  };

  /** Best (lowest) growth of `fn` over up to 20 runs, each from a collected heap, after `warm` warm-up runs. */
  function bestGrowth(fn: () => void, warm: number): number {
    forceGc();
    for (let w = 0; w < warm; w++) fn();
    let best = heapGrowth(fn);
    for (let trial = 1; trial < 20 && best >= LIMIT; trial++) best = Math.min(best, heapGrowth(fn));
    return best;
  }

  it('the grid hits regions and background alike', () => {
    const seen = new Set<RegionId>();
    for (let k = 0; k < N; k++) seen.add(hitTest(POINTS[2 * k]!, POINTS[2 * k + 1]!, bones, view));
    expect(seen).toContain('background');
    expect(seen.size).toBeGreaterThanOrEqual(12);
  });

  it('100 000 hitTest calls grow heapUsed by < 1 MB, once V8 has optimised it', () => {
    // Until V8's optimising compilers take over, the interpreter boxes every double, so warm up first, then
    // take the best of up to 20 runs, each from a collected heap, any run during which a GC ran counting as
    // +Infinity (as in src/anim/rig.test.ts). A real allocation shows in every run (see the control below).
    hits = 0;
    expect(bestGrowth(hundredThousand, 10)).toBeLessThan(LIMIT);
    expect(hits).toBeGreaterThan(0);
  });

  it('an allocating variant fails the same check (positive control)', () => {
    // One small object per call, made to escape so V8 can't optimise it away: about 7 MB per 100 000 calls.
    // That garbage triggers scavenges, so `heapGrowth` reads +Infinity and the check above rejects it; the
    // GC-aware `allocatedBytes` shows the allocation it caught is real.
    let sink = { x: 0, y: 0 };
    const allocating = (): void => {
      for (let k = 0; k < 100_000; k++) {
        const j = 2 * (k % N);
        sink = { x: POINTS[j]!, y: POINTS[j + 1]! };
        if (hitTest(sink.x, sink.y, bones, view) !== 'background') hits++;
      }
    };
    expect(bestGrowth(allocating, 10)).toBeGreaterThanOrEqual(LIMIT);
    expect(allocatedBytes(allocating)).toBeGreaterThanOrEqual(LIMIT);
    expect(sink.x).toBeTypeOf('number');
  });
});
