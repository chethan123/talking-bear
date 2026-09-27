import fc from 'fast-check';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { PRESETS, type VoicePreset } from '../dsp/types.ts';
import {
  CUSTOM_PITCH_MAX,
  CUSTOM_PITCH_MIN,
  DEFAULT_SETTINGS,
  parseSettings,
  presetFor,
  SLEEP_TIMEOUT_MAX_SEC,
  SLEEP_TIMEOUT_MIN_SEC,
  type Settings,
} from './settings.ts';

const VOICES = ['cub', 'chipmunk', 'bigbear', 'custom'] as const;
const KEYS = ['voice', 'customPitch', 'quietMode', 'gentleMode', 'haptics', 'noisyRoomNs', 'sleepTimeoutSec'];

/** A complete, valid `Settings` (the invariant `parseSettings` guarantees). */
function expectValid(s: Settings): void {
  expect(Object.keys(s).toSorted()).toEqual([...KEYS].toSorted());
  expect(VOICES).toContain(s.voice);
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DEFAULT_SETTINGS', () => {
  it('are exactly the specified defaults (issue #65, plan §4.3.4, §7 M8, Q1)', () => {
    expect(DEFAULT_SETTINGS).toStrictEqual({
      voice: 'cub',
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

  it('types: voice is exactly the VoicePreset ids', () => {
    expectTypeOf<Settings['voice']>().toEqualTypeOf<VoicePreset['id']>();
  });
});

describe('presetFor', () => {
  it.each(['cub', 'chipmunk', 'bigbear'] as const)('returns the shared PRESETS entry for %s', (voice) => {
    const s: Settings = { ...DEFAULT_SETTINGS, voice, customPitch: 2.1 };
    expect(presetFor(s)).toBe(PRESETS[voice]);
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
    for (const voice of VOICES) expect(parseSettings({ voice }).voice).toBe(voice);
    const all: Settings = {
      voice: 'bigbear',
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
    }
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
    );
    const record = fc.record(
      {
        voice: field,
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
