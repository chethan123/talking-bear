import fc from 'fast-check';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { PRESETS, type VoicePreset } from '../dsp/types.ts';
import {
  createSettingsStore,
  CUSTOM_PITCH_MAX,
  CUSTOM_PITCH_MIN,
  DEFAULT_SETTINGS,
  parseSettings,
  presetFor,
  SETTINGS_KEY,
  SLEEP_TIMEOUT_MAX_SEC,
  SLEEP_TIMEOUT_MIN_SEC,
  voiceKey,
  type CharacterId,
  type Settings,
} from './settings.ts';

const VOICES = ['cub', 'chipmunk', 'bigbear', 'duck', 'custom'] as const;
const CHARACTERS = ['juni', 'fenn'] as const;
const KEYS = [
  'voice',
  'fennVoice',
  'character',
  'customPitch',
  'quietMode',
  'gentleMode',
  'haptics',
  'noisyRoomNs',
  'sleepTimeoutSec',
];

/** A complete, valid `Settings` (the invariant `parseSettings` guarantees). */
function expectValid(s: Settings): void {
  expect(Object.keys(s).toSorted()).toEqual([...KEYS].toSorted());
  expect(VOICES).toContain(s.voice);
  expect(VOICES).toContain(s.fennVoice);
  expect(CHARACTERS).toContain(s.character);
  expect(Number.isFinite(s.customPitch)).toBe(true);
  expect(s.customPitch).toBeGreaterThanOrEqual(CUSTOM_PITCH_MIN);
  expect(s.customPitch).toBeLessThanOrEqual(CUSTOM_PITCH_MAX);
  expect(Number.isInteger(s.sleepTimeoutSec)).toBe(true);
  expect(s.sleepTimeoutSec).toBeGreaterThanOrEqual(SLEEP_TIMEOUT_MIN_SEC);
  expect(s.sleepTimeoutSec).toBeLessThanOrEqual(SLEEP_TIMEOUT_MAX_SEC);
  for (const k of ['quietMode', 'gentleMode', 'haptics', 'noisyRoomNs'] as const) {
    expect(typeof s[k]).toBe('boolean');
  }
}

/** A Map-backed `getItem`/`setItem` fake that counts calls and can be told to throw. */
function fakeStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  const calls = { getItem: 0, setItem: 0 };
  const fail = { getItem: false, setItem: false };
  return {
    data,
    calls,
    fail,
    getItem(k: string): string | null {
      calls.getItem++;
      if (fail.getItem) throw new DOMException('blocked', 'SecurityError');
      return data.get(k) ?? null;
    },
    setItem(k: string, v: string): void {
      calls.setItem++;
      if (fail.setItem) throw new DOMException('full', 'QuotaExceededError');
      data.set(k, v);
    },
  };
}

/** A deliberately invalid patch (a `Record<string, unknown>` is assignable to `Partial<Settings>`). */
const invalid = (patch: Record<string, unknown>): Partial<Settings> => patch;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DEFAULT_SETTINGS', () => {
  it('are exactly the specified defaults (issue #65, plan §4.3.4, §7 M8, Q1)', () => {
    expect(DEFAULT_SETTINGS).toStrictEqual({
      voice: 'cub',
      fennVoice: 'duck',
      character: 'juni',
      customPitch: PRESETS.cub.pitchRatio,
      quietMode: true,
      gentleMode: false,
      haptics: true,
      noisyRoomNs: false,
      sleepTimeoutSec: 120,
    });
    expect(DEFAULT_SETTINGS.customPitch).toBe(1.6);
  });

  it('are frozen and valid', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expectValid(DEFAULT_SETTINGS);
  });

  it('types: voice and fennVoice are exactly the VoicePreset ids, character the CharacterIds', () => {
    expectTypeOf<Settings['voice']>().toEqualTypeOf<VoicePreset['id']>();
    expectTypeOf<Settings['fennVoice']>().toEqualTypeOf<VoicePreset['id']>();
    expectTypeOf<Settings['character']>().toEqualTypeOf<CharacterId>();
    expectTypeOf<CharacterId>().toEqualTypeOf<'juni' | 'fenn'>();
    expectTypeOf(createSettingsStore).parameter(1).toEqualTypeOf<string | undefined>();
  });
});

describe('presetFor', () => {
  it.each(['cub', 'chipmunk', 'bigbear', 'duck'] as const)(
    'returns the shared PRESETS entry for %s',
    (voice) => {
      const s: Settings = { ...DEFAULT_SETTINGS, voice, customPitch: 2.1 };
      expect(presetFor(s)).toBe(PRESETS[voice]);
    },
  );

  it("picks the active character's voice: voice for Juni, fennVoice for Fenn", () => {
    const s: Settings = { ...DEFAULT_SETTINGS, voice: 'chipmunk', fennVoice: 'bigbear' };
    expect(presetFor({ ...s, character: 'juni' })).toBe(PRESETS.chipmunk);
    expect(presetFor({ ...s, character: 'fenn' })).toBe(PRESETS.bigbear);
    expect(presetFor({ ...s, character: 'fenn', fennVoice: 'custom', customPitch: 1.3 })).toStrictEqual({
      id: 'custom',
      pitchRatio: 1.3,
    });
    expect(voiceKey('juni')).toBe('voice');
    expect(voiceKey('fenn')).toBe('fennVoice');
  });

  it('T116 acceptance 5: Fenn with the Duckling voice is PRESETS.duck', () => {
    expect(presetFor({ ...DEFAULT_SETTINGS, character: 'fenn', fennVoice: 'duck' })).toBe(PRESETS.duck);
    // Fenn's default voice is the Duckling.
    expect(presetFor({ ...DEFAULT_SETTINGS, character: 'fenn' })).toBe(PRESETS.duck);
  });

  it('returns { id: custom, pitchRatio: customPitch } for custom, as a new object', () => {
    const s: Settings = { ...DEFAULT_SETTINGS, voice: 'custom', customPitch: 1.85 };
    const p = presetFor(s);
    expect(p).toStrictEqual({ id: 'custom', pitchRatio: 1.85 });
    expect(presetFor(s)).not.toBe(p);
  });

  it('of the defaults is Bear cub', () => {
    expect(presetFor(DEFAULT_SETTINGS)).toBe(PRESETS.cub);
  });
});

describe('parseSettings', () => {
  it.each([null, undefined, 'a string', '{"voice":"chipmunk"}', 42, true, Symbol('s'), 10n, () => 1])(
    'gives the defaults for the non-object %s',
    (raw) => {
      const s = parseSettings(raw);
      expect(s).toStrictEqual(DEFAULT_SETTINGS);
      expect(s).not.toBe(DEFAULT_SETTINGS);
      expect(Object.isFrozen(s)).toBe(false);
    },
  );

  it('gives the defaults for {} and []', () => {
    expect(parseSettings({})).toStrictEqual(DEFAULT_SETTINGS);
    expect(parseSettings([])).toStrictEqual(DEFAULT_SETTINGS);
  });

  it('repairs the issue #65 garbage: bad voice → default, numbers clamped', () => {
    expect(parseSettings({ voice: 'x', customPitch: 99, sleepTimeoutSec: -5 })).toStrictEqual({
      ...DEFAULT_SETTINGS,
      customPitch: CUSTOM_PITCH_MAX,
      sleepTimeoutSec: SLEEP_TIMEOUT_MIN_SEC,
    });
  });

  it('clamps numbers to their ranges, inclusive', () => {
    expect(parseSettings({ customPitch: 0.1, sleepTimeoutSec: 99999 })).toMatchObject({
      customPitch: 0.7,
      sleepTimeoutSec: 600,
    });
    expect(parseSettings({ customPitch: -3, sleepTimeoutSec: 0 })).toMatchObject({
      customPitch: 0.7,
      sleepTimeoutSec: 60,
    });
    expect(parseSettings({ customPitch: 0.7, sleepTimeoutSec: 60 })).toMatchObject({
      customPitch: 0.7,
      sleepTimeoutSec: 60,
    });
    expect(parseSettings({ customPitch: 2.2, sleepTimeoutSec: 600 })).toMatchObject({
      customPitch: 2.2,
      sleepTimeoutSec: 600,
    });
  });

  it('gives the default for NaN and ±Infinity (not the range edge)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(parseSettings({ customPitch: bad, sleepTimeoutSec: bad })).toStrictEqual(DEFAULT_SETTINGS);
    }
  });

  it('rounds sleepTimeoutSec to whole seconds (after clamping)', () => {
    expect(parseSettings({ sleepTimeoutSec: 90.4 }).sleepTimeoutSec).toBe(90);
    expect(parseSettings({ sleepTimeoutSec: 90.5 }).sleepTimeoutSec).toBe(91);
    expect(parseSettings({ sleepTimeoutSec: 59.6 }).sleepTimeoutSec).toBe(60);
    expect(parseSettings({ sleepTimeoutSec: 600.4 }).sleepTimeoutSec).toBe(600);
  });

  it('keeps customPitch unrounded', () => {
    expect(parseSettings({ customPitch: 1.234 }).customPitch).toBe(1.234);
  });

  it('accepts every valid value', () => {
    for (const voice of VOICES) {
      expect(parseSettings({ voice }).voice).toBe(voice);
      expect(parseSettings({ fennVoice: voice }).fennVoice).toBe(voice);
    }
    for (const character of CHARACTERS) expect(parseSettings({ character }).character).toBe(character);
    const all: Settings = {
      voice: 'bigbear',
      fennVoice: 'chipmunk',
      character: 'fenn',
      customPitch: 0.95,
      quietMode: false,
      gentleMode: true,
      haptics: false,
      noisyRoomNs: true,
      sleepTimeoutSec: 300,
    };
    expect(parseSettings(all)).toStrictEqual(all);
  });

  it('does not coerce wrongly typed values: they take the defaults', () => {
    expect(
      parseSettings({
        voice: ['cub'],
        fennVoice: ['duck'],
        character: ['fenn'],
        customPitch: '1.8',
        quietMode: 'false',
        gentleMode: 1,
        haptics: 0,
        noisyRoomNs: 'true',
        sleepTimeoutSec: '300',
      }),
    ).toStrictEqual(DEFAULT_SETTINGS);
  });

  it('rejects inherited names as voices', () => {
    for (const voice of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'CUB', ' cub']) {
      expect(parseSettings({ voice }).voice).toBe('cub');
      expect(parseSettings({ fennVoice: voice }).fennVoice).toBe('duck');
    }
  });

  it('T116 acceptance 5: a stored v1 object without the new keys parses to their defaults', () => {
    expect(parseSettings({ voice: 'chipmunk' })).toStrictEqual({
      ...DEFAULT_SETTINGS,
      voice: 'chipmunk',
      character: 'juni',
      fennVoice: 'duck',
    });
  });

  it('T116 acceptance 5: an invalid character or fennVoice takes the default', () => {
    for (const character of [
      'bear',
      'Juni',
      'FENN',
      '',
      'toString',
      1,
      true,
      null,
      ['fenn'],
      { id: 'fenn' },
    ]) {
      expect(parseSettings({ character }).character).toBe('juni');
    }
    for (const fennVoice of ['quack', 'Duck', 'juni', 1, null, ['duck']]) {
      expect(parseSettings({ fennVoice }).fennVoice).toBe('duck');
    }
    expect(parseSettings({ character: 'robot', fennVoice: 'chipmunk' })).toStrictEqual({
      ...DEFAULT_SETTINGS,
      fennVoice: 'chipmunk',
    });
  });

  it('drops unknown keys', () => {
    const s = parseSettings({ voice: 'chipmunk', extra: 1, volume: 11 });
    expect(Object.keys(s).toSorted()).toEqual([...KEYS].toSorted());
    expect(s).toStrictEqual({ ...DEFAULT_SETTINGS, voice: 'chipmunk' });
  });

  it('reads own properties only: inherited values and a JSON __proto__ key are ignored', () => {
    const inherited = { __proto__: { haptics: false, voice: 'bigbear' }, voice: 'chipmunk' };
    expect(Object.getPrototypeOf(inherited)).toMatchObject({ haptics: false });
    expect(parseSettings(inherited)).toStrictEqual({ ...DEFAULT_SETTINGS, voice: 'chipmunk' });
    const json: unknown = JSON.parse('{"__proto__":{"quietMode":false},"gentleMode":true}');
    expect(parseSettings(json)).toStrictEqual({ ...DEFAULT_SETTINGS, gentleMode: true });
  });

  it('never throws on hostile objects, and never runs getters: accessors, throwing proxies, revoked proxies', () => {
    const throwing = Object.defineProperty({ haptics: false }, 'voice', {
      enumerable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    expect(parseSettings(throwing)).toStrictEqual({ ...DEFAULT_SETTINGS, haptics: false });

    const get = vi.fn(() => 'chipmunk');
    const accessor = Object.defineProperty({}, 'voice', { enumerable: true, get });
    expect(parseSettings(accessor)).toStrictEqual(DEFAULT_SETTINGS);
    expect(get).not.toHaveBeenCalled();

    const trap = new Proxy(
      { voice: 'chipmunk' },
      {
        get(): never {
          throw new Error('get trap');
        },
        getOwnPropertyDescriptor(): never {
          throw new Error('descriptor trap');
        },
      },
    );
    expect(parseSettings(trap)).toStrictEqual(DEFAULT_SETTINGS);

    const { proxy, revoke } = Proxy.revocable({ voice: 'chipmunk' }, {});
    revoke();
    expect(parseSettings(proxy)).toStrictEqual(DEFAULT_SETTINGS);
  });

  it('property: any input gives valid settings, and parsing is idempotent', () => {
    const field = fc.oneof(
      fc.anything(),
      fc.double(),
      fc.integer({ min: -1000, max: 1000 }),
      fc.boolean(),
      fc.constantFrom(...VOICES),
      fc.constantFrom(...CHARACTERS),
    );
    const record = fc.record(
      {
        voice: field,
        fennVoice: field,
        character: field,
        customPitch: field,
        quietMode: field,
        gentleMode: field,
        haptics: field,
        noisyRoomNs: field,
        sleepTimeoutSec: field,
        junk: fc.anything(),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(fc.oneof(fc.anything(), record), (raw) => {
        const s = parseSettings(raw);
        expectValid(s);
        expect(parseSettings(s)).toStrictEqual(s);
      }),
      { numRuns: 500 },
    );
  });

  it('property: valid settings pass through unchanged', () => {
    const valid = fc.record({
      voice: fc.constantFrom(...VOICES),
      fennVoice: fc.constantFrom(...VOICES),
      character: fc.constantFrom(...CHARACTERS),
      customPitch: fc.double({ min: CUSTOM_PITCH_MIN, max: CUSTOM_PITCH_MAX, noNaN: true }),
      quietMode: fc.boolean(),
      gentleMode: fc.boolean(),
      haptics: fc.boolean(),
      noisyRoomNs: fc.boolean(),
      sleepTimeoutSec: fc.integer({ min: SLEEP_TIMEOUT_MIN_SEC, max: SLEEP_TIMEOUT_MAX_SEC }),
    });
    fc.assert(
      fc.property(valid, (s) => {
        expect(parseSettings(s)).toStrictEqual({ ...s }); // fc.record may build null-prototype objects
      }),
      { numRuns: 300 },
    );
  });
});

describe('createSettingsStore: loading', () => {
  it('starts with the defaults when nothing is stored, and loading never writes', () => {
    const st = fakeStorage();
    const store = createSettingsStore(st);
    expect(store.get()).toStrictEqual(DEFAULT_SETTINGS);
    expect(st.calls).toEqual({ getItem: 1, setItem: 0 });
  });

  it('works with storage = null', () => {
    const store = createSettingsStore(null);
    expect(store.get()).toStrictEqual(DEFAULT_SETTINGS);
    const seen: Settings[] = [];
    store.subscribe((s) => seen.push(s));
    store.set({ voice: 'chipmunk' });
    expect(store.get().voice).toBe('chipmunk');
    expect(seen).toEqual([store.get()]);
  });

  it('reads and validates what is stored under the default key', () => {
    expect(SETTINGS_KEY).toBe('bear.settings.v1');
    const st = fakeStorage({
      [SETTINGS_KEY]: JSON.stringify({ voice: 'bigbear', customPitch: 9, quietMode: false, extra: 1 }),
    });
    const store = createSettingsStore(st);
    expect(store.get()).toStrictEqual({
      ...DEFAULT_SETTINGS,
      voice: 'bigbear',
      customPitch: 2.2,
      quietMode: false,
    });
    expect(st.calls.setItem).toBe(0);
  });

  it('uses the given key', () => {
    const st = fakeStorage({ other: '{"voice":"chipmunk"}', [SETTINGS_KEY]: '{"voice":"bigbear"}' });
    const store = createSettingsStore(st, 'other');
    expect(store.get().voice).toBe('chipmunk');
    store.set({ haptics: false });
    expect(JSON.parse(st.data.get('other') ?? 'null')).toMatchObject({ voice: 'chipmunk', haptics: false });
    expect(st.data.get(SETTINGS_KEY)).toBe('{"voice":"bigbear"}');
  });

  it.each(['not json', '', '{"voice":', 'null', '"cub"', '[1,2]', '42'])(
    'gives the defaults for stored %j, and still persists the next set',
    (text) => {
      const st = fakeStorage({ [SETTINGS_KEY]: text });
      const store = createSettingsStore(st);
      expect(store.get()).toStrictEqual(DEFAULT_SETTINGS);
      store.set({ voice: 'chipmunk' });
      expect(st.calls.setItem).toBe(1);
      expect(JSON.parse(st.data.get(SETTINGS_KEY) ?? 'null')).toStrictEqual({
        ...DEFAULT_SETTINGS,
        voice: 'chipmunk',
      });
    },
  );

  it('returns a frozen snapshot', () => {
    const store = createSettingsStore(fakeStorage());
    expect(Object.isFrozen(store.get())).toBe(true);
    expect(store.get()).toBe(store.get());
    store.set({ quietMode: false });
    expect(Object.isFrozen(store.get())).toBe(true);
  });
});

describe('createSettingsStore: storage errors', () => {
  it('getItem throws → defaults, in memory only (setItem never called), set and subscribe still work', () => {
    const st = fakeStorage({ [SETTINGS_KEY]: '{"voice":"bigbear"}' });
    st.fail.getItem = true;
    let store: ReturnType<typeof createSettingsStore> | undefined;
    expect(() => {
      store = createSettingsStore(st);
    }).not.toThrow();
    if (!store) throw new Error('no store');
    expect(store.get()).toStrictEqual(DEFAULT_SETTINGS);
    const cb = vi.fn();
    store.subscribe(cb);
    store.set({ voice: 'chipmunk', quietMode: false });
    expect(store.get()).toStrictEqual({ ...DEFAULT_SETTINGS, voice: 'chipmunk', quietMode: false });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(store.get());
    expect(st.calls.setItem).toBe(0);
    expect(st.data.get(SETTINGS_KEY)).toBe('{"voice":"bigbear"}');
  });

  it('setItem throws → set does not throw, updates memory and notifies; later sets stay in memory', () => {
    const st = fakeStorage();
    st.fail.setItem = true;
    const store = createSettingsStore(st);
    const cb = vi.fn();
    store.subscribe(cb);
    expect(() => store.set({ voice: 'bigbear' })).not.toThrow();
    expect(store.get().voice).toBe('bigbear');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith(store.get());
    expect(st.calls.setItem).toBe(1);

    st.fail.setItem = false; // storage recovers, but the store has latched to in-memory
    store.set({ haptics: false });
    expect(store.get()).toMatchObject({ voice: 'bigbear', haptics: false });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(st.calls.setItem).toBe(1);
    expect(st.data.size).toBe(0);
  });
});

describe('createSettingsStore: set', () => {
  it('merges the patch and keeps the rest', () => {
    const store = createSettingsStore(fakeStorage());
    store.set({ voice: 'custom', customPitch: 1.9 });
    store.set({ sleepTimeoutSec: 300 });
    expect(store.get()).toStrictEqual({
      ...DEFAULT_SETTINGS,
      voice: 'custom',
      customPitch: 1.9,
      sleepTimeoutSec: 300,
    });
  });

  it('validates through parseSettings: invalid values become defaults, numbers are clamped', () => {
    const store = createSettingsStore(fakeStorage());
    store.set({ voice: 'chipmunk', customPitch: 1.2, sleepTimeoutSec: 300, haptics: false });
    store.set(invalid({ voice: 'x', customPitch: 99, sleepTimeoutSec: -5, haptics: 'no', extra: 1 }));
    expect(store.get()).toStrictEqual({
      ...DEFAULT_SETTINGS,
      customPitch: CUSTOM_PITCH_MAX,
      sleepTimeoutSec: SLEEP_TIMEOUT_MIN_SEC,
    });
    store.set({ customPitch: Number.NaN });
    expect(store.get().customPitch).toBe(DEFAULT_SETTINGS.customPitch);
  });

  it('treats undefined patch values as absent', () => {
    const store = createSettingsStore(fakeStorage());
    store.set({ voice: 'bigbear', quietMode: false });
    store.set({ voice: undefined, quietMode: undefined, haptics: false });
    expect(store.get()).toMatchObject({ voice: 'bigbear', quietMode: false, haptics: false });
  });

  it('never throws on a hostile patch, and never runs its getters', () => {
    const store = createSettingsStore(fakeStorage());
    store.set({ voice: 'bigbear' });
    const patch = Object.defineProperty({ haptics: false }, 'voice', {
      enumerable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    expect(() => store.set(patch)).not.toThrow();
    expect(store.get()).toStrictEqual({ ...DEFAULT_SETTINGS, voice: 'bigbear', haptics: false });
  });

  it('property: set(patch) is parseSettings({ ...before, ...defined keys of patch })', () => {
    const value = fc.oneof(
      fc.constant(undefined),
      fc.anything(),
      fc.double(),
      fc.boolean(),
      fc.constantFrom(...VOICES),
      fc.constantFrom(...CHARACTERS),
    );
    const patch = fc.dictionary(fc.constantFrom(...KEYS, 'junk'), value, { noNullPrototype: true });
    fc.assert(
      fc.property(fc.array(patch, { maxLength: 6 }), (patches) => {
        const store = createSettingsStore(fakeStorage());
        for (const p of patches) {
          const before = store.get();
          const defined = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
          store.set(invalid(p));
          expect(store.get()).toStrictEqual(parseSettings({ ...before, ...defined }));
        }
      }),
      { numRuns: 300 },
    );
  });

  it('persists the validated JSON with exactly the known keys, before notifying', () => {
    const st = fakeStorage();
    const store = createSettingsStore(st);
    let storedWhenNotified: string | undefined;
    store.subscribe(() => {
      storedWhenNotified = st.data.get(SETTINGS_KEY);
    });
    store.set(invalid({ voice: 'chipmunk', junk: true }));
    const stored = st.data.get(SETTINGS_KEY);
    expect(stored).toBe(JSON.stringify(store.get()));
    expect(storedWhenNotified).toBe(stored);
    expect(JSON.parse(stored ?? 'null')).toStrictEqual(store.get()); // exactly the known keys
  });

  it('persists and notifies on every set, even without a change', () => {
    const st = fakeStorage();
    const store = createSettingsStore(st);
    const cb = vi.fn();
    store.subscribe(cb);
    store.set({});
    store.set({ voice: 'cub' });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(st.calls.setItem).toBe(2);
  });
});

describe('createSettingsStore: round trip', () => {
  it('a second store on the same storage reads back what the first one set', () => {
    const st = fakeStorage();
    const a = createSettingsStore(st);
    const want: Settings = {
      voice: 'custom',
      fennVoice: 'bigbear',
      character: 'juni',
      customPitch: 0.85,
      quietMode: false,
      gentleMode: true,
      haptics: false,
      noisyRoomNs: true,
      sleepTimeoutSec: 450,
    };
    a.set(want);
    expect(a.get()).toStrictEqual(want);
    const b = createSettingsStore(st);
    expect(b.get()).toStrictEqual(want);
    expect(presetFor(b.get())).toStrictEqual({ id: 'custom', pitchRatio: 0.85 });
  });

  it('property: any sequence of patches round-trips', () => {
    const patch = fc.record(
      {
        voice: fc.constantFrom(...VOICES),
        fennVoice: fc.constantFrom(...VOICES),
        character: fc.constantFrom(...CHARACTERS),
        customPitch: fc.double({ min: 0, max: 3, noNaN: true }),
        quietMode: fc.boolean(),
        gentleMode: fc.boolean(),
        haptics: fc.boolean(),
        noisyRoomNs: fc.boolean(),
        sleepTimeoutSec: fc.double({ min: 0, max: 1000, noNaN: true }),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(fc.array(patch, { maxLength: 8 }), (patches) => {
        const st = fakeStorage();
        const a = createSettingsStore(st);
        for (const p of patches) a.set(p);
        expectValid(a.get());
        expect(createSettingsStore(st).get()).toStrictEqual(a.get());
      }),
      { numRuns: 200 },
    );
  });
});

describe('createSettingsStore: subscribe', () => {
  it('does not call back on subscribe; calls back with the new settings on set', () => {
    const store = createSettingsStore(null);
    const cb = vi.fn();
    store.subscribe(cb);
    expect(cb).not.toHaveBeenCalled();
    store.set({ gentleMode: true });
    expect(cb).toHaveBeenCalledExactlyOnceWith(store.get());
  });

  it('unsubscribe stops calls and is idempotent', () => {
    const store = createSettingsStore(null);
    const cb = vi.fn();
    const other = vi.fn();
    const off = store.subscribe(cb);
    store.subscribe(other);
    off();
    off();
    store.set({ haptics: false });
    expect(cb).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('the same callback subscribed twice is called twice and unsubscribed independently', () => {
    const store = createSettingsStore(null);
    const cb = vi.fn();
    const off1 = store.subscribe(cb);
    store.subscribe(cb);
    store.set({ haptics: false });
    expect(cb).toHaveBeenCalledTimes(2);
    off1();
    store.set({ haptics: true });
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('a throwing subscriber is logged; the others still run and set does not throw', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createSettingsStore(fakeStorage());
    const before = vi.fn();
    const after = vi.fn();
    const err = new Error('subscriber bug');
    store.subscribe(before);
    store.subscribe(() => {
      throw err;
    });
    store.subscribe(after);
    expect(() => store.set({ quietMode: false })).not.toThrow();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('settings subscriber failed', err);
  });

  it('a subscriber added during a round waits for the next set; one removed during it is skipped', () => {
    const store = createSettingsStore(null);
    const late = vi.fn();
    const removed = vi.fn();
    let offRemoved: (() => void) | undefined;
    store.subscribe(() => {
      store.subscribe(late);
      offRemoved?.();
    });
    offRemoved = store.subscribe(removed);
    store.set({ haptics: false });
    expect(late).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });

  it('a nested set from a subscriber leaves every subscriber with the latest value last', () => {
    const store = createSettingsStore(fakeStorage());
    const seenA: Settings[] = [];
    const seenB: Settings[] = [];
    store.subscribe((s) => {
      seenA.push(s);
      if (s.voice === 'chipmunk') store.set({ voice: 'bigbear' });
    });
    store.subscribe((s) => seenB.push(s));
    store.set({ voice: 'chipmunk' });
    expect(store.get().voice).toBe('bigbear');
    expect(seenA.map((s) => s.voice)).toEqual(['chipmunk', 'bigbear']);
    expect(seenB.map((s) => s.voice)).toEqual(['bigbear']);
  });
});
