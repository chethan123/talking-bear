import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { RegionId } from '../src/input/region-ids.ts';
import { expectMicSignal, steps, tapToWake, waitForLoop, type Woke } from './helpers/app';
import { expectNoEnforcedViolations, getReportOnlyViolations, installCspRecorder } from './helpers/csp';
import { micFlags } from './helpers/flags';

// Plan §4.8.3 (Trusted Types), §4.9.3 (CSP assertions), §5 X-P5, §7 M8 (issue #121): the full flow under the
// production headers, with Trusted Types enforced on HTML: load, wake, one loop on espeak-ng speech, a nose tap and a
// belly tickle, the settings sheet opened (1 s press of the gear) and closed, and a service worker update check. It
// runs twice, on `/` and with the developer overlay open (`/?debug=1`, whose mount path is otherwise never loaded),
// and asserts zero `enforce` and zero `report` CSP violations. The `report` ones (the X-P5 list, which plan §4.9.3
// requires empty from M8) still go to test-results/xp5-report-only.json on every run, green or red, for CI's
// `xp5-report-only` artifact.
//
// - The fake mic plays tts_sentence_a once (`%noloop`), then silence: after the one loop nothing else is recorded,
//   so the gestures and the gear (refused while Recording, Processing or Playing) never race a recording.
// - Gestures are CDP touch events at `__bearTest.regionCenter(id)`, as in gestures.spec.ts.
// - Non-vacuous: the document carries one CSP field, the common policy with the Trusted Types directives merged in,
//   and no Report-Only header; the `default` policy exists, passes same-origin script URLs unchanged and throws on any
//   other origin; it is main.ts's first import; /sw.js and the entry module carry the common CSP only (HTML only).
test.use({ hasTouch: true, launchOptions: { args: micFlags('e2e/fixtures/tts_sentence_a.wav') } });

/** Where the X-P5 list goes, under the project's output directory (test-results/), for CI to upload. */
const XP5_FILE = 'xp5-report-only.json';
const CSP = 'Content-Security-Policy';
/** The M7 header (T98). From M8 no response carries it. */
const REPORT_ONLY = 'Content-Security-Policy-Report-Only';
/** After each gesture: its reaction plays out and the cooldowns pass before the next one (gestures.spec.ts). */
const GAP_MS = 1_200;
/** The gear opens the sheet after a press this long (src/ui/settings-sheet.ts GEAR_HOLD_MS = 1000), plus margin. */
const GEAR_PRESS_MS = 1_300;

/** The two runs of the flow. The overlay mounts with `?debug=1` in any build (src/main.ts `boot`). */
const LEGS: readonly { title: string; path: string; overlay: boolean }[] = [
  { title: 'the app', path: '/', overlay: false },
  { title: 'the debug overlay open, ?debug=1', path: '/?debug=1', overlay: true },
];

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

/**
 * The CSP values server/headers.json makes: `common` on every response, and `html`, text/html's one field, the common
 * CSP with htmlOnly's same-name value merged in (server/headers.go `htmlHeaders`, issue #121).
 */
function expectedCsps(): { common: string; html: string } {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.resolve('server/headers.json'), 'utf8'));
  const field = (map: string, name: string): unknown => {
    const m: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, map) : null;
    return typeof m === 'object' && m !== null ? Reflect.get(m, name) : undefined;
  };
  const common = field('common', CSP);
  const html = field('htmlOnly', CSP);
  if (typeof common !== 'string') throw new Error(`server/headers.json: common has no ${CSP}`);
  if (typeof html !== 'string') throw new Error(`server/headers.json: htmlOnly has no ${CSP}`);
  if (field('htmlOnly', REPORT_ONLY) !== undefined)
    throw new Error(`server/headers.json: htmlOnly has ${REPORT_ONLY}`);
  return { common, html: `${common}; ${html}` };
}

/** Every value of header `name` in a response's raw header list (one entry per field). */
function fieldValues(fields: readonly { name: string; value: string }[], name: string): string[] {
  return fields.filter((f) => f.name.toLowerCase() === name.toLowerCase()).map((f) => f.value);
}

/**
 * e2e/helpers/app.ts `openApp` at `url`: installs the CSP recorder, opens the page and waits until the app has booted
 * into Asleep with its test hooks. The document must carry exactly one CSP field, `html`, and no Report-Only field.
 */
async function openAt(page: Page, url: string, html: string): Promise<void> {
  await installCspRecorder(page);
  const res = await page.goto(url);
  if (res === null) throw new Error(`page.goto('${url}') returned no response`);
  const fields = await res.headersArray();
  expect(fieldValues(fields, CSP), `${url}: the document's ${CSP} fields`).toEqual([html]);
  expect(fieldValues(fields, REPORT_ONLY), `${url}: the document's ${REPORT_ONLY} fields`).toEqual([]);
  await page.waitForFunction(() => window.__bearTest !== undefined);
  await expect(page.locator('main#app')).toHaveAttribute('data-state', 'Asleep');
}

/** e2e/helpers/app.ts `wake` after `openAt`: taps the app awake and returns the step into Listening. */
async function wakeFrom(page: Page): Promise<Woke> {
  await tapToWake(page);
  await expect(page.locator('main#app')).toHaveAttribute('data-state', 'Listening', { timeout: 10_000 });
  const at = Date.now();
  const all = await steps(page);
  const index = all.findLastIndex((s) => s.to === 'Listening' && s.from !== 'Listening');
  const step = all[index];
  if (step === undefined) throw new Error('data-state is Listening, but the log has no transition into it');
  return { index, logT: step.t, at };
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

/**
 * One CDP touch event; `points` are all the touch points down after it. `timestamp` (seconds since the epoch, CDP
 * `TimeSinceEpoch`) becomes the event's own time; without it the browser stamps the event when it gets it.
 */
async function touch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  points: readonly Point[],
  timestamp?: number,
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
    ...(timestamp === undefined ? {} : { timestamp }),
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

// Every run that reached the page, green or red: add this test's report-only violations to the X-P5 list first
// (Playwright empties the output directory at the start of a run, so the file holds this run's list), then assert no
// violation of either kind.
test.afterEach(async ({ page }, testInfo) => {
  // A failure before navigation (the first-import check, headers.json) leaves nothing to record or assert.
  if (page.url() === 'about:blank') return;
  const reportOnly = await getReportOnlyViolations(page);
  const file = path.join(testInfo.project.outputDir, XP5_FILE);
  fs.mkdirSync(testInfo.project.outputDir, { recursive: true });
  const earlier: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const list = [...(Array.isArray(earlier) ? earlier : []), ...reportOnly];
  fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
  console.log(
    `X-P5 report-only list, ${testInfo.title} (${reportOnly.length}): ${JSON.stringify(reportOnly)}`,
  );
  await expectNoEnforcedViolations(page);
  expect(reportOnly, 'report-only CSP violations (the X-P5 list, empty from M8: plan §4.9.3)').toEqual([]);
});

for (const leg of LEGS) {
  test(`csp (${leg.title}): the full flow under enforced Trusted Types has no CSP violation`, async ({
    page,
  }) => {
    // Plan §4.8.3: the policy module is the first import of main.ts (ES imports are hoisted). No sink runs at module
    // top level today, so the flow alone would not notice it moving down: guard the source.
    const firstImport = /^import\s[^;]*;/m.exec(fs.readFileSync(path.resolve('src/main.ts'), 'utf8'))?.[0];
    expect(firstImport, 'the first import of src/main.ts').toBe("import './security/tt-policy.ts';");
    const csps = expectedCsps();

    await test.step('load and wake', async () => {
      await openAt(page, leg.path, csps.html);
      if (leg.overlay) {
        // The overlay mounts once its module has loaded (#57). Under enforced Trusted Types an HTML sink in its mount
        // path throws and the overlay never appears, so wait for either, then report the violation before the overlay.
        await expect
          .poll(
            () =>
              page.evaluate(
                () =>
                  document.querySelector('.debug-overlay') !== null ||
                  (window.__cspViolations ?? []).some((v) => v.disposition === 'enforce'),
              ),
            { message: 'the debug overlay mounted, or an enforced CSP violation', timeout: 10_000 },
          )
          .toBe(true);
        await expectNoEnforcedViolations(page);
        await expect(page.locator('.debug-overlay')).toBeVisible();
      }
      const woke = await wakeFrom(page);
      const policy = await page.evaluate(() => {
        const tt: unknown = Reflect.get(globalThis, 'trustedTypes');
        const p: unknown = typeof tt === 'object' && tt !== null ? Reflect.get(tt, 'defaultPolicy') : null;
        return typeof p === 'object' && p !== null ? Reflect.get(p, 'name') : null;
      });
      expect(policy, 'trustedTypes.defaultPolicy.name').toBe('default');
      // The policy's rules: same-origin script URLs pass unchanged, any other origin throws, and there is no createHTML
      // or createScript rule. The flow never passes a cross-origin URL or an HTML string, so these probes are where a
      // policy that allows everything would show.
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
      // HTML and script text: the policy has no createHTML or createScript rule, so every such sink throws.
      const otherRules = await page.evaluate(() => {
        const tt: unknown = Reflect.get(globalThis, 'trustedTypes');
        const p: unknown = typeof tt === 'object' && tt !== null ? Reflect.get(tt, 'defaultPolicy') : null;
        const probes = [
          ['createHTML', '<b>x</b>'],
          ['createScript', '1'],
        ] as const;
        return probes.map(([name, input]) => {
          const fn: unknown = typeof p === 'object' && p !== null ? Reflect.get(p, name) : null;
          if (typeof fn !== 'function') return `missing:${name}`;
          try {
            Reflect.apply(fn, p, [input]);
            return `ok:${name}`;
          } catch (e) {
            return e instanceof Error ? `throw:${e.name}` : `throw:${String(e)}`;
          }
        });
      });
      expect(otherRules, 'the default policy blesses no HTML or script text').toEqual([
        'throw:TypeError',
        'throw:TypeError',
      ]);

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

      // A zig-zag on the belly, 8 segments of 20 px 40 ms apart (gestures.spec.ts) → giggle. Each event carries its
      // own CDP timestamp, 40 ms apart: the recognizer reads each event's own `timeStamp`, and awaited CDP sends
      // stretch real time when the renderer stalls (ORCH-PLAN-REVIEW v1 finding 1 on #121: a 584 ms stall with the
      // overlay mounted pushed the moves past the 600 ms tickle window).
      const belly = await regionCenter(page, 'belly');
      const base = Date.now() / 1000;
      await touch(cdp, 'touchStart', [{ x: belly.x - 10, y: belly.y }], base);
      for (let k = 1; k <= 8; k++) {
        await page.waitForTimeout(40);
        await touch(
          cdp,
          'touchMove',
          [{ x: belly.x + (k % 2 === 1 ? 10 : -10), y: belly.y }],
          base + k * 0.04,
        );
      }
      await touch(cdp, 'touchEnd', [], base + 0.36);
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

    await test.step('HTML only: /sw.js and the entry module carry the common CSP only', async () => {
      const html = await (await page.request.get('/')).text();
      const entry = /<script type="module"[^>]*\ssrc="([^"]+)"/.exec(html)?.[1];
      if (entry === undefined) throw new Error('index.html has no module script');
      for (const url of ['/sw.js', entry]) {
        const res = await page.request.get(url);
        expect(res.status(), url).toBe(200);
        const fields = res.headersArray();
        expect(fieldValues(fields, CSP), `${url}: ${CSP}`).toEqual([csps.common]);
        expect(fieldValues(fields, REPORT_ONLY), `${url}: ${REPORT_ONLY}`).toEqual([]);
      }
      const root = (await page.request.get('/')).headersArray();
      expect(fieldValues(root, CSP), `/: ${CSP}`).toEqual([csps.html]);
      expect(fieldValues(root, REPORT_ONLY), `/: ${REPORT_ONLY}`).toEqual([]);
    });
  });
}
