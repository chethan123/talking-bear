import * as fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { Effect, SessionEvent, StateName } from '../../src/app/events.ts';
import { yinF0 } from '../../src/dsp/yin.ts';
import { expectNoEnforcedViolations, installCspRecorder } from './csp';

// Shared helpers for the M1 e2e specs (plan §4.9.3, §7 M1), on top of the e2e test hooks, window.__bearTest
// (src/test-hooks.ts), which only the e2e build has. The hooks' module isn't part of this TypeScript project
// (it imports a `?worker&url` module), so the part of its shape the specs use is restated here, typed with the
// app's own event, effect and state types (type-only imports: no app code runs in Node, only the pure YIN).

/** One `__bearTest.log` entry: a step the session reduced (from === to when the state didn't change). */
export interface LogEntry {
  t: number;
  frame: number;
  from: StateName;
  to: StateName;
  event: SessionEvent['t'];
  effects: Effect['k'][];
}

/** A log entry together with the event that caused it: `log[i]` and `events[i]` are pushed by the same call. */
export interface Step extends LogEntry {
  e: SessionEvent;
}

interface BearTestHooks {
  log: LogEntry[];
  events: { t: number; e: SessionEvent }[];
  state(): StateName;
  maxLevelDb(sinceMs: number): number;
  outputSamples(): number[];
  outputSampleRate(): number;
}

declare global {
  interface Window {
    /** The e2e test hooks (src/test-hooks.ts); undefined until the e2e build has booted. */
    __bearTest?: BearTestHooks;
  }
}

/** The element that carries `data-state` (main.ts). */
const APP = 'main#app';

/** M1's placeholder replay rate (plan §7 M1: `AudioBufferSourceNode` with `playbackRate = 1.6`). */
export const PLAYBACK_RATE = 1.6;

/** One loop's state changes, from the Listening it starts in. */
export const LOOP: readonly StateName[] = ['Recording', 'Processing', 'Playing', 'Cooldown', 'Listening'];

/** States in which no `arm` may happen (plan §3.4, §4.9.3: no `arm` while gated). */
const GATED: readonly StateName[] = ['Processing', 'Playing', 'SfxGated', 'Cooldown'];

/** Registers an afterEach hook in the calling spec file: its page recorded no enforced CSP violation. */
export function noCspViolationsAfterEach(): void {
  test.afterEach(async ({ page }) => {
    await expectNoEnforcedViolations(page);
  });
}

/** Installs the CSP recorder, opens the app and waits until it has booted into Asleep with its test hooks. */
export async function openApp(page: Page): Promise<void> {
  await installCspRecorder(page);
  await page.goto('/');
  await page.waitForFunction(() => window.__bearTest !== undefined);
  await expect(page.locator(APP)).toHaveAttribute('data-state', 'Asleep');
}

/**
 * A trusted click on the stage (sticky activation, so the AudioContext may start; `dispatchEvent` would be
 * untrusted), then "Continue" if the click opened the parent sheet (NeedsParent). The session reduces the tap
 * synchronously, so once `data-state` has left Asleep it shows the tap's result.
 */
export async function tapToWake(page: Page): Promise<void> {
  const app = page.locator(APP);
  await page.locator('canvas.stage').click();
  await expect(app).not.toHaveAttribute('data-state', 'Asleep');
  if ((await app.getAttribute('data-state')) === 'NeedsParent') {
    await page.getByRole('button', { name: 'Continue' }).click();
  }
}

/** Where `wake` left the app: the step into Listening. Time budgets "after wake" start here. */
export interface Woke {
  /** Log index of the transition into Listening. */
  index: number;
  /** That step's log time (the page's performance.now(), ms). */
  logT: number;
  /** Date.now() in Node when wake saw Listening (no earlier than logT, on Node's clock). */
  at: number;
}

/** Opens the app (CSP recorder first), taps it awake and waits up to 10 s for Listening. */
export async function wake(page: Page): Promise<Woke> {
  await openApp(page);
  await tapToWake(page);
  await expect(page.locator(APP)).toHaveAttribute('data-state', 'Listening', { timeout: 10_000 });
  const at = Date.now();
  const all = await steps(page);
  const index = all.findLastIndex((s) => s.to === 'Listening' && s.from !== 'Listening');
  const step = all[index];
  if (step === undefined) {
    throw new Error(`data-state is Listening, but the log has no transition into it: ${pathOf(all)}`);
  }
  return { index, logT: step.t, at };
}

/** Every audio spec first proves the fake mic isn't silent: a missing or unreadable WAV is silent input. */
export async function expectMicSignal(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__bearTest?.maxLevelDb(3000) ?? Number.NEGATIVE_INFINITY), {
      message: 'fake mic silent: check WAV path/format',
      timeout: 3000,
    })
    .toBeGreaterThan(-60);
}

/** Every step the session reduced so far, each with its event (payload included). */
export async function steps(page: Page): Promise<Step[]> {
  const { log, events } = await page.evaluate(() => {
    const h = window.__bearTest;
    if (h === undefined) throw new Error('window.__bearTest is missing');
    return { log: h.log, events: h.events };
  });
  if (events.length !== log.length) {
    throw new Error(`__bearTest: ${log.length} log entries but ${events.length} events`);
  }
  return log.map((x, i) => ({ ...x, e: events[i]!.e }));
}

/** The state changes so far (steps with from !== to), each with the event that caused it. */
export async function transitions(page: Page): Promise<Step[]> {
  return (await steps(page)).filter((s) => s.from !== s.to);
}

/** "Waking → Listening → Recording …": the states the steps changed into, for messages. */
function pathOf(all: readonly Step[]): string {
  return all
    .filter((s) => s.from !== s.to)
    .map((s) => s.to)
    .join(' → ');
}

/**
 * Waits up to `timeoutMs` for a state change into `to` at a log index greater than `after`, and returns its
 * log index. On timeout it fails with the state changes so far.
 */
export async function waitForTransition(
  page: Page,
  to: StateName,
  timeoutMs: number,
  after = -1,
): Promise<number> {
  try {
    const found = await page.waitForFunction(
      ([target, from]) => {
        const log = window.__bearTest?.log ?? [];
        for (let i = from + 1; i < log.length; i++) {
          const x = log[i]!;
          if (x.to === target && x.from !== target) return { i };
        }
        return null;
      },
      [to, after] as const,
      { timeout: Math.max(1, timeoutMs) },
    );
    const hit = await found.jsonValue();
    if (hit === null) throw new Error('waitForFunction resolved without a match');
    return hit.i;
  } catch (err) {
    const path = pathOf(await steps(page).catch(() => []));
    throw new Error(`no transition into ${to} within ${timeoutMs} ms; state changes so far: ${path}`, {
      cause: err,
    });
  }
}

/**
 * Waits for one loop after wake's Listening and checks that it ended within `budgetMs` of wake: the state
 * changes since wake are exactly LOOP, and the final Listening's log time is at most `budgetMs` after wake's.
 * Returns the log index of the loop's final transition into Listening.
 */
export async function waitForLoop(page: Page, woke: Woke, budgetMs: number): Promise<number> {
  // The waits allow 1 s past the budget, so polling never misses a step that came in time; the budget itself
  // is asserted on the page's clock below.
  const deadline = woke.at + budgetMs + 1000;
  let i = woke.index;
  for (const to of LOOP) i = await waitForTransition(page, to, deadline - Date.now(), i);
  const all = await steps(page);
  const path = all
    .slice(woke.index + 1)
    .filter((s) => s.from !== s.to)
    .map((s) => s.to);
  expect(path, 'the state changes after wake are one loop').toEqual(LOOP);
  const took = all[i]!.t - woke.logT;
  expect(took, `the loop ended ${took} ms after wake`).toBeLessThanOrEqual(budgetMs);
  return i;
}

/** The `durationSec` of the last `processed` event: the length of the replay at PLAYBACK_RATE, in seconds. */
export async function processedDuration(page: Page): Promise<number> {
  const all = await steps(page);
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i]!.e;
    if (e.t === 'processed') return e.durationSec;
  }
  throw new Error(`no processed event; state changes: ${pathOf(all)}`);
}

/** What the last take was cut from: the frames (context rate) the reducer used for it. */
export interface Take {
  /** `sampleRate` of the latest `ctxRunning` before the take. */
  sr: number;
  epoch: number;
  /** `armFrame` of the latest `armed` event of the take's epoch. */
  armFrame: number;
  /** `ev.frame` of the `seg` start that moved Listening → Recording. */
  startFrame: number;
  /** `ev.lastSpeechFrame` of the `seg` end that moved Recording → Processing. */
  lastSpeechFrame: number;
  reason: 'silence' | 'maxLength';
}

/** The last take: the epoch's events that led to the latest Recording → Processing transition. */
export async function lastTake(page: Page): Promise<Take> {
  const all = await steps(page);
  const endAt = all.findLastIndex((s) => s.from === 'Recording' && s.to === 'Processing');
  const end = all[endAt];
  if (end === undefined || end.e.t !== 'seg' || end.e.ev.kind !== 'end') {
    throw new Error(`no seg end moved Recording → Processing; state changes: ${pathOf(all)}`);
  }
  const { epoch } = end.e;
  const before = all.slice(0, endAt);
  const start = before.findLast((s) => s.from === 'Listening' && s.to === 'Recording')?.e;
  if (start?.t !== 'seg' || start.ev.kind !== 'start' || start.epoch !== epoch) {
    throw new Error(`no seg start of epoch ${epoch} moved Listening → Recording: ${JSON.stringify(start)}`);
  }
  const armed = before.findLast((s) => s.e.t === 'armed' && s.e.epoch === epoch)?.e;
  if (armed?.t !== 'armed') throw new Error(`no armed event of epoch ${epoch}`);
  const running = before.findLast((s) => s.e.t === 'ctxRunning')?.e;
  if (running?.t !== 'ctxRunning') throw new Error('no ctxRunning event before the take');
  return {
    sr: running.sampleRate,
    epoch,
    armFrame: armed.armFrame,
    startFrame: start.ev.frame,
    lastSpeechFrame: end.e.ev.lastSpeechFrame,
    reason: end.e.ev.reason,
  };
}

/**
 * The exact replay length of a take, in seconds: from 300 ms of pre-roll before the onset, clamped to the arm
 * frame, to 150 ms of tail after the last speech frame, played at PLAYBACK_RATE (plan §4.2.3, §4.4, §7 M1).
 */
export function expectedProcessedDuration(take: Take): number {
  const { sr } = take;
  const fromFrame = Math.max(take.startFrame - Math.round(0.3 * sr), take.armFrame);
  const toFrame = take.lastSpeechFrame + Math.round(0.15 * sr);
  return (toFrame - fromFrame) / sr / PLAYBACK_RATE;
}

/** A fixture's sidecar (scripts/gen-fixtures.ts): `{ sampleRate, speech: [{ start, end }], f0? }`. */
interface Sidecar {
  sampleRate: number;
  speech: { start: number; end: number }[];
  f0?: number;
}

function readSidecar(fixture: string): Sidecar {
  const url = new URL(`../fixtures/${fixture}.json`, import.meta.url);
  const meta: unknown = JSON.parse(fs.readFileSync(url, 'utf8'));
  if (typeof meta === 'object' && meta !== null && 'sampleRate' in meta && 'speech' in meta) {
    const { sampleRate, speech } = meta;
    const f0 = 'f0' in meta ? meta.f0 : undefined;
    const spans: { start: number; end: number }[] = [];
    if (typeof sampleRate === 'number' && Array.isArray(speech)) {
      for (const span of speech as unknown[]) {
        if (typeof span === 'object' && span !== null && 'start' in span && 'end' in span) {
          const { start, end } = span;
          if (typeof start === 'number' && typeof end === 'number') spans.push({ start, end });
        }
      }
      if (spans.length === speech.length && (f0 === undefined || typeof f0 === 'number')) {
        return f0 === undefined ? { sampleRate, speech: spans } : { sampleRate, speech: spans, f0 };
      }
    }
  }
  throw new Error(`${url.pathname}: expected { sampleRate, speech: [{ start, end }], f0? }`);
}

/**
 * One full loop on a vowel fixture (the `loop-*` specs): wake, a non-silent mic, the loop's state changes
 * within 15 s, the exact take and replay length, the VAD's speech span against the fixture's, the replay's
 * pitch, and no `arm` while gated. `f0` is the fixture's vowel f0 in Hz (its sidecar must agree).
 */
export async function expectLoop(page: Page, fixture: string, f0: number): Promise<void> {
  const meta = readSidecar(fixture);
  expect(meta.f0, `${fixture}.json f0`).toBe(f0);
  expect(meta.speech, `${fixture}.json: one speech span`).toHaveLength(1);
  const speechSec = (meta.speech[0]!.end - meta.speech[0]!.start) / meta.sampleRate;
  expect(speechSec, `${fixture}.json: speech length`).toBe(1.5);

  // 1–2. Wake, a non-silent mic, then one loop within 15 s of wake.
  const woke = await wake(page);
  await expectMicSignal(page);
  const ended = await waitForLoop(page, woke, 15_000);

  // 3. The take and its processing are exact.
  const take = await lastTake(page);
  expect(take.reason, 'the vowel ended in silence').toBe('silence');
  const expected = expectedProcessedDuration(take);
  const processed = await processedDuration(page);
  expect(
    Math.abs(processed - expected),
    `processedDuration ${processed} s, expected ${expected} s`,
  ).toBeLessThanOrEqual(0.002);

  // 4. VAD accuracy against the fixture (energy backend: 10 ms hops; the margin covers the fade envelope).
  const vadSec = (take.lastSpeechFrame - take.startFrame) / take.sr;
  expect(Math.abs(vadSec - speechSec), `VAD speech ${vadSec} s, fixture ${speechSec} s`).toBeLessThanOrEqual(
    0.13,
  );

  // 5. The replay's pitch: the vowel's f0 × 1.6, ±3 %.
  const { samples, rate } = await page.evaluate(() => {
    const h = window.__bearTest;
    if (h === undefined) throw new Error('window.__bearTest is missing');
    return { samples: h.outputSamples(), rate: h.outputSampleRate() };
  });
  const outF0 = yinF0(Float32Array.from(samples), rate);
  const wantF0 = f0 * PLAYBACK_RATE;
  expect(
    Math.abs(outF0 - wantF0) / wantF0,
    `yinF0(outputSamples()) = ${outF0} Hz, want ${wantF0} Hz`,
  ).toBeLessThanOrEqual(0.03);

  // 6. No arm while gated.
  const all = await steps(page);
  const gatedArms = all.filter((s) => s.effects.includes('arm') && GATED.includes(s.to));
  expect(gatedArms, 'arm effects on steps into a gated state').toEqual([]);

  const preRollFrom = take.startFrame - Math.round(0.3 * take.sr);
  console.log(
    [
      `${fixture}: sr ${take.sr}, armFrame ${take.armFrame}, startFrame ${take.startFrame}, lastSpeechFrame ${take.lastSpeechFrame}`,
      `take from ${preRollFrom >= take.armFrame ? 'pre-roll' : 'armFrame'} (onset − 0.3 s − armFrame = ${((preRollFrom - take.armFrame) / take.sr).toFixed(4)} s)`,
      `processedDuration ${processed.toFixed(6)} s, expected ${expected.toFixed(6)} s, diff ${((processed - expected) * 1000).toFixed(4)} ms`,
      `VAD ${vadSec.toFixed(4)} s vs ${speechSec} s (error ${((vadSec - speechSec) * 1000).toFixed(1)} ms)`,
      `yinF0 ${outF0.toFixed(2)} Hz vs ${wantF0} Hz (error ${(((outF0 - wantF0) / wantF0) * 100).toFixed(2)} %), output ${(samples.length / rate).toFixed(4)} s`,
      `loop ${((all[ended]!.t - woke.logT) / 1000).toFixed(2)} s`,
    ].join('; '),
  );
}
