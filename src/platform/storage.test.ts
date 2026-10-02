// storage.ts never throws and never rejects (issue #98, plan §4.7 "Offline guarantees"): every way
// `navigator.storage` can be missing or fail resolves to false / null instead.
import { describe, expect, it } from 'vitest';

import { createStorage, type StorageManagerLike, type StorageNavigator } from './storage.ts';

/** Every method's result, awaited together; any rejection fails the test. */
async function all(nav: StorageNavigator): Promise<[boolean, boolean | null, unknown]> {
  const s = createStorage(nav);
  return Promise.all([s.persist(), s.persisted(), s.estimate()]);
}

const boom = (): never => {
  throw new Error('boom');
};

describe('createStorage: missing APIs', () => {
  it('no navigator.storage gives false / null / null', async () => {
    expect(await all({})).toEqual([false, null, null]);
  });

  it('a storage object without the methods gives false / null / null', async () => {
    expect(await all({ storage: {} })).toEqual([false, null, null]);
  });
});

describe('createStorage: failures never escape', () => {
  it('methods that reject give false / null / null', async () => {
    const storage: StorageManagerLike = {
      persist: () => Promise.reject(new Error('persist')),
      persisted: () => Promise.reject(new Error('persisted')),
      estimate: () => Promise.reject(new Error('estimate')),
    };
    expect(await all({ storage })).toEqual([false, null, null]);
  });

  it('methods that throw synchronously give false / null / null', async () => {
    const storage: StorageManagerLike = { persist: boom, persisted: boom, estimate: boom };
    expect(await all({ storage })).toEqual([false, null, null]);
  });

  it('a navigator.storage getter that throws gives false / null / null', async () => {
    const nav: StorageNavigator = {};
    Object.defineProperty(nav, 'storage', { get: boom });
    expect(await all(nav)).toEqual([false, null, null]);
  });
});

describe('createStorage: values', () => {
  it('persist() reports what the browser granted', async () => {
    expect(await createStorage({ storage: { persist: async () => false } }).persist()).toBe(false);
    expect(await createStorage({ storage: { persist: async () => true } }).persist()).toBe(true);
  });

  it('persisted() reports the current state', async () => {
    expect(await createStorage({ storage: { persisted: async () => false } }).persisted()).toBe(false);
    expect(await createStorage({ storage: { persisted: async () => true } }).persisted()).toBe(true);
  });

  it('estimate() counts missing fields as 0 and passes bytes through', async () => {
    expect(await createStorage({ storage: { estimate: async () => ({}) } }).estimate()).toEqual({
      usage: 0,
      quota: 0,
    });
    const full = { estimate: async () => ({ usage: 2048, quota: 4096 }) };
    expect(await createStorage({ storage: full }).estimate()).toEqual({ usage: 2048, quota: 4096 });
  });

  it('calls the methods on navigator.storage itself (this is kept)', async () => {
    class FakeStorageManager implements StorageManagerLike {
      readonly granted = true;
      readonly used = 512;
      async persist(): Promise<boolean> {
        return this.granted;
      }
      async persisted(): Promise<boolean> {
        return this.granted;
      }
      async estimate(): Promise<{ usage?: number; quota?: number }> {
        return { usage: this.used, quota: this.used * 2 };
      }
    }
    expect(await all({ storage: new FakeStorageManager() })).toEqual([
      true,
      true,
      { usage: 512, quota: 1024 },
    ]);
  });
});
