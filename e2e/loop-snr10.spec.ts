import { test } from '@playwright/test';
import { expectLoop, noCspViolationsAfterEach } from './helpers/app';
import { micFlags } from './helpers/flags';

// Plan §4.9.3 `loop`, §7 M1. Launch flags are worker-scoped: one fixture per spec file.
test.use({ launchOptions: { args: micFlags('e2e/fixtures/vowel_f0-140_pink_snr10.wav') } });
test.setTimeout(45_000);
noCspViolationsAfterEach();

test('loop: a 140 Hz vowel in pink noise at SNR 10 dB is recorded, cut exactly and replayed at ×1.6', async ({
  page,
}) => {
  await expectLoop(page, 'vowel_f0-140_pink_snr10', 140);
});
