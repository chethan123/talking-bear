import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { RegionId } from '../src/input/region-ids.ts';
import { expectMicSignal, waitForLoop, wake } from './helpers/app';
import { expectNoEnforcedViolations, getReportOnlyViolations } from './helpers/csp';
import { micFlags } from './helpers/flags';

// Plan §4.8.3 (Trusted Types), §4.9.3 (CSP assertions), §5 X-P5, §7 M7 (issue #109): the full flow under the
// production headers, Trusted Types included in Report-Only on HTML: load, wake, one loop on espeak-ng speech, a nose
// tap and a belly tickle, the settings sheet opened (1 s press of the gear) and closed, and a service worker update
// check. It asserts zero `enforce` CSP violations, and collects the `report` ones (the X-P5 list) into
// test-results/xp5-report-only.json on every run, green or red. In M7 that list is recorded, not asserted; M8
// enforces Trusted Types if it is empty.
//
// - The fake mic plays tts_sentence_a once (`%noloop`), then silence: after the one loop nothing else is recorded,
//   so the gestures and the gear (refused while Recording, Processing or Playing) never race a recording.
// - Gestures are CDP touch events at `__bearTest.regionCenter(id)`, as in gestures.spec.ts.
// - Non-vacuous: the page's own document carries the Report-Only Trusted Types header; the `default` policy exists,
//   passes same-origin script URLs unchanged and throws on any other origin; it is main.ts's first import; and /sw.js
//   and the entry module don't carry the header (HTML only).
test.use({ hasTouch: true, launchOptions: { args: micFlags('e2e/fixtures/tts_sentence_a.wav') } });

/** Where the X-P5 list goes, under the project's output directory (test-results/), for CI to upload. */
const XP5_FILE = 'xp5-report-only.json';
/** The header that carries the Trusted Types directives in M7 (server/headers.json `htmlOnly`). */
const REPORT_ONLY = 'Content-Security-Policy-Report-Only';
/** After each gesture: its reaction plays out and the cooldowns pass before the next one (gestures.spec.ts). */
const GAP_MS = 1_200;
/** The gear opens the sheet after a press this long (src/ui/settings-sheet.ts GEAR_HOLD_MS = 1000), plus margin. */
const GEAR_PRESS_MS = 1_300;

interface Point {
  x: number;
  y: number;
}

function isPoint(v: unknown): v is Point {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof Reflect.get(v, 'x') === 'number' &&
    typeof Reflect.get(v, 'y') === 'number'
  );
}

/** server/headers.json's `htmlOnly` value of the Report-Only header: what `/` must carry. */
function expectedReportOnly(): string {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.resolve('server/headers.json'), 'utf8'));
  const htmlOnly: unknown =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'htmlOnly') : null;
  const value: unknown =
    typeof htmlOnly === 'object' && htmlOnly !== null ? Reflect.get(htmlOnly, REPORT_ONLY) : null;
  if (typeof value !== 'string') throw new Error(`server/headers.json: htmlOnly has no ${REPORT_ONLY}`);
  return value;
}

/** `__bearTest.regionCenter(id)` (#93), read through Reflect and checked, as gestures.spec.ts does. */
async function regionCenter(page: Page, id: RegionId): Promise<Point> {
  const p: unknown = await page.evaluate((r) => {
    const hooks: unknown = window.__bearTest;
    const fn: unknown =
      typeof hooks === 'object' && hooks !== null ? Reflect.get(hooks, 'regionCenter') : null;
    if (typeof fn !== 'function') throw new Error('window.__bearTest.regionCenter is missing');
    const point: unknown = Reflect.apply(fn, hooks, [r]);
    return point;
  }, id);
  if (!isPoint(p)) throw new Error(`regionCenter(${id}) returned ${JSON.stringify(p)}`);
  return p;
}

/** One CDP touch event; `points` are all the touch points down after it. */
async function touch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  points: readonly Point[],
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
  });
}

/** Waits up to 5 s for a `reaction` named `name` in `__bearTest.events`. */
async function expectReaction(page: Page, name: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window.__bearTest?.events ?? []).flatMap((entry) =>
            entry.e.t === 'reaction' ? [entry.e.name] : [],
          ),
        ),
      { message: `a ${name} reaction in __bearTest.events`, timeout: 5_000 },
    )
    .toContain(name);
}

// Every run, green or red: write the X-P5 list first, then assert no enforced violation.
test.afterEach(async ({ page }, testInfo) => {
  const reportOnly = await getReportOnlyViolations(page);
  fs.mkdirSync(testInfo.project.outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(testInfo.project.outputDir, XP5_FILE),
    `${JSON.stringify(reportOnly, null, 2)}\n`,
  );
  console.log(`X-P5 report-only list (${reportOnly.length}): ${JSON.stringify(reportOnly)}`);
  await expectNoEnforcedViolations(page);
});

test('csp: the full flow has no enforced CSP violation; the Trusted Types report-only list is recorded', async ({
  page,
}) => {
  // Plan §4.8.3: the policy module is the first import of main.ts (ES imports are hoisted). No sink runs at module top
  // level today, so the flow alone would not notice it moving down: guard the source.
  const firstImport = /^import\s[^;]*;/m.exec(fs.readFileSync(path.resolve('src/main.ts'), 'utf8'))?.[0];
  expect(firstImport, 'the first import of src/main.ts').toBe("import './security/tt-policy.ts';");
  const wantReportOnly = expectedReportOnly();
  const documents: (string | null)[] = [];
  page.on('response', (res) => {
    if (res.request().isNavigationRequest() && res.request().frame() === page.mainFrame()) {
      documents.push(res.headers()[REPORT_ONLY.toLowerCase()] ?? null);
    }
  });

  await test.step('load and wake', async () => {
    const woke = await wake(page);
    expect(documents, 'the document carries Trusted Types in Report-Only').toEqual([wantReportOnly]);
    const policy = await page.evaluate(() => {
      const tt: unknown = Reflect.get(globalThis, 'trustedTypes');
      const p: unknown = typeof tt === 'object' && tt !== null ? Reflect.get(tt, 'defaultPolicy') : null;
      return typeof p === 'object' && p !== null ? Reflect.get(p, 'name') : null;
    });
    expect(policy, 'trustedTypes.defaultPolicy.name').toBe('default');
    // The policy's rule: same-origin script URLs pass unchanged, any other origin throws. The flow only ever passes
    // same-origin URLs, so this is the one place a policy that allows everything would show.
    const results = await page.evaluate(
      (inputs) => {
        const tt: unknown = Reflect.get(globalThis, 'trustedTypes');
        const p: unknown = typeof tt === 'object' && tt !== null ? Reflect.get(tt, 'defaultPolicy') : null;
        const fn: unknown = typeof p === 'object' && p !== null ? Reflect.get(p, 'createScriptURL') : null;
        if (typeof fn !== 'function')
          throw new Error('trustedTypes.defaultPolicy.createScriptURL is missing');
        return inputs.map((u) => {
          try {
            const r: unknown = Reflect.apply(fn, p, [u]);
            return `ok:${String(r)}`;
          } catch (e) {
            return e instanceof Error ? `throw:${e.name}:${e.message}` : `throw:${String(e)}`;
          }
        });
      },
      ['sw.js', '/assets/x.js', 'https://example.com/x.js', 'data:text/javascript,1'],
    );
    expect(results.slice(0, 3), 'createScriptURL').toEqual([
      'ok:sw.js',
      'ok:/assets/x.js',
      'throw:TypeError:blocked script URL: https://example.com/x.js',
    ]);
    expect(results[3], 'createScriptURL(data:)').toMatch(/^throw:TypeError:blocked script URL:/);

    await test.step('one loop', async () => {
      await expectMicSignal(page);
      await waitForLoop(page, woke, 15_000);
    });
  });

  await test.step('gestures: a nose tap, a belly tickle', async () => {
    const cdp = await page.context().newCDPSession(page);
    const nose = await regionCenter(page, 'nose');
    await touch(cdp, 'touchStart', [nose]);
    await touch(cdp, 'touchEnd', []);
    await expectReaction(page, 'sneeze');
    await page.waitForTimeout(GAP_MS);

    // A zig-zag on the belly, 8 segments of 20 px 40 ms apart (gestures.spec.ts) → giggle.
    const belly = await regionCenter(page, 'belly');
    await touch(cdp, 'touchStart', [{ x: belly.x - 10, y: belly.y }]);
    for (let k = 1; k <= 8; k++) {
      await page.waitForTimeout(40);
      await touch(cdp, 'touchMove', [{ x: belly.x + (k % 2 === 1 ? 10 : -10), y: belly.y }]);
    }
    await touch(cdp, 'touchEnd', []);
    await expectReaction(page, 'giggle');
    await expect(page.locator('main#app')).toHaveAttribute('data-state', 'Listening', { timeout: 10_000 });
  });

  await test.step('the settings sheet: a 1 s press of the gear opens it, Close closes it', async () => {
    const gear = page.getByRole('button', { name: 'Settings' });
    const sheet = page.locator('dialog.settings-sheet');
    await expect(sheet).toBeHidden();
    await gear.hover();
    await page.mouse.down();
    await page.waitForTimeout(GEAR_PRESS_MS);
    await page.mouse.up();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toBeHidden();
  });

  await test.step('a service worker update check: reg.update()', async () => {
    const scriptURL = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      await reg.update();
      return reg.active?.scriptURL ?? null;
    });
    expect(scriptURL, 'the active service worker').toMatch(/\/sw\.js$/);
  });

  await test.step('HTML only: /sw.js and the entry module have no Report-Only header', async () => {
    const html = await (await page.request.get('/')).text();
    const entry = /<script type="module"[^>]*\ssrc="([^"]+)"/.exec(html)?.[1];
    if (entry === undefined) throw new Error('index.html has no module script');
    for (const url of ['/sw.js', entry]) {
      const res = await page.request.get(url);
      expect(res.status(), url).toBe(200);
      expect(res.headers()[REPORT_ONLY.toLowerCase()], `${url}: ${REPORT_ONLY}`).toBeUndefined();
    }
    const root = await page.request.get('/');
    expect(root.headers()[REPORT_ONLY.toLowerCase()], `/: ${REPORT_ONLY}`).toBe(wantReportOnly);
  });
});
