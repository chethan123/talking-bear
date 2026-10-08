// The kid-first UI's icons (plan §7 M8, Q3; issue #115): inline SVG built with createElementNS and setAttribute only,
// never markup strings (CSP and Trusted Types, plan §4.8.3), and never a `style` attribute. Each icon is a 48 × 48
// viewBox that its container sizes with CSS. They are decoration for a child who can't read: `aria-hidden="true"`
// and `focusable="false"`, with no <title> and no text; accessible names belong to the controls (#118).
//
// Every shape sets `fill` explicitly: SVG's default fill is black, so a stroke-only shape gets `fill="none"`.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The plan §4.6 "Palette" colours the icons use (Juni's own: fur, pads, nose, blaze, tongue). */
export const ICON_COLOURS = {
  /** Fur, juniper teal. */
  fur: '#2F7A6D',
  /** Paw pads. */
  pads: '#7B4B5A',
  /** Nose. */
  nose: '#2B1D2A',
  /** Blaze, the cream stripe. */
  blaze: '#F6EEDC',
  /** Tongue: the palette's red, for the "no" slash. */
  tongue: '#E07A7A',
} as const;

/** The icons: tap-to-wake paw, mic blocked (mic help), mic muted (badge), tap to retry, too noisy (badge). */
export type IconName = 'paw' | 'micBlocked' | 'micMuted' | 'retry' | 'noise';

type Attrs = Readonly<Record<string, string | number>>;

function shape(tag: string, attrs: Attrs): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A round-capped stroke with no fill. */
function stroke(d: string, colour: string, width: number): SVGElement {
  return shape('path', {
    d,
    fill: 'none',
    stroke: colour,
    'stroke-width': width,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
}

/** The icon's disc: it reads over both the teal fur and the cream background. */
function disc(fill: string): SVGElement {
  return shape('circle', { cx: 24, cy: 24, r: 22.5, fill, stroke: ICON_COLOURS.fur, 'stroke-width': 2 });
}

/** A microphone in `colour`: capsule, cradle and stand. */
function mic(colour: string): SVGElement[] {
  return [
    shape('rect', { x: 19, y: 9, width: 10, height: 18, rx: 5, fill: colour }),
    stroke('M14 23 v1 a10 10 0 0 0 20 0 v-1', colour, 2.5),
    stroke('M24 34 v5 M18 39 h12', colour, 2.5),
  ];
}

const SLASH = 'M11 11 L37 37';

/** Each icon's shapes, in paint order. */
const SHAPES: { readonly [N in IconName]: () => SVGElement[] } = {
  paw: () => [
    disc(ICON_COLOURS.blaze),
    shape('ellipse', { cx: 24, cy: 30.5, rx: 9, ry: 7.5, fill: ICON_COLOURS.pads }),
    shape('circle', { cx: 14.5, cy: 20.5, r: 3.6, fill: ICON_COLOURS.pads }),
    shape('circle', { cx: 20.5, cy: 15, r: 3.6, fill: ICON_COLOURS.pads }),
    shape('circle', { cx: 27.5, cy: 15, r: 3.6, fill: ICON_COLOURS.pads }),
    shape('circle', { cx: 33.5, cy: 20.5, r: 3.6, fill: ICON_COLOURS.pads }),
  ],
  micBlocked: () => [
    disc(ICON_COLOURS.blaze),
    ...mic(ICON_COLOURS.nose),
    stroke(SLASH, ICON_COLOURS.blaze, 7),
    stroke(SLASH, ICON_COLOURS.tongue, 4),
  ],
  micMuted: () => [
    disc(ICON_COLOURS.nose),
    ...mic(ICON_COLOURS.blaze),
    stroke(SLASH, ICON_COLOURS.tongue, 4),
  ],
  retry: () => [
    disc(ICON_COLOURS.blaze),
    stroke('M34 15.5 A12.5 12.5 0 1 0 36.5 27', ICON_COLOURS.fur, 4),
    shape('polygon', { points: '38,8 39,19 28,16.5', fill: ICON_COLOURS.fur }),
  ],
  noise: () => [
    disc(ICON_COLOURS.blaze),
    ...[17, 24, 31].map((y) => stroke(`M9 ${y} q3.75 -4 7.5 0 t7.5 0 t7.5 0 t7.5 0`, ICON_COLOURS.fur, 3)),
  ],
};

/**
 * A new `<svg class="icon" data-icon=name>` (48 × 48 viewBox, `aria-hidden="true"`, `focusable="false"`), built
 * from palette shapes only. Every call returns a new element.
 */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('data-icon', name);
  svg.append(...SHAPES[name]());
  return svg;
}
