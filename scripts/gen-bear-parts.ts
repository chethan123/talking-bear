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
