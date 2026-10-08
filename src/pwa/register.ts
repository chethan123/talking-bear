/**
 * Service worker registration, update policy and install prompt (plan §4.5, §4.7, §3.4 row 38).
 *
 * - The service worker comes from vite-plugin-pwa (generateSW, `registerType: 'prompt'`), registered through
 *   `virtual:pwa-register`, which uses workbox-window. A new version waits until we activate it.
 * - **Update ready:** `onNeedRefresh` sets `updateReady()` and dispatches `updateReady` to the session.
 * - **Applying it:** `applyUpdate()` calls `updateSW(true)` synchronously. The session's `applyUpdate` effect
 *   calls it from the synchronous `hidden` dispatch in Asleep or Paused (row 38), after any take or playback was
 *   aborted, so nothing is cut; the settings sheet's restart calls it too. Before `onNeedRefresh` it does
 *   nothing: the new worker only exists, waiting, from then on.
 * - **Reloading:** once the new worker takes control, the page reloads, so it never runs old code against the
 *   new precache. The plugin's own reload only fires when workbox-window's `isUpdate` is true, which it fixes
 *   when it registers: a first-visit page (controlled later by `clientsClaim`) would never reload. So the
 *   plugin's reload is turned off (`onNeedReload`) and `applyUpdate()` arms a one-time `controllerchange`
 *   reload itself; the first `clientsClaim` takeover happens before that and never reloads. The reload stays
 *   armed for `RELOAD_ARM_MS` only: if SKIP_WAITING found no waiting worker, a later activation must not
 *   reload the page in whatever state it is in by then.
 * - **Another tab's update (#230):** when another tab of the app applies an update, the new worker takes
 *   control of this page too (`clientsClaim`), and its activation deleted the old precache entries. This page
 *   runs old code that loads old lazy URLs at its next wake, so it must reload too, but never mid-take: the
 *   `controllerchange` it didn't arm sets `updateReady()` and dispatches `updateReady`. A hidden page is
 *   already in Asleep or Paused, so it reloads at once; a visible one waits for the session's C11 path, which
 *   calls `applyUpdate()` at the next hide in Asleep or Paused and so reloads it (there is no waiting worker
 *   left to activate). The first `clientsClaim` takeover of an uncontrolled page (a first visit) is not an
 *   update and changes nothing.
 * - **Update checks:** a single-page app never navigates, so `reg.update()` runs on every `visible` and hourly
 *   (frozen tabs run no timers; the next `visible` catches up).
 * - **Offline:** after the first `offlineReady`, ask for persistent storage.
 * - **Install (§4.5):** `beforeinstallprompt` is prevented, so no install UI appears in front of a child; the
 *   event is kept for the settings sheet's Install button.
 */

import { registerSW } from 'virtual:pwa-register';
import type { Clock } from '../app/clock.ts';
import type { SessionEvent } from '../app/events.ts';
import type { StorageApi } from '../platform/storage.ts';
import type { Visibility } from '../platform/visibility.ts';

/** How often a page that stays open asks for a new sw.js, in ms (plan §4.7 update checks). */
export const UPDATE_CHECK_MS = 60 * 60 * 1000;

/**
 * How long `applyUpdate()`'s reload stays armed, in ms, counted from the latest `applyUpdate()` (each one sends
 * SKIP_WAITING again) (#230 Decision 1). The new worker takes control well within it; a `controllerchange`
 * after it is handled as another tab's update.
 */
export const RELOAD_ARM_MS = 10_000;

/** Chromium's non-standard `beforeinstallprompt` event (plan §4.5); it isn't in the DOM lib. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
}

function isInstallPrompt(e: Event): e is BeforeInstallPromptEvent {
  return 'prompt' in e && typeof e.prompt === 'function';
}

export interface PwaDeps {
  dispatch(e: SessionEvent): void;
  visibility: Visibility;
  clock: Clock;
  storage: StorageApi;
  /** Called with true when an install prompt becomes available, and false once it is used or the app installed. */
  onInstallAvailable(available: boolean): void;
}

export interface Pwa {
  /**
   * If an update is ready, activates it now (`updateSW(true)`); the page reloads once it takes control. If
   * another tab already activated it, reloads the page now.
   */
  applyUpdate(): void;
  /** Shows the kept install prompt, if any; never rejects. Call it from a click handler (user activation). */
  promptInstall(): Promise<void>;
  /** True once a new service worker is waiting (`onNeedRefresh`), or another tab activated one. */
  updateReady(): boolean;
}

const warn = (what: string, err: unknown): void => {
  console.warn(`pwa: ${what} failed`, err);
};

/** The `controllerchange` reload `applyUpdate()` arms: the worker it activated took control. */
const reloadOnOwnUpdate = (): void => {
  location.reload();
};

export function setupPwa(deps: PwaDeps): Pwa {
  let ready = false;
  /** `applyUpdate()`'s one-time `controllerchange` reload is attached (for `RELOAD_ARM_MS`). */
  let reloadArmed = false;
  /** The pending disarm of that reload, restarted by every `applyUpdate()`. */
  let disarmTimer: number | null = null;
  let reg: ServiceWorkerRegistration | undefined;
  let installEvent: BeforeInstallPromptEvent | null = null;
  /** Another tab activated a new version: this page runs old code until it reloads. */
  let activatedElsewhere = false;

  const updateSW = registerSW({
    onNeedRefresh() {
      ready = true;
      deps.dispatch({ t: 'updateReady' });
    },
    // The plugin reloads only when workbox-window's `isUpdate` is true, never on a first-visit page;
    // applyUpdate() arms its own reload instead, so this one stays off.
    onNeedReload() {},
    onOfflineReady() {
      void deps.storage.persist();
    },
    onRegisteredSW(_url, registration) {
      reg = registration;
    },
    onRegisterError(err: unknown) {
      warn('service worker registration', err);
    },
  });

  if ('serviceWorker' in navigator) {
    let controlled = navigator.serviceWorker.controller !== null;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!controlled) {
        controlled = true; // the first clientsClaim takeover of a first visit, not an update
        return;
      }
      if (reloadArmed) return; // our own applyUpdate(): its listener reloads
      activatedElsewhere = true;
      ready = true;
      deps.dispatch({ t: 'updateReady' }); // the session applies it at the next hide in Asleep or Paused
      // Already hidden: every hide leaves the session in Asleep or Paused (rows 5, 38, 43), so this is C11's moment.
      if (deps.visibility.current() === 'hidden') location.reload();
    });
  }

  /** Asks the browser to re-check sw.js; offline, that rejects, which is expected. */
  const check = (): void => {
    reg?.update().catch((err: unknown) => warn('update check', err));
  };

  deps.visibility.subscribe((e) => {
    if (e === 'visible') check();
  });

  const hourly = (): void => {
    check();
    deps.clock.setTimeout(hourly, UPDATE_CHECK_MS);
  };
  deps.clock.setTimeout(hourly, UPDATE_CHECK_MS);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    if (!isInstallPrompt(e)) return;
    installEvent = e;
    deps.onInstallAvailable(true);
  });
  window.addEventListener('appinstalled', () => {
    if (installEvent === null) return;
    installEvent = null;
    deps.onInstallAvailable(false);
  });

  return {
    applyUpdate() {
      if (!ready) return;
      if (activatedElsewhere) {
        location.reload(); // the new worker already controls this page; nothing is waiting
        return;
      }
      if ('serviceWorker' in navigator) {
        const container = navigator.serviceWorker;
        if (!reloadArmed) {
          reloadArmed = true;
          container.addEventListener('controllerchange', reloadOnOwnUpdate, { once: true });
        }
        // Every SKIP_WAITING gets the full window, so a retry near the deadline still reloads on its own path.
        if (disarmTimer !== null) deps.clock.clearTimeout(disarmTimer);
        disarmTimer = deps.clock.setTimeout(() => {
          container.removeEventListener('controllerchange', reloadOnOwnUpdate);
          reloadArmed = false;
          disarmTimer = null;
        }, RELOAD_ARM_MS);
      }
      updateSW(true).catch((err: unknown) => warn('update', err));
    },
    async promptInstall() {
      const e = installEvent;
      if (e === null) return;
      // An event's prompt() works once, so it's used up whatever the outcome; Chrome sends a new
      // beforeinstallprompt if the app can still be installed.
      installEvent = null;
      deps.onInstallAvailable(false);
      try {
        await e.prompt();
      } catch (err) {
        warn('install prompt', err);
      }
    },
    updateReady: () => ready,
  };
}
