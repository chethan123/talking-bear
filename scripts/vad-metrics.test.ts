import { describe, expect, it } from 'vitest';

import {
  allowedErrors,
  corpusTruth,
  evaluateScene,
  MAX_FALSE_TRIGGERS_PER_MIN,
  overlaps,
  percentile,
  poolMetrics,
  ttsGate,
  type GateCheck,
  type GateResult,
  type GateScene,
  type Metrics,
  type Segment,
  type TruthSpan,
} from './vad-metrics.ts';

// ctxRate 1000: one ctx frame is one ms, so every expected value below is readable in ms.
const RATE = 1000;
const MIN = 60_000; // one minute of frames

const short = (id: string, start: number, end: number): TruthSpan => ({
  id,
  kind: 'short',
  start,
  end,
  offset: end,
});
const passage = (id: string, start: number, end: number): TruthSpan => ({
  id,
  kind: 'passage',
  start,
  end,
  offset: end,
});
const seg = (
  startFrame: number,
  endFrame: number,
  lastSpeechFrame: number | null = endFrame - 600,
  reason: Segment['reason'] = 'silence',
): Segment => ({ startFrame, lastSpeechFrame, endFrame, reason });

const evaluate = (truth: TruthSpan[], segments: Segment[], durationFrames = MIN): Metrics =>
  evaluateScene({ ctxRate: RATE, durationFrames, truth, segments });

describe('overlaps (half-open intervals)', () => {
  it('is true for any shared frame and false for touching intervals', () => {
    expect(overlaps(0, 10, 5, 15)).toBe(true);
    expect(overlaps(5, 15, 0, 10)).toBe(true);
    expect(overlaps(0, 10, 2, 3)).toBe(true); // containment
    expect(overlaps(0, 10, 0, 10)).toBe(true);
    expect(overlaps(0, 10, 9, 20)).toBe(true); // one shared frame
    expect(overlaps(0, 10, 10, 20)).toBe(false); // touching at 10
    expect(overlaps(10, 20, 0, 10)).toBe(false);
    expect(overlaps(0, 10, 11, 20)).toBe(false);
  });
});

describe('percentile (nearest rank)', () => {
  it('takes the ⌈p·n/100⌉-th smallest value of an unsorted list', () => {
    const v = [100, 10, 90, 20, 80, 30, 70, 40, 60, 50];
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 90)).toBe(90);
    expect(percentile(v, 91)).toBe(100);
    expect(percentile(v, 100)).toBe(100);
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([3, 1], 50)).toBe(1);
    expect(v).toEqual([100, 10, 90, 20, 80, 30, 70, 40, 60, 50]); // not sorted in place
  });

  it('is null for no values and rejects p outside (0, 100]', () => {
    expect(percentile([], 90)).toBeNull();
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
    expect(() => percentile([1], Number.NaN)).toThrow(RangeError);
  });
});

describe('allowedErrors', () => {
  it('is floor(3·N/180)', () => {
    expect([0, 59, 60, 119, 120, 180, 181, 389].map(allowedErrors)).toEqual([0, 0, 1, 1, 2, 3, 3, 6]);
  });
});

describe('evaluateScene', () => {
  it('counts every short phrase as a miss when there are no segments', () => {
    const m = evaluate([short('a', 1000, 2000), short('b', 5000, 6000), passage('p', 9000, 19000)], []);
    expect(m).toMatchObject({
      shortPhrases: 2,
      hits: 0,
      misses: 2,
      splits: 0,
      truncChecked: 0,
      truncations: 0,
      capEnds: 0,
      misfires: 0,
      segments: 0,
      falseTriggers: 0,
      minutes: 1,
      falseTriggersPerMin: 0,
      eosMs: [],
      eosP50Ms: null,
      eosP90Ms: null,
    });
  });

  it('scores a hit and its end-of-speech latency against the true offset', () => {
    const m = evaluate([short('a', 1000, 2000)], [seg(950, 2640, 1990)]);
    expect(m).toMatchObject({ shortPhrases: 1, hits: 1, misses: 0, splits: 0, falseTriggers: 0 });
    expect(m.eosMs).toEqual([640]);
    expect(m.eosP50Ms).toBe(640);
    expect(m.eosP90Ms).toBe(640);
  });

  it('does not count segments that only touch a span, and counts them as false triggers', () => {
    // [0, 1000) ends where the span starts; [2000, 2700) starts where it ends.
    const m = evaluate([short('a', 1000, 2000)], [seg(0, 1000, 400), seg(2000, 2700, 2100)]);
    expect(m).toMatchObject({ hits: 0, misses: 1, splits: 0, falseTriggers: 2, falseTriggersPerMin: 2 });
    // One frame of overlap on either side is enough.
    const n = evaluate([short('a', 1000, 2000)], [seg(0, 1001, 400)]);
    expect(n).toMatchObject({ hits: 1, misses: 0, falseTriggers: 0 });
    const o = evaluate([short('a', 1000, 2000)], [seg(1999, 2700, 2100)]);
    expect(o).toMatchObject({ hits: 1, misses: 0, falseTriggers: 0 });
  });

  it('scores a split when ≥ 2 segments overlap one short phrase, with no latency', () => {
    const m = evaluate([short('a', 1000, 3000)], [seg(1000, 2100, 1500), seg(2200, 3640, 2990)]);
    expect(m).toMatchObject({ hits: 0, misses: 0, splits: 1, falseTriggers: 0, segments: 2, eosMs: [] });
    // Segments that overlap each other count separately too.
    const n = evaluate([short('a', 1000, 3000)], [seg(900, 2500, 1800), seg(1200, 3600, 2900)]);
    expect(n).toMatchObject({ hits: 0, splits: 1, falseTriggers: 0 });
  });

  it('scores two hits when one segment covers two short phrases', () => {
    const m = evaluate([short('a', 1000, 2000), short('b', 2500, 3000)], [seg(900, 3600, 2950)]);
    expect(m).toMatchObject({ hits: 2, misses: 0, splits: 0, falseTriggers: 0 });
    expect(m.eosMs).toEqual([1600, 600]);
  });

  it('never counts a misfire as a hit, a split or a false trigger', () => {
    const m = evaluate(
      [short('a', 1000, 2000), short('b', 5000, 6000)],
      [
        seg(1000, 2600, null, 'misfire'), // the only segment on a: a miss
        seg(5000, 5800, null, 'misfire'), // a misfire next to a real segment on b: still a hit
        seg(5100, 6650, 6050),
        seg(9000, 9700, null, 'misfire'), // in the noise: not a false trigger
      ],
    );
    expect(m).toMatchObject({ hits: 1, misses: 1, splits: 0, misfires: 3, segments: 1, falseTriggers: 0 });
    expect(m.eosMs).toEqual([650]);
  });

  it('counts an open segment for overlaps, without a latency', () => {
    const m = evaluate([short('a', 1000, 2000)], [seg(1000, MIN, null, 'open')]);
    expect(m).toMatchObject({ hits: 1, truncChecked: 0, falseTriggers: 0, eosMs: [] });
    const n = evaluate([short('a', 1000, 2000)], [seg(50_000, MIN, null, 'open')]);
    expect(n).toMatchObject({ misses: 1, falseTriggers: 1 });
  });

  it('flags truncation when lastSpeechFrame + 150 ms < span end − 150 ms (strict)', () => {
    const t = [short('a', 1000, 3000)];
    expect(evaluate(t, [seg(1000, 3299, 2699)])).toMatchObject({ truncChecked: 1, truncations: 1 });
    expect(evaluate(t, [seg(1000, 3300, 2700)])).toMatchObject({ truncChecked: 1, truncations: 0 }); // equal
    // A split takes the latest lastSpeechFrame of its segments.
    expect(evaluate(t, [seg(1000, 2100, 1500), seg(2200, 3500, 2900)])).toMatchObject({
      splits: 1,
      truncChecked: 1,
      truncations: 0,
    });
    // Misfires have no lastSpeechFrame and are not segments: nothing to check.
    expect(evaluate(t, [seg(1000, 2100, null, 'misfire')])).toMatchObject({
      truncChecked: 0,
      truncations: 0,
    });
  });

  it('uses passages only for truncation and cap ends', () => {
    const m = evaluate(
      [passage('p', 1000, 12_000)],
      [seg(1000, 4000, 3400), seg(4500, 11_000, 10_900, 'maxLength')],
    );
    expect(m).toMatchObject({
      shortPhrases: 0,
      hits: 0,
      misses: 0,
      splits: 0, // two segments on a passage are not a split
      truncChecked: 1,
      truncations: 1, // 10 900 + 150 < 12 000 − 150
      capEnds: 1,
      falseTriggers: 0,
      eosMs: [],
    });
  });

  it('rates false triggers per minute of evaluated input', () => {
    const m = evaluate(
      [short('a', 1000, 2000)],
      [seg(1000, 2600), seg(30_000, 30_900), seg(60_000, 61_000)],
      2 * MIN,
    );
    expect(m).toMatchObject({ falseTriggers: 2, minutes: 2, falseTriggersPerMin: 1 });
    expect(evaluate([], [seg(0, 900)], 0)).toMatchObject({
      falseTriggers: 1,
      minutes: 0,
      falseTriggersPerMin: 0,
    });
  });

  it('gives each hit its latency and takes nearest-rank p50 and p90', () => {
    const truth = Array.from({ length: 10 }, (_, i) => short(`u${i}`, 10_000 * i, 10_000 * i + 1000));
    const segments = truth.map((t, i) => seg(t.start, t.end + 100 * (10 - i), t.end - 10));
    const m = evaluate(truth, segments, 2 * MIN);
    expect(m.eosMs).toEqual([1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]);
    expect(m.eosP50Ms).toBe(500);
    expect(m.eosP90Ms).toBe(900);
  });

  it('converts frames with the context rate', () => {
    const m = evaluateScene({
      ctxRate: 48_000,
      durationFrames: 48_000 * 30,
      truth: [{ id: 'a', kind: 'short', start: 48_000, end: 96_000, offset: 96_000 }],
      segments: [seg(48_000, 96_000 + 28_800, 96_000 - 1536)],
    });
    expect(m.eosMs).toEqual([600]);
    expect(m.minutes).toBe(0.5);
    // 150 ms is 7200 frames at 48 kHz: lastSpeech 96 000 − 14 401 is truncated, − 14 400 is not.
    const at = (last: number): number =>
      evaluateScene({
        ctxRate: 48_000,
        durationFrames: 48_000 * 30,
        truth: [{ id: 'a', kind: 'short', start: 48_000, end: 96_000, offset: 96_000 }],
        segments: [seg(48_000, 100_000, last)],
      }).truncations;
    expect(at(96_000 - 14_401)).toBe(1);
    expect(at(96_000 - 14_400)).toBe(0);
  });

  it('rejects a non-positive ctxRate', () => {
    expect(() => evaluateScene({ ctxRate: 0, durationFrames: 1, truth: [], segments: [] })).toThrow(
      RangeError,
    );
  });
});

describe('corpusTruth', () => {
  it('joins the consecutive spans of one id into a hull, with the last end as the offset, at the context rate', () => {
    const t = corpusTruth(
      {
        sampleRate: 16_000,
        spans: [
          [100, 200],
          [300, 450],
        ],
        kinds: ['sentence', 'sentence'],
        ids: ['s1', 's1'],
      },
      48_000,
    );
    expect(t).toEqual([{ id: 's1', kind: 'short', start: 300, end: 1350, offset: 1350 }]);
  });

  it('maps words and sentences to short phrases and passages to passages, one per id run', () => {
    const t = corpusTruth(
      {
        sampleRate: 16_000,
        spans: [
          [0, 10],
          [20, 30],
          [40, 50],
          [60, 70],
          [80, 90],
        ],
        kinds: ['word', 'sentence', 'passage', 'passage', 'word'],
        ids: ['w', 's', 'p', 'p', 'w'],
      },
      16_000,
    );
    expect(t).toEqual([
      { id: 'w', kind: 'short', start: 0, end: 10, offset: 10 },
      { id: 's', kind: 'short', start: 20, end: 30, offset: 30 },
      { id: 'p', kind: 'passage', start: 40, end: 70, offset: 70 },
      // The same id again after another utterance is a new utterance.
      { id: 'w', kind: 'short', start: 80, end: 90, offset: 90 },
    ]);
    expect(corpusTruth({ sampleRate: 16_000, spans: [], kinds: [], ids: [] }, 48_000)).toEqual([]);
  });
});

describe('poolMetrics', () => {
  it('adds counts and minutes, recomputes the rate and the percentiles', () => {
    const a = evaluate([short('a', 1000, 2000)], [seg(1000, 2600, 1900), seg(30_000, 30_500)], MIN);
    const b = evaluate([short('b', 1000, 2000), short('c', 5000, 6000)], [seg(1000, 3000, 1900)], 3 * MIN);
    const p = poolMetrics([a, b]);
    expect(p).toMatchObject({
      shortPhrases: 3,
      hits: 2,
      misses: 1,
      splits: 0,
      segments: 3,
      falseTriggers: 1,
      minutes: 4,
      falseTriggersPerMin: 0.25, // 1 in 4 min, not the mean of 1/min and 0/min
      eosMs: [600, 1000],
      eosP50Ms: 600,
      eosP90Ms: 1000,
    });
    expect(poolMetrics([])).toMatchObject({
      shortPhrases: 0,
      minutes: 0,
      falseTriggersPerMin: 0,
      eosP50Ms: null,
    });
  });
});

/** Metrics with the given counts (the rest zero). */
function metrics(p: Partial<Metrics>): Metrics {
  return { ...evaluate([], [], 0), ...p };
}

function scene(
  name: string,
  type: GateScene['type'],
  noise: string,
  snrDb: number | null,
  p: Partial<Metrics>,
): GateScene {
  return { name, type, noise, snrDb, metrics: metrics(p) };
}

/** 180 short phrases over SNR 20/10/5, plus the fan and music noise-only streams, all clean. */
function base(): GateScene[] {
  return [
    scene('fan-snr20', 'snr', 'fan', 20, { shortPhrases: 60, hits: 60, minutes: 1.5 }),
    scene('tv-snr10', 'snr', 'tv', 10, { shortPhrases: 60, hits: 60, minutes: 1.5 }),
    scene('music-snr5', 'snr', 'music', 5, { shortPhrases: 60, hits: 60, minutes: 1.5 }),
    scene('fan-noise', 'noise-only', 'fan', null, { minutes: 15 }),
    scene('music-noise', 'noise-only', 'music', null, { minutes: 15 }),
    scene('music-snr10', 'snr', 'music', 10, { minutes: 1.5 }),
  ];
}

function check(r: GateResult, prefix: string): GateCheck | undefined {
  return r.checks.find((c) => c.name.startsWith(prefix));
}

/** Whether the gate passes once scene `name` of base() has `falseTriggers` false triggers. */
function passesWithFalseTriggers(name: string, falseTriggers: number): boolean {
  const s = base();
  const target = s.find((x) => x.name === name)!;
  target.metrics = metrics({
    ...target.metrics,
    falseTriggers,
    falseTriggersPerMin: falseTriggers / target.metrics.minutes,
  });
  return ttsGate(s).pass;
}

describe('ttsGate', () => {
  it('passes a clean corpus and lists every check', () => {
    const r = ttsGate(base());
    expect(r.pass).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual([
      'misses (SNR 20/10/5, N = 180)',
      'splits (SNR 20/10/5, N = 180)',
      'false triggers/min, fan noise-only (0 in 15.0 min)',
      'false triggers/min, fan SNR ≥ 10 (0 in 1.5 min)',
      'false triggers/min, music noise-only (0 in 15.0 min)',
      'false triggers/min, music SNR ≥ 10 (0 in 1.5 min)',
    ]);
    expect(check(r, 'misses')).toMatchObject({
      value: 0,
      limit: 3,
      scenes: ['fan-snr20', 'tv-snr10', 'music-snr5', 'music-snr10'],
    });
    expect(check(r, 'false triggers/min, music SNR')).toMatchObject({ scenes: ['music-snr10'] });
  });

  it('allows floor(3·N/180) misses and splits, pooled over SNR 20, 10 and 5 only', () => {
    const at = (misses: number, splits: number): boolean => {
      const s = base();
      s[0]!.metrics = metrics({ shortPhrases: 60, hits: 60 - misses - splits, misses, splits, minutes: 1.5 });
      return ttsGate(s).pass;
    };
    expect(at(3, 3)).toBe(true);
    expect(at(4, 0)).toBe(false);
    expect(at(0, 4)).toBe(false);
    // SNR 0 is reported, not gated; the passages scene has no short phrases.
    const s = base();
    s.push(scene('fan-snr0', 'snr', 'fan', 0, { shortPhrases: 30, misses: 30, minutes: 1.5 }));
    s.push(scene('passages', 'passages', 'fan', 20, { truncations: 8, minutes: 1.5 }));
    expect(ttsGate(s).pass).toBe(true);
    expect(check(ttsGate(s), 'misses')).toMatchObject({
      limit: 3,
      scenes: ['fan-snr20', 'tv-snr10', 'music-snr5', 'music-snr10'],
    });
  });

  it("gates false triggers on the passages scene with its noise's SNR ≥ 10 scenes", () => {
    const s = base();
    s.push(scene('passages', 'passages', 'fan', 20, { minutes: 1.5 }));
    expect(check(ttsGate(s), 'false triggers/min, fan SNR')).toMatchObject({
      scenes: ['fan-snr20', 'passages'],
      pass: true,
    });
    s[s.length - 1]!.metrics = metrics({ minutes: 1.5, falseTriggers: 1 });
    // 1 false trigger in 3.0 min of fan SNR ≥ 10 scenes: 0.333/min.
    expect(check(ttsGate(s), 'false triggers/min, fan SNR')).toMatchObject({ value: 0.333, pass: false });
    expect(ttsGate(s).pass).toBe(false);
  });

  it('allows 0 errors when N < 60 (the fast subset may have floor 0)', () => {
    const s = [
      scene('fast-fan-snr10', 'snr', 'fan', 10, { shortPhrases: 20, hits: 19, misses: 1, minutes: 1.2 }),
    ];
    const r = ttsGate(s);
    expect(check(r, 'misses')).toMatchObject({ value: 1, limit: 0, pass: false });
    expect(r.pass).toBe(false);
  });

  it('fails when there is no gated SNR scene', () => {
    const r = ttsGate([scene('fan-noise', 'noise-only', 'fan', null, { minutes: 15 })]);
    expect(check(r, 'misses')!.pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('gates false triggers at 0.13/min per noise-only stream and per noise over SNR ≥ 10', () => {
    expect(MAX_FALSE_TRIGGERS_PER_MIN).toBe(0.13);
    const ft = passesWithFalseTriggers;
    expect(ft('fan-noise', 1)).toBe(true); // 0.067/min
    expect(ft('fan-noise', 2)).toBe(false); // 0.133/min > 0.13
    expect(ft('music-noise', 2)).toBe(false);
    expect(ft('music-snr10', 1)).toBe(false); // 0.67/min
    // tv and SNR-5 scenes are not gated for false triggers.
    expect(ft('tv-snr10', 5)).toBe(true);
    expect(ft('music-snr5', 5)).toBe(true);
  });

  it('pools the SNR ≥ 10 scenes of one noise', () => {
    const s = base();
    s.push(scene('music-snr20', 'snr', 'music', 20, { shortPhrases: 0, minutes: 14, falseTriggers: 2 }));
    // 2 false triggers in 15.5 min of music SNR ≥ 10 scenes: 0.129/min.
    const r = ttsGate(s);
    expect(check(r, 'false triggers/min, music SNR')).toMatchObject({
      value: 0.129,
      pass: true,
      scenes: ['music-snr10', 'music-snr20'],
    });
  });
});
