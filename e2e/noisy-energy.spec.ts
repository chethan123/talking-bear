import { expect, test } from '@playwright/test';
import { expectMicSignal, noCspViolationsAfterEach, steps, wake, type Step } from './helpers/app';
import { micFlags } from './helpers/flags';

// Issue #289 (plan §4.4 "Background noise never falls silent" on the energy fallback; ORCH-ANSWER 6084880690 and
// ORCH-NOTE 6085389040 on #289): with 20 s of pink noise at −20 dBFS on the fake mic and the energy backend pinned,
// the noise latches the energy gate about 1 s in, so the session is in Recording when the noise floor estimate
// (src/app/effects.ts: Listening levels, and Recording levels from 1 s after the epoch's first one) sets `tooNoisy`,
// and Recording shows the too-noisy badge. The capped noise segment then ends as the energy voicing rule's misfire,
// which carries reason maxLength and its voiced ratio, so the session counts it as a noisy cap. Escalation to +3 and
// +6 dB and hold-to-talk needs 3 to 9 such caps (30–90 s) and is covered by the machine's unit and property tests.
test.use({ launchOptions: { args: micFlags('e2e/fixtures/noise_pink_-20dbfs_20s.wav') } });
test.setTimeout(45_000);
noCspViolationsAfterEach();

/** Plan §4.4: the too-noisy threshold (dBFS). */
const TOO_NOISY_DB = -35;
/** Issue #289 Specification: the badge appears within this long of the first Listening. */
const BUDGET_MS = 5000;
/** #116: the voiced ratio below which a capped segment is noise. */
const NOISY_VOICED_RATIO = 0.3;

/** The state changes of `all`, for failure messages. */
const changes = (all: readonly Step[]): string[] =>
  all.filter((s) => s.from !== s.to).map((s) => `${s.from} -> ${s.to} (${s.e.t})`);

test('noisy (energy backend): pink noise at −20 dBFS shows the too-noisy icon within 5 s of Listening, in Recording', async ({
  page,
}) => {
  const woke = await wake(page, { vad: 'energy' });
  await expectMicSignal(page);
  expect(await page.evaluate(() => window.__bearTest?.vadBackend())).toBe('energy');

  const badge = page
    .locator('.overlay .overlay-badge')
    .filter({ has: page.locator('svg[data-icon="noise"]') });
  await expect(badge).toBeVisible({ timeout: BUDGET_MS });
  expect(await badge.textContent()).toBe('');

  // The log is the timing authority: the noiseFloor that turned the badge on, in Recording, within the budget.
  const all = await steps(page);
  const at = all.findIndex(
    (s, i) =>
      i > woke.index &&
      s.e.t === 'noiseFloor' &&
      s.e.floorDb > TOO_NOISY_DB &&
      s.effects.includes('ui') &&
      s.to === 'Recording',
  );
  const step = all[at];
  if (step === undefined || step.e.t !== 'noiseFloor') {
    throw new Error(
      `no noiseFloor above ${TOO_NOISY_DB} dBFS showed the badge in Recording; state changes: ${changes(all).join(', ')}`,
    );
  }
  const delayMs = step.t - woke.logT;
  expect(delayMs).toBeLessThanOrEqual(BUDGET_MS);
  // The energy gate latched on the noise: the only state change before the badge is the onset.
  expect(changes(all.slice(woke.index + 1, at))).toEqual(['Listening -> Recording (seg)']);

  // The capped noise segment ends as the voicing rule's misfire with its reason and voiced ratio (a noisy cap).
  const isMisfire = (s: Step, i: number): boolean => i > at && s.e.t === 'seg' && s.e.ev.kind === 'misfire';
  await expect
    .poll(async () => (await steps(page)).findIndex(isMisfire), { timeout: 15_000 })
    .toBeGreaterThan(at);
  const later = await steps(page);
  const misfire = later[later.findIndex(isMisfire)];
  if (misfire === undefined || misfire.e.t !== 'seg' || misfire.e.ev.kind !== 'misfire') {
    throw new Error(`no misfire after the badge; state changes: ${changes(later).join(', ')}`);
  }
  const ev = misfire.e.ev;
  expect(ev.reason).toBe('maxLength');
  expect(ev.voicedRatio).toBeDefined();
  expect(ev.voicedRatio).toBeLessThan(NOISY_VOICED_RATIO);
  // The badge stays across the re-arm: Recording and Listening both show it, so no ui effect.
  expect(misfire.to).toBe('Listening');
  expect(misfire.effects).not.toContain('ui');
  await expect(badge).toBeVisible();

  console.log(
    [
      `noisy-energy: noiseFloor ${step.e.floorDb.toFixed(1)} dBFS at ${delayMs.toFixed(0)} ms after Listening (Recording)`,
      `capped misfire at ${(misfire.t - woke.logT).toFixed(0)} ms, voicedRatio ${String(ev.voicedRatio)}`,
    ].join('; '),
  );
});
