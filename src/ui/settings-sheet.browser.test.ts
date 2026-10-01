// Browser Mode tests for the M3 settings sheet (settings-sheet.ts, issue #66). styles.css is imported, so the
// gear's size and corner are the real ones; the store is the real one (in memory) with `set` spied on.

import { afterEach, beforeEach, describe, expect, test, vi, type Mock, type MockInstance } from 'vitest';
import type { StateName } from '../app/events.ts';
import { createSettingsStore, DEFAULT_SETTINGS, type SettingsStore } from '../app/settings.ts';
import {
  mountSettingsSheet,
  SETTINGS_TEXT,
  SHEET_BLOCKED,
  type SettingsSheetDeps,
} from './settings-sheet.ts';
import './styles.css';

const STATES: readonly StateName[] = [
  'Asleep',
  'NeedsParent',
  'Waking',
  'MicDenied',
  'Listening',
  'Recording',
  'Processing',
  'Playing',
  'SfxGated',
  'Cooldown',
  'Paused',
  'Error',
];

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  root.remove();
});

interface Harness {
  store: SettingsStore;
  set: MockInstance<SettingsStore['set']>;
  setQuiet: Mock<(on: boolean) => void>;
  state: { name: StateName };
  deps: SettingsSheetDeps;
}

function harness(): Harness {
  const store = createSettingsStore(null);
  const set = vi.spyOn(store, 'set');
  const setQuiet = vi.fn<(on: boolean) => void>();
  const state: { name: StateName } = { name: 'Listening' };
  return { store, set, setQuiet, state, deps: { store, bus: { setQuiet }, state: () => state.name } };
}

function gear(): HTMLButtonElement {
  const b = root.querySelector<HTMLButtonElement>('button.settings-gear');
  if (b === null) throw new Error('no gear');
  return b;
}

function dialog(): HTMLDialogElement {
  const d = root.querySelector('dialog');
  if (d === null) throw new Error('no dialog');
  return d;
}

/** The input inside the label whose text is `text`. */
function input(text: string): HTMLInputElement {
  for (const label of root.querySelectorAll('label')) {
    if (label.textContent === text) {
      const i = label.querySelector('input');
      if (i !== null) return i;
    }
  }
  throw new Error(`no input labelled ${text}`);
}

function closeButton(): HTMLButtonElement {
  const b = Array.from(dialog().querySelectorAll('button')).find(
    (x) => x.textContent === SETTINGS_TEXT.close,
  );
  if (b === undefined) throw new Error('no Close button');
  return b;
}

const RADIOS = [
  [SETTINGS_TEXT.cub, 'cub'],
  [SETTINGS_TEXT.chipmunk, 'chipmunk'],
  [SETTINGS_TEXT.bigbear, 'bigbear'],
  [SETTINGS_TEXT.custom, 'custom'],
] as const;

describe('settings sheet', () => {
  test('the gear is a ≥ 48 px button in the top-right corner, named Settings; the sheet starts closed', () => {
    mountSettingsSheet(root, harness().deps);
    const b = gear();
    expect(b.type).toBe('button');
    expect(b.getAttribute('aria-label')).toBe('Settings');
    const r = b.getBoundingClientRect();
    expect(r.width).toBeGreaterThanOrEqual(48);
    expect(r.height).toBeGreaterThanOrEqual(48);
    expect(r.top).toBeLessThanOrEqual(16);
    expect(window.innerWidth - r.right).toBeLessThanOrEqual(16);
    expect(getComputedStyle(b).position).toBe('fixed');
    expect(dialog().open).toBe(false);
  });

  test('the gear opens a modal sheet with the four voices, the custom slider, Quiet mode and Close', () => {
    mountSettingsSheet(root, harness().deps);
    gear().click();
    const d = dialog();
    expect(d.open).toBe(true);
    expect(d.matches(':modal')).toBe(true);
    const radios = RADIOS.map(([text]) => input(text));
    expect(radios.map((r) => r.type)).toEqual(['radio', 'radio', 'radio', 'radio']);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false, false]); // the default voice, Bear cub
    const pitch = input(SETTINGS_TEXT.customPitch);
    expect([pitch.type, pitch.min, pitch.max, pitch.step]).toEqual(['range', '0.7', '2.2', '0.05']);
    expect(Number(pitch.value)).toBe(DEFAULT_SETTINGS.customPitch);
    expect(pitch.disabled).toBe(true);
    const quiet = input(SETTINGS_TEXT.quietMode);
    expect(quiet.type).toBe('checkbox');
    expect(quiet.checked).toBe(true); // Quiet mode is on by default
    closeButton().click();
    expect(d.open).toBe(false);
  });

  test('selecting Chipmunk calls store.set({ voice: "chipmunk" }); each voice sets its own id', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    gear().click();
    input(SETTINGS_TEXT.chipmunk).click();
    expect(h.set).toHaveBeenCalledTimes(1);
    expect(h.set).toHaveBeenLastCalledWith({ voice: 'chipmunk' });
    expect(h.store.get().voice).toBe('chipmunk');
    for (const [text, voice] of RADIOS) {
      input(text).click();
      expect(h.set).toHaveBeenLastCalledWith({ voice });
    }
    expect(h.setQuiet).not.toHaveBeenCalled();
  });

  test('the slider is enabled only for Custom and sets customPitch', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    gear().click();
    const pitch = input(SETTINGS_TEXT.customPitch);
    input(SETTINGS_TEXT.custom).click();
    expect(pitch.disabled).toBe(false);
    pitch.value = '1.85';
    pitch.dispatchEvent(new Event('change', { bubbles: true }));
    expect(h.set).toHaveBeenLastCalledWith({ customPitch: 1.85 });
    expect(h.store.get()).toMatchObject({ voice: 'custom', customPitch: 1.85 });
    input(SETTINGS_TEXT.bigbear).click();
    expect(pitch.disabled).toBe(true);
  });

  test('Quiet mode toggles bus.setQuiet and the stored quietMode', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    gear().click();
    const quiet = input(SETTINGS_TEXT.quietMode);
    quiet.click();
    expect(h.setQuiet.mock.calls).toEqual([[false]]);
    expect(h.set).toHaveBeenLastCalledWith({ quietMode: false });
    expect(h.store.get().quietMode).toBe(false);
    quiet.click();
    expect(h.setQuiet.mock.calls).toEqual([[false], [true]]);
    expect(h.set).toHaveBeenLastCalledWith({ quietMode: true });
    expect(h.store.get().quietMode).toBe(true);
  });

  test('opening shows the store as it is now', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    h.store.set({ voice: 'custom', customPitch: 0.9, quietMode: false });
    gear().click();
    expect(RADIOS.map(([text]) => input(text).checked)).toEqual([false, false, false, true]);
    const pitch = input(SETTINGS_TEXT.customPitch);
    expect(Number(pitch.value)).toBe(0.9);
    expect(pitch.disabled).toBe(false);
    expect(input(SETTINGS_TEXT.quietMode).checked).toBe(false);
  });

  test('the gear is ignored while Recording, Processing or Playing, and opens the sheet in every other state', () => {
    expect([...SHEET_BLOCKED]).toEqual(['Recording', 'Processing', 'Playing']);
    for (const name of STATES) {
      const h = harness();
      h.state.name = name;
      const sheet = mountSettingsSheet(root, h.deps);
      gear().click();
      expect(dialog().open, name).toBe(!SHEET_BLOCKED.has(name));
      expect(sheet.open(), name).toBe(!SHEET_BLOCKED.has(name));
      sheet.close();
      expect(dialog().open).toBe(false);
      root.replaceChildren();
    }
  });

  test('no element under the mount root has a style attribute (CSP style-src self)', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    expect(root.querySelectorAll('[style]').length).toBe(0);
    gear().click();
    input(SETTINGS_TEXT.custom).click();
    input(SETTINGS_TEXT.quietMode).click();
    expect(root.querySelectorAll('[style]').length).toBe(0);
    closeButton().click();
    expect(root.querySelectorAll('[style]').length).toBe(0);
  });
});
