import { expect, test, type Page } from '@playwright/test';
import type { RegionId } from '../src/input/region-ids.ts';
import { PRESETS } from '../src/dsp/types.ts';
import { AM_LINE_PLAIN_MAX_DB } from './helpers/am-line';
import { expectLoop, noCspViolationsAfterEach, openApp, steps } from './helpers/app';
import { micFlags } from './helpers/flags';

// The character swap (duck plan §3.3, §4.3, T126 acceptance 4): the swap button in Asleep, persistence across a
// reload, the button hidden once awake, a 300 Hz vowel loop on Fenn in the Duckling voice (its replay length at
// p = 1.45 and its AM line, not YIN: §3.1.2), and a beak tap's quack gating the mic. A second test runs the same loop on
// Juni and measures the same AM line on her plain replay (≤ 10 dB): in this file, so both share the fixture and the
// measure, at the cost of one more ~15 s loop.
//
// Launch flags are worker-scoped: one fixture for the file. Pinned to the energy backend, as loop-f0-300.spec.ts is
// (issue #51: Silero cuts this synthetic vowel short). Each test starts with empty storage, so on Juni.
test.use({ launchOptions: { args: micFlags('e2e/fixtures/vowel_f0-300.wav') } });
test.setTimeout(60_000);
noCspViolationsAfterEach();

const APP = 'main#app';
const SWITCH = 'button.character-switch';
/** After the beak tap: no Recording within this long (acceptance 4(e)). */
const NO_RECORDING_MS = 3_000;

interface Point {
  x: number;
  y: number;
}

/** One `__bearTest.sfxLog` entry (src/test-hooks.ts `SfxLogEntry`): the fields this spec reads. */
interface SfxLogEntry {
  t: number;
  id: string;
}

function isPoint(v: unknown): v is Point {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof Reflect.get(v, 'x') === 'number' &&
    typeof Reflect.get(v, 'y') === 'number'
  );
}

/** `__bearTest.regionCenter(id)`, read through Reflect and checked, as sfx-gating.spec.ts does. */
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
        typeof Reflect.get(x, 'id') === 'string',
    )
  );
}

/** `__bearTest.sfxLog`, read through Reflect and checked. */
async function sfxLogOf(page: Page): Promise<SfxLogEntry[]> {
  const log: unknown = await page.evaluate(() => {
    const hooks: unknown = window.__bearTest;
    return typeof hooks === 'object' && hooks !== null ? Reflect.get(hooks, 'sfxLog') : null;
  });
  if (!isSfxLog(log)) throw new Error(`__bearTest.sfxLog is ${JSON.stringify(log)}`);
  return log;
}

/** The preset id of the last `settingsChanged` before the first `tapBear` (the wake). */
async function presetBeforeWake(page: Page): Promise<string | undefined> {
  const all = await steps(page);
  const wakeAt = all.findIndex((s) => s.e.t === 'tapBear');
  expect(wakeAt, 'a tapBear woke the session').toBeGreaterThanOrEqual(0);
  const last = all.slice(0, wakeAt).findLast((s) => s.e.t === 'settingsChanged')?.e;
  return last?.t === 'settingsChanged' ? last.preset.id : undefined;
}

test('Fenn: the swap in Asleep, kept on reload, hidden once awake; a Duckling loop with its AM line; a quack gates the mic', async ({
  page,
}) => {
  // (a) In Asleep, a tap on the button swaps the sleeping character: the session stays Asleep and never sees a tap.
  await openApp(page);
  const app = page.locator(APP);
  const stage = page.locator('canvas.stage');
  const button = page.locator(SWITCH);
  await expect(stage).toHaveAttribute('aria-label', 'Juni the bear');
  await expect(button).toBeVisible();
  await expect(button).toHaveAccessibleName('Switch to Fenn the duckling');
  await button.click();
  await expect(stage).toHaveAttribute('aria-label', 'Fenn the duckling');
  await expect(stage).toHaveCount(1);
  await expect(app).toHaveAttribute('data-state', 'Asleep');
  await expect(button).toHaveAccessibleName('Switch to Juni the bear');
  const afterSwap = await steps(page);
  expect(afterSwap.filter((s) => s.e.t === 'tapBear').map((s) => s.e)).toEqual([]);
  expect(afterSwap.filter((s) => s.from !== s.to).map((s) => s.to)).toEqual([]);
  expect(afterSwap.findLast((s) => s.e.t === 'settingsChanged')?.e).toMatchObject({ preset: { id: 'duck' } });
  // The stage is still main#app's first child, below the overlay, the gear and the sheet.
  expect(await app.evaluate((el) => el.firstElementChild?.matches('canvas.stage') ?? false)).toBe(true);

  // (b) A reload keeps Fenn.
  await page.reload();
  await page.waitForFunction(() => window.__bearTest !== undefined);
  await expect(app).toHaveAttribute('data-state', 'Asleep');
  await expect(stage).toHaveAttribute('aria-label', 'Fenn the duckling');
  await expect(button).toHaveAccessibleName('Switch to Juni the bear');

  // (c) + (d) The loop (expectLoop opens the app again: Fenn once more) in the Duckling voice: the replay length at
  // p = 1.45, and the AM line instead of YIN. Once awake the button is hidden.
  const { amLineDb } = await expectLoop(page, 'vowel_f0-300', 300, {
    vad: 'energy',
    pitchRatio: PRESETS.duck.pitchRatio,
    f0Check: false,
  });
  await expect(stage).toHaveAttribute('aria-label', 'Fenn the duckling');
  expect(await presetBeforeWake(page), 'the preset of the last settingsChanged before the wake').toBe('duck');
  await expect(button).toBeHidden();
  console.log(`character: Fenn's Duckling replay, AM line ${amLineDb.toFixed(1)} dB`);

  // (e) Back in Listening, the fixture over (%noloop: the mic is silent): a beak tap quacks and nothing records.
  await expect(app).toHaveAttribute('data-state', 'Listening');
  const beak = await regionCenter(page, 'beak');
  const tapT = await page.evaluate(() => performance.now());
  await page.mouse.click(beak.x, beak.y);
  await expect
    .poll(async () => (await sfxLogOf(page)).filter((x) => x.t >= tapT).map((x) => x.id), {
      message: 'the sfx scheduled after the beak tap',
      timeout: 3_000,
    })
    .toContain('quack');
  await page.waitForTimeout(NO_RECORDING_MS);
  const after = (await steps(page)).filter((s) => s.t >= tapT);
  expect(
    after.some((s) => s.to === 'SfxGated'),
    'the quack gated the mic',
  ).toBe(true);
  expect(
    after.filter((s) => s.to === 'Recording').map((s) => s.e),
    `transitions into Recording within ${NO_RECORDING_MS} ms of the beak tap`,
  ).toEqual([]);
  await expect(button).toBeHidden();
});

test('Juni: the same loop has no AM line (≤ 10 dB) and the Bear cub preset', async ({ page }) => {
  const { amLineDb } = await expectLoop(page, 'vowel_f0-300', 300, { vad: 'energy' });
  await expect(page.locator('canvas.stage')).toHaveAttribute('aria-label', 'Juni the bear');
  expect(await presetBeforeWake(page), 'the preset of the last settingsChanged before the wake').toBe('cub');
  console.log(`character: Juni's Bear cub replay, AM line ${amLineDb.toFixed(1)} dB`);
  expect(amLineDb, "Juni's replay's AM line, dB").toBeLessThanOrEqual(AM_LINE_PLAIN_MAX_DB);
});
