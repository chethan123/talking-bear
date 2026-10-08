/// <reference types="@vitest/browser-playwright" />
// Browser Mode tests for the overlays (overlay.ts, plan §7 M8, issue #115): the child-facing variants are icons only,
// the parent sheet keeps its text, every button is a ≥ 48 × 48 target, nothing has a style attribute, and the paw
// pulses at 1 Hz except under reduced motion. styles.css is imported: the sizes and the pulse come from it.
// The canvas stage and its input are tested with the bear in src/anim/bear-view.browser.test.ts (#81).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cdp } from 'vitest/browser';
import type { Overlay, SessionEvent } from '../app/events.ts';
import { createSettingsStore } from '../app/settings.ts';
import type { IconName } from './icons.ts';
import { LICENCES_TEXT } from './licences-screen.ts';
import { mountOverlay, OVERLAY_TEXT } from './overlay.ts';
import { mountSettingsSheet, SETTINGS_TEXT, type SheetPwa } from './settings-sheet.ts';
import './styles.css';

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  root.remove();
});

/** The child-facing variants and the icon each shows (issue #115 "Overlays"). */
const ICON_VIEWS: readonly [Exclude<Overlay, null | 'parentPermission'>, IconName][] = [
  ['tapToWake', 'paw'],
  ['micHelp', 'micBlocked'],
  ['micMuted', 'micMuted'],
  ['error', 'retry'],
  ['tooNoisy', 'noise'],
];
const ALL: readonly Overlay[] = [
  'tapToWake',
  'parentPermission',
  'micHelp',
  'micMuted',
  'tooNoisy',
  'holdToTalk',
  'error',
  null,
];
const PARENT = [
  'Before Juni can listen',
  'Juni only listens on this device. Nothing you say is sent anywhere.',
  'The microphone switches off when Juni falls asleep.',
  'Continue',
] as const;

/** The overlay layer's variants: its direct children. */
function views(): HTMLElement[] {
  const layer = root.querySelector('.overlay');
  if (layer === null) throw new Error('no overlay layer');
  return Array.from(layer.children).filter((el): el is HTMLElement => el instanceof HTMLElement);
}

/** The one visible variant. */
function visibleView(): HTMLElement {
  const shown = views().filter((v) => !v.hidden);
  expect(shown).toHaveLength(1);
  return shown[0]!;
}

/** The paw: tapToWake's pulsing element. */
function paw(): HTMLElement {
  const el = root.querySelector<HTMLElement>('.overlay-paw');
  if (el === null) throw new Error('no paw');
  return el;
}

describe('overlay.ts: kid-first, text-free (#115)', () => {
  test.each(ICON_VIEWS)('%s shows only the %s icon: no text, no button', (variant, name) => {
    const show = mountOverlay(root, vi.fn());
    show(variant);
    const view = visibleView();
    expect(view.checkVisibility()).toBe(true);
    const box = view.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(view.textContent).toBe('');
    expect(root.innerText.trim()).toBe('');
    const svgs = view.querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    expect(svgs[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(svgs[0]?.getAttribute('data-icon')).toBe(name);
    expect(svgs[0]?.checkVisibility()).toBe(true);
    expect(view.querySelector('button')).toBeNull();
  });

  test('micHelp is still a section (the settings sheet test finds the help as `.overlay section`)', () => {
    const show = mountOverlay(root, vi.fn());
    show('micHelp');
    expect(visibleView().localName).toBe('section');
  });

  test('the parent sheet still has its text: h2, two paragraphs and Continue', () => {
    const show = mountOverlay(root, vi.fn());
    show('parentPermission');
    const sheet = visibleView();
    expect(sheet.querySelector('h2')?.textContent).toBe(PARENT[0]);
    const ps = sheet.querySelectorAll('p');
    expect(ps).toHaveLength(2);
    expect(ps[0]?.textContent).toBe(PARENT[1]);
    expect(ps[1]?.textContent).toBe(PARENT[2]);
    expect(sheet.querySelector('button')?.textContent).toBe(PARENT[3]);
    expect(root.innerText).toBe(PARENT.join('\n\n'));
  });

  test("the exported texts are the parent sheet's only", () => {
    expect(OVERLAY_TEXT).toEqual({
      parentTitle: PARENT[0],
      parentLocal: PARENT[1],
      parentMicOff: PARENT[2],
      parentContinue: PARENT[3],
    });
  });

  test('Continue dispatches parentContinue', () => {
    const dispatch = vi.fn<(e: SessionEvent) => void>();
    const show = mountOverlay(root, dispatch);
    show('parentPermission');
    const button = visibleView().querySelector('button');
    expect(button?.checkVisibility()).toBe(true);
    button?.click();
    expect(dispatch.mock.calls).toEqual([[{ t: 'parentContinue' }]]);
  });

  test('micHelp has no retry: clicking anything in it, and every overlay button, never dispatches settingsRetry', () => {
    const dispatch = vi.fn<(e: SessionEvent) => void>();
    const show = mountOverlay(root, dispatch);
    show('micHelp');
    const help = visibleView();
    for (const el of [help, ...help.querySelectorAll('*')]) el.dispatchEvent(new MouseEvent('click'));
    expect(dispatch).not.toHaveBeenCalled();
    // The overlay's buttons are the parent sheet's Continue and the text-free hold-to-talk button (#116), whose
    // click dispatches nothing (it records on pointerdown / pointerup).
    const buttons = Array.from(root.querySelectorAll('button'));
    expect(buttons.map((b) => [b.className, b.textContent])).toEqual([
      ['sheet-button', OVERLAY_TEXT.parentContinue],
      ['overlay-hold', ''],
    ]);
    for (const b of buttons) b.click();
    expect(dispatch.mock.calls).toEqual([[{ t: 'parentContinue' }]]);
  });

  test('null hides every variant, and switching variants hides the previous one', () => {
    const show = mountOverlay(root, vi.fn());
    show('parentPermission');
    show('tapToWake');
    expect(visibleView()).toBe(paw());
    show(null);
    expect(root.innerText.trim()).toBe('');
    for (const el of views()) expect(el.hidden).toBe(true);
  });

  test('no element under root has a style attribute after rendering every variant', () => {
    const show = mountOverlay(root, vi.fn());
    for (const o of ALL) {
      show(o);
      expect(root.querySelectorAll('[style]').length, String(o)).toBe(0);
    }
  });

  test('every button is at least 48 × 48: the overlay, the gear, the open settings sheet and the licences view', async () => {
    const pwa: SheetPwa = {
      installAvailable: () => true,
      promptInstall: async () => {},
      updateReady: () => true,
      applyUpdate: () => {},
    };
    const show = mountOverlay(root, vi.fn());
    const sheet = mountSettingsSheet(root, {
      store: createSettingsStore(null),
      bus: { setQuiet: vi.fn() },
      state: () => 'MicDenied',
      dispatch: vi.fn(),
      pwa,
      fetch: async () => new Response('Licences.'),
    });
    expect(sheet.open()).toBe(true);
    sheet.refreshPwa();
    const measured = new Set<HTMLButtonElement>();
    const measure = (at: string): void => {
      for (const b of document.querySelectorAll('button')) {
        if (!b.checkVisibility()) continue;
        const r = b.getBoundingClientRect();
        expect(r.width, `${b.textContent} (${at})`).toBeGreaterThanOrEqual(48);
        expect(r.height, `${b.textContent} (${at})`).toBeGreaterThanOrEqual(48);
        measured.add(b);
      }
    };
    for (const o of ALL) {
      show(o);
      measure(String(o));
    }
    const licences = Array.from(root.querySelectorAll('button')).find(
      (b) => b.textContent === SETTINGS_TEXT.licences,
    );
    licences?.click();
    await vi.waitFor(() => {
      expect(root.querySelector('dialog.licences-screen pre')?.textContent).toBe('Licences.');
    });
    measure('licences');
    // The app's whole button set, every one measured: Continue, the hold-to-talk button (#116, no text), the gear,
    // the sheet's Close, retry, Install, restart and licences buttons, and the licences view's Close.
    expect(Array.from(measured, (b) => b.textContent).toSorted()).toEqual(
      [
        OVERLAY_TEXT.parentContinue,
        '',
        '⚙',
        SETTINGS_TEXT.close,
        SETTINGS_TEXT.micRetry,
        SETTINGS_TEXT.install,
        SETTINGS_TEXT.restart,
        SETTINGS_TEXT.licences,
        LICENCES_TEXT.close,
      ].toSorted(),
    );
    expect(measured.size).toBe(9);
  });
});

describe('overlay.ts: the tap-to-wake paw pulses (#115)', () => {
  test('one CSS animation, overlay-paw-pulse: scale 1 → 1.12 → 1 over 1 s, forever (1 Hz)', () => {
    const show = mountOverlay(root, vi.fn());
    show('tapToWake');
    const anims = paw().getAnimations();
    expect(anims).toHaveLength(1);
    const a = anims[0];
    if (!(a instanceof CSSAnimation)) throw new Error('not a CSS animation');
    expect(a.animationName).toBe('overlay-paw-pulse');
    const effect = a.effect;
    if (!(effect instanceof KeyframeEffect)) throw new Error('no keyframe effect');
    const timing = effect.getComputedTiming();
    expect(timing.duration).toBe(1000);
    expect(timing.iterations).toBe(Number.POSITIVE_INFINITY);
    expect(effect.getKeyframes().map((k) => [k.offset, k['transform']])).toEqual([
      [0, 'scale(1)'],
      [0.5, 'scale(1.12)'],
      [1, 'scale(1)'],
    ]);
  });

  test('under prefers-reduced-motion: reduce the paw is static: no animation, no transform', async () => {
    const show = mountOverlay(root, vi.fn());
    await cdp().send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    try {
      expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
      show('tapToWake');
      expect(paw().checkVisibility()).toBe(true);
      expect(paw().getAnimations()).toHaveLength(0);
      expect(getComputedStyle(paw()).transform).toBe('none');
    } finally {
      await cdp().send('Emulation.setEmulatedMedia', { features: [] });
    }
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
    expect(paw().getAnimations()).toHaveLength(1);
  });
});

/** A synthetic touch pointer event on `el`, as the browser would dispatch it. */
function pointer(el: Element, type: string, pointerId: number): void {
  el.dispatchEvent(new PointerEvent(type, { pointerId, pointerType: 'touch', button: 0, bubbles: true }));
}

/** The overlay with a frame clock that reads `frames` in turn (null: no context yet). */
function mountHold(frames: (number | null)[]): {
  show: (o: Overlay) => void;
  dispatch: ReturnType<typeof vi.fn<(e: SessionEvent) => void>>;
  button: HTMLButtonElement;
} {
  const dispatch = vi.fn<(e: SessionEvent) => void>();
  let i = 0;
  const show = mountOverlay(root, dispatch, () => frames[Math.min(i++, frames.length - 1)] ?? null);
  show('holdToTalk');
  const button = root.querySelector<HTMLButtonElement>('button.overlay-hold');
  if (button === null) throw new Error('no hold button');
  return { show, dispatch, button };
}

describe('overlay.ts: the hold-to-talk button (#116)', () => {
  test('a single text-free button at least 96 × 96 holding only the paw icon; it takes pointer events', () => {
    const { button } = mountHold([1]);
    expect(visibleView()).toBe(button);
    expect(button.checkVisibility()).toBe(true);
    const box = button.getBoundingClientRect();
    expect(box.width).toBeGreaterThanOrEqual(96);
    expect(box.height).toBeGreaterThanOrEqual(96);
    expect(button.textContent).toBe('');
    expect(root.innerText.trim()).toBe('');
    expect(button.childNodes).toHaveLength(1);
    const svg = button.firstChild;
    if (!(svg instanceof SVGSVGElement)) throw new Error('not an svg');
    expect(svg.getAttribute('data-icon')).toBe('paw');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelectorAll('[style]')).toHaveLength(0);
    expect(getComputedStyle(button).pointerEvents).toBe('auto');
    expect(getComputedStyle(root.querySelector('.overlay')!).pointerEvents).toBe('none');
  });

  test('pointerdown dispatches holdStart and pointerup holdEnd, at the frame clock', () => {
    const { button, dispatch } = mountHold([48_000, 96_000]);
    pointer(button, 'pointerdown', 1);
    expect(button.classList.contains('overlay-hold--pressed')).toBe(true);
    pointer(button, 'pointerup', 1);
    expect(button.classList.contains('overlay-hold--pressed')).toBe(false);
    expect(dispatch.mock.calls).toEqual([
      [{ t: 'holdStart', frame: 48_000 }],
      [{ t: 'holdEnd', frame: 96_000 }],
    ]);
  });

  test('a second pointer is ignored while the first holds; pointercancel ends the hold once', () => {
    const { button, dispatch } = mountHold([10, 20, 30, 40]);
    pointer(button, 'pointerdown', 1);
    pointer(button, 'pointerdown', 2);
    pointer(button, 'pointerup', 2);
    pointer(button, 'pointercancel', 1);
    pointer(button, 'pointerup', 1);
    pointer(button, 'lostpointercapture', 1);
    expect(dispatch.mock.calls).toEqual([[{ t: 'holdStart', frame: 10 }], [{ t: 'holdEnd', frame: 20 }]]);
  });

  test('without an audio context (no frame clock) a press dispatches nothing', () => {
    const { button, dispatch } = mountHold([null]);
    pointer(button, 'pointerdown', 1);
    pointer(button, 'pointerup', 1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(button.classList.contains('overlay-hold--pressed')).toBe(false);
  });

  test('hiding the button mid-hold ends the hold, so the next press starts a new one', () => {
    const { button, dispatch, show } = mountHold([100, 200, 300]);
    pointer(button, 'pointerdown', 1);
    show(null);
    show('holdToTalk');
    pointer(button, 'pointerdown', 2);
    expect(dispatch.mock.calls).toEqual([
      [{ t: 'holdStart', frame: 100 }],
      [{ t: 'holdEnd', frame: 200 }],
      [{ t: 'holdStart', frame: 300 }],
    ]);
  });

  test('a release whose frame clock vanished ends at the press frame', () => {
    const { button, dispatch } = mountHold([500, null]);
    pointer(button, 'pointerdown', 1);
    pointer(button, 'pointerup', 1);
    expect(dispatch.mock.calls).toEqual([[{ t: 'holdStart', frame: 500 }], [{ t: 'holdEnd', frame: 500 }]]);
  });
});
