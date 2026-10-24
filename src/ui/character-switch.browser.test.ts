/// <reference types="@vitest/browser-playwright" />
// Browser Mode tests for the character swap button (character-switch.ts, duck plan §3.3, T126): its box and place
// (styles.css is imported), its thumbnail and name, shown only in Asleep, a trusted tap on it never reaching the stage
// (no `tapBear`), a click choosing the other character, and the rule that hides it after a fixed (`showPose`) stage.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { SessionEvent, StateName } from '../app/events.ts';
import { createSettingsStore } from '../app/settings.ts';
import { mountBearView, type BearView } from '../anim/bear-view.ts';
import { POSES } from '../anim/poses.ts';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '../anim/renderer.ts';
import { CHARACTERS, FENN, JUNI } from '../characters/index.ts';
import type { CharacterId } from '../characters/types.ts';
import {
  characterThumbnail,
  mountCharacterSwitch,
  SWITCH_THUMB_PX,
  SWITCH_THUMB_RECT,
  type CharacterSwitch,
  type CharacterSwitchDeps,
} from './character-switch.ts';
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

let root: HTMLElement;
const disposers: (() => void)[] = [];

beforeEach(() => {
  root = document.createElement('main');
  root.id = 'app';
  document.body.append(root);
});

afterEach(() => {
  for (const d of disposers.splice(0)) d();
  root.remove();
});

interface Harness {
  sw: CharacterSwitch;
  button: HTMLButtonElement;
  session: { state: StateName };
  character: { id: CharacterId };
  choose: ReturnType<typeof vi.fn<(id: CharacterId) => void>>;
  thumbnail: ReturnType<typeof vi.fn<CharacterSwitchDeps['thumbnail']>>;
}

function harness(state: StateName = 'Asleep', id: CharacterId = 'juni'): Harness {
  const session = { state };
  const character = { id };
  const choose = vi.fn<(id: CharacterId) => void>();
  const thumbnail = vi.fn<CharacterSwitchDeps['thumbnail']>((c, size) =>
    characterThumbnail(CHARACTERS[c], size),
  );
  const sw = mountCharacterSwitch(root, {
    state: () => session.state,
    current: () => character.id,
    choose,
    thumbnail,
  });
  disposers.push(() => sw.dispose());
  const button = root.querySelector<HTMLButtonElement>('button.character-switch');
  if (button === null) throw new Error('no button.character-switch');
  return { sw, button, session, character, choose, thumbnail };
}

/** A bear view on `root` (its canvas prepended, as in main.ts), in session state `state.name`. */
function bear(state: { state: StateName }, dispatch: (e: SessionEvent) => void): BearView {
  const view = mountBearView(root, {
    visibility: { current: () => 'visible', subscribe: () => () => undefined },
    now: () => performance.now(),
    state: () => state.state,
    dispatch,
    engine: { getProcessed: () => undefined, context: () => null },
    character: JUNI,
  });
  disposers.push(() => view.dispose());
  return view;
}

/** The RGBA pixels of a 2D canvas. */
function pixels(c: HTMLCanvasElement): Uint8ClampedArray {
  const g = c.getContext('2d');
  if (g === null) throw new Error('no 2d context');
  return g.getImageData(0, 0, c.width, c.height).data;
}

/** The RGB of pixel (x, y) of a thumbnail's pixels. */
function at(d: Uint8ClampedArray, x: number, y: number): number[] {
  const o = 4 * (y * SWITCH_THUMB_PX + x);
  return Array.from(d.subarray(o, o + 3));
}

describe('the swap button', () => {
  test('a 72 × 72 CSS px button at the bottom left (16 px), z-index 2, above the overlay, no style attribute', () => {
    const { button } = harness();
    expect(button.type).toBe('button');
    const box = button.getBoundingClientRect();
    expect(box.width).toBe(72);
    expect(box.height).toBe(72);
    expect(box.left).toBe(16);
    expect(window.innerHeight - box.bottom).toBe(16); // env(safe-area-inset-bottom) is 0 here
    const css = getComputedStyle(button);
    expect(css.position).toBe('fixed');
    expect(css.zIndex).toBe('2');
    expect(root.querySelectorAll('[style]')).toHaveLength(0);
  });

  test("it holds the other character's head on a 144 × 144 canvas, and is named after the other character", () => {
    const { button, thumbnail } = harness('Asleep', 'juni');
    expect(button.getAttribute('aria-label')).toBe('Switch to Fenn the duckling');
    expect(button.textContent).toBe('');
    const thumb = button.querySelector('canvas');
    expect(thumb).not.toBeNull();
    expect(thumb?.width).toBe(SWITCH_THUMB_PX);
    expect(thumb?.height).toBe(SWITCH_THUMB_PX);
    expect(thumb?.getAttribute('aria-hidden')).toBe('true');
    expect(thumbnail.mock.calls).toEqual([['fenn', SWITCH_THUMB_PX]]);
  });

  test('the thumbnail is drawn: the head differs from the background, and the two characters differ', () => {
    const juni = pixels(characterThumbnail(JUNI));
    const fenn = pixels(characterThumbnail(FENN));
    const mid = SWITCH_THUMB_PX / 2;
    for (const d of [juni, fenn]) expect(at(d, mid, mid)).not.toEqual(at(d, 1, 1));
    let differ = 0;
    for (let i = 0; i < juni.length; i += 4) if (juni[i] !== fenn[i] || juni[i + 1] !== fenn[i + 1]) differ++;
    expect(differ).toBeGreaterThan((SWITCH_THUMB_PX * SWITCH_THUMB_PX) / 10);
    // The framed rect lies inside the design box.
    const [x0, y0, x1, y1] = SWITCH_THUMB_RECT;
    expect(x0 >= 0 && y0 >= 0 && x1 <= DESIGN_WIDTH && y1 <= DESIGN_HEIGHT).toBe(true);
  });

  test('hidden in every state but Asleep; refresh() follows the state', () => {
    const h = harness('Asleep');
    expect(h.button.hidden).toBe(false);
    for (const state of STATES) {
      h.session.state = state;
      h.sw.refresh();
      expect(h.button.hidden, state).toBe(state !== 'Asleep');
      expect(getComputedStyle(h.button).display === 'none', state).toBe(state !== 'Asleep');
    }
    const fresh = harness('Recording');
    expect(fresh.button.hidden).toBe(true);
  });

  test('a trusted tap on it never reaches the stage: no tapBear, though a tap on the canvas beside it wakes', async () => {
    const session: { state: StateName } = { state: 'Asleep' };
    const dispatch = vi.fn<(e: SessionEvent) => void>();
    const view = bear(session, dispatch);
    const h = harness('Asleep');
    expect(root.firstElementChild).toBe(view.canvas);
    // The button lies over the canvas: the canvas is full-viewport, the button at the bottom left.
    const box = h.button.getBoundingClientRect();
    expect(document.elementFromPoint(box.left + 36, box.top + 36)).toBe(h.button.firstElementChild);
    const downs: EventTarget[] = [];
    const onDown = (e: Event): void => {
      if (e.target !== null) downs.push(e.target);
    };
    document.addEventListener('pointerdown', onDown, true);
    disposers.push(() => document.removeEventListener('pointerdown', onDown, true));
    await userEvent.click(h.button);
    expect(downs.length).toBeGreaterThan(0);
    expect(downs.every((t) => t !== view.canvas)).toBe(true);
    expect(dispatch.mock.calls.filter(([e]) => e.t === 'tapBear')).toEqual([]);
    expect(h.choose.mock.calls).toEqual([['fenn']]);
    // Control: a tap on the canvas wakes.
    await userEvent.click(view.canvas, { position: { x: innerWidth / 2, y: 40 } });
    expect(dispatch.mock.calls.filter(([e]) => e.t === 'tapBear')).toHaveLength(1);
  });

  test('a click chooses the other character: the settings store gets `character`, and refresh() offers the first', async () => {
    const store = createSettingsStore(null);
    expect(store.get().character).toBe('juni');
    const sw = mountCharacterSwitch(root, {
      state: () => 'Asleep',
      current: () => store.get().character,
      choose: (id) => store.set({ character: id }),
      thumbnail: (id, size) => characterThumbnail(CHARACTERS[id], size),
    });
    disposers.push(() => sw.dispose());
    const button = root.querySelector<HTMLButtonElement>('button.character-switch');
    if (button === null) throw new Error('no button');
    const fennThumb = button.firstElementChild;
    await userEvent.click(button);
    expect(store.get().character).toBe('fenn');
    sw.refresh();
    expect(button.getAttribute('aria-label')).toBe('Switch to Juni the bear');
    const juniThumb = button.firstElementChild;
    expect(juniThumb).not.toBe(fennThumb);
    expect(button.children).toHaveLength(1);
    await userEvent.click(button);
    expect(store.get().character).toBe('juni');
    sw.refresh();
    expect(button.getAttribute('aria-label')).toBe('Switch to Fenn the duckling');
    expect(button.firstElementChild).toBe(fennThumb); // drawn once per character
  });

  test('each thumbnail is drawn once, however often the characters swap', () => {
    const h = harness('Asleep', 'juni');
    for (let k = 0; k < 6; k++) {
      h.character.id = k % 2 === 0 ? 'fenn' : 'juni';
      h.sw.refresh();
    }
    expect(h.thumbnail.mock.calls.map(([id]) => id).toSorted()).toEqual(['fenn', 'juni']);
  });

  test('hidden after a fixed (showPose) stage, which precedes it in main#app', () => {
    const session: { state: StateName } = { state: 'Asleep' };
    const view = bear(session, () => undefined);
    const h = harness('Asleep');
    expect(getComputedStyle(h.button).display).not.toBe('none');
    view.showPose(POSES.neutral, 500, 700);
    expect(view.canvas.classList.contains('stage--fixed')).toBe(true);
    expect(getComputedStyle(h.button).display).toBe('none');
  });

  test('dispose removes the button', () => {
    const h = harness();
    h.sw.dispose();
    expect(root.querySelector('.character-switch')).toBeNull();
  });
});
