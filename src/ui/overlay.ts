// The M1 text overlays (plan §7 M1 UI, §4.5 parent sheet): tap-to-wake, the parent-permission sheet, the
// mic-denied help, the mic-muted and too-noisy badges, and the error hint. Development text only: M8 replaces it
// with the kid-first, text-free UI.
//
// CSP `style-src 'self'` and Trusted Types (plan §4.8.3): the DOM is built with createElement/textContent only,
// never HTML strings, and nothing sets a `style` attribute. Every variant is built once at mount and toggled
// with the `hidden` attribute.

import type { Overlay, SessionEvent } from '../app/events.ts';

export const OVERLAY_TEXT = {
  tapToWake: 'Tap Juni to wake up',
  parentTitle: 'Before Juni can listen',
  parentLocal: 'Juni only listens on this device. Nothing you say is sent anywhere.',
  parentMicOff: 'The microphone switches off when Juni falls asleep.',
  parentContinue: 'Continue',
  micHelp: "Microphone is blocked. To fix it, allow the microphone for this site in Chrome's site settings.",
  micHelpRetry: 'Try again',
  micMuted: 'Mic muted',
  tooNoisy: 'Too noisy',
  error: 'Something went wrong. Tap to try again.',
} as const;

type View = Exclude<Overlay, null>;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className !== null) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = element('button', 'sheet-button', text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Mounts every overlay variant (all hidden) into `root` and returns `show`: `show(o)` makes variant `o` the only
 * visible one, and `show(null)` hides them all. The sheets' buttons dispatch `parentContinue` and `settingsRetry`.
 * The non-interactive variants let pointer events through to the canvas below (styles.css), so "Tap Juni…" and
 * "Tap to try again" reach it.
 */
export function mountOverlay(root: HTMLElement, dispatch: (e: SessionEvent) => void): (o: Overlay) => void {
  const layer = element('div', 'overlay');

  const parent = element('section', 'sheet');
  parent.append(
    element('h2', null, OVERLAY_TEXT.parentTitle),
    element('p', null, OVERLAY_TEXT.parentLocal),
    element('p', null, OVERLAY_TEXT.parentMicOff),
    button(OVERLAY_TEXT.parentContinue, () => dispatch({ t: 'parentContinue' })),
  );

  const micHelp = element('section', 'sheet');
  micHelp.append(
    element('p', null, OVERLAY_TEXT.micHelp),
    button(OVERLAY_TEXT.micHelpRetry, () => dispatch({ t: 'settingsRetry' })),
  );

  const views: Record<View, HTMLElement> = {
    tapToWake: element('p', 'overlay-hint', OVERLAY_TEXT.tapToWake),
    parentPermission: parent,
    micHelp,
    micMuted: element('p', 'badge', OVERLAY_TEXT.micMuted),
    tooNoisy: element('p', 'badge', OVERLAY_TEXT.tooNoisy),
    error: element('p', 'overlay-hint', OVERLAY_TEXT.error),
  };
  const all = Object.values(views);
  for (const view of all) {
    view.hidden = true;
    layer.append(view);
  }
  root.append(layer);

  return (o) => {
    const shown = o === null ? null : views[o];
    for (const view of all) view.hidden = view !== shown;
  };
}
