// Bootstrap and wiring (plan §3.3, §7 M1, §7 M3, §7 M4, §7 M5, §7 M6): platform services, the settings store, the
// audio engine, the service worker and install prompt (pwa/register.ts), the session store, the haptics, the bear
// (BearView: Juni on the canvas stage, driven by the session's `anim` effects and the replay's processed envelope,
// and touched through the pointer input: adapter → recogniser → reactions table → director → session), the M1 text
// overlays and the settings sheet (M3, M8: behind a 1 s press of the gear), with `data-state` on main#app for
// hook-free smoke tests (plan §4.9.3).
import './ui/styles.css';
import { latencyFromQuery, mountBearView, type BearView } from './anim/bear-view.ts';
import type { Overlay, SessionState, StateName } from './app/events.ts';
import { realClock } from './app/clock.ts';
import { initialSessionState, overlayFor } from './app/machine.ts';
import { createSession, type Session } from './app/session.ts';
import { createSettingsStore, presetFor } from './app/settings.ts';
import { createEngine } from './audio/engine.ts';
import { createPlayer } from './audio/player.ts';
import { createSfx } from './audio/sfx.ts';
import { SYNTHS } from './audio/sfx-synths.ts';
import { createHaptics } from './platform/haptics.ts';
import { createMicPermission } from './platform/permissions.ts';
import { createStorage } from './platform/storage.ts';
import { createVisibility } from './platform/visibility.ts';
import { createWakeLock } from './platform/wake-lock.ts';
import { setupPwa } from './pwa/register.ts';
import { mountOverlay } from './ui/overlay.ts';
import { mountSettingsSheet, type SettingsSheet } from './ui/settings-sheet.ts';

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

/** What `boot` takes besides its root (#57). */
export interface BootOptions {
  /** Mounts the developer overlay. Default: the `?debug=1` query. */
  debug?: boolean;
  /** Called with the session as soon as it exists, before its first event (lab/vad-live's tally). */
  onSession?(s: Session): void;
  /**
   * With the overlay: called once it is up (`true`: it has turned the worker's feature trace on) or has failed to
   * load or mount (`false`: the trace is off), so a caller reports what actually ran (lab/vad-live's pre-gate).
   */
  onDebugOverlay?(mounted: boolean): void;
}

/**
 * Mounts the developer overlay once its module has loaded (#57) and reports whether it is up: `true` once `mount`
 * has returned (the overlay has turned the worker's feature trace on), `false` if the module failed to load
 * (`null`) or `mount` threw. A mount that threw after turning the trace on has it turned off again, so `false` always
 * means the trace is off. Nothing waits for it, and a `report` that throws is logged.
 */
export function mountDebugOverlayWhenLoaded<M>(
  module: Promise<M | null>,
  mount: (m: M) => void,
  trace: { setTrace(on: boolean): void },
  report: (mounted: boolean) => void,
): void {
  void module
    .then((m) => {
      if (m === null) return false;
      mount(m);
      return true;
    })
    .catch((err: unknown) => {
      console.error('debug overlay failed to mount', err);
      trace.setTrace(false); // a mount that threw after turning the trace on: nothing reads the trace
      return false;
    })
    .then(report)
    .catch((err: unknown) => console.error('onDebugOverlay threw', err));
}

/** Boots the app into `app`, its root element (index.html: main#app), which gets `data-state`. */
export async function boot(app: HTMLElement, opts: BootOptions = {}): Promise<void> {
  // The developer overlay (mounted below) is loaded on demand (#57), its fetch started here. A failed load is
  // handled here, at once: the mount below is reached only after `await`s.
  const wantDebug = opts.debug ?? new URLSearchParams(location.search).get('debug') === '1';
  const overlayModule = wantDebug
    ? import('./ui/debug-overlay.ts').catch((err: unknown) => {
        console.error('debug overlay failed to load', err);
        return null;
      })
    : null;
  const clock = realClock;
  const visibility = createVisibility();
  const wakeLock = createWakeLock(navigator, visibility);
  const permission = createMicPermission(navigator, visibility);
  const settings = createSettingsStore(settingsStorage());
  const storage = createStorage(navigator);
  // Haptics (plan §4.6.3): the reactions' patterns, gated by the setting and by sticky activation. The latest
  // `vibrate` log line (X-A6) is kept for the debug overlay.
  let lastVibrate: string | null = null;
  const haptics = createHaptics(
    navigator,
    () => settings.get().haptics,
    (m) => {
      lastVibrate = m;
    },
  );

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

  // The service worker and the install prompt (plan §4.5, §4.7), set up before the first await so the
  // `beforeinstallprompt` listener is in place early. `updateReady` is relayed to the session once it exists
  // (caught up below), and both PWA signals refresh the settings sheet's Install and restart buttons.
  let sheet: SettingsSheet | null = null;
  let installAvailable = false;
  const pwa = setupPwa({
    dispatch: (e) => {
      session?.dispatch(e);
      sheet?.refreshPwa();
    },
    visibility,
    clock,
    storage,
    onInstallAvailable: (available) => {
      installAvailable = available;
      sheet?.refreshPwa();
    },
  });

  const permission0 = await permission.query();
  let showOverlay: (o: Overlay) => void = noop;
  // The bear exists once the UI is mounted below; the session emits no effect before its first event.
  let bear: BearView | null = null;
  session = createSession(initialSessionState(permission0), {
    engine,
    makePlayer: createPlayer,
    // Every reaction sound of plan §4.6.4 (#88), synthesised.
    makeSfx: (ctx, bus) => createSfx(ctx, bus, SYNTHS),
    wakeLock,
    visibility,
    permission,
    clock,
    onAnim: (ev) => bear?.onAnim(ev),
    onPlayStarted: (id, startCtxTime) => bear?.onPlayStarted(id, startCtxTime),
    // M8 (#113): read at every dispatch: the sleep timeout (next timer start) and noisy-room NS (next mic open).
    settings: () => settings.get(),
    onUi: (o) => showOverlay(o),
    // Row 38: on a hide that leaves the session Asleep or Paused with an update ready, activate it synchronously.
    onApplyUpdate: () => pwa.applyUpdate(),
  });
  opts.onSession?.(session);
  // An update found before the session existed (its relayed dispatch was dropped).
  if (pwa.updateReady()) session.dispatch({ t: 'updateReady' });

  // E2E hooks (plan §4.9.3): dead-code-eliminated from production builds, where the flag is unset. Installed
  // before the UI is mounted, so no pointer input can reach the session before the hooks are listening.
  if (import.meta.env.VITE_BEAR_TEST_HOOKS === '1') {
    const { installTestHooks } = await import('./test-hooks.ts');
    installTestHooks({ session, engine, visibility, bear: () => bear });
  }

  const s = session;
  // The bear (plan §7 M4) is the stage: mounted first, so the overlays and the sheet sit above it. `?L=<ms>`
  // overrides the display-latency constant for X-A2. Its pointer input (plan §7 M5, #93) routes by the session
  // state: in Asleep, Error and Paused a tap anywhere dispatches `tapBear`; while awake (MicDenied included) the
  // gestures go to the director, whose `toSession` reactions come back through `dispatch` (session.dispatch),
  // `haptic` patterns go to `haptics.play` and `mood` to its mood layer; the last pointer up and a stroke or
  // long-press end release the director; background touches move the gaze; pointerdown / pointerup note the
  // haptics' activation (bear-view.ts).
  const view = mountBearView(app, {
    visibility,
    now: () => clock.now(),
    state: () => s.state().name,
    dispatch: (e) => s.dispatch(e),
    engine,
    haptics,
    seed: Math.floor(Math.random() * 2 ** 32),
    latencyMs: latencyFromQuery(location.search),
  });
  bear = view;
  // Reduced motion (plan §4.6.6): the OS setting or the parent's Gentle mode; it also sets the director's gentle
  // flag (gentle clips, no P4 escalation without one: plan §4.6.4).
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const applyMotion = (): void => view.setReducedMotion(motion.matches || settings.get().gentleMode);
  applyMotion();
  motion.addEventListener('change', applyMotion);

  // Settings (plan §7 M3, M8): the voice preset goes to the reducer now and on every change, Quiet mode to the
  // engine and Gentle mode to the bear on every change. The sheet writes the store and also sets Quiet itself;
  // a repeated setQuiet is idempotent. Haptics, the sleep timeout and noisy-room NS are read where they are used
  // (createHaptics above, the session's `settings`).
  s.dispatch({ t: 'settingsChanged', preset: presetFor(settings.get()) });
  settings.subscribe((st) => {
    s.dispatch({ t: 'settingsChanged', preset: presetFor(st) });
    engine.setQuiet(st.quietMode);
    applyMotion();
  });

  showOverlay = mountOverlay(app, (e) => s.dispatch(e));
  sheet = mountSettingsSheet(app, {
    store: settings,
    bus: { setQuiet: (on) => engine.setQuiet(on) },
    state: () => s.state().name,
    // #114: "Try the microphone again" (For parents) dispatches `settingsRetry`; the sheet mounts the licences view.
    dispatch: (e) => s.dispatch(e),
    now: () => clock.now(),
    pwa: {
      installAvailable: () => installAvailable,
      promptInstall: () => pwa.promptInstall(),
      updateReady: () => pwa.updateReady(),
      applyUpdate: () => pwa.applyUpdate(),
    },
  });

  // Developer overlay (plan §7 M2, M4, M5, M6): the frame loop's p95 frame time and fps, storage persistence and
  // usage, the device lines (#93: the latest vibrate result, ctx.state, the mic track's events, the audio inputs),
  // and the live VAD plot and lines (#56; the worker's feature trace is on while it is mounted). It is loaded on
  // demand and nothing waits for it (#57): its code, and the energy gate it replays, stay out of the initial bundle.
  if (overlayModule !== null) {
    mountDebugOverlayWhenLoaded(
      overlayModule,
      (m) =>
        m.mountDebugOverlay(app, {
          frameStats: (out) => view.frameStats(out),
          clock,
          storage,
          device: {
            lastVibrate: () => lastVibrate,
            engine,
            session: s,
            mediaDevices: 'mediaDevices' in navigator ? navigator.mediaDevices : null,
            now: () => clock.now(),
          },
          vad: { engine, session: s },
        }),
      engine,
      (mounted) => opts.onDebugOverlay?.(mounted),
    );
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

// index.html's entry. lab/vad-live has no main#app: it imports `boot` and calls it on its own root.
const appRoot = document.querySelector<HTMLElement>('main#app');
if (appRoot !== null) void boot(appRoot);
