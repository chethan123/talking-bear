// Bootstrap and wiring (plan §3.3, §7 M1): platform services, the audio engine, the session store and the M1
// placeholder UI (canvas circle + text overlays), with `data-state` on main#app for hook-free smoke tests
// (plan §4.9.3).
import './ui/styles.css';
import type { Overlay, SessionState, StateName } from './app/events.ts';
import { realClock } from './app/clock.ts';
import { initialSessionState, overlayFor } from './app/machine.ts';
import { createSession, type Session } from './app/session.ts';
import { createEngine } from './audio/engine.ts';
import { createPlayer } from './audio/player.ts';
import { createSfx, M1_SYNTHS } from './audio/sfx.ts';
import { createMicPermission } from './platform/permissions.ts';
import { createVisibility } from './platform/visibility.ts';
import { createWakeLock } from './platform/wake-lock.ts';
import { mountCircle } from './ui/circle.ts';
import { mountOverlay } from './ui/overlay.ts';

const noop = (): void => {};

/** A developer flag: the `localStorage` value `'1'`. Storage can throw (blocked site data); default false. */
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  const app = document.querySelector<HTMLElement>('main#app');
  if (app === null) throw new Error('boot: main#app is missing');

  const clock = realClock;
  const visibility = createVisibility();
  const wakeLock = createWakeLock(navigator, visibility);
  const permission = createMicPermission(navigator, visibility);

  // createEngine takes its event sink before the session exists; the engine emits nothing until an effect has
  // called it, so relaying through `session` loses nothing (Session.onEngineEvent).
  let session: Session | undefined;
  const engine = createEngine({
    connectWorkletOutput: readFlag('bear.connectWorkletOutput'),
    onEvent: (e) => session?.onEngineEvent(e),
  });

  const permission0 = await permission.query();
  let showOverlay: (o: Overlay) => void = noop;
  session = createSession(initialSessionState(permission0), {
    engine,
    makePlayer: createPlayer,
    makeSfx: (ctx, bus) => createSfx(ctx, bus, M1_SYNTHS),
    wakeLock,
    visibility,
    permission,
    clock,
    onUi: (o) => showOverlay(o),
  });

  const s = session;
  const circle = mountCircle(app, {
    visibility,
    now: () => clock.now(),
    state: () => s.state().name,
    dispatch: (e) => s.dispatch(e),
  });
  showOverlay = mountOverlay(app, (e) => s.dispatch(e));

  let shown: StateName | null = null;
  const render = (st: SessionState): void => {
    if (st.name === shown) return;
    shown = st.name;
    app.dataset.state = st.name;
    circle.setState(st.name);
  };
  // The initial state produces no `ui` effect and no subscriber call.
  render(s.state());
  showOverlay(overlayFor(s.state()));
  s.subscribe(render);
  s.subscribeLevel((e) => {
    if (e.t === 'level') circle.setLevel(e.db);
  });
}

void boot();
