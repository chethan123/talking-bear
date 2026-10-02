// Bootstrap and wiring (plan §3.3, §7 M1, §7 M3, §7 M4): platform services, the settings store, the audio
// engine, the session store, the bear (BearView: Juni on the canvas stage, driven by the session's `anim` effects
// and the replay's processed envelope), the M1 text overlays and the M3 settings sheet, with `data-state` on
// main#app for hook-free smoke tests (plan §4.9.3).
import './ui/styles.css';
import { latencyFromQuery, mountBearView, type BearView } from './anim/bear-view.ts';
import type { Overlay, SessionState, StateName } from './app/events.ts';
import { realClock } from './app/clock.ts';
import { initialSessionState, overlayFor } from './app/machine.ts';
import { createSession, type Session } from './app/session.ts';
import { createSettingsStore, presetFor } from './app/settings.ts';
import { createEngine } from './audio/engine.ts';
import { createPlayer } from './audio/player.ts';
import { createSfx, M1_SYNTHS } from './audio/sfx.ts';
import { createMicPermission } from './platform/permissions.ts';
import { createVisibility } from './platform/visibility.ts';
import { createWakeLock } from './platform/wake-lock.ts';
import { mountDebugOverlay } from './ui/debug-overlay.ts';
import { mountOverlay } from './ui/overlay.ts';
import { mountSettingsSheet } from './ui/settings-sheet.ts';

const noop = (): void => {};

/** A developer flag: the `localStorage` value `'1'`. Storage can throw (blocked site data); default false. */
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** `localStorage`, or null where it is missing or reading it throws (blocked site data, sandboxed frames). */
function settingsStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  const app = document.querySelector<HTMLElement>('main#app');
  if (app === null) throw new Error('boot: main#app is missing');

  const clock = realClock;
  const visibility = createVisibility();
  const wakeLock = createWakeLock(navigator, visibility);
  const permission = createMicPermission(navigator, visibility);
  const settings = createSettingsStore(settingsStorage());

  // createEngine takes its event sink before the session exists; the engine emits nothing until an effect has
  // called it, so relaying through `session` loses nothing (Session.onEngineEvent).
  let session: Session | undefined;
  const engine = createEngine({
    connectWorkletOutput: readFlag('bear.connectWorkletOutput'),
    onEvent: (e) => session?.onEngineEvent(e),
  });
  // Quiet mode (plan §4.3.4): the engine builds its master bus with the stored value, so it holds from the
  // first sound, with no ramp.
  engine.setQuiet(settings.get().quietMode);

  const permission0 = await permission.query();
  let showOverlay: (o: Overlay) => void = noop;
  // The bear exists once the UI is mounted below; the session emits no effect before its first event.
  let bear: BearView | null = null;
  session = createSession(initialSessionState(permission0), {
    engine,
    makePlayer: createPlayer,
    makeSfx: (ctx, bus) => createSfx(ctx, bus, M1_SYNTHS),
    wakeLock,
    visibility,
    permission,
    clock,
    onAnim: (ev) => bear?.onAnim(ev),
    onPlayStarted: (id, startCtxTime) => bear?.onPlayStarted(id, startCtxTime),
    onUi: (o) => showOverlay(o),
  });

  // E2E hooks (plan §4.9.3): dead-code-eliminated from production builds, where the flag is unset. Installed
  // before the UI is mounted, so no pointer input can reach the session before the hooks are listening.
  if (import.meta.env.VITE_BEAR_TEST_HOOKS === '1') {
    const { installTestHooks } = await import('./test-hooks.ts');
    installTestHooks({ session, engine, visibility, bear: () => bear });
  }

  const s = session;
  // The bear (plan §7 M4) is the stage: mounted first, so the overlays and the sheet sit above it. Its pointer
  // input keeps the M1 tap behaviour. `?L=<ms>` overrides the display-latency constant for X-A2.
  const view = mountBearView(app, {
    visibility,
    now: () => clock.now(),
    state: () => s.state().name,
    dispatch: (e) => s.dispatch(e),
    engine,
    seed: Math.floor(Math.random() * 2 ** 32),
    latencyMs: latencyFromQuery(location.search),
  });
  bear = view;
  // Reduced motion (plan §4.6.6): the OS setting or the parent's Gentle mode.
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const applyMotion = (): void => view.setReducedMotion(motion.matches || settings.get().gentleMode);
  applyMotion();
  motion.addEventListener('change', applyMotion);

  // Settings (plan §7 M3): the voice preset goes to the reducer now and on every change, Quiet mode to the
  // engine and Gentle mode to the bear on every change. The sheet writes the store and also sets Quiet itself;
  // a repeated setQuiet is idempotent.
  s.dispatch({ t: 'settingsChanged', preset: presetFor(settings.get()) });
  settings.subscribe((st) => {
    s.dispatch({ t: 'settingsChanged', preset: presetFor(st) });
    engine.setQuiet(st.quietMode);
    applyMotion();
  });

  showOverlay = mountOverlay(app, (e) => s.dispatch(e));
  mountSettingsSheet(app, {
    store: settings,
    bus: { setQuiet: (on) => engine.setQuiet(on) },
    state: () => s.state().name,
  });

  // Developer overlay (plan §7 M2, M4): the frame loop's p95 frame time and fps.
  if (new URLSearchParams(location.search).get('debug') === '1') {
    mountDebugOverlay(app, { frameStats: (out) => view.frameStats(out), clock });
  }

  let shown: StateName | null = null;
  const render = (st: SessionState): void => {
    if (st.name === shown) return;
    shown = st.name;
    app.dataset.state = st.name;
  };
  // The initial state produces no `ui` effect and no subscriber call.
  render(s.state());
  showOverlay(overlayFor(s.state()));
  s.subscribe(render);
}

void boot();
