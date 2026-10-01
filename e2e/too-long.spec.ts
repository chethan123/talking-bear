import { expect, test } from '@playwright/test';
import {
  expectedProcessedDuration,
  expectMicSignal,
  lastTake,
  noCspViolationsAfterEach,
  processedDuration,
  steps,
  waitForLoop,
  wake,
} from './helpers/app';
import { micFlags } from './helpers/flags';

// Plan §4.9.3 `too-long`, §7 M1: 12 s of vowel is capped at the 10 s maximum utterance and still replayed.
test.use({ launchOptions: { args: micFlags('e2e/fixtures/long_12s.wav') } });
test.setTimeout(45_000);
noCspViolationsAfterEach();

test('too-long: 12 s of speech is capped at 10 s, cut exactly and replayed', async ({ page }) => {
  const woke = await wake(page);
  await expectMicSignal(page);
  // The loop completes back to Listening within 30 s of wake.
  const ended = await waitForLoop(page, woke, 30_000);

  const all = await steps(page);
  expect(
    all.some((s) => s.e.t === 'seg' && s.e.ev.kind === 'end' && s.e.ev.reason === 'maxLength'),
    'a seg end with reason maxLength',
  ).toBe(true);

  const take = await lastTake(page);
  expect(take.reason, 'the take ended at the 10 s cap').toBe('maxLength');
  const expected = expectedProcessedDuration(take);
  const processed = await processedDuration(page);
  expect(
    Math.abs(processed - expected),
    `processedDuration ${processed} s, expected ${expected} s`,
  ).toBeLessThanOrEqual(0.002);
  // 10 s of speech + 0.3 s pre-roll + 0.15 s tail, at ×1.6.
  const capped = (10 + 0.3 + 0.15) / 1.6;
  expect(Math.abs(processed - capped), `processedDuration ${processed} s, ≈ ${capped} s`).toBeLessThanOrEqual(
    0.1,
  );

  console.log(
    [
      `long_12s: sr ${take.sr}, armFrame ${take.armFrame}, startFrame ${take.startFrame}, lastSpeechFrame ${take.lastSpeechFrame}`,
      `processedDuration ${processed.toFixed(6)} s, expected ${expected.toFixed(6)} s, diff ${((processed - expected) * 1000).toFixed(4)} ms`,
      `vs ${capped} s: ${((processed - capped) * 1000).toFixed(1)} ms`,
      `loop ${((all[ended]!.t - woke.logT) / 1000).toFixed(2)} s`,
    ].join('; '),
  );
});
