import { afterEach, describe, expect, test, vi } from 'vitest';
import { clipTimeNow, minEndWaitMs, outputContextTimeNow, type OutputClockCtx } from './output-clock.ts';

function fakeCtx(
  ts: { contextTime?: number; performanceTime?: number },
  currentTime = 99,
  outputLatency?: number,
): OutputClockCtx {
  return { currentTime, outputLatency, getOutputTimestamp: () => ts };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('outputContextTimeNow', () => {
  test('extrapolates the output timestamp to now: contextTime 10, performanceTime 1000, now 1500 → 10.5', () => {
    const ctx = fakeCtx({ contextTime: 10, performanceTime: 1000 }, 99, 0.02);
    expect(outputContextTimeNow(ctx, () => 1500)).toBeCloseTo(10.5, 12);
  });

  test('defaults now to performance.now()', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1500);
    const ctx = fakeCtx({ contextTime: 10, performanceTime: 1000 });
    expect(outputContextTimeNow(ctx)).toBeCloseTo(10.5, 12);
  });

  test('falls back to currentTime − outputLatency when performanceTime is 0', () => {
    const ctx = fakeCtx({ contextTime: 10, performanceTime: 0 }, 5, 0.04);
    expect(outputContextTimeNow(ctx, () => 1500)).toBeCloseTo(4.96, 12);
  });

  test('falls back when performanceTime is undefined, treating an undefined outputLatency as 0', () => {
    const ctx = fakeCtx({}, 5);
    expect(outputContextTimeNow(ctx, () => 1500)).toBe(5);
  });
});

describe('clipTimeNow', () => {
  test('is the output context time minus the scheduled start: 10.5 − 10.2 → 0.3', () => {
    const ctx = fakeCtx({ contextTime: 10, performanceTime: 1000 });
    expect(clipTimeNow(ctx, 10.2, () => 1500)).toBeCloseTo(0.3, 12);
  });

  test('uses the fallback when performanceTime is 0', () => {
    const ctx = fakeCtx({ contextTime: 0, performanceTime: 0 }, 5, 0.04);
    expect(clipTimeNow(ctx, 4.5, () => 1500)).toBeCloseTo(0.46, 12);
  });
});

describe('minEndWaitMs', () => {
  test('is 1000 · max(outputLatency, 50 ms)', () => {
    expect(minEndWaitMs({})).toBeCloseTo(50, 12);
    expect(minEndWaitMs({ outputLatency: 0 })).toBeCloseTo(50, 12);
    expect(minEndWaitMs({ outputLatency: 0.03 })).toBeCloseTo(50, 12);
    expect(minEndWaitMs({ outputLatency: 0.2 })).toBeCloseTo(200, 12);
  });
});
