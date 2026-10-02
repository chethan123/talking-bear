// The developer overlay, `?debug=1` (plan §7 M2 "per-frame timings", §7 M4 exit criteria; issues #56, #81). This
// is its frame-loop part (#81): the main-thread time per drawn frame (p95 over the last 120 drawn frames) and the
// current fps, read from the bear's frame loop four times a second. #56 adds the VAD plot and lines. #98 adds the
// storage line (plan §4.7 "Offline guarantees"): `navigator.storage.persisted()` and `estimate()`, read every 5 s.
//
// CSP `style-src 'self'` (plan §4.8.3): the DOM is built with createElement/textContent only and nothing sets a
// `style` attribute; the look is in styles.css (`.debug-overlay`). It allocates a string per refresh, never per
// animation frame.

import type { Clock } from '../app/clock.ts';
import type { FrameStats } from '../anim/loop.ts';
import type { StorageApi, StorageUsage } from '../platform/storage.ts';

/** How often the text is refreshed, in ms. */
export const DEBUG_REFRESH_MS = 250;
/** How often the storage line is refreshed, in ms: it changes slowly and each read is an async browser call. */
export const DEBUG_STORAGE_REFRESH_MS = 5000;

export interface DebugOverlayDeps {
  /** The frame loop's stats (`BearView.frameStats`). */
  frameStats(out: FrameStats): FrameStats;
  clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
  /** Storage persistence and usage (#98); without it there is no storage line. */
  storage?: Pick<StorageApi, 'persisted' | 'estimate'>;
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

/** "storage persisted yes · 870 / 1953125 KB" (usage / quota); "?" and dashes where the API is missing. */
export function formatStorage(persisted: boolean | null, usage: StorageUsage | null): string {
  const p = persisted === null ? '?' : persisted ? 'yes' : 'no';
  const kb =
    usage === null ? '– / – KB' : `${Math.round(usage.usage / 1024)} / ${Math.round(usage.quota / 1024)} KB`;
  return `storage persisted ${p} · ${kb}`;
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

  // ---- storage line (#98) ----
  let storageTimer: number | null = null;
  const { storage } = deps;
  if (storage !== undefined) {
    const storageLine = document.createElement('p');
    storageLine.className = 'debug-line';
    storageLine.textContent = formatStorage(null, null);
    box.append(storageLine);
    const refreshStorage = async (): Promise<void> => {
      const [persisted, usage] = await Promise.all([storage.persisted(), storage.estimate()]);
      if (live) storageLine.textContent = formatStorage(persisted, usage);
    };
    const scheduleStorage = (): void => {
      storageTimer = deps.clock.setTimeout(() => {
        if (!live) return;
        void refreshStorage();
        scheduleStorage();
      }, DEBUG_STORAGE_REFRESH_MS);
    };
    void refreshStorage();
    scheduleStorage();
  }

  return {
    refresh,
    dispose() {
      live = false;
      deps.clock.clearTimeout(timer);
      if (storageTimer !== null) deps.clock.clearTimeout(storageTimer);
      box.remove();
    },
  };
}
