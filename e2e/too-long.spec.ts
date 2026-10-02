import { expect, test } from '@playwright/test';
import {
  expectMicSignal,
  expectProcessedDuration,
  lastTake,
  noCspViolationsAfterEach,
  PITCH_RATIO,
  processedDurationBounds,
  processedDuration,
  steps,
  takeSeconds,
  waitForLoop,
  wake,
} from './helpers/app';
import { micFlags } from './helpers/flags';

// Plan §4.9.3 `too-long`, §7 M1: 12 s of vowel is capped at the 10 s maximum utterance and still replayed.
// Pinned to the energy backend (issue #51): Silero ends this synthetic vowel by silence before the 10 s cap.
test.use({ launchOptions: { args: micFlags('e2e/fixtures/long_12s.wav') } });
test.setTimeout(45_000);
noCspViolationsAfterEach();

/** The speech in the take: the 10 s cap (the fixture's vowel goes on past it). */
const CAPPED_SPEECH_SEC = 10;

test('too-long: 12 s of speech is capped at 10 s and replayed', async ({ page }) => {
  const woke = await wake(page, { vad: 'energy' });
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
  // The replay's length: the take trimmed by processVoice (only the pre-roll's silence can go), then divided by
  // p (issue #66).
  const processed = await processedDuration(page);
  expectProcessedDuration(processed, take, CAPPED_SPEECH_SEC, PITCH_RATIO);
  const { min, max } = processedDurationBounds(take, CAPPED_SPEECH_SEC, PITCH_RATIO);

  console.log(
    [
      `long_12s: sr ${take.sr}, armFrame ${take.armFrame}, startFrame ${take.startFrame}, lastSpeechFrame ${take.lastSpeechFrame}`,
      `processedDuration ${processed.toFixed(6)} s in [${min.toFixed(6)}, ${max.toFixed(6)}] s (take ${takeSeconds(take).toFixed(6)} s)`,
      `loop ${((all[ended]!.t - woke.logT) / 1000).toFixed(2)} s`,
    ].join('; '),
  );
});
