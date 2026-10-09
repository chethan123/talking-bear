import { expect, test, type Page } from '@playwright/test';
import { expectNoEnforcedViolations, installCspRecorder } from '../helpers/csp';
import { micFlags } from '../helpers/flags';

// Issue #107 (plan §4.9.3, §7 M7, §9 `image-smoke`): the hook-free smoke test of the production image. Production
// builds have no `__bearTest`, so the spec drives and reads the app through the DOM only: the stage canvas, the
// parent sheet's Continue button and `data-state` on main#app. CI runs it against `bear:ci` with
// playwright.smoke.config.ts. Launch flags are worker-scoped: one fixture per spec file (plan §4.9.3).
// The CSP recorder sees the documents' violations only, not those of the workers or the service worker (as in the
// e2e specs).
test.use({ launchOptions: { args: micFlags('e2e/fixtures/tts_sentence_a.wav') } });
test.setTimeout(60_000);

/** The element that carries `data-state` (src/main.ts). */
const APP = 'main#app';
/** The states one loop passes through, in order (issue #107, smoke step 2). */
const LOOP = ['Listening', 'Recording', 'Processing', 'Playing', 'Listening'] as const;
/** The loop's budget from the wake tap (issue #107). */
const LOOP_BUDGET_MS = 20_000;
/**
 * "The canvas renders": at least this fraction of the stage's middle row differs from the row's left-edge pixel
 * by more than `BEAR_CHANNEL_DELTA` in some channel. The background is a vertical gradient, so on its own it gives 0;
 * Juni crosses the middle row (measured on the image at 1280×720 in Asleep: 0.198).
 */
const BEAR_ROW_MIN_FRACTION = 0.05;
/** The per-channel difference (0–255) from the row's left-edge pixel that counts a pixel as drawn over the background. */
const BEAR_CHANNEL_DELTA = 16;
/** The bound on the service worker becoming ready and taking control, before going offline. */
const SW_READY_MS = 15_000;

declare global {
  interface Window {
    /** Every `data-state` value of main#app in this document, in order (set by `recordStates`'s init script). */
    smokeStates?: string[];
  }
}

/**
 * Records every `data-state` value main#app takes in every document the page loads from now on, so short states
 * (Processing) are never missed. Call it before `page.goto()`. A MutationObserver with `attributeOldValue`
 * reconstructs each value even when several changes land in one task.
 */
async function recordStates(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    window.smokeStates = seen;
    const push = (value: string | null): void => {
      if (value !== null && seen[seen.length - 1] !== value) seen.push(value);
    };
    document.addEventListener('DOMContentLoaded', () => {
      const app = document.querySelector('main#app');
      if (app === null) return;
      push(app.getAttribute('data-state'));
      new MutationObserver((records) => {
        // A record's oldValue is the value before its change, so the value after record i is the oldValue of
        // record i + 1, and the value after the last one is the current value.
        records.forEach((_, i) => {
          const next = records[i + 1];
          push(next === undefined ? app.getAttribute('data-state') : next.oldValue);
        });
      }).observe(app, { attributes: true, attributeFilter: ['data-state'], attributeOldValue: true });
    });
  });
}

async function states(page: Page): Promise<string[]> {
  return page.evaluate(() => window.smokeStates ?? []);
}

/** Whether `wanted` occurs in `seen` in order (not necessarily adjacent). */
function passesThrough(seen: readonly string[], wanted: readonly string[]): boolean {
  let next = 0;
  for (const s of seen) {
    if (s === wanted[next]) next += 1;
    if (next === wanted.length) return true;
  }
  return false;
}

/**
 * The fraction of the stage canvas's middle row whose pixels differ from the row's pixel 0 by more than `delta` in
 * some RGB channel (0 without a canvas). Read from the renderer's own 2D context (src/anim/renderer.ts).
 */
async function bearRowFraction(page: Page): Promise<number> {
  return page.evaluate((delta) => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.stage');
    if (canvas === null || canvas.width === 0 || canvas.height === 0) return 0;
    const g = canvas.getContext('2d');
    if (g === null) return 0;
    const row = g.getImageData(0, canvas.height >> 1, canvas.width, 1).data;
    const [r0, g0, b0] = [row[0] ?? 0, row[1] ?? 0, row[2] ?? 0];
    let differing = 0;
    for (let i = 0; i + 2 < row.length; i += 4) {
      const d = Math.max(
        Math.abs((row[i] ?? 0) - r0),
        Math.abs((row[i + 1] ?? 0) - g0),
        Math.abs((row[i + 2] ?? 0) - b0),
      );
      if (d > delta) differing += 1;
    }
    return differing / canvas.width;
  }, BEAR_CHANNEL_DELTA);
}

test('smoke: wake, one loop, no enforced CSP violation, offline reload', async ({ page, context }) => {
  const app = page.locator(APP);
  await installCspRecorder(page);
  await recordStates(page);
  await page.goto('/');
  await expect(app).toHaveAttribute('data-state', 'Asleep');

  // 1. Wake with a trusted click on the stage (it unlocks the AudioContext), then Continue if the parent sheet
  //    opened (NeedsParent).
  await page.locator('canvas.stage').click();
  await expect(app).not.toHaveAttribute('data-state', 'Asleep');
  if ((await app.getAttribute('data-state')) === 'NeedsParent') {
    await page.getByRole('button', { name: 'Continue' }).click();
  }

  // 2. The fake mic's sentence runs one loop: Listening → Recording → Processing → Playing → Listening.
  await expect
    .poll(async () => passesThrough(await states(page), LOOP), {
      message: `data-state passes through ${LOOP.join(' → ')} within ${LOOP_BUDGET_MS} ms of the wake tap`,
      timeout: LOOP_BUDGET_MS,
    })
    .toBe(true);
  console.log(`smoke: data-state ${(await states(page)).join(' → ')}`);

  // 3. No enforce-mode CSP violation in the first document.
  await expectNoEnforcedViolations(page);

  // 4. Once the service worker is ready and controls the page, a reload with the network off boots into Asleep
  //    and the stage renders the bear.
  const ready = await page.evaluate(
    (ms) =>
      Promise.race([
        navigator.serviceWorker.ready.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]),
    SW_READY_MS,
  );
  expect(ready, 'service worker never became ready (precache failed?)').toBe(true);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: SW_READY_MS,
  });
  await page.waitForLoadState('networkidle');
  await context.setOffline(true);
  await page.reload();
  await expect(app).toHaveAttribute('data-state', 'Asleep');
  await expect(page.locator('canvas.stage')).toBeVisible();
  await expect
    .poll(() => bearRowFraction(page), { message: 'the stage canvas draws Juni after the offline reload' })
    .toBeGreaterThanOrEqual(BEAR_ROW_MIN_FRACTION);
  await expectNoEnforcedViolations(page);
});
