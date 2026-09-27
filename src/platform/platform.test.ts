import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../test/fake-clock.ts';
import { realClock } from '../app/clock.ts';
import { createVisibility, type VisEvent } from './visibility.ts';

// ---- fakes built on the global EventTarget ----------------------------------------------------

/** The parts of `Document` that visibility.ts uses: `visibilityState` and its events. */
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState;
  constructor(initial: DocumentVisibilityState = 'visible') {
    super();
    this.visibilityState = initial;
  }
  /** A real-style `visibilitychange`: the state flips first, then the event fires. */
  setVisibility(v: DocumentVisibilityState): void {
    this.visibilityState = v;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

function makeVisibility(initial: DocumentVisibilityState = 'visible') {
  const doc = new FakeDocument(initial);
  const win = new EventTarget();
  const vis = createVisibility(doc, win);
  return { doc, win, vis };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- 1. FakeClock ------------------------------------------------------------------------------

describe('FakeClock', () => {
  it('runs due timers in due-time order, ties in creation order, with now() at each due time', () => {
    const clock = new FakeClock();
    const log: string[] = [];
    const at = (name: string) => () => log.push(`${name}@${clock.now()}`);
    clock.setTimeout(at('c30'), 30);
    clock.setTimeout(at('a10'), 10);
    clock.setTimeout(at('b20'), 20);
    clock.setTimeout(at('a10-second'), 10);
    clock.setTimeout(at('zero'), 0);
    clock.advance(25);
    expect(log).toEqual(['zero@0', 'a10@10', 'a10-second@10', 'b20@20']);
    expect(clock.now()).toBe(25);
    clock.advance(5);
    expect(log).toEqual(['zero@0', 'a10@10', 'a10-second@10', 'b20@20', 'c30@30']);
    expect(clock.now()).toBe(30);
    expect(clock.pending()).toBe(0);
  });

  it('includes the end of the window and starts from the constructor time', () => {
    const clock = new FakeClock(1000);
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(clock.now()), 50);
    clock.advance(49);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([1050]);
  });

  it('treats a negative or NaN delay as 0, returns distinct ids, and rejects a negative advance', () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    const a = clock.setTimeout(() => fired.push('neg'), -5);
    const b = clock.setTimeout(() => fired.push('nan'), Number.NaN);
    expect(a).not.toBe(b);
    clock.advance(0);
    expect(fired).toEqual(['neg', 'nan']);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
  });

  it('clearTimeout cancels a pending timer, also from inside an earlier callback; unknown ids are ignored', () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    const cancelled = clock.setTimeout(() => fired.push('cancelled'), 10);
    let later = 0;
    clock.setTimeout(() => {
      fired.push('first');
      clock.clearTimeout(later);
    }, 5);
    later = clock.setTimeout(() => fired.push('later'), 20);
    clock.setTimeout(() => fired.push('kept'), 30);
    clock.clearTimeout(cancelled);
    clock.clearTimeout(9999);
    clock.advance(100);
    expect(fired).toEqual(['first', 'kept']);
    clock.clearTimeout(later); // already cleared: no-op
    expect(clock.pending()).toBe(0);
  });

  it('runs timers scheduled during advance when they fall due within the window', () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    clock.setTimeout(() => {
      fired.push(`outer@${clock.now()}`);
      clock.setTimeout(() => fired.push(`nested+5@${clock.now()}`), 5);
      clock.setTimeout(() => fired.push(`nested+0@${clock.now()}`), 0);
      clock.setTimeout(() => {
        fired.push(`nested+100@${clock.now()}`);
      }, 100);
    }, 10);
    clock.setTimeout(() => fired.push(`sibling@${clock.now()}`), 10);
    clock.advance(20);
    // nested+0 is due at 10 like sibling, but was created later, so it runs after it
    expect(fired).toEqual(['outer@10', 'sibling@10', 'nested+0@10', 'nested+5@15']);
    expect(clock.now()).toBe(20);
    clock.advance(89);
    expect(fired).toHaveLength(4);
    clock.advance(1);
    expect(fired.at(-1)).toBe('nested+100@110');
  });
});

describe('realClock', () => {
  it('uses performance.now and the global timers, with numeric ids', async () => {
    const t0 = realClock.now();
    expect(typeof t0).toBe('number');
    const fired: string[] = [];
    const kept = realClock.setTimeout(() => fired.push('kept'), 1);
    const cleared = realClock.setTimeout(() => fired.push('cleared'), 1);
    expect(typeof kept).toBe('number');
    expect(typeof cleared).toBe('number');
    realClock.clearTimeout(cleared);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fired).toEqual(['kept']);
    expect(realClock.now()).toBeGreaterThanOrEqual(t0);
  });
});

// ---- 2. Visibility -----------------------------------------------------------------------------

describe('createVisibility', () => {
  it('starts from document.visibilityState', () => {
    expect(makeVisibility('hidden').vis.current()).toBe('hidden');
    expect(makeVisibility('visible').vis.current()).toBe('visible');
  });

  it('maps real-style events to subscribers synchronously, and current() tracks visibilitychange', () => {
    const { doc, win, vis } = makeVisibility();
    const seen: VisEvent[] = [];
    vis.subscribe((e) => seen.push(e));

    doc.setVisibility('hidden');
    expect(seen).toEqual(['hidden']); // synchronous: no await between dispatch and assertion
    expect(vis.current()).toBe('hidden');

    win.dispatchEvent(new Event('pagehide'));
    doc.dispatchEvent(new Event('freeze'));
    doc.dispatchEvent(new Event('resume'));
    expect(seen).toEqual(['hidden', 'pagehide', 'freeze', 'resume']);
    expect(vis.current()).toBe('hidden'); // only visibilitychange changes current()

    doc.setVisibility('visible');
    expect(seen.at(-1)).toBe('visible');
    expect(vis.current()).toBe('visible');
  });

  it('simulate() notifies like a real event and updates current() without touching the document', () => {
    const { doc, vis } = makeVisibility();
    const seen: VisEvent[] = [];
    vis.subscribe((e) => seen.push(e));

    vis.simulate('hidden');
    expect(seen).toEqual(['hidden']);
    expect(vis.current()).toBe('hidden');
    expect(doc.visibilityState).toBe('visible');

    vis.simulate('visible');
    expect(seen).toEqual(['hidden', 'visible']);
    expect(vis.current()).toBe('visible');
  });

  it('notifies every subscriber in order; unsubscribe, even mid-round, stops delivery; a throwing subscriber is logged', () => {
    const { vis } = makeVisibility();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    let offC: (() => void) | undefined;
    const offA = vis.subscribe((e) => {
      seen.push(`a:${e}`);
      offC?.(); // removed during the round: must not be called in it
    });
    vis.subscribe(() => {
      throw new Error('boom');
    });
    offC = vis.subscribe((e) => seen.push(`c:${e}`));
    const offD = vis.subscribe((e) => seen.push(`d:${e}`));

    vis.simulate('hidden');
    expect(seen).toEqual(['a:hidden', 'd:hidden']);
    expect(error).toHaveBeenCalledTimes(1);

    offA();
    offD();
    offD(); // idempotent
    vis.simulate('visible');
    expect(seen).toEqual(['a:hidden', 'd:hidden']);
  });
});
