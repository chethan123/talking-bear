import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Checks Fenn's art, art/duck.svg, against the constrained SVG subset that scripts/gen-bear-parts.ts compiles (rules in
// art/README.md) and duck plan §4.4's design: the palette, the rig and its pivots, the eyes, the lids, the blush and
// the beak's draw order. The subset is small enough to parse with regexes: no comments, no text, double-quoted
// attributes only.

const SVG_URL = new URL('../art/duck.svg', import.meta.url);

const ROOT_TAG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1400">';

const ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  svg: new Set(['xmlns', 'viewBox']),
  defs: new Set(['id']),
  g: new Set(['id', 'data-pivot', 'data-parent']),
  path: new Set(['id', 'd', 'fill', 'fill-opacity', 'data-parent', 'data-mirror', 'data-clip', 'data-skip']),
};

// Duck plan §4.4 palette: the only fills allowed.
const PALETTE: ReadonlySet<string> = new Set([
  '#7A5A3A', // down: cap, back, wings, fluff
  '#5E4329', // down shade
  '#94714C', // down highlight
  '#F4D27A', // face, belly, cheeks
  '#DDB65A', // face shade
  '#F09A4A', // bill
  '#D67C30', // bill shade
  '#8A4A20', // nail and nostrils
  '#E8893A', // feet
  '#C46F26', // feet shade
  '#2F7A6D', // wing stripe
  '#FFFFFF', // sclera, eye highlight
  '#3A2A1E', // iris
  '#1A1216', // pupil
  '#5A1E2E', // bill interior
  '#E07A7A', // tongue
  '#F2A07B', // blush (reaction only)
]);
const BLUSH = '#F2A07B';

// Fenn's rig as built in art/duck.svg, in document order: every bone, its parent and its pivot (design units). `root` has
// no parent. The head's children are drawn fluff, tuft, cheeks, bill (with its jaw), eyes, brows; docs/plan.md §4.6.7
// lists the same order.
const RIG: ReadonlyArray<readonly [bone: string, parent: string | undefined, pivot: string]> = [
  ['root', undefined, '500,1340'],
  ['body', 'root', '500,1250'],
  ['tailA', 'body', '770,1060'],
  ['tailB', 'body', '782,1050'],
  ['legL', 'body', '400,1160'],
  ['footL', 'legL', '370,1275'],
  ['legR', 'body', '600,1160'],
  ['footR', 'legR', '630,1275'],
  ['belly', 'body', '500,960'],
  ['wingL', 'body', '290,720'],
  ['wingR', 'body', '710,720'],
  ['neck', 'body', '500,640'],
  ['head', 'neck', '500,600'],
  ['fluffL', 'head', '230,330'],
  ['fluffR', 'head', '770,330'],
  ['tuft', 'head', '500,160'],
  ['cheekBlushL', 'head', '330,470'],
  ['cheekBlushR', 'head', '670,470'],
  ['bill', 'head', '500,505'],
  ['jaw', 'bill', '500,540'],
  ['eyeL', 'head', '400,380'],
  ['eyeR', 'head', '600,380'],
  ['browL', 'head', '400,312'],
  ['browR', 'head', '600,312'],
];

const EYE_PARTS = ['sclera', 'iris', 'pupil', 'highlight', 'lidUpper', 'lidLower'] as const;

/** The beak's draw order (duck plan §4.4), and the bone of each: no parametric mouth, only parts. */
const BEAK: ReadonlyArray<readonly [part: string, bone: string]> = [
  ['billInterior', 'bill'],
  ['tongue', 'jaw'],
  ['lowerBill', 'jaw'],
  ['upperBill', 'bill'],
  ['nostrils', 'bill'],
];

const ID = /^[A-Za-z][\w-]*$/;
const PIVOT = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;

interface SvgElement {
  name: string;
  attrs: ReadonlyMap<string, string>;
  /** id of the nearest enclosing `<g>`, if any */
  enclosingBone: string | undefined;
  /** whether the element is nested inside the root `<svg>` */
  insideSvg: boolean;
}

function parseSvg(src: string): SvgElement[] {
  const tagRe = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
  const elements: SvgElement[] = [];
  const open: { name: string; id: string | undefined }[] = [];
  let last = 0;
  for (;;) {
    const m = tagRe.exec(src);
    if (m === null) break;
    const between = src.slice(last, m.index).trim();
    if (between !== '') throw new Error(`unexpected content at offset ${last}: ${between.slice(0, 40)}`);
    last = m.index + m[0].length;
    const [, closing = '', name = '', rawAttrs = '', selfClosing = ''] = m;
    if (closing !== '') {
      const top = open.pop();
      if (top?.name !== name) throw new Error(`unbalanced </${name}> at offset ${m.index}`);
      continue;
    }
    const attrs = new Map<string, string>();
    for (const a of rawAttrs.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      const [, key = '', value = ''] = a;
      if (attrs.has(key)) throw new Error(`duplicate ${key} on <${name}> at offset ${m.index}`);
      attrs.set(key, value);
    }
    elements.push({
      name,
      attrs,
      enclosingBone: open.findLast((e) => e.name === 'g')?.id,
      insideSvg: open[0]?.name === 'svg',
    });
    if (selfClosing === '') open.push({ name, id: attrs.get('id') });
  }
  const rest = src.slice(last).trim();
  if (rest !== '') throw new Error(`unexpected trailing content: ${rest.slice(0, 40)}`);
  if (open.length > 0) throw new Error(`unclosed <${open.map((e) => e.name).join('>, <')}>`);
  return elements;
}

/** [minX, minY, maxX, maxY] over every coordinate pair of absolute M/L/C/Z path data (control points included). */
function bbox(d: string): [number, number, number, number] {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const src = readFileSync(SVG_URL, 'utf8');
const elements = parseSvg(src);
const bones = elements.filter((e) => e.name === 'g');
const paths = elements.filter((e) => e.name === 'path');
const boneIds = new Set(bones.flatMap((b) => b.attrs.get('id') ?? []));
const label = (e: SvgElement): string => `<${e.name} id="${e.attrs.get('id') ?? '?'}">`;
const pathById = (id: string): SvgElement | undefined => paths.find((p) => p.attrs.get('id') === id);

describe('art/duck.svg', () => {
  it('has exactly one root <svg> with the design box, and every other element inside it', () => {
    expect(src.startsWith(ROOT_TAG)).toBe(true);
    expect(elements[0]?.name).toBe('svg');
    expect(elements.filter((e) => e.name === 'svg')).toHaveLength(1);
    for (const e of elements.slice(1)) expect(e.insideSvg, `${label(e)} is inside <svg>`).toBe(true);
  });

  it('uses only <svg>, <defs>, <g> and <path>, with no transform, style or other attributes', () => {
    for (const e of elements) {
      const allowed = ALLOWED_ATTRIBUTES[e.name];
      expect(allowed, `element ${label(e)}`).toBeDefined();
      for (const key of e.attrs.keys()) {
        expect(allowed?.has(key), `attribute ${key} on ${label(e)}`).toBe(true);
      }
    }
  });

  it('gives every element and every mirrored copy a unique id', () => {
    const ids = elements.flatMap((e) => [e.attrs.get('id'), e.attrs.get('data-mirror')]);
    const defined = ids.filter((id): id is string => id !== undefined);
    expect(defined.filter((id, i) => defined.indexOf(id) !== i)).toEqual([]);
    for (const e of [...bones, ...paths]) {
      expect(e.attrs.get('id'), label(e)).toMatch(ID);
    }
  });

  it('mirrors only left parts of left bones, into the matching right part id and right bone', () => {
    const mirrored = paths.filter((p) => p.attrs.has('data-mirror'));
    expect(mirrored.length).toBeGreaterThan(0);
    for (const p of mirrored) {
      const id = p.attrs.get('id') ?? '';
      expect(id, `${label(p)} is a left part`).toMatch(/L/);
      expect(p.attrs.get('data-mirror'), `data-mirror of ${label(p)}`).toBe(id.replace(/L(?=[^L]*$)/, 'R'));
      const bone = p.enclosingBone ?? '';
      expect(bone, `bone of mirrored ${label(p)}`).toMatch(/L$/);
      expect(boneIds.has(`${bone.slice(0, -1)}R`), `right bone for ${bone}`).toBe(true);
    }
  });

  it("declares exactly the rig's bones, in document order, each with its parent and pivot", () => {
    expect(bones.map((b) => b.attrs.get('id'))).toEqual(RIG.map(([id]) => id));
    for (const [id, parent, pivot] of RIG) {
      const bone = bones.find((b) => b.attrs.get('id') === id);
      expect(bone?.attrs.get('data-parent'), `parent of ${id}`).toBe(parent);
      expect(bone?.attrs.get('data-pivot'), `pivot of ${id}`).toBe(pivot);
      expect(bone?.attrs.get('data-pivot') ?? '', `pivot of ${id}`).toMatch(PIVOT);
    }
  });

  it('nests every path and bone inside the bone its data-parent names', () => {
    for (const e of [...bones, ...paths]) {
      if (e.attrs.get('id') === 'root') continue;
      expect(e.attrs.get('data-parent'), `nesting of ${label(e)}`).toBe(e.enclosingBone);
    }
  });

  it('draws the tail feathers first, behind the body', () => {
    const first = paths.slice(0, 3).map((p) => p.enclosingBone);
    expect(first.every((bone) => bone === 'tailA' || bone === 'tailB')).toBe(true);
    const bodyAt = paths.findIndex((p) => p.enclosingBone === 'body');
    const lastTail = paths.findLastIndex((p) => p.enclosingBone === 'tailA' || p.enclosingBone === 'tailB');
    expect(lastTail).toBeLessThan(bodyAt);
  });

  it('writes path data with absolute M, L, C and Z only, at most one decimal, and palette fills', () => {
    for (const p of paths) {
      const d = p.attrs.get('d') ?? '';
      expect(d, `d of ${label(p)}`).toMatch(/^M [\d\s.MLCZ-]*Z$/);
      for (const n of d.match(/-?\d+(?:\.\d+)?/g) ?? []) {
        expect(n, `number in ${label(p)}`).toMatch(/^-?\d+(\.\d)?$/);
      }
      const fill = p.attrs.get('fill') ?? '';
      expect(PALETTE.has(fill), `fill ${fill} of ${label(p)} is in the palette`).toBe(true);
      const opacity = p.attrs.get('fill-opacity');
      if (opacity !== undefined) {
        expect(opacity, `fill-opacity of ${label(p)}`).toMatch(/^(0(\.\d+)?|1(\.0+)?)$/);
      }
    }
  });

  it('ships every blush path at fill-opacity 0 (the renderer drives it), and only the blush is transparent', () => {
    const blush = paths.filter((p) => p.attrs.get('fill') === BLUSH);
    expect(blush.map((p) => p.attrs.get('id'))).toEqual(['blushL']);
    expect(blush[0]?.attrs.get('data-mirror')).toBe('blushR');
    for (const p of blush) expect(p.attrs.get('fill-opacity'), label(p)).toBe('0');
    for (const p of paths.filter((q) => q.attrs.get('fill') !== BLUSH)) {
      expect(p.attrs.has('fill-opacity'), label(p)).toBe(false);
    }
  });

  it('draws each eye as sclera (clip), iris, pupil, highlight, then the lids, without mirroring', () => {
    for (const side of ['L', 'R'] as const) {
      const ids = paths.filter((p) => p.enclosingBone === `eye${side}`).map((p) => p.attrs.get('id'));
      expect(ids).toEqual(EYE_PARTS.map((part) => `${part}${side}`));
      const at = paths.findIndex((p) => p.attrs.get('id') === `sclera${side}`);
      expect(paths[at]?.attrs.get('data-clip')).toBe('true');
      expect(paths.slice(at + 1, at + 4).map((p) => p.attrs.get('id'))).toEqual(
        ['iris', 'pupil', 'highlight'].map((part) => `${part}${side}`),
      );
      for (const p of paths.slice(at, at + EYE_PARTS.length)) {
        expect(p.attrs.has('data-mirror'), label(p)).toBe(false);
      }
    }
    for (const p of paths.filter((q) => q.attrs.has('data-clip'))) {
      expect(p.attrs.get('id'), 'only scleras clip').toMatch(/^sclera[LR]$/);
      expect(p.attrs.get('data-clip')).toBe('true');
    }
  });

  it('draws the upper lids closed: each covers its sclera, in the face colour', () => {
    for (const side of ['L', 'R'] as const) {
      const [sx0, sy0, sx1, sy1] = bbox(pathById(`sclera${side}`)?.attrs.get('d') ?? '');
      const lid = pathById(`lidUpper${side}`);
      const [lx0, ly0, lx1, ly1] = bbox(lid?.attrs.get('d') ?? '');
      expect(lx0, `lidUpper${side} left`).toBeLessThanOrEqual(sx0);
      expect(ly0, `lidUpper${side} top`).toBeLessThanOrEqual(sy0);
      expect(lx1, `lidUpper${side} right`).toBeGreaterThanOrEqual(sx1);
      expect(ly1, `lidUpper${side} bottom`).toBeGreaterThanOrEqual(sy1);
      expect(lid?.attrs.get('fill'), `lidUpper${side} fill`).toBe('#F4D27A');
    }
  });

  it('draws the beak as parts in the order interior, tongue, lower bill, upper bill, nostrils; no mouth preview', () => {
    const order = BEAK.map(([id]) => paths.findIndex((p) => p.attrs.get('id') === id));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order.toSorted((a, b) => a - b)).toEqual(order);
    for (const [id, bone] of BEAK) expect(pathById(id)?.enclosingBone, `bone of ${id}`).toBe(bone);
    expect(paths.filter((p) => p.attrs.has('data-skip'))).toEqual([]);
  });

  it('draws between 40 and 80 paths, counting mirrored parts twice', () => {
    const count = paths.length + paths.filter((p) => p.attrs.has('data-mirror')).length;
    expect(count).toBeGreaterThanOrEqual(40);
    expect(count).toBeLessThanOrEqual(80);
  });
});
