// `boot(root, { debug, onDebugOverlay })` (#57, PR #260 review): the overlay's report says what actually ran, so
// lab/vad-live labels its pre-gate by the real feature-trace state, not by the URL. The overlay module is mocked:
// it turns the trace on through its deps, as the real one does, and then mounts or throws.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { boot } from './main.ts';
import type { Pwa } from './pwa/register.ts';
import type { DebugOverlayDeps } from './ui/debug-overlay.ts';

const h = vi.hoisted(() => ({
  /** What the mocked overlay does after turning the trace on. */
  mode: 'mount' as 'mount' | 'throw',
  mounts: 0,
  /** Every `setTrace` call on the engine the overlay got, `boot`'s own included. */
  trace: [] as boolean[],
}));

// register.ts imports `virtual:pwa-register`, which exists only inside a Vite build with vite-plugin-pwa; Browser
// Mode can't even resolve it, so the whole module is replaced (no service worker in this test).
vi.mock('./pwa/register.ts', () => ({
  setupPwa: (): Pwa => ({ applyUpdate: () => {}, promptInstall: async () => {}, updateReady: () => false }),
}));

vi.mock('./ui/debug-overlay.ts', () => ({
  mountDebugOverlay: (_root: HTMLElement, deps: DebugOverlayDeps) => {
    h.mounts++;
    const engine = deps.vad?.engine;
    if (engine === undefined) throw new Error('test: the overlay got no engine');
    const setTrace = engine.setTrace.bind(engine);
    engine.setTrace = (on: boolean): void => {
      h.trace.push(on);
      setTrace(on);
    };
    engine.setTrace(true);
    if (h.mode === 'throw') throw new Error('test: mount failed after turning the trace on');
    return { refresh: (): void => {}, dispose: (): void => {} };
  },
}));

const roots: HTMLElement[] = [];

/** Boots into a fresh root; resolves with `onDebugOverlay`'s argument, or 'none' if it isn't called in time. */
async function bootReport(debug: boolean, waitMs = 3000): Promise<boolean | 'none'> {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  const reported = new Promise<boolean>((resolve) => {
    void boot(root, { debug, onDebugOverlay: resolve });
  });
  const timeout = new Promise<'none'>((resolve) => setTimeout(() => resolve('none'), waitMs));
  return Promise.race([reported, timeout]);
}

describe('boot: onDebugOverlay', () => {
  afterEach(() => {
    h.mode = 'mount';
    h.mounts = 0;
    h.trace.length = 0;
    for (const r of roots.splice(0)) r.remove();
    vi.restoreAllMocks();
  });

  test('a mounted overlay reports true, with the feature trace on', async () => {
    expect(await bootReport(true)).toBe(true);
    expect(h.mounts).toBe(1);
    expect(h.trace).toEqual([true]);
  });

  test('a mount that throws reports false and turns the trace back off', async () => {
    h.mode = 'throw';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await bootReport(true)).toBe(false);
    expect(h.mounts).toBe(1);
    expect(h.trace).toEqual([true, false]);
    expect(error).toHaveBeenCalledWith('debug overlay failed to mount', expect.any(Error));
  });

  test('without debug there is no overlay and no report', async () => {
    expect(await bootReport(false, 500)).toBe('none');
    expect(h.mounts).toBe(0);
    expect(h.trace).toEqual([]);
  });
});
