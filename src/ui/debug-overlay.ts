// The developer overlay, `?debug=1` (plan §7 M2 "per-frame timings", §7 M4 exit criteria; issues #56, #81). This
// is its frame-loop part (#81): the main-thread time per drawn frame (p95 over the last 120 drawn frames) and the
// current fps, read from the bear's frame loop four times a second. #56 adds the VAD plot and lines.
//
// CSP `style-src 'self'` (plan §4.8.3): the DOM is built with createElement/textContent only and nothing sets a
// `style` attribute; the look is in styles.css (`.debug-overlay`). It allocates a string per refresh, never per
// animation frame.

import type { Clock } from '../app/clock.ts';
import type { FrameStats } from '../anim/loop.ts';

/** How often the text is refreshed, in ms. */
export const DEBUG_REFRESH_MS = 250;

export interface DebugOverlayDeps {
  /** The frame loop's stats (`BearView.frameStats`). */
  frameStats(out: FrameStats): FrameStats;
  clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
}

export interface DebugOverlay {
  /** Refreshes the text now. */
  refresh(): void;
  /** Stops refreshing and removes the overlay. */
  dispose(): void;
}

/** "frame p95 1.8 ms · 60 fps"; dashes before there are numbers. */
export function formatFrameStats(s: FrameStats): string {
  const p95 = Number.isFinite(s.p95Ms) ? `${s.p95Ms.toFixed(1)} ms` : '– ms';
  const fps = Number.isFinite(s.fps) ? `${Math.round(s.fps)} fps` : '– fps';
  return `frame p95 ${p95} · ${fps}`;
}

export function mountDebugOverlay(root: HTMLElement, deps: DebugOverlayDeps): DebugOverlay {
  const box = document.createElement('div');
  box.className = 'debug-overlay';
  const frames = document.createElement('p');
  frames.className = 'debug-line';
  box.append(frames);
  root.append(box);

  const stats: FrameStats = { p95Ms: Number.NaN, fps: Number.NaN, frames: 0 };
  let timer = 0;
  let live = true;

  function refresh(): void {
    frames.textContent = formatFrameStats(deps.frameStats(stats));
  }

  function schedule(): void {
    timer = deps.clock.setTimeout(() => {
      if (!live) return;
      refresh();
      schedule();
    }, DEBUG_REFRESH_MS);
  }

  refresh();
  schedule();

  return {
    refresh,
    dispose() {
      live = false;
      deps.clock.clearTimeout(timer);
      box.remove();
    },
  };
}
