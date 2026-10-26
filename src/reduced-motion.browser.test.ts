// Reduced motion and Gentle mode at boot (plan §4.6.4, §4.6.6, §7 M8; issue #118): `boot` (main.ts) turns the bear's
// reduced motion on for `prefers-reduced-motion: reduce` or the parent's Gentle mode, and the bear's reduced motion
// sets the director's gentle flag. `matchMedia` is stubbed for the one query (Browser Mode can't flip the OS
// setting per test), Gentle mode comes from the stored settings, and the bear is the real one, captured through a
// wrapper around `mountBearView`. What reduced motion then does (× 0.3 on the squash and sway channels, ζ ≥ 0.9,
// gentle clips) is tested in anim/bear-view.browser.test.ts ("reduced motion" and "reduced motion sets the director
// gentle"); the gentle clips end to end are e2e/a11y.spec.ts. Also checked at boot: the canvas's name and the one
// live region, which reads the Asleep text.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BearView } from './anim/bear-view.ts';
import { SETTINGS_KEY } from './app/settings.ts';
import { boot } from './main.ts';
import type { Pwa } from './pwa/register.ts';
import { ANNOUNCEMENTS } from './ui/a11y.ts';
import { JUNI } from './characters/juni.ts';

const h = vi.hoisted(() => ({ views: [] as BearView[] }));

// register.ts imports `virtual:pwa-register`, which Browser Mode can't resolve (as in main.browser.test.ts).
vi.mock('./pwa/register.ts', () => ({
  setupPwa: (): Pwa => ({
    applyUpdate: () => {},
    promptInstall: async () => {},
    updateReady: () => false,
    activatedElsewhere: () => false,
  }),
}));

// The real bear, recorded so the test can read its reduced-motion and director state.
vi.mock(import('./anim/bear-view.ts'), async (importOriginal) => {
  const m = await importOriginal();
  return {
    ...m,
    mountBearView: (...args: Parameters<typeof m.mountBearView>) => {
      const v = m.mountBearView(...args);
      h.views.push(v);
      return v;
    },
  };
});

const QUERY = '(prefers-reduced-motion: reduce)';

/** A `matchMedia` whose reduced-motion query is `os.matches`; `os.set` flips it and fires `change`. */
function stubMotion(matches: boolean): { set(on: boolean): void } {
  const real = window.matchMedia.bind(window);
  const listeners: (() => void)[] = [];
  const mq = {
    matches,
    media: QUERY,
    onchange: null,
    addEventListener: (_type: string, cb: () => void) => listeners.push(cb),
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  vi.stubGlobal('matchMedia', (q: string) => (q === QUERY ? mq : real(q)));
  return {
    set(on) {
      mq.matches = on;
      for (const cb of listeners) cb();
    },
  };
}

const roots: HTMLElement[] = [];

/** Boots the app into a fresh root and returns its bear. */
async function bootBear(): Promise<{ root: HTMLElement; view: BearView }> {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  const before = h.views.length;
  await boot(root, { debug: false });
  expect(h.views.length).toBe(before + 1);
  const view = h.views[before];
  if (view === undefined) throw new Error('test: boot mounted no bear');
  return { root, view };
}

afterEach(() => {
  for (const r of roots.splice(0)) r.remove();
  for (const el of document.querySelectorAll('[data-a11y-live]')) el.remove();
  localStorage.removeItem(SETTINGS_KEY);
  vi.unstubAllGlobals();
});

describe('boot: reduced motion and Gentle mode (#118)', () => {
  test('the OS setting (prefers-reduced-motion: reduce) turns reduced motion and gentle clips on', async () => {
    stubMotion(true);
    const { view } = await bootBear();
    expect(view.reducedMotion).toBe(true);
    expect(view.director().gentle).toBe(true);
  });

  test('Gentle mode does the same with the OS setting off', async () => {
    stubMotion(false);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ gentleMode: true }));
    const { view } = await bootBear();
    expect(matchMedia(QUERY).matches).toBe(false);
    expect(view.reducedMotion).toBe(true);
    expect(view.director().gentle).toBe(true);
  });

  test('neither: full motion, no gentle clips', async () => {
    stubMotion(false);
    const { view } = await bootBear();
    expect(view.reducedMotion).toBe(false);
    expect(view.director().gentle).toBe(false);
  });

  test('a change of the OS setting applies at once, both ways', async () => {
    const os = stubMotion(false);
    const { view } = await bootBear();
    expect(view.reducedMotion).toBe(false);
    os.set(true);
    expect(view.reducedMotion).toBe(true);
    expect(view.director().gentle).toBe(true);
    os.set(false);
    expect(view.reducedMotion).toBe(false);
    expect(view.director().gentle).toBe(false);
  });

  test('the booted app: the canvas is "Juni the bear", one live region, empty at boot, then the Asleep text', async () => {
    stubMotion(false);
    const { root, view } = await bootBear();
    expect(root.querySelector('canvas.stage')).toBe(view.canvas);
    expect(view.canvas.getAttribute('role')).toBe('img');
    expect(view.canvas.getAttribute('aria-label')).toBe('Juni the bear');
    const live = document.querySelectorAll(
      '[aria-live]:not([aria-live="off"]), :is([role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"]):not([aria-live]), output:not([aria-live])',
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.hasAttribute('data-a11y-live')).toBe(true);
    expect(root.contains(live[0]!)).toBe(false);
    // Created during boot and still empty when boot returns: the screen reader registers the empty region first
    // (#295 review); the Asleep text follows once it has been exposed.
    expect(live[0]?.textContent).toBe('');
    await vi.waitFor(() => expect(live[0]?.textContent).toBe(ANNOUNCEMENTS.Asleep(JUNI.names)), {
      timeout: 2_000,
    });
  });
});
