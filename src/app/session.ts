// The session store (plan §3.3, §3.4): the imperative shell around the pure reducer in machine.ts. It holds the
// state, runs the dispatch loop, feeds engine, visibility and permission events in, and hands each transition's
// effects to the effect interpreter (effects.ts).
//
// Dispatch loop: events go into a FIFO queue. A dispatch made while one is running (from an effect or a
// listener) is only queued; otherwise the queue is drained, and for each event: reduce → store the new state →
// run its effects in order → onTransition (then the addTransitionListener listeners) → subscribers.
//
// Each `sfx` effect the runner schedules is reported to the `addSfxListener` listeners while it runs (so before
// that step's transition listeners), with the context time its sound ends (#93: the e2e `sfxLog`).
//
// Noise floor (#116): every engine `level` also goes to the effect runner's `level`, which dispatches at most one
// `noiseFloor` per second while Listening (effects.ts).
//
// Settings (plan §7 M8, #113): with `deps.settings`, every step reduces with `cfg.tSleepMs` taken from the
// current `sleepTimeoutSec`, so a change takes effect on the next sleep-timer start; the effect runner reads
// `noisyRoomNs` at each `openMic` (effects.ts).

import type { Engine, EngineEvent } from '../audio/engine.ts';
import type { createPlayer } from '../audio/player.ts';
import type { createSfx } from '../audio/sfx.ts';
import type { createMicPermission } from '../platform/permissions.ts';
import type { VisEvent, Visibility } from '../platform/visibility.ts';
import type { Clock } from './clock.ts';
import { createEffectRunner } from './effects.ts';
import type { Settings } from './settings.ts';
import {
  DEFAULT_CONFIG,
  type AnimEvent,
  type Effect,
  type Overlay,
  type SessionConfig,
  type SessionEvent,
  type SessionState,
  type SfxId,
  type StateName,
} from './events.ts';
import { reduce } from './machine.ts';

export type Player = ReturnType<typeof createPlayer>;
export type Sfx = ReturnType<typeof createSfx>;

export interface SessionDeps {
  engine: Engine;
  /** Factories: the runner creates the player and sfx lazily, from engine.context() and engine.masterBus(),
   *  the first time a play / sfx effect runs. stopPlayback before that is a no-op. */
  makePlayer(ctx: AudioContext, bus: AudioNode): Player;
  makeSfx(ctx: AudioContext, bus: AudioNode): Sfx;
  wakeLock: { set(on: boolean): void };
  visibility: Visibility;
  permission: ReturnType<typeof createMicPermission>;
  clock: Clock;
  /** The reducer's timings; `DEFAULT_CONFIG` by default. With `settings`, its `tSleepMs` is replaced (below). */
  cfg?: SessionConfig;
  /**
   * The current settings (main.ts: the store's `get`), read at every dispatch: the reducer's `tSleepMs` is
   * `sleepTimeoutSec × 1000`, and each `openMic` effect adds `{ noiseSuppression: true }` while `noisyRoomNs` is
   * on. Without it the session uses `cfg` as given and opens the mic with the plan §4.1.1 constraints only.
   */
  settings?(): Settings;
  onAnim?(ev: AnimEvent): void;
  /**
   * A `play{id}` effect started replay `id`, whose first sample is scheduled at context time `startCtxTime` (the
   * player's `PlayHandle.startCtxTime`). Called synchronously inside that effect, so before the `anim talk{id}`
   * that follows it in the same transition; the bear's mouth (#81) samples the envelope against it.
   */
  onPlayStarted?(id: number, startCtxTime: number): void;
  onUi?(o: Overlay): void;
  onApplyUpdate?(): void;
  onTransition?(from: StateName, to: StateName, e: SessionEvent, effects: Effect[]): void;
}

/** Engine events that never reach the reducer. */
export type LevelEvent = Extract<
  EngineEvent,
  { t: 'level' | 'vadError' | 'vadReady' | 'vadStats' | 'traceBatch' }
>;
export type TransitionListener = (from: StateName, to: StateName, e: SessionEvent, effects: Effect[]) => void;

/** An `sfx` effect the runner scheduled: `sfx.play(id)` returned `endCtxTime`, the context time its sound ends. */
export interface SfxScheduled {
  seq: number;
  id: SfxId;
  endCtxTime: number;
}

export interface Session {
  dispatch(e: SessionEvent): void;
  state(): SessionState;
  subscribe(cb: (s: SessionState) => void): () => void;
  /** Multi-listener version of onTransition (UI, test hooks). */
  addTransitionListener(cb: TransitionListener): () => void;
  /** Every `sfx` effect once scheduled, with its end on the context clock (test hooks: `sfxLog`). */
  addSfxListener(cb: (e: SfxScheduled) => void): () => void;
  /** Engine `level`, `vadError`, `vadReady`, `vadStats` and `traceBatch` events (not dispatched to the reducer). */
  subscribeLevel(cb: (e: LevelEvent) => void): () => void;
  /**
   * The engine's event sink: `level`, `vadError`, `vadReady`, `vadStats` and `traceBatch` go to the
   * `subscribeLevel` listeners (a `level` feeds the effect runner's noise floor estimate first, #116), every other
   * engine event is dispatched. `createEngine` takes its `onEvent`
   * before the session exists, so main.ts relays to it:
   *
   * ```ts
   * let session: Session | undefined;
   * const engine = createEngine({ connectWorkletOutput, onEvent: (e) => session?.onEngineEvent(e) });
   * // … visibility, wake lock, permission, permission0 …
   * session = createSession(initialSessionState(permission0), { engine, … });
   * ```
   *
   * The engine emits nothing until an effect has called it, so nothing is lost before `session` is set.
   */
  onEngineEvent(e: EngineEvent): void;
}

function safely(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`session: ${label} failed`, err);
  }
}

/** A listener set whose callbacks run in subscription order; each subscription is its own entry. */
function listenerSet<A extends unknown[]>(
  label: string,
): { add(cb: (...args: A) => void): () => void; notify(...args: A): void } {
  const entries = new Set<(...args: A) => void>();
  return {
    add(cb) {
      const entry = (...args: A): void => cb(...args);
      entries.add(entry);
      return () => {
        entries.delete(entry);
      };
    },
    notify(...args) {
      // A snapshot, like DOM listeners: one added during this round waits for the next event, and one removed
      // during it is skipped.
      for (const entry of Array.from(entries)) {
        if (entries.has(entry)) safely(label, () => entry(...args));
      }
    },
  };
}

/**
 * Creates the session store and wires it: engine events arrive through `onEngineEvent` (see there for the
 * main.ts relay), visibility `hidden` / `pagehide` / `freeze` are dispatched at once, `visible` is dispatched
 * after the permission re-query has settled, and permission changes become `permissionChanged`.
 */
export function createSession(initial: SessionState, deps: SessionDeps): Session {
  const baseCfg = deps.cfg ?? DEFAULT_CONFIG;
  /** `baseCfg` with the settings' sleep timeout, rebuilt only when that changes. */
  let cfg = baseCfg;
  let cfgSleepSec: number | null = null;
  function config(): SessionConfig {
    if (deps.settings === undefined) return baseCfg;
    const sec = deps.settings().sleepTimeoutSec;
    if (sec !== cfgSleepSec) {
      cfgSleepSec = sec;
      cfg = { ...baseCfg, tSleepMs: sec * 1000 };
    }
    return cfg;
  }
  let current = initial;
  const queue: SessionEvent[] = [];
  let draining = false;
  const transitionListeners = listenerSet<Parameters<TransitionListener>>('transition listener');
  const subscribers = listenerSet<[SessionState]>('subscriber');
  const levelListeners = listenerSet<[LevelEvent]>('level listener');
  const sfxListeners = listenerSet<[SfxScheduled]>('sfx listener');
  /** Bumped by every visibility change: a `visible` whose permission re-query settles later is dropped. */
  let visibleToken = 0;

  const runner = createEffectRunner(deps, {
    dispatch,
    state: () => current,
    sfxScheduled: (e) => sfxListeners.notify(e),
  });

  function step(e: SessionEvent): void {
    const from = current.name;
    let out: { state: SessionState; effects: Effect[] };
    try {
      out = reduce(current, e, config());
    } catch (err) {
      console.error('session: reduce failed', e, err); // the reducer is total; never drop the rest of the queue
      return;
    }
    const { state, effects } = out;
    current = state;
    for (const fx of effects) runner.run(fx);
    // A processed result the reducer did not turn into a replay (a stale id, or a late reply after the
    // processing watchdog) is never played, so nothing would release it: drop it now (plan §2).
    if (e.t === 'processed' && !effects.some((fx) => fx.k === 'play' && fx.id === e.id)) {
      safely('releaseProcessed', () => deps.engine.releaseProcessed(e.id));
    }
    safely('onTransition', () => deps.onTransition?.(from, state.name, e, effects));
    transitionListeners.notify(from, state.name, e, effects);
    subscribers.notify(state);
  }

  function dispatch(e: SessionEvent): void {
    queue.push(e);
    if (draining) return; // re-entrant: processed after the current event's effects and listeners
    draining = true;
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) step(next);
    } finally {
      draining = false;
    }
  }

  /**
   * Row 39 wakes by the permission known when `visible` arrives, and a one-time grant can expire in the
   * background (§4.5). So `visible` is dispatched only after the permission re-query has settled: the module
   * notifies (→ `permissionChanged`) before its query() promise resolves, so the reducer sees the new permission
   * first. The query starts in a microtask, after every visibility subscriber of this round (they all run inside
   * the one Visibility's DOM event), including the permission module's own re-query; ours is then the newest
   * generation whatever the subscription order, and the module discards the older result. A rejected query still dispatches `visible` (the reducer wakes by the
   * last known permission) rather than leaving the bear in Paused; a query that never settles leaves it in Paused
   * until the next hide/visible retries. A hide, or a newer `visible`, before that cancels this one.
   */
  function onVisible(): void {
    const token = ++visibleToken;
    const settle = (): void => {
      if (token === visibleToken) dispatch({ t: 'visible' });
    };
    const query = Promise.resolve().then(() =>
      token === visibleToken ? deps.permission.query() : undefined,
    );
    void query.then(settle, (err: unknown) => {
      console.error('session: permission query failed', err);
      settle();
    });
  }

  function onVisibility(v: VisEvent): void {
    switch (v) {
      case 'hidden':
      case 'pagehide':
      case 'freeze':
        visibleToken++;
        dispatch({ t: v });
        return;
      case 'visible':
        onVisible();
        return;
      case 'resume':
        return;
    }
  }

  deps.visibility.subscribe(onVisibility);
  deps.permission.subscribe((p) => dispatch({ t: 'permissionChanged', state: p }));

  return {
    dispatch,
    state: () => current,
    subscribe: (cb) => subscribers.add(cb),
    addTransitionListener: (cb) => transitionListeners.add(cb),
    addSfxListener: (cb) => sfxListeners.add(cb),
    subscribeLevel: (cb) => levelListeners.add(cb),
    onEngineEvent(e) {
      if (e.t === 'level') runner.level(e); // #116: the noise floor estimate, before the level listeners
      if (
        e.t === 'level' ||
        e.t === 'vadError' ||
        e.t === 'vadReady' ||
        e.t === 'vadStats' ||
        e.t === 'traceBatch'
      )
        levelListeners.notify(e);
      else dispatch(e);
    },
  };
}
