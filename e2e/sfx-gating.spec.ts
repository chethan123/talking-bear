import { expect, test, type Page } from '@playwright/test';
import type { RegionId } from '../src/input/region-ids.ts';
import { noCspViolationsAfterEach, steps, wake } from './helpers/app';
import { micFlags } from './helpers/flags';

// Plan §4.9.3 `sfx-gating`, §3.4 rows 14, 32–36, §7 M5 (issue #93): a reaction sound never starts a recording.
// A tap storm in Listening must enter SfxGated, and every `arm` must come after the latest sfx scheduled before
// it has ended, plus the 250 ms cooldown.
//
// What CI can show: the fake mic is a WAV (silence_2s), so there is no acoustic path from the speaker to the mic.
// The "no Recording" assertion can't catch real self-capture; the meaningful check here is the arm-after-sfx-end
// timing. Real self-capture is checked on D1 in #95 (step 4). The input is silent, so there is no
// `expectMicSignal`.
test.use({ launchOptions: { args: micFlags('e2e/fixtures/silence_2s.wav') } });
test.setTimeout(60_000);
noCspViolationsAfterEach();

/** Taps in the storm, alternating nose and belly, with this pause after each click. */
const TAPS = 15;
const PAUSE_MS = 300;
/** The session's cooldown after the last sfx has left the speaker (plan §3.4 row 34, DEFAULT_CONFIG). */
const COOLDOWN_S = 0.25;
/** No Recording during the storm or this long after it. */
const AFTER_MS = 2_000;

interface Point {
  x: number;
  y: number;
}

/** One `__bearTest.sfxLog` entry (src/test-hooks.ts `SfxLogEntry`): the fields this spec reads. */
interface SfxLogEntry {
  t: number;
  endCtxTime: number;
}

function isPoint(v: unknown): v is Point {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof Reflect.get(v, 'x') === 'number' &&
    typeof Reflect.get(v, 'y') === 'number'
  );
}

/**
 * `__bearTest.regionCenter(id)` (#93): a hit region's centre in viewport CSS px. e2e/helpers/app.ts doesn't restate
 * this hook, so it is read through Reflect and checked, as screenshots.spec.ts and mouth-sync.spec.ts do.
 */
async function regionCenter(page: Page, id: RegionId): Promise<Point> {
  const p: unknown = await page.evaluate((r) => {
    const hooks: unknown = window.__bearTest;
    const fn: unknown =
      typeof hooks === 'object' && hooks !== null ? Reflect.get(hooks, 'regionCenter') : null;
    if (typeof fn !== 'function') throw new Error('window.__bearTest.regionCenter is missing');
    const point: unknown = Reflect.apply(fn, hooks, [r]);
    return point;
  }, id);
  if (!isPoint(p)) throw new Error(`regionCenter(${id}) returned ${JSON.stringify(p)}`);
  return p;
}

function isSfxLog(v: unknown): v is SfxLogEntry[] {
  return (
    Array.isArray(v) &&
    v.every(
      (x: unknown) =>
        typeof x === 'object' &&
        x !== null &&
        typeof Reflect.get(x, 't') === 'number' &&
        typeof Reflect.get(x, 'endCtxTime') === 'number',
    )
  );
}

/** `__bearTest.sfxLog` (#93), read through Reflect and checked like `regionCenter`. */
async function sfxLogOf(page: Page): Promise<SfxLogEntry[]> {
  const log: unknown = await page.evaluate(() => {
    const hooks: unknown = window.__bearTest;
    const entries: unknown =
      typeof hooks === 'object' && hooks !== null ? Reflect.get(hooks, 'sfxLog') : null;
    return entries;
  });
  if (!isSfxLog(log)) throw new Error(`__bearTest.sfxLog is ${JSON.stringify(log)}`);
  return log;
}

const pageNow = (page: Page): Promise<number> => page.evaluate(() => performance.now());

test('sfx-gating: a tap storm enters SfxGated; every arm waits for the latest sfx end + 0.25 s; nothing records', async ({
  page,
}) => {
  await wake(page);

  // The storm: 15 trusted clicks, nose and belly in turn, each 300 ms after the previous one ended (≈ 4.5 s).
  // Each centre is read just before its click: the reactions move the bear.
  const stormT0 = await pageNow(page);
  for (let k = 0; k < TAPS; k++) {
    const p = await regionCenter(page, k % 2 === 0 ? 'nose' : 'belly');
    await page.mouse.click(p.x, p.y);
    if (k < TAPS - 1) await page.waitForTimeout(PAUSE_MS);
  }
  const stormT1 = await pageNow(page);
  await page.waitForTimeout(AFTER_MS);
  // The bear listens again once the last sfx has left the speaker and the cooldown has passed: that arm counts.
  await page.waitForFunction(
    (t0) => {
      const h = window.__bearTest;
      return (
        h !== undefined &&
        h.state() === 'Listening' &&
        h.log.some((x) => x.to === 'Listening' && x.from !== 'Listening' && x.t > t0)
      );
    },
    stormT0,
    { timeout: 10_000 },
  );

  const all = await steps(page);
  const sfxLog = await sfxLogOf(page);
  const rate = await page.evaluate(() => window.__bearTest?.outputSampleRate() ?? Number.NaN);

  // 1. The storm's sounds gate the mic.
  const gated = all.filter(
    (s) => s.to === 'SfxGated' && s.from !== 'SfxGated' && s.t >= stormT0 && s.t <= stormT1,
  );
  expect(gated.length, 'transitions into SfxGated during the storm').toBeGreaterThanOrEqual(1);

  // 2. Every scheduled sfx is logged with its end.
  expect(sfxLog.length, 'scheduled sfx (__bearTest.sfxLog)').toBeGreaterThanOrEqual(1);

  // 3. Every arm after an sfx starts at a ctx time ≥ the latest end of the sfx scheduled before it + 0.25 s.
  const arms = all
    .filter((s) => s.effects.includes('arm'))
    .flatMap((s) => {
      const before = sfxLog.filter((x) => x.t <= s.t);
      if (before.length === 0) return [];
      const end = Math.max(...before.map((x) => x.endCtxTime));
      const at = s.frame / rate;
      return [{ at, end, margin: at - (end + COOLDOWN_S) }];
    });
  console.log(
    `sfx-gating: ${sfxLog.length} sfx scheduled, ${arms.length} arm(s) after an sfx; ` +
      `margins over the latest sfx end + ${COOLDOWN_S} s: ${arms.map((a) => a.margin.toFixed(3)).join(', ')} s`,
  );
  expect(arms.length, 'arms after an sfx').toBeGreaterThanOrEqual(1);
  for (const a of arms) {
    expect(
      a.at,
      `arm at ctx ${a.at.toFixed(3)} s, latest sfx end ${a.end.toFixed(3)} s`,
    ).toBeGreaterThanOrEqual(a.end + COOLDOWN_S);
  }

  // 4. Nothing records during the storm or for 2 s after it.
  const recording = all.filter((s) => s.to === 'Recording' && s.t >= stormT0 && s.t <= stormT1 + AFTER_MS);
  expect(
    recording.map((s) => s.e),
    'transitions into Recording during the storm or within 2 s after it',
  ).toEqual([]);
});
