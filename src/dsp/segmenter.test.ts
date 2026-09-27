import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ENERGY_SEG_PARAMS,
  SILERO_SEG_PARAMS,
  initialSegState,
  segmenterStep,
  type SegEvent,
  type SegParams,
  type SegState,
} from './segmenter.ts';

/**
 * Example parameters as a literal object, so the examples never depend on the tunable constants
 * (#59 retunes `SILERO_SEG_PARAMS` and can't edit this file). `frameMs` is spelled out for the same reason.
 */
const P: SegParams = {
  ...SILERO_SEG_PARAMS,
  posThreshold: 0.5,
  negThreshold: 0.35,
  hangoverMs: 600,
  minSpeechMs: 150,
  maxUtteranceMs: 10000,
  frameMs: 32,
};

const NUM_RUNS = 1000;

interface Emitted {
  step: number;
  ev: SegEvent;
}

function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`index ${i} out of range (length ${xs.length})`);
  return x;
}

/** Concatenates constant runs: `seq([0.9, 5], [0, 40])` is five 0.9s followed by forty 0s. */
function seq(...runs: Array<[value: number, count: number]>): number[] {
  const out: number[] = [];
  for (const [value, count] of runs) for (let i = 0; i < count; i++) out.push(value);
  return out;
}

/** Steps a segmenter over `probs` (frame label `frames[i]`, else the step index) and records every event. */
function run(
  p: SegParams,
  probs: readonly number[],
  frames?: readonly number[],
  s: SegState = initialSegState(),
): Emitted[] {
  const out: Emitted[] = [];
  for (const [i, prob] of probs.entries()) {
    const ev = segmenterStep(s, p, frames === undefined ? i : at(frames, i), prob);
    if (ev !== null) out.push({ step: i, ev });
  }
  return out;
}

const start = (step: number, frame = step): Emitted => ({ step, ev: { kind: 'start', frame } });
const end = (
  step: number,
  lastSpeechFrame: number,
  reason: 'silence' | 'maxLength',
  frame = step,
): Emitted => ({ step, ev: { kind: 'end', frame, lastSpeechFrame, reason } });
const misfire = (step: number, frame = step): Emitted => ({ step, ev: { kind: 'misfire', frame } });

describe('segmenter examples (32 ms steps, frame = step index)', () => {
  it('1: five speech steps, then a silence end on the step where 19 silent steps have elapsed', () => {
    expect(run(P, seq([0.9, 5], [0, 40]))).toEqual([start(0), end(23, 4, 'silence')]);
  });

  it('2: four speech steps (128 ms < 150 ms), then zeros, is a misfire at step 22', () => {
    expect(run(P, seq([0.9, 4], [0, 40]))).toEqual([start(0), misfire(22)]);
  });

  it('3: values between the thresholds neither start nor extend silence', () => {
    expect(run(P, seq([0.9, 5], [0.4, 30], [0.9, 1]))).toEqual([start(0)]);
    expect(run(P, seq([0.4, 50]))).toEqual([]);
    expect(run(P, seq([0.9, 5], [0.4, 30], [0.9, 1], [0, 40]))).toEqual([start(0), end(54, 35, 'silence')]);
  });

  it('4: a gap shorter than the hangover does not split the segment', () => {
    expect(run(P, seq([0.9, 1], [0.2, 10], [0.9, 5], [0, 40]))).toEqual([start(0), end(34, 15, 'silence')]);
  });

  it('5: continuous speech ends at the cap on step 312 (313 × 32 ≥ 10 000) and restarts only on the next step', () => {
    expect(run(P, seq([0.9, 314]))).toEqual([start(0), end(312, 312, 'maxLength'), start(313)]);
  });
});

describe('segmenter rules', () => {
  it('prob equal to posThreshold is speech; prob equal to negThreshold is between the thresholds', () => {
    expect(run(P, seq([0.5, 5], [0, 40]))).toEqual([start(0), end(23, 4, 'silence')]);
    expect(run(P, seq([0.5, 5], [0.35, 40]))).toEqual([start(0)]);
  });

  it('the hangover, minimum-speech and cap comparisons are inclusive', () => {
    expect(run({ ...P, hangoverMs: 608 }, seq([0.9, 5], [0, 40]))).toEqual([start(0), end(23, 4, 'silence')]);
    expect(run({ ...P, minSpeechMs: 160 }, seq([0.9, 5], [0, 40]))).toEqual([
      start(0),
      end(23, 4, 'silence'),
    ]);
    expect(run({ ...P, maxUtteranceMs: 10016 }, seq([0.9, 320]))).toEqual([
      start(0),
      end(312, 312, 'maxLength'),
      start(313),
    ]);
  });

  it('a silence end takes priority over the cap on the same step', () => {
    expect(run({ ...P, maxUtteranceMs: 768 }, seq([0.9, 5], [0, 40]))).toEqual([
      start(0),
      end(23, 4, 'silence'),
    ]);
    expect(run({ ...P, maxUtteranceMs: 736 }, seq([0.9, 4], [0, 40]))).toEqual([start(0), misfire(22)]);
  });

  it('a cap end is emitted whatever the amount of speech', () => {
    expect(run(P, seq([0.9, 5], [0.4, 400]))).toEqual([start(0), end(312, 4, 'maxLength')]);
  });

  it('values between the thresholds after a silence start change nothing, so the hangover keeps counting', () => {
    expect(run(P, seq([0.9, 5], [0.2, 1], [0.4, 40]))).toEqual([start(0), end(23, 4, 'silence')]);
  });

  it('counts durations in steps, never from frame-label differences', () => {
    const probs = seq([0.9, 5], [0, 40]);
    const linear = (i: number): number => 1000 + 1536 * i;
    const square = (i: number): number => i * i + 7;
    expect(
      run(
        P,
        probs,
        probs.map((_, i) => linear(i)),
      ),
    ).toEqual([start(0, linear(0)), end(23, linear(4), 'silence', linear(23))]);
    expect(
      run(
        P,
        probs,
        probs.map((_, i) => square(i)),
      ),
    ).toEqual([start(0, square(0)), end(23, square(4), 'silence', square(23))]);
    const capped = seq([0.9, 314]);
    expect(
      run(
        P,
        capped,
        capped.map((_, i) => linear(i)),
      ),
    ).toEqual([
      start(0, linear(0)),
      end(312, linear(312), 'maxLength', linear(312)),
      start(313, linear(313)),
    ]);
  });

  it('starts every segment from fresh state (back-to-back segments)', () => {
    expect(run(P, seq([0.9, 5], [0, 19], [0.9, 1], [0, 40]))).toEqual([
      start(0),
      end(23, 4, 'silence'),
      start(24),
      misfire(43),
    ]);
  });

  it('initialSegState returns an independent idle state on every call', () => {
    const a = initialSegState();
    const b = initialSegState();
    expect(a).not.toBe(b);
    expect(segmenterStep(a, P, 0, 0.9)).toEqual({ kind: 'start', frame: 0 });
    expect(b).toEqual(initialSegState());
    expect(segmenterStep(b, P, 0, 0)).toBeNull();
  });
});

// ---- property tests -------------------------------------------------------------------------------

const randomParamsArb: fc.Arbitrary<SegParams> = fc
  .record({
    frameMs: fc.integer({ min: 5, max: 64 }),
    negThreshold: fc.double({ min: 0.05, max: 0.9, noNaN: true }),
    gap: fc.double({ min: 0, max: 0.3, noNaN: true }), // posThreshold − negThreshold; 0 = one threshold (energy)
    hangoverMs: fc.integer({ min: 50, max: 1500 }),
    minSpeechMs: fc.integer({ min: 0, max: 500 }),
    maxUtteranceMs: fc.integer({ min: 500, max: 12000 }),
  })
  .map(({ gap, ...rest }) => ({ ...rest, posThreshold: Math.min(1, rest.negThreshold + gap) }));

/** Random sane parameters, plus the two shipped sets whatever their tuned values are. */
const paramsArb: fc.Arbitrary<SegParams> = fc.oneof(
  { arbitrary: randomParamsArb, weight: 4 },
  { arbitrary: fc.constant(SILERO_SEG_PARAMS), weight: 1 },
  { arbitrary: fc.constant(ENERGY_SEG_PARAMS), weight: 1 },
);

/** Constant runs (including values exactly at and just below each threshold), or i.i.d. values. */
function probsArb(p: SegParams): fc.Arbitrary<number[]> {
  const level = fc.oneof(
    fc.constantFrom(0, 1, p.posThreshold, p.negThreshold, p.posThreshold - 1e-9, p.negThreshold - 1e-9),
    fc.double({ min: 0, max: 1, noNaN: true }),
  );
  const runs = fc
    .array(fc.tuple(level, fc.integer({ min: 1, max: 80 })), { maxLength: 40 })
    .map((r) => seq(...r));
  const iid = fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 500 });
  return fc.oneof({ arbitrary: runs, weight: 3 }, { arbitrary: iid, weight: 1 });
}

/** Strictly increasing, non-uniform frame labels: `offset`, then repeating increments `incs`. */
interface Labels {
  offset: number;
  incs: number[];
}
const labelsArb: fc.Arbitrary<Labels> = fc.record({
  offset: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
  incs: fc.array(fc.integer({ min: 1, max: 3000 }), { minLength: 1, maxLength: 16 }),
});
function labelsFor({ offset, incs }: Labels, n: number): number[] {
  const out: number[] = [];
  let f = offset;
  for (let i = 0; i < n; i++) {
    out.push(f);
    f += at(incs, i % incs.length);
  }
  return out;
}

interface Case {
  p: SegParams;
  probs: number[];
  frames: number[];
}
const caseArb: fc.Arbitrary<Case> = paramsArb.chain((p) =>
  fc
    .tuple(probsArb(p), labelsArb)
    .map(([probs, labels]) => ({ p, probs, frames: labelsFor(labels, probs.length) })),
);

/**
 * Offline reference: the issue's rules restated as a scan over whole segments, with per-segment locals
 * instead of a persistent `SegState`, and frame labels looked up by step.
 */
function referenceEvents(p: SegParams, probs: readonly number[], frames: readonly number[]): Emitted[] {
  const out: Emitted[] = [];
  let i = 0;
  while (i < probs.length) {
    if (!(at(probs, i) >= p.posThreshold)) {
      i++;
      continue;
    }
    const s0 = i;
    out.push({ step: s0, ev: { kind: 'start', frame: at(frames, s0) } });
    let last = s0;
    let silence: number | null = null;
    let closed: Emitted | null = null;
    for (let j = s0 + 1; j < probs.length && closed === null; j++) {
      const q = at(probs, j);
      if (q >= p.posThreshold) {
        last = j;
        silence = null;
      } else if (q < p.negThreshold && silence === null) {
        silence = j;
      }
      if (silence !== null && (j - silence + 1) * p.frameMs >= p.hangoverMs) {
        closed =
          (last - s0 + 1) * p.frameMs >= p.minSpeechMs
            ? {
                step: j,
                ev: {
                  kind: 'end',
                  frame: at(frames, j),
                  lastSpeechFrame: at(frames, last),
                  reason: 'silence',
                },
              }
            : { step: j, ev: { kind: 'misfire', frame: at(frames, j) } };
      } else if ((j - s0 + 1) * p.frameMs >= p.maxUtteranceMs) {
        closed = {
          step: j,
          ev: { kind: 'end', frame: at(frames, j), lastSpeechFrame: at(frames, last), reason: 'maxLength' },
        };
      }
    }
    if (closed === null) break; // the last segment is still open when the input ends
    out.push(closed);
    i = closed.step + 1;
  }
  return out;
}

describe('segmenter properties (fast-check)', () => {
  it('events alternate: a start is followed by exactly one end or misfire before the next start', () => {
    fc.assert(
      fc.property(caseArb, ({ p, probs, frames }) => {
        let open = false;
        for (const { ev } of run(p, probs, frames)) {
          expect(open).toBe(ev.kind !== 'start');
          open = ev.kind === 'start';
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('silence ends have at least minSpeech of speech and misfires less; the cap bounds every segment (steps tracked here)', () => {
    fc.assert(
      fc.property(caseArb, ({ p, probs, frames }) => {
        let startStep = -1;
        for (const { step, ev } of run(p, probs, frames)) {
          if (ev.kind === 'start') {
            startStep = step;
            continue;
          }
          let lastSpeechStep = startStep;
          for (let i = startStep; i <= step; i++) if (at(probs, i) >= p.posThreshold) lastSpeechStep = i;
          const speechMs = (lastSpeechStep - startStep + 1) * p.frameMs;
          const spanMs = (step - startStep + 1) * p.frameMs;
          // No segment outlives the cap: it was not reached on the previous step.
          expect((step - startStep) * p.frameMs).toBeLessThan(p.maxUtteranceMs);
          if (ev.kind === 'misfire') {
            expect(speechMs).toBeLessThan(p.minSpeechMs);
            continue;
          }
          expect(ev.lastSpeechFrame).toBe(at(frames, lastSpeechStep));
          expect(spanMs).toBeGreaterThanOrEqual(p.minSpeechMs);
          if (ev.reason === 'silence') expect(speechMs).toBeGreaterThanOrEqual(p.minSpeechMs);
          else expect(spanMs).toBeGreaterThanOrEqual(p.maxUtteranceMs);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('an all-zero sequence emits nothing', () => {
    fc.assert(
      fc.property(paramsArb, fc.integer({ min: 0, max: 3000 }), labelsArb, (p, n, labels) => {
        expect(run(p, new Array<number>(n).fill(0), labelsFor(labels, n))).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('appending only zeros after an end or a misfire emits nothing more', () => {
    fc.assert(
      fc.property(caseArb, ({ p, probs, frames }) => {
        const s = initialSegState();
        for (const [i, prob] of probs.entries()) {
          const ev = segmenterStep(s, p, at(frames, i), prob);
          if (ev === null || ev.kind === 'start') continue;
          const fork: SegState = { ...s };
          const extra: SegEvent[] = [];
          for (let j = 1; j <= 400; j++) {
            const next = segmenterStep(fork, p, at(frames, i) + j, 0);
            if (next !== null) extra.push(next);
          }
          expect(extra).toEqual([]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('lastSpeechFrame lies between the start frame and the end frame', () => {
    fc.assert(
      fc.property(caseArb, ({ p, probs, frames }) => {
        let startFrame = Number.NaN;
        for (const { ev } of run(p, probs, frames)) {
          if (ev.kind === 'start') startFrame = ev.frame;
          if (ev.kind !== 'end') continue;
          expect(ev.lastSpeechFrame).toBeGreaterThanOrEqual(startFrame);
          expect(ev.lastSpeechFrame).toBeLessThanOrEqual(ev.frame);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('matches an offline reference scan of the rules, with random frame labels', () => {
    fc.assert(
      fc.property(caseArb, ({ p, probs, frames }) => {
        expect(run(p, probs, frames)).toEqual(referenceEvents(p, probs, frames));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
