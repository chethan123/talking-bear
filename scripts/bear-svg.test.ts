import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Checks the constrained SVG subset that scripts/gen-bear-parts.ts compiles (rules in art/README.md).
// The subset is small enough to parse with regexes: no comments, no text, double-quoted attributes only.

const SVG_URL = new URL('../art/bear.svg', import.meta.url);

const ROOT_TAG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1400">';

const ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  svg: new Set(['xmlns', 'viewBox']),
  defs: new Set(['id']),
  g: new Set(['id', 'data-pivot', 'data-parent']),
  path: new Set(['id', 'd', 'fill', 'fill-opacity', 'data-parent', 'data-mirror', 'data-clip', 'data-skip']),
};

// Plan §4.6.5 palette: the only fills allowed.
const PALETTE: ReadonlySet<string> = new Set([
  '#2F7A6D', // fur
  '#225A51', // fur shade
  '#3F9282', // fur highlight
  '#EBD9B4', // oat: muzzle, belly, inner ears
  '#F6EEDC', // blaze
  '#2B1D2A', // nose
  '#5A1E2E', // mouth
  '#E07A7A', // tongue
  '#7B4B5A', // pads
  '#E3A43A', // iris
  '#1A1216', // pupil
  '#FFFFFF', // eye highlight
  '#E2B33C', // neckerchief
  '#B9861E', // neckerchief stitch
  '#F2A07B', // blush (reaction only)
]);
const BLUSH = '#F2A07B';

// Rig bones and their parents (plan §4.6.5); `root` has no parent.
const RIG: ReadonlyArray<readonly [bone: string, parent: string | undefined]> = [
  ['root', undefined],
  ['body', 'root'],
  ['legL', 'body'],
  ['legR', 'body'],
  ['footL', 'legL'],
  ['footR', 'legR'],
  ['belly', 'body'],
  ['neckerchief', 'body'],
  ['knot', 'neckerchief'],
  ['tailA', 'knot'],
  ['tailB', 'knot'],
  ['armL', 'body'],
  ['armR', 'body'],
  ['pawL', 'armL'],
  ['pawR', 'armR'],
  ['neck', 'body'],
  ['head', 'neck'],
  ['earL', 'head'],
  ['earR', 'head'],
  ['innerEarL', 'earL'],
  ['innerEarR', 'earR'],
  ['tuft', 'head'],
  ['blaze', 'head'],
  ['browL', 'head'],
  ['browR', 'head'],
  ['eyeL', 'head'],
  ['eyeR', 'head'],
  ['cheekBlushL', 'head'],
  ['cheekBlushR', 'head'],
  ['muzzle', 'head'],
  ['nose', 'muzzle'],
  ['upperLip', 'muzzle'],
  ['jaw', 'muzzle'],
];

// Pivots fixed by the spec, in design units.
const PIVOTS: Readonly<Record<string, string>> = {
  root: '500,1340',
  body: '500,1250',
  armL: '300,700',
  armR: '700,700',
  head: '500,600',
};

const EYE_PARTS = ['sclera', 'iris', 'pupil', 'highlight', 'lidUpper', 'lidLower'] as const;

interface SvgElement {
  name: string;
  attrs: ReadonlyMap<string, string>;
  /** id of the nearest enclosing `<g>`, if any */
  enclosingBone: string | undefined;
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
    elements.push({ name, attrs, enclosingBone: open.findLast((e) => e.name === 'g')?.id });
    if (selfClosing === '') open.push({ name, id: attrs.get('id') });
  }
  const rest = src.slice(last).trim();
  if (rest !== '') throw new Error(`unexpected trailing content: ${rest.slice(0, 40)}`);
  if (open.length > 0) throw new Error(`unclosed <${open.map((e) => e.name).join('>, <')}>`);
  return elements;
}

const src = readFileSync(SVG_URL, 'utf8');
const elements = parseSvg(src);
const bones = elements.filter((e) => e.name === 'g');
const paths = elements.filter((e) => e.name === 'path');
const boneIds = new Set(bones.flatMap((b) => b.attrs.get('id') ?? []));
const label = (e: SvgElement): string => `<${e.name} id="${e.attrs.get('id') ?? '?'}">`;

describe('art/bear.svg', () => {
  it('has exactly one root <svg> with the design box', () => {
    expect(src.startsWith(ROOT_TAG)).toBe(true);
    expect(elements[0]?.name).toBe('svg');
    expect(elements.filter((e) => e.name === 'svg')).toHaveLength(1);
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
      expect(e.attrs.get('id'), label(e)).toMatch(/^[A-Za-z][\w-]*$/);
    }
  });

  it('declares every rig bone with its parent', () => {
    for (const [id, parent] of RIG) {
      const bone = bones.find((b) => b.attrs.get('id') === id);
      expect(bone, `bone ${id}`).toBeDefined();
      expect(bone?.attrs.get('data-parent'), `parent of ${id}`).toBe(parent);
    }
  });

  it('points every data-parent at an existing bone or root', () => {
    for (const e of [...bones, ...paths]) {
      if (e.attrs.get('id') === 'root') continue;
      const parent = e.attrs.get('data-parent') ?? '';
      expect(parent === 'root' || boneIds.has(parent), `data-parent "${parent}" of ${label(e)}`).toBe(true);
    }
  });

  it('nests every path and bone inside the bone its data-parent names', () => {
    for (const e of [...bones, ...paths]) {
      if (e.attrs.get('id') === 'root') continue;
      expect(e.attrs.get('data-parent'), `nesting of ${label(e)}`).toBe(e.enclosingBone);
    }
  });

  it('places the pivots the spec fixes, and writes every pivot as "x,y"', () => {
    for (const [id, pivot] of Object.entries(PIVOTS)) {
      const bone = bones.find((b) => b.attrs.get('id') === id);
      expect(bone?.attrs.get('data-pivot'), `pivot of ${id}`).toBe(pivot);
    }
    for (const b of bones) {
      const pivot = b.attrs.get('data-pivot');
      if (pivot !== undefined) expect(pivot, `pivot of ${label(b)}`).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
    }
  });

  it('gives every path an id, path data using only SVG path commands, and a palette fill', () => {
    for (const p of paths) {
      expect(p.attrs.get('d'), `d of ${label(p)}`).toMatch(/^\s*[Mm][MLHVCSQTAZmlhvcsqtaz\d\s,.eE+-]*$/);
      const fill = p.attrs.get('fill') ?? '';
      expect(fill, `fill of ${label(p)}`).toMatch(/^#[0-9A-F]{6}$/);
      expect(PALETTE.has(fill), `fill ${fill} of ${label(p)} is in the palette`).toBe(true);
      const opacity = p.attrs.get('fill-opacity');
      if (opacity !== undefined) {
        expect(opacity, `fill-opacity of ${label(p)}`).toMatch(/^(0(\.\d+)?|1(\.0+)?)$/);
      }
    }
  });

  it('ships every blush path at fill-opacity 0 (the renderer drives it)', () => {
    const blush = paths.filter((p) => p.attrs.get('fill') === BLUSH);
    expect(blush.length).toBeGreaterThan(0);
    for (const p of blush) expect(p.attrs.get('fill-opacity'), label(p)).toBe('0');
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

  it('has the neutral mouth preview, which the generator skips', () => {
    const preview = paths.find((p) => p.attrs.get('id') === 'mouthPreview');
    expect(preview?.attrs.get('data-skip')).toBe('true');
    for (const p of paths.filter((q) => q.attrs.has('data-skip'))) {
      expect(p.attrs.get('data-skip'), label(p)).toBe('true');
    }
  });

  it('draws between 45 and 80 paths, counting mirrored parts twice', () => {
    // data-skip paths (the mouth preview) are not drawn by the generator, so they are not counted.
    const drawn = paths.filter((p) => !p.attrs.has('data-skip'));
    const count = drawn.length + drawn.filter((p) => p.attrs.has('data-mirror')).length;
    expect(count).toBeGreaterThanOrEqual(45);
    expect(count).toBeLessThanOrEqual(80);
  });
});
