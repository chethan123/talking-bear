import { expect, test, type Page } from '@playwright/test';
import { noCspViolationsAfterEach, openApp } from './helpers/app';
import { installCspRecorder } from './helpers/csp';
import { micFlags } from './helpers/flags';

// Issue #122 (plan §4.10): the performance marks and measures of src/perf.ts, and the debug overlay's readout of
// them. There is no timing gate here: the budgets (first frame ≤ 500 ms on a warm start, tap → listening ≤ 300 ms)
// are device measurements on D1. These tests only check that each measure exists, once, and is finite.
// Launch flags are worker-scoped: one fixture per spec file (plan §4.9.3). Silence: nothing here needs speech.
test.use({ launchOptions: { args: micFlags('e2e/fixtures/silence_2s.wav') } });
noCspViolationsAfterEach();

/** The element that carries `data-state` (src/main.ts). */
const APP = 'main#app';

interface Entry {
  startTime: number;
  duration: number;
}

/** The page's performance entries named `name` of `type`, in order. */
async function entries(page: Page, name: string, type: 'mark' | 'measure'): Promise<Entry[]> {
  return page.evaluate(
    ([n, t]) =>
      performance.getEntriesByName(n, t).map((e) => ({ startTime: e.startTime, duration: e.duration })),
    [name, type] as const,
  );
}

test('first-frame: boot-start → first-bear-frame is measured once and is finite', async ({ page }) => {
  await openApp(page);
  await expect.poll(async () => (await entries(page, 'first-frame', 'measure')).length).toBe(1);
  const [measure] = await entries(page, 'first-frame', 'measure');
  expect(Number.isFinite(measure?.duration)).toBe(true);
  expect(measure?.duration).toBeGreaterThanOrEqual(0);
  const boot = await entries(page, 'boot-start', 'mark');
  const frame = await entries(page, 'first-bear-frame', 'mark');
  expect(boot).toHaveLength(1);
  expect(frame).toHaveLength(1);
  expect(frame[0]!.startTime).toBeGreaterThanOrEqual(boot[0]!.startTime);
});

test('tap-to-listening: a wake tap with the mic granted is measured once at Listening and is finite', async ({
  page,
}) => {
  await openApp(page);
  expect(await entries(page, 'tap-to-listening', 'measure')).toHaveLength(0);
  // A trusted click (sticky activation). The fake UI grants the mic, so the tap goes straight to Waking; a tap
  // into the parent sheet (NeedsParent) is not measured (src/perf.ts) and this test would fail on it.
  await page.locator('canvas.stage').click();
  await expect(page.locator(APP)).toHaveAttribute('data-state', 'Listening', { timeout: 10_000 });
  await expect.poll(async () => (await entries(page, 'tap-to-listening', 'measure')).length).toBe(1);
  const [measure] = await entries(page, 'tap-to-listening', 'measure');
  expect(Number.isFinite(measure?.duration)).toBe(true);
  expect(measure?.duration).toBeGreaterThanOrEqual(0);
  const tap = await entries(page, 'tap', 'mark');
  const listening = await entries(page, 'listening', 'mark');
  expect(tap).toHaveLength(1);
  expect(listening).toHaveLength(1);
  expect(listening[0]!.startTime).toBeGreaterThanOrEqual(tap[0]!.startTime);
});

test('the debug overlay shows the last first-frame measure, and a dash before any tap', async ({ page }) => {
  await installCspRecorder(page);
  await page.goto('/?debug=1');
  await expect(page.locator('.debug-overlay [data-line="perf"]')).toHaveText(
    /^first frame \d+ ms · tap→listening – ms$/,
  );
});
