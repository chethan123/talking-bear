import { expect, test } from '@playwright/test';
import { expectMicSignal, noCspViolationsAfterEach, transitions, wake } from './helpers/app';
import { micFlags } from './helpers/flags';

// Plan §4.9.3 `too-short`, §7 M1: knocks start a segment that ends as a misfire, never as a take. The fixture
// has three 40 ms bursts at 1.0, 2.5 and 4.0 s and ends at 5.04 s (scripts/gen-fixtures.ts).
test.use({ launchOptions: { args: micFlags('e2e/fixtures/knock.wav') } });
test.setTimeout(45_000);
noCspViolationsAfterEach();

/** The window after wake in which a knock must misfire and nothing may be processed. */
const WINDOW_MS = 8_000;

test('too-short: a knock misfires back to Listening and is never processed', async ({ page }) => {
  const woke = await wake(page);
  await expectMicSignal(page);

  // Wait out the whole window. It covers the whole fixture (5.04 s from the mic's start, which is before
  // Listening) plus the energy backend's 800 ms hangover, so every knock has been segmented by its end.
  await page.waitForTimeout(Math.max(0, woke.at + WINDOW_MS - Date.now()));
  const all = await transitions(page);
  const misfires = all.filter(
    (s) =>
      s.from === 'Recording' &&
      s.to === 'Listening' &&
      s.e.t === 'seg' &&
      s.e.ev.kind === 'misfire' &&
      s.t <= woke.logT + WINDOW_MS,
  );
  console.log(
    `knock: ${misfires.length} misfire(s) within ${WINDOW_MS} ms of wake; state changes: ${all.map((s) => s.to).join(' → ')}`,
  );
  // Soft: both checks report, so a failure shows whether knocks didn't misfire, were processed, or both.
  expect
    .soft(misfires.length, 'Recording → Listening steps caused by a seg misfire within 8 s of wake')
    .toBeGreaterThanOrEqual(1);
  expect
    .soft(
      all.filter((s) => s.to === 'Processing').map((s) => s.e),
      'transitions into Processing',
    )
    .toEqual([]);
});
