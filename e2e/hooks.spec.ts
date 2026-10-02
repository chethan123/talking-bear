import * as fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { yinF0 } from '../src/dsp/yin.ts';
import { expectNoEnforcedViolations, installCspRecorder } from './helpers/csp';
import { micFlags } from './helpers/flags';

// The e2e test hooks, window.__bearTest (src/test-hooks.ts, plan §4.9.3), which only the e2e build has, are typed
// by the global `Window` declaration in helpers/app.ts: this TypeScript project (tsconfig.node.json) includes every
// e2e file, so the declaration applies here without an import.

// Launch flags are worker-scoped: one fixture per spec file (plan §4.9.3).
test.use({ launchOptions: { args: micFlags('e2e/fixtures/vowel_f0-140.wav') } });

/** The state-changing steps of one loop, from the first Listening on. */
const LOOP = ['Listening', 'Recording', 'Processing', 'Playing', 'Cooldown', 'Listening'];

/** Seconds of speech in a fixture, from its sidecar: `{ sampleRate, speech: [{ start, end }] }`. */
function speechSeconds(url: URL): number {
  const meta: unknown = JSON.parse(fs.readFileSync(url, 'utf8'));
  if (typeof meta === 'object' && meta !== null && 'sampleRate' in meta && 'speech' in meta) {
    const { sampleRate, speech } = meta;
    if (typeof sampleRate === 'number' && Array.isArray(speech) && speech.length === 1) {
      const span: unknown = speech[0];
      if (typeof span === 'object' && span !== null && 'start' in span && 'end' in span) {
        const { start, end } = span;
        if (typeof start === 'number' && typeof end === 'number') return (end - start) / sampleRate;
      }
    }
  }
  throw new Error(`${url.pathname}: expected { sampleRate, speech: [{ start, end }] }`);
}

/** The fixture's vowel: (120000 − 48000) / 48000 = 1.5 s. */
const SPEECH_SEC = speechSeconds(new URL('./fixtures/vowel_f0-140.json', import.meta.url));

async function state(page: Page): Promise<string> {
  return page.evaluate(() => {
    const h = window.__bearTest;
    if (h === undefined) throw new Error('window.__bearTest is missing');
    return h.state();
  });
}

test('the test hooks log one loop, and the output tap hears the replay at 140 × 1.6 Hz', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    // Until index.html links its icon (plan §4.7, with the PWA icons), Chromium's /favicon.ico request 404s.
    if (msg.type() !== 'error' || msg.location().url.endsWith('/favicon.ico')) return;
    pageErrors.push(`${msg.text()} (${msg.location().url})`);
  });

  await installCspRecorder(page);
  await page.goto('/');
  await page.waitForFunction(() => window.__bearTest !== undefined);
  expect(await state(page)).toBe('Asleep');

  // Drive one loop as the ui-placeholder smoke does: a trusted click (sticky activation for the AudioContext),
  // then Continue if the parent sheet shows.
  await page.locator('canvas.stage').click();
  await expect.poll(() => state(page)).not.toBe('Asleep');
  if ((await state(page)) === 'NeedsParent') await page.getByRole('button', { name: 'Continue' }).click();

  // Every audio spec first proves that the input isn't silent (plan §4.9.3). The fixture starts with 1 s of zeros.
  await expect
    .poll(() => page.evaluate(() => window.__bearTest?.maxLevelDb(60_000) ?? Number.NEGATIVE_INFINITY), {
      message: 'fake mic silent: check WAV path/format',
      timeout: 5_000,
    })
    .toBeGreaterThan(-50);

  // The loop is over once the bear listens again after its replay's cooldown.
  await page.waitForFunction(
    () => {
      const log = window.__bearTest?.log ?? [];
      const played = log.findIndex((x) => x.to === 'Playing');
      return played >= 0 && log.slice(played).some((x) => x.from === 'Cooldown' && x.to === 'Listening');
    },
    undefined,
    { timeout: 20_000 },
  );

  const { log, events, samples, rate } = await page.evaluate(() => {
    const h = window.__bearTest;
    if (h === undefined) throw new Error('window.__bearTest is missing');
    return { log: h.log, events: h.events, samples: h.outputSamples(), rate: h.outputSampleRate() };
  });

  // log: a Playing entry, and exactly one loop's state changes.
  expect(log.some((x) => x.to === 'Playing')).toBe(true);
  const path = log.filter((x) => x.from !== x.to).map((x) => x.to);
  const firstListening = path.indexOf('Listening');
  expect(['Waking', 'NeedsParent,Waking']).toContain(path.slice(0, firstListening).join(','));
  expect(path.slice(firstListening)).toEqual(LOOP);

  // log.frame: −1 before the context exists (the first tap builds it asynchronously); from ctxRunning on, the
  // context's frame, which never goes back.
  expect(log[0]?.frame).toBe(-1);
  const running = log.findIndex((x) => x.event === 'ctxRunning');
  expect(running).toBeGreaterThan(0);
  const frames = log.slice(running).map((x) => x.frame);
  expect(frames.every((f, i) => f >= 0 && (i === 0 || f >= frames[i - 1]!))).toBe(true);
  // …in samples: between the Recording and Cooldown entries it advances with the wall clock (t, in ms).
  const rec = log.find((x) => x.to === 'Recording');
  const cool = log.find((x) => x.to === 'Cooldown');
  if (rec === undefined || cool === undefined) throw new Error('the log has no Recording or Cooldown entry');
  const skew = (cool.frame - rec.frame) / rate - (cool.t - rec.t) / 1000;
  expect(Math.abs(skew), `log.frame vs t over Recording → Cooldown: skew ${skew} s`).toBeLessThan(0.05);

  // events: every reduced event with its payload, one per log entry.
  expect(events.map((x) => x.e.t)).toEqual(log.map((x) => x.event));
  expect(events.find((x) => x.e.t === 'ctxRunning')?.e).toEqual({ t: 'ctxRunning', sampleRate: rate });

  // The output tap heard the replay: M1 plays the clip at rate 1.6, so f0 = 140 × 1.6 = 224 Hz, ±3 %.
  const f0 = yinF0(Float32Array.from(samples), rate);
  const seconds = samples.length / rate;
  console.log(
    `output tap: ${samples.length} samples at ${rate} Hz = ${seconds.toFixed(4)} s (vowel ${SPEECH_SEC} s / 1.6 = ${(SPEECH_SEC / 1.6).toFixed(4)} s), yinF0 = ${f0.toFixed(2)} Hz`,
  );
  expect(f0, `yinF0(outputSamples()) = ${f0} Hz`).toBeGreaterThanOrEqual(224 * 0.97);
  expect(f0, `yinF0(outputSamples()) = ${f0} Hz`).toBeLessThanOrEqual(224 * 1.03);
  // …and all of it: the trimmed ring spans the vowel replayed at rate 1.6 (1.5 s / 1.6 = 0.9375 s) within 15 ms,
  // so no block (1024 frames, 21–23 ms) was lost or repeated, not even at either end of the sound, and it starts
  // and ends on sound (the silence around it was trimmed at 1e-4).
  expect(SPEECH_SEC).toBe(1.5);
  expect(Math.abs(seconds - SPEECH_SEC / 1.6), `output tap: ${seconds} s`).toBeLessThanOrEqual(0.015);
  expect(Math.abs(samples[0] ?? 0)).toBeGreaterThan(1e-4);
  expect(Math.abs(samples.at(-1) ?? 0)).toBeGreaterThan(1e-4);

  // setVisibility drives the app's visibility source: hidden → Paused; visible → awake again, which resumes the
  // context a second time without a second output tap (the hooks insert it on the first ctxRunning only).
  await page.evaluate(() => window.__bearTest?.setVisibility('hidden'));
  await expect.poll(() => state(page)).toBe('Paused');
  // maxLevelDb covers exactly the last sinceMs: Paused posts no level events, so 1.5 s later the last second has
  // none, the last 3 s still reach back into Listening, and the vowel is within the last minute.
  await page.waitForTimeout(1500);
  const levels = await page.evaluate(() => {
    const h = window.__bearTest;
    if (h === undefined) throw new Error('window.__bearTest is missing');
    return [h.maxLevelDb(1000), h.maxLevelDb(3000), h.maxLevelDb(60_000)];
  });
  console.log(
    `hooks: log.frame skew ${skew.toFixed(4)} s over Recording → Cooldown; maxLevelDb(1000/3000/60000) 1.5 s into Paused = ${levels.join(' / ')} dB`,
  );
  expect(levels[0], `maxLevelDb(1000/3000/60000) = ${levels.join(', ')}`).toBe(Number.NEGATIVE_INFINITY);
  expect(levels[1], `maxLevelDb(1000/3000/60000) = ${levels.join(', ')}`).toBeGreaterThan(
    Number.NEGATIVE_INFINITY,
  );
  expect(levels[2], `maxLevelDb(1000/3000/60000) = ${levels.join(', ')}`).toBeGreaterThan(-50);
  await page.evaluate(() => window.__bearTest?.setVisibility('visible'));
  await expect.poll(() => state(page), { timeout: 10_000 }).toBe('Listening');
  const ctxRunnings = await page.evaluate(
    () => window.__bearTest?.events.filter((x) => x.e.t === 'ctxRunning').length ?? 0,
  );
  expect(ctxRunnings).toBe(2);

  expect(pageErrors).toEqual([]);
  await expectNoEnforcedViolations(page);
});
