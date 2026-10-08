import { expect, test } from '@playwright/test';
import { noCspViolationsAfterEach, openApp, tapToWake } from './helpers/app';
import { denyFlags } from './helpers/flags';

// Plan §4.9.3 `deny`, §7 M1, M8: the mic prompt is auto-denied, so the wake ends in MicDenied and its help icon
// (#115: the kid-first overlays are text-free).
test.use({ launchOptions: { args: denyFlags('e2e/fixtures/vowel_f0-140.wav') } });
test.setTimeout(45_000);
noCspViolationsAfterEach();

test('deny: a denied mic shows the MicDenied icon', async ({ page }) => {
  await openApp(page);
  await tapToWake(page);
  await expect(page.locator('main#app')).toHaveAttribute('data-state', 'MicDenied', { timeout: 5_000 });
  const help = page.locator('.overlay section.overlay-icon');
  await expect(help).toBeVisible();
  await expect(help.locator('svg[data-icon="micBlocked"]')).toBeVisible();
  expect(await help.textContent()).toBe('');
  expect((await page.locator('.overlay').innerText()).trim()).toBe('');
  await expect(page.locator('.overlay').getByRole('button')).toHaveCount(0);
});
