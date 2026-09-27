import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../test/fake-clock.ts';
import { realClock } from '../app/clock.ts';
import { createMicPermission, type PermissionsNavigator } from './permissions.ts';
import { createVisibility, type VisEvent } from './visibility.ts';
import { createWakeLock, type WakeLockNavigator } from './wake-lock.ts';

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

class FakeSentinel extends EventTarget {
  released = false;
  readonly type = 'screen';
  readonly release = vi.fn(async (): Promise<void> => {
    this.uaRelease();
  });
  /** What the UA does on hide, and what `release()` does: flag, then fire `release` once. */
  uaRelease(): void {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

/** `navigator.wakeLock` whose `request()` results the test settles by hand. */
function makeWakeLockNav() {
  const calls: Array<{ resolve(s: FakeSentinel): void; reject(err: unknown): void }> = [];
  const request = vi.fn(
    (type: string) =>
      new Promise<FakeSentinel>((resolve, reject) => {
        expect(type).toBe('screen');
        calls.push({ resolve, reject });
      }),
  );
  const nav: WakeLockNavigator = { wakeLock: { request } };
  /** Grants request `i` with a fresh sentinel and returns it. */
  const grant = (i: number): FakeSentinel => {
    const s = new FakeSentinel();
    calls[i]?.resolve(s);
    return s;
  };
  return { nav, request, calls, grant };
}

class FakePermissionStatus extends EventTarget {
  readonly name = 'microphone';
  state: PermissionState;
  constructor(state: PermissionState) {
    super();
    this.state = state;
  }
  /** What Chrome does when the user changes the permission: new state, then `change`. */
  change(s: PermissionState): void {
    this.state = s;
    this.dispatchEvent(new Event('change'));
  }
}

/** `navigator.permissions` that always returns the same live status object. */
function makePermissionNav(initial: PermissionState) {
  const status = new FakePermissionStatus(initial);
  const query = vi.fn(async (desc: { name: string }) => {
    expect(desc.name).toBe('microphone');
    return status;
  });
  const nav: PermissionsNavigator = { permissions: { query } };
  return { nav, status, query };
}

/** Lets every pending promise callback run (a macrotask turn drains the microtask queue). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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

  it('treats an infinite delay as 0, like the browser (WebIDL long)', () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('+inf'), Number.POSITIVE_INFINITY);
    clock.setTimeout(() => fired.push('-inf'), Number.NEGATIVE_INFINITY);
    clock.advance(0);
    expect(fired).toEqual(['+inf', '-inf']);
  });

  it('never moves time backwards when a callback advances re-entrantly', () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    clock.setTimeout(() => clock.advance(20), 5); // from 5 to 25, inside the outer advance(10)
    clock.setTimeout(() => fired.push(`inner@${clock.now()}`), 15);
    clock.advance(10);
    expect(fired).toEqual(['inner@15']);
    expect(clock.now()).toBe(25);
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

// ---- 3. Wake lock ------------------------------------------------------------------------------

describe('createWakeLock', () => {
  it('does not request while hidden; becoming visible requests while wanted', async () => {
    const { doc, vis } = makeVisibility('hidden');
    const { nav, request, grant } = makeWakeLockNav();
    const wl = createWakeLock(nav, vis, vi.fn());

    wl.set(true);
    expect(request).not.toHaveBeenCalled();
    expect(wl.held()).toBe(false);

    doc.setVisibility('visible');
    expect(request).toHaveBeenCalledTimes(1);
    grant(0);
    await flush();
    expect(wl.held()).toBe(true);
  });

  it('set(false) releases; visible no longer re-requests', async () => {
    const { vis } = makeVisibility();
    const { nav, request, grant } = makeWakeLockNav();
    const wl = createWakeLock(nav, vis, vi.fn());

    wl.set(true);
    wl.set(true); // no second request while one is in flight
    expect(request).toHaveBeenCalledTimes(1);
    const s = grant(0);
    await flush();
    expect(wl.held()).toBe(true);

    wl.set(false);
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(wl.held()).toBe(false);

    vis.simulate('hidden');
    vis.simulate('visible');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('re-requests on visible after the UA released the lock on hide', async () => {
    const { doc, vis } = makeVisibility();
    const { nav, request, grant } = makeWakeLockNav();
    const wl = createWakeLock(nav, vis, vi.fn());

    wl.set(true);
    const first = grant(0);
    await flush();
    doc.setVisibility('hidden');
    first.uaRelease();
    expect(wl.held()).toBe(false);

    doc.setVisibility('visible');
    expect(request).toHaveBeenCalledTimes(2);
    grant(1);
    await flush();
    expect(wl.held()).toBe(true);
  });

  it('releases a lock granted after set(false)', async () => {
    const { vis } = makeVisibility();
    const { nav, grant } = makeWakeLockNav();
    const wl = createWakeLock(nav, vis, vi.fn());

    wl.set(true);
    wl.set(false);
    const late = grant(0);
    await flush();
    expect(late.release).toHaveBeenCalledTimes(1);
    expect(wl.held()).toBe(false);
  });

  it('logs a rejected request and never throws', async () => {
    const { vis } = makeVisibility();
    const { nav, request, calls, grant } = makeWakeLockNav();
    const log = vi.fn();
    const wl = createWakeLock(nav, vis, log);

    const err = new Error('NotAllowedError: battery saver');
    expect(() => wl.set(true)).not.toThrow();
    calls[0]?.reject(err);
    await flush();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toContain(err);
    expect(wl.held()).toBe(false);

    // still wanted: the next visible retries
    vis.simulate('visible');
    expect(request).toHaveBeenCalledTimes(2);
    grant(1);
    await flush();
    expect(wl.held()).toBe(true);
  });

  it('drops a sentinel that arrives already released, and re-requests on the next visible', async () => {
    const { doc, vis } = makeVisibility();
    const { nav, request, calls } = makeWakeLockNav();
    const wl = createWakeLock(nav, vis, vi.fn());

    wl.set(true);
    const stale = new FakeSentinel();
    stale.released = true; // released by the UA before we could listen: no release event will come
    calls[0]?.resolve(stale);
    await flush();
    expect(wl.held()).toBe(false);

    doc.setVisibility('hidden');
    doc.setVisibility('visible');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('retries once when a visible was skipped while the failed request was in flight', async () => {
    const { doc, vis } = makeVisibility();
    const { nav, request, calls, grant } = makeWakeLockNav();
    const log = vi.fn();
    const wl = createWakeLock(nav, vis, log);

    wl.set(true);
    doc.setVisibility('hidden');
    doc.setVisibility('visible'); // skipped: a request is in flight
    expect(request).toHaveBeenCalledTimes(1);
    calls[0]?.reject(new Error('NotAllowedError: document hidden'));
    await flush();
    expect(log).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2); // exactly one retry
    grant(1);
    await flush();
    expect(wl.held()).toBe(true);
  });

  it('retries once when a visible was skipped and the request is granted already released', async () => {
    const { doc, vis } = makeVisibility();
    const { nav, request, calls, grant } = makeWakeLockNav();
    const wl = createWakeLock(nav, vis, vi.fn());

    wl.set(true);
    doc.setVisibility('hidden');
    doc.setVisibility('visible'); // skipped: a request is in flight
    const stale = new FakeSentinel();
    stale.released = true;
    calls[0]?.resolve(stale);
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    grant(1);
    await flush();
    expect(wl.held()).toBe(true);
  });

  it('does not re-request after a plain rejection, and an owed retry never loops', async () => {
    const { vis } = makeVisibility();
    const { nav, request, calls } = makeWakeLockNav();
    const log = vi.fn();
    const wl = createWakeLock(nav, vis, log);
    const err = new Error('NotAllowedError: battery saver');

    wl.set(true);
    calls[0]?.reject(err);
    await flush();
    expect(request).toHaveBeenCalledTimes(1); // nothing was skipped: no retry

    wl.set(true); // request 2
    wl.set(true); // skipped while in flight: one retry is owed
    calls[1]?.reject(err);
    await flush();
    expect(request).toHaveBeenCalledTimes(3); // the one owed retry
    calls[2]?.reject(err);
    await flush();
    expect(request).toHaveBeenCalledTimes(3); // no loop
    expect(log).toHaveBeenCalledTimes(3);
    expect(wl.held()).toBe(false);
  });

  it('logs a request that throws synchronously', () => {
    const { vis } = makeVisibility();
    const err = new Error('sync');
    const nav: WakeLockNavigator = {
      wakeLock: {
        request: () => {
          throw err;
        },
      },
    };
    const log = vi.fn();
    const wl = createWakeLock(nav, vis, log);
    expect(() => wl.set(true)).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toContain(err);
    expect(wl.held()).toBe(false);
  });

  it('is a no-op without navigator.wakeLock', () => {
    const { vis } = makeVisibility();
    const log = vi.fn();
    const wl = createWakeLock({}, vis, log);
    expect(() => {
      wl.set(true);
      vis.simulate('hidden');
      vis.simulate('visible');
      wl.set(false);
    }).not.toThrow();
    expect(wl.held()).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});

// ---- 4. Mic permission -------------------------------------------------------------------------

describe('createMicPermission', () => {
  it("gives 'prompt' when the API is missing, throws or rejects", async () => {
    const vis = makeVisibility().vis;
    await expect(createMicPermission({}, vis).query()).resolves.toBe('prompt');

    const throwing: PermissionsNavigator = {
      permissions: {
        query: () => {
          throw new TypeError('unsupported');
        },
      },
    };
    await expect(createMicPermission(throwing, vis).query()).resolves.toBe('prompt');

    const rejecting: PermissionsNavigator = {
      permissions: { query: () => Promise.reject(new TypeError('unsupported')) },
    };
    await expect(createMicPermission(rejecting, vis).query()).resolves.toBe('prompt');
  });

  it('passes the state through', async () => {
    const vis = makeVisibility().vis;
    for (const s of ['granted', 'prompt', 'denied'] as const) {
      await expect(createMicPermission(makePermissionNav(s).nav, vis).query()).resolves.toBe(s);
    }
  });

  it('notifies on change events only when the value changes', async () => {
    const { vis } = makeVisibility();
    const { nav, status } = makePermissionNav('prompt');
    const perm = createMicPermission(nav, vis);
    await expect(perm.query()).resolves.toBe('prompt');
    const seen: string[] = [];
    perm.subscribe((s) => seen.push(s));

    status.change('granted');
    expect(seen).toEqual(['granted']);
    status.dispatchEvent(new Event('change')); // same value
    expect(seen).toEqual(['granted']);
    await perm.query(); // repeated queries don't add listeners or notifications
    await perm.query();
    status.change('denied');
    expect(seen).toEqual(['granted', 'denied']);
  });

  it('re-queries on every visible and notifies only when the value changes', async () => {
    const { doc, vis } = makeVisibility();
    const { nav, status, query } = makePermissionNav('granted');
    const perm = createMicPermission(nav, vis);
    await perm.query();
    const seen: string[] = [];
    perm.subscribe((s) => seen.push(s));
    const calls = query.mock.calls.length;

    doc.setVisibility('hidden'); // a one-time grant expires in the background: no change event
    status.state = 'prompt';
    expect(query).toHaveBeenCalledTimes(calls); // hidden doesn't query
    doc.setVisibility('visible');
    expect(query).toHaveBeenCalledTimes(calls + 1);
    await flush();
    expect(seen).toEqual(['prompt']);

    vis.simulate('visible'); // unchanged
    await flush();
    expect(query).toHaveBeenCalledTimes(calls + 2);
    expect(seen).toEqual(['prompt']);
  });

  it('unsubscribe stops notifications', async () => {
    const { vis } = makeVisibility();
    const { nav, status } = makePermissionNav('granted');
    const perm = createMicPermission(nav, vis);
    await perm.query();
    const cb = vi.fn();
    const off = perm.subscribe(cb);
    off();
    status.change('denied');
    expect(cb).not.toHaveBeenCalled();
  });

  it('subscribing before any query attaches the change listener, with the first value as the baseline', async () => {
    const { vis } = makeVisibility();
    const { nav, status } = makePermissionNav('prompt');
    const perm = createMicPermission(nav, vis);
    const seen: string[] = [];
    perm.subscribe((s) => seen.push(s));
    await flush();
    expect(seen).toEqual([]);
    status.change('granted');
    expect(seen).toEqual(['granted']);
  });

  it('follows the latest status object a query returns', async () => {
    const { doc, vis } = makeVisibility();
    const statuses: FakePermissionStatus[] = [];
    let current: PermissionState = 'granted';
    const nav: PermissionsNavigator = {
      permissions: {
        query: () => {
          const s = new FakePermissionStatus(current); // a new object per query
          statuses.push(s);
          return Promise.resolve(s);
        },
      },
    };
    const perm = createMicPermission(nav, vis);
    await perm.query();
    const seen: string[] = [];
    perm.subscribe((s) => seen.push(s));

    doc.setVisibility('hidden');
    current = 'prompt'; // a one-time grant expired in the background
    doc.setVisibility('visible');
    await flush();
    expect(statuses).toHaveLength(2);
    expect(seen).toEqual(['prompt']);

    statuses[1]?.change('granted'); // granted again: the event arrives on the latest object
    expect(seen).toEqual(['prompt', 'granted']);
    statuses[0]?.change('denied'); // the first object is no longer observed
    expect(seen).toEqual(['prompt', 'granted']);
  });

  it('ignores a query result that a newer change event overtook', async () => {
    const { vis } = makeVisibility();
    const status = new FakePermissionStatus('granted');
    let release: (() => void) | undefined;
    let slow = false;
    const nav: PermissionsNavigator = {
      permissions: {
        query: () =>
          slow
            ? new Promise<FakePermissionStatus>((resolve) => {
                const stale = new FakePermissionStatus('granted');
                release = () => resolve(stale);
              })
            : Promise.resolve(status),
      },
    };
    const perm = createMicPermission(nav, vis);
    await perm.query();
    const seen: string[] = [];
    perm.subscribe((s) => seen.push(s));

    slow = true;
    const pending = perm.query(); // started before the change, resolves after it with the old value
    status.change('denied');
    release?.();
    await expect(pending).resolves.toBe('granted');
    await flush();
    expect(seen).toEqual(['denied']);
  });
});
