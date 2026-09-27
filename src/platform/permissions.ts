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
 * Microphone permission tracking (plan §4.5): `navigator.permissions.query({name:'microphone'})`, its
 * `change` event, and a re-query on every `visible` (a one-time grant can expire in the background).
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
  let status: PermissionStatusLike | null = null;
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

  const onChange = (): void => {
    generation++;
    if (status !== null) observe(status.state);
  };

  const read = async (): Promise<MicPermissionState> => {
    if (!api) return 'prompt';
    try {
      const s = await api.query({ name: 'microphone' });
      if (status === null) {
        status = s; // one live status object is enough to hear every change
        s.addEventListener('change', onChange);
      }
      return s.state;
    } catch {
      return 'prompt';
    }
  };

  const query = async (): Promise<MicPermissionState> => {
    const mine = ++generation;
    const s = await read();
    if (mine === generation) observe(s); // skip if a newer query or change event overtook this one
    return s;
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
