import { expect, test } from '@playwright/test';
import { expectMicSignal, noCspViolationsAfterEach, steps, wake, type Step } from './helpers/app';
import { micFlags } from './helpers/flags';

// Issue #116 (plan §4.4 "Background noise never falls silent"): with 20 s of pink noise at −20 dBFS on the fake
// mic, the too-noisy badge appears within 5 s of Listening. The value the session compares with −35 dBFS is the
// noise floor estimate of the ORCH-NOTE on #116 (src/app/effects.ts): the larger of the gate floor and the minimum
// band-limited hop level over a ≥ 1 s Listening window. The default backend (Silero) gives no segment on this noise,
// so the session stays in Listening. The cap-hit escalation (margins +3, +6 dB, then hold-to-talk) is covered by
// the machine's unit and property tests.
test.use({ launchOptions: { args: micFlags('e2e/fixtures/noise_pink_-20dbfs_20s.wav') } });
test.setTimeout(45_000);
noCspViolationsAfterEach();

/** Plan §4.4: the too-noisy threshold (dBFS). */
const TOO_NOISY_DB = -35;
/** Issue #116 Validation 2: the badge appears within this long of Listening. */
const BUDGET_MS = 5000;

/** The state changes of `all`, for failure messages. */
const changes = (all: readonly Step[]): string[] =>
  all.filter((s) => s.from !== s.to).map((s) => `${s.from} -> ${s.to} (${s.e.t})`);

test('noisy: pink noise at −20 dBFS shows the too-noisy icon within 5 s of Listening', async ({ page }) => {
  const woke = await wake(page);
  await expectMicSignal(page);

  const badge = page
    .locator('.overlay .overlay-badge')
    .filter({ has: page.locator('svg[data-icon="noise"]') });
  await expect(badge).toBeVisible({ timeout: BUDGET_MS });
  expect(await badge.textContent()).toBe('');
  await expect(page.locator('main#app')).toHaveAttribute('data-state', 'Listening');

  // The log is the timing authority: the noiseFloor that turned the badge on, in Listening, within the budget.
  const all = await steps(page);
  const at = all.findIndex(
    (s, i) =>
      i > woke.index &&
      s.e.t === 'noiseFloor' &&
      s.e.floorDb > TOO_NOISY_DB &&
      s.effects.includes('ui') &&
      s.to === 'Listening',
  );
  const step = all[at];
  if (step === undefined || step.e.t !== 'noiseFloor') {
    throw new Error(
      `no noiseFloor above ${TOO_NOISY_DB} dBFS showed the badge; state changes: ${changes(all).join(', ')}`,
    );
  }
  const delayMs = step.t - woke.logT;
  // The session never left Listening between the wake and the badge.
  expect(changes(all.slice(woke.index + 1, at))).toEqual([]);

  const ready = await page.evaluate(
    () => window.__bearTest?.workerEvents.filter((w) => w.e.t === 'vadReady').map((w) => w.t) ?? [],
  );
  console.log(
    [
      `noisy: noiseFloor ${step.e.floorDb.toFixed(1)} dBFS at ${delayMs.toFixed(0)} ms after Listening`,
      `vadReady at ${ready.map((t) => (t - woke.logT).toFixed(0)).join(', ') || 'never'} ms after Listening`,
    ].join('; '),
  );
  expect(delayMs).toBeLessThanOrEqual(BUDGET_MS);
});
