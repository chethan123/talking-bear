/**
 * Storage persistence and usage (plan §4.7 "Offline guarantees"): wrappers around `navigator.storage` that never
 * throw and never reject. Best-effort storage can be evicted under pressure, which removes the service worker
 * too, so register.ts asks for persistence after the first `offlineReady`; Chrome grants it heuristically,
 * favouring installed apps. The debug overlay shows `persisted()` and `estimate()`.
 */

/** The part of `StorageManager` used here; each method may be missing (older or non-secure contexts). */
export interface StorageManagerLike {
  persist?(): Promise<boolean>;
  persisted?(): Promise<boolean>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
}

/** The part of `Navigator` used here: `navigator` satisfies it, and `{}` is a browser without the API. */
export interface StorageNavigator {
  readonly storage?: StorageManagerLike;
}

/** Bytes used by this origin and the quota available to it. */
export interface StorageUsage {
  usage: number;
  quota: number;
}

export interface StorageApi {
  /** `navigator.storage.persist()`: true if storage is (now) persistent; false if refused, missing or failed. */
  persist(): Promise<boolean>;
  /** `navigator.storage.persisted()`; null if the API is missing or failed. */
  persisted(): Promise<boolean | null>;
  /** `navigator.storage.estimate()` in bytes (a missing field counts as 0); null if the API is missing or failed. */
  estimate(): Promise<StorageUsage | null>;
}

export function createStorage(nav: StorageNavigator): StorageApi {
  return {
    async persist() {
      try {
        return (await nav.storage?.persist?.()) === true;
      } catch {
        return false;
      }
    },
    async persisted() {
      try {
        const api = nav.storage;
        if (api?.persisted === undefined) return null;
        return await api.persisted();
      } catch {
        return null;
      }
    },
    async estimate() {
      try {
        const api = nav.storage;
        if (api?.estimate === undefined) return null;
        const e = await api.estimate();
        return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
      } catch {
        return null;
      }
    },
  };
}
