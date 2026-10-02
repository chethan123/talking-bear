import { expect, test } from '@playwright/test';
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
noCspViolationsAfterEach();

for (const name of Object.keys(POSES)) {
  test(`pose ${name}`, async ({ page }) => {
    await openApp(page);
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1000);
    await page.evaluate((pose) => {
      const hooks: unknown = window.__bearTest;
      const showPose: unknown =
        typeof hooks === 'object' && hooks !== null ? Reflect.get(hooks, 'showPose') : null;
      if (typeof showPose !== 'function') throw new Error('window.__bearTest.showPose is missing');
      Reflect.apply(showPose, hooks, [pose]);
    }, name);
    await expect(page.locator('canvas.stage')).toHaveScreenshot(`${name}.png`, { maxDiffPixelRatio: 0.001 });
  });
}
