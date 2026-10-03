// Browser Mode tests for the settings sheet (settings-sheet.ts): M3 (issue #66), its M6 Install and restart
// buttons (issue #98) and M8 (issue #113): the gear's 1 s press guard and progress ring, every control, and the
// focus-trapped dialog. styles.css is imported, so the gear's size, corner and ring are the real ones; the store is
// the real one (in memory) with `set` spied on. Presses use an injected clock, except the real-time 300 / 1100 ms
// case; pointer and key events are dispatched on the gear, and Tab / Escape go through the real keyboard.

import { afterEach, beforeEach, describe, expect, test, vi, type Mock, type MockInstance } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { StateName } from '../app/events.ts';
import { createSettingsStore, DEFAULT_SETTINGS, type SettingsStore } from '../app/settings.ts';
import {
  GEAR_HOLD_MS,
  GEAR_PRESSING_CLASS,
  mountSettingsSheet,
  SETTINGS_TEXT,
  SHEET_BLOCKED,
  SLEEP_AFTER_MIN,
  type SettingsSheetDeps,
  type SheetPwa,
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
  /** The sheet's clock (ms); a press advances it. */
  clock: { t: number };
  deps: SettingsSheetDeps;
}

function harness(): Harness {
  const store = createSettingsStore(null);
  const set = vi.spyOn(store, 'set');
  const setQuiet = vi.fn<(on: boolean) => void>();
  const state: { name: StateName } = { name: 'Listening' };
  const clock = { t: 1000 };
  return {
    store,
    set,
    setQuiet,
    state,
    clock,
    deps: { store, bus: { setQuiet }, state: () => state.name, now: () => clock.t },
  };
}

function gear(): HTMLButtonElement {
  const b = root.querySelector<HTMLButtonElement>('button.settings-gear');
  if (b === null) throw new Error('no gear');
  return b;
}

function ring(): SVGSVGElement {
  const r = gear().querySelector<SVGSVGElement>('svg.settings-gear-ring');
  if (r === null) throw new Error('no ring');
  return r;
}

function arc(): SVGCircleElement {
  const c = ring().querySelector('circle');
  if (c === null) throw new Error('no ring circle');
  return c;
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

/** The "Sleep after" select: the one inside the label that starts with its text. */
function sleepSelect(): HTMLSelectElement {
  for (const label of root.querySelectorAll('label')) {
    const s = label.querySelector('select');
    if (s !== null && label.firstElementChild?.textContent === SETTINGS_TEXT.sleepAfter) return s;
  }
  throw new Error('no Sleep after select');
}

function closeButton(): HTMLButtonElement {
  const b = Array.from(dialog().querySelectorAll('button')).find(
    (x) => x.textContent === SETTINGS_TEXT.close,
  );
  if (b === undefined) throw new Error('no Close button');
  return b;
}

/** Dispatches a pointer event of `type` on the gear: by default the primary touch pointer 1 at its centre. */
function pointer(type: string, init: PointerEventInit = {}): void {
  const r = gear().getBoundingClientRect();
  gear().dispatchEvent(
    new PointerEvent(type, {
      bubbles: type !== 'pointerleave',
      cancelable: true,
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      ...init,
    }),
  );
}

/** A press of `ms` on the harness clock: pointerdown, the clock advances, pointerup. */
function press(h: Harness, ms: number): void {
  pointer('pointerdown');
  h.clock.t += ms;
  pointer('pointerup');
}

/** A key held for `ms` on the harness clock, on the gear. */
function keyPress(h: Harness, key: string, ms: number): void {
  gear().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  h.clock.t += ms;
  gear().dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RADIOS = [
  [SETTINGS_TEXT.cub, 'cub'],
  [SETTINGS_TEXT.chipmunk, 'chipmunk'],
  [SETTINGS_TEXT.bigbear, 'bigbear'],
  [SETTINGS_TEXT.custom, 'custom'],
] as const;

/** The four toggles: label, settings key, default. */
const TOGGLES = [
  [SETTINGS_TEXT.quietMode, 'quietMode', true],
  [SETTINGS_TEXT.gentleMode, 'gentleMode', false],
  [SETTINGS_TEXT.haptics, 'haptics', true],
  [SETTINGS_TEXT.noisyRoom, 'noisyRoomNs', false],
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

  test('a 1 s press opens a modal sheet with the voices, the slider, the four toggles, Sleep after and Close', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    press(h, GEAR_HOLD_MS);
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
    // Quiet on, Gentle off, Haptics on, Noisy room off: the defaults (plan §7 M8).
    for (const [text, , on] of TOGGLES) {
      const t = input(text);
      expect([t.type, t.getAttribute('role'), t.checked], text).toEqual(['checkbox', 'switch', on]);
    }
    const s = sleepSelect();
    expect(Array.from(s.options, (o) => [o.value, o.textContent])).toEqual([
      ['60', '1 min'],
      ['120', '2 min'],
      ['180', '3 min'],
      ['300', '5 min'],
      ['600', '10 min'],
    ]);
    expect(SLEEP_AFTER_MIN).toEqual([1, 2, 3, 5, 10]);
    expect(s.value).toBe('120'); // 2 min
    // Every control is a 48 px target.
    for (const label of d.querySelectorAll('label')) {
      expect(label.getBoundingClientRect().height, label.textContent ?? '').toBeGreaterThanOrEqual(48);
    }
    expect(s.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
    closeButton().click();
    expect(d.open).toBe(false);
  });

  test('selecting Chipmunk calls store.set({ voice: "chipmunk" }); each voice sets its own id', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    press(h, GEAR_HOLD_MS);
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
    press(h, GEAR_HOLD_MS);
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
    press(h, GEAR_HOLD_MS);
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

  test('Gentle mode, Haptics and Noisy room each write their own setting, both ways', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    press(h, GEAR_HOLD_MS);
    for (const [text, key, on] of TOGGLES.slice(1)) {
      const t = input(text);
      t.click();
      expect(h.set, text).toHaveBeenLastCalledWith({ [key]: !on });
      expect(h.store.get()[key], text).toBe(!on);
      t.click();
      expect(h.set, text).toHaveBeenLastCalledWith({ [key]: on });
      expect(h.store.get()[key], text).toBe(on);
    }
    expect(h.set).toHaveBeenCalledTimes(6);
    expect(h.setQuiet).not.toHaveBeenCalled();
  });

  test('Sleep after writes sleepTimeoutSec for every choice', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    press(h, GEAR_HOLD_MS);
    const s = sleepSelect();
    for (const min of [10, 1, 3, 5, 2]) {
      s.value = String(min * 60);
      s.dispatchEvent(new Event('change', { bubbles: true }));
      expect(h.set).toHaveBeenLastCalledWith({ sleepTimeoutSec: min * 60 });
      expect(h.store.get().sleepTimeoutSec).toBe(min * 60);
    }
    expect(h.set).toHaveBeenCalledTimes(5);
  });

  test('opening shows the store as it is now', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    h.store.set({
      voice: 'custom',
      customPitch: 0.9,
      quietMode: false,
      gentleMode: true,
      haptics: false,
      noisyRoomNs: true,
      sleepTimeoutSec: 600,
    });
    press(h, GEAR_HOLD_MS);
    expect(RADIOS.map(([text]) => input(text).checked)).toEqual([false, false, false, true]);
    const pitch = input(SETTINGS_TEXT.customPitch);
    expect(Number(pitch.value)).toBe(0.9);
    expect(pitch.disabled).toBe(false);
    expect(TOGGLES.map(([text]) => input(text).checked)).toEqual([false, true, false, true]);
    expect(sleepSelect().value).toBe('600');
  });

  test('a stored sleep timeout that is not a choice selects nothing', () => {
    const h = harness();
    const sheet = mountSettingsSheet(root, h.deps);
    h.store.set({ sleepTimeoutSec: 90 });
    sheet.open();
    expect(sleepSelect().selectedIndex).toBe(-1);
    expect(h.store.get().sleepTimeoutSec).toBe(90);
  });

  test('the gear is ignored while Recording, Processing or Playing, and opens the sheet in every other state', () => {
    expect([...SHEET_BLOCKED]).toEqual(['Recording', 'Processing', 'Playing']);
    for (const name of STATES) {
      const h = harness();
      h.state.name = name;
      const sheet = mountSettingsSheet(root, h.deps);
      pointer('pointerdown');
      expect(gear().classList.contains(GEAR_PRESSING_CLASS), name).toBe(!SHEET_BLOCKED.has(name)); // no ring
      h.clock.t += GEAR_HOLD_MS;
      pointer('pointerup');
      expect(dialog().open, name).toBe(!SHEET_BLOCKED.has(name));
      expect(sheet.open(), name).toBe(!SHEET_BLOCKED.has(name));
      sheet.close();
      expect(dialog().open).toBe(false);
      root.replaceChildren();
    }
  });

  test('a press that starts in Listening opens nothing if the bear is Recording at its release', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    pointer('pointerdown');
    h.state.name = 'Recording';
    h.clock.t += GEAR_HOLD_MS;
    pointer('pointerup');
    expect(dialog().open).toBe(false);
    expect(gear().classList.contains(GEAR_PRESSING_CLASS)).toBe(false);
  });

  test('no element under the mount root has a style attribute (CSP style-src self)', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    expect(root.querySelectorAll('[style]').length).toBe(0);
    pointer('pointerdown'); // the ring is filling
    expect(root.querySelectorAll('[style]').length).toBe(0);
    h.clock.t += GEAR_HOLD_MS;
    pointer('pointerup');
    expect(dialog().open).toBe(true);
    input(SETTINGS_TEXT.custom).click();
    for (const [text] of TOGGLES) input(text).click();
    const s = sleepSelect();
    s.value = '300';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelectorAll('[style]').length).toBe(0);
    closeButton().click();
    expect(root.querySelectorAll('[style]').length).toBe(0);
  });
});

describe('the 1 s press guard (#113)', () => {
  test('a 300 ms press does not open the sheet, and a 1100 ms press does (real time, the default clock)', async () => {
    const h = harness();
    mountSettingsSheet(root, { ...h.deps, now: undefined });
    pointer('pointerdown');
    await sleep(300);
    pointer('pointerup');
    expect(dialog().open).toBe(false);
    pointer('pointerdown');
    await sleep(1100);
    expect(dialog().open).toBe(false); // D1: opens at release, never while held
    pointer('pointerup');
    expect(dialog().open).toBe(true);
  });

  test('a click does nothing; a press opens from exactly GEAR_HOLD_MS (1000 ms)', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    expect(GEAR_HOLD_MS).toBe(1000);
    gear().click();
    expect(dialog().open).toBe(false);
    press(h, 999);
    expect(dialog().open).toBe(false);
    press(h, 1000);
    expect(dialog().open).toBe(true);
  });

  test('the press ends without opening on pointercancel, leaving the gear, a move off it, a second pointer or blur', () => {
    const cases: [string, () => void][] = [
      ['pointercancel', () => pointer('pointercancel')],
      ['pointerleave', () => pointer('pointerleave')],
      ['move off the gear', () => pointer('pointermove', { clientX: 10, clientY: 300 })],
      ['second pointer', () => pointer('pointerdown', { pointerId: 2, isPrimary: false })],
      ['blur', () => gear().dispatchEvent(new FocusEvent('blur'))],
    ];
    for (const [name, interrupt] of cases) {
      const h = harness();
      mountSettingsSheet(root, h.deps);
      pointer('pointerdown');
      expect(gear().classList.contains(GEAR_PRESSING_CLASS), name).toBe(true);
      h.clock.t += 500;
      interrupt();
      expect(gear().classList.contains(GEAR_PRESSING_CLASS), name).toBe(false);
      h.clock.t += GEAR_HOLD_MS;
      pointer('pointerup');
      expect(dialog().open, name).toBe(false);
      root.replaceChildren();
    }
  });

  test('a move within the gear keeps the press; a release off the gear opens nothing', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    const r = gear().getBoundingClientRect();
    pointer('pointerdown');
    pointer('pointermove', { clientX: r.left + 4, clientY: r.bottom - 4 });
    h.clock.t += GEAR_HOLD_MS;
    pointer('pointerup', { clientX: r.left - 20, clientY: r.top + 20 });
    expect(dialog().open).toBe(false);
    pointer('pointerdown');
    pointer('pointermove', { clientX: r.left + 4, clientY: r.bottom - 4 });
    h.clock.t += GEAR_HOLD_MS;
    pointer('pointerup');
    expect(dialog().open).toBe(true);
  });

  test('only the primary pointer with the main button starts a press', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    for (const init of [
      { button: 2, pointerType: 'mouse' },
      { isPrimary: false, pointerId: 3 },
    ]) {
      pointer('pointerdown', init);
      expect(gear().classList.contains(GEAR_PRESSING_CLASS)).toBe(false);
      h.clock.t += GEAR_HOLD_MS;
      pointer('pointerup', init);
      expect(dialog().open).toBe(false);
    }
    pointer('pointerdown', { pointerType: 'mouse' });
    h.clock.t += GEAR_HOLD_MS;
    pointer('pointerup', { pointerType: 'mouse' });
    expect(dialog().open).toBe(true);
  });

  test('a primary pointerdown restarts a press whose pointerup was lost', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    pointer('pointerdown'); // pointer 1: its pointerup never arrives
    h.clock.t += 300;
    pointer('pointerdown', { pointerId: 5 });
    expect(gear().classList.contains(GEAR_PRESSING_CLASS)).toBe(true);
    h.clock.t += GEAR_HOLD_MS;
    pointer('pointerup', { pointerId: 5 });
    expect(dialog().open).toBe(true);
  });

  test('the gear tells screen readers to hold it: aria-description "Hold for 1 second"', () => {
    mountSettingsSheet(root, harness().deps);
    expect(gear().getAttribute('aria-description')).toBe('Hold for 1 second');
    expect(SETTINGS_TEXT.holdHint).toBe('Hold for 1 second');
  });

  test('the ring is hidden at rest and fills over GEAR_HOLD_MS while pressing', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    expect(ring().getAttribute('aria-hidden')).toBe('true');
    expect(getComputedStyle(ring()).opacity).toBe('0');
    expect(arc().getAnimations()).toHaveLength(0);
    pointer('pointerdown');
    expect(gear().classList.contains(GEAR_PRESSING_CLASS)).toBe(true);
    expect(getComputedStyle(ring()).opacity).toBe('1');
    const [fill, ...rest] = arc().getAnimations();
    expect(rest).toHaveLength(0);
    if (!(fill instanceof CSSAnimation)) throw new Error('the ring has no CSS animation');
    expect(fill.animationName).toBe('settings-gear-fill');
    expect(fill.effect?.getTiming().duration).toBe(GEAR_HOLD_MS);
    h.clock.t += 400;
    pointer('pointerup'); // too short: closed, and the ring is gone
    expect(dialog().open).toBe(false);
    expect(gear().classList.contains(GEAR_PRESSING_CLASS)).toBe(false);
    expect(getComputedStyle(ring()).opacity).toBe('0');
    expect(arc().getAnimations()).toHaveLength(0);
  });

  test('a held Enter or Space opens after 1 s; a repeat neither restarts nor ends the press; the other activation key cancels it', () => {
    for (const key of ['Enter', ' ']) {
      const h = harness();
      const sheet = mountSettingsSheet(root, h.deps);
      const keydown = (init: KeyboardEventInit): void => {
        gear().dispatchEvent(new KeyboardEvent('keydown', init));
      };
      keyPress(h, key, 300);
      expect(dialog().open, key).toBe(false);
      // A repeat is the same press: it keeps the ring and its start time (600 + 400 ms = 1 s opens).
      keydown({ key });
      h.clock.t += 600;
      keydown({ key, repeat: true });
      expect(gear().classList.contains(GEAR_PRESSING_CLASS), key).toBe(true);
      h.clock.t += 400;
      gear().dispatchEvent(new KeyboardEvent('keyup', { key }));
      expect(dialog().open, key).toBe(true);
      sheet.close();
      // A non-activation key is ignored.
      keydown({ key });
      keydown({ key: 'a' });
      expect(gear().classList.contains(GEAR_PRESSING_CLASS), key).toBe(true);
      h.clock.t += GEAR_HOLD_MS;
      gear().dispatchEvent(new KeyboardEvent('keyup', { key }));
      expect(dialog().open, key).toBe(true);
      sheet.close();
      // The other activation key cancels the press.
      keydown({ key });
      h.clock.t += 600;
      keydown({ key: key === ' ' ? 'Enter' : ' ' });
      expect(gear().classList.contains(GEAR_PRESSING_CLASS), key).toBe(false);
      h.clock.t += 600;
      gear().dispatchEvent(new KeyboardEvent('keyup', { key }));
      expect(dialog().open, key).toBe(false);
      keyPress(h, key, GEAR_HOLD_MS);
      expect(dialog().open, key).toBe(true);
      sheet.close();
      root.replaceChildren();
    }
  });

  test('X-A5: the gear prevents the context menu and takes no touch gestures or selection', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    gear().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    const cs = getComputedStyle(gear());
    expect(cs.touchAction).toBe('none');
    expect(cs.userSelect).toBe('none');
    // Android's long-press contextmenu (≈ 500 ms) neither opens the sheet nor ends a parent's press.
    const contextmenu = (): void => {
      gear().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    };
    pointer('pointerdown');
    h.clock.t += 500;
    contextmenu();
    expect(dialog().open).toBe(false);
    expect(gear().classList.contains(GEAR_PRESSING_CLASS)).toBe(true);
    h.clock.t += 600;
    contextmenu();
    expect(dialog().open).toBe(false);
    pointer('pointerup');
    expect(dialog().open).toBe(true);
  });
});

describe('the dialog (#113)', () => {
  test('role="dialog", aria-modal="true", labelled by its title; focus starts on Close', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    press(h, GEAR_HOLD_MS);
    const d = dialog();
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(d.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Settings');
    expect(document.activeElement).toBe(closeButton());
  });

  test('Tab from Close wraps to the selected voice, Shift+Tab from the voices wraps to Close', async () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    h.store.set({ voice: 'bigbear' });
    press(h, GEAR_HOLD_MS);
    expect(document.activeElement).toBe(closeButton());
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(input(SETTINGS_TEXT.bigbear));
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(closeButton());
    // Tab walks forward through the controls without leaving the dialog.
    await userEvent.keyboard('{Tab}{Tab}');
    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(closeButton());
  });

  test('Escape closes the sheet without writing the store', async () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    press(h, GEAR_HOLD_MS);
    expect(dialog().open).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(dialog().open).toBe(false);
    expect(h.set).not.toHaveBeenCalled();
  });

  test('the bear keeps running: the sheet stays open when the bear starts Recording, and Close still closes it', () => {
    const h = harness();
    mountSettingsSheet(root, h.deps);
    press(h, GEAR_HOLD_MS);
    h.state.name = 'Recording';
    expect(dialog().open).toBe(true);
    closeButton().click();
    expect(dialog().open).toBe(false);
  });
});

// ---- M6 Install and restart (#98) ----

/** A fake PWA side: flags the test flips, and spies for the two actions. */
function fakePwa() {
  const flags = { install: false, ready: false };
  const promptInstall = vi.fn(async (): Promise<void> => {});
  const applyUpdate = vi.fn<() => void>();
  const pwa: SheetPwa = {
    installAvailable: () => flags.install,
    promptInstall,
    updateReady: () => flags.ready,
    applyUpdate,
  };
  return { flags, promptInstall, applyUpdate, pwa };
}

/** The dialog's button whose text is `text`, if any. */
function maybeButton(text: string): HTMLButtonElement | undefined {
  return Array.from(dialog().querySelectorAll('button')).find((x) => x.textContent === text);
}

function button(text: string): HTMLButtonElement {
  const b = maybeButton(text);
  if (b === undefined) throw new Error(`no ${text} button`);
  return b;
}

describe('M6 Install and restart (#98)', () => {
  test('without the PWA side, the sheet has neither button', () => {
    mountSettingsSheet(root, harness().deps);
    expect(maybeButton(SETTINGS_TEXT.install)).toBeUndefined();
    expect(maybeButton(SETTINGS_TEXT.restart)).toBeUndefined();
  });

  test('Install is shown only while an install prompt is available, and a click prompts once', () => {
    const f = fakePwa();
    const sheet = mountSettingsSheet(root, { ...harness().deps, pwa: f.pwa });
    sheet.open();
    const install = button(SETTINGS_TEXT.install);
    expect(install.type).toBe('button');
    expect(install.hidden).toBe(true);
    expect(install.getBoundingClientRect().height).toBe(0);
    f.flags.install = true;
    sheet.refreshPwa();
    expect(install.hidden).toBe(false);
    expect(install.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
    install.click();
    expect(f.promptInstall).toHaveBeenCalledTimes(1);
    // Opening re-reads the flags too.
    sheet.close();
    f.flags.install = false;
    sheet.open();
    expect(install.hidden).toBe(true);
  });

  test('"New version – restart" is enabled only while an update is ready, and applies it', () => {
    const f = fakePwa();
    const sheet = mountSettingsSheet(root, { ...harness().deps, pwa: f.pwa });
    sheet.open();
    const restart = button(SETTINGS_TEXT.restart);
    expect(restart.type).toBe('button');
    expect(restart.hidden).toBe(false);
    expect(restart.disabled).toBe(true);
    expect(restart.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
    // Disabled, it doesn't look like the enabled teal button (styles.css, D14).
    expect(getComputedStyle(restart).backgroundColor).toBe('rgb(223, 230, 228)');
    expect(getComputedStyle(restart).color).toBe('rgb(95, 99, 104)');
    restart.click();
    expect(f.applyUpdate).not.toHaveBeenCalled();
    f.flags.ready = true;
    sheet.refreshPwa();
    expect(restart.disabled).toBe(false);
    expect(getComputedStyle(restart).backgroundColor).toBe('rgb(47, 122, 109)');
    restart.click();
    expect(f.applyUpdate).toHaveBeenCalledTimes(1);
  });

  test('the restart does nothing while the bear is Recording, Processing or Playing', () => {
    const h = harness();
    const f = fakePwa();
    f.flags.ready = true;
    const sheet = mountSettingsSheet(root, { ...h.deps, pwa: f.pwa });
    sheet.open(); // in Listening
    const restart = button(SETTINGS_TEXT.restart);
    expect(restart.disabled).toBe(false);
    for (const name of SHEET_BLOCKED) {
      h.state.name = name;
      restart.click();
      expect(f.applyUpdate, name).not.toHaveBeenCalled();
    }
    h.state.name = 'Cooldown';
    restart.click();
    expect(f.applyUpdate).toHaveBeenCalledTimes(1);
  });

  test('focus moves to Close when the focused Install is hidden', () => {
    const f = fakePwa();
    f.flags.install = true;
    const sheet = mountSettingsSheet(root, { ...harness().deps, pwa: f.pwa });
    sheet.open();
    const install = button(SETTINGS_TEXT.install);
    install.focus();
    expect(document.activeElement).toBe(install);
    f.flags.install = false;
    sheet.refreshPwa();
    expect(install.hidden).toBe(true);
    expect(document.activeElement).toBe(closeButton());
  });

  test('an Install click reports through refreshPwa: Install hides and focus lands on Close', () => {
    const f = fakePwa();
    f.flags.install = true;
    // Like register.ts: the prompt is used up, and reported unavailable, before promptInstall's first await.
    f.promptInstall.mockImplementation(async () => {
      f.flags.install = false;
    });
    const sheet = mountSettingsSheet(root, { ...harness().deps, pwa: f.pwa });
    sheet.open();
    const install = button(SETTINGS_TEXT.install);
    install.focus();
    install.click();
    expect(f.promptInstall).toHaveBeenCalledTimes(1);
    expect(install.hidden).toBe(true);
    expect(document.activeElement).toBe(closeButton());
  });

  test('no element under the mount root has a style attribute with both buttons shown', () => {
    const f = fakePwa();
    f.flags.install = true;
    f.flags.ready = true;
    const sheet = mountSettingsSheet(root, { ...harness().deps, pwa: f.pwa });
    sheet.open();
    expect(button(SETTINGS_TEXT.install).hidden).toBe(false);
    expect(button(SETTINGS_TEXT.restart).disabled).toBe(false);
    expect(root.querySelectorAll('[style]').length).toBe(0);
  });
});
