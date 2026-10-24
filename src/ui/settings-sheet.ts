// The settings sheet (plan §7 M3, M8; issues #66, #113, #114). A gear button in the top-right corner opens a modal
// sheet with the voice preset (Bear cub, Chipmunk, Big bear, Custom), the custom pitch slider (0.7–2.2, enabled only
// for Custom), Quiet mode, Gentle mode, Haptics, Noisy room (noise suppression), Sleep after (1–10 min) and the
// "For parents" section. Every control writes the settings store at once; main.ts and the session apply each setting
// (Quiet: the engine's bus; Gentle: the bear's reduced motion; Haptics: `createHaptics`'s `getEnabled`; Noisy room:
// the next mic open; Sleep after: the next sleep-timer start).
//
// Guard (M8, plan Q3): the gear opens the sheet only after a continuous press of at least `GEAR_HOLD_MS` (1 s):
// `pointerdown` … `pointerup` on the gear, or a held Enter / Space key. A ring fills during the press (styles.css);
// a short tap or click does nothing. The press ends without opening on a `pointercancel`, when the pointer leaves
// the gear, when a second (non-primary) pointer comes down on it, when the other activation key goes down, or on
// blur; key repeats and other keys are ignored. Pressing is ignored, and opening refused, while the session is
// Recording, Processing or Playing (`SHEET_BLOCKED`). The gear's `aria-description` says to hold it.
//
// The sheet is a modal `<dialog>` (`role="dialog"`, `aria-modal="true"`): it opens scrolled to the top with focus on
// Close, Tab and Shift+Tab wrap between the first control and Close, and Close or Escape closes it. The bear keeps
// running while it is open.
//
// "For parents" (#114, plan §7 M8, §4.5, §2, §11), the section before Close, holds the sheet's only text:
// - "Try the microphone again", which closes the sheet and then dispatches `settingsRetry` (the session acts on it
//   in MicDenied, plan §3.4 row 10, and in Asleep, where it wakes as a tap does, #266; retrying lives here, never
//   on the child-facing mic help), and how to allow the microphone in Chrome's site settings, as plain text;
// - M6's Install (issue #98, plan §4.5, §4.7), shown only while an install prompt is available, and
//   "New version – restart", enabled only while an update is ready (and ignored while Recording, Processing or
//   Playing, like the gear);
// - the privacy note (plan §2 "Privacy posture");
// - "Open-source licences", which opens the full-screen licences view (licences-screen.ts) over the sheet.
// Nothing in the sheet links anywhere: it has no anchors, and nothing opens a window.
//
// CSP `style-src 'self'` and Trusted Types (plan §4.8.3): the DOM is built with createElement(NS)/textContent only,
// never HTML strings, and nothing sets a `style` attribute; styles.css styles it, including the ring's fill.

import type { SessionEvent, StateName } from '../app/events.ts';
import { CUSTOM_PITCH_MAX, CUSTOM_PITCH_MIN, type Settings, type SettingsStore } from '../app/settings.ts';
import { JUNI } from '../characters/juni.ts';
import type { CharacterNames } from '../characters/types.ts';
import { mountLicencesScreen, type LicencesScreen } from './licences-screen.ts';

export const SETTINGS_TEXT = {
  open: 'Settings',
  title: 'Settings',
  voice: 'Voice',
  cub: 'Bear cub',
  chipmunk: 'Chipmunk',
  bigbear: 'Big bear',
  custom: 'Custom',
  customPitch: 'Custom pitch',
  quietMode: 'Quiet mode',
  gentleMode: 'Gentle mode',
  haptics: 'Haptics',
  noisyRoom: 'Noisy room',
  sleepAfter: 'Sleep after',
  minutes: 'min',
  /** The gear's accessible description (invisible: plan Q3's text-free rule is about visible text). */
  holdHint: 'Hold for 1 second',
  forParents: 'For parents',
  micRetry: 'Try the microphone again',
  micHelp:
    "If the microphone is blocked: open Chrome's menu → Settings → Site settings → Microphone, and allow this site.",
  install: 'Install',
  restart: 'New version – restart',
  /** The parent privacy note, adapted from plan §2 "Privacy posture"; it names the active character. */
  privacy: (n: CharacterNames): string =>
    `Talking Bear works entirely on this device. It has no accounts, analytics or tracking, and never sends audio anywhere. What ${n.name} hears stays in memory only until the replay finishes. Settings are stored on this device.`,
  licences: 'Open-source licences',
  close: 'Close',
} as const;

/** The gear's visible glyph (U+2699); its accessible name is `SETTINGS_TEXT.open`. */
const GEAR = '⚙';
/** The slider's step (plan §4.3.4 custom slider 0.7–2.2). */
export const CUSTOM_PITCH_STEP = 0.05;
/** The gear opens the sheet only after a press at least this long (plan §7 M8). styles.css's ring fills in 1 s too. */
export const GEAR_HOLD_MS = 1000;
/** The gear's class while a press is in progress: it shows the filling ring. */
export const GEAR_PRESSING_CLASS = 'settings-gear--pressing';
/** "Sleep after" choices in minutes (plan Q1, §7 M8); stored as `sleepTimeoutSec`. */
export const SLEEP_AFTER_MIN: readonly number[] = [1, 2, 3, 5, 10];
/** States in which the gear is ignored, so a loop in progress is never disturbed. */
export const SHEET_BLOCKED: ReadonlySet<StateName> = new Set<StateName>([
  'Recording',
  'Processing',
  'Playing',
]);

const VOICES: readonly Settings['voice'][] = ['cub', 'chipmunk', 'bigbear', 'custom'];

/** The PWA side of the sheet (src/pwa/register.ts, plus the install availability main.ts tracks). */
export interface SheetPwa {
  /** True while an install prompt is available: Install is shown only then. */
  installAvailable(): boolean;
  /** Shows the install prompt; called synchronously from the Install click (user activation). */
  promptInstall(): Promise<void>;
  /** True once a new version is waiting: the restart is enabled only then. */
  updateReady(): boolean;
  /** Activates the waiting version; the page reloads. */
  applyUpdate(): void;
}

export interface SettingsSheetDeps {
  /** The settings store: read when the sheet opens, written on every change. */
  store: Pick<SettingsStore, 'get' | 'set'>;
  /** Quiet mode on the master bus; called with the new value on every toggle. */
  bus: { setQuiet(on: boolean): void };
  /** The session's current state: the gear does nothing while it is in `SHEET_BLOCKED`. */
  state(): StateName;
  /** The session's dispatch: "Try the microphone again" sends `settingsRetry` through it. */
  dispatch(e: SessionEvent): void;
  /** Install and restart (M6). Without it the sheet has neither button. */
  pwa?: SheetPwa;
  /** The licences view's fetch (licences-screen.ts); defaults to the global `fetch`. */
  fetch?: (url: string) => Promise<Response>;
  /** Milliseconds on a monotonic clock, for the gear's press time; defaults to `performance.now()`. */
  now?: () => number;
  /** The active character's names, for the privacy note (read on every `open`); defaults to Juni's. */
  names?: () => CharacterNames;
}

export interface SettingsSheet {
  /** Opens the sheet with the store's current values; false (and nothing happens) in a `SHEET_BLOCKED` state. */
  open(): boolean;
  close(): void;
  /** Re-reads `pwa.installAvailable()` and `pwa.updateReady()` into the buttons; call it when either changes. */
  refreshPwa(): void;
}

const noop = (): void => {};

/** Each mount names its radio group uniquely, so two sheets in one document never share a group. */
let mounts = 0;

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

/** A `<label>` holding `input` and then its text. */
function labelled(input: HTMLInputElement, text: string): HTMLLabelElement {
  const label = element('label', 'settings-option');
  label.append(input, element('span', null, text));
  return label;
}

/** The settings a sheet toggle (a checkbox with the switch role) controls. */
type ToggleKey = 'quietMode' | 'gentleMode' | 'haptics' | 'noisyRoomNs';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The gear's progress ring: a circle whose stroke styles.css draws and fills (`GEAR_PRESSING_CLASS`). */
function progressRing(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'settings-gear-ring');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('aria-hidden', 'true');
  const arc = document.createElementNS(SVG_NS, 'circle');
  arc.setAttribute('cx', '24');
  arc.setAttribute('cy', '24');
  arc.setAttribute('r', '22');
  arc.setAttribute('pathLength', '100');
  arc.setAttribute('transform', 'rotate(-90 24 24)'); // the fill starts at 12 o'clock
  svg.append(arc);
  return svg;
}

/** Mounts the gear, its (closed) sheet and the (closed) licences view into `root`. */
export function mountSettingsSheet(root: HTMLElement, deps: SettingsSheetDeps): SettingsSheet {
  const { store, bus } = deps;
  const now = deps.now ?? ((): number => performance.now());
  const group = `bear-voice-${++mounts}`;

  const gear = element('button', 'settings-gear', GEAR);
  gear.type = 'button';
  gear.setAttribute('aria-label', SETTINGS_TEXT.open);
  gear.setAttribute('aria-description', SETTINGS_TEXT.holdHint);
  gear.append(progressRing());

  const dialog = element('dialog', 'settings-sheet');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const title = element('h2', null, SETTINGS_TEXT.title);
  title.id = `${group}-title`;
  dialog.setAttribute('aria-labelledby', title.id);

  const pitch = element('input', 'settings-range');
  pitch.type = 'range';
  pitch.min = String(CUSTOM_PITCH_MIN);
  pitch.max = String(CUSTOM_PITCH_MAX);
  pitch.step = String(CUSTOM_PITCH_STEP);
  pitch.addEventListener('change', () => {
    store.set({ customPitch: Number(pitch.value) });
  });
  const pitchLabel = element('label', 'settings-option settings-pitch');
  pitchLabel.append(element('span', null, SETTINGS_TEXT.customPitch), pitch);

  const radios = new Map<Settings['voice'], HTMLInputElement>();
  const voices = element('fieldset', 'settings-group');
  voices.append(element('legend', null, SETTINGS_TEXT.voice));
  for (const voice of VOICES) {
    const radio = element('input', null);
    radio.type = 'radio';
    radio.name = group;
    radio.value = voice;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      pitch.disabled = voice !== 'custom';
      store.set({ voice });
    });
    radios.set(voice, radio);
    voices.append(labelled(radio, SETTINGS_TEXT[voice]));
  }

  /** A toggle that writes `key` on every change, then calls `then` with the new value. */
  function toggle(key: ToggleKey, then?: (on: boolean) => void): HTMLInputElement {
    const input = element('input', null);
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.addEventListener('change', () => {
      const patch: Partial<Settings> = {};
      patch[key] = input.checked;
      store.set(patch);
      then?.(input.checked);
    });
    return input;
  }
  const toggles: [ToggleKey, HTMLInputElement, string][] = [
    ['quietMode', toggle('quietMode', (on) => bus.setQuiet(on)), SETTINGS_TEXT.quietMode],
    ['gentleMode', toggle('gentleMode'), SETTINGS_TEXT.gentleMode],
    ['haptics', toggle('haptics'), SETTINGS_TEXT.haptics],
    ['noisyRoomNs', toggle('noisyRoomNs'), SETTINGS_TEXT.noisyRoom],
  ];

  const sleep = element('select', 'settings-select');
  for (const min of SLEEP_AFTER_MIN) {
    const option = element('option', null, `${min} ${SETTINGS_TEXT.minutes}`);
    option.value = String(min * 60);
    sleep.append(option);
  }
  sleep.addEventListener('change', () => {
    store.set({ sleepTimeoutSec: Number(sleep.value) });
  });
  const sleepLabel = element('label', 'settings-option');
  sleepLabel.append(element('span', null, SETTINGS_TEXT.sleepAfter), sleep);

  const close = element('button', 'sheet-button', SETTINGS_TEXT.close);
  close.type = 'button';
  close.addEventListener('click', () => {
    dialog.close();
  });

  dialog.append(title, voices, pitchLabel);
  for (const [, input, text] of toggles) dialog.append(labelled(input, text));
  dialog.append(sleepLabel);

  // ---- For parents (#114): mic retry and help, Install and restart, the privacy note, the licences ----
  const parents = element('section', 'settings-parents');
  const parentsTitle = element('h3', null, SETTINGS_TEXT.forParents);
  parentsTitle.id = `${group}-parents`;
  parents.setAttribute('aria-labelledby', parentsTitle.id);
  const retry = element('button', 'sheet-button', SETTINGS_TEXT.micRetry);
  retry.type = 'button';
  // Closed first, so the session's effects (the mic open, Chrome's prompt) run with no modal sheet over the bear.
  retry.addEventListener('click', () => {
    dialog.close();
    deps.dispatch({ t: 'settingsRetry' });
  });
  parents.append(parentsTitle, retry, element('p', null, SETTINGS_TEXT.micHelp));

  /** Install and restart, if the app passed its PWA side. */
  let refreshPwa: () => void = noop;
  const { pwa } = deps;
  if (pwa !== undefined) {
    const install = element('button', 'sheet-button', SETTINGS_TEXT.install);
    install.type = 'button';
    install.addEventListener('click', () => {
      void pwa.promptInstall();
      refreshPwa();
    });
    const restart = element('button', 'sheet-button', SETTINGS_TEXT.restart);
    restart.type = 'button';
    // The sheet stays open while the bear runs: never reload in the middle of a take or a replay.
    restart.addEventListener('click', () => {
      if (pwa.updateReady() && !SHEET_BLOCKED.has(deps.state())) pwa.applyUpdate();
    });
    refreshPwa = () => {
      const hideInstall = !pwa.installAvailable();
      const disableRestart = !pwa.updateReady();
      // A control that goes away under the focus would leave it on <body>, outside the modal sheet.
      const focused = document.activeElement;
      if ((hideInstall && focused === install) || (disableRestart && focused === restart)) close.focus();
      install.hidden = hideInstall;
      restart.disabled = disableRestart;
    };
    parents.append(install, restart);
  }

  const licencesButton = element('button', 'sheet-button', SETTINGS_TEXT.licences);
  licencesButton.type = 'button';
  /** The licences view, mounted after the sheet (below). */
  let licences: LicencesScreen | null = null;
  licencesButton.addEventListener('click', () => {
    void licences?.open();
  });
  const names = deps.names ?? ((): CharacterNames => JUNI.names);
  const privacy = element('p', null, SETTINGS_TEXT.privacy(names()));
  parents.append(privacy, licencesButton);
  dialog.append(parents, close);

  /**
   * Shows the store's current values. A stored sleep timeout that is not one of the choices (only a hand-edited
   * store has one) selects nothing rather than show a value that isn't in effect.
   */
  function render(s: Settings): void {
    for (const [voice, radio] of radios) radio.checked = voice === s.voice;
    pitch.value = String(s.customPitch);
    pitch.disabled = s.voice !== 'custom';
    for (const [key, input] of toggles) input.checked = s[key];
    sleep.value = String(s.sleepTimeoutSec);
    const text = SETTINGS_TEXT.privacy(names());
    if (privacy.textContent !== text) privacy.textContent = text;
    refreshPwa();
  }

  function open(): boolean {
    if (SHEET_BLOCKED.has(deps.state())) return false;
    render(store.get());
    if (!dialog.open) {
      dialog.showModal();
      // The guarded start: a stray Enter or Space closes the sheet rather than change a setting. Close is last, so
      // focusing it must not scroll the sheet: it opens at the top, voices first.
      close.focus({ preventScroll: true });
      dialog.scrollTop = 0;
    }
    return true;
  }

  // ---- focus trap: Tab from Close wraps to the voice group's tab stop, Shift+Tab from the voices to Close ----
  const voiceRadios = Array.from(radios.values());
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focused = document.activeElement;
    if (!e.shiftKey && focused === close) {
      e.preventDefault();
      (voiceRadios.find((r) => r.checked) ?? voiceRadios[0])?.focus();
    } else if (e.shiftKey && voiceRadios.some((r) => r === focused)) {
      e.preventDefault();
      close.focus();
    }
  });

  // ---- the gear's guard: a continuous press of at least GEAR_HOLD_MS opens the sheet ----
  /** The press in progress: its pointer id, or the held key (`'Enter'` / `' '`); null when there is none. */
  let pressBy: number | string | null = null;
  let pressT0 = 0;

  function startPress(by: number | string): void {
    if (SHEET_BLOCKED.has(deps.state())) return; // ignored: no ring, nothing to open
    pressBy = by;
    pressT0 = now();
    gear.classList.add(GEAR_PRESSING_CLASS);
  }
  function cancelPress(): void {
    pressBy = null;
    gear.classList.remove(GEAR_PRESSING_CLASS);
  }
  function endPress(): void {
    const held = now() - pressT0;
    cancelPress();
    if (held >= GEAR_HOLD_MS) open(); // open() re-checks SHEET_BLOCKED: the state may have changed meanwhile
  }
  /** Whether the pointer is over the gear (touch pointers stay captured to it when they move off). */
  function overGear(e: PointerEvent): boolean {
    const r = gear.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  gear.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) {
      if (pressBy !== null) cancelPress(); // a second pointer on the gear: not a deliberate press
      return;
    }
    if (e.button !== 0) return;
    cancelPress(); // a press still recorded here lost its pointerup: this one starts afresh
    startPress(e.pointerId);
  });
  gear.addEventListener('pointermove', (e) => {
    if (e.pointerId === pressBy && !overGear(e)) cancelPress();
  });
  gear.addEventListener('pointerup', (e) => {
    if (e.pointerId !== pressBy) return;
    if (overGear(e)) endPress();
    else cancelPress();
  });
  gear.addEventListener('pointercancel', (e) => {
    if (e.pointerId === pressBy) cancelPress();
  });
  gear.addEventListener('pointerleave', (e) => {
    if (e.pointerId === pressBy) cancelPress();
  });
  // The keyboard press: Enter or Space held for GEAR_HOLD_MS (their clicks, like a pointer's, do nothing).
  gear.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat) return;
    if (pressBy !== null) cancelPress();
    else startPress(e.key);
  });
  gear.addEventListener('keyup', (e) => {
    if (e.key === pressBy) endPress();
  });
  gear.addEventListener('blur', () => {
    if (pressBy !== null) cancelPress();
  });
  // X-A5: no context menu on the long-press (styles.css adds touch-action: none and user-select: none).
  gear.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  render(store.get());
  root.append(gear, dialog);
  // After the sheet, so the sheet stays the first dialog under root; its modal stacks over the sheet when opened.
  licences = mountLicencesScreen(root, { fetch: deps.fetch });
  return {
    open,
    close: () => {
      dialog.close();
    },
    refreshPwa: () => {
      refreshPwa();
    },
  };
}
