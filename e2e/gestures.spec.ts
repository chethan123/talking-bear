import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { RegionId } from '../src/input/region-ids.ts';
import { noCspViolationsAfterEach, wake } from './helpers/app';
import { micFlags } from './helpers/flags';

// Plan §4.9.3 `gestures`, §7 M5 (issue #93): multi-touch through CDP `Input.dispatchTouchEvent`, end to end
// through the pointer adapter, the recogniser, the reactions table, the director and the session.
//
// - The mic input is deliberately silent (silence_2s), so there is no `expectMicSignal`: the spec only waits for
//   Listening.
// - CDP touch points are viewport CSS px. Every `touchMove` lists every point still down: a point left out of
//   a `touchMove` counts as released. `touchEnd` lists none (all up).
// - Points come from `__bearTest.regionCenter(id)`: a hit region's centre over the bear's current bone matrices.
// - What `__bearTest.events` shows besides the reaction each step waits for: every touchStart's `tap down` adds its
//   region's tap reaction (the pinch's `cheekPuffL` and `cheekPuffR`, the tickle's and long-press's
//   `bellyBoing`); the tickle zig-zag first emits a belly `stroke start`, `update` and `end`, none with a
//   reaction, then `tickle`; the pinch's all-up release adds `squish` with its `pop`.
test.use({ hasTouch: true, launchOptions: { args: micFlags('e2e/fixtures/silence_2s.wav') } });
test.setTimeout(60_000);
noCspViolationsAfterEach();

declare global {
  interface Window {
    /** This spec's recorder: `defaultPrevented` of every `contextmenu` that reached the window. */
    bearContextMenus?: boolean[];
  }
}

interface Point {
  x: number;
  y: number;
}

/** After each gesture: its reaction plays out and the (region, gesture) cooldowns pass before the next one. */
const GAP_MS = 1_200;

function isPoint(v: unknown): v is Point {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof Reflect.get(v, 'x') === 'number' &&
    typeof Reflect.get(v, 'y') === 'number'
  );
}

/**
 * `__bearTest.regionCenter(id)` (#93): a hit region's centre in viewport CSS px. e2e/helpers/app.ts doesn't restate
 * this hook, so it is read through Reflect and checked, as screenshots.spec.ts and mouth-sync.spec.ts do.
 */
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

/** Two points that start at `a` and `b` and move 1.5 px toward each other 10 times, 30 ms apart (span −30 px). */
async function converge(page: Page, cdp: CDPSession, a: Point, b: Point): Promise<void> {
  const s = Math.sign(b.x - a.x);
  await touch(cdp, 'touchStart', [a, b]);
  for (let k = 1; k <= 10; k++) {
    await page.waitForTimeout(30);
    const d = 1.5 * k * s;
    await touch(cdp, 'touchMove', [
      { x: a.x + d, y: a.y },
      { x: b.x - d, y: b.y },
    ]);
  }
  await touch(cdp, 'touchEnd', []);
}

test('gestures: a nose tap, a pinch, a hug, a tickle and a belly long-press react; no context menu', async ({
  page,
}) => {
  await wake(page);
  await page.evaluate(() => {
    window.bearContextMenus = [];
    // Bubble phase on the window: after the stage's own listener has had its say.
    window.addEventListener('contextmenu', (e) => {
      window.bearContextMenus?.push(e.defaultPrevented);
    });
  });
  const cdp = await page.context().newCDPSession(page);

  // A single tap on the nose → sneeze.
  const nose = await regionCenter(page, 'nose');
  await touch(cdp, 'touchStart', [nose]);
  await touch(cdp, 'touchEnd', []);
  await expectReaction(page, 'sneeze');
  await page.waitForTimeout(GAP_MS);

  // Pinch: the cheeks → squish.
  await converge(page, cdp, await regionCenter(page, 'cheekL'), await regionCenter(page, 'cheekR'));
  await expectReaction(page, 'squish');
  await page.waitForTimeout(GAP_MS);

  // Hug: the flanks → hug.
  await converge(page, cdp, await regionCenter(page, 'flankL'), await regionCenter(page, 'flankR'));
  await expectReaction(page, 'hug');
  await page.waitForTimeout(GAP_MS);

  // Tickle: a zig-zag on the belly, 8 segments of 20 px 40 ms apart (7 reversals in ≈ 320 ms) → giggle.
  const belly = await regionCenter(page, 'belly');
  await touch(cdp, 'touchStart', [{ x: belly.x - 10, y: belly.y }]);
  for (let k = 1; k <= 8; k++) {
    await page.waitForTimeout(40);
    await touch(cdp, 'touchMove', [{ x: belly.x + (k % 2 === 1 ? 10 : -10), y: belly.y }]);
  }
  await touch(cdp, 'touchEnd', []);
  await expectReaction(page, 'giggle');
  await page.waitForTimeout(GAP_MS);

  // A long-press on the belly → belly rub.
  const held = await regionCenter(page, 'belly');
  await touch(cdp, 'touchStart', [held]);
  await page.waitForTimeout(800);
  await touch(cdp, 'touchEnd', []);
  await expectReaction(page, 'bellyRub');

  // A right-click on the background fires a contextmenu (a CDP touch long-press fires none on desktop Linux):
  // the recorder sees at least one, and the stage prevented every default.
  const box = await page.locator('canvas.stage').boundingBox();
  if (box === null) throw new Error('canvas.stage has no box');
  await page.mouse.click(box.x + 20, box.y + box.height / 2, { button: 'right' });
  const menus = await page.evaluate(() => window.bearContextMenus ?? []);
  expect(menus.length, 'contextmenu events recorded').toBeGreaterThanOrEqual(1);
  expect(menus, 'defaultPrevented of every contextmenu').toEqual(menus.map(() => true));
});
