/**
 * Haptics (plan §4.6.3, issue #92): plays the reactions' vibration patterns through `navigator.vibrate`, gated by
 * the `haptics` setting and by Chrome's sticky user activation.
 *
 * **Activation.** `navigator.vibrate` needs sticky activation, and for touch only `pointerup` / `touchend` grants
 * it [V R31]. Until a `noteActivation('up')`, `play` vibrates nothing: it keeps **one** pending pattern (a copy; a
 * later `play` replaces it, as a new `vibrate` call replaces a running pattern) and returns false. The next
 * `noteActivation('up')` plays it, so the very first poke vibrates on up, not down. From then on (sticky: for the
 * page's lifetime) `play` calls `vibrate` at once and returns its result. `noteActivation('down')` never activates;
 * it only records the latest activation kind for the log. The app notes `down` on every `pointerdown` and `up` on
 * every `pointerup`, never on `pointercancel` (which grants no activation): the pointer adapter's `onRawDown`, and
 * its `onRawUp` with `cancel: false` (#93).
 *
 * **Gating.** `getEnabled()` (in the app, `() => settings.get().haptics`) is read at every `play` and again when
 * the pending pattern is due: while it returns false, `vibrate` is never called, and a `play` keeps nothing
 * pending (it also drops an earlier pending pattern: the newest request, "no vibration", wins). A browser without
 * `navigator.vibrate` makes `play` return false. A throwing `vibrate` is logged and counts as false: neither method
 * ever throws (unless `getEnabled` or `log` does).
 *
 * **X-A6 log.** Each `vibrate` call logs one line with its result and the activation state:
 * `vibrate(<pattern JSON>) = <true|false>` (or `threw <error>`), then `; immediate` (from `play`) or
 * `; deferred to up` (the pending pattern, played by `noteActivation('up')`), then the state suffix
 * `; last activation: <none|down|up>; userActivation: hasBeenActive=<b> isActive=<b>` from
 * `navigator.userActivation` (`n/a` without it). A `play` kept pending logs
 * `vibrate(<pattern JSON>) not called (deferred to up)` plus the same suffix, so the first down leaves a trace too.
 * Nothing else is logged (not a disabled or unsupported `play`). The very first poke logs, at its down and its up:
 * `vibrate([12]) not called (deferred to up); last activation: down; userActivation: hasBeenActive=false …`, then
 * `vibrate([12]) = true; deferred to up; last activation: up; userActivation: hasBeenActive=true isActive=true`.
 */

/** The activation-triggering pointer events the app reports: `pointerdown` and `pointerup`. */
export type ActivationKind = 'down' | 'up';

/**
 * The parts of `Navigator` used here: `navigator` satisfies it, and `{}` is a browser without the Vibration API
 * (or without `navigator.userActivation`, which is only logged).
 */
export interface HapticsNavigator {
  vibrate?(pattern: number[]): boolean;
  readonly userActivation?: { readonly hasBeenActive: boolean; readonly isActive: boolean };
}

export interface Haptics {
  /**
   * Vibrates `pattern` (ms on, off, on, …) if haptics are enabled and supported. Returns `navigator.vibrate`'s
   * result; false when disabled, unsupported, or kept pending until the first `noteActivation('up')`.
   */
  play(pattern: number[]): boolean;
  /** Reports a `pointerdown` (`'down'`) or `pointerup` (`'up'`); the first `'up'` plays the pending pattern. */
  noteActivation(kind: ActivationKind): void;
}

export function createHaptics(
  nav: HapticsNavigator,
  getEnabled: () => boolean,
  log?: (m: string) => void,
): Haptics {
  /** An `up` has been noted: sticky activation, for the page's lifetime. */
  let activated = false;
  /** The latest noted kind; `'none'` before any (a `play` kept pending before any note logs it). */
  let last: ActivationKind | 'none' = 'none';
  /** The pattern to play on the first `up`, or null. */
  let pending: number[] | null = null;

  const ready = (): boolean => getEnabled() && typeof nav.vibrate === 'function';

  /** The activation-state suffix shared by every log line. */
  const state = (): string => {
    const ua = nav.userActivation;
    const uaText = ua ? `hasBeenActive=${ua.hasBeenActive} isActive=${ua.isActive}` : 'n/a';
    return `last activation: ${last}; userActivation: ${uaText}`;
  };

  const vibrate = (pattern: number[], how: 'immediate' | 'deferred to up'): boolean => {
    let result = false;
    let outcome: string;
    try {
      result = nav.vibrate?.(pattern) === true; // a method call: `navigator.vibrate` needs its `this`
      outcome = `= ${result}`;
    } catch (err) {
      outcome = `threw ${String(err)}`;
    }
    if (log !== undefined) log(`vibrate(${JSON.stringify(pattern)}) ${outcome}; ${how}; ${state()}`);
    return result;
  };

  return {
    play(pattern) {
      if (!ready()) {
        pending = null; // the newest request is "no vibration"
        return false;
      }
      if (!activated) {
        pending = pattern.slice();
        if (log !== undefined) {
          log(`vibrate(${JSON.stringify(pattern)}) not called (deferred to up); ${state()}`);
        }
        return false;
      }
      return vibrate(pattern, 'immediate');
    },
    noteActivation(kind) {
      last = kind;
      if (kind !== 'up') return;
      activated = true;
      const due = pending;
      if (due === null) return;
      pending = null;
      if (ready()) vibrate(due, 'deferred to up');
    },
  };
}
