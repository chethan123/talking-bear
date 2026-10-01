// The M3 settings sheet (plan §7 M3, issue #66): a gear button in the top-right corner opens a modal sheet with
// the voice preset (Bear cub, Chipmunk, Big bear, Custom), the custom pitch slider (0.7–2.2, enabled only for
// Custom) and Quiet mode. Development text only: M8 moves the sheet behind a 1 s long-press and adds more.
//
// CSP `style-src 'self'` and Trusted Types (plan §4.8.3): the DOM is built with createElement/textContent only,
// never HTML strings, and nothing sets a `style` attribute; styles.css styles it.

import type { StateName } from '../app/events.ts';
import { CUSTOM_PITCH_MAX, CUSTOM_PITCH_MIN, type Settings, type SettingsStore } from '../app/settings.ts';

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
  close: 'Close',
} as const;

/** The gear's visible glyph (U+2699); its accessible name is `SETTINGS_TEXT.open`. */
const GEAR = '⚙';
/** The slider's step (plan §4.3.4 custom slider 0.7–2.2). */
export const CUSTOM_PITCH_STEP = 0.05;
/** States in which the gear is ignored, so a loop in progress is never disturbed. */
export const SHEET_BLOCKED: ReadonlySet<StateName> = new Set<StateName>([
  'Recording',
  'Processing',
  'Playing',
]);

const VOICES: readonly Settings['voice'][] = ['cub', 'chipmunk', 'bigbear', 'custom'];

export interface SettingsSheetDeps {
  /** The settings store: read when the sheet opens, written on every change. */
  store: Pick<SettingsStore, 'get' | 'set'>;
  /** Quiet mode on the master bus; called with the new value on every toggle. */
  bus: { setQuiet(on: boolean): void };
  /** The session's current state: the gear does nothing while it is in `SHEET_BLOCKED`. */
  state(): StateName;
}

export interface SettingsSheet {
  /** Opens the sheet with the store's current values; false (and nothing happens) in a `SHEET_BLOCKED` state. */
  open(): boolean;
  close(): void;
}

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

/** Mounts the gear and its (closed) sheet into `root`. */
export function mountSettingsSheet(root: HTMLElement, deps: SettingsSheetDeps): SettingsSheet {
  const { store, bus } = deps;
  const group = `bear-voice-${++mounts}`;

  const gear = element('button', 'settings-gear', GEAR);
  gear.type = 'button';
  gear.setAttribute('aria-label', SETTINGS_TEXT.open);

  const dialog = element('dialog', 'settings-sheet');
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

  const quiet = element('input', null);
  quiet.type = 'checkbox';
  quiet.addEventListener('change', () => {
    store.set({ quietMode: quiet.checked });
    bus.setQuiet(quiet.checked);
  });

  const close = element('button', 'sheet-button', SETTINGS_TEXT.close);
  close.type = 'button';
  close.addEventListener('click', () => {
    dialog.close();
  });

  dialog.append(title, voices, pitchLabel, labelled(quiet, SETTINGS_TEXT.quietMode), close);

  /** Shows the store's current values. */
  function render(s: Settings): void {
    for (const [voice, radio] of radios) radio.checked = voice === s.voice;
    pitch.value = String(s.customPitch);
    pitch.disabled = s.voice !== 'custom';
    quiet.checked = s.quietMode;
  }

  function open(): boolean {
    if (SHEET_BLOCKED.has(deps.state())) return false;
    render(store.get());
    if (!dialog.open) dialog.showModal();
    return true;
  }

  gear.addEventListener('click', () => {
    open();
  });

  render(store.get());
  root.append(gear, dialog);
  return {
    open,
    close: () => {
      dialog.close();
    },
  };
}
