import { test } from '@playwright/test';
import { expectLoop, expectSileroTake, noCspViolationsAfterEach } from './helpers/app';
import { micFlags } from './helpers/flags';

// Issue #51: the loop on espeak-ng speech (e2e/fixtures/tts_sentence_b.wav, #50) with the default VAD backend,
// Silero. The same assertions as the vowel loop specs, with two tolerances widened: TTS intonation varies more
// than a synthetic vowel, so the replay's f0 may be off the sidecar's f0 × p by ±5 %; and the VAD speech span
// may be off this fixture's sidecar label by TTS_VAD_TOLERANCE_SEC. Launch flags are worker-scoped: one fixture
// per spec file (plan §4.9.3).

/**
 * The VAD speech span tolerance for this fixture, in seconds (issue #51 D6, ORCH-NOTE 5950838607; the vowel
 * specs and tts_sentence_a keep the default 0.13 s). The sidecar label runs to max − 35 dB, which includes a
 * low-level tail that neither backend calls speech (energy misses it by 140–210 ms at every alignment). With
 * Silero the error sits on its 32 ms frame lattice at −214 … −22 ms over sub-frame alignments, at 44.1 and
 * 48 kHz: 3 of 32 alignments (≈ 9 %) exceed 0.13 s and none exceeds 0.25 s, the worst case plus one frame.
 */
const TTS_VAD_TOLERANCE_SEC = 0.25;

test.use({ launchOptions: { args: micFlags('e2e/fixtures/tts_sentence_b.wav') } });
test.setTimeout(45_000);
noCspViolationsAfterEach();

test('loop (Silero): a child-like (espeak-ng pitch 99) TTS sentence is recorded, cut exactly and replayed at ×1.6', async ({
  page,
}) => {
  await expectLoop(page, 'tts_sentence_b', 314.3, {
    speechSec: 1.43,
    f0Tolerance: 0.05,
    vadToleranceSec: TTS_VAD_TOLERANCE_SEC,
  });
  await expectSileroTake(page);
});
