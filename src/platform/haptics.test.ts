import { describe, expect, expectTypeOf, it } from 'vitest';

import { createHaptics, type Haptics, type HapticsNavigator } from './haptics.ts';

/** Plan §4.6.3's poke and tickle patterns, as sample inputs. */
const POKE = [12];
const TICKLE = [8, 40, 8, 40, 8];

/**
 * A fake `navigator` with the Vibration API. Like Chrome's, `vibrate` throws "Illegal invocation" when called
 * without its `this`, so every test that sees a call (or a `true`) also checks that it was a method call.
 */
class FakeNavigator implements HapticsNavigator {
  /** Each `vibrate` call's pattern, copied. */
  readonly calls: number[][] = [];
  /** What `vibrate` returns. */
  result = true;
  /** When set, `vibrate` throws it. */
  error: Error | null = null;
  userActivation: { hasBeenActive: boolean; isActive: boolean } | undefined = {
    hasBeenActive: false,
    isActive: false,
  };

  vibrate(pattern: number[]): boolean {
    if (!(this instanceof FakeNavigator)) throw new TypeError('Illegal invocation');
    if (this.error !== null) throw this.error;
    this.calls.push([...pattern]);
    return this.result;
  }
}

function setup(enabledAtStart = true) {
  const nav = new FakeNavigator();
  let enabled = enabledAtStart;
  const lines: string[] = [];
  const h = createHaptics(
    nav,
    () => enabled,
    (m) => lines.push(m),
  );
  const setEnabled = (on: boolean): void => {
    enabled = on;
  };
  return { nav, lines, h, setEnabled };
}

describe('createHaptics: signature', () => {
  it('matches the issue: the real Navigator fits, getEnabled, optional log, play and noteActivation', () => {
    expectTypeOf<Navigator>().toExtend<HapticsNavigator>();
    expectTypeOf(createHaptics).parameter(1).toEqualTypeOf<() => boolean>();
    expectTypeOf(createHaptics).parameter(2).toEqualTypeOf<((m: string) => void) | undefined>();
    expectTypeOf(createHaptics).returns.toEqualTypeOf<Haptics>();
    expectTypeOf<Haptics['play']>().toEqualTypeOf<(pattern: number[]) => boolean>();
    expectTypeOf<Haptics['noteActivation']>().toEqualTypeOf<(kind: 'down' | 'up') => void>();
  });
});

describe('createHaptics: disabled (validation 1)', () => {
  it('never calls vibrate, keeps nothing pending and logs nothing while getEnabled() is false', () => {
    const { nav, lines, h } = setup(false);
    expect(h.play(POKE)).toBe(false);
    h.noteActivation('down');
    h.noteActivation('up');
    expect(h.play(POKE)).toBe(false);
    h.noteActivation('down');
    expect(h.play(TICKLE)).toBe(false);
    h.noteActivation('up');
    expect(nav.calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('a play while disabled keeps nothing pending, even if haptics are on by the first up', () => {
    const { nav, h, setEnabled } = setup(false);
    expect(h.play(POKE)).toBe(false);
    setEnabled(true);
    h.noteActivation('up');
    expect(nav.calls).toEqual([]);
  });

  it('drops the pending pattern when haptics are off by the first up, and never plays it later', () => {
    const { nav, lines, h, setEnabled } = setup();
    expect(h.play(POKE)).toBe(false);
    setEnabled(false);
    h.noteActivation('up');
    expect(nav.calls).toEqual([]);
    setEnabled(true);
    h.noteActivation('down');
    h.noteActivation('up');
    expect(nav.calls).toEqual([]);
    expect(lines).toEqual([
      'vibrate([12]) not called (deferred to up); last activation: none; userActivation: hasBeenActive=false isActive=false',
    ]);
  });

  it('a play while disabled clears an earlier pending pattern', () => {
    const { nav, h, setEnabled } = setup();
    h.play(POKE);
    setEnabled(false);
    expect(h.play(TICKLE)).toBe(false);
    setEnabled(true);
    h.noteActivation('up');
    expect(nav.calls).toEqual([]);
  });

  it('reads getEnabled() at every play, so a settings toggle applies at once', () => {
    const { nav, h, setEnabled } = setup();
    h.noteActivation('up');
    expect(h.play(POKE)).toBe(true);
    setEnabled(false);
    expect(h.play(POKE)).toBe(false);
    expect(nav.calls).toEqual([POKE]);
    setEnabled(true);
    expect(h.play(TICKLE)).toBe(true);
    expect(nav.calls).toEqual([POKE, TICKLE]);
  });
});

describe('createHaptics: sticky activation (validation 2)', () => {
  it('defers the first play before any up, through downs, and fires it once on noteActivation("up")', () => {
    const { nav, h } = setup();
    expect(h.play(POKE)).toBe(false);
    expect(nav.calls).toEqual([]);
    h.noteActivation('down');
    h.noteActivation('down');
    expect(nav.calls).toEqual([]);
    h.noteActivation('up');
    expect(nav.calls).toEqual([POKE]);
    h.noteActivation('down');
    h.noteActivation('up');
    expect(nav.calls).toEqual([POKE]);
  });

  it('defers a play made after the first down (the adapter notes down before its gestures) until the up', () => {
    const { nav, h } = setup();
    h.noteActivation('down');
    expect(h.play(POKE)).toBe(false);
    expect(nav.calls).toEqual([]);
    h.noteActivation('up');
    expect(nav.calls).toEqual([POKE]);
  });

  it('keeps one pending pattern: a later play before the first up replaces it', () => {
    const { nav, h } = setup();
    expect(h.play(POKE)).toBe(false);
    expect(h.play(TICKLE)).toBe(false);
    h.noteActivation('down');
    h.noteActivation('up');
    expect(nav.calls).toEqual([TICKLE]);
  });

  it('keeps a copy of the pending pattern, so the caller may reuse its array', () => {
    const { nav, h } = setup();
    const pattern = [12];
    h.play(pattern);
    pattern[0] = 99;
    h.noteActivation('up');
    expect(nav.calls).toEqual([[12]]);
  });

  it('a first up with nothing pending vibrates nothing, but activates', () => {
    const { nav, h } = setup();
    h.noteActivation('up');
    expect(nav.calls).toEqual([]);
    expect(h.play(POKE)).toBe(true);
    expect(nav.calls).toEqual([POKE]);
  });
});

describe('createHaptics: after activation (validation 3)', () => {
  it('calls vibrate immediately, as a method of nav, and returns its result', () => {
    const { nav, h } = setup();
    h.noteActivation('down');
    h.noteActivation('up');
    expect(h.play(POKE)).toBe(true);
    expect(nav.calls).toEqual([POKE]);
    nav.result = false;
    expect(h.play(TICKLE)).toBe(false);
    expect(nav.calls).toEqual([POKE, TICKLE]);
  });

  it('stays activated (sticky) through later downs and ups', () => {
    const { nav, h } = setup();
    h.noteActivation('up');
    h.noteActivation('down');
    expect(h.play(TICKLE)).toBe(true);
    h.noteActivation('up');
    h.noteActivation('down');
    expect(h.play(POKE)).toBe(true);
    expect(nav.calls).toEqual([TICKLE, POKE]);
  });
});

describe('createHaptics: unsupported (validation 4)', () => {
  it('returns false and never throws without navigator.vibrate', () => {
    const lines: string[] = [];
    const h = createHaptics(
      {},
      () => true,
      (m) => lines.push(m),
    );
    expect(h.play(POKE)).toBe(false);
    h.noteActivation('down');
    h.noteActivation('up');
    expect(h.play(POKE)).toBe(false);
    expect(lines).toEqual([]);
  });

  it('returns false with navigator.userActivation but no vibrate, and without a log', () => {
    const h = createHaptics({ userActivation: { hasBeenActive: true, isActive: true } }, () => true);
    h.noteActivation('up');
    expect(h.play(POKE)).toBe(false);
  });
});

describe('createHaptics: X-A6 log', () => {
  it('logs the deferred first poke at its down and at its up, with the activation state', () => {
    const { nav, lines, h } = setup();
    h.noteActivation('down');
    h.play(POKE);
    nav.userActivation = { hasBeenActive: true, isActive: true };
    h.noteActivation('up');
    expect(lines).toEqual([
      'vibrate([12]) not called (deferred to up); last activation: down; userActivation: hasBeenActive=false isActive=false',
      'vibrate([12]) = true; deferred to up; last activation: up; userActivation: hasBeenActive=true isActive=true',
    ]);
  });

  it('logs one line per immediate call, with the latest activation kind', () => {
    const { nav, lines, h } = setup();
    h.noteActivation('up');
    h.noteActivation('down');
    nav.userActivation = { hasBeenActive: true, isActive: false };
    nav.result = false;
    h.play(TICKLE);
    nav.result = true;
    h.noteActivation('up');
    h.play(POKE);
    expect(lines).toEqual([
      'vibrate([8,40,8,40,8]) = false; immediate; last activation: down; userActivation: hasBeenActive=true isActive=false',
      'vibrate([12]) = true; immediate; last activation: up; userActivation: hasBeenActive=true isActive=false',
    ]);
  });

  it('logs n/a without navigator.userActivation', () => {
    const { nav, lines, h } = setup();
    nav.userActivation = undefined;
    h.noteActivation('up');
    h.play(POKE);
    expect(lines).toEqual(['vibrate([12]) = true; immediate; last activation: up; userActivation: n/a']);
  });

  it('works without a log callback', () => {
    const nav = new FakeNavigator();
    const h = createHaptics(nav, () => true);
    h.play(POKE);
    h.noteActivation('up');
    expect(h.play(TICKLE)).toBe(true);
    expect(nav.calls).toEqual([POKE, TICKLE]);
  });
});

describe('createHaptics: a throwing vibrate', () => {
  it('is logged and returns false from play, without throwing', () => {
    const { nav, lines, h } = setup();
    h.noteActivation('up');
    nav.error = new Error('boom');
    expect(h.play(POKE)).toBe(false);
    expect(lines).toEqual([
      'vibrate([12]) threw Error: boom; immediate; last activation: up; userActivation: hasBeenActive=false isActive=false',
    ]);
  });

  it('is logged when the pending pattern plays, without throwing from noteActivation', () => {
    const { nav, lines, h } = setup();
    nav.error = new Error('boom');
    h.play(POKE);
    expect(() => h.noteActivation('up')).not.toThrow();
    expect(lines).toEqual([
      'vibrate([12]) not called (deferred to up); last activation: none; userActivation: hasBeenActive=false isActive=false',
      'vibrate([12]) threw Error: boom; deferred to up; last activation: up; userActivation: hasBeenActive=false isActive=false',
    ]);
  });
});
