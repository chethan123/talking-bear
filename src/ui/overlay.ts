// The overlays (plan §4.5, §7 M1, M8; issue #115): kid-first and text-free (Q3). A child can't read, so every
// child-facing variant is an icon and the bear's body language says the rest: tap-to-wake is a pulsing paw over the
// sleeping bear, the mic-denied help a blocked-mic icon (the bear mimes a cupped ear, bear-view.ts), the mic-muted and
// too-noisy badges small icons, and the error a "tap to retry" circular arrow. The parent-permission sheet is the
// only text here (plan §4.5), and the settings sheet the only other text screen. The mic-denied help has no button:
// a child's tap never retries the mic, and retrying lives behind the settings long-press, in the sheet's "For
// parents" section (plan §4.5, #114).
//
// Hold-to-talk (#116, plan §4.4): in a room too noisy for the VAD, the session shows a large text-free paw button in
// Listening and Recording. Pressing it dispatches `holdStart{frame}` and releasing it `holdEnd{frame}`, with frames on
// the capture worklet's clock (`nowFrame`, round(ctx.currentTime · sampleRate)). Only the first pointer counts; the
// button captures it, so sliding off keeps recording, and a cancel, a lost capture or the view being hidden ends the
// hold as a release does. It is the only child-facing button; its accessible name comes with #118.
//
// CSP `style-src 'self'` and Trusted Types (plan §4.8.3): the DOM is built with createElement/createElementNS and
// textContent only, never HTML strings, and nothing sets a `style` attribute; the paw's pulse is a styles.css
// @keyframes animation that `prefers-reduced-motion: reduce` turns off. Every variant is built once at mount and
// toggled with the `hidden` attribute.

import type { Overlay, SessionEvent } from '../app/events.ts';
import { icon, type IconName } from './icons.ts';

/** The parent-permission sheet's text: the only text among the overlays (plan §4.5). */
export const OVERLAY_TEXT = {
  parentTitle: 'Before Juni can listen',
  parentLocal: 'Juni only listens on this device. Nothing you say is sent anywhere.',
  parentMicOff: 'The microphone switches off when Juni falls asleep.',
  parentContinue: 'Continue',
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

/** An icon-only variant: `tag.className` holding icon `name`, with no text. */
function iconView<K extends 'div' | 'section'>(
  tag: K,
  className: string,
  name: IconName,
): HTMLElementTagNameMap[K] {
  const el = element(tag, className);
  el.append(icon(name));
  return el;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = element('button', 'sheet-button', text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** The hold-to-talk button (#116): a paw icon, no text; pointer handling is wired by `mountOverlay`. */
function holdButton(): HTMLButtonElement {
  const b = element('button', 'overlay-hold');
  b.type = 'button';
  b.append(icon('paw'));
  return b;
}

/**
 * Mounts every overlay variant (all hidden) into `root` and returns `show`: `show(o)` makes variant `o` the only
 * visible one, and `show(null)` hides them all. The parent sheet's Continue dispatches `parentContinue`; nothing
 * here dispatches `settingsRetry` (the settings sheet does, #114). The hold button dispatches `holdStart` /
 * `holdEnd` with `nowFrame()`; while `nowFrame` returns null (no audio context) a press does nothing.
 * The icon variants are not interactive and let pointer events through to the canvas below (styles.css), so a tap
 * on the paw or the retry arrow reaches the bear. The paw, mic-help and retry icons sit at the bottom centre, over
 * the bear's body; the mic-muted and too-noisy badges at the top centre. The mic help stays a `section`. The hold
 * button (#116) takes pointer events and sits at the bottom centre too.
 */
export function mountOverlay(
  root: HTMLElement,
  dispatch: (e: SessionEvent) => void,
  nowFrame: () => number | null = () => null,
): (o: Overlay) => void {
  const layer = element('div', 'overlay');

  const parent = element('section', 'sheet');
  parent.append(
    element('h2', null, OVERLAY_TEXT.parentTitle),
    element('p', null, OVERLAY_TEXT.parentLocal),
    element('p', null, OVERLAY_TEXT.parentMicOff),
    button(OVERLAY_TEXT.parentContinue, () => dispatch({ t: 'parentContinue' })),
  );

  const views: Record<View, HTMLElement> = {
    tapToWake: iconView('div', 'overlay-icon overlay-paw', 'paw'),
    parentPermission: parent,
    micHelp: iconView('section', 'overlay-icon', 'micBlocked'),
    micMuted: iconView('div', 'overlay-badge', 'micMuted'),
    tooNoisy: iconView('div', 'overlay-badge', 'noise'),
    holdToTalk: holdButton(),
    error: iconView('div', 'overlay-icon', 'retry'),
  };

  // The hold: the pointer that pressed the button and the frame it pressed at; null while nothing is held.
  const hold = views.holdToTalk;
  let holdPointer: number | null = null;
  let holdFrame = 0;
  const endHold = (): void => {
    if (holdPointer === null) return;
    const id = holdPointer;
    holdPointer = null;
    hold.classList.remove('overlay-hold--pressed');
    try {
      if (hold.hasPointerCapture(id)) hold.releasePointerCapture(id);
    } catch {
      // A synthetic or already-gone pointer: nothing to release.
    }
    dispatch({ t: 'holdEnd', frame: nowFrame() ?? holdFrame });
  };
  hold.addEventListener('pointerdown', (e) => {
    if (holdPointer !== null || e.button !== 0) return; // the first pointer only, primary button or touch
    const frame = nowFrame();
    if (frame === null) return;
    holdPointer = e.pointerId;
    holdFrame = frame;
    try {
      hold.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer (tests) can't be captured: the hold works without capture.
    }
    hold.classList.add('overlay-hold--pressed');
    dispatch({ t: 'holdStart', frame });
  });
  const onRelease = (e: PointerEvent): void => {
    if (e.pointerId === holdPointer) endHold();
  };
  hold.addEventListener('pointerup', onRelease);
  hold.addEventListener('pointercancel', onRelease);
  hold.addEventListener('lostpointercapture', onRelease);
  hold.addEventListener('contextmenu', (e) => e.preventDefault()); // a long press must not open a menu
  const all = Object.values(views);
  for (const view of all) {
    view.hidden = true;
    layer.append(view);
  }
  root.append(layer);

  return (o) => {
    // Hiding the button mid-hold (Recording ended, the page hid) ends the hold: its release would never arrive.
    if (o !== 'holdToTalk') endHold();
    const shown = o === null ? null : views[o];
    for (const view of all) view.hidden = view !== shown;
  };
}
