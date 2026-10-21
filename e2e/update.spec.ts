import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import type { StateName } from '../src/app/events.ts';
import { expectMicSignal, noCspViolationsAfterEach, steps, tapToWake } from './helpers/app';
import { expectNoEnforcedViolations, installCspRecorder } from './helpers/csp';
import { micFlags } from './helpers/flags';

// Issue #101 (plan §4.7 update flow, §4.9.3 `update`, §7 M6): the update policy end to end, at one origin.
// e2e/update-proxy.mjs (the third webServer in playwright.config.ts, port 4174) serves the e2e build as v1 or v2
// (scripts/build-update-variants.mjs; `data-build` on <html> names the build) and flips between them on
// `GET /__switch?to=…`, so the page's service worker finds a new version of itself at the same origin.
//
// A new version found while Recording must not reload the page through the rest of the loop (Recording →
// Processing → Playing → Cooldown → Listening). A hide in Listening (→ Paused, row 38) applies it (C11), and the
// page reloads into v2. No request 404s. The page is a first visit, so workbox-window never treats the new worker
// as an update, and the reload is register.ts's own (applyUpdate's `controllerchange` listener, #98).
//
// Timing (issue #275). Chromium runs the update job that `reg.update()` starts at best-effort priority on its UI
// thread, so the check begins 0.45–18 s later on a busy machine (measured; the proxy then answers /sw.js within
// ms, and v2 installs and reports `updateReady` 12–54 ms after it). An update asked for in Recording could miss
// the 10 s take. The spec therefore asks for it in Asleep and holds v2's one precache fetch (/index.html, the
// only file v1 and v2 differ in besides sw.js) with a route, so v2 waits in `installing`. It releases the fetch
// once Recording has begun, and v2 finishes installing through the real path (workbox-window `installed` →
// `onNeedRefresh` → `updateReady`) within ~0.2 s. 'found' is the app's `updateReady` (`onNeedRefresh`); the
// browser's `updatefound` happens in Asleep.
//
// long_12s.wav: 1 s of silence, then a 12 s vowel, which the energy backend records up to the 10 s cap (Silero
// ends this synthetic vowel early, #51), so Recording outlasts the rest of v2's install by far.
test.use({ launchOptions: { args: micFlags('e2e/fixtures/long_12s.wav') } });
test.setTimeout(90_000);
noCspViolationsAfterEach();

/** The update proxy's origin. The spec never uses another one, whatever the config's baseURL. */
const ORIGIN = 'http://localhost:4174';
const APP = 'main#app';
/** The loop's state changes after Recording (step 4). */
const AFTER_RECORDING: readonly StateName[] = ['Processing', 'Playing', 'Cooldown', 'Listening'];
/** Step 2's budget: from reg.update() to v2's held precache fetch, in ms (measured 0.45–18 s; #275). */
const UPDATE_CHECK_MS = 30_000;
/** Step 5's budget: from the hide to a page that runs v2, in ms. */
const APPLY_MS = 5000;

/** The build the page runs: `data-build` on <html> (vite.config.ts). */
async function build(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset.build);
}

/** `GET <ORIGIN><path>`, expecting `status`. */
async function proxyGet(request: APIRequestContext, path: string, status: number) {
  const res = await request.get(`${ORIGIN}${path}`);
  expect(res.status(), `GET ${path}`).toBe(status);
  return res;
}

/** The proxy's 404 log, `GET /__404s`: one "<METHOD> <path> (<active build>)" per 404. */
async function notFound(request: APIRequestContext): Promise<string[]> {
  const list: unknown = await (await proxyGet(request, '/__404s', 200)).json();
  if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) {
    throw new Error(`/__404s: expected an array of strings, got ${JSON.stringify(list)}`);
  }
  return list;
}

/**
 * Polls `probe` every 100 ms until it returns a value other than null, and returns it; or returns 'reloaded' as
 * soon as `navigations` (step 2's main-frame navigation recorder) is non-empty, so the caller reports the reload.
 * A probe that throws (its page went away in a reload) gets 1 s for the navigation event to arrive; if none did,
 * its own error is thrown. On timeout it fails with the state changes so far.
 */
async function untilOrReload<T>(
  page: Page,
  navigations: readonly string[],
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | null>,
): Promise<T | 'reloaded'> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let hit: T | null;
    try {
      hit = await probe();
    } catch (err) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (navigations.length > 0) return 'reloaded';
      throw err;
    }
    if (navigations.length > 0) return 'reloaded';
    if (hit !== null) return hit;
    if (Date.now() > deadline) {
      const path = (await steps(page)).filter((s) => s.from !== s.to).map((s) => s.to);
      throw new Error(`no ${what} within ${timeoutMs} ms; state changes so far: ${path.join(' → ')}`);
    }
    await page.waitForTimeout(100);
  }
}

/** v2's precache fetch: GET /index.html at the proxy. */
function isIndexHtml(url: URL): boolean {
  return url.origin === ORIGIN && url.pathname === '/index.html';
}

/**
 * A route handler that holds the first /index.html request a service worker makes (v2's install, step 2) until
 * `release()` (step 3), and lets every other request through at once.
 */
function holdSwIndexHtml(): {
  route: (route: Route) => Promise<void>;
  heldAt: () => number;
  release: () => void;
} {
  /** When the first service-worker request was caught (Date.now()), or 0. */
  let heldAt = 0;
  let open: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    async route(route) {
      if (heldAt === 0 && route.request().serviceWorker() !== null) {
        heldAt = Date.now();
        await released;
      }
      await route.continue();
    },
    heldAt: () => heldAt,
    release: () => open?.(),
  };
}

/** Step 4's invariant: no main-frame navigation since step 2. */
function expectNoReload(navigations: readonly string[], when: string): void {
  expect(navigations, `step 4: the page reloaded (main-frame navigation) ${when}`).toEqual([]);
}

test('update: a new version found while Recording waits for the loop, then is applied on hidden in Paused', async ({
  page,
  request,
}) => {
  const app = page.locator(APP);
  /** Main-frame navigations from step 2 on. */
  const navigations: string[] = [];
  let notFoundBefore = 0;

  await test.step('1. first visit to v1: the service worker controls the page', async () => {
    // The proxy serves v1 (a proxy reused from an earlier local run may be on v2), and only the 404s from here
    // on count. On this first visit the service worker installs (precaching v1) and, with clientsClaim, takes
    // control. The energy backend is pinned before the tap, so the take runs to the 10 s cap.
    await proxyGet(request, '/__switch?to=v1', 204);
    notFoundBefore = (await notFound(request)).length;
    await installCspRecorder(page);
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => window.__bearTest !== undefined);
    await expect(app).toHaveAttribute('data-state', 'Asleep');
    await page
      .waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 15_000 })
      .catch((err: unknown) => {
        throw new Error('step 1: the service worker did not control the page within 15 s', { cause: err });
      });
    expect(await build(page), 'step 1: the first visit runs v1').toBe('v1');
    await page.evaluate(() => {
      const h = window.__bearTest;
      if (h === undefined) throw new Error('window.__bearTest is missing');
      h.setVadBackend('energy');
    });
  });

  const hold = holdSwIndexHtml();

  let checkMs = 0;
  await test.step('2. in Asleep: flip to v2, reg.update(); v2 installs up to its held fetch', async () => {
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.context().route(isIndexHtml, hold.route);
    await proxyGet(request, '/__switch?to=v2', 204);
    const asked = Date.now();
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg === undefined) throw new Error('no service worker registration');
      await reg.update();
    });
    await expect
      .poll(() => hold.heldAt(), {
        message: `step 2: v2's install fetched /index.html within ${UPDATE_CHECK_MS} ms of reg.update()`,
        timeout: UPDATE_CHECK_MS,
      })
      .toBeGreaterThan(0);
    checkMs = hold.heldAt() - asked;
    // v2 is still installing, so the update is not ready yet: it can only become ready after the release.
    const pending = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { installing: reg?.installing?.state ?? null, waiting: reg?.waiting?.state ?? null };
    });
    expect(pending, 'step 2: v2 waits in installing, on its held fetch').toEqual({
      installing: 'installing',
      waiting: null,
    });
    expect(await app.getAttribute('data-state'), 'step 2: still Asleep').toBe('Asleep');
    expect(
      (await steps(page)).some((s) => s.e.t === 'updateReady'),
      'step 2: no updateReady before the release',
    ).toBe(false);
  });

  let releasedAt = 0;
  // Then v2 finishes installing, and `onNeedRefresh` dispatches `updateReady`, which the hooks log like every
  // session event. If the page reloads first (an update applied at once: Validation 2's mutation reloads it
  // within milliseconds of `updateReady`), the wait ends there and step 4 reports it.
  const ready =
    await test.step("3. wake; Recording; release v2's fetch: updateReady arrives while Recording", async () => {
      await tapToWake(page);
      await expect(app).toHaveAttribute('data-state', 'Listening', { timeout: 10_000 });
      await expectMicSignal(page);
      await expect(app).toHaveAttribute('data-state', 'Recording', { timeout: 10_000 });
      expect(
        (await steps(page)).some((s) => s.e.t === 'updateReady'),
        'step 3: no updateReady before the release',
      ).toBe(false);
      releasedAt = Date.now();
      hold.release();
      const found = await untilOrReload(page, navigations, 'updateReady', 10_000, async () => {
        const all = await steps(page);
        const i = all.findIndex((s) => s.e.t === 'updateReady');
        return i < 0 ? null : { index: i, state: all[i]!.from };
      });
      await page.context().unroute(isIndexHtml, hold.route);
      // Recording, so step 4 covers the whole rest of the loop.
      if (found !== 'reloaded') {
        expect(
          found.state,
          `step 3: the update was ready while Recording (seen ${Date.now() - releasedAt} ms after the release)`,
        ).toBe('Recording');
      }
      return found;
    });
  const readyAfterMs = Date.now() - releasedAt;

  await test.step('4. no reload through Recording → Processing → Playing → Cooldown → Listening', async () => {
    expectNoReload(navigations, 'right after updateReady, while Recording');
    if (ready === 'reloaded') throw new Error('unreachable: a reload fails the line above');
    let at = ready.index;
    for (const to of AFTER_RECORDING) {
      const from = at;
      const next = await untilOrReload(page, navigations, `a transition into ${to}`, 30_000, async () => {
        const i = (await steps(page)).findIndex((s, k) => k > from && s.to === to && s.from !== to);
        return i < 0 ? null : i;
      });
      expectNoReload(navigations, `before ${to}`);
      if (next === 'reloaded') throw new Error('unreachable: a reload fails the line above');
      at = next;
    }
    const loop = (await steps(page))
      .slice(ready.index)
      .filter((s) => s.from !== s.to)
      .map((s) => s.to);
    expect(loop, 'step 4: the state changes after updateReady are the rest of one loop').toEqual(
      AFTER_RECORDING,
    );
    expectNoReload(navigations, 'through the loop');
    expect(await build(page), 'step 4: the page still runs v1').toBe('v1');
    await expectNoEnforcedViolations(page); // v1's document, before the reload replaces it
  });

  const applyMs =
    await test.step('5. hidden in Listening → Paused applies the update: a reload into v2', async () => {
      const start = Date.now();
      // Settles to null on the navigation, or to the step's error; never rejects, so no failure above it is
      // shadowed by an unhandled rejection.
      const reloaded = page
        .waitForEvent('framenavigated', {
          predicate: (frame) => frame === page.mainFrame(),
          timeout: APPLY_MS,
        })
        .then(
          () => null,
          (err: unknown) =>
            new Error(`step 5: no main-frame navigation within ${APPLY_MS} ms of the hide`, { cause: err }),
        );
      const hide = await page.evaluate(() => {
        const h = window.__bearTest;
        if (h === undefined) throw new Error('window.__bearTest is missing');
        h.setVisibility('hidden');
        const last = h.log.at(-1);
        return last === undefined ? null : { from: last.from, to: last.to, effects: last.effects };
      });
      expect(hide, 'step 5: the hide moved Listening → Paused and applied the update').toEqual({
        from: 'Listening',
        to: 'Paused',
        effects: expect.arrayContaining(['applyUpdate']),
      });
      const missed = await reloaded;
      if (missed !== null) throw missed;
      await expect
        .poll(() => build(page), {
          message: `step 5: the page runs v2 within ${APPLY_MS} ms of the hide`,
          timeout: Math.max(1, start + APPLY_MS - Date.now()),
        })
        .toBe('v2');
      const took = Date.now() - start;
      // The new page boots, and nothing reloads it again.
      await expect(app).toHaveAttribute('data-state', 'Asleep');
      await page.waitForLoadState('networkidle', { timeout: 10_000 });
      expect(navigations, 'step 5: exactly one reload').toHaveLength(1);
      return took;
    });

  await test.step('6. no 404s at the proxy', async () => {
    expect((await notFound(request)).slice(notFoundBefore), 'step 6: 404s at the proxy').toEqual([]);
    // The log itself works: a missing path shows up in it.
    await proxyGet(request, '/update-spec-missing.js', 404);
    expect((await notFound(request)).slice(notFoundBefore), 'step 6: the 404 log records a 404').toEqual([
      'GET /update-spec-missing.js (v2)',
    ]);
  });

  console.log(
    `update: v2's precache fetch held ${checkMs} ms after reg.update(); ` +
      `updateReady seen ${readyAfterMs} ms after the release, while ${ready === 'reloaded' ? '?' : ready.state}; ` +
      `v2 running ${applyMs} ms after the hide; navigations ${JSON.stringify(navigations)}`,
  );
});
