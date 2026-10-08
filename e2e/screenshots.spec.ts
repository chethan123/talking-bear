import { expect, test, type Page } from '@playwright/test';
import { POSES } from '../src/anim/poses.ts';
import { noCspViolationsAfterEach, openApp } from './helpers/app';

// Plan §7 M4 "Playwright e2e for full-app states" (issue #81): every key pose, rendered once by the app's own
// BearView through `__bearTest.showPose`, on the 500 × 700 CSS px canvas at DPR 1 that the renderer screenshots
// use (#75: scale 0.5, design box fitted and centred). The clock is installed at 0 and paused (no audio here, so
// `page.clock` is allowed), and showPose stops the frame loop, so nothing moves between the two captures
// Playwright compares. The installed clock runs until it is paused, so it is paused at 1 s rather than at 0:
// `pauseAt(0)` can find the clock already past 0 ("Cannot fast-forward to the past").
//
// Baselines: e2e/screenshots.spec.ts-snapshots/<pose>-chromium-linux.png, generated on Linux with
// `pnpm e2e e2e/screenshots.spec.ts --update-snapshots`. A Playwright or Chromium bump is expected to change
// pixels: regenerate them, never raise maxDiffPixelRatio.
//
// `asleep-overlay` (#115) is a full-page screenshot, because the tap-to-wake paw is a DOM overlay, not canvas content:
// reduced motion keeps the paw static, and showPose freezes the canvas. Its baseline also holds the settings gear,
// whose "⚙" is a system-font glyph, so it depends on the image's fonts: regenerate it on the CI image if the fonts
// differ (`--update-snapshots=missing` after deleting it), and never raise maxDiffPixelRatio.
noCspViolationsAfterEach();

/** Freezes the canvas on pose `name` through `__bearTest.showPose` (the loop stops for good). */
async function showPose(page: Page, name: string): Promise<void> {
  await page.evaluate((pose) => {
    const hooks: unknown = window.__bearTest;
    const show: unknown = typeof hooks === 'object' && hooks !== null ? Reflect.get(hooks, 'showPose') : null;
    if (typeof show !== 'function') throw new Error('window.__bearTest.showPose is missing');
    Reflect.apply(show, hooks, [pose]);
  }, name);
}

for (const name of Object.keys(POSES)) {
  test(`pose ${name}`, async ({ page }) => {
    await openApp(page);
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1000);
    await showPose(page, name);
    await expect(page.locator('canvas.stage')).toHaveScreenshot(`${name}.png`, { maxDiffPixelRatio: 0.001 });
  });
}

test('asleep-overlay', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page); // waits for data-state="Asleep"
  const paw = page.locator('.overlay .overlay-paw');
  await expect(paw).toBeVisible();
  expect(await paw.evaluate((el) => el.getAnimations().length)).toBe(0); // static under reduced motion
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await showPose(page, 'asleep');
  await expect(page).toHaveScreenshot('asleep-overlay.png', { maxDiffPixelRatio: 0.001 });
});
