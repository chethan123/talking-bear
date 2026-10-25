// The character swap button (duck plan §3.3 option A, §4.1, T126; Q12): a 72 × 72 CSS px button at the bottom left
// (styles.css `.character-switch`) holding the other character's head, shown only while the session is Asleep, where
// the mic is closed and the context suspended (plan §3.4 entry actions), so a tap can only swap a sleeping character
// and one more tap swaps it back. It is text-free (Q3): the head is a canvas thumbnail, and the button's accessible
// name is the other character's `names.switchTo` ("Switch to Fenn the duckling").
//
// - `refresh()` runs on every session state change (main.ts): the button is `hidden` unless `state()` is Asleep, and
//   it shows the head and the name of the character `current()` is not.
// - A `click` calls `choose(other)`; main.ts, if the session is still Asleep, writes `settings.set({ character })`
//   and remounts the bear.
// - The button is a later sibling of the stage canvas (main#app's first child), so styles.css hides it under
//   `.stage.stage--fixed` (`showPose`): it never appears in a pose screenshot.
// - The canvas sits under the button but is not its ancestor, so the button's pointer events never reach the stage's
//   pointer adapter: a tap on it never dispatches `tapBear`.

import type { StateName } from '../app/events.ts';
import { POSES } from '../anim/poses.ts';
import { createContext, render, type View } from '../anim/renderer.ts';
import { createRig } from '../anim/rig.ts';
import { CHARACTERS } from '../characters/index.ts';
import type { CharacterId, CharacterSpec } from '../characters/types.ts';

/** The thumbnail's backing store, px: the 72 CSS px button at 2×. */
export const SWITCH_THUMB_PX = 144;
/** The design rect the thumbnail frames, `[x0, y0, x1, y1]` in design units: the head of either character. */
export const SWITCH_THUMB_RECT: readonly [number, number, number, number] = [200, 100, 800, 700];

/** The other character of each: the one the button offers. */
const OTHER: Readonly<Record<CharacterId, CharacterId>> = { juni: 'fenn', fenn: 'juni' };

export interface CharacterSwitchDeps {
  /** The session's current state: the button is shown only while it is 'Asleep'. */
  state(): StateName;
  /** The character on stage. */
  current(): CharacterId;
  /** main.ts: `settings.set({ character: id })` if the session is still Asleep, then `refresh()`. */
  choose(id: CharacterId): void;
  /** The other character's head, drawn once (`characterThumbnail`); called at most once per character. */
  thumbnail(id: CharacterId, size: number): HTMLCanvasElement;
}

export interface CharacterSwitch {
  /** Re-reads `state()` and `current()`; call it on every session state change and after a swap. */
  refresh(): void;
  /** Removes the button and its listener. */
  dispose(): void;
}

/**
 * A `size × size` canvas with `spec`'s head: `POSES.neutral` rendered with its own rig, the view framing
 * `SWITCH_THUMB_RECT` (fitted and centred). Allocates (a rig with its paths): setup only.
 */
export function characterThumbnail(spec: CharacterSpec, size = SWITCH_THUMB_PX): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'character-switch-thumb';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.width = size;
  canvas.height = size;
  const [x0, y0, x1, y1] = SWITCH_THUMB_RECT;
  const w = x1 - x0;
  const h = y1 - y0;
  const scale = size / Math.max(w, h);
  const view: View = {
    scale,
    ox: (size - w * scale) / 2 - x0 * scale,
    oy: (size - h * scale) / 2 - y0 * scale,
  };
  render(createContext(canvas), createRig(spec), POSES.neutral, view);
  return canvas;
}

/** A long press on the button must not open a menu. */
function onContextMenu(e: Event): void {
  e.preventDefault();
}

/** Mounts the swap button at the end of `root` (main#app), refreshed once. */
export function mountCharacterSwitch(root: HTMLElement, deps: CharacterSwitchDeps): CharacterSwitch {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'character-switch';
  const thumbs = new Map<CharacterId, HTMLCanvasElement>();
  /** The character the button offers now; null before the first refresh. */
  let offered: CharacterId | null = null;

  const onClick = (): void => {
    deps.choose(OTHER[deps.current()]);
  };
  button.addEventListener('click', onClick);
  button.addEventListener('contextmenu', onContextMenu);

  function refresh(): void {
    button.hidden = deps.state() !== 'Asleep';
    const other = OTHER[deps.current()];
    if (other === offered) return;
    offered = other;
    let thumb = thumbs.get(other);
    if (thumb === undefined) {
      thumb = deps.thumbnail(other, SWITCH_THUMB_PX);
      thumbs.set(other, thumb);
    }
    button.replaceChildren(thumb);
    button.setAttribute('aria-label', CHARACTERS[other].names.switchTo);
  }

  refresh();
  root.append(button);

  return {
    refresh,
    dispose() {
      button.removeEventListener('click', onClick);
      button.removeEventListener('contextmenu', onContextMenu);
      button.remove();
    },
  };
}
