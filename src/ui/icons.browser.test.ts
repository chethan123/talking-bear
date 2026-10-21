// Browser Mode tests for the kid-first icons (icons.ts, issue #115): inline SVG in the plan §4.6 palette, hidden from
// assistive technology, with no text, no title and no style attribute, and an explicit fill on every shape (SVG's
// default fill is black).

import { describe, expect, test } from 'vitest';
import { ICON_COLOURS, icon, type IconName } from './icons.ts';

const NAMES: readonly IconName[] = ['paw', 'micBlocked', 'micMuted', 'retry', 'noise'];
const SVG_NS = 'http://www.w3.org/2000/svg';
/** The shapes an icon may draw with. */
const SHAPES = ['circle', 'ellipse', 'rect', 'path', 'polygon', 'line'] as const;

/** Plan §4.6 "Palette", transcribed here (not imported from icons.ts), upper-cased. */
const PALETTE: ReadonlySet<string> = new Set([
  '#2F7A6D', // fur
  '#225A51', // fur shade
  '#3F9282', // fur highlight
  '#EBD9B4', // oat: muzzle, belly, inner ear
  '#F6EEDC', // blaze
  '#2B1D2A', // nose
  '#5A1E2E', // mouth
  '#E07A7A', // tongue
  '#7B4B5A', // pads
  '#E3A43A', // iris
  '#1A1216', // pupil
  '#E2B33C', // neckerchief
  '#B9861E', // neckerchief stitch
  '#F2A07B', // blush
  '#FFF4E0', // background top
  '#F3D6B3', // background bottom
]);

const inPalette = (c: string | null): boolean => c !== null && PALETTE.has(c.toUpperCase());

describe('icons.ts', () => {
  test.each(NAMES)('%s: an aria-hidden, unfocusable <svg> with no text, title or style', (name) => {
    const svg = icon(name);
    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.localName).toBe('svg');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('data-icon')).toBe(name);
    expect(svg.getAttribute('viewBox')).toBe('0 0 48 48');
    expect(svg.classList.contains('icon')).toBe(true);
    expect(svg.textContent).toBe('');
    expect(svg.querySelector('title, desc, text')).toBeNull();
    expect(svg.matches('[style]') || svg.querySelector('[style]') !== null).toBe(false);
  });

  test.each(NAMES)(
    '%s: every shape has an explicit palette fill or fill="none" with a palette stroke',
    (name) => {
      const svg = icon(name);
      const shapes = Array.from(svg.querySelectorAll(SHAPES.join(',')));
      // Nothing but shapes: no group, image or foreign content to slip a colour past this check.
      expect(svg.children.length).toBe(shapes.length);
      expect(shapes.length).toBeGreaterThan(1);
      let painted = 0;
      for (const el of shapes) {
        const fill = el.getAttribute('fill');
        const stroke = el.getAttribute('stroke');
        const what = `${el.localName} ${el.getAttribute('d') ?? ''}`;
        expect(fill, what).not.toBeNull();
        if (fill === 'none') expect(inPalette(stroke), what).toBe(true);
        else expect(inPalette(fill), `${what} fill ${fill}`).toBe(true);
        if (stroke !== null) expect(inPalette(stroke), `${what} stroke ${stroke}`).toBe(true);
        if (fill !== 'none') painted++;
      }
      expect(painted).toBeGreaterThan(0);
    },
  );

  test('the exported colours are palette colours', () => {
    for (const c of Object.values(ICON_COLOURS)) expect(inPalette(c), c).toBe(true);
  });

  test('every call returns a new element, and the five icons differ', () => {
    for (const name of NAMES) expect(icon(name)).not.toBe(icon(name));
    const markup = NAMES.map((n) => {
      const svg = icon(n);
      svg.removeAttribute('data-icon');
      return svg.outerHTML;
    });
    expect(new Set(markup).size).toBe(NAMES.length);
  });

  test('the shapes paint: a mounted icon has a box and draws in the fill colours, never in black', () => {
    const root = document.createElement('div');
    document.body.append(root);
    try {
      for (const name of NAMES) {
        const svg = icon(name);
        svg.setAttribute('width', '48');
        svg.setAttribute('height', '48');
        root.replaceChildren(svg);
        expect(svg.getBoundingClientRect().width, name).toBe(48);
        for (const el of svg.querySelectorAll(SHAPES.join(','))) {
          expect(getComputedStyle(el).fill, `${name} ${el.localName}`).not.toBe('rgb(0, 0, 0)');
        }
      }
    } finally {
      root.remove();
    }
  });
});
