import { rmSync } from 'node:fs';
import { chromium, expect, test, type TestInfo } from '@playwright/test';

// Issue #100 (plan §4.9.3 `installability`, §5 X-P1): Chrome's own installability check over CDP,
// Page.getInstallabilityErrors, which needs the full Chromium (`channel: 'chromium'`, playwright.config.ts): the
// headless shell's stub always returns [].
//
// Each test launches its own persistent context (a fresh profile in the test's output dir, removed afterwards).
// Playwright's default contexts are off the record, and Chrome reports `in-incognito` for every page in one
// (plan §4.7: an installable origin is "Not incognito"), which would fail the positive test and make the negative
// control pass for the wrong reason.
//
// The negative control serves the same build with a manifest that has no `purpose: "any"` icon (the second
// webServer in playwright.config.ts, port 4175, e2e/fixtures/bad-manifest/make.mjs). It must report errors, and
// among them the missing icon, so the check isn't vacuous.

/** The negative control's origin: dist-e2e-badmanifest, served by the second webServer. */
const BAD_MANIFEST_ORIGIN = 'http://localhost:4175';

/** The launch options of the project (`channel`, `headless`) and its baseURL, from the test's fixtures. */
interface Launch {
  channel: string | undefined;
  headless: boolean;
  baseURL: string | undefined;
}

/** Opens `url` in a fresh persistent context, waits for its service worker, and returns Chrome's verdict. */
async function checkInstallability(url: string, launch: Launch, testInfo: TestInfo) {
  const profile = testInfo.outputPath('profile');
  const context = await chromium.launchPersistentContext(profile, launch);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const cdp = await page.context().newCDPSession(page);
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    console.log(`${url}: installabilityErrors ${JSON.stringify(installabilityErrors)}`);
    return installabilityErrors;
  } finally {
    await context.close();
    // The profile (about 5 MB) is of no use afterwards; on a failure, the trace and the logged errors remain.
    rmSync(profile, { recursive: true, force: true });
  }
}

test('installability: Chrome reports no installability errors for the app', async ({
  channel,
  headless,
  baseURL,
}, testInfo) => {
  expect(await checkInstallability('/', { channel, headless, baseURL }, testInfo)).toEqual([]);
});

test('installability (negative control): a manifest without an `any` icon is not installable', async ({
  channel,
  headless,
  baseURL,
}, testInfo) => {
  const errors = await checkInstallability(
    `${BAD_MANIFEST_ORIGIN}/`,
    { channel, headless, baseURL },
    testInfo,
  );
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.map((e) => e.errorId)).toContain('manifest-missing-suitable-icon');
});
