import { test } from '@playwright/test';
import { expectLoop, noCspViolationsAfterEach } from './helpers/app';
import { micFlags } from './helpers/flags';

// Plan §4.9.3 `loop`, §7 M1. Launch flags are worker-scoped: one fixture per spec file. Pinned to the energy
// backend (issue #51): Silero ends this synthetic vowel's segment after 0.3–0.6 s of its 1.5 s, so the take is
// cut short.
test.use({ launchOptions: { args: micFlags('e2e/fixtures/vowel_f0-140.wav') } });
test.setTimeout(45_000);
noCspViolationsAfterEach();

test('loop: a 140 Hz vowel is recorded, cut exactly and replayed at ×1.6', async ({ page }) => {
  await expectLoop(page, 'vowel_f0-140', 140, { vad: 'energy' });
});
