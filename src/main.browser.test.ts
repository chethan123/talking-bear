// `boot(root, { debug, onDebugOverlay })` (#57, PR #260 review): the overlay's report says what actually ran, so
// lab/vad-live labels its pre-gate by the real feature-trace state, not by the URL. `boot` is tested with the
// overlay module mocked (it turns the trace on through its deps, as the real one does, and then mounts or throws);
// a module that fails to load can't be mocked in Browser Mode (a throwing factory fails the run), so that path is
// tested on `mountDebugOverlayWhenLoaded`, which `boot` hands the import to.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Session } from './app/session.ts';
import { SETTINGS_KEY, type SettingsStore } from './app/settings.ts';
import { boot, mountDebugOverlayWhenLoaded } from './main.ts';
import type { Pwa, PwaDeps } from './pwa/register.ts';
import type { DebugOverlayDeps } from './ui/debug-overlay.ts';

const h = vi.hoisted(() => ({
  /** What the mocked overlay does after turning the trace on. */
  mode: 'mount' as 'mount' | 'throw',
  mounts: 0,
  /** Every `setTrace` call on the engine the overlay got, `boot`'s own included. */
  trace: [] as boolean[],
  /** What the mocked PWA reports at boot (#277), and the deps `boot` gave it. */
  pwaReady: false,
  pwaActivated: false,
  pwaDeps: null as PwaDeps | null,
}));

// register.ts imports `virtual:pwa-register`, which exists only inside a Vite build with vite-plugin-pwa; Browser
// Mode can't even resolve it, so the whole module is replaced (no service worker in this test).
vi.mock('./pwa/register.ts', () => ({
  setupPwa: (deps: PwaDeps): Pwa => {
    h.pwaDeps = deps;
    return {
      applyUpdate: () => {},
      promptInstall: async () => {},
      updateReady: () => h.pwaReady,
      activatedElsewhere: () => h.pwaActivated,
    };
  },
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

/** Resolves with the first report, or 'none' if there is none within `waitMs`. */
function firstReport(
  start: (report: (mounted: boolean) => void) => void,
  waitMs = 3000,
): Promise<boolean | 'none'> {
  const reported = new Promise<boolean>((resolve) => start(resolve));
  const timeout = new Promise<'none'>((resolve) => setTimeout(() => resolve('none'), waitMs));
  return Promise.race([reported, timeout]);
}

/** Boots into a fresh root; resolves with `onDebugOverlay`'s argument, or 'none' if it isn't called in time. */
function bootReport(debug: boolean, waitMs = 3000): Promise<boolean | 'none'> {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  return firstReport((report) => void boot(root, { debug, onDebugOverlay: report }), waitMs);
}

afterEach(() => {
  h.mode = 'mount';
  h.mounts = 0;
  h.trace.length = 0;
  h.pwaReady = false;
  h.pwaActivated = false;
  h.pwaDeps = null;
  for (const r of roots.splice(0)) r.remove();
  localStorage.removeItem(SETTINGS_KEY); // the character tests store one
  vi.restoreAllMocks();
});

describe('boot: onDebugOverlay', () => {
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

describe('mountDebugOverlayWhenLoaded', () => {
  test('a module that failed to load (null) reports false, never mounts and leaves the trace alone', async () => {
    const mount = vi.fn();
    const trace = { setTrace: vi.fn() };
    const report = await firstReport((r) =>
      mountDebugOverlayWhenLoaded(Promise.resolve(null), mount, trace, r),
    );
    expect(report).toBe(false);
    expect(mount).not.toHaveBeenCalled();
    expect(trace.setTrace).not.toHaveBeenCalled();
  });

  test('a report that throws is logged, not left as an unhandled rejection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const trace = { setTrace: vi.fn() };
    mountDebugOverlayWhenLoaded(
      Promise.resolve({}),
      () => {},
      trace,
      () => {
        throw new Error('test: report threw');
      },
    );
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('onDebugOverlay threw', expect.any(Error)));
    expect(trace.setTrace).not.toHaveBeenCalled();
  });
});

/** Boots into a fresh root and resolves with the session once `boot` has finished. */
async function bootSession(): Promise<Session> {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  const got: { session?: Session } = {};
  await boot(root, {
    debug: false,
    onSession: (s) => {
      got.session = s;
    },
  });
  if (got.session === undefined) throw new Error('test: boot created no session');
  return got.session;
}

describe('boot: the updateReady relay (#277)', () => {
  test('an update another tab activated before the session existed is caught up with its flag', async () => {
    h.pwaReady = true;
    h.pwaActivated = true;
    const session = await bootSession();
    expect(session.state()).toMatchObject({ name: 'Asleep', updateReady: true, updateActivated: true });
  });

  test("the page's own update before the session existed is caught up without the flag", async () => {
    h.pwaReady = true;
    const session = await bootSession();
    expect(session.state()).toMatchObject({ updateReady: true, updateActivated: false });
  });

  test('a dispatch after boot reaches the session unchanged, flag included', async () => {
    const session = await bootSession();
    expect(session.state()).toMatchObject({ updateReady: false, updateActivated: false });
    const deps = h.pwaDeps;
    if (deps === null) throw new Error('test: setupPwa was not called');
    deps.dispatch({ t: 'updateReady', activated: true });
    expect(session.state()).toMatchObject({ updateReady: true, updateActivated: true });
  });
});

// The character swap's wiring (duck plan §4.3, T126). NeedsParent stands for every awake state: a tap reaches it from
// Asleep with permission `prompt` without opening the mic, and the sleep timer or a hide brings it back to Asleep, so
// the test needs neither a fake mic nor a VAD loop (which would make it an e2e spec).

/** Boots into a fresh root; resolves once `boot` has finished, with the root, the session and the settings store. */
async function bootApp(): Promise<{ root: HTMLElement; session: Session; settings: SettingsStore }> {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  const got: { session?: Session; settings?: SettingsStore } = {};
  await boot(root, {
    debug: false,
    onSession: (s) => {
      got.session = s;
    },
    onSettings: (st) => {
      got.settings = st;
    },
  });
  if (got.session === undefined || got.settings === undefined)
    throw new Error('test: boot gave no session or store');
  return { root, session: got.session, settings: got.settings };
}

/** Wakes the session from Asleep into NeedsParent (permission `prompt`: no mic). */
function wakeToNeedsParent(session: Session): void {
  session.dispatch({ t: 'permissionChanged', state: 'prompt' });
  session.dispatch({ t: 'tapBear' });
  expect(session.state().name).toBe('NeedsParent');
}

/** The stage canvas `root` holds (exactly one). */
function stageOf(root: HTMLElement): HTMLCanvasElement {
  const stages = root.querySelectorAll<HTMLCanvasElement>('canvas.stage');
  expect(stages).toHaveLength(1);
  return stages[0]!;
}

/** Counts the stage canvases added to `root` from now on: one per remount. */
function countMounts(root: HTMLElement): () => number {
  let mounts = 0;
  const count = (records: MutationRecord[]): void => {
    for (const r of records) {
      for (const n of r.addedNodes)
        if (n instanceof HTMLCanvasElement && n.classList.contains('stage')) mounts++;
    }
  };
  const observer = new MutationObserver(count);
  observer.observe(root, { childList: true });
  return () => {
    count(observer.takeRecords());
    return mounts;
  };
}

/** Spies on `Element.prototype.animate` and returns the arguments of every call made on a stage canvas. */
function stageFades(): () => unknown[][] {
  const spy = vi.spyOn(Element.prototype, 'animate');
  return () =>
    spy.mock.calls.filter((_args, i) => {
      const el: unknown = spy.mock.contexts[i];
      return el instanceof HTMLCanvasElement && el.classList.contains('stage');
    });
}

/** Pretends the page is hidden (`visibilitychange`, read by every booted app's Visibility); returns the undo. */
function hidePage(): () => void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  return () => {
    Reflect.deleteProperty(document, 'visibilityState'); // the own property: Document.prototype's getter again
    document.dispatchEvent(new Event('visibilitychange'));
  };
}

describe('boot: the swap button (T126)', () => {
  test('a click once the session has left Asleep stores nothing and keeps the voice; in Asleep it swaps', async () => {
    const { root, session, settings } = await bootApp();
    const mounts = countMounts(root);
    const button = root.querySelector<HTMLButtonElement>('button.character-switch');
    if (button === null) throw new Error('test: no swap button');
    expect(button.hidden).toBe(false);

    // A click that lands after a tap on the canvas woke the bear (the button is hidden by then).
    wakeToNeedsParent(session);
    expect(button.hidden).toBe(true);
    button.click();
    expect(settings.get().character).toBe('juni');
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull(); // nothing was written
    expect(session.state().preset.id).toBe('cub');
    expect(button.hidden).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Switch to Fenn the duckling');

    // Back in Asleep: nothing is pending, so nothing is remounted; then a click swaps.
    session.dispatch({ t: 'timer', name: 'sleep' });
    expect(session.state().name).toBe('Asleep');
    expect(mounts()).toBe(0);
    expect(stageOf(root).getAttribute('aria-label')).toBe('Juni the bear');
    expect(button.hidden).toBe(false);
    button.click();
    expect(settings.get().character).toBe('fenn');
    expect(session.state()).toMatchObject({ name: 'Asleep', preset: { id: 'duck' } });
    expect(mounts()).toBe(1);
    expect(stageOf(root).getAttribute('aria-label')).toBe('Fenn the duckling');
    expect(button.getAttribute('aria-label')).toBe('Switch to Juni the bear');
  });
});

describe('boot: a character change outside Asleep is deferred (T126, G6)', () => {
  test('no remount until the session enters Asleep, then exactly one, with the 200 ms fade', async () => {
    const { root, session, settings } = await bootApp();
    const fades = stageFades();
    const mounts = countMounts(root);
    const juniStage = stageOf(root);
    wakeToNeedsParent(session);

    settings.set({ character: 'fenn' });
    expect(session.state().preset.id).toBe('duck'); // the voice follows at once
    settings.set({ haptics: false }); // any later write re-runs applyCharacter: still deferred
    session.dispatch({ t: 'permissionChanged', state: 'prompt' }); // a step that keeps NeedsParent
    expect(session.state().name).toBe('NeedsParent');
    expect(mounts()).toBe(0);
    expect(stageOf(root)).toBe(juniStage);
    expect(juniStage.getAttribute('aria-label')).toBe('Juni the bear');

    session.dispatch({ t: 'timer', name: 'sleep' });
    expect(session.state().name).toBe('Asleep');
    expect(mounts()).toBe(1);
    const fennStage = stageOf(root);
    expect(fennStage.getAttribute('aria-label')).toBe('Fenn the duckling');
    expect(fades()).toEqual([[{ opacity: [0, 1] }, 200]]);
    expect(root.querySelector('button.character-switch')?.getAttribute('aria-label')).toBe(
      'Switch to Juni the bear',
    );

    // Nothing more is pending: another round trip remounts nothing.
    wakeToNeedsParent(session);
    session.dispatch({ t: 'timer', name: 'sleep' });
    expect(mounts()).toBe(1);
    expect(stageOf(root)).toBe(fennStage);
    expect(fades()).toHaveLength(1);
  });

  test('under reduced motion (Gentle mode) the deferred remount has no fade', async () => {
    const { root, session, settings } = await bootApp();
    settings.set({ gentleMode: true });
    const fades = stageFades();
    const mounts = countMounts(root);
    wakeToNeedsParent(session);
    settings.set({ character: 'fenn' });
    expect(mounts()).toBe(0);
    session.dispatch({ t: 'timer', name: 'sleep' });
    expect(mounts()).toBe(1);
    expect(stageOf(root).getAttribute('aria-label')).toBe('Fenn the duckling');
    expect(fades()).toEqual([]);
  });

  test('a deferred remount on a hide into Asleep has no fade', async () => {
    const { root, session, settings } = await bootApp();
    const fades = stageFades();
    const mounts = countMounts(root);
    wakeToNeedsParent(session);
    settings.set({ character: 'fenn' });
    const show = hidePage();
    try {
      expect(session.state().name).toBe('Asleep'); // row 5: NeedsParent + hidden
      expect(mounts()).toBe(1);
      expect(stageOf(root).getAttribute('aria-label')).toBe('Fenn the duckling');
      expect(fades()).toEqual([]);
    } finally {
      show();
    }
  });
});
