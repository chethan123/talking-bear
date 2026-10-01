/**
 * Browser Mode tests for the DOM pointer adapter (issue #87): synthetic `PointerEvent`s dispatched on a real canvas,
 * with a fake `hit`. The canvas sits at a known offset in the viewport so canvas-relative coordinates are checked.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { attachPointerAdapter } from './pointer-adapter.ts';
import type { PointerAdapter, PointerAdapterOptions } from './pointer-adapter.ts';
import { LONG_PRESS_MS } from './recognizer.ts';
import type { Gesture, PointerSample } from './recognizer.ts';
import type { RegionId } from './region-ids.ts';

/** The canvas's viewport position and CSS size. */
const LEFT = 30;
const TOP = 40;
const SIZE = 200;
/** The fake hit: the top half is the nose, the bottom half the belly. */
const fakeHit = (_x: number, y: number): RegionId => (y < SIZE / 2 ? 'nose' : 'belly');

let canvas: HTMLCanvasElement;
let attached: PointerAdapter[] = [];

beforeEach(() => {
  canvas = document.createElement('canvas');
  canvas.style.position = 'fixed';
  canvas.style.left = `${LEFT}px`;
  canvas.style.top = `${TOP}px`;
  canvas.style.width = `${SIZE}px`;
  canvas.style.height = `${SIZE}px`;
  document.body.append(canvas);
});

afterEach(() => {
  for (const a of attached) a.detach();
  attached = [];
  canvas.remove();
  vi.restoreAllMocks();
});

interface Rig {
  adapter: PointerAdapter;
  gestures: Gesture[];
  samples: PointerSample[];
  hits: [number, number][];
  readonly rawDowns: number;
  rawUps: { cancel: boolean; active: number }[];
  /** Every callback in call order: `rawDown`, `sample:<type>`, `hit:<x>,<y>`, `gesture:<g>[:<phase>]`, `rawUp`. */
  log: string[];
}

/** Attaches an adapter to `canvas` that records every callback. */
function rig(extra: Partial<PointerAdapterOptions> = {}): Rig {
  const gestures: Gesture[] = [];
  const samples: PointerSample[] = [];
  const hits: [number, number][] = [];
  const rawUps: { cancel: boolean; active: number }[] = [];
  const log: string[] = [];
  const counts = { rawDowns: 0 };
  const adapter = attachPointerAdapter(canvas, {
    hit: (x, y) => {
      hits.push([x, y]);
      log.push(`hit:${x},${y}`);
      return fakeHit(x, y);
    },
    onGesture: (g) => {
      gestures.push(g);
      log.push('phase' in g ? `gesture:${g.g}:${g.phase}` : `gesture:${g.g}`);
    },
    onRawDown: () => {
      counts.rawDowns++;
      log.push('rawDown');
    },
    onRawUp: (e) => {
      rawUps.push(e);
      log.push('rawUp');
    },
    onSample: (s) => {
      samples.push(s);
      log.push(`sample:${s.type}`);
    },
    ...extra,
  });
  attached.push(adapter);
  return {
    adapter,
    gestures,
    samples,
    hits,
    get rawDowns() {
      return counts.rawDowns;
    },
    rawUps,
    log,
  };
}

/** A pointer event at canvas-relative (x, y); a touch with pointer id 7 unless `init` says otherwise. */
function pe(type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 7,
    pointerType: 'touch',
    isPrimary: true,
    clientX: LEFT + x,
    clientY: TOP + y,
    ...init,
  });
}

/** Dispatches a pointer event on the canvas and returns it. */
function fire(type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
  const e = pe(type, x, y, init);
  canvas.dispatchEvent(e);
  return e;
}

/** Spins until `performance.now()` has advanced by at least `ms`, so the next event's `timeStamp` differs. */
function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin
  }
}

describe('attachPointerAdapter', () => {
  test('V1: down + up at the same point gives tap down then tap up, in canvas CSS px', () => {
    const r = rig();
    const down = fire('pointerdown', 50, 60);
    const up = fire('pointerup', 50, 60);
    expect(r.gestures).toEqual([
      { g: 'tap', phase: 'down', region: 'nose', x: 50, y: 60, count: 1 },
      { g: 'tap', phase: 'up', region: 'nose', x: 50, y: 60, count: 1 },
    ]);
    expect(r.hits[0]).toEqual([50, 60]);
    expect(r.samples).toEqual([
      { id: 7, t: down.timeStamp, x: 50, y: 60, type: 'down', pointerType: 'touch' },
      { id: 7, t: up.timeStamp, x: 50, y: 60, type: 'up', pointerType: 'touch' },
    ]);
  });

  test('V2: contextmenu and selectstart default actions are prevented', () => {
    rig();
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    expect(canvas.dispatchEvent(menu)).toBe(false);
    expect(menu.defaultPrevented).toBe(true);
    const select = new Event('selectstart', { bubbles: true, cancelable: true });
    expect(canvas.dispatchEvent(select)).toBe(false);
    expect(select.defaultPrevented).toBe(true);
  });

  test('V3: a tick at down timeStamp + 520 ms gives longPress start; + 499 ms does not', () => {
    let clock = 0;
    const r = rig({ now: () => clock });
    const down = fire('pointerdown', 50, 150);
    clock = down.timeStamp + LONG_PRESS_MS - 1;
    r.adapter.tick();
    expect(r.gestures).toEqual([{ g: 'tap', phase: 'down', region: 'belly', x: 50, y: 150, count: 1 }]);
    clock = down.timeStamp + 520;
    r.adapter.tick();
    expect(r.gestures.slice(1)).toEqual([{ g: 'longPress', region: 'belly', phase: 'start' }]);
    expect(r.samples.at(-1)).toEqual({ id: -1, t: down.timeStamp + 520, x: 0, y: 0, type: 'tick' });
    // Each tick is a fresh object, so a recorded trace keeps every tick's own time.
    expect(r.samples.filter((s) => s.type === 'tick').map((s) => s.t)).toEqual([
      down.timeStamp + LONG_PRESS_MS - 1,
      down.timeStamp + 520,
    ]);
  });

  test('V4: pointercancel gives cancel, then no reaction gestures, and onRawUp({cancel: true, active: 0})', () => {
    let clock = 0;
    const r = rig({ now: () => clock });
    const down = fire('pointerdown', 50, 150);
    fire('pointermove', 52, 150);
    const cancel = fire('pointercancel', 52, 150);
    expect(r.gestures).toEqual([
      { g: 'tap', phase: 'down', region: 'belly', x: 50, y: 150, count: 1 },
      { g: 'cancel' },
    ]);
    expect(r.samples.at(-1)).toMatchObject({ id: 7, t: cancel.timeStamp, type: 'cancel' });
    expect(r.rawUps).toEqual([{ cancel: true, active: 0 }]);
    const fed = r.samples.length;
    // Nothing after the cancel reaches the recogniser for that pointer, whatever follows.
    clock = down.timeStamp + 2 * LONG_PRESS_MS;
    r.adapter.tick();
    fire('pointermove', 150, 150);
    fire('pointerup', 150, 150);
    r.adapter.tick();
    expect(r.gestures.slice(2)).toEqual([]);
    expect(r.samples).toHaveLength(fed);
  });

  test('V5: every coalesced event becomes a move sample timed by its own timeStamp', () => {
    const r = rig();
    fire('pointerdown', 10, 150);
    const coalesced: PointerEvent[] = [];
    for (let i = 1; i <= 4; i++) {
      busyWait(3);
      coalesced.push(pe('pointermove', 10 + 10 * i, 150));
    }
    busyWait(3);
    const move = fire('pointermove', 50, 150, { coalescedEvents: coalesced });
    expect(move.getCoalescedEvents()).toHaveLength(4);
    const moves = r.samples.filter((s) => s.type === 'move');
    expect(moves).toHaveLength(4);
    expect(moves.map((s) => s.t)).toEqual(coalesced.map((c) => c.timeStamp));
    expect(moves.map((s) => [s.x, s.y])).toEqual([
      [20, 150],
      [30, 150],
      [40, 150],
      [50, 150],
    ]);
    for (let i = 1; i < moves.length; i++) expect(moves[i]!.t).toBeGreaterThan(moves[i - 1]!.t);
    for (const s of moves) expect(s).toMatchObject({ id: 7, pointerType: 'touch' });
  });

  test('a pointermove with no coalesced events is one sample of the event itself', () => {
    const r = rig();
    fire('pointerdown', 10, 150);
    const move = fire('pointermove', 30, 160);
    expect(move.getCoalescedEvents()).toHaveLength(0);
    expect(r.samples.slice(1)).toEqual([
      { id: 7, t: move.timeStamp, x: 30, y: 160, type: 'move', pointerType: 'touch' },
    ]);
  });

  test('id and pointerType come from the dispatched event, not from its coalesced events', () => {
    const r = rig();
    fire('pointerdown', 10, 150);
    const bare = new PointerEvent('pointermove', { clientX: LEFT + 20, clientY: TOP + 150 });
    fire('pointermove', 20, 150, { coalescedEvents: [bare] });
    expect(r.samples.slice(1)).toEqual([
      { id: 7, t: bare.timeStamp, x: 20, y: 150, type: 'move', pointerType: 'touch' },
    ]);
  });

  test('a detach from inside a callback stops the rest of that event', () => {
    let moves = 0;
    const r = rig({
      onSample: (s) => {
        if (s.type === 'move' && ++moves === 2) r.adapter.detach();
      },
    });
    fire('pointerdown', 10, 150);
    const coalesced = [1, 2, 3, 4].map((i) => pe('pointermove', 10 + 10 * i, 150));
    fire('pointermove', 50, 150, { coalescedEvents: coalesced });
    expect(moves).toBe(2);
    const up = rig({
      onGesture: (g) => {
        if (g.g === 'tap' && g.phase === 'up') up.adapter.detach();
      },
    });
    fire('pointerdown', 50, 60, { pointerId: 21 });
    fire('pointerup', 50, 60, { pointerId: 21 });
    expect(up.rawUps).toEqual([]);
  });

  test('a detach from onSample stops that sample: no hit test, no gestures, and nothing afterwards', () => {
    const r = rig({ onSample: () => r.adapter.detach() });
    fire('pointerdown', 50, 60);
    expect(r.rawDowns).toBe(1);
    expect(r.hits).toEqual([]);
    expect(r.gestures).toEqual([]);
    fire('pointerup', 50, 60);
    fire('pointerdown', 50, 150, { pointerId: 8 });
    r.adapter.tick();
    expect(r.rawDowns).toBe(1);
    expect(r.hits).toEqual([]);
    expect(r.gestures).toEqual([]);
    expect(r.rawUps).toEqual([]);
  });

  test('a detach from the first onGesture of a sample drops the rest of its gestures', () => {
    // A down for a pointer that is already down emits two gestures: the stale contact's cancel, then tap down.
    const control = rig();
    fire('pointerdown', 50, 60);
    fire('pointerdown', 50, 60);
    expect(control.gestures.map((g) => g.g)).toEqual(['tap', 'cancel', 'tap']);
    control.adapter.detach();
    const seen: Gesture[] = [];
    const r = rig({
      onGesture: (g) => {
        seen.push(g);
        if (g.g === 'cancel') r.adapter.detach();
      },
    });
    fire('pointerdown', 50, 60);
    fire('pointerdown', 50, 60);
    expect(seen.map((g) => g.g)).toEqual(['tap', 'cancel']);
  });

  test('coordinates use the canvas position read at the latest pointerdown', () => {
    const r = rig();
    canvas.style.left = `${LEFT + 25}px`; // moved after attach: not cached at attach
    fire('pointerdown', 50, 60);
    canvas.style.left = `${LEFT + 50}px`; // moved after the down: moves keep the down's origin
    fire('pointermove', 60, 60);
    fire('pointerdown', 50, 150, { pointerId: 8, isPrimary: false }); // a later down re-reads it
    expect(r.samples.map((s) => [s.type, s.x, s.y])).toEqual([
      ['down', 25, 60],
      ['move', 35, 60],
      ['down', 0, 150],
    ]);
  });

  test('moves, ups and cancels of a pointer that is not down are not fed', () => {
    const r = rig();
    fire('pointermove', 20, 20, { pointerType: 'mouse', pointerId: 1 });
    fire('pointerup', 20, 20, { pointerType: 'mouse', pointerId: 1 });
    fire('pointercancel', 20, 20, { pointerId: 9 });
    expect(r.samples).toEqual([]);
    expect(r.gestures).toEqual([]);
    expect(r.rawUps).toEqual([
      { cancel: false, active: 0 },
      { cancel: true, active: 0 },
    ]);
  });

  test('onRawDown, then onSample, precede recognize; onRawUp follows the up gestures and counts pointers still down', () => {
    const r = rig();
    fire('pointerdown', 50, 60);
    fire('pointerup', 50, 60);
    // onSample runs before recognize, which calls hit for the down and for the up (a last move).
    expect(r.log).toEqual([
      'rawDown',
      'sample:down',
      'hit:50,60',
      'gesture:tap:down',
      'sample:up',
      'hit:50,60',
      'gesture:tap:up',
      'rawUp',
    ]);
    fire('pointerdown', 50, 60, { pointerId: 11 });
    fire('pointerdown', 50, 150, { pointerId: 12, isPrimary: false });
    fire('pointerup', 50, 60, { pointerId: 11 });
    fire('pointercancel', 50, 150, { pointerId: 12, isPrimary: false });
    expect(r.rawDowns).toBe(3);
    expect(r.rawUps).toEqual([
      { cancel: false, active: 0 },
      { cancel: false, active: 1 },
      { cancel: true, active: 0 },
    ]);
  });

  test('tick feeds nothing while no pointer is down', () => {
    const r = rig({ now: () => 1e9 });
    r.adapter.tick();
    fire('pointerdown', 50, 60);
    fire('pointerup', 50, 60);
    const fed = r.samples.length;
    r.adapter.tick();
    expect(r.samples).toHaveLength(fed);
    expect(r.samples.some((s) => s.type === 'tick')).toBe(false);
  });

  test('the default tick clock shares the event timeStamp origin (performance.now)', async () => {
    const r = rig();
    const down = fire('pointerdown', 50, 150);
    r.adapter.tick();
    expect(r.gestures.map((g) => g.g)).toEqual(['tap']);
    const tick = r.samples.at(-1)!;
    expect(tick.type).toBe('tick');
    expect(tick.t).toBeGreaterThanOrEqual(down.timeStamp);
    expect(tick.t - down.timeStamp).toBeLessThan(LONG_PRESS_MS);
    await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 20));
    r.adapter.tick();
    expect(r.gestures.slice(1)).toEqual([{ g: 'longPress', region: 'belly', phase: 'start' }]);
  });

  test('the mouse gets pointer capture; touch does not; a failing capture is harmless', () => {
    const capture = vi.spyOn(canvas, 'setPointerCapture');
    const r = rig();
    fire('pointerdown', 50, 60);
    expect(capture).not.toHaveBeenCalled();
    fire('pointerup', 50, 60);
    fire('pointerdown', 50, 60, { pointerType: 'mouse', pointerId: 1 });
    expect(capture).toHaveBeenLastCalledWith(1);
    fire('pointerup', 50, 60, { pointerType: 'mouse', pointerId: 1 });
    // Pointer id 99 is not an active pointer: the real setPointerCapture throws NotFoundError.
    expect(() => HTMLCanvasElement.prototype.setPointerCapture.call(canvas, 99)).toThrow(DOMException);
    const before = r.gestures.length;
    fire('pointerdown', 50, 150, { pointerType: 'mouse', pointerId: 99 });
    expect(capture).toHaveBeenLastCalledWith(99);
    expect(r.gestures.slice(before)).toEqual([
      { g: 'tap', phase: 'down', region: 'belly', x: 50, y: 150, count: 1 },
    ]);
  });

  test('touch-action and user-select are none while attached, and restored by detach', () => {
    canvas.style.setProperty('touch-action', 'pan-y', 'important');
    const r = rig();
    expect(getComputedStyle(canvas).touchAction).toBe('none');
    expect(getComputedStyle(canvas).userSelect).toBe('none');
    r.adapter.detach();
    expect(canvas.style.getPropertyValue('touch-action')).toBe('pan-y');
    expect(canvas.style.getPropertyPriority('touch-action')).toBe('important');
    expect(canvas.style.getPropertyValue('user-select')).toBe('');
    expect(getComputedStyle(canvas).userSelect).not.toBe('none');
  });

  test('pointer listeners are passive; contextmenu and selectstart are not', () => {
    const add = vi.spyOn(canvas, 'addEventListener');
    rig();
    const passive = new Map(
      add.mock.calls.map(([type, , options]) => [
        type,
        typeof options === 'object' && options.passive === true,
      ]),
    );
    expect(Object.fromEntries(passive)).toEqual({
      pointerdown: true,
      pointermove: true,
      pointerup: true,
      pointercancel: true,
      contextmenu: false,
      selectstart: false,
    });
  });

  test('after detach: no samples, gestures or hooks, nothing prevented, tick inert; detach releases capture', () => {
    let clock = 0;
    const add = vi.spyOn(canvas, 'addEventListener');
    const remove = vi.spyOn(canvas, 'removeEventListener');
    const r = rig({ now: () => clock });
    const has = vi.spyOn(canvas, 'hasPointerCapture').mockReturnValue(true);
    const release = vi.spyOn(canvas, 'releasePointerCapture').mockImplementation(() => {
      throw new DOMException('gone', 'NotFoundError');
    });
    const down = fire('pointerdown', 50, 150, { pointerType: 'mouse', pointerId: 1 });
    const fed = r.samples.length;
    const gestures = r.gestures.length;
    expect(() => r.adapter.detach()).not.toThrow();
    expect(add).toHaveBeenCalledTimes(6);
    expect(remove.mock.calls.map(([type, listener]) => [type, listener])).toEqual(
      add.mock.calls.map(([type, listener]) => [type, listener]),
    );
    expect(has).toHaveBeenCalledWith(1);
    expect(release).toHaveBeenCalledWith(1);
    clock = down.timeStamp + 2 * LONG_PRESS_MS;
    r.adapter.tick();
    fire('pointermove', 80, 150, { pointerType: 'mouse', pointerId: 1 });
    fire('pointerup', 80, 150, { pointerType: 'mouse', pointerId: 1 });
    fire('pointerdown', 50, 60);
    fire('pointercancel', 50, 60);
    r.adapter.tick();
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(menu);
    const select = new Event('selectstart', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(select);
    expect(r.samples).toHaveLength(fed);
    expect(r.gestures).toHaveLength(gestures);
    expect(r.rawDowns).toBe(1);
    expect(r.rawUps).toEqual([]);
    expect(menu.defaultPrevented).toBe(false);
    expect(select.defaultPrevented).toBe(false);
    expect(() => r.adapter.detach()).not.toThrow();
  });
});
