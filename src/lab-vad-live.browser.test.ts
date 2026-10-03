// lab/vad-live's tally (#57, PR #260 review, D15): one arming rule. The page tallies only while the app has booted and
// the debug overlay's trace state is settled; a take counts only if that held at its Listening → Recording, and only
// until it ends; a failed boot locks the tally for good. `boot` is mocked: it hands the page a fake session and leaves
// its own outcome and the overlay's report to each test. Each test loads a fresh copy of the page module (a query on
// its URL), on a fresh #vad-live-app and #tally.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SessionEvent, StateName } from './app/events.ts';
import type { Session, TransitionListener } from './app/session.ts';
import type { BootOptions } from './main.ts';

interface BootCall {
  opts: BootOptions;
  resolve(): void;
  reject(err: unknown): void;
  listener: TransitionListener | null;
}

const h = vi.hoisted(() => ({ boots: [] as BootCall[] }));

vi.mock('./main.ts', () => ({
  boot: (_root: HTMLElement, opts: BootOptions): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const call: BootCall = { opts, resolve, reject, listener: null };
      h.boots.push(call);
      // The page only subscribes to transitions; the rest of the session is never called.
      const session: Session = {
        dispatch: () => {},
        state: () => {
          throw new Error('test: the page reads no session state');
        },
        subscribe: () => () => {},
        addTransitionListener: (cb) => {
          call.listener = cb;
          return () => {};
        },
        addSfxListener: () => () => {},
        subscribeLevel: () => () => {},
        onEngineEvent: () => {},
      };
      opts.onSession?.(session);
    }),
}));

interface Summary {
  app: string;
  overlay: string;
  counts: Record<string, Record<string, number>>;
}

let copies = 0;
let sheets: CSSStyleSheet[] = [];

/** Loads a fresh copy of the page; `debug0` opens it as `?debug=0`. Returns the page's `boot` call. */
async function openPage(debug0 = false): Promise<BootCall> {
  const root = document.createElement('div');
  root.id = 'vad-live-app';
  const tally = document.createElement('section');
  tally.id = 'tally';
  document.body.append(root, tally);
  sheets = [...document.adoptedStyleSheets];
  const url = location.href;
  if (debug0) {
    const u = new URL(url);
    u.searchParams.set('debug', '0');
    history.replaceState(history.state, '', u);
  }
  copies++;
  try {
    await import(/* @vite-ignore */ `../lab/vad-live.ts?copy=${copies}`);
  } finally {
    history.replaceState(history.state, '', url);
  }
  const call = h.boots.at(-1);
  if (call === undefined || call.listener === null)
    throw new Error('test: the page did not boot with a session');
  return call;
}

/** Lets the page's `boot(...).then` handlers run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function isSummary(x: unknown): x is Summary {
  return typeof x === 'object' && x !== null && 'app' in x && 'overlay' in x && 'counts' in x;
}

/** The page's Copy summary JSON, as shown in its `pre`. */
function summary(): Summary {
  const parsed: unknown = JSON.parse(document.querySelector('#tally pre')?.textContent ?? '{}');
  if (!isSummary(parsed)) throw new Error('test: the summary is missing app, overlay or counts');
  return parsed;
}

function quiet(): Record<string, number> {
  const q = summary().counts.quiet;
  if (q === undefined) throw new Error('test: no quiet counts');
  return q;
}

function button(name: string): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll<HTMLButtonElement>('#tally button')).find(
    (x) => x.textContent === name,
  );
  if (b === undefined) throw new Error(`test: no ${name} button`);
  return b;
}

function step(page: BootCall, from: StateName, to: StateName, e: SessionEvent): void {
  page.listener?.(from, to, e, []);
}

const START: SessionEvent = { t: 'seg', epoch: 1, ev: { kind: 'start', frame: 0 } };
const MISFIRE: SessionEvent = { t: 'seg', epoch: 1, ev: { kind: 'misfire', frame: 1 } };
const end = (reason: 'silence' | 'maxLength'): SessionEvent => ({
  t: 'seg',
  epoch: 1,
  ev: { kind: 'end', frame: 2, lastSpeechFrame: 1, reason },
});
const PROCESSED: SessionEvent = { t: 'processed', id: 1, durationSec: 1 };

/** A take after its onset: end of speech (silence or the cap), the replay, the cooldown, back to Listening. */
function finishTake(page: BootCall, reason: 'silence' | 'maxLength'): void {
  step(page, 'Recording', 'Processing', end(reason));
  step(page, 'Processing', 'Playing', PROCESSED);
  step(page, 'Playing', 'Cooldown', { t: 'playbackAtSpeakerEnded', id: 1 });
  step(page, 'Cooldown', 'Listening', { t: 'timer', name: 'cooldown' });
}

function fullTake(page: BootCall, reason: 'silence' | 'maxLength' = 'silence'): void {
  step(page, 'Listening', 'Recording', START);
  finishTake(page, reason);
}

afterEach(() => {
  document.querySelector('#vad-live-app')?.remove();
  document.querySelector('#tally')?.remove();
  document.adoptedStyleSheets = sheets;
  h.boots.length = 0;
  vi.restoreAllMocks();
});

describe('lab/vad-live tally (D15)', () => {
  test('a take that starts while the overlay loads counts nothing, even after it is up; the next take counts', async () => {
    const page = await openPage();
    page.resolve();
    await settle();
    expect(summary().app).toBe('ok');
    expect(summary().overlay).toBe('loading');
    step(page, 'Listening', 'Recording', START);
    page.opts.onDebugOverlay?.(true); // the overlay comes up mid-take
    finishTake(page, 'silence');
    expect(summary().overlay).toBe('on');
    expect(quiet().recordings).toBe(0);
    expect(quiet().completed).toBe(0);
    fullTake(page);
    expect(quiet().recordings).toBe(1);
    expect(quiet().completed).toBe(1);
  });

  test('the marks are disabled while the overlay loads and enabled once it has settled', async () => {
    const page = await openPage();
    page.resolve();
    await settle();
    expect(button('Hit').disabled).toBe(true);
    button('Hit').click();
    expect(quiet().hit).toBe(0);
    page.opts.onDebugOverlay?.(false); // failed is settled too: the trace is off, and the summary says so
    expect(summary().overlay).toBe('failed');
    expect(button('Hit').disabled).toBe(false);
    button('Hit').click();
    expect(quiet().hit).toBe(1);
    button('Undo last mark').click();
    expect(quiet().hit).toBe(0);
  });

  test('a failed boot locks the tally: marks stay disabled, takes are ignored, the summary says app failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = await openPage(true); // overlay off: only the app lock can stop the tally
    page.reject(new Error('test: boot failed'));
    await settle();
    expect(summary().app).toBe('failed');
    expect(summary().overlay).toBe('off');
    expect(button('Hit').disabled).toBe(true);
    button('Hit').click();
    fullTake(page);
    step(page, 'Listening', 'Recording', START);
    step(page, 'Recording', 'Listening', MISFIRE);
    expect(quiet()).toMatchObject({ hit: 0, recordings: 0, completed: 0, misfires: 0 });
    expect(document.querySelector('#tally p')?.textContent).toContain('The app failed to boot');
  });

  test('with ?debug=0 the first take after boot counts, and nothing before boot resolves', async () => {
    const page = await openPage(true);
    expect(summary()).toMatchObject({ app: 'booting', overlay: 'off' });
    expect(button('Hit').disabled).toBe(true);
    fullTake(page); // before boot resolved: not counted
    page.resolve();
    await settle();
    expect(button('Hit').disabled).toBe(false);
    fullTake(page);
    expect(quiet()).toMatchObject({ recordings: 1, completed: 1 });
  });

  test("an armed take's misfire and maxLength end are counted, and each take's end disarms", async () => {
    const page = await openPage(true);
    page.resolve();
    await settle();
    step(page, 'Listening', 'Recording', START);
    step(page, 'Recording', 'Listening', MISFIRE);
    expect(quiet()).toMatchObject({ recordings: 1, misfires: 1, completed: 0 });
    step(page, 'Processing', 'Playing', PROCESSED); // no onset since the misfire: not part of an armed take
    expect(quiet().completed).toBe(0);
    fullTake(page, 'maxLength');
    expect(quiet()).toMatchObject({ recordings: 2, maxLength: 1, completed: 1 });
    step(page, 'Processing', 'Playing', PROCESSED); // the take ended in Listening
    expect(quiet().completed).toBe(1);
  });
});
