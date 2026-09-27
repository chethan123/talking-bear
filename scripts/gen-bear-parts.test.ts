import { describe, expect, it } from 'vitest';

import { parsePathData, pathBBox } from './gen-bear-parts.ts';

function expectClose(actual: readonly number[], expected: readonly number[], digits = 9): void {
  expect(actual).toHaveLength(expected.length);
  for (const [i, v] of expected.entries()) expect(actual[i], `bbox[${i}]`).toBeCloseTo(v, digits);
}

const bbox = (d: string): [number, number, number, number] => pathBBox(parsePathData(d));

describe('parsePathData: Path2D-free validation of d', () => {
  it('accepts every command MLHVCSQTAZ in both cases, followed by numbers', () => {
    const upper = 'M1 2L3 4H5V6C7 8 9 10 11 12S13 14 15 16Q17 18 19 20T21 22A23 24 25 0 1 26 27Z';
    const lower = 'm1 2l3 4h5v6c7 8 9 10 11 12s13 14 15 16q17 18 19 20t21 22a23 24 25 1 0 26 27z';
    const segments = parsePathData(`${upper} ${lower}`);
    expect(segments.map((s) => s.command).join('')).toBe('MLHVCSQTAZmlhvcsqtaz');
    expect(segments.map((s) => s.args.length)).toEqual([
      2, 2, 1, 1, 6, 4, 4, 2, 7, 0, 2, 2, 1, 1, 6, 4, 4, 2, 7, 0,
    ]);
    expect(segments[8]?.args).toEqual([23, 24, 25, 0, 1, 26, 27]);
  });

  it('reads the SVG number grammar: signs and dots as separators, exponents, commas, compact arc flags', () => {
    expect(parsePathData('M.5.5-1-1')).toEqual([
      { command: 'M', args: [0.5, 0.5] },
      { command: 'L', args: [-1, -1] },
    ]);
    expect(parsePathData(' M1e2,-2.5E-1 l+3 , 4.\n')).toEqual([
      { command: 'M', args: [100, -0.25] },
      { command: 'l', args: [3, 4] },
    ]);
    expect(parsePathData('M0 0a1 1 0 115 5')).toEqual([
      { command: 'M', args: [0, 0] },
      { command: 'a', args: [1, 1, 0, 1, 1, 5, 5] },
    ]);
  });

  it('splits repeated argument groups; extra moveto pairs are linetos', () => {
    expect(parsePathData('m1 1 2 2 3 3').map((s) => s.command)).toEqual(['m', 'l', 'l']);
    expect(parsePathData('M1 1 2 2').map((s) => s.command)).toEqual(['M', 'L']);
    expect(parsePathData('M0 0 C1 1 2 2 3 3 4 4 5 5 6 6').map((s) => s.command)).toEqual(['M', 'C', 'C']);
  });

  it.each([
    ['', 'empty'],
    ['  ', 'empty'],
    ['L0 0', 'must start with M or m'],
    ['M0 0 X1 1', 'unexpected "X"'],
    ['M0 0 L1 1 #', 'unexpected "#"'],
    ['M0 0 L1 1 e2', 'unexpected "e"'],
    ['M0', '"M" needs 2 numbers per group'],
    ['M0 0 L1', '"L" needs 2 numbers per group'],
    ['M0 0 C1 1 2 2 3', '"C" needs 6 numbers per group'],
    ['M0,,0', '"M" needs 2 numbers per group'],
    ['M,0 0', 'expected a number'],
    ['M0 0 L1 1,', 'unexpected ","'],
    ['M0 0 L1 1, L2 2', 'unexpected ","'],
    ['M0 0 Z 1', 'unexpected "1"'],
    ['M0 0 A1 1 0 2 0 5 5', 'expected an arc flag (0 or 1)'],
    ['M1e999 0', 'is not finite'],
  ])('rejects %j', (d, message) => {
    expect(() => parsePathData(d)).toThrow(message);
  });
});

describe('pathBBox: all path coordinates, control points included', () => {
  it('follows absolute lines, H and V', () => {
    expect(bbox('M10 20 L30 5 H40 V60')).toEqual([10, 5, 40, 60]);
  });

  it('resolves relative commands from the current point, including h, v and after z', () => {
    expect(bbox('M10 20 h30 v-5 H0 V100 z l5 5')).toEqual([0, 15, 40, 100]);
    expect(bbox('m10 10 l5 5 z m-20 0 l1 1')).toEqual([-10, 10, 15, 15]);
    expect(bbox('m10 10 c1 -20 2 30 5 0 s10 10 10 0')).toEqual([10, -20, 25, 40]); // s reflects (12, 40) to (18, -20)
  });

  it('includes explicit control points and the reflected ones of S and T', () => {
    expect(bbox('M0 0 C10 -10 20 30 30 0 S50 50 60 0')).toEqual([0, -30, 60, 50]); // S reflects (20, 30) to (40, -30)
    expect(bbox('M0 0 L10 10 S20 -20 30 0')).toEqual([0, -20, 30, 10]); // after L, the first control is (10, 10)
    expect(bbox('M0 0 Q10 20 20 0 T40 0')).toEqual([0, -20, 40, 20]); // T reflects (10, 20) to (30, -20)
    expect(bbox('M0 0 Q10 20 20 0 T40 0 T60 0')).toEqual([0, -20, 60, 20]); // then (30, -20) to (50, 20)
    expect(bbox('M0 0 T10 0')).toEqual([0, 0, 10, 0]);
  });

  it('bounds arcs by their end points and their extreme points on the ellipse', () => {
    expectClose(bbox('M0 0 A50 50 0 0 1 100 0'), [0, -50, 100, 0]); // clockwise semicircle bulges up
    expectClose(bbox('M0 0 A50 50 0 0 0 100 0'), [0, 0, 100, 50]);
    expectClose(bbox('M0 0 A10 10 0 0 1 100 0'), [0, -50, 100, 0]); // radii scaled up to reach
    expectClose(bbox('M50 0 A50 50 0 1 1 0 50'), [0, 0, 100, 100]); // large arc round (50, 50)
    expectClose(bbox('M50 0 A50 50 0 0 1 0 50'), [0, 0, 50, 50]); // small arc round (0, 0)
    expectClose(bbox('M0 0 A100 50 90 0 1 0 200'), [0, 0, 50, 200]); // rotated ellipse
    expectClose(bbox('M0 0 A100 50 90 0 0 0 200'), [-50, 0, 0, 200]);
    expectClose(bbox('M10 10 a50 50 0 0 1 100 0'), [10, -40, 110, 10]);
    expect(bbox('M0 0 A0 50 0 0 1 100 0')).toEqual([0, 0, 100, 0]); // zero radius: a straight line
    expect(bbox('M5 5 A20 20 0 0 1 5 5')).toEqual([5, 5, 5, 5]); // same end point: omitted
  });
});
