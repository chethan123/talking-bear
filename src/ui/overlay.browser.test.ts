// Browser Mode tests for the M1 placeholder UI: the text overlays (overlay.ts) and, because Scope names only this
// test file, the canvas stage and its input (circle.ts). styles.css is deliberately not imported: the `hidden`
// attribute hides through the UA stylesheet, and the canvas keeps its intrinsic 300×150 CSS size.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Overlay, SessionEvent } from '../app/events.ts';
import { mountOverlay, OVERLAY_TEXT } from './overlay.ts';

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  root.remove();
});

/** The one visible overlay sheet under `root`. */
function visibleSheet(): HTMLElement {
  const sheets = Array.from(root.querySelectorAll<HTMLElement>('section')).filter((s) => !s.hidden);
  expect(sheets).toHaveLength(1);
  return sheets[0]!;
}

describe('overlay.ts', () => {
  const SINGLE_TEXT: readonly [Overlay, string][] = [
    ['tapToWake', 'Tap Juni to wake up'],
    ['micMuted', 'Mic muted'],
    ['tooNoisy', 'Too noisy'],
    ['error', 'Something went wrong. Tap to try again.'],
  ];
  const PARENT = [
    'Before Juni can listen',
    'Juni only listens on this device. Nothing you say is sent anywhere.',
    'The microphone switches off when Juni falls asleep.',
    'Continue',
  ] as const;
  const MIC_HELP = [
    "Microphone is blocked. To fix it, allow the microphone for this site in Chrome's site settings.",
    'Try again',
  ] as const;

  test.each(SINGLE_TEXT)('%s renders exactly its text', (variant, text) => {
    const show = mountOverlay(root, vi.fn());
    show(variant);
    expect(root.innerText).toBe(text);
  });

  test('parentPermission renders the sheet: h2, two paragraphs and Continue', () => {
    const show = mountOverlay(root, vi.fn());
    show('parentPermission');
    const sheet = visibleSheet();
    expect(sheet.querySelector('h2')?.textContent).toBe(PARENT[0]);
    const ps = sheet.querySelectorAll('p');
    expect(ps).toHaveLength(2);
    expect(ps[0]?.textContent).toBe(PARENT[1]);
    expect(ps[1]?.textContent).toBe(PARENT[2]);
    expect(sheet.querySelector('button')?.textContent).toBe(PARENT[3]);
    expect(root.innerText).toBe(PARENT.join('\n\n'));
  });

  test('micHelp renders the blocked-mic text and Try again', () => {
    const show = mountOverlay(root, vi.fn());
    show('micHelp');
    const sheet = visibleSheet();
    const ps = sheet.querySelectorAll('p');
    expect(ps).toHaveLength(1);
    expect(ps[0]?.textContent).toBe(MIC_HELP[0]);
    expect(sheet.querySelector('button')?.textContent).toBe(MIC_HELP[1]);
    expect(root.innerText).toBe(MIC_HELP.join('\n\n'));
  });

  test('the exported texts are the specified ones', () => {
    expect(OVERLAY_TEXT).toEqual({
      tapToWake: SINGLE_TEXT[0]![1],
      parentTitle: PARENT[0],
      parentLocal: PARENT[1],
      parentMicOff: PARENT[2],
      parentContinue: PARENT[3],
      micHelp: MIC_HELP[0],
      micHelpRetry: MIC_HELP[1],
      micMuted: SINGLE_TEXT[1]![1],
      tooNoisy: SINGLE_TEXT[2]![1],
      error: SINGLE_TEXT[3]![1],
    });
  });

  test('Continue dispatches parentContinue', () => {
    const dispatch = vi.fn<(e: SessionEvent) => void>();
    const show = mountOverlay(root, dispatch);
    show('parentPermission');
    const button = visibleSheet().querySelector('button');
    expect(button?.checkVisibility()).toBe(true);
    button?.click();
    expect(dispatch.mock.calls).toEqual([[{ t: 'parentContinue' }]]);
  });

  test('Try again dispatches settingsRetry', () => {
    const dispatch = vi.fn<(e: SessionEvent) => void>();
    const show = mountOverlay(root, dispatch);
    show('micHelp');
    const button = visibleSheet().querySelector('button');
    expect(button?.checkVisibility()).toBe(true);
    button?.click();
    expect(dispatch.mock.calls).toEqual([[{ t: 'settingsRetry' }]]);
  });

  test('null hides every variant, and switching variants hides the previous one', () => {
    const show = mountOverlay(root, vi.fn());
    show('parentPermission');
    show('tapToWake');
    expect(root.innerText).toBe('Tap Juni to wake up');
    show(null);
    expect(root.innerText.trim()).toBe('');
    for (const el of root.querySelectorAll<HTMLElement>('.overlay > *')) expect(el.hidden).toBe(true);
  });

  test('no element under root has a style attribute after rendering every variant', () => {
    const show = mountOverlay(root, vi.fn());
    const all: Overlay[] = [
      'tapToWake',
      'parentPermission',
      'micHelp',
      'micMuted',
      'tooNoisy',
      'error',
      null,
    ];
    for (const o of all) show(o);
    expect(root.querySelectorAll('[style]').length).toBe(0);
  });
});
