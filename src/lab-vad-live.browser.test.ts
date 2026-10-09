// lab/vad-live's tally (#57, PR #260 review, D15, D16): one arming rule. The page tallies only while the app has
// booted and the debug overlay's trace state is settled; a listen is clean if its `arm` effect came under that rule;
// a take counts only if it started in a clean listen, into the condition selected then, and only until it ends; the
// marks open at the first clean listen and close while an unarmed take is the latest phrase; a failed boot locks the
// tally for good. `boot` is mocked: it hands the page a fake session and leaves its own outcome and the overlay's
// report to each test. Each test loads a fresh copy of the page module (a query on its URL), on a fresh #vad-live-app
// and #tally.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Effect, SessionEvent, StateName } from './app/events.ts';
import type { LevelEvent, Session, TransitionListener } from './app/session.ts';
import type { BootOptions } from './main.ts';

interface BootCall {
  opts: BootOptions;
  resolve(): void;
  reject(err: unknown): void;
  listener: TransitionListener | null;
  /** The page's level listener (`subscribeLevel`), for the capture-jump tests (#268). */
  level: ((e: LevelEvent) => void) | null;
}

const h = vi.hoisted(() => ({ boots: [] as BootCall[] }));

vi.mock('./main.ts', () => ({
  boot: (_root: HTMLElement, opts: BootOptions): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const call: BootCall = { opts, resolve, reject, listener: null, level: null };
      h.boots.push(call);
      // The page only subscribes to transitions and levels; the rest of the session is never called.
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
        subscribeLevel: (cb) => {
          call.level = cb;
          return () => {};
        },
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

function step(page: BootCall, from: StateName, to: StateName, e: SessionEvent, effects: Effect[] = []): void {
  page.listener?.(from, to, e, effects);
}

/** Every entry into Listening carries the session's `arm` effect (machine.ts entryActions): a new listen. */
const ARM: Effect[] = [{ k: 'arm', epoch: 1 }];
const START: SessionEvent = { t: 'seg', epoch: 1, ev: { kind: 'start', frame: 0 } };
const MISFIRE: SessionEvent = { t: 'seg', epoch: 1, ev: { kind: 'misfire', frame: 1 } };
const end = (reason: 'silence' | 'maxLength'): SessionEvent => ({
  t: 'seg',
  epoch: 1,
  ev: { kind: 'end', frame: 2, lastSpeechFrame: 1, reason },
});
const PROCESSED: SessionEvent = { t: 'processed', id: 1, durationSec: 1, clipped: false };

/** The wake: Waking → Listening, with the listen's `arm`. */
function wake(page: BootCall): void {
  step(page, 'Waking', 'Listening', { t: 'ctxRunning', sampleRate: 48000 }, ARM);
}

/** A take after its onset: end of speech (silence or the cap), the replay, the cooldown, back to a new listen. */
function finishTake(page: BootCall, reason: 'silence' | 'maxLength'): void {
  step(page, 'Recording', 'Processing', end(reason));
  step(page, 'Processing', 'Playing', PROCESSED);
  step(page, 'Playing', 'Cooldown', { t: 'playbackAtSpeakerEnded', id: 1 });
  step(page, 'Cooldown', 'Listening', { t: 'timer', name: 'cooldown' }, ARM);
}

function fullTake(page: BootCall, reason: 'silence' | 'maxLength' = 'silence'): void {
  step(page, 'Listening', 'Recording', START);
  finishTake(page, reason);
}

/** Opens the page, boots it (and, unless `?debug=0`, settles the overlay as on) and wakes the bear: a clean listen. */
async function livePage(debug0 = false): Promise<BootCall> {
  const page = await openPage(debug0);
  page.resolve();
  await settle();
  if (!debug0) page.opts.onDebugOverlay?.(true);
  wake(page);
  return page;
}

afterEach(() => {
  document.querySelector('#vad-live-app')?.remove();
  document.querySelector('#tally')?.remove();
  document.adoptedStyleSheets = sheets;
  h.boots.length = 0;
  vi.restoreAllMocks();
});

describe('lab/vad-live tally (D15, D16)', () => {
  test('a take that starts while the overlay loads counts nothing, even after it is up; the next take counts', async () => {
    const page = await openPage();
    page.resolve();
    await settle();
    expect(summary().app).toBe('ok');
    expect(summary().overlay).toBe('loading');
    wake(page); // a listen armed while the overlay loads
    step(page, 'Listening', 'Recording', START);
    page.opts.onDebugOverlay?.(true); // the overlay comes up mid-take
    finishTake(page, 'silence'); // back to Listening: a clean listen
    expect(summary().overlay).toBe('on');
    expect(quiet().recordings).toBe(0);
    expect(quiet().completed).toBe(0);
    fullTake(page);
    expect(quiet().recordings).toBe(1);
    expect(quiet().completed).toBe(1);
  });

  test('the overlay settling while the bear listens: that listen is neither counted nor markable; the next is', async () => {
    const page = await openPage();
    page.resolve();
    await settle();
    wake(page); // armed while loading
    page.opts.onDebugOverlay?.(true); // settles mid-listen: this listen is not clean
    expect(button('Hit').disabled).toBe(true);
    step(page, 'Listening', 'Recording', START);
    finishTake(page, 'silence'); // its replay, then a clean listen
    expect(quiet()).toMatchObject({ recordings: 0, completed: 0 });
    step(page, 'Listening', 'Recording', START);
    expect(button('Hit').disabled).toBe(false);
    finishTake(page, 'silence');
    expect(quiet()).toMatchObject({ recordings: 1, completed: 1 });
  });

  test("an excluded take's replay can't be marked: Hit stays disabled until the next armed onset", async () => {
    const page = await openPage(true); // overlay off
    wake(page); // armed while the app was still booting: not clean
    page.resolve();
    await settle();
    step(page, 'Listening', 'Recording', START);
    step(page, 'Recording', 'Processing', end('silence'));
    step(page, 'Processing', 'Playing', PROCESSED);
    expect(button('Hit').disabled).toBe(true); // the excluded phrase is being replayed
    button('Hit').click();
    step(page, 'Playing', 'Cooldown', { t: 'playbackAtSpeakerEnded', id: 1 });
    step(page, 'Cooldown', 'Listening', { t: 'timer', name: 'cooldown' }, ARM);
    expect(button('Hit').disabled).toBe(true); // a clean listen, but the latest phrase is still the excluded one
    step(page, 'Listening', 'Recording', START);
    expect(button('Hit').disabled).toBe(false);
    button('Hit').click();
    expect(quiet()).toMatchObject({ hit: 1, recordings: 1 });
  });

  test('a Listening → Listening stay (no arm effect) does not make the listen clean', async () => {
    const page = await openPage();
    page.resolve();
    await settle();
    wake(page); // armed while loading
    page.opts.onDebugOverlay?.(true);
    step(page, 'Listening', 'Listening', { t: 'timer', name: 'doze' }); // a stay: no re-arm
    fullTake(page);
    expect(quiet()).toMatchObject({ recordings: 0, completed: 0 });
    fullTake(page); // after the arm at the end of that take
    expect(quiet()).toMatchObject({ recordings: 1, completed: 1 });
  });

  test("a take's counts go to the condition selected when it started; marks to the one selected when pressed", async () => {
    const page = await livePage();
    step(page, 'Listening', 'Recording', START);
    const fan = document.querySelector<HTMLInputElement>('#tally input[value="fan"]');
    if (fan === null) throw new Error('test: no fan radio');
    fan.click(); // the fan goes on mid-take
    finishTake(page, 'maxLength');
    button('Hit').click();
    expect(quiet()).toMatchObject({ recordings: 1, completed: 1, maxLength: 1, hit: 0 });
    expect(summary().counts.fan).toMatchObject({ recordings: 0, completed: 0, maxLength: 0, hit: 1 });
  });

  test('the marks are disabled while the overlay loads and enabled once it has settled and the bear listens', async () => {
    const page = await openPage();
    page.resolve();
    await settle();
    expect(button('Hit').disabled).toBe(true);
    button('Hit').click();
    expect(quiet().hit).toBe(0);
    page.opts.onDebugOverlay?.(false); // failed is settled too: the trace is off, and the summary says so
    expect(summary().overlay).toBe('failed');
    wake(page);
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
    wake(page);
    expect(button('Hit').disabled).toBe(true);
    button('Hit').click();
    fullTake(page);
    step(page, 'Listening', 'Recording', START);
    step(page, 'Recording', 'Listening', MISFIRE, ARM);
    expect(quiet()).toMatchObject({ hit: 0, recordings: 0, completed: 0, misfires: 0 });
    expect(document.querySelector('#tally p')?.textContent).toContain('The app failed to boot');
  });

  test('with ?debug=0 the first listen after boot counts, and nothing before boot resolves', async () => {
    const page = await openPage(true);
    expect(summary()).toMatchObject({ app: 'booting', overlay: 'off' });
    expect(button('Hit').disabled).toBe(true);
    fullTake(page); // before boot resolved: not counted (and its re-arm is not clean either)
    page.resolve();
    await settle();
    wake(page);
    fullTake(page);
    expect(quiet()).toMatchObject({ recordings: 1, completed: 1 });
    expect(button('Hit').disabled).toBe(false); // the latest phrase is an armed take
  });

  test("an armed take's misfire and maxLength end are counted, and each take's end disarms", async () => {
    const page = await livePage(true);
    step(page, 'Listening', 'Recording', START);
    step(page, 'Recording', 'Listening', MISFIRE, ARM);
    expect(quiet()).toMatchObject({ recordings: 1, misfires: 1, completed: 0 });
    step(page, 'Processing', 'Playing', PROCESSED); // no onset since the misfire: not part of an armed take
    expect(quiet().completed).toBe(0);
    fullTake(page, 'maxLength');
    expect(quiet()).toMatchObject({ recordings: 2, maxLength: 1, completed: 1 });
    step(page, 'Processing', 'Playing', PROCESSED); // the take ended in Listening
    expect(quiet().completed).toBe(1);
  });
});

// ---- capture jumps (#268) -------------------------------------------------------------------------------------------
// At 48 kHz one level interval is 1440 ctx frames (a level every third 10 ms hop), and the jump rule's limit is
// 1440 + 24000 (Math.round(48000 / 2)); at 44.1 kHz, 1323 + 22050. The pre-roll is 300 ms: 14400 frames at 48 kHz.

/** One `level` event of `epoch` at ctx `frame`. */
function level(page: BootCall, epoch: number, frame: number): void {
  page.level?.({ t: 'level', epoch, frame, db: -30, floorDb: -60 });
}

/** `n` contiguous level events of `epoch` from `first`, 1440 frames apart; returns the last one's frame. */
function levels(page: BootCall, epoch: number, first: number, n: number): number {
  for (let i = 0; i < n; i++) level(page, epoch, first + i * 1440);
  return first + (n - 1) * 1440;
}

const segStart = (epoch: number, frame: number): SessionEvent => ({
  t: 'seg',
  epoch,
  ev: { kind: 'start', frame },
});
const segEnd = (epoch: number, frame: number): SessionEvent => ({
  t: 'seg',
  epoch,
  ev: { kind: 'end', frame, lastSpeechFrame: frame - 28_800, reason: 'silence' },
});
const segMisfire = (epoch: number, frame: number): SessionEvent => ({
  t: 'seg',
  epoch,
  ev: { kind: 'misfire', frame },
});
const arm = (epoch: number): Effect[] => [{ k: 'arm', epoch }];

/** The replay of a take that ended in Processing, the cooldown, and a new listen armed as `epoch`. */
function replay(page: BootCall, epoch: number): void {
  step(page, 'Processing', 'Playing', PROCESSED);
  step(page, 'Playing', 'Cooldown', { t: 'playbackAtSpeakerEnded', id: 1 });
  step(page, 'Cooldown', 'Listening', { t: 'timer', name: 'cooldown' }, arm(epoch));
}

/** A whole take of `epoch` from its onset at `onset`, with contiguous levels, then a new listen as `epoch + 1`. */
function cleanTake(page: BootCall, epoch: number, onset: number): void {
  step(page, 'Listening', 'Recording', segStart(epoch, onset));
  const last = levels(page, epoch, onset + 1440, 40);
  step(page, 'Recording', 'Processing', segEnd(epoch, last + 1440));
  level(page, epoch, last + 1440);
  replay(page, epoch + 1);
}

describe('lab/vad-live capture jumps (#268)', () => {
  test('a jump during an armed take: the jump is counted, the take excluded and its replay unmarkable; the next take counts', async () => {
    const page = await livePage(); // epoch 1, 48 kHz
    let f = levels(page, 1, 0, 20);
    step(page, 'Listening', 'Recording', segStart(1, f));
    expect(quiet().recordings).toBe(1); // counted at the onset, as before
    f = levels(page, 1, f + 1440, 30);
    step(page, 'Recording', 'Processing', segEnd(1, f)); // the gap end comes just before the first level after the gap
    level(page, 1, f + 1440 + 96_000); // a 2 s re-anchor
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 0, completed: 0 });
    expect(document.querySelector('#count-quiet-captureJumps')?.textContent).toBe('1');
    expect(button('Hit').disabled).toBe(true);
    expect(document.querySelector('#tally p')?.textContent).toContain('A capture jump');
    replay(page, 2);
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 0, completed: 0 });
    expect(button('Hit').disabled).toBe(true);
    step(page, 'Listening', 'Recording', segStart(2, 500_000));
    expect(button('Hit').disabled).toBe(false);
    const last = levels(page, 2, 501_440, 40);
    step(page, 'Recording', 'Processing', segEnd(2, last + 1440));
    level(page, 2, last + 1440);
    replay(page, 3);
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 1, completed: 1 });
  });

  test('the jump rule: one level interval plus Math.round(sampleRate / 2) is no jump, one frame more is; epochs apart', async () => {
    const page = await livePage(); // 48 kHz
    level(page, 1, 0);
    level(page, 1, 1439);
    level(page, 1, 2880); // ±1 rounding
    level(page, 1, 2880 + 25_440); // exactly the limit
    expect(quiet().captureJumps).toBe(0);
    level(page, 1, 2880 + 25_440 + 25_441); // one frame more
    expect(quiet().captureJumps).toBe(1);
    level(page, 2, 10_000_000); // the next epoch's first level: not compared with epoch 1's
    expect(quiet().captureJumps).toBe(1);
    // A context at 44.1 kHz: the limit is 1323 + 22050.
    step(page, 'Listening', 'Listening', { t: 'ctxRunning', sampleRate: 44_100 });
    level(page, 2, 10_000_000 + 23_373);
    expect(quiet().captureJumps).toBe(1);
    level(page, 2, 10_000_000 + 23_373 + 23_374);
    expect(quiet().captureJumps).toBe(2);
  });

  test('a misfire at a jump is excluded too (no recordings, no misfires); the next take counts', async () => {
    const page = await livePage(true);
    let f = levels(page, 1, 0, 20);
    step(page, 'Listening', 'Recording', segStart(1, f));
    f = levels(page, 1, f + 1440, 5);
    step(page, 'Recording', 'Listening', { t: 'seg', epoch: 1, ev: { kind: 'misfire', frame: f } }, arm(2));
    expect(quiet()).toMatchObject({ recordings: 1, misfires: 1 });
    level(page, 1, f + 1440 + 48_000); // the first level after a 1 s re-anchor, of the misfire's epoch
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 0, misfires: 0 });
    expect(button('Hit').disabled).toBe(true);
    cleanTake(page, 2, 300_000);
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 1, completed: 1, misfires: 0 });
    expect(button('Hit').disabled).toBe(false);
  });

  test('a jump while listening: counted, excluding nothing; a take whose pre-roll reaches back over it is excluded', async () => {
    const page = await livePage();
    const f = levels(page, 1, 0, 20);
    const after = f + 1440 + 96_000; // the first level after a 2 s re-anchor
    level(page, 1, after);
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 0 });
    expect(button('Hit').disabled).toBe(false); // no phrase was cut
    levels(page, 1, after + 1440, 5);
    step(page, 'Listening', 'Recording', segStart(1, after + 14_399)); // pre-roll from after − 1: over the gap
    expect(quiet().recordings).toBe(0);
    expect(button('Hit').disabled).toBe(true);
    step(page, 'Recording', 'Processing', segEnd(1, after + 100_000));
    replay(page, 2);
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 0, completed: 0 });
    // In epoch 2, a take whose pre-roll starts exactly at the first level after a jump counts.
    const g = levels(page, 2, 1_000_000, 20);
    const after2 = g + 1440 + 96_000;
    level(page, 2, after2);
    step(page, 'Listening', 'Recording', segStart(2, after2 + 14_400));
    expect(button('Hit').disabled).toBe(false);
    step(page, 'Recording', 'Processing', segEnd(2, after2 + 100_000));
    replay(page, 3);
    expect(quiet()).toMatchObject({ captureJumps: 2, recordings: 1, completed: 1 });
  });

  test('a take whose segment ended before a jump keeps its counts: the next level of its epoch closes it', async () => {
    const page = await livePage();
    let f = levels(page, 1, 0, 20);
    step(page, 'Listening', 'Recording', segStart(1, f));
    f = levels(page, 1, f + 1440, 30);
    step(page, 'Recording', 'Processing', segEnd(1, f + 1440));
    f = levels(page, 1, f + 1440, 2); // contiguous: the segment ended before any gap
    level(page, 1, f + 1440 + 96_000); // a later jump in the same epoch
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 1 });
    replay(page, 2);
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 1, completed: 1 });
    expect(button('Hit').disabled).toBe(false);
  });

  test("jumps count only while the tally is live (D15), into the excluded take's condition or else the selected one", async () => {
    const page = await openPage();
    page.resolve();
    await settle();
    wake(page); // the overlay is still loading
    level(page, 1, 0);
    level(page, 1, 100_000);
    expect(quiet().captureJumps).toBe(0);
    page.opts.onDebugOverlay?.(true);
    step(page, 'Listening', 'Listening', { t: 'timer', name: 'doze' }); // a stay: no re-arm
    level(page, 1, 200_000);
    expect(quiet().captureJumps).toBe(1); // a capture event, not a phrase: no clean listen needed
    step(page, 'Listening', 'Listening', { t: 'ctxRunning', sampleRate: 48_000 }, arm(2)); // a clean listen
    const f = levels(page, 2, 300_000, 5);
    step(page, 'Listening', 'Recording', segStart(2, f));
    const fan = document.querySelector<HTMLInputElement>('#tally input[value="fan"]');
    if (fan === null) throw new Error('test: no fan radio');
    fan.click(); // the fan goes on mid-take
    step(page, 'Recording', 'Processing', segEnd(2, f + 1440));
    level(page, 2, f + 1440 + 96_000);
    expect(quiet()).toMatchObject({ captureJumps: 2, recordings: 0 });
    expect(summary().counts.fan).toMatchObject({ captureJumps: 0, recordings: 0 });
    replay(page, 3);
    level(page, 3, 1_000_000);
    level(page, 3, 1_100_000); // a jump while listening, in fan
    expect(summary().counts.fan).toMatchObject({ captureJumps: 1 });
  });

  test('a misfire at a jump re-arms: the rest of the phrase, whose pre-roll reaches back over the jump, is excluded too', async () => {
    const page = await livePage(true);
    let f = levels(page, 1, 0, 20);
    step(page, 'Listening', 'Recording', segStart(1, f));
    f = levels(page, 1, f + 1440, 5);
    step(page, 'Recording', 'Listening', segMisfire(1, f), arm(2)); // the gap misfire re-arms at once
    // The real order: the worker posts the gap misfire, then the first post-gap level (still epoch 1); the session
    // runs the misfire's transition, with its re-arm, before that level reaches the page.
    const after = f + 1440 + 48_000; // the first level after a 1 s re-anchor
    level(page, 1, after);
    levels(page, 2, after + 2880, 3);
    step(page, 'Listening', 'Recording', segStart(2, after + 7200)); // the rest of the phrase, 150 ms on
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 0, misfires: 0 });
    expect(button('Hit').disabled).toBe(true);
    expect(document.querySelector('#tally p')?.textContent).toContain('A capture jump');
    step(page, 'Recording', 'Listening', segMisfire(2, after + 30_000), arm(3));
    expect(quiet()).toMatchObject({ recordings: 0, misfires: 0 });
    // A second cut phrase, in epoch 3; then a phrase whose pre-roll starts exactly at the first level after the jump.
    let g = levels(page, 3, after + 100_000, 20);
    step(page, 'Listening', 'Recording', segStart(3, g));
    g = levels(page, 3, g + 1440, 5);
    step(page, 'Recording', 'Listening', segMisfire(3, g), arm(4));
    const after2 = g + 1440 + 48_000;
    level(page, 3, after2);
    step(page, 'Listening', 'Recording', segStart(4, after2 + 14_400));
    expect(button('Hit').disabled).toBe(false);
    expect(quiet()).toMatchObject({ captureJumps: 2, recordings: 1, misfires: 0 });
  });

  test('a new AudioContext forgets the latest jump: an onset at a low frame after it counts', async () => {
    const page = await livePage();
    level(page, 1, 900_000);
    level(page, 1, 1_000_000); // a jump while listening: the first level after it is at frame 1 000 000
    expect(quiet().captureJumps).toBe(1);
    step(page, 'Listening', 'Listening', { t: 'ctxRunning', sampleRate: 48_000 }); // the frames restart (no re-arm)
    levels(page, 2, 30_000, 10);
    step(page, 'Listening', 'Recording', segStart(2, 50_000));
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 1 });
    expect(button('Hit').disabled).toBe(false);
  });

  test("an exclusion takes back only the excluded take's counts, not an earlier take's", async () => {
    const page = await livePage();
    cleanTake(page, 1, 100_000); // counted, then a new listen as epoch 2
    expect(quiet()).toMatchObject({ recordings: 1, completed: 1 });
    let f = levels(page, 2, 500_000, 20);
    step(page, 'Listening', 'Recording', segStart(2, f));
    f = levels(page, 2, f + 1440, 30);
    step(page, 'Recording', 'Processing', segEnd(2, f));
    level(page, 2, f + 1440 + 96_000); // a 2 s re-anchor cuts the armed epoch-2 take
    replay(page, 3);
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 1, completed: 1 });
  });

  test('a jump seen before the tally is live is not remembered: an onset within 300 ms after it counts', async () => {
    const page = await openPage();
    page.resolve();
    await settle();
    wake(page); // the overlay is still loading: not tallying
    level(page, 1, 900_000);
    level(page, 1, 1_000_000); // a jump before tallying starts
    page.opts.onDebugOverlay?.(true);
    step(page, 'Listening', 'Listening', { t: 'timer', name: 'doze' }, arm(2)); // a clean re-arm
    step(page, 'Listening', 'Recording', segStart(2, 1_007_200)); // 150 ms after the first level after the jump
    expect(quiet()).toMatchObject({ captureJumps: 0, recordings: 1 });
    expect(button('Hit').disabled).toBe(false);
  });

  test("an input reselection forgets the latest jump: the new input's first onset within 300 ms counts", async () => {
    const page = await livePage();
    level(page, 1, 900_000);
    level(page, 1, 1_000_000); // a jump while listening, counted
    expect(quiet().captureJumps).toBe(1);
    step(page, 'Listening', 'Waking', { t: 'inputsChanged' }, [{ k: 'closeMic' }, { k: 'reselectInput' }]); // row 40
    step(page, 'Waking', 'Listening', { t: 'micGranted', req: 2 }, arm(2));
    step(page, 'Listening', 'Recording', segStart(2, 1_007_200));
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 1 });
    expect(button('Hit').disabled).toBe(false);
  });

  test('a re-arm forgets the latest jump: after an unmute, an onset within 300 ms counts', async () => {
    const page = await livePage();
    level(page, 1, 900_000);
    level(page, 1, 1_000_000); // a jump while listening, counted
    expect(quiet().captureJumps).toBe(1);
    step(page, 'Listening', 'Listening', { t: 'trackUnmuted' }, arm(2)); // row 19: re-enter Listening after a mute
    step(page, 'Listening', 'Recording', segStart(2, 1_007_200)); // 150 ms after the first level after the jump
    expect(quiet()).toMatchObject({ captureJumps: 1, recordings: 1 });
    expect(button('Hit').disabled).toBe(false);
  });
});
