import type { Visibility } from './visibility.ts';

export type MicPermissionState = 'granted' | 'prompt' | 'denied';

/** The part of `PermissionStatus` used here. */
export interface PermissionStatusLike extends EventTarget {
  readonly state: MicPermissionState;
}

/** The part of `Navigator` used here: `navigator` satisfies it, and `{}` is a browser without the API. */
export interface PermissionsNavigator {
  readonly permissions?: { query(desc: { name: 'microphone' }): Promise<PermissionStatusLike> };
}

/**
 * Microphone permission tracking (plan §4.5): `navigator.permissions.query({name:'microphone'})`, the
 * `change` event of the latest status object it returned, and a re-query on every `visible` (a
 * one-time grant can expire in the background).
 * Every observed value (a query result or a change event) is compared with the previous one, and
 * subscribers hear only changes; the first observation is the baseline, so callers get the current
 * value from `query()`.
 */
export function createMicPermission(
  nav: PermissionsNavigator,
  vis: Visibility,
): {
  /** 'prompt' if the API is missing or throws. */
  query(): Promise<MicPermissionState>;
  /**
   * PermissionStatus.onchange + re-query on every 'visible'; called only when the value changes.
   * A throwing subscriber is logged, not rethrown: assert outside callbacks.
   */
  subscribe(cb: (s: MicPermissionState) => void): () => void;
} {
  const api = nav.permissions;
  const subs = new Set<(s: MicPermissionState) => void>();
  let last: MicPermissionState | null = null;
  let status: PermissionStatusLike | null = null; // the status object whose `change` events are observed
  let unwatch: (() => void) | null = null;
  let generation = 0; // bumped by every query start and change event; older query results are stale

  const observe = (s: MicPermissionState): void => {
    const changed = last !== null && s !== last;
    last = s;
    if (!changed) return;
    for (const cb of Array.from(subs)) {
      if (!subs.has(cb)) continue; // unsubscribed during this round
      try {
        cb(s);
      } catch (err) {
        console.error('permission subscriber failed', err);
      }
    }
  };

  /** Observes `change` on `s`, the latest status object, and stops observing the previous one. */
  const watch = (s: PermissionStatusLike): void => {
    unwatch?.();
    const onChange = (): void => {
      generation++;
      observe(s.state);
    };
    s.addEventListener('change', onChange);
    unwatch = () => s.removeEventListener('change', onChange);
    status = s;
  };

  const read = async (): Promise<{ state: MicPermissionState; status: PermissionStatusLike | null }> => {
    if (!api) return { state: 'prompt', status: null };
    try {
      const s = await api.query({ name: 'microphone' });
      return { state: s.state, status: s };
    } catch {
      return { state: 'prompt', status: null };
    }
  };

  const query = async (): Promise<MicPermissionState> => {
    const mine = ++generation;
    const r = await read();
    if (mine === generation) {
      // Not overtaken by a newer query or change event: follow its status object, then compare its value.
      if (r.status !== null && r.status !== status) watch(r.status);
      observe(r.state);
    }
    return r.state;
  };

  vis.subscribe((e) => {
    if (e === 'visible') void query();
  });

  return {
    query,
    subscribe(cb) {
      const entry = (s: MicPermissionState): void => cb(s);
      subs.add(entry);
      if (status === null) void query(); // attach the change listener, and set the baseline if none yet
      return () => {
        subs.delete(entry);
      };
    },
  };
}
