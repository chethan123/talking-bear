// The M1 placeholder stage (plan §7 M1 UI): a full-viewport canvas circle whose radius follows the input level
// and whose fill follows the session state, plus the canvas's pointer input (tap to wake, poke, double-tap poke2).
//
// Frame loop: requestAnimationFrame capped at 30 fps; it stops while the page is hidden and while Asleep, and every
// state change redraws once. No allocation per frame (CLAUDE.md rule 3): the mutable per-frame numbers live in one
// preallocated Float64Array (a double stored in a closure variable can be boxed again on every write), `tick` and
// `draw` are created once, and fills come from the constant STATE_FILL table.

import type { SessionEvent, StateName } from '../app/events.ts';
import { AWAKE } from '../app/machine.ts';
import type { Visibility } from '../platform/visibility.ts';

export const STATE_FILL: Readonly<Record<StateName, string>> = {
  Asleep: '#9AA0A6',
  NeedsParent: '#E3A43A',
  Waking: '#7FC8BC',
  MicDenied: '#E3A43A',
  Listening: '#2F7A6D',
  Recording: '#D93025',
  Processing: '#8E44AD',
  Playing: '#1A73E8',
  SfxGated: '#F29900',
  Cooldown: '#BDC1C6',
  Paused: '#9AA0A6',
  Error: '#8B0000',
};
/** The page background (styles.css); the canvas is opaque (`alpha: false`), so it paints it itself. */
export const BACKGROUND = '#FFF4E0';
/** The backing store is the CSS size × min(devicePixelRatio, MAX_DPR). */
export const MAX_DPR = 2;
/** Time constant of the one-pole smoothing of the level. */
export const LEVEL_TAU_MS = 80;
export const FPS_CAP = 30;
/** vsync jitter tolerance of the fps cap: a 60 Hz display draws every 2nd frame, not every 3rd. */
export const FRAME_SLACK_MS = 2;
/** A second pointerdown within this time and distance of a poke is a double tap (poke2). */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 100;

/** `clamp((db + 70) / 60, 0, 1)`; NaN gives 0. */
export function levelOf(db: number): number {
  const x = (db + 70) / 60;
  if (!(x > 0)) return 0;
  return x < 1 ? x : 1;
}

/** `r0 · (1 + 0.6 · lvl)` with `r0 = 0.25 · min(w, h)`. */
export function radiusOf(w: number, h: number, lvl: number): number {
  return 0.25 * Math.min(w, h) * (1 + 0.6 * lvl);
}

export interface CircleDeps {
  visibility: Pick<Visibility, 'current' | 'subscribe'>;
  /** Monotonic milliseconds (the app clock), for the double tap. */
  now(): number;
  /** The session's current state, for the pointer input. */
  state(): StateName;
  dispatch(e: SessionEvent): void;
  /** Defaults to `requestAnimationFrame`; tests inject a fake. */
  requestFrame?: (cb: FrameRequestCallback) => number;
  /** Defaults to `cancelAnimationFrame`. */
  cancelFrame?: (id: number) => void;
}

export interface Circle {
  readonly canvas: HTMLCanvasElement;
  /** Sets the fill for `s`, redraws once, and starts or stops the frame loop. */
  setState(s: StateName): void;
  /** The latest `level` event's dB; the circle eases towards it. */
  setLevel(db: number): void;
  /** Stops the loop, removes the listeners and the canvas. */
  dispose(): void;
}

// Slots of the frame-state array.
const LVL = 0; // smoothed level, 0..1
const TARGET = 1; // level of the latest `level` event, 0..1
const LAST = 2; // timestamp of the last drawn frame; -1 = none since the loop (re)started

function opaque2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = canvas.getContext('2d', { alpha: false });
  if (g === null) throw new Error('circle: no 2d canvas context');
  return g;
}

export function mountCircle(root: HTMLElement, deps: CircleDeps): Circle {
  const { visibility } = deps;
  const requestFrame = (cb: FrameRequestCallback): number =>
    deps.requestFrame ? deps.requestFrame(cb) : requestAnimationFrame(cb);
  const cancelFrame = (id: number): void => {
    if (deps.cancelFrame) deps.cancelFrame(id);
    else cancelAnimationFrame(id);
  };

  const canvas = document.createElement('canvas');
  canvas.className = 'stage';
  root.append(canvas);
  const g = opaque2d(canvas);

  const f = new Float64Array(3);
  f[LAST] = -1;
  let name: StateName = 'Asleep';
  let fill: string = STATE_FILL.Asleep;
  let rafId = 0;

  function draw(): void {
    const w = canvas.width;
    const h = canvas.height;
    g.fillStyle = BACKGROUND;
    g.fillRect(0, 0, w, h);
    g.fillStyle = fill;
    g.beginPath();
    g.arc(w / 2, h / 2, radiusOf(w, h, f[LVL]!), 0, 2 * Math.PI);
    g.fill();
  }

  function wantLoop(): boolean {
    return name !== 'Asleep' && visibility.current() !== 'hidden';
  }

  function tick(t: number): void {
    rafId = 0;
    if (!wantLoop()) return;
    rafId = requestFrame(tick);
    const last = f[LAST]!;
    if (last >= 0 && t - last < 1000 / FPS_CAP - FRAME_SLACK_MS) return;
    const dt = last >= 0 ? Math.max(0, t - last) : 0;
    f[LAST] = t;
    const lvl = f[LVL]!;
    f[LVL] = lvl + (f[TARGET]! - lvl) * (1 - Math.exp(-dt / LEVEL_TAU_MS));
    draw();
  }

  /** Starts or stops the loop to match the state and the page visibility. */
  function sync(): void {
    if (wantLoop()) {
      if (rafId === 0) {
        f[LAST] = -1;
        rafId = requestFrame(tick);
      }
    } else if (rafId !== 0) {
      cancelFrame(rafId);
      rafId = 0;
    }
  }

  function resize(): void {
    const dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
    // Read both CSS sizes first: without a CSS size, a canvas's layout size follows its width/height attributes.
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    draw(); // resizing clears the backing store
  }

  // ---- input ---------------------------------------------------------------------------------------------------
  let lastPokeT = -Infinity;
  let lastPokeX = 0;
  let lastPokeY = 0;

  function onPointerDown(e: PointerEvent): void {
    const s = deps.state();
    if (s === 'Asleep' || s === 'Error') {
      deps.dispatch({ t: 'tapBear' });
      return;
    }
    if (!AWAKE.has(s)) return;
    const t = deps.now();
    if (
      t - lastPokeT <= DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - lastPokeX, e.clientY - lastPokeY) <= DOUBLE_TAP_PX
    ) {
      lastPokeT = -Infinity; // the pair is complete: a third quick tap is a new poke
      deps.dispatch({ t: 'reaction', name: 'poke2', priority: 3, sfx: 'testBeep' });
      return;
    }
    lastPokeT = t;
    lastPokeX = e.clientX;
    lastPokeY = e.clientY;
    deps.dispatch({ t: 'reaction', name: 'poke', priority: 2, sfx: 'testBeep' });
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('resize', resize);
  const unsubscribe = visibility.subscribe(sync);
  resize();

  return {
    canvas,
    setState(s) {
      if (s === name) return;
      name = s;
      fill = STATE_FILL[s];
      draw();
      sync();
    },
    setLevel(db) {
      f[TARGET] = levelOf(db);
    },
    dispose() {
      if (rafId !== 0) cancelFrame(rafId);
      rafId = 0;
      unsubscribe();
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.remove();
    },
  };
}
