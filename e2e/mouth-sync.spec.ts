import { expect, test, type Page } from '@playwright/test';
import {
  expectMicSignal,
  noCspViolationsAfterEach,
  processedDuration,
  steps,
  wake,
  waitForTransition,
} from './helpers/app';
import { micFlags } from './helpers/flags';

// Issue #81 Validation 2, plan §4.6.2 "Sync" and X-A2: while the replay plays, the mouth reads the processed
// envelope at clipTimeNow + L on every rAF. `__bearTest.frameLog()` returns one entry per drawn frame:
// { rafT (ms), clipTime (s, L included; null without a mouth clip), envIndex (−1 outside the clip) }.
// Launch flags are worker-scoped: one fixture per spec file (plan §4.9.3).
test.use({ launchOptions: { args: micFlags('e2e/fixtures/tts_sentence_a.wav') } });
test.setTimeout(45_000);
noCspViolationsAfterEach();

interface FrameLogEntry {
  rafT: number;
  clipTime: number | null;
  envIndex: number;
}

function isFrameLog(v: unknown): v is FrameLogEntry[] {
  return (
    Array.isArray(v) &&
    v.every(
      (x: unknown) =>
        typeof x === 'object' &&
        x !== null &&
        'rafT' in x &&
        typeof x.rafT === 'number' &&
        'clipTime' in x &&
        (x.clipTime === null || typeof x.clipTime === 'number') &&
        'envIndex' in x &&
        typeof x.envIndex === 'number',
    )
  );
}

async function frameLog(page: Page): Promise<FrameLogEntry[]> {
  const log: unknown = await page.evaluate(() => {
    const hooks: unknown = window.__bearTest;
    const read: unknown = typeof hooks === 'object' && hooks !== null ? Reflect.get(hooks, 'frameLog') : null;
    if (typeof read !== 'function') throw new Error('window.__bearTest.frameLog is missing');
    const entries: unknown = Reflect.apply(read, hooks, []);
    return entries;
  });
  if (!isFrameLog(log)) throw new Error(`frameLog() returned ${JSON.stringify(log)}`);
  return log;
}

/** Tolerance on |ΔclipTime − ΔrafT| between consecutive drawn frames, in ms. */
const SYNC_TOLERANCE_MS = 8;

test('mouth sync: during Playing, envIndex rises monotonically and clipTime follows the rAF clock', async ({
  page,
}) => {
  const woke = await wake(page);
  await expectMicSignal(page);
  const playing = await waitForTransition(page, 'Playing', 15_000, woke.index);
  const cooldown = await waitForTransition(page, 'Cooldown', 10_000, playing);
  const log = await frameLog(page); // the last 600 drawn frames (10 s at 60 fps): all of the replay
  const all = await steps(page);
  const from = all[playing]!.t;
  const to = all[cooldown]!.t;
  const during = log.filter((f) => f.rafT > from && f.rafT < to);
  const inClip = during.filter((f) => f.envIndex >= 0);
  const duration = await processedDuration(page);
  const frames = Math.ceil(duration / 0.01); // the envelope's length: one frame per 10 ms hop
  console.log(
    `mouth-sync: Playing ${(to - from).toFixed(1)} ms, ${during.length} drawn frames, ${inClip.length} in the clip; ` +
      `envIndex ${inClip[0]?.envIndex} … ${inClip.at(-1)?.envIndex} of ${frames}; replay ${duration.toFixed(3)} s`,
  );

  // Every drawn frame of Playing had the mouth on the replay's envelope (the log covers all of it).
  expect(log[0]!.rafT, 'the frame log starts before Playing').toBeLessThan(from);
  expect(during.length, 'drawn frames during Playing (at least half of 60 fps)').toBeGreaterThan(
    0.5 * 60 * duration,
  );
  expect(
    during.filter((f) => f.clipTime === null),
    'frames of Playing without a mouth clip',
  ).toEqual([]);

  // envIndex rises monotonically through the clip, from its first frames to its last: −1 only before the clip
  // starts (the 50 ms start delay and the output latency) and after it ends.
  const first = during.findIndex((f) => f.envIndex >= 0);
  const last = during.findLastIndex((f) => f.envIndex >= 0);
  expect(first, 'a frame inside the clip').toBeGreaterThanOrEqual(0);
  expect(
    during.slice(first, last + 1).every((f) => f.envIndex >= 0),
    'the in-clip frames are contiguous',
  ).toBe(true);
  // Strictly increasing between frames at least one 10 ms envelope hop apart (every pair at 60 Hz), never
  // decreasing between closer ones.
  for (let i = 1; i < inClip.length; i++) {
    const a = inClip[i - 1]!;
    const b = inClip[i]!;
    const what = `frame ${i}: envIndex ${a.envIndex} → ${b.envIndex} over ${(b.rafT - a.rafT).toFixed(2)} ms`;
    if (b.rafT - a.rafT >= 10) expect(b.envIndex, what).toBeGreaterThan(a.envIndex);
    else expect(b.envIndex, what).toBeGreaterThanOrEqual(a.envIndex);
  }
  expect(inClip[0]!.envIndex, 'the first in-clip frame is near the start').toBeLessThanOrEqual(3);
  expect(inClip.at(-1)!.envIndex, 'the last in-clip frame is near the end').toBeGreaterThanOrEqual(
    frames - 4,
  );

  // Consecutive drawn frames advance clipTime by their rAF interval, ±8 ms.
  const worst = { i: -1, err: 0 };
  for (let i = 1; i < during.length; i++) {
    const a = during[i - 1]!;
    const b = during[i]!;
    const err = (b.clipTime! - a.clipTime!) * 1000 - (b.rafT - a.rafT);
    if (Math.abs(err) > Math.abs(worst.err)) Object.assign(worst, { i, err });
  }
  console.log(
    `mouth-sync: worst |ΔclipTime − ΔrafT| = ${Math.abs(worst.err).toFixed(3)} ms at frame ${worst.i}`,
  );
  expect(Math.abs(worst.err), `|ΔclipTime − ΔrafT| at frame ${worst.i}`).toBeLessThanOrEqual(
    SYNC_TOLERANCE_MS,
  );
});
