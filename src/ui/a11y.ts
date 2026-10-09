// Accessibility (plan §7 M8, issue #118): the accessible names of the child-facing overlays and the canvas, and the
// app's one aria-live region.
//
// **Self-trigger.** With TalkBack on, a spoken announcement comes out of the loudspeaker, so while the mic is armed
// it could reach the VAD. The region therefore speaks only on entering Asleep, MicDenied and Error, the states whose
// mic is closed, and is cleared on leaving them; never in Listening or Recording, never on a reaction. Paused is not
// announced (ORCH-NOTE on #118): it exists only while the page is hidden, and a message queued there would be spoken
// on return, while Waking reopens the mic.
//
// **Driven by the overlay.** `overlayFor` (app/machine.ts) shows `tapToWake` exactly in Asleep, `micHelp` exactly in
// MicDenied and `error` exactly in Error, and the session's `ui` effect fires whenever the overlay changes. So
// overlay.ts sets the region to `announcementFor(o)` on every `show(o)`: the announcement while one of those three is
// up, '' otherwise. `say` writes only when the text differs, so no awake state ever touches the region.
//
// **One region, outside main#app.** `liveRegion(doc)` finds or creates the single `div.a11y-live` at the end of
// `document.body`, outside the overlay root, so the child overlays stay text-free (Q3, #115). styles.css hides it
// visually without hiding it from assistive tech; it is never `hidden`. A new region stays empty for
// `LIVE_REGION_EXPOSE_MS` before its first text, so it is registered before the boot announcement; a clear is
// never deferred, and a held text is dropped if the state has moved on.
//
// **Icon overlays** are `role="status"` with an `aria-label` and an explicit `aria-live="off"`: `status` implies
// `aria-live="polite"`, and the mic-muted and too-noisy badges are shown in Listening, so without the explicit off
// they would be live regions there. The labels are attributes only: no text node is added to any overlay.

import type { Overlay, StateName } from '../app/events.ts';

/** The accessible names: the canvas and the child-facing overlays (their icons are `aria-hidden`). */
export const A11Y_TEXT = {
  /** The canvas stage, `role="img"`. */
  stage: 'Juni the bear',
  tapToWake: 'Tap to wake Juni',
  micHelp: 'Microphone blocked',
  micMuted: 'Microphone muted',
  tooNoisy: 'Too noisy',
  error: 'Tap to try again',
  /** The hold-to-talk button (#116). */
  holdToTalk: 'Hold to talk',
} as const;

/** What the live region says on entering each announcing state (issue #118). No other state announces. */
export const ANNOUNCEMENTS = {
  Asleep: 'Juni is asleep. Tap to wake.',
  MicDenied: 'Microphone blocked. A parent can fix this in settings.',
  Error: 'Something went wrong. Tap to try again.',
} as const satisfies Partial<Record<StateName, string>>;

/** The overlay each announcing state shows (`overlayFor`): the region speaks only while one of these is up. */
const ANNOUNCED: Readonly<Partial<Record<Exclude<Overlay, null>, string>>> = {
  tapToWake: ANNOUNCEMENTS.Asleep,
  micHelp: ANNOUNCEMENTS.MicDenied,
  error: ANNOUNCEMENTS.Error,
};

/** The live region's text while overlay `o` is shown: its state's announcement, or '' (cleared). */
export function announcementFor(o: Overlay): string {
  return o === null ? '' : (ANNOUNCED[o] ?? '');
}

/** The live region's class: styles.css hides it visually, never from assistive tech. */
export const LIVE_REGION_CLASS = 'a11y-live';
/** The attribute that marks the document's one live region. */
const LIVE_REGION_ATTR = 'data-a11y-live';

export interface LiveRegion {
  readonly element: HTMLElement;
  /**
   * Sets the region's text; writes only when it differs, so a repeated text causes no mutation. While the region is
   * new (`ready` pending) a non-empty text is held and written when it resolves, if no later `say` replaced or
   * cleared it; a clear ('') is never deferred.
   */
  say(text: string): void;
  /** Resolves once the region has been exposed (empty) for `LIVE_REGION_EXPOSE_MS` and any held text written. */
  readonly ready: Promise<void>;
}

/**
 * How long a new region stays empty before its first text (#295 review): screen readers register a polite region
 * when the empty node is exposed, so text written in the task that creates it (the boot "Juni is asleep") can go
 * unannounced. A fixed timeout, not rAF: it runs while frames are throttled or paused, and 100 ms spans several
 * rendering lifecycles and Chromium's accessibility-tree updates. Only the boot announcement waits (the mic is
 * closed then); the region is created once per document.
 */
export const LIVE_REGION_EXPOSE_MS = 100;

/** Per region: the held text while it is new, and the promise that resolves once it is exposed. */
const pending = new WeakMap<HTMLElement, string>();
const exposing = new WeakMap<HTMLElement, Promise<void>>();

/**
 * The document's one live region: the element marked `data-a11y-live`, or a new
 * `div.a11y-live[aria-live=polite][aria-atomic=true]` appended to `doc.body`, empty until `LIVE_REGION_EXPOSE_MS`
 * has passed. Every caller shares it.
 */
export function liveRegion(doc: Document = document): LiveRegion {
  let el = doc.querySelector<HTMLElement>(`[${LIVE_REGION_ATTR}]`);
  if (el === null) {
    el = doc.createElement('div');
    el.className = LIVE_REGION_CLASS;
    el.setAttribute(LIVE_REGION_ATTR, '');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    doc.body.append(el);
    const created = el;
    exposing.set(
      created,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          exposing.delete(created);
          const text = pending.get(created);
          pending.delete(created);
          // Only the latest wish is written: a `say` since then has replaced it, or a clear dropped it.
          if (text !== undefined && created.textContent !== text) created.textContent = text;
          resolve();
        }, LIVE_REGION_EXPOSE_MS);
      }),
    );
  }
  const element = el;
  return {
    element,
    say(text) {
      if (exposing.has(element) && text !== '') {
        pending.set(element, text); // held until the region is exposed
        return;
      }
      pending.delete(element);
      if (element.textContent !== text) element.textContent = text;
    },
    get ready() {
      return exposing.get(element) ?? Promise.resolve();
    },
  };
}

/** Names an icon-only overlay: `role="status"`, `aria-label`, and `aria-live="off"` so it never announces. */
export function labelStatus(el: HTMLElement, label: string): void {
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-live', 'off');
}
