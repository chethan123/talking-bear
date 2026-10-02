/// <reference types="vite-plugin-pwa/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../test/fake-clock.ts';
import type { SessionEvent } from '../app/events.ts';
import type { StorageApi } from '../platform/storage.ts';
import { createVisibility } from '../platform/visibility.ts';
import { setupPwa, UPDATE_CHECK_MS, type PwaDeps } from './register.ts';

/** A registration as register.ts uses it: only `update()`. */
interface FakeRegistration {
  update(): Promise<unknown>;
}

/** The `RegisterSWOptions` callbacks register.ts passes, as the mock hands them to the tests. */
interface Captured {
  onNeedRefresh?(): void;
  onNeedReload?(): void;
  onOfflineReady?(): void;
  onRegisteredSW?(swScriptUrl: string, registration: FakeRegistration | undefined): void;
  onRegisterError?(error: unknown): void;
}

type UpdateSW = (reloadPage?: boolean) => Promise<void>;

// `virtual:pwa-register` exists only inside a Vite build with vite-plugin-pwa. The mock records the options
// register.ts passes, so each test plays the plugin's callbacks itself, and hands back a spy as `updateSW`.
const pwa = vi.hoisted(() => {
  const state: { options: Captured[]; updateSW: UpdateSW | null } = { options: [], updateSW: null };
  return state;
});

vi.mock('virtual:pwa-register', () => ({
  registerSW: (options: Captured): UpdateSW => {
    pwa.options.push(options);
    if (pwa.updateSW === null) throw new Error('test: updateSW spy missing');
    return pwa.updateSW;
  },
}));

/** The options of the one registerSW call the current test made. */
function registered(): Captured {
  expect(pwa.options).toHaveLength(1);
  const options = pwa.options[0];
  if (options === undefined) throw new Error('test: registerSW was not called');
  return options;
}

/** The `document` stand-in for visibility.ts; register.ts itself uses the global window, navigator, location. */
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

/** A `beforeinstallprompt` as Chromium sends it: cancelable, with a one-shot `prompt()`. */
class FakeInstallPrompt extends Event {
  readonly prompt = vi.fn(async (): Promise<{ outcome: string }> => ({ outcome: 'accepted' }));
  constructor() {
    super('beforeinstallprompt', { cancelable: true });
  }
}

function setup() {
  const updateSW = vi.fn(async (_reloadPage?: boolean): Promise<void> => {});
  pwa.updateSW = updateSW;
  const win = new EventTarget();
  vi.stubGlobal('window', win);
  // The service worker container (its `controllerchange`) and the page reload, for the update's reload.
  const sw = new EventTarget();
  vi.stubGlobal('navigator', { serviceWorker: sw });
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  const visibility = createVisibility(new FakeDocument(), new EventTarget());
  const clock = new FakeClock();
  const events: SessionEvent[] = [];
  const installAvailable: boolean[] = [];
  const storage = {
    persist: vi.fn(async () => true),
    persisted: vi.fn(async () => true),
    estimate: vi.fn(async () => ({ usage: 0, quota: 0 })),
  } satisfies StorageApi;
  const deps: PwaDeps = {
    dispatch: (e) => events.push(e),
    visibility,
    clock,
    storage,
    onInstallAvailable: (a) => installAvailable.push(a),
  };
  const api = setupPwa(deps);
  const update = vi.fn(async (): Promise<void> => {});
  const reg: FakeRegistration = { update };
  return {
    api,
    updateSW,
    win,
    sw,
    reload,
    visibility,
    clock,
    events,
    installAvailable,
    storage,
    reg,
    update,
  };
}

beforeEach(() => {
  pwa.options.length = 0;
  pwa.updateSW = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('setupPwa: update policy', () => {
  it('applyUpdate before onNeedRefresh is a no-op', () => {
    const t = setup();
    expect(t.api.updateReady()).toBe(false);
    t.api.applyUpdate();
    expect(t.updateSW).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
  });

  it('onNeedRefresh sets updateReady and dispatches it once', () => {
    const t = setup();
    registered().onNeedRefresh?.();
    expect(t.api.updateReady()).toBe(true);
    expect(t.events).toEqual([{ t: 'updateReady' }]);
  });

  it('after onNeedRefresh, applyUpdate calls updateSW(true) synchronously', () => {
    const t = setup();
    registered().onNeedRefresh?.();
    t.api.applyUpdate();
    // No await between the call and the assertion: the session's hidden handler relies on this.
    expect(t.updateSW).toHaveBeenCalledTimes(1);
    expect(t.updateSW).toHaveBeenCalledWith(true);
  });

  it('updateReady stays true after applyUpdate: the waiting worker remains until the reload', () => {
    const t = setup();
    registered().onNeedRefresh?.();
    t.api.applyUpdate();
    expect(t.api.updateReady()).toBe(true);
  });

  it('a hidden page never applies an update by itself: only the session effect calls applyUpdate', () => {
    const t = setup();
    registered().onNeedRefresh?.();
    t.visibility.simulate('hidden');
    expect(t.updateSW).not.toHaveBeenCalled();
  });

  it('a rejected updateSW is caught', async () => {
    const t = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.updateSW.mockRejectedValueOnce(new Error('boom'));
    registered().onNeedRefresh?.();
    t.api.applyUpdate();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('onOfflineReady asks for persistent storage; registering alone does not', () => {
    const t = setup();
    registered().onRegisteredSW?.('/sw.js', t.reg);
    expect(t.storage.persist).not.toHaveBeenCalled();
    registered().onOfflineReady?.();
    expect(t.storage.persist).toHaveBeenCalledTimes(1);
  });
});

describe('setupPwa: reload after an applied update', () => {
  it('a controllerchange before applyUpdate (the first clientsClaim) does not reload', () => {
    const t = setup();
    registered().onNeedRefresh?.();
    t.sw.dispatchEvent(new Event('controllerchange'));
    expect(t.reload).not.toHaveBeenCalled();
  });

  it("the plugin's own reload (onNeedReload) does nothing", () => {
    const t = setup();
    registered().onNeedRefresh?.();
    registered().onNeedReload?.();
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('after applyUpdate, the new worker taking control reloads the page exactly once', () => {
    const t = setup();
    registered().onNeedRefresh?.();
    t.api.applyUpdate();
    expect(t.reload).not.toHaveBeenCalled();
    t.sw.dispatchEvent(new Event('controllerchange'));
    expect(t.reload).toHaveBeenCalledTimes(1);
    t.sw.dispatchEvent(new Event('controllerchange'));
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('a second applyUpdate adds no second reload listener', () => {
    const t = setup();
    registered().onNeedRefresh?.();
    t.api.applyUpdate();
    t.api.applyUpdate();
    expect(t.updateSW).toHaveBeenCalledTimes(2);
    t.sw.dispatchEvent(new Event('controllerchange'));
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('applyUpdate before onNeedRefresh arms no reload', () => {
    const t = setup();
    t.api.applyUpdate();
    t.sw.dispatchEvent(new Event('controllerchange'));
    expect(t.reload).not.toHaveBeenCalled();
  });
});

describe('setupPwa: update checks', () => {
  it('visible triggers reg.update()', () => {
    const t = setup();
    registered().onRegisteredSW?.('/sw.js', t.reg);
    t.visibility.simulate('hidden');
    expect(t.update).not.toHaveBeenCalled();
    t.visibility.simulate('visible');
    expect(t.update).toHaveBeenCalledTimes(1);
    t.visibility.simulate('hidden');
    t.visibility.simulate('visible');
    expect(t.update).toHaveBeenCalledTimes(2);
  });

  it('visible before the registration exists does nothing', () => {
    const t = setup();
    t.visibility.simulate('visible');
    registered().onRegisteredSW?.('/sw.js', t.reg);
    expect(t.update).not.toHaveBeenCalled();
  });

  it('checks hourly on the injected clock, re-arming each time', () => {
    expect(UPDATE_CHECK_MS).toBe(3_600_000);
    const t = setup();
    registered().onRegisteredSW?.('/sw.js', t.reg);
    t.clock.advance(UPDATE_CHECK_MS - 1);
    expect(t.update).not.toHaveBeenCalled();
    t.clock.advance(1);
    expect(t.update).toHaveBeenCalledTimes(1);
    t.clock.advance(UPDATE_CHECK_MS);
    expect(t.update).toHaveBeenCalledTimes(2);
    expect(t.clock.pending()).toBe(1);
  });

  it('a failed update check (offline) is caught', async () => {
    const t = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.update.mockRejectedValueOnce(new TypeError('Failed to update a ServiceWorker'));
    registered().onRegisteredSW?.('/sw.js', t.reg);
    t.visibility.simulate('visible');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});

describe('setupPwa: install prompt', () => {
  it('beforeinstallprompt is prevented and stashed; promptInstall shows it once', async () => {
    const t = setup();
    const e = new FakeInstallPrompt();
    t.win.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(t.installAvailable).toEqual([true]);
    expect(e.prompt).not.toHaveBeenCalled();

    const shown = t.api.promptInstall();
    // prompt() runs synchronously inside the click that called promptInstall (user activation).
    expect(e.prompt).toHaveBeenCalledTimes(1);
    await shown;
    expect(t.installAvailable).toEqual([true, false]);

    await t.api.promptInstall(); // used up: nothing to show
    expect(e.prompt).toHaveBeenCalledTimes(1);
  });

  it('two promptInstall calls in one tick show the prompt once, used up before the first await', async () => {
    const t = setup();
    const e = new FakeInstallPrompt();
    t.win.dispatchEvent(e);
    const first = t.api.promptInstall();
    const second = t.api.promptInstall();
    expect(e.prompt).toHaveBeenCalledTimes(1);
    expect(t.installAvailable).toEqual([true, false]);
    await Promise.all([first, second]);
    expect(e.prompt).toHaveBeenCalledTimes(1);
  });

  it('a beforeinstallprompt without prompt() is still prevented, and reports nothing', () => {
    const t = setup();
    const e = new Event('beforeinstallprompt', { cancelable: true });
    t.win.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(t.installAvailable).toEqual([]);
  });

  it('promptInstall without a stashed event resolves and does nothing', async () => {
    const t = setup();
    await expect(t.api.promptInstall()).resolves.toBeUndefined();
    expect(t.installAvailable).toEqual([]);
  });

  it('a rejected prompt() is caught', async () => {
    const t = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = new FakeInstallPrompt();
    e.prompt.mockRejectedValueOnce(new DOMException('no activation', 'NotAllowedError'));
    t.win.dispatchEvent(e);
    await expect(t.api.promptInstall()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('appinstalled drops a stashed prompt', async () => {
    const t = setup();
    const e = new FakeInstallPrompt();
    t.win.dispatchEvent(e);
    t.win.dispatchEvent(new Event('appinstalled'));
    expect(t.installAvailable).toEqual([true, false]);
    await t.api.promptInstall();
    expect(e.prompt).not.toHaveBeenCalled();
  });
});
