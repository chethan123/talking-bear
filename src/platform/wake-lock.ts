import type { Visibility } from './visibility.ts';

/** The part of `WakeLockSentinel` used here. */
export interface WakeLockSentinelLike extends EventTarget {
  readonly released: boolean;
  release(): Promise<void>;
}

/** The part of `Navigator` used here: `navigator` satisfies it, and `{}` is a browser without the API. */
export interface WakeLockNavigator {
  readonly wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

/**
 * Screen Wake Lock (plan §4.5): held while wanted and the page is visible. The UA releases the lock
 * when the page is hidden, so it is re-requested on `visible` while still wanted. Failures (hidden
 * document, battery saver, Permissions-Policy) are logged, never thrown, and a browser without
 * `navigator.wakeLock` makes this a no-op.
 */
export function createWakeLock(
  nav: WakeLockNavigator,
  vis: Visibility,
  log: (...args: unknown[]) => void = console.warn,
): { set(on: boolean): void; held(): boolean } {
  const api = nav.wakeLock;
  let wanted = false;
  let pending = false; // a request is in flight
  let sentinel: WakeLockSentinelLike | null = null;

  const release = (s: WakeLockSentinelLike): void => {
    try {
      s.release().catch((err: unknown) => log('wake lock release failed', err));
    } catch (err) {
      log('wake lock release failed', err);
    }
  };

  const request = (): void => {
    if (sentinel?.released === true) sentinel = null; // released by the UA; its event may still be queued
    if (!api || !wanted || pending || sentinel !== null || vis.current() !== 'visible') return;
    pending = true;
    const onGranted = (s: WakeLockSentinelLike): void => {
      pending = false;
      if (!wanted) {
        release(s); // set(false) arrived while the request was in flight
        return;
      }
      sentinel = s;
      s.addEventListener('release', () => {
        if (sentinel === s) sentinel = null; // the UA released it (page hidden)
      });
    };
    const onRejected = (err: unknown): void => {
      pending = false;
      log('wake lock request failed', err);
    };
    try {
      api.request('screen').then(onGranted, onRejected);
    } catch (err) {
      onRejected(err);
    }
  };

  vis.subscribe((e) => {
    if (e === 'visible') request();
  });

  return {
    set(on) {
      wanted = on;
      if (on) {
        request();
      } else if (sentinel !== null) {
        const s = sentinel;
        sentinel = null;
        release(s);
      }
    },
    held: () => sentinel !== null && !sentinel.released,
  };
}
