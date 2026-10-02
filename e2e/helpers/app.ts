import * as fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { Effect, SessionEvent, StateName } from '../../src/app/events.ts';
import { PRESETS } from '../../src/dsp/types.ts';
import { yinF0 } from '../../src/dsp/yin.ts';
import { SILERO_NOT_READY_MESSAGE } from '../../src/workers/vad-core.ts';
import { expectNoEnforcedViolations, installCspRecorder } from './csp';

// Shared helpers for the e2e specs (plan §4.9.3, §7 M1, §7 M3), on top of the e2e test hooks, window.__bearTest
// (src/test-hooks.ts), which only the e2e build has. The hooks' module isn't part of this TypeScript project
// (it imports a `?worker&url` module), so the part of its shape the specs use is restated here, typed with the
// app's own event, effect and state types (type-only imports: no app code runs in Node, only the pure YIN and
// the preset table).

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

/** A VAD backend `__bearTest.setVadBackend` can pin (src/audio/engine.ts `VadBackend`). */
export type VadBackend = 'silero' | 'energy';

/** A `__bearTest.workerEvents` event: the worker's VAD status, as the engine forwards it (src/audio/engine.ts). */
export type WorkerEvent =
  | { t: 'vadReady'; backend: 'silero' }
  | { t: 'vadStats'; p95Ms: number }
  | { t: 'vadError'; message: string };

export interface BearTestHooks {
  log: LogEntry[];
  events: { t: number; e: SessionEvent }[];
  state(): StateName;
  setVisibility(v: 'visible' | 'hidden'): void;
  maxLevelDb(sinceMs: number): number;
  outputSamples(): number[];
  outputSampleRate(): number;
  setVadBackend(b: VadBackend): void;
  vadBackend(): VadBackend;
  workerEvents: { t: number; e: WorkerEvent }[];
}

declare global {
  interface Window {
    /** The e2e test hooks (src/test-hooks.ts); undefined until the e2e build has booted. */
    __bearTest?: BearTestHooks;
  }
}

/** The element that carries `data-state` (main.ts). */
const APP = 'main#app';

/**
 * The pitch ratio p of the voice the specs hear: Bear cub, the default preset (plan §4.3.4). Each spec starts
 * with empty storage, so the settings are the defaults.
 */
export const PITCH_RATIO = PRESETS.cub.pitchRatio;

/**
 * The output tap's sample peak bound, in dBFS: the voice chain's −3 dBTP ceiling, −3.1 dB of master gain (0.7)
 * and −6 dB of Quiet mode (on by default). The tap sits after the Quiet gain (plan §4.3.4, issue #66).
 */
export const OUTPUT_PEAK_MAX_DBFS = -12;

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

/** What `wake` sets up before the tap. */
export interface WakeOptions {
  /**
   * Pins the VAD backend (`__bearTest.setVadBackend`) after boot and before the tap, so every arm uses it. The
   * default is the app's, DEFAULT_VAD_BACKEND (Silero); specs whose synthetic fixtures Silero doesn't treat as
   * speech pin 'energy' (issue #51).
   */
  vad?: VadBackend;
}

/** Opens the app (CSP recorder first), taps it awake and waits up to 10 s for Listening. */
export async function wake(page: Page, opts: WakeOptions = {}): Promise<Woke> {
  await openApp(page);
  const { vad } = opts;
  if (vad !== undefined) {
    await page.evaluate((b) => {
      const h = window.__bearTest;
      if (h === undefined) throw new Error('window.__bearTest is missing');
      h.setVadBackend(b);
    }, vad);
  }
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

/** The `durationSec` of the last `processed` event: the length of the replay (played at rate 1), in seconds. */
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
 * The take's length in seconds: from 300 ms of pre-roll before the onset, clamped to the arm frame, to 150 ms
 * of tail after the last speech frame (plan §4.2.3, §4.4, §7 M1).
 */
export function takeSeconds(take: Take): number {
  const { sr } = take;
  const fromFrame = Math.max(take.startFrame - Math.round(0.3 * sr), take.armFrame);
  const toFrame = take.lastSpeechFrame + Math.round(0.15 * sr);
  return (toFrame - fromFrame) / sr;
}

/**
 * The range of the processed duration of `take` (issue #66) when the fixture's speech lasts `speechSec` and the
 * voice's pitch ratio is `p`. processVoice trims the take, which can only shorten it but never below the speech
 * plus its two 50 ms margins, then resamples by 1/p:
 *   (speechSec + 0.1) / p − 0.064 ≤ processedDuration ≤ takeSeconds(take) / p + 0.002,
 * with 0.064 s = 2 × 32 ms for the trim's 10 ms frame quantisation and the fixture's fade envelope, and 0.002 s
 * for the resampler's length rounding.
 */
export function processedDurationBounds(
  take: Take,
  speechSec: number,
  p: number,
): { min: number; max: number } {
  return { min: (speechSec + 0.1) / p - 0.064, max: takeSeconds(take) / p + 0.002 };
}

/** Asserts that `processed` is within processedDurationBounds(take, speechSec, p). */
export function expectProcessedDuration(processed: number, take: Take, speechSec: number, p: number): void {
  const { min, max } = processedDurationBounds(take, speechSec, p);
  const what = `processedDuration ${processed} s, bounds [${min}, ${max}] s`;
  expect(processed, what).toBeGreaterThanOrEqual(min);
  expect(processed, what).toBeLessThanOrEqual(max);
}

/** The largest |sample| of `samples` in dBFS (−Infinity when all are zero or there are none). */
export function peakDbfs(samples: readonly number[]): number {
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  return 20 * Math.log10(peak);
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

/** expectLoop's per-fixture expectations; the defaults are the vowel fixtures'. */
export interface LoopOptions extends WakeOptions {
  /** The fixture's speech span in seconds (its sidecar must agree); default 1.5. */
  speechSec?: number;
  /** The replay's f0 tolerance, relative to f0 × p; default 0.03 (±3 %). */
  f0Tolerance?: number;
  /** The VAD's speech span tolerance against the sidecar's, in seconds; default 0.13. */
  vadToleranceSec?: number;
}

/**
 * One full loop on a fixture (the `loop-*` specs): wake, a non-silent mic, the loop's state changes within
 * 15 s, the replay length within processVoice's bounds, the VAD's speech span against the fixture's, the
 * replay's pitch and peak, and no `arm` while gated. `f0` is the fixture's f0 in Hz (its sidecar must agree).
 */
export async function expectLoop(
  page: Page,
  fixture: string,
  f0: number,
  opts: LoopOptions = {},
): Promise<void> {
  const { speechSec: wantSpeechSec = 1.5, f0Tolerance = 0.03, vadToleranceSec = 0.13, vad } = opts;
  const meta = readSidecar(fixture);
  expect(meta.f0, `${fixture}.json f0`).toBe(f0);
  expect(meta.speech, `${fixture}.json: one speech span`).toHaveLength(1);
  const speechSec = (meta.speech[0]!.end - meta.speech[0]!.start) / meta.sampleRate;
  expect(speechSec, `${fixture}.json: speech length`).toBe(wantSpeechSec);

  // 1–2. Wake, a non-silent mic, then one loop within 15 s of wake.
  const woke = await wake(page, vad === undefined ? {} : { vad });
  await expectMicSignal(page);
  const ended = await waitForLoop(page, woke, 15_000);

  // 3. The replay's length: the take trimmed by processVoice, then divided by p (issue #66).
  const take = await lastTake(page);
  expect(take.reason, 'the speech ended in silence').toBe('silence');
  const processed = await processedDuration(page);
  expectProcessedDuration(processed, take, speechSec, PITCH_RATIO);

  // 4. VAD accuracy against the fixture: a flat margin, by default the energy backend's (10 ms hops; it covers
  // the vowels' fade envelope).
  const vadSec = (take.lastSpeechFrame - take.startFrame) / take.sr;
  expect(Math.abs(vadSec - speechSec), `VAD speech ${vadSec} s, fixture ${speechSec} s`).toBeLessThanOrEqual(
    vadToleranceSec,
  );

  // 5. The replay's pitch: the fixture's f0 × p, within f0Tolerance.
  const { samples, rate } = await page.evaluate(() => {
    const h = window.__bearTest;
    if (h === undefined) throw new Error('window.__bearTest is missing');
    return { samples: h.outputSamples(), rate: h.outputSampleRate() };
  });
  expect(samples.length, 'the output tap heard the replay').toBeGreaterThan(0);
  const outF0 = yinF0(Float32Array.from(samples), rate);
  const wantF0 = f0 * PITCH_RATIO;
  expect(
    Math.abs(outF0 - wantF0) / wantF0,
    `yinF0(outputSamples()) = ${outF0} Hz, want ${wantF0} Hz`,
  ).toBeLessThanOrEqual(f0Tolerance);

  // 6. The replay's sample peak at the output tap, after the master gain and Quiet mode.
  const peak = peakDbfs(samples);
  expect(peak, `outputSamples() peak ${peak} dBFS`).toBeLessThanOrEqual(OUTPUT_PEAK_MAX_DBFS);

  // 7. No arm while gated.
  const all = await steps(page);
  const gatedArms = all.filter((s) => s.effects.includes('arm') && GATED.includes(s.to));
  expect(gatedArms, 'arm effects on steps into a gated state').toEqual([]);

  const preRollFrom = take.startFrame - Math.round(0.3 * take.sr);
  const { min, max } = processedDurationBounds(take, speechSec, PITCH_RATIO);
  console.log(
    [
      `${fixture}: sr ${take.sr}, armFrame ${take.armFrame}, startFrame ${take.startFrame}, lastSpeechFrame ${take.lastSpeechFrame}`,
      `take from ${preRollFrom >= take.armFrame ? 'pre-roll' : 'armFrame'} (onset − 0.3 s − armFrame = ${((preRollFrom - take.armFrame) / take.sr).toFixed(4)} s)`,
      `processedDuration ${processed.toFixed(6)} s in [${min.toFixed(6)}, ${max.toFixed(6)}] s (take ${takeSeconds(take).toFixed(6)} s)`,
      `VAD ${vadSec.toFixed(4)} s vs ${speechSec} s (error ${((vadSec - speechSec) * 1000).toFixed(1)} ms)`,
      `yinF0 ${outF0.toFixed(2)} Hz vs ${wantF0} Hz (error ${(((outF0 - wantF0) / wantF0) * 100).toFixed(2)} %), output ${(samples.length / rate).toFixed(4)} s, peak ${peak.toFixed(2)} dBFS`,
      `loop ${((all[ended]!.t - woke.logT) / 1000).toFixed(2)} s`,
    ].join('; '),
  );
}

/**
 * Issue #51 Validation 2: the last take's segment came from the Silero backend.
 * - The take was armed asking for Silero (`__bearTest.vadBackend()`: no spec pinned 'energy').
 * - An epoch that asks for Silero before the worker has its model runs on energy, and the worker says so once
 *   with `vadError` SILERO_NOT_READY_MESSAGE; if that epoch is still idle when the model arrives, it switches to
 *   Silero, before the worker posts `vadReady` (#46). Any other `vadError` (`silero failed: …`) leaves the epoch
 *   on energy. So between the take's arm and its `seg` start (by `t`) there may be no `vadError` except a
 *   not-ready error followed by a `vadReady` before that start, and some `vadReady` must precede the start.
 * The window opens at the step whose effects include that arm, not at its `armed` event: the worker's error can
 * arrive before the worklet's `armed`.
 */
export async function expectSileroTake(page: Page): Promise<void> {
  const { armedWith, workerEvents } = await page.evaluate(() => {
    const h = window.__bearTest;
    if (h === undefined) throw new Error('window.__bearTest is missing');
    return { armedWith: h.vadBackend(), workerEvents: h.workerEvents };
  });
  expect(armedWith, 'the backend the take was armed with').toBe('silero');
  const all = await steps(page);
  const endAt = all.findLastIndex((s) => s.from === 'Recording' && s.to === 'Processing');
  const startAt = all.findLastIndex((s, i) => i < endAt && s.from === 'Listening' && s.to === 'Recording');
  const start = all[startAt];
  if (start?.e.t !== 'seg' || start.e.ev.kind !== 'start') {
    throw new Error(
      `no seg start moved Listening → Recording before the last take; state changes: ${pathOf(all)}`,
    );
  }
  const { epoch } = start.e;
  const armedAt = all.findLastIndex((s, i) => i < startAt && s.e.t === 'armed' && s.e.epoch === epoch);
  const armAt = all.findLastIndex((s, i) => i < armedAt && s.effects.includes('arm'));
  const arm = all[armAt];
  if (armedAt < 0 || arm === undefined) throw new Error(`no arm effect and armed event for epoch ${epoch}`);
  const ready = workerEvents.filter((w) => w.e.t === 'vadReady').map((w) => w.t);
  const errors: { t: number; message: string }[] = [];
  for (const w of workerEvents) {
    if (w.e.t === 'vadError' && w.t >= arm.t && w.t <= start.t) errors.push({ t: w.t, message: w.e.message });
  }
  const failing = errors.filter(
    (err) => err.message !== SILERO_NOT_READY_MESSAGE || !ready.some((t) => t > err.t && t <= start.t),
  );
  console.log(
    `silero take: epoch ${epoch}, arm at ${arm.t.toFixed(1)} ms, seg start at ${start.t.toFixed(1)} ms; ` +
      `vadReady at ${ready.map((t) => t.toFixed(1)).join(', ') || 'never'} ms; ${errors.length} vadError(s) in between`,
  );
  expect(
    failing.map((err) => `${err.t.toFixed(1)} ms: ${err.message}`),
    `vadErrors between the arm and the seg start, other than '${SILERO_NOT_READY_MESSAGE}' recovered by a vadReady before the start`,
  ).toEqual([]);
  expect(
    ready.some((t) => t <= start.t),
    'a vadReady before the seg start',
  ).toBe(true);
}
