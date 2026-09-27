// Compiles art/bear.svg into the committed module src/art/bear-parts.gen.ts (plan §4.6.1): path strings,
// fills, opacities, pivots, the bone tree and the draw order. The renderer (src/anim) builds Path2D objects
// from it once and never parses SVG at runtime.
//
// The input is the constrained SVG subset in art/README.md, parsed here with a small strict parser (no
// dependencies). Anything outside the subset throws, naming the line.
//
// Usage:
//   pnpm gen:bear                            regenerate src/art/bear-parts.gen.ts
//   node scripts/gen-bear-parts.ts --check   exit 1 if the committed file is stale (CI runs this)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The source art and the generated module, relative to the repository root. */
export const SVG_FILE = 'art/bear.svg';
export const OUT_FILE = 'src/art/bear-parts.gen.ts';

/** The repository root: the parent of scripts/. */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A rig bone, as emitted into BONES. */
export interface GenBone {
  id: string;
  /** Index of the parent bone in BONES; -1 for the root. */
  parent: number;
  pivot: readonly [number, number];
}

/** A drawn part, as emitted into PARTS. */
export interface GenPart {
  id: string;
  /** Index of the part's bone in BONES. */
  bone: number;
  d: string;
  fill: string;
  opacity: number;
  mirror: boolean;
  clip: boolean;
  /** minX, minY, maxX, maxY over all path coordinates incl. control points, rounded to 0.001. */
  bbox: readonly [number, number, number, number];
}

export interface CompiledBear {
  /** Document order: parents before children. */
  bones: GenBone[];
  /** Draw order, back to front; a mirrored copy follows its source. */
  parts: GenPart[];
}

// ---------------------------------------------------------------------------------------------------
// Path data (SVG 1.1 §8.3.9 grammar, validated without Path2D)

/** One path command with one argument group; implicit repeats are split into separate segments. */
export interface PathSegment {
  /** The command letter as written (lower case = relative); implicit lineto after a moveto is L / l. */
  command: string;
  args: number[];
}

/** Numbers per argument group, keyed by upper-case command letter. */
const ARITY: ReadonlyMap<string, number> = new Map([
  ['M', 2],
  ['L', 2],
  ['H', 1],
  ['V', 1],
  ['C', 6],
  ['S', 4],
  ['Q', 4],
  ['T', 2],
  ['A', 7],
  ['Z', 0],
]);

const NUMBER = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;

function isWsp(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

function startsNumber(c: string | undefined): boolean {
  return c !== undefined && /[\d.+-]/.test(c);
}

/**
 * Parses SVG path data into segments, accepting only the commands MLHVCSQTAZ (either case) and numbers.
 * Throws on anything else: other characters, a missing initial moveto, incomplete argument groups,
 * stray commas, arc flags other than 0 / 1, and numbers that are not finite.
 */
export function parsePathData(d: string): PathSegment[] {
  const segments: PathSegment[] = [];
  let i = 0;
  const error = (what: string): Error => new Error(`invalid path data at offset ${i}: ${what}`);
  const skipWsp = (): void => {
    while (isWsp(d[i])) i++;
  };
  const readNumber = (): number => {
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(d);
    if (m === null) throw error('expected a number');
    const value = Number(m[0]);
    if (!Number.isFinite(value)) throw error(`number ${m[0]} is not finite`);
    i += m[0].length;
    return value;
  };
  const readArgs = (command: string, arity: number): number[] => {
    const isArc = command === 'A' || command === 'a';
    const args: number[] = [];
    for (;;) {
      const k = args.length % arity;
      const flag = isArc && (k === 3 || k === 4);
      if (args.length > 0) {
        skipWsp();
        let comma = false;
        if (d[i] === ',') {
          comma = true;
          i++;
          skipWsp();
        }
        const next = d[i];
        const startsArg = flag ? next === '0' || next === '1' : startsNumber(next);
        if (!startsArg) {
          if (flag) throw error('expected an arc flag (0 or 1)');
          if (k !== 0) throw error(`"${command}" needs ${arity} numbers per group`);
          if (comma) throw error('unexpected ","');
          return args;
        }
      }
      if (flag) {
        // A flag is a single character, so "11" is two flags (compact arcs such as a1 1 0 115 5).
        args.push(d[i] === '1' ? 1 : 0);
        i++;
      } else {
        args.push(readNumber());
      }
    }
  };

  skipWsp();
  if (i >= d.length) throw error('empty');
  while (i < d.length) {
    const command = d[i] ?? '';
    const upper = command.toUpperCase();
    const arity = /^[A-Za-z]$/.test(command) ? ARITY.get(upper) : undefined;
    if (arity === undefined) throw error(`unexpected "${command}"`);
    if (segments.length === 0 && upper !== 'M') throw error('path data must start with M or m');
    i++;
    skipWsp();
    if (arity === 0) {
      segments.push({ command, args: [] });
      continue;
    }
    const args = readArgs(command, arity);
    for (let g = 0; g < args.length; g += arity) {
      const implicitLine = g > 0 && upper === 'M';
      segments.push({
        command: implicitLine ? (command === 'M' ? 'L' : 'l') : command,
        args: args.slice(g, g + arity),
      });
    }
    skipWsp();
  }
  return segments;
}

/**
 * The bounding box [minX, minY, maxX, maxY] of path data over all its coordinates: end points, explicit
 * control points and the reflected control points of S / T. Arcs have no control points, so an arc adds its
 * end point and its extreme points on the ellipse. Because a Bézier curve lies inside the hull of its
 * control points, the box always contains the drawn shape.
 */
export function pathBBox(segments: readonly PathSegment[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  let x = 0; // current point
  let y = 0;
  let startX = 0; // start of the current subpath
  let startY = 0;
  let cubicX = 0; // second control point of the previous C / S
  let cubicY = 0;
  let quadX = 0; // control point of the previous Q / T
  let quadY = 0;
  let previous = '';
  for (const { command, args } of segments) {
    const upper = command.toUpperCase();
    const relative = command !== upper;
    const ox = relative ? x : 0;
    const oy = relative ? y : 0;
    const [a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0] = args;
    switch (upper) {
      case 'M':
        x = ox + a0;
        y = oy + a1;
        startX = x;
        startY = y;
        break;
      case 'L':
        x = ox + a0;
        y = oy + a1;
        break;
      case 'H':
        x = ox + a0;
        break;
      case 'V':
        y = oy + a0;
        break;
      case 'C':
        add(ox + a0, oy + a1);
        cubicX = ox + a2;
        cubicY = oy + a3;
        add(cubicX, cubicY);
        x = ox + a4;
        y = oy + a5;
        break;
      case 'S':
        if (previous === 'C' || previous === 'S') add(2 * x - cubicX, 2 * y - cubicY);
        cubicX = ox + a0;
        cubicY = oy + a1;
        add(cubicX, cubicY);
        x = ox + a2;
        y = oy + a3;
        break;
      case 'Q':
        quadX = ox + a0;
        quadY = oy + a1;
        add(quadX, quadY);
        x = ox + a2;
        y = oy + a3;
        break;
      case 'T':
        if (previous === 'Q' || previous === 'T') {
          quadX = 2 * x - quadX;
          quadY = 2 * y - quadY;
        } else {
          quadX = x;
          quadY = y;
        }
        add(quadX, quadY);
        x = ox + a0;
        y = oy + a1;
        break;
      case 'A':
        addArcExtremes(x, y, a0, a1, a2, a3 !== 0, a4 !== 0, ox + a5, oy + a6, add);
        x = ox + a5;
        y = oy + a6;
        break;
      case 'Z':
        x = startX;
        y = startY;
        break;
      default:
        throw new Error(`unknown path command ${command}`);
    }
    add(x, y);
    previous = upper;
  }
  return [minX, minY, maxX, maxY];
}

const TAU = 2 * Math.PI;

/**
 * Adds the points where an elliptical arc (SVG 1.1 implementation notes F.6.5–F.6.6) reaches its extreme x
 * and y, when they lie on the swept part of the ellipse. The caller adds the end points.
 */
function addArcExtremes(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  angleDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
  add: (x: number, y: number) => void,
): void {
  if (x1 === x2 && y1 === y2) return; // the arc is omitted
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return; // a straight line to the end point
  const phi = ((angleDeg % 360) * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const hx = (x1 - x2) / 2;
  const hy = (y1 - y2) / 2;
  const x1p = cos * hx + sin * hy;
  const y1p = -sin * hx + cos * hy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const numerator = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const denominator = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = Math.atan2(uy, ux);
  let delta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && delta > 0) delta -= TAU;
  if (sweep && delta < 0) delta += TAU;
  // x(θ) = cx + rx·cosφ·cosθ − ry·sinφ·sinθ and y(θ) = cy + rx·sinφ·cosθ + ry·cosφ·sinθ; dx/dθ = 0 and
  // dy/dθ = 0 each have two solutions, π apart.
  const tx = Math.atan2(-ry * sin, rx * cos);
  const ty = Math.atan2(ry * cos, rx * sin);
  for (const t of [tx, tx + Math.PI, ty, ty + Math.PI]) {
    const offset = delta >= 0 ? t - theta1 : theta1 - t;
    if (((offset % TAU) + TAU) % TAU > Math.abs(delta)) continue;
    const c = Math.cos(t);
    const s = Math.sin(t);
    add(cx + rx * cos * c - ry * sin * s, cy + rx * sin * c + ry * cos * s);
  }
}

// ---------------------------------------------------------------------------------------------------
// The SVG subset (art/README.md)

interface SvgElement {
  name: string;
  attrs: ReadonlyMap<string, string>;
  /** Index of the enclosing element; -1 for the root <svg>. */
  parent: number;
  line: number;
}

/** The allowed elements and their allowed attributes (the same allow-list as scripts/bear-svg.test.ts). */
const ALLOWED_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['svg', new Set(['xmlns', 'viewBox'])],
  ['defs', new Set(['id'])],
  ['g', new Set(['id', 'data-pivot', 'data-parent'])],
  [
    'path',
    new Set(['id', 'd', 'fill', 'fill-opacity', 'data-parent', 'data-mirror', 'data-clip', 'data-skip']),
  ],
]);

const XMLNS = 'http://www.w3.org/2000/svg';
/** The design box: mirrored copies are drawn under translate(1000, 0) scale(-1, 1). */
const VIEW_BOX = '0 0 1000 1400';

const ID = /^[A-Za-z][\w-]*$/;
const PIVOT = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;
const FILL = /^#[0-9A-F]{6}$/;
const OPACITY = /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/;

/** Splits the source into elements. Only tags and whitespace are allowed: no text, comments or declarations. */
function parseElements(src: string): SvgElement[] {
  const tag = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
  const lineAt = (offset: number): number => src.slice(0, offset).split('\n').length;
  const elements: SvgElement[] = [];
  const open: number[] = [];
  let last = 0;
  for (let m = tag.exec(src); m !== null; m = tag.exec(src)) {
    const [whole, closing = '', name = '', rawAttrs = '', selfClosing = ''] = m;
    const line = lineAt(m.index);
    if (src.slice(last, m.index).trim() !== '') throw new Error(`line ${lineAt(last)}: unexpected content`);
    last = m.index + whole.length;
    if (closing !== '') {
      if (rawAttrs !== '' || selfClosing !== '') throw new Error(`line ${line}: malformed </${name}>`);
      const top = open.pop();
      if (top === undefined || elements[top]?.name !== name)
        throw new Error(`line ${line}: unbalanced </${name}>`);
      continue;
    }
    const attrs = new Map<string, string>();
    for (const [, key = '', value = ''] of rawAttrs.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      if (attrs.has(key)) throw new Error(`line ${line}: duplicate ${key} on <${name}>`);
      attrs.set(key, value);
    }
    elements.push({ name, attrs, parent: open.at(-1) ?? -1, line });
    if (selfClosing === '') open.push(elements.length - 1);
  }
  if (src.slice(last).trim() !== '') throw new Error(`line ${lineAt(last)}: unexpected content`);
  const unclosed = open.at(-1);
  if (unclosed !== undefined)
    throw new Error(`line ${elements[unclosed]?.line}: unclosed <${elements[unclosed]?.name}>`);
  return elements;
}

/** Names an element in error messages: `line 12: <path id="noseTip">`. */
function where(e: SvgElement): string {
  const id = e.attrs.get('id');
  return `line ${e.line}: <${e.name}${id === undefined ? '' : ` id="${id}"`}>`;
}

/** Rounds a bounding-box coordinate to 0.001 design units (drops float noise from relative commands and arcs). */
function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r; // no -0
}

/** Compiles the SVG source into bones (document order) and parts (draw order, mirrored copies included). */
export function compileBearSvg(src: string): CompiledBear {
  const elements = parseElements(src);

  const svg = elements[0];
  if (svg?.name !== 'svg') throw new Error('the root element must be <svg>');
  if (svg.attrs.size !== 2 || svg.attrs.get('xmlns') !== XMLNS || svg.attrs.get('viewBox') !== VIEW_BOX) {
    throw new Error(`${where(svg)}: the root must be <svg xmlns="${XMLNS}" viewBox="${VIEW_BOX}">`);
  }

  const ids = new Set<string>();
  const claimId = (id: string | undefined, e: SvgElement, attr: string): string => {
    if (id === undefined || !ID.test(id)) throw new Error(`${where(e)}: ${attr} must match ${String(ID)}`);
    if (ids.has(id)) throw new Error(`${where(e)}: duplicate id "${id}"`);
    ids.add(id);
    return id;
  };

  interface BoneSource {
    id: string;
    parentId: string | undefined;
    pivot: readonly [number, number] | undefined;
    e: SvgElement;
  }
  interface PathSource {
    id: string;
    boneId: string;
    d: string;
    fill: string;
    opacity: number;
    bbox: readonly [number, number, number, number];
    mirrorId: string | undefined;
    clip: boolean;
    skip: boolean;
  }
  const boneSources: BoneSource[] = [];
  const pathSources: PathSource[] = [];

  for (const [index, e] of elements.entries()) {
    const allowed = ALLOWED_ATTRIBUTES.get(e.name);
    if (allowed === undefined) throw new Error(`${where(e)}: element <${e.name}> is not allowed`);
    for (const key of e.attrs.keys()) {
      if (!allowed.has(key)) throw new Error(`${where(e)}: attribute ${key} is not allowed`);
    }
    if (index === 0) continue;
    const parent = elements[e.parent];
    if (parent === undefined) throw new Error(`${where(e)}: must be inside <svg>`);
    if (e.name === 'svg') throw new Error(`${where(e)}: nested <svg>`);
    if (parent.name === 'defs' || parent.name === 'path') {
      throw new Error(`${where(e)}: <${parent.name}> must not have children`);
    }
    if (e.name === 'defs') {
      if (parent.name !== 'svg') throw new Error(`${where(e)}: <defs> must be a child of <svg>`);
      continue;
    }
    const dataParent = e.attrs.get('data-parent');
    const enclosingBone = parent.name === 'g' ? parent.attrs.get('id') : undefined;
    if (e.name === 'g') {
      const id = claimId(e.attrs.get('id'), e, 'id');
      if (enclosingBone === undefined && dataParent !== undefined) {
        throw new Error(`${where(e)}: the root bone must not have data-parent`);
      }
      if (enclosingBone !== undefined && dataParent !== enclosingBone) {
        throw new Error(`${where(e)}: data-parent must name the enclosing bone "${enclosingBone}"`);
      }
      const rawPivot = e.attrs.get('data-pivot');
      let pivot: readonly [number, number] | undefined;
      if (rawPivot !== undefined) {
        const m = PIVOT.exec(rawPivot);
        if (m === null) throw new Error(`${where(e)}: data-pivot must be "x,y"`);
        pivot = [Number(m[1]), Number(m[2])];
      }
      boneSources.push({ id, parentId: enclosingBone, pivot, e });
      continue;
    }
    // e.name === 'path'
    const id = claimId(e.attrs.get('id'), e, 'id');
    if (enclosingBone === undefined) throw new Error(`${where(e)}: a path must be inside a bone <g>`);
    if (dataParent !== enclosingBone) {
      throw new Error(`${where(e)}: data-parent must name the enclosing bone "${enclosingBone}"`);
    }
    const rawD = e.attrs.get('d');
    if (rawD === undefined) throw new Error(`${where(e)}: missing d`);
    const d = rawD.trim().replace(/[ \t\n\r\f]+/g, ' ');
    let bbox: readonly [number, number, number, number];
    try {
      bbox = pathBBox(parsePathData(d));
    } catch (error) {
      throw new Error(`${where(e)}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    const fill = e.attrs.get('fill');
    if (fill === undefined || !FILL.test(fill))
      throw new Error(`${where(e)}: fill must be an upper-case #RRGGBB`);
    const rawOpacity = e.attrs.get('fill-opacity');
    if (rawOpacity !== undefined && !OPACITY.test(rawOpacity)) {
      throw new Error(`${where(e)}: fill-opacity must be a number from 0 to 1`);
    }
    const flag = (attr: string): boolean => {
      const value = e.attrs.get(attr);
      if (value !== undefined && value !== 'true') throw new Error(`${where(e)}: ${attr} must be "true"`);
      return value !== undefined;
    };
    const clip = flag('data-clip');
    const skip = flag('data-skip');
    const mirrorId = e.attrs.has('data-mirror')
      ? claimId(e.attrs.get('data-mirror'), e, 'data-mirror')
      : undefined;
    if (skip && (clip || mirrorId !== undefined)) {
      throw new Error(`${where(e)}: a data-skip path cannot have data-clip or data-mirror`);
    }
    if (clip && mirrorId !== undefined)
      throw new Error(`${where(e)}: a data-clip path cannot have data-mirror`);
    pathSources.push({
      id,
      boneId: enclosingBone,
      d,
      fill,
      opacity: rawOpacity === undefined ? 1 : Number(rawOpacity),
      bbox,
      mirrorId,
      clip,
      skip,
    });
  }

  // Bones in document order, so every parent precedes its children.
  const boneIndex = new Map<string, number>();
  const bones: GenBone[] = [];
  for (const b of boneSources) {
    const parent = b.parentId === undefined ? -1 : boneIndex.get(b.parentId);
    if (parent === undefined) throw new Error(`${where(b.e)}: unknown parent bone`);
    if (parent === -1 && bones.length > 0)
      throw new Error(`${where(b.e)}: there must be exactly one root bone`);
    const pivot = b.pivot ?? bones[parent]?.pivot;
    if (pivot === undefined) throw new Error(`${where(b.e)}: the root bone needs a data-pivot`);
    boneIndex.set(b.id, bones.length);
    bones.push({ id: b.id, parent, pivot });
  }
  if (bones.length === 0) throw new Error('there must be exactly one root bone');

  const parts: GenPart[] = [];
  for (const p of pathSources) {
    if (p.skip) continue;
    const bone = boneIndex.get(p.boneId);
    if (bone === undefined) throw new Error(`path ${p.id}: unknown bone ${p.boneId}`);
    const { bbox } = p;
    const part: GenPart = {
      id: p.id,
      bone,
      d: p.d,
      fill: p.fill,
      opacity: p.opacity,
      mirror: false,
      clip: p.clip,
      bbox: [round3(bbox[0]), round3(bbox[1]), round3(bbox[2]), round3(bbox[3])],
    };
    parts.push(part);
    if (p.mirrorId !== undefined) {
      // The copy belongs to the mirrored bone (a trailing L becomes R: earL → earR) when it exists.
      const mirroredBone = p.boneId.endsWith('L') ? boneIndex.get(`${p.boneId.slice(0, -1)}R`) : undefined;
      parts.push({ ...part, id: p.mirrorId, bone: mirroredBone ?? bone, mirror: true });
    }
  }
  return { bones, parts };
}

// ---------------------------------------------------------------------------------------------------
// The generated module

const HEADER = [
  '// AUTO-GENERATED by scripts/gen-bear-parts.ts from art/bear.svg — do not edit.',
  '// Regenerate with `pnpm gen:bear`; CI fails when this file is stale (`node scripts/gen-bear-parts.ts --check`).',
  '',
  'export interface Bone {',
  '  id: string;',
  '  /** Index of the parent bone in BONES; -1 for root. */',
  '  parent: number;',
  "  /** Pivot in design units; a bone without data-pivot takes its parent's. */",
  '  pivot: readonly [number, number];',
  '}',
  '',
  'export interface Part {',
  '  id: string;',
  '  /** Index of the bone in BONES. */',
  '  bone: number;',
  '  /** SVG path data, in design units (for a mirrored copy: before the mirror). */',
  '  d: string;',
  '  /** #RRGGBB */',
  '  fill: string;',
  '  /** fill-opacity, 0 to 1. */',
  '  opacity: number;',
  '  /** Draw `d` under translate(1000, 0) scale(-1, 1): the copy mirrored about x = 500. */',
  '  mirror: boolean;',
  '  /** The renderer clips the parts drawn right after this one (iris, pupil, highlight) to it. */',
  '  clip: boolean;',
  '  /** minX, minY, maxX, maxY of `d` over all path coordinates incl. control points (before any mirror). */',
  '  bbox: readonly [number, number, number, number];',
  '}',
];

/** A single-quoted TypeScript string literal. Every emitted string is validated first, so this never escapes. */
function str(s: string): string {
  if (/['\\\n\r\u2028\u2029]/.test(s)) throw new Error(`cannot emit ${JSON.stringify(s)}`);
  return `'${s}'`;
}

function num(v: number): string {
  return Object.is(v, -0) ? '0' : String(v);
}

function propertyKey(id: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(id) ? id : str(id);
}

function list(open: string, items: readonly string[]): string[] {
  return items.length === 0 ? [`${open}[];`] : [`${open}[`, ...items, '];'];
}

function record(open: string, ids: readonly string[]): string[] {
  const entries = ids.map((id, i) => `  ${propertyKey(id)}: ${i},`);
  return entries.length === 0 ? [`${open}{};`] : [`${open}{`, ...entries, '};'];
}

/** Renders the module text: deterministic, 2-space indentation, one trailing newline. */
export function renderModule({ bones, parts }: CompiledBear): string {
  const boneLines = bones.map(
    (b) => `  { id: ${str(b.id)}, parent: ${num(b.parent)}, pivot: [${b.pivot.map(num).join(', ')}] },`,
  );
  const partLines = parts.flatMap((p) => [
    '  {',
    `    id: ${str(p.id)},`,
    `    bone: ${num(p.bone)},`,
    `    d: ${str(p.d)},`,
    `    fill: ${str(p.fill)},`,
    `    opacity: ${num(p.opacity)},`,
    `    mirror: ${String(p.mirror)},`,
    `    clip: ${String(p.clip)},`,
    `    bbox: [${p.bbox.map(num).join(', ')}],`,
    '  },',
  ]);
  const lines = [
    ...HEADER,
    '',
    '/** Rig bones, parents before children. */',
    ...list('export const BONES: readonly Bone[] = ', boneLines),
    '',
    '/** Parts in draw order, back to front; a mirrored copy comes right after its source, with mirror: true. */',
    ...list('export const PARTS: readonly Part[] = ', partLines),
    '',
    '/** Bone id → index in BONES. */',
    ...record(
      'export const BONE: Readonly<Record<string, number>> = ',
      bones.map((b) => b.id),
    ),
    '',
    '/** Part id → index in PARTS. */',
    ...record(
      'export const PART: Readonly<Record<string, number>> = ',
      parts.map((p) => p.id),
    ),
  ];
  return `${lines.join('\n')}\n`;
}

/** The generated module text for an SVG source. */
export function generate(svg: string): string {
  return renderModule(compileBearSvg(svg));
}

function excerpt(text: string | undefined): string {
  if (text === undefined) return '(end of file)';
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

/** Undefined when the committed text matches; otherwise a hint naming the first differing line. */
export function checkGenerated(generated: string, committed: string | undefined): string | undefined {
  if (committed === generated) return undefined;
  if (committed === undefined) return `${OUT_FILE} is missing.`;
  if (committed.replace(/\r\n/g, '\n') === generated) {
    return `${OUT_FILE} differs only in line endings (CRLF): check core.autocrlf.`;
  }
  const want = generated.split('\n');
  const have = committed.split('\n');
  let line = 0;
  while (line < want.length && line < have.length && want[line] === have[line]) line++;
  return [
    `${OUT_FILE} is stale: it does not match ${SVG_FILE} (first difference at line ${line + 1}).`,
    `  committed: ${excerpt(have[line])}`,
    `  generated: ${excerpt(want[line])}`,
  ].join('\n');
}

/** The CLI: writes the module, or with --check compares it. Returns the exit code. */
export function main(args: readonly string[], root: string = REPO_ROOT): number {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('usage: node scripts/gen-bear-parts.ts [--check]');
    return 2;
  }
  let generated: string;
  try {
    generated = generate(readFileSync(join(root, SVG_FILE), 'utf8'));
  } catch (error) {
    console.error(`gen-bear-parts: ${SVG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const out = join(root, OUT_FILE);
  if (args[0] === '--check') {
    const problem = checkGenerated(generated, existsSync(out) ? readFileSync(out, 'utf8') : undefined);
    if (problem !== undefined) {
      console.error(`${problem}\nRun \`pnpm gen:bear\` and commit ${OUT_FILE}.`);
      return 1;
    }
    console.log(`${OUT_FILE} is up to date.`);
    return 0;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, generated);
  console.log(`wrote ${OUT_FILE}`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
