// The app's single settings model (plan §7 M3, §7 M8): the shape and defaults, a tolerant validator, the
// voice preset a setting selects, and a store that persists to an injected `Storage` (`localStorage` in
// the app). Pure at import: no DOM or global access; `storage` is passed in by the caller.
//
// Every storage access is inside try/catch. The first exception (private mode, blocked storage,
// thumbnail capture, quota) switches the store to in-memory only for the rest of its life, as if it had
// been created with `storage = null`. Nothing here throws.

import { PRESETS, type VoicePreset } from '../dsp/types.ts';

export interface Settings {
  /** The voice preset; `'custom'` plays at `customPitch`. Default `'cub'` (plan §4.3.4, §7 M8). */
  voice: 'cub' | 'chipmunk' | 'bigbear' | 'custom';
  /** Pitch ratio p of the custom voice, `CUSTOM_PITCH_MIN`–`CUSTOM_PITCH_MAX` (plan §4.3.4). */
  customPitch: number;
  /** Another −6 dB on the master bus (plan §4.3.4). Default true. */
  quietMode: boolean;
  /** Reduced-motion reaction variants even without the OS setting (plan §4.6.4, M8). Default false. */
  gentleMode: boolean;
  /** Vibration on reactions (plan §4.6.3, M5). Default true. */
  haptics: boolean;
  /** Noisy-room noise-suppression toggle (plan §7 M8). Default false. */
  noisyRoomNs: boolean;
  /** Sleep after this many seconds without speech or touch (plan Q1). Default 120; a whole number 60–600. */
  sleepTimeoutSec: number;
}

export const CUSTOM_PITCH_MIN = 0.7;
export const CUSTOM_PITCH_MAX = 2.2;
export const SLEEP_TIMEOUT_MIN_SEC = 60;
export const SLEEP_TIMEOUT_MAX_SEC = 600;
/** The `localStorage` key; the version suffix changes only with an incompatible format. */
export const SETTINGS_KEY = 'bear.settings.v1';

/**
 * The defaults (plan §4.3.4, §7 M8, Q1, Q3). Frozen. `customPitch` starts at the Bear cub ratio, so
 * choosing Custom first sounds like the default voice.
 */
export const DEFAULT_SETTINGS: Settings = Object.freeze<Settings>({
  voice: 'cub',
  customPitch: PRESETS.cub.pitchRatio,
  quietMode: true,
  gentleMode: false,
  haptics: true,
  noisyRoomNs: false,
  sleepTimeoutSec: 120,
});

const VOICES: readonly string[] = ['cub', 'chipmunk', 'bigbear', 'custom'] satisfies Settings['voice'][];

/**
 * The preset a setting selects: the shared `PRESETS` entry for a named voice (callers must not mutate
 * it), or a new `{ id: 'custom', pitchRatio: customPitch }` for Custom.
 */
export function presetFor(s: Settings): VoicePreset {
  return s.voice === 'custom' ? { id: 'custom', pitchRatio: s.customPitch } : PRESETS[s.voice];
}

/**
 * The value of `o`'s own data property `k`, or `undefined` if it has none. Inherited values (a polluted
 * `Object.prototype`, an object literal's `__proto__`) and accessor properties don't count, so no foreign
 * getter ever runs; anything that throws (a proxy trap, `null`) also reads as missing.
 */
function read(o: unknown, k: keyof Settings): unknown {
  try {
    const value: unknown = Object.getOwnPropertyDescriptor(o, k)?.value;
    return value;
  } catch {
    return undefined;
  }
}

// Validators: the value (numbers clamped) if valid, else `undefined`. No coercion: `'true'` is not a
// boolean and `'1.8'` is not a number. NaN and ±Infinity are invalid, not clamped to a range edge.
const isVoice = (v: unknown): v is Settings['voice'] => typeof v === 'string' && VOICES.includes(v);
const asVoice = (v: unknown): Settings['voice'] | undefined => (isVoice(v) ? v : undefined);
const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const asNumber = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;
const asPitch = (v: unknown): number | undefined => asNumber(v, CUSTOM_PITCH_MIN, CUSTOM_PITCH_MAX);
const asSleep = (v: unknown): number | undefined => {
  const n = asNumber(v, SLEEP_TIMEOUT_MIN_SEC, SLEEP_TIMEOUT_MAX_SEC);
  return n === undefined ? undefined : Math.round(n); // whole seconds; the bounds are whole, so still in range
};

/**
 * A new `Settings`: `base` with each own key of `patch` validated in. A missing or `undefined` key keeps
 * `base`'s value, an invalid value takes the default, and numbers are clamped. Unknown keys are ignored.
 * For a valid `base` this is `parseSettings({ ...base, ...definedKeysOf(patch) })`.
 */
function merge(base: Settings, patch: unknown): Settings {
  const pick = <K extends keyof Settings>(
    k: K,
    valid: (v: unknown) => Settings[K] | undefined,
  ): Settings[K] => {
    const v = read(patch, k);
    return v === undefined ? base[k] : (valid(v) ?? DEFAULT_SETTINGS[k]);
  };
  return {
    voice: pick('voice', asVoice),
    customPitch: pick('customPitch', asPitch),
    quietMode: pick('quietMode', asBool),
    gentleMode: pick('gentleMode', asBool),
    haptics: pick('haptics', asBool),
    noisyRoomNs: pick('noisyRoomNs', asBool),
    sleepTimeoutSec: pick('sleepTimeoutSec', asSleep),
  };
}

/**
 * Validates anything into a new, complete `Settings`. Tolerant and total: unknown keys are dropped; a
 * missing, wrongly typed or non-finite value takes the default; finite numbers are clamped to their
 * range, and `sleepTimeoutSec` is rounded to whole seconds. Never throws, whatever `raw` is.
 */
export function parseSettings(raw: unknown): Settings {
  return merge(DEFAULT_SETTINGS, raw);
}
