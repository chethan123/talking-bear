import { expect, test } from '@playwright/test';
import { expectLoop, expectSileroTake, noCspViolationsAfterEach } from './helpers/app';
import { micFlags } from './helpers/flags';

// Issue #100 (plan §4.9.3 `offline`, §7 M6 "airplane-mode cold start runs the full loop"): once the service worker
// controls the page, a reload with the network off boots the app, and the full loop then runs offline with
// loop-tts-a's assertions (tts_sentence_a.wav, Silero). Every request from the reload on must succeed and be
// answered by the service worker: a response from the network or the HTTP cache would hide a file missing from
// the precache. Launch flags are worker-scoped: one fixture per spec file (plan §4.9.3).
test.use({ launchOptions: { args: micFlags('e2e/fixtures/tts_sentence_a.wav') } });
test.setTimeout(60_000); // loop-tts-a's 45 s, plus the first visit and the reload
noCspViolationsAfterEach();

test('offline: after the service worker takes control, a reload with the network off runs the full loop', async ({
  page,
  context,
}) => {
  // 1. First visit: the service worker installs (precaching the app) and, with clientsClaim, controls this page.
  //    Network idle first, so the reload below can't abort one of this page's requests.
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.waitForLoadState('networkidle');

  // 2. Network off, then reload. The recorders are attached first, so they see every request from here on.
  const failed: string[] = [];
  const notFromSw: string[] = [];
  const fromSw: string[] = [];
  page.on('requestfailed', (req) =>
    failed.push(`${req.url()}: ${req.failure()?.errorText ?? 'unknown error'}`),
  );
  page.on('response', (res) => {
    if (res.fromServiceWorker()) fromSw.push(new URL(res.url()).pathname);
    else notFromSw.push(`${res.status()} ${res.url()}`);
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('main#app')).toHaveAttribute('data-state', 'Asleep');
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller !== null),
    'the reloaded page is controlled by the service worker',
  ).toBe(true);
  // expectLoop opens the app itself (CSP recorder, then goto('/')): a second offline load of the same page.
  // Network idle first, so that navigation can't abort a late request of the reloaded page.
  await page.waitForLoadState('networkidle');

  // 3. The full loop (wake → Listening → Recording → Processing → Playing → Cooldown → Listening), with
  //    loop-tts-a's assertions.
  await expectLoop(page, 'tts_sentence_a', 98.9, { speechSec: 1.28, f0Tolerance: 0.05 });
  await expectSileroTake(page);

  // 4. No request failed, and none was answered by anything but the service worker. The recorders did see the
  //    loads: the document, and the Silero weights that only the worker fetches, after wake.
  console.log(`offline: ${fromSw.length} responses from the service worker: ${fromSw.join(' ')}`);
  expect(failed, 'failed requests after going offline').toEqual([]);
  expect(notFromSw, 'responses not from the service worker after going offline').toEqual([]);
  expect(fromSw, 'the service worker answered the reload').toContain('/');
  expect(
    fromSw.some((p) => /^\/assets\/weights-[^/]+\.bin$/.test(p)),
    'the service worker answered the worker’s Silero weights fetch',
  ).toBe(true);
});
