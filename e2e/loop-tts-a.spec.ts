import { test } from '@playwright/test';
import { expectLoop, expectSileroTake, noCspViolationsAfterEach } from './helpers/app';
import { micFlags } from './helpers/flags';

// Issue #51: the loop on espeak-ng speech (e2e/fixtures/tts_sentence_a.wav, #50) with the default VAD backend,
// Silero. The same assertions as the vowel loop specs, except the pitch: TTS intonation varies more than a
// synthetic vowel, so the replay's f0 may be off the sidecar's f0 × p by ±5 %. Launch flags are worker-scoped:
// one fixture per spec file (plan §4.9.3).
test.use({ launchOptions: { args: micFlags('e2e/fixtures/tts_sentence_a.wav') } });
test.setTimeout(45_000);
noCspViolationsAfterEach();

test('loop (Silero): a low-pitched TTS sentence is recorded, cut exactly and replayed at ×1.6', async ({
  page,
}) => {
  await expectLoop(page, 'tts_sentence_a', 98.9, { speechSec: 1.28, f0Tolerance: 0.05 });
  await expectSileroTake(page);
});
