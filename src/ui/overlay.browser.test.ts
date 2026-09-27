// Browser Mode tests for the M1 placeholder UI: the text overlays (overlay.ts) and, because Scope names only this
// test file, the canvas stage and its input (circle.ts). styles.css is deliberately not imported: the `hidden`
// attribute hides through the UA stylesheet, and the canvas keeps its intrinsic 300×150 CSS size.

import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import type { Overlay, SessionEvent, StateName } from '../app/events.ts';
import { AWAKE } from '../app/machine.ts';
import type { VisEvent } from '../platform/visibility.ts';
import {
  BACKGROUND,
  levelOf,
  MAX_DPR,
  mountCircle,
  radiusOf,
  STATE_FILL,
  type Circle,
  type CircleDeps,
} from './circle.ts';
import { mountOverlay, OVERLAY_TEXT } from './overlay.ts';

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  root.remove();
});

/** The one visible overlay sheet under `root`. */
function visibleSheet(): HTMLElement {
  const sheets = Array.from(root.querySelectorAll<HTMLElement>('section')).filter((s) => !s.hidden);
  expect(sheets).toHaveLength(1);
  return sheets[0]!;
}

describe('overlay.ts', () => {
  const SINGLE_TEXT: readonly [Overlay, string][] = [
    ['tapToWake', 'Tap Juni to wake up'],
    ['micMuted', 'Mic muted'],
    ['tooNoisy', 'Too noisy'],
    ['error', 'Something went wrong. Tap to try again.'],
  ];
  const PARENT = [
    'Before Juni can listen',
    'Juni only listens on this device. Nothing you say is sent anywhere.',
    'The microphone switches off when Juni falls asleep.',
    'Continue',
  ] as const;
  const MIC_HELP = [
    "Microphone is blocked. To fix it, allow the microphone for this site in Chrome's site settings.",
    'Try again',
  ] as const;

  test.each(SINGLE_TEXT)('%s renders exactly its text', (variant, text) => {
    const show = mountOverlay(root, vi.fn());
    show(variant);
    expect(root.innerText).toBe(text);
  });

  test('parentPermission renders the sheet: h2, two paragraphs and Continue', () => {
    const show = mountOverlay(root, vi.fn());
    show('parentPermission');
    const sheet = visibleSheet();
    expect(sheet.querySelector('h2')?.textContent).toBe(PARENT[0]);
    const ps = sheet.querySelectorAll('p');
    expect(ps).toHaveLength(2);
    expect(ps[0]?.textContent).toBe(PARENT[1]);
    expect(ps[1]?.textContent).toBe(PARENT[2]);
    expect(sheet.querySelector('button')?.textContent).toBe(PARENT[3]);
    expect(root.innerText).toBe(PARENT.join('\n\n'));
  });

  test('micHelp renders the blocked-mic text and Try again', () => {
    const show = mountOverlay(root, vi.fn());
    show('micHelp');
    const sheet = visibleSheet();
    const ps = sheet.querySelectorAll('p');
    expect(ps).toHaveLength(1);
    expect(ps[0]?.textContent).toBe(MIC_HELP[0]);
    expect(sheet.querySelector('button')?.textContent).toBe(MIC_HELP[1]);
    expect(root.innerText).toBe(MIC_HELP.join('\n\n'));
  });

  test('the exported texts are the specified ones', () => {
    expect(OVERLAY_TEXT).toEqual({
      tapToWake: SINGLE_TEXT[0]![1],
      parentTitle: PARENT[0],
      parentLocal: PARENT[1],
      parentMicOff: PARENT[2],
      parentContinue: PARENT[3],
      micHelp: MIC_HELP[0],
      micHelpRetry: MIC_HELP[1],
      micMuted: SINGLE_TEXT[1]![1],
      tooNoisy: SINGLE_TEXT[2]![1],
      error: SINGLE_TEXT[3]![1],
    });
  });

  test('Continue dispatches parentContinue', () => {
    const dispatch = vi.fn<(e: SessionEvent) => void>();
    const show = mountOverlay(root, dispatch);
    show('parentPermission');
    const button = visibleSheet().querySelector('button');
    expect(button?.checkVisibility()).toBe(true);
    button?.click();
    expect(dispatch.mock.calls).toEqual([[{ t: 'parentContinue' }]]);
  });

  test('Try again dispatches settingsRetry', () => {
    const dispatch = vi.fn<(e: SessionEvent) => void>();
    const show = mountOverlay(root, dispatch);
    show('micHelp');
    const button = visibleSheet().querySelector('button');
    expect(button?.checkVisibility()).toBe(true);
    button?.click();
    expect(dispatch.mock.calls).toEqual([[{ t: 'settingsRetry' }]]);
  });

  test('null hides every variant, and switching variants hides the previous one', () => {
    const show = mountOverlay(root, vi.fn());
    show('parentPermission');
    show('tapToWake');
    expect(root.innerText).toBe('Tap Juni to wake up');
    show(null);
    expect(root.innerText.trim()).toBe('');
    for (const el of root.querySelectorAll<HTMLElement>('.overlay > *')) expect(el.hidden).toBe(true);
  });

  test('no element under root has a style attribute after rendering every variant', () => {
    const show = mountOverlay(root, vi.fn());
    const all: Overlay[] = [
      'tapToWake',
      'parentPermission',
      'micHelp',
      'micMuted',
      'tooNoisy',
      'error',
      null,
    ];
    for (const o of all) show(o);
    expect(root.querySelectorAll('[style]').length).toBe(0);
  });
});

// ---- circle.ts --------------------------------------------------------------------------------------------------

/** The fill table as the issue specifies it. */
const SPEC_FILL: readonly [StateName, string][] = [
  ['Asleep', '#9AA0A6'],
  ['NeedsParent', '#E3A43A'],
  ['Waking', '#7FC8BC'],
  ['MicDenied', '#E3A43A'],
  ['Listening', '#2F7A6D'],
  ['Recording', '#D93025'],
  ['Processing', '#8E44AD'],
  ['Playing', '#1A73E8'],
  ['SfxGated', '#F29900'],
  ['Cooldown', '#BDC1C6'],
  ['Paused', '#9AA0A6'],
  ['Error', '#8B0000'],
];

/** A fake frame scheduler: `step(t)` runs the pending callbacks, like one vsync at time `t`. */
function fakeFrames(): {
  pending: Map<number, FrameRequestCallback>;
  request: (cb: FrameRequestCallback) => number;
  cancel: (id: number) => void;
  step: (t: number) => void;
} {
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  return {
    pending,
    request: (cb) => {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    cancel: (id) => {
      pending.delete(id);
    },
    step: (t) => {
      const due = Array.from(pending.values());
      pending.clear();
      for (const cb of due) cb(t);
    },
  };
}

/** A fake Visibility: `set(v)` changes current() and notifies like a real visibility change. */
function fakeVisibility(): { vis: CircleDeps['visibility']; set: (v: 'visible' | 'hidden') => void } {
  let current: 'visible' | 'hidden' = 'visible';
  const subs = new Set<(e: VisEvent) => void>();
  return {
    vis: {
      current: () => current,
      subscribe: (cb) => {
        subs.add(cb);
        return () => {
          subs.delete(cb);
        };
      },
    },
    set: (v) => {
      current = v;
      for (const cb of subs) cb(v);
    },
  };
}

function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function pixel(c: Circle, x: number, y: number): [number, number, number] {
  const g = c.canvas.getContext('2d');
  if (g === null) throw new Error('no 2d context');
  const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return [d[0]!, d[1]!, d[2]!];
}

/** The pixel `k · r0` right of the centre (r0 = 0.25 · min(w, h) in backing-store pixels). */
function pixelAtRadius(c: Circle, k: number): [number, number, number] {
  const { width: w, height: h } = c.canvas;
  return pixel(c, w / 2 + k * 0.25 * Math.min(w, h), h / 2);
}

describe('circle.ts (M1 stage)', () => {
  let circle: Circle | undefined;
  let frames: ReturnType<typeof fakeFrames>;
  let visibility: ReturnType<typeof fakeVisibility>;
  let state: StateName;
  let clock: number;
  let dispatch: Mock<(e: SessionEvent) => void>;

  function mount(): Circle {
    circle = mountCircle(root, {
      visibility: visibility.vis,
      now: () => clock,
      state: () => state,
      dispatch,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    });
    return circle;
  }

  beforeEach(() => {
    frames = fakeFrames();
    visibility = fakeVisibility();
    state = 'Asleep';
    clock = 0;
    dispatch = vi.fn<(e: SessionEvent) => void>();
  });

  afterEach(() => {
    circle?.dispose();
    circle = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('mounts one canvas.stage whose backing store is its CSS size × min(devicePixelRatio, 2)', () => {
    const c = mount();
    expect(root.querySelectorAll('canvas.stage')).toHaveLength(1);
    const dpr = Math.min(devicePixelRatio, MAX_DPR);
    expect(c.canvas.width).toBe(Math.max(1, Math.round(c.canvas.clientWidth * dpr)));
    expect(c.canvas.height).toBe(Math.max(1, Math.round(c.canvas.clientHeight * dpr)));
    expect(root.querySelectorAll('[style]').length).toBe(0);
  });

  test('caps the backing-store scale at 2 on a denser display', () => {
    // A CSS size, as styles.css gives the stage in the app (a constructed sheet: no style attribute), so the
    // layout size does not follow the backing store.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.stage { width: 200px; height: 100px; }');
    const before = [...document.adoptedStyleSheets]; // a copy: adoptedStyleSheets is a live array
    document.adoptedStyleSheets = [...before, sheet];
    try {
      vi.stubGlobal('devicePixelRatio', 3);
      const c = mount();
      expect([c.canvas.clientWidth, c.canvas.clientHeight]).toEqual([200, 100]);
      expect([c.canvas.width, c.canvas.height]).toEqual([400, 200]);
    } finally {
      document.adoptedStyleSheets = before;
    }
  });

  test('fills the circle with the specified colour of each state', () => {
    expect(STATE_FILL).toEqual(Object.fromEntries(SPEC_FILL));
    const c = mount();
    for (const [s, hex] of SPEC_FILL) {
      c.setState(s === 'Listening' ? 'Recording' : 'Listening');
      c.setState(s);
      expect(pixel(c, c.canvas.width / 2, c.canvas.height / 2), s).toEqual(rgbOf(hex));
      expect(pixel(c, 1, 1), `${s} background`).toEqual(rgbOf(BACKGROUND));
    }
  });

  test('levelOf maps dB to 0..1 and radiusOf follows r0 · (1 + 0.6 · lvl)', () => {
    expect(levelOf(-70)).toBe(0);
    expect(levelOf(-10)).toBe(1);
    expect(levelOf(-40)).toBeCloseTo(0.5, 12);
    expect(levelOf(-100)).toBe(0);
    expect(levelOf(0)).toBe(1);
    expect(levelOf(Number.NaN)).toBe(0);
    expect(levelOf(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(radiusOf(300, 150, 0)).toBe(37.5);
    expect(radiusOf(300, 150, 1)).toBeCloseTo(60, 12);
  });

  test('the radius eases towards the latest level with an 80 ms one-pole', () => {
    const c = mount();
    const fill = rgbOf(STATE_FILL.Listening);
    const bg = rgbOf(BACKGROUND);
    c.setState('Listening');
    expect(pixelAtRadius(c, 0.9)).toEqual(fill);
    expect(pixelAtRadius(c, 1.1)).toEqual(bg);

    const period = 1000 / 60;
    let t = 1000;
    frames.step(t); // the first frame after the start is drawn with dt = 0
    c.setLevel(-10); // target lvl 1
    frames.step((t += period)); // skipped by the 30 fps cap
    frames.step((t += period)); // drawn: dt = 33.3 ms → lvl = 1 − e^(−33.3/80) ≈ 0.34, r ≈ 1.20 · r0
    expect(pixelAtRadius(c, 1.15)).toEqual(fill);
    expect(pixelAtRadius(c, 1.25)).toEqual(bg);

    for (let i = 0; i < 60; i++) frames.step((t += period)); // 1 s later: r ≈ 1.6 · r0
    expect(pixelAtRadius(c, 1.55)).toEqual(fill);
    expect(pixelAtRadius(c, 1.65)).toEqual(bg);
  });

  test('the loop is capped at 30 fps and stops while Asleep or hidden; a state change redraws once', () => {
    const c = mount();
    const arc = vi.spyOn(CanvasRenderingContext2D.prototype, 'arc');
    c.setState('Listening');
    expect(frames.pending.size).toBe(1);

    arc.mockClear();
    c.setState('Asleep');
    expect(arc).toHaveBeenCalledTimes(1);
    expect(frames.pending.size).toBe(0);

    c.setState('Listening');
    expect(frames.pending.size).toBe(1);
    let t = 0;
    arc.mockClear();
    for (let i = 0; i < 60; i++) frames.step((t += 1000 / 60));
    expect(Math.abs(arc.mock.calls.length - 30)).toBeLessThanOrEqual(1);

    arc.mockClear();
    for (let i = 0; i < 120; i++) frames.step((t += 1000 / 120));
    expect(Math.abs(arc.mock.calls.length - 30)).toBeLessThanOrEqual(1);

    visibility.set('hidden');
    expect(frames.pending.size).toBe(0);
    arc.mockClear();
    frames.step((t += 1000));
    expect(arc).not.toHaveBeenCalled();

    visibility.set('visible');
    expect(frames.pending.size).toBe(1);
    c.setState('Asleep');
    expect(frames.pending.size).toBe(0);
  });

  test('pointer input: tapBear when Asleep or Error, poke / poke2 when awake, nothing otherwise', () => {
    const c = mount();
    const down = (t: number, x: number, y: number): void => {
      clock = t;
      c.canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }));
    };
    const poke: SessionEvent = { t: 'reaction', name: 'poke', priority: 2, sfx: 'testBeep' };
    const poke2: SessionEvent = { t: 'reaction', name: 'poke2', priority: 3, sfx: 'testBeep' };

    for (const s of ['Asleep', 'Error'] as const) {
      state = s;
      dispatch.mockClear();
      down(0, 10, 10);
      down(100, 10, 10);
      expect(dispatch.mock.calls, s).toEqual([[{ t: 'tapBear' }], [{ t: 'tapBear' }]]);
    }
    for (const s of ['NeedsParent', 'Paused'] as const) {
      state = s;
      dispatch.mockClear();
      down(0, 10, 10);
      expect(dispatch, s).not.toHaveBeenCalled();
    }
    expect(AWAKE.size).toBe(8);
    let t = 10_000;
    for (const s of AWAKE) {
      state = s;
      dispatch.mockClear();
      down((t += 1000), 10, 10);
      expect(dispatch.mock.calls, s).toEqual([[poke]]);
    }

    state = 'Listening';
    const taps: [number, number, number, SessionEvent][] = [
      [100_000, 10, 10, poke],
      [100_200, 70, 70, poke2], // 200 ms, 84.9 px
      [100_300, 70, 70, poke], // the pair was complete
      [100_650, 70, 70, poke], // 350 ms later
      [100_700, 200, 70, poke], // 130 px away
      [101_001, 200, 70, poke], // 301 ms later
      [101_100, 200, 70, poke2],
      [102_000, 0, 0, poke],
      [102_300, 100, 0, poke2], // exactly 300 ms and 100 px
    ];
    dispatch.mockClear();
    for (const [time, x, y] of taps) down(time, x, y);
    expect(dispatch.mock.calls).toEqual(taps.map(([, , , e]) => [e]));
  });
});
