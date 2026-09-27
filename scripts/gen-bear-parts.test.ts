import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BONE, BONES, PART, PARTS } from '../src/art/bear-parts.gen.ts';
import {
  OUT_FILE,
  REPO_ROOT,
  SVG_FILE,
  checkGenerated,
  compileBearSvg,
  generate,
  main,
  parsePathData,
  pathBBox,
} from './gen-bear-parts.ts';

// A tiny SVG in the art/README.md subset: a mirrored part whose right bone exists (furL → armR), one whose
// right bone does not (padL stays on pawL), a skipped path, bones without data-pivot (pawL inherits from
// armL, head from root), a clip path with arcs, and a Q / T path with fill-opacity.
const FIXTURE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1400">
  <g id="root" data-pivot="500,1340">
    <path id="shadow" d="M 400 1300 L 600 1300 L 600 1360 L 400 1360 Z" fill="#225A51" data-parent="root"/>
    <g id="armL" data-pivot="300,700" data-parent="root">
      <path id="furL" d="M 250 700 C 250 650 350 650 350 700 L 350 900 Z" fill="#2F7A6D" data-parent="armL" data-mirror="furR"/>
      <g id="pawL" data-parent="armL">
        <path id="padL" d="M 280 880   h 40
          v 30 h -40 z" fill="#7B4B5A" data-parent="pawL" data-mirror="padR"/>
      </g>
    </g>
    <g id="armR" data-pivot="700,700" data-parent="root"/>
    <g id="head" data-parent="root">
      <path id="mouthPreview" d="M 480 520 L 520 520 L 500 540 Z" fill="#5A1E2E" data-parent="head" data-skip="true"/>
      <g id="eyeL" data-pivot="405,385" data-parent="head">
        <path id="scleraL" d="M 367 385 A 38 46 0 0 1 443 385 A 38 46 0 0 1 367 385 Z" fill="#FFFFFF" data-parent="eyeL" data-clip="true"/>
        <path id="irisL" d="M 375 385 Q 405 345 435 385 T 375 385 Z" fill="#E3A43A" fill-opacity="0.5" data-parent="eyeL"></path>
      </g>
    </g>
  </g>
</svg>
`;

/** Replaces exactly one occurrence of `from` in the fixture. */
function edit(from: string, to: string): string {
  expect(FIXTURE.split(from), `fixture contains ${from} once`).toHaveLength(2);
  return FIXTURE.replace(from, to);
}

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

describe('compileBearSvg: the tiny fixture', () => {
  const { bones, parts } = compileBearSvg(FIXTURE);

  it('lists bones in document order, parents before children, inheriting missing pivots', () => {
    expect(bones).toEqual([
      { id: 'root', parent: -1, pivot: [500, 1340] },
      { id: 'armL', parent: 0, pivot: [300, 700] },
      { id: 'pawL', parent: 1, pivot: [300, 700] },
      { id: 'armR', parent: 0, pivot: [700, 700] },
      { id: 'head', parent: 0, pivot: [500, 1340] },
      { id: 'eyeL', parent: 4, pivot: [405, 385] },
    ]);
    for (const [i, b] of bones.entries()) expect(b.parent, b.id).toBeLessThan(i);
  });

  it('emits parts in draw order, each mirrored copy right after its source, and skips data-skip paths', () => {
    expect(parts.map((p) => [p.id, bones[p.bone]?.id, p.mirror])).toEqual([
      ['shadow', 'root', false],
      ['furL', 'armL', false],
      ['furR', 'armR', true], // the mirrored bone exists
      ['padL', 'pawL', false],
      ['padR', 'pawL', true], // no pawR: the copy stays on the same bone
      ['scleraL', 'eyeL', false],
      ['irisL', 'eyeL', false],
    ]);
  });

  it('gives a mirrored copy the same d, fill, opacity and bbox as its source', () => {
    const [furL, furR] = [parts[1], parts[2]];
    expect(furR).toEqual({ ...furL, id: 'furR', bone: 3, mirror: true });
  });

  it('rounds bbox values to 0.001 and never emits -0', () => {
    const svg = edit(
      '<g id="armR"',
      '<path id="noise" d="M 0.1 0.2 l 0.2 0.1 Z" fill="#225A51" data-parent="root"/>\n' +
        '    <path id="speck" d="M -0.0001 -0 L 1 1" fill="#225A51" data-parent="root"/>\n' +
        '    <g id="armR"',
    );
    expect(bbox('M 0.1 0.2 l 0.2 0.1 Z')[2]).not.toBe(0.3); // 0.1 + 0.2 is 0.30000000000000004
    const compiled = compileBearSvg(svg).parts;
    const noise = compiled.find((p) => p.id === 'noise');
    const speck = compiled.find((p) => p.id === 'speck');
    expect(noise?.bbox).toEqual([0.1, 0.2, 0.3, 0.3]);
    expect(speck?.bbox).toEqual([0, 0, 1, 1]);
    expect(speck?.bbox.map((v) => Object.is(v, -0))).toEqual([false, false, false, false]);
    const text = generate(svg);
    expect(text).toContain('    bbox: [0.1, 0.2, 0.3, 0.3],\n');
    expect(text).toContain('    bbox: [0, 0, 1, 1],\n');
  });

  it('maps fill, fill-opacity, data-clip and the bbox; whitespace in d collapses to single spaces', () => {
    expect(parts[3]).toEqual({
      id: 'padL',
      bone: 2,
      d: 'M 280 880 h 40 v 30 h -40 z',
      fill: '#7B4B5A',
      opacity: 1,
      mirror: false,
      clip: false,
      bbox: [280, 880, 320, 910],
    });
    expect(parts[5]).toMatchObject({ id: 'scleraL', clip: true, opacity: 1, bbox: [367, 339, 443, 431] });
    expect(parts[6]).toMatchObject({ id: 'irisL', clip: false, opacity: 0.5, bbox: [375, 345, 465, 425] });
  });
});

describe('the generated module text', () => {
  const text = generate(FIXTURE);

  it('is deterministic, starts with the header and uses 2-space indentation', () => {
    expect(generate(FIXTURE)).toBe(text);
    expect(
      text.startsWith('// AUTO-GENERATED by scripts/gen-bear-parts.ts from art/bear.svg — do not edit.\n'),
    ).toBe(true);
    expect(text.endsWith('};\n')).toBe(true);
    for (const line of text.split('\n'))
      expect(line).toMatch(/^(?:(?: {2})*[^ \t].*[^ \t]|(?: {2})*[^ \t]|)$/);
  });

  it('writes BONES, PARTS, BONE and PART in a fixed layout', () => {
    expect(text).toContain(
      [
        'export const BONES: readonly Bone[] = [',
        "  { id: 'root', parent: -1, pivot: [500, 1340] },",
        "  { id: 'armL', parent: 0, pivot: [300, 700] },",
      ].join('\n'),
    );
    expect(text).toContain(
      [
        '  {',
        "    id: 'furR',",
        '    bone: 3,',
        "    d: 'M 250 700 C 250 650 350 650 350 700 L 350 900 Z',",
        "    fill: '#2F7A6D',",
        '    opacity: 1,',
        '    mirror: true,',
        '    clip: false,',
        '    bbox: [250, 650, 350, 900],',
        '  },',
      ].join('\n'),
    );
    expect(text).toContain(
      [
        'export const PART: Readonly<Record<string, number>> = {',
        '  shadow: 0,',
        '  furL: 1,',
        '  furR: 2,',
        '  padL: 3,',
        '  padR: 4,',
        '  scleraL: 5,',
        '  irisL: 6,',
        '};',
      ].join('\n'),
    );
  });

  describe('as a module', () => {
    let dir = '';
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'gen-bear-parts-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('loads, and BONE / PART map every id to its index', async () => {
      const file = join(dir, 'bear-parts.gen.ts');
      writeFileSync(file, text);
      const mod: unknown = await import(pathToFileURL(file).href);
      const { bones, parts } = compileBearSvg(FIXTURE);
      expect(mod).toHaveProperty('BONES', bones);
      expect(mod).toHaveProperty('PARTS', parts);
      expect(mod).toHaveProperty('BONE', Object.fromEntries(bones.map((b, i) => [b.id, i])));
      expect(mod).toHaveProperty('PART', Object.fromEntries(parts.map((p, i) => [p.id, i])));
    });
  });
});

describe('compileBearSvg: anything outside the subset throws', () => {
  it.each([
    ['text content', () => edit('<g id="armR"', 'hello <g id="armR"'), 'unexpected content'],
    ['a declaration', () => `<?xml version="1.0"?>\n${FIXTURE}`, 'unexpected content'],
    ['a single-quoted attribute', () => edit('fill="#225A51"', "fill='#225A51'"), 'unexpected content'],
    ['an unclosed element', () => FIXTURE.replace(/<\/g>\n<\/svg>/, '</svg>'), 'unbalanced </svg>'],
    [
      'another root',
      () => edit('viewBox="0 0 1000 1400"', 'viewBox="0 0 1000 1000"'),
      'the root must be <svg',
    ],
    [
      'another element',
      () => edit('<g id="armR"', '<circle id="c"/><g id="armR"'),
      '<circle> is not allowed',
    ],
    [
      'an element named like an object property',
      () => edit('<g id="armR"', '<constructor/><g id="armR"'),
      '<constructor> is not allowed',
    ],
    [
      'a transform',
      () => edit('<g id="head"', '<g id="head" transform="scale(2)"'),
      'transform is not allowed',
    ],
    ['a duplicate id', () => edit('data-mirror="padR"', 'data-mirror="shadow"'), 'duplicate id "shadow"'],
    ['an id outside the pattern', () => edit('id="shadow"', 'id="2shadow"'), 'id must match'],
    ['a wrong data-parent', () => edit('data-parent="pawL"', 'data-parent="armL"'), 'enclosing bone "pawL"'],
    ['a missing data-parent', () => edit(' data-parent="head">', '>'), 'enclosing bone "head"'],
    [
      'a path outside every bone',
      () => edit('  <g id="root"', '  <path id="x" d="M0 0" fill="#225A51"/>\n  <g id="root"'),
      'must be inside a bone',
    ],
    [
      'a second root bone',
      () => edit('</svg>', '<g id="extra" data-pivot="0,0"/></svg>'),
      'exactly one root bone',
    ],
    ['a root bone without a pivot', () => edit(' data-pivot="500,1340"', ''), 'root bone needs a data-pivot'],
    [
      'a malformed pivot',
      () => edit('data-pivot="300,700"', 'data-pivot="300 700"'),
      'data-pivot must be "x,y"',
    ],
    [
      'a lower-case fill',
      () => edit('fill="#7B4B5A"', 'fill="#7b4b5a"'),
      'fill must be an upper-case #RRGGBB',
    ],
    ['a missing fill', () => edit(' fill="#7B4B5A"', ''), 'fill must be an upper-case #RRGGBB'],
    ['fill-opacity above 1', () => edit('fill-opacity="0.5"', 'fill-opacity="1.5"'), 'fill-opacity must be'],
    ['invalid path data', () => edit('h -40 z', 'h -40 k'), 'unexpected "k"'],
    [
      'data-clip other than "true"',
      () => edit('data-clip="true"', 'data-clip="yes"'),
      'data-clip must be "true"',
    ],
    [
      'data-skip other than "true"',
      () => edit('data-skip="true"', 'data-skip="1"'),
      'data-skip must be "true"',
    ],
    [
      'a mirrored clip path',
      () => edit('data-clip="true"', 'data-clip="true" data-mirror="scleraR"'),
      'cannot have data-mirror',
    ],
    [
      'a mirrored skipped path',
      () => edit('data-skip="true"', 'data-skip="true" data-mirror="mouthR"'),
      'cannot have data-clip or data-mirror',
    ],
    [
      'content inside <defs>',
      () => edit('  <g id="root"', '  <defs id="defs"><g id="x" data-pivot="0,0"/></defs>\n  <g id="root"'),
      '<defs> must not have children',
    ],
  ])('%s', (_name, make, message) => {
    expect(() => compileBearSvg(make())).toThrow(message);
  });

  it('accepts an empty <defs>', () => {
    expect(() => compileBearSvg(edit('  <g id="root"', '  <defs id="defs"/>\n  <g id="root"'))).not.toThrow();
  });
});

describe(`${SVG_FILE} → ${OUT_FILE}`, () => {
  it('is up to date (what --check verifies in CI)', () => {
    const svg = readFileSync(join(REPO_ROOT, SVG_FILE), 'utf8');
    expect(generate(svg)).toBe(readFileSync(join(REPO_ROOT, OUT_FILE), 'utf8'));
  });

  it('has one root, parents before children, and BONE mapping every id to its index', () => {
    expect(BONES[0]?.parent).toBe(-1);
    for (const [i, b] of BONES.entries()) {
      if (i > 0) expect(b.parent, b.id).toBeGreaterThanOrEqual(0);
      expect(b.parent, b.id).toBeLessThan(i);
      expect(BONE[b.id], b.id).toBe(i);
    }
    expect(Object.keys(BONE)).toHaveLength(BONES.length);
  });

  it('has valid path data and a matching bbox for every part, and PART mapping every id to its index', () => {
    for (const [i, p] of PARTS.entries()) {
      expect(p.d, p.id).toMatch(/^[MLHVCSQTAZmlhvcsqtaz\d ,.eE+-]+$/);
      expectClose(p.bbox, bbox(p.d), 2); // bbox is rounded to 0.001
      expect(BONES[p.bone], p.id).toBeDefined();
      expect(PART[p.id], p.id).toBe(i);
    }
    expect(Object.keys(PART)).toHaveLength(PARTS.length);
  });

  it('places each mirrored copy right after its source, on the matching right bone', () => {
    const mirrored = PARTS.filter((p) => p.mirror);
    expect(mirrored.length).toBeGreaterThan(0);
    for (const copy of mirrored) {
      const source = PARTS[(PART[copy.id] ?? 0) - 1];
      expect(source?.mirror, copy.id).toBe(false);
      expect({ ...copy, id: '', bone: 0, mirror: false }).toEqual({ ...source, id: '', bone: 0 });
      const sourceBone = BONES[source?.bone ?? -1]?.id ?? '';
      expect(BONES[copy.bone]?.id, copy.id).toBe(sourceBone.replace(/L$/, 'R'));
    }
  });

  it('skips the mouth preview, clips at the scleras and keeps the blush transparent', () => {
    expect(PART['mouthPreview']).toBeUndefined();
    expect(PARTS.filter((p) => p.clip).map((p) => p.id)).toEqual(['scleraL', 'scleraR']);
    expect(PARTS.filter((p) => p.fill === '#F2A07B').map((p) => p.opacity)).toEqual([0, 0]);
  });
});

describe('main: the gen:bear CLI', () => {
  let root = '';
  let errors: string[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gen-bear-parts-'));
    mkdirSync(join(root, 'art'));
    writeFileSync(join(root, SVG_FILE), FIXTURE);
    errors = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((message: string) => {
      errors.push(message);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the module; --check then passes, and fails once a colour changes, never writing', () => {
    const out = join(root, OUT_FILE);
    expect(main(['--check'], root)).toBe(1);
    expect(errors.join('\n')).toContain(`${OUT_FILE} is missing`);
    expect(existsSync(out)).toBe(false);
    expect(main([], root)).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(generate(FIXTURE));
    expect(main([], root)).toBe(0);
    expect(main(['--check'], root)).toBe(0);
    writeFileSync(join(root, SVG_FILE), FIXTURE.replace('#2F7A6D', '#3F9282'));
    errors = [];
    expect(main(['--check'], root)).toBe(1);
    expect(errors.join('\n')).toMatch(/is stale[\s\S]*committed: {5}fill: '#2F7A6D',[\s\S]*pnpm gen:bear/);
    expect(readFileSync(out, 'utf8')).toBe(generate(FIXTURE));
  });

  it('exits 1 on an invalid SVG and 2 on unknown arguments', () => {
    writeFileSync(join(root, SVG_FILE), FIXTURE.replace('<g id="armR"', '<circle/><g id="armR"'));
    expect(main([], root)).toBe(1);
    expect(errors.join('\n')).toContain('<circle> is not allowed');
    expect(existsSync(join(root, OUT_FILE))).toBe(false);
    expect(main(['--fix'], root)).toBe(2);
    expect(main(['--check', '--check'], root)).toBe(2);
  });
});

describe('checkGenerated', () => {
  it('names the first differing line', () => {
    expect(checkGenerated('a\nb\n', 'a\nb\n')).toBeUndefined();
    expect(checkGenerated('a\nb\n', 'a\nc\n')).toContain('first difference at line 2');
    expect(checkGenerated('a\nb\n', 'a')).toContain('committed: (end of file)');
    expect(checkGenerated('a\nb\n', 'a\r\nb\r\n')).toBe(
      `${OUT_FILE} differs only in line endings (CRLF): check core.autocrlf.`,
    );
  });
});
