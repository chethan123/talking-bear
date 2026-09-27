// The session store (plan §3.3, §3.4): the imperative shell around the pure reducer in machine.ts. It holds the
// state, runs the dispatch loop, feeds engine, visibility and permission events in, and hands each transition's
// effects to the effect interpreter (effects.ts).
//
// Dispatch loop: events go into a FIFO queue. A dispatch made while one is running (from an effect or a
// listener) is only queued; otherwise the queue is drained, and for each event: reduce → store the new state →
// run its effects in order → onTransition (then the addTransitionListener listeners) → subscribers.

import type { Engine, EngineEvent } from '../audio/engine.ts';
import type { createPlayer } from '../audio/player.ts';
import type { createSfx } from '../audio/sfx.ts';
import type { createMicPermission } from '../platform/permissions.ts';
import type { VisEvent, Visibility } from '../platform/visibility.ts';
import type { Clock } from './clock.ts';
import { createEffectRunner } from './effects.ts';
import {
  DEFAULT_CONFIG,
  type AnimEvent,
  type Effect,
  type Overlay,
  type SessionConfig,
  type SessionEvent,
  type SessionState,
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
  cfg?: SessionConfig;
  onAnim?(ev: AnimEvent): void;
  onUi?(o: Overlay): void;
  onApplyUpdate?(): void;
  onTransition?(from: StateName, to: StateName, e: SessionEvent, effects: Effect[]): void;
}

/** Engine events that never reach the reducer. */
export type LevelEvent = Extract<EngineEvent, { t: 'level' | 'vadError' }>;
export type TransitionListener = (from: StateName, to: StateName, e: SessionEvent, effects: Effect[]) => void;

export interface Session {
  dispatch(e: SessionEvent): void;
  state(): SessionState;
  subscribe(cb: (s: SessionState) => void): () => void;
  /** Multi-listener version of onTransition (UI, test hooks). */
  addTransitionListener(cb: TransitionListener): () => void;
  /** Engine `level` and `vadError` events (not dispatched to the reducer). */
  subscribeLevel(cb: (e: LevelEvent) => void): () => void;
  /**
   * The engine's event sink: `level` and `vadError` go to the `subscribeLevel` listeners, every other engine
   * event is dispatched. `createEngine` takes its `onEvent` before the session exists, so main.ts relays to it:
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
  const cfg = deps.cfg ?? DEFAULT_CONFIG;
  let current = initial;
  const queue: SessionEvent[] = [];
  let draining = false;
  const transitionListeners = listenerSet<Parameters<TransitionListener>>('transition listener');
  const subscribers = listenerSet<[SessionState]>('subscriber');
  const levelListeners = listenerSet<[LevelEvent]>('level listener');
  /** Bumped by every visibility change: a `visible` whose permission re-query settles later is dropped. */
  let visibleToken = 0;

  const runner = createEffectRunner(deps, { dispatch, state: () => current });

  function step(e: SessionEvent): void {
    const from = current.name;
    let out: { state: SessionState; effects: Effect[] };
    try {
      out = reduce(current, e, cfg);
    } catch (err) {
      console.error('session: reduce failed', e, err); // the reducer is total; never drop the rest of the queue
      return;
    }
    const { state, effects } = out;
    current = state;
    for (const fx of effects) runner.run(fx);
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
   * first. The query starts in a microtask, after every visibility subscriber of this round, including the
   * permission module's own re-query; ours is then the newest generation whatever the subscription order, and
   * the module discards the older result. A rejected query still dispatches `visible` (the reducer wakes by the
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
    subscribeLevel: (cb) => levelListeners.add(cb),
    onEngineEvent(e) {
      if (e.t === 'level' || e.t === 'vadError') levelListeners.notify(e);
      else dispatch(e);
    },
  };
}
