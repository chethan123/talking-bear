import { expect, test } from '@playwright/test';
import { noCspViolationsAfterEach, openApp, tapToWake } from './helpers/app';
import { denyFlags } from './helpers/flags';

// Plan §4.9.3 `deny`, §7 M1: the mic prompt is auto-denied, so the wake ends in MicDenied and its help text.
test.use({ launchOptions: { args: denyFlags('e2e/fixtures/vowel_f0-140.wav') } });
test.setTimeout(45_000);
noCspViolationsAfterEach();

test('deny: a denied mic shows the MicDenied help', async ({ page }) => {
  await openApp(page);
  await tapToWake(page);
  await expect(page.locator('main#app')).toHaveAttribute('data-state', 'MicDenied', { timeout: 5_000 });
  await expect(page.getByText('Microphone is blocked')).toBeVisible();
});
