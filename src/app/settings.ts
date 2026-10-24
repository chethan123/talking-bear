// The app's single settings model (plan §7 M3, §7 M8, §4.3.5): the shape and defaults, a tolerant validator, the
// voice preset the settings select for the active character, and a store that persists to an injected `Storage` (`localStorage` in
// the app). Pure at import: no DOM or global access; `storage` is passed in by the caller.
//
// Every storage access is inside try/catch. The first exception (private mode, blocked storage,
// thumbnail capture, quota) switches the store to in-memory only for the rest of its life, as if it had
// been created with `storage = null`. Nothing here throws.

import { PRESETS, type VoiceId, type VoicePreset } from '../dsp/types.ts';

/** The characters (duck plan Q9, Q12): Juni the bear and Fenn the duckling. */
export type CharacterId = 'juni' | 'fenn';

export interface Settings {
  /**
   * Juni's voice preset; `'custom'` plays at `customPitch`. Default `'cub'` (plan §4.3.4, §7 M8). Stored v1 data
   * keeps its meaning: it always was Juni's voice.
   */
  voice: VoiceId;
  /** Fenn's voice preset, the same choices as `voice`. Default `'duck'` (duck plan Q11). */
  fennVoice: VoiceId;
  /** The character on stage. Default `'juni'`. */
  character: CharacterId;
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
/** The `localStorage` key; the version suffix changes only with an incompatible format (new keys are additive). */
export const SETTINGS_KEY = 'bear.settings.v1';

/**
 * The defaults (plan §4.3.4, §7 M8, Q1, Q3). Frozen. `customPitch` starts at the Bear cub ratio, so
 * choosing Custom first sounds like the default voice.
 */
export const DEFAULT_SETTINGS: Settings = Object.freeze<Settings>({
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

const VOICES: readonly string[] = ['cub', 'chipmunk', 'bigbear', 'duck', 'custom'] satisfies VoiceId[];
const CHARACTERS: readonly string[] = ['juni', 'fenn'] satisfies CharacterId[];

/** The settings field that holds `character`'s voice: `voice` for Juni, `fennVoice` for Fenn. */
export function voiceKey(character: CharacterId): 'voice' | 'fennVoice' {
  return character === 'fenn' ? 'fennVoice' : 'voice';
}

/**
 * The preset the settings select: the active character's voice (`voice` for Juni, `fennVoice` for Fenn), as
 * the shared `PRESETS` entry for a named voice (callers must not mutate it), or a new
 * `{ id: 'custom', pitchRatio: customPitch }` for Custom (both characters share `customPitch`).
 */
export function presetFor(s: Settings): VoicePreset {
  const voice = s[voiceKey(s.character)];
  return voice === 'custom' ? { id: 'custom', pitchRatio: s.customPitch } : PRESETS[voice];
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
const isVoice = (v: unknown): v is VoiceId => typeof v === 'string' && VOICES.includes(v);
const asVoice = (v: unknown): VoiceId | undefined => (isVoice(v) ? v : undefined);
const isCharacter = (v: unknown): v is CharacterId => typeof v === 'string' && CHARACTERS.includes(v);
const asCharacter = (v: unknown): CharacterId | undefined => (isCharacter(v) ? v : undefined);
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
    fennVoice: pick('fennVoice', asVoice),
    character: pick('character', asCharacter),
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

/** Parses the stored text; no item, or text that isn't JSON, gives the defaults. */
function parseStored(text: string | null): Settings {
  if (typeof text !== 'string') return { ...DEFAULT_SETTINGS };
  try {
    return parseSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export interface SettingsStore {
  /** The current settings: a frozen snapshot, replaced (never mutated) by `set`. */
  get(): Settings;
  /**
   * Merges `patch` into the current settings (a key that is absent or `undefined` keeps its value),
   * validates the result with `parseSettings` (an invalid value becomes its default, a number is
   * clamped), persists it as JSON, then notifies every subscriber, even when nothing changed.
   */
  set(patch: Partial<Settings>): void;
  /**
   * Calls `cb` with the new settings after every `set` (not immediately: read `get()` for the current
   * value). Returns an idempotent unsubscribe. Like DOM listeners, a round iterates a snapshot: a
   * subscriber added during it waits for the next `set`, one removed during it is skipped. A throwing
   * subscriber is logged, not rethrown, and the others still run. If a subscriber calls `set`, that
   * nested `set` notifies everyone with the newer value and the outer round stops, so every
   * subscriber's last value is the current one. A subscriber must not call `set` unconditionally:
   * every `set` notifies, so that would recurse until the stack overflows.
   */
  subscribe(cb: (s: Settings) => void): () => void;
}

export function createSettingsStore(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  key = SETTINGS_KEY,
): SettingsStore {
  let backend = storage; // null once any access has thrown: in-memory only from then on
  let text: string | null = null;
  if (backend !== null) {
    try {
      text = backend.getItem(key);
    } catch {
      backend = null;
    }
  }
  let current: Settings = Object.freeze(parseStored(text));
  let version = 0; // bumped by every set; a round that sees a newer version stops
  const subs = new Set<(s: Settings) => void>();

  return {
    get: () => current,
    set(patch) {
      const next = Object.freeze(merge(current, patch));
      current = next;
      const mine = ++version;
      if (backend !== null) {
        try {
          backend.setItem(key, JSON.stringify(next));
        } catch {
          backend = null;
        }
      }
      for (const cb of Array.from(subs)) {
        if (version !== mine) break; // a subscriber's set already notified everyone with a newer value
        if (!subs.has(cb)) continue; // unsubscribed during this round
        try {
          cb(next);
        } catch (err) {
          console.error('settings subscriber failed', err);
        }
      }
    },
    subscribe(cb) {
      const entry = (s: Settings): void => cb(s); // its own entry, so subscribing one cb twice works
      subs.add(entry);
      return () => {
        subs.delete(entry);
      };
    },
  };
}
