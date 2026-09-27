/**
 * The app's single source of page visibility (plan §4.5, §4.9.3). Nothing else in the app reads
 * `document.visibilityState` or listens for `visibilitychange`, `pagehide`, `freeze` or `resume`:
 * everything subscribes here, so the e2e hook `simulate()` drives the whole app.
 */
export type VisEvent = 'hidden' | 'visible' | 'pagehide' | 'freeze' | 'resume';

export interface Visibility {
  current(): 'visible' | 'hidden';
  /**
   * Subscribers run synchronously inside the DOM event, in subscription order (plan §4.7 relies on it).
   * A throwing subscriber is logged, not rethrown: assert outside callbacks.
   */
  subscribe(cb: (e: VisEvent) => void): () => void;
  /** e2e only: plan §4.9.3. Emits exactly like a real event and updates current(). */
  simulate(v: 'visible' | 'hidden'): void;
}

/** The part of `Document` used here; `document` satisfies it, and Node tests pass an `EventTarget` fake. */
export type VisibilityDocument = EventTarget & Pick<Document, 'visibilityState'>;

export function createVisibility(doc: VisibilityDocument = document, win: EventTarget = window): Visibility {
  const read = (): 'visible' | 'hidden' => (doc.visibilityState === 'hidden' ? 'hidden' : 'visible');
  let state = read();
  const subs = new Set<(e: VisEvent) => void>();

  const emit = (e: VisEvent): void => {
    // Like DOM listeners: iterate a snapshot, so a subscriber added during this round waits for the
    // next event, while one removed during it is skipped. One failing subscriber doesn't starve the
    // others; its error is logged.
    for (const cb of Array.from(subs)) {
      if (!subs.has(cb)) continue;
      try {
        cb(e);
      } catch (err) {
        console.error('visibility subscriber failed', err);
      }
    }
  };
  const setState = (v: 'visible' | 'hidden'): void => {
    state = v;
    emit(v);
  };

  doc.addEventListener('visibilitychange', () => setState(read()));
  win.addEventListener('pagehide', () => emit('pagehide'));
  doc.addEventListener('freeze', () => emit('freeze'));
  doc.addEventListener('resume', () => emit('resume'));

  return {
    current: () => state,
    subscribe(cb) {
      const entry = (e: VisEvent): void => cb(e); // its own entry, so subscribing one cb twice works
      subs.add(entry);
      return () => {
        subs.delete(entry);
      };
    },
    simulate: setState,
  };
}
