import { expect, test } from '@playwright/test';
import type { SessionEvent } from '../src/app/events.ts';
import { expectNoCaptureJump, reanchorAfterLoop, type Step, type Take } from './helpers/app';

// The e2e helpers' capture re-anchor rule (issue #268), unit-level: expectNoCaptureJump on synthetic level series,
// with no page and no browser. At 48 kHz one level interval is 1440 ctx frames (3 hops of 10 ms) and the rule's
// limit is 1440 + 24000 (0.5 s); at 44.1 kHz, 1323 + 22050.

/** A take at 48 kHz: armed at frame 100 000, its onset 1 s later, 1.5 s of speech. Its window is [133 600, 227 200). */
const TAKE: Take = {
  sr: 48_000,
  epoch: 3,
  armFrame: 100_000,
  startFrame: 148_000,
  lastSpeechFrame: 220_000,
  reason: 'silence',
};
const SPEECH_SEC = 1.5;

/** `n` level events from `first`, `step` frames apart (`jitter` alternately subtracted and added). */
function series(first: number, n: number, step = 1440, jitter = 0): { frame: number; db: number }[] {
  const out: { frame: number; db: number }[] = [];
  for (let i = 0; i < n; i++) out.push({ frame: first + i * step + (i % 2 === 0 ? 0 : -jitter), db: -30 });
  return out;
}

/** The level series from the arm frame to `last`, then from `last + step` on: one step of `step` frames. */
function withStep(step: number, last: number, take: Take = TAKE): { frame: number; db: number }[] {
  const interval = take.sr === 48_000 ? 1440 : 1323;
  const before = series(take.armFrame, Math.floor((last - take.armFrame) / interval) + 1, interval);
  const at = before.at(-1)!.frame;
  return [...before, ...series(at + step, 120, interval)];
}

test('capture re-anchor rule: a 2 s jump inside the take window fails, naming it in frames and ms', () => {
  const levels = withStep(1440 + 96_000, 180_000); // the last level before the gap is at 179 200
  expect(() => expectNoCaptureJump(levels, TAKE, SPEECH_SEC)).toThrow(
    /capture re-anchor in the test environment, not a VAD failure: consecutive level events jumped 97440 frames \(2030 ms\), from frame 179200/,
  );
});

test('capture re-anchor rule: a contiguous series passes, rounding jitter included', () => {
  expect(() => expectNoCaptureJump(series(TAKE.armFrame, 200, 1440, 1), TAKE, SPEECH_SEC)).not.toThrow();
});

test('capture re-anchor rule: a step of one level interval plus Math.round(sr / 2) passes; one frame more fails', () => {
  expect(() => expectNoCaptureJump(withStep(1440 + 24_000, 180_000), TAKE, SPEECH_SEC)).not.toThrow();
  expect(() => expectNoCaptureJump(withStep(1440 + 24_001, 180_000), TAKE, SPEECH_SEC)).toThrow(
    /capture re-anchor/,
  );
  const take441: Take = { ...TAKE, sr: 44_100 };
  expect(() =>
    expectNoCaptureJump(withStep(1323 + 22_050, 180_000, take441), take441, SPEECH_SEC),
  ).not.toThrow();
  expect(() => expectNoCaptureJump(withStep(1323 + 22_051, 180_000, take441), take441, SPEECH_SEC)).toThrow(
    /capture re-anchor/,
  );
});

test('capture re-anchor rule: the window spans the pre-roll and the speech; a jump outside it passes', () => {
  // Before the pre-roll: the levels step from 107 200 to 132 641, at or before the window's start (133 600).
  expect(() => expectNoCaptureJump(withStep(1440 + 24_001, 107_200), TAKE, SPEECH_SEC)).not.toThrow();
  // Into the pre-roll: from 108 640 to 134 081, past the window's start.
  expect(() => expectNoCaptureJump(withStep(1440 + 24_001, 108_640), TAKE, SPEECH_SEC)).toThrow(
    /capture re-anchor/,
  );
  // After the speech: the last level before the gap is at 228 160, past the window's end (227 200).
  expect(() => expectNoCaptureJump(withStep(1440 + 24_001, 228_160), TAKE, SPEECH_SEC)).not.toThrow();
  // A take that ended early (its last frame before the gap) still fails while the fixture's speech spans the gap.
  const early: Take = { ...TAKE, lastSpeechFrame: 170_000 };
  expect(() => expectNoCaptureJump(withStep(1440 + 96_000, 200_000), early, SPEECH_SEC)).toThrow(
    /capture re-anchor/,
  );
});

test("capture re-anchor rule: only the take's epoch counts; the step to the next epoch's levels is no jump", () => {
  // The take's epoch stops early (the levels end at 199 360, inside the window); the next epoch is armed at 400 000.
  const levels = [...series(TAKE.armFrame, 70), ...series(400_480, 50)];
  expect(() => expectNoCaptureJump(levels, TAKE, SPEECH_SEC, 400_000)).not.toThrow();
  expect(() => expectNoCaptureJump(levels, TAKE, SPEECH_SEC)).toThrow(/capture re-anchor/);
});

/** A session step carrying `e` (only the event matters to reanchorAfterLoop). */
function stepOf(e: SessionEvent): Step {
  return { t: 0, frame: 0, from: 'Listening', to: 'Listening', event: e.t, effects: [], e };
}

test('capture re-anchor after a failed loop: every epoch armed since wake is searched, with no window', () => {
  const all: Step[] = [
    stepOf({ t: 'armed', epoch: 1, armFrame: 0 }), // armed before the wake: not searched
    stepOf({ t: 'ctxRunning', sampleRate: 48_000 }), // index 1: the wake's step into Listening
    stepOf({ t: 'armed', epoch: 2, armFrame: 100_000 }),
    stepOf({ t: 'armed', epoch: 3, armFrame: 400_000 }),
  ];
  // Before the wake's arm, a jump: ignored. Epoch 2 ends early, and epoch 3 starts at 400 480: no jump either.
  const quiet = [...series(0, 5), ...series(60_000, 5), ...series(TAKE.armFrame, 70), ...series(400_480, 50)];
  expect(reanchorAfterLoop(quiet, all, 1)).toBeUndefined();
  // A 1 s re-anchor in epoch 3, after the misfire's re-arm, is named.
  const cut = [
    ...series(TAKE.armFrame, 70),
    ...series(400_480, 20),
    ...series(400_480 + 19 * 1440 + 49_440, 20),
  ];
  expect(reanchorAfterLoop(cut, all, 1)).toMatch(
    /^capture re-anchor in the test environment, not a VAD failure: consecutive level events jumped 49440 frames \(1030 ms\), from frame 427840 \(0\.580 s after the arm at frame 400000\)/,
  );
  // With no ctxRunning, the frames have no rate: nothing is claimed.
  expect(reanchorAfterLoop(cut, [all[0]!, all[2]!, all[3]!], 0)).toBeUndefined();
});
