import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { RegionId } from '../src/input/region-ids.ts';
import { noCspViolationsAfterEach, openApp, tapToWake, wake } from './helpers/app';
import { micFlags } from './helpers/flags';

// Accessibility end to end (plan §7 M8, issue #118): the canvas's accessible name, every button's name (the character
// swap button's in Asleep, and its absence from the tree once awake: duck plan T126), the one
// aria-live region (it reads the Asleep text after boot, is cleared on waking, and nothing in Listening, a reaction
// or a pause changes it; Paused is not announced, ORCH-NOTE on #118), and reduced motion and Gentle mode playing the
// gentle clips, with a control that plays the full ones.
//
// - Gestures are CDP touch events, as in gestures.spec.ts; points come from `__bearTest.regionCenter`.
// - `__bearTest.pose()` (#118) names the director's clip; e2e/helpers/app.ts doesn't restate it (or regionCenter),
//   so both are read through Reflect and checked. An in-page sampler records every change of the clip name every
//   10 ms, with its `performance.now()` time.
// - "A belly tickle kept up for 3.5 s": the zig-zag goes on until 3.5 s have passed since the sampler first saw
//   `giggle` AND the escalation's clip has been sampled (`laughFitGentle` with reduced motion or Gentle mode,
//   `laughFit` in the control), and fails 8 s after the first giggle. The director escalates on the first sustained
//   tickle more than 3 s into the run, ~3.0–3.7 s after giggle starts. The control proves the same tickle reaches
//   `laughFit`, so "never laughFit" in the gentle tests is not vacuous.
// - The mic input is silent (silence_2s), so nothing is recorded: the loop never leaves Listening on its own.
test.use({ hasTouch: true, launchOptions: { args: micFlags('e2e/fixtures/silence_2s.wav') } });
test.setTimeout(60_000);
noCspViolationsAfterEach();

declare global {
  interface Window {
    /** This spec's clip sampler: every change of `__bearTest.pose().clip`, with its performance.now() time. */
    bearClips?: { t: number; clip: string | null }[];
    /** This spec's live-region recorder: mutations seen since it was installed. */
    bearLiveMutations?: number;
  }
}

interface Point {
  x: number;
  y: number;
}

const APP = 'main#app';
const LIVE = '[data-a11y-live]';
/** Every element that is a live region (an `aria-live` other than off, or an implicitly live role without one). */
const LIVE_REGIONS =
  '[aria-live]:not([aria-live="off"]), :is([role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"]):not([aria-live]), output:not([aria-live])';
const ASLEEP_TEXT = 'Juni is asleep. Tap to wake.';
/** After each gesture: its reaction plays out and the cooldowns pass before the next one (gestures.spec.ts). */
const GAP_MS = 1_200;
/** The tickle goes on for at least this long after the first giggle … */
const TICKLE_MIN_MS = 3_500;
/** … and fails if the escalation hasn't been sampled this long after it. */
const TICKLE_CAP_MS = 8_000;

function isPoint(v: unknown): v is Point {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof Reflect.get(v, 'x') === 'number' &&
    typeof Reflect.get(v, 'y') === 'number'
  );
}

/** `__bearTest.regionCenter(id)`: a hit region's centre in viewport CSS px (as gestures.spec.ts reads it). */
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

/** Starts the in-page clip sampler (`window.bearClips`), after checking `__bearTest.pose()` answers. */
async function startClipSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const hooks: unknown = window.__bearTest;
    const fn: unknown = typeof hooks === 'object' && hooks !== null ? Reflect.get(hooks, 'pose') : null;
    if (typeof fn !== 'function') throw new Error('window.__bearTest.pose is missing');
    const read = (): string | null => {
      const pose: unknown = Reflect.apply(fn, hooks, []);
      const clip: unknown = typeof pose === 'object' && pose !== null ? Reflect.get(pose, 'clip') : undefined;
      if (clip !== null && typeof clip !== 'string')
        throw new Error(`pose().clip is ${JSON.stringify(clip)}`);
      return clip;
    };
    const clips: { t: number; clip: string | null }[] = [{ t: performance.now(), clip: read() }];
    window.bearClips = clips;
    setInterval(() => {
      const clip = read();
      if (clips.at(-1)?.clip !== clip) clips.push({ t: performance.now(), clip });
    }, 10);
  });
}

/** Every clip name the sampler has seen, in order of first appearance. */
async function clipsSeen(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() => [...new Set((window.bearClips ?? []).map((c) => c.clip))]);
}

/** Taps the nose and waits up to 3 s for the sampler to see `clip`. */
async function tapNose(page: Page, cdp: CDPSession, clip: string): Promise<void> {
  const nose = await regionCenter(page, 'nose');
  await touch(cdp, 'touchStart', [nose]);
  await touch(cdp, 'touchEnd', []);
  await expect.poll(() => clipsSeen(page), { message: `the ${clip} clip`, timeout: 3_000 }).toContain(clip);
}

/**
 * A belly zig-zag (20 px segments, 40 ms apart, as gestures.spec.ts) kept up until TICKLE_MIN_MS have passed since
 * the sampler first saw `giggle` and it has seen `escalation`; fails TICKLE_CAP_MS after the first giggle.
 */
async function tickle(page: Page, cdp: CDPSession, escalation: string): Promise<void> {
  const belly = await regionCenter(page, 'belly');
  await touch(cdp, 'touchStart', [{ x: belly.x - 10, y: belly.y }]);
  try {
    for (let k = 1; ; k++) {
      await page.waitForTimeout(40);
      await touch(cdp, 'touchMove', [{ x: belly.x + (k % 2 === 1 ? 10 : -10), y: belly.y }]);
      const st = await page.evaluate((esc) => {
        const clips = window.bearClips ?? [];
        return {
          giggleAt: clips.find((c) => c.clip === 'giggle')?.t ?? null,
          escalated: clips.some((c) => c.clip === esc),
          now: performance.now(),
        };
      }, escalation);
      if (st.giggleAt === null) {
        if (k >= 50) throw new Error('no giggle after 2 s of tickling');
        continue;
      }
      const since = st.now - st.giggleAt;
      if (since >= TICKLE_MIN_MS && st.escalated) return;
      if (since >= TICKLE_CAP_MS) {
        throw new Error(
          `no ${escalation} ${TICKLE_CAP_MS} ms after the first giggle: ${String(await clipsSeen(page))}`,
        );
      }
    }
  } finally {
    await touch(cdp, 'touchEnd', []);
  }
}

/** `prefers-reduced-motion: reduce` as the page sees it. */
async function reducedMotion(page: Page): Promise<boolean> {
  return page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** The gentle run: a nose tap plays sneezeGentle; a long tickle shows giggle and laughFitGentle, never laughFit. */
async function expectGentle(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await startClipSampler(page);
  await tapNose(page, cdp, 'sneezeGentle');
  await page.waitForTimeout(GAP_MS);
  await tickle(page, cdp, 'laughFitGentle');
  const seen = await clipsSeen(page);
  expect(seen).toContain('sneezeGentle');
  expect(seen).toContain('giggle');
  expect(seen).toContain('laughFitGentle');
  expect(seen).not.toContain('sneeze');
  expect(seen).not.toContain('laughFit');
}

test('names: the canvas is an image "Juni the bear", every button is named, one live region', async ({
  page,
}) => {
  await openApp(page);
  await expect(page.locator('canvas.stage')).toMatchAriaSnapshot('- img "Juni the bear"');
  const names = await page.$$eval('button', (bs) =>
    bs.map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()),
  );
  expect(names.length).toBeGreaterThanOrEqual(8);
  expect(names.filter((n) => n === '')).toEqual([]);
  expect(names).toContain('Hold to talk');
  expect(names).toContain('Settings');
  const live = page.locator(LIVE_REGIONS);
  await expect(live).toHaveCount(1);
  await expect(live).toHaveAttribute('data-a11y-live', '');
  await expect(page.locator(LIVE)).toHaveText(ASLEEP_TEXT);
  // Outside main#app (D4): the overlays stay text-free.
  await expect(page.locator(`main#app ${LIVE}`)).toHaveCount(0);
});

test('the swap button (T126): named after the other character in Asleep, absent from the accessibility tree once awake', async ({
  page,
}) => {
  await openApp(page);
  const button = page.locator('button.character-switch');
  await expect(button).toBeVisible();
  await expect(button).toHaveAccessibleName('Switch to Fenn the duckling');
  await expect(page.getByRole('button', { name: 'Switch to Fenn the duckling' })).toHaveCount(1);
  expect(await page.locator(APP).ariaSnapshot()).toContain('button "Switch to Fenn the duckling"');
  await tapToWake(page);
  await expect(page.locator(APP)).toHaveAttribute('data-state', 'Listening', { timeout: 10_000 });
  await expect(button).toBeHidden();
  await expect(page.getByRole('button', { name: /^Switch to / })).toHaveCount(0);
  expect(await page.locator(APP).ariaSnapshot()).not.toContain('Switch to');
});

test('the live region: the Asleep text after boot, cleared on waking, untouched by Listening, a reaction or a pause', async ({
  page,
}) => {
  await openApp(page);
  await expect(page.locator(LIVE)).toHaveText(ASLEEP_TEXT);
  await tapToWake(page);
  await expect(page.locator(APP)).toHaveAttribute('data-state', 'Listening', { timeout: 10_000 });
  await expect(page.locator(LIVE)).toHaveText('');
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error('no live region');
    window.bearLiveMutations = 0;
    new MutationObserver((records) => {
      window.bearLiveMutations = (window.bearLiveMutations ?? 0) + records.length;
    }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
  }, LIVE);
  // A reaction with a sound: SfxGated, then back to Listening.
  const cdp = await page.context().newCDPSession(page);
  const nose = await regionCenter(page, 'nose');
  await touch(cdp, 'touchStart', [nose]);
  await touch(cdp, 'touchEnd', []);
  await expect
    .poll(() => page.evaluate(() => (window.__bearTest?.log ?? []).some((s) => s.to === 'SfxGated')), {
      message: 'the sneeze gated the mic',
      timeout: 5_000,
    })
    .toBe(true);
  await expect(page.locator(APP)).toHaveAttribute('data-state', 'Listening', { timeout: 10_000 });
  // Hidden → Paused (not announced) → visible → Waking → Listening.
  await page.evaluate(() => window.__bearTest?.setVisibility('hidden'));
  await expect(page.locator(APP)).toHaveAttribute('data-state', 'Paused');
  await page.evaluate(() => window.__bearTest?.setVisibility('visible'));
  await expect(page.locator(APP)).toHaveAttribute('data-state', 'Listening', { timeout: 10_000 });
  expect(await page.evaluate(() => window.bearLiveMutations)).toBe(0);
  await expect(page.locator(LIVE)).toHaveText('');
});

test('reduced motion (prefers-reduced-motion: reduce): sneezeGentle; a 3.5 s tickle shows giggle, never laughFit', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); // before wake(), which navigates; it persists
  await wake(page);
  expect(await reducedMotion(page)).toBe(true);
  await expectGentle(page);
});

test('Gentle mode with the OS setting off: the same gentle clips', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    localStorage.setItem('bear.settings.v1', JSON.stringify({ gentleMode: true }));
  });
  await wake(page);
  expect(await reducedMotion(page)).toBe(false);
  await expectGentle(page);
});

test('control: neither, so a nose tap plays sneeze and the same tickle reaches laughFit', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await wake(page);
  expect(await reducedMotion(page)).toBe(false);
  const cdp = await page.context().newCDPSession(page);
  await startClipSampler(page);
  await tapNose(page, cdp, 'sneeze');
  await page.waitForTimeout(GAP_MS);
  await tickle(page, cdp, 'laughFit');
  const seen = await clipsSeen(page);
  expect(seen).toContain('giggle');
  expect(seen).toContain('laughFit');
  expect(seen).not.toContain('sneezeGentle');
  expect(seen).not.toContain('laughFitGentle');
});
