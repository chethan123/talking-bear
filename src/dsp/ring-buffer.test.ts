import fc from 'fast-check';
import type { Arbitrary, Command } from 'fast-check';
import { describe, expect, test } from 'vitest';

import { RingBuffer } from './ring-buffer.ts';

/** `n` samples for frames `from … from+n−1`; the value of frame f is `100 + f`. */
function seq(from: number, n: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => 100 + from + i);
}

function values(from: number, n: number): number[] {
  return Array.from(seq(from, n));
}

function expectRangeError(fn: () => unknown, message?: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RangeError);
  if (message !== undefined) expect(caught).toHaveProperty('message', message);
}

function snapshot(rb: RingBuffer): Record<string, unknown> {
  return {
    isEmpty: rb.isEmpty,
    startFrame: rb.startFrame,
    endFrame: rb.endFrame,
    gapCount: rb.gapCount,
    gapFrames: rb.gapFrames,
  };
}

describe('RingBuffer examples', () => {
  test('wrap-around: capacity 10, frames 0–7 then 8–15', () => {
    const rb = new RingBuffer(10);
    rb.write(seq(0, 8), 0);
    rb.write(seq(8, 8), 8);
    expect(Array.from(rb.read(6, 16))).toEqual(values(6, 10));
    expect(rb.startFrame).toBe(6);
    expect(rb.endFrame).toBe(16);
    expectRangeError(() => rb.read(5, 6));
  });

  test('the first write sets the base', () => {
    const rb = new RingBuffer(16);
    rb.write(seq(1000, 4), 1000);
    expect(rb.startFrame).toBe(1000);
    expect(rb.endFrame).toBe(1004);
    expect(rb.isEmpty).toBe(false);
    expect(Array.from(rb.read(1000, 1004))).toEqual(values(1000, 4));
  });

  test.each([5, 0, -3])('an overlapping write at %i throws overlap and changes nothing', (start) => {
    const rb = new RingBuffer(8);
    rb.write(seq(0, 6), 0);
    const before = snapshot(rb);
    expectRangeError(() => rb.write(seq(50, 4), start), 'overlap');
    expect(Array.from(rb.read(0, 6))).toEqual(values(0, 6));
    expect(snapshot(rb)).toEqual(before);
    expect(before).toEqual({ isEmpty: false, startFrame: 0, endFrame: 6, gapCount: 0, gapFrames: 0 });
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'the constructor rejects capacity %s',
    (capacity) => {
      expectRangeError(() => new RingBuffer(capacity));
    },
  );

  test('a new buffer is empty', () => {
    const rb = new RingBuffer(3);
    expect(rb.capacity).toBe(3);
    expect(snapshot(rb)).toEqual({
      isEmpty: true,
      startFrame: Number.NaN,
      endFrame: Number.NaN,
      gapCount: 0,
      gapFrames: 0,
    });
  });

  test('reads on an empty buffer throw', () => {
    const rb = new RingBuffer(3);
    expectRangeError(() => rb.read(0, 0));
    expectRangeError(() => rb.read(0, 1));
    expectRangeError(() => rb.readInto(0, new Float32Array(0)));
  });

  test('a gap is zero-filled and counted', () => {
    const rb = new RingBuffer(16);
    rb.write(seq(0, 4), 0);
    rb.write(seq(7, 2), 7);
    expect(Array.from(rb.read(0, 9))).toEqual([...values(0, 4), 0, 0, 0, ...values(7, 2)]);
    expect(rb.gapCount).toBe(1);
    expect(rb.gapFrames).toBe(3);
    expect(rb.endFrame).toBe(9);
    rb.write(seq(9, 1), 9);
    expect(rb.gapCount).toBe(1);
    expect(rb.gapFrames).toBe(3);
    rb.write(seq(12, 1), 12);
    expect(rb.gapCount).toBe(2);
    expect(rb.gapFrames).toBe(5);
    expect(Array.from(rb.read(9, 13))).toEqual([109, 0, 0, 112]);
  });

  test('a block longer than the capacity keeps its last capacity frames', () => {
    const rb = new RingBuffer(4);
    rb.write(seq(0, 10), 0);
    expect(rb.startFrame).toBe(6);
    expect(rb.endFrame).toBe(10);
    expect(Array.from(rb.read(6, 10))).toEqual(values(6, 4));
  });

  test('a gap longer than the capacity keeps its last frames', () => {
    const rb = new RingBuffer(4);
    rb.write(seq(0, 2), 0);
    rb.write(seq(20, 1), 20);
    expect(rb.gapCount).toBe(1);
    expect(rb.gapFrames).toBe(18);
    expect(rb.startFrame).toBe(17);
    expect(rb.endFrame).toBe(21);
    expect(Array.from(rb.read(17, 21))).toEqual([0, 0, 0, 120]);
  });

  test('read rules', () => {
    const rb = new RingBuffer(8);
    rb.write(seq(0, 12), 0);
    expect(rb.startFrame).toBe(4);
    expect(rb.endFrame).toBe(12);
    expect(rb.read(4, 4)).toHaveLength(0);
    expect(rb.read(12, 12)).toHaveLength(0);
    expectRangeError(() => rb.read(5, 4));
    expectRangeError(() => rb.read(3, 5));
    expectRangeError(() => rb.read(10, 13));

    const evicted = new Float32Array(2).fill(-7);
    expectRangeError(() => rb.readInto(3, evicted));
    expect(Array.from(evicted)).toEqual([-7, -7]);
    const unwritten = new Float32Array(2).fill(-7);
    expectRangeError(() => rb.readInto(11, unwritten));
    expect(Array.from(unwritten)).toEqual([-7, -7]);

    const out = new Float32Array(5);
    rb.readInto(6, out);
    expect(Array.from(out)).toEqual(values(6, 5));
  });

  test('frame indices must be integers', () => {
    const rb = new RingBuffer(8);
    rb.write(seq(0, 12), 0);
    expectRangeError(() => rb.read(4.5, 6));
    expectRangeError(() => rb.read(4, 6.5));
    expectRangeError(() => rb.read(Number.NaN, 6));
    expectRangeError(() => rb.read(4, Number.POSITIVE_INFINITY));
    const out = new Float32Array(1).fill(-7);
    expectRangeError(() => rb.readInto(4.5, out));
    expect(Array.from(out)).toEqual([-7]);

    const before = snapshot(rb);
    expectRangeError(() => rb.write(seq(0, 1), 12.5));
    expectRangeError(() => rb.write(seq(0, 1), Number.NaN));
    expectRangeError(() => rb.write(seq(0, 1), Number.POSITIVE_INFINITY));
    expect(snapshot(rb)).toEqual(before);
    expect(Array.from(rb.read(4, 12))).toEqual(values(4, 8));

    const fresh = new RingBuffer(8);
    expectRangeError(() => fresh.write(seq(0, 1), 0.5));
    expect(fresh.isEmpty).toBe(true);
  });

  test('read returns a fresh copy', () => {
    const rb = new RingBuffer(8);
    rb.write(seq(0, 4), 0);
    const first = rb.read(0, 4);
    first.fill(-1);
    const second = rb.read(0, 4);
    expect(second).not.toBe(first);
    expect(Array.from(second)).toEqual(values(0, 4));
  });

  test('negative frame indices', () => {
    const rb = new RingBuffer(5);
    rb.write(seq(-7, 4), -7);
    rb.write(seq(-3, 4), -3);
    expect(rb.startFrame).toBe(-4);
    expect(rb.endFrame).toBe(1);
    expect(Array.from(rb.read(-4, 1))).toEqual([96, 97, 98, 99, 100]);
  });

  test('zero-length blocks follow the same rules', () => {
    const rb = new RingBuffer(8);
    rb.write(new Float32Array(0), 50);
    expect(rb.isEmpty).toBe(false);
    expect(rb.startFrame).toBe(50);
    expect(rb.endFrame).toBe(50);
    expect(rb.read(50, 50)).toHaveLength(0);
    rb.write(new Float32Array(0), 53);
    expect(rb.gapCount).toBe(1);
    expect(rb.gapFrames).toBe(3);
    expect(rb.endFrame).toBe(53);
    expect(Array.from(rb.read(50, 53))).toEqual([0, 0, 0]);
  });

  test('worklet shape: 12 s at 48 kHz written in 128-frame quanta for 13 s', () => {
    const rb = new RingBuffer(Math.ceil(12 * 48000));
    const quantum = new Float32Array(128);
    for (let q = 0; q < 4875; q++) {
      const start = q * 128;
      for (let i = 0; i < 128; i++) quantum[i] = ((start + i) % 1000) / 1000;
      rb.write(quantum, start);
    }
    expect(rb.capacity).toBe(576000);
    expect(rb.endFrame).toBe(624000);
    expect(rb.startFrame).toBe(48000);
    expect(rb.gapCount).toBe(0);
    const got = rb.read(600000, 610000);
    const expected = Array.from({ length: 10000 }, (_, i) => Math.fround(((600000 + i) % 1000) / 1000));
    expect(Array.from(got)).toEqual(expected);
    expectRangeError(() => rb.read(47999, 48001));
  });
});

// ---- Model-based test (plan §4.9.1) -------------------------------------------------------------------

/** A deliberately naive oracle: every frame ever written (gaps as 0) in a Map, plus start and end. */
interface Model {
  readonly capacity: number;
  readonly frames: Map<number, number>;
  /** Oldest readable frame. NaN while empty. */
  start: number;
  /** One past the newest frame. NaN while empty. */
  end: number;
  gapCount: number;
  gapFrames: number;
}

type RingCommand = Command<Model, RingBuffer>;

const RANGE_ERROR = 'RangeError';

type Rejection = 'non-integer' | 'empty' | 'reversed' | 'evicted' | 'unwritten';

/** What the generator actually exercised, so the property cannot pass vacuously. */
const seen: Record<
  'gapWrites' | 'overlapWrites' | 'evictingWrites' | 'validReads' | 'validReadIntos' | Rejection,
  number
> = {
  gapWrites: 0,
  overlapWrites: 0,
  evictingWrites: 0,
  validReads: 0,
  validReadIntos: 0,
  'non-integer': 0,
  empty: 0,
  reversed: 0,
  evicted: 0,
  unwritten: 0,
};

function emptyModel(capacity: number): Model {
  return {
    capacity,
    frames: new Map(),
    start: Number.NaN,
    end: Number.NaN,
    gapCount: 0,
    gapFrames: 0,
  };
}

function modelWrite(m: Model, block: Float32Array, startFrame: number): 'ok' | 'overlap' {
  if (Number.isNaN(m.end)) {
    m.start = startFrame;
    m.end = startFrame;
  } else if (startFrame < m.end) {
    return 'overlap';
  }
  if (startFrame > m.end) {
    m.gapCount += 1;
    m.gapFrames += startFrame - m.end;
    for (let f = m.end; f < startFrame; f++) m.frames.set(f, 0);
  }
  block.forEach((value, i) => m.frames.set(startFrame + i, value));
  m.end = startFrame + block.length;
  // `end` only grows, so this is max(base, end − capacity).
  m.start = Math.max(m.start, m.end - m.capacity);
  return 'ok';
}

/** Which read rule rejects `[from, to)`, or null when the range is readable. */
function rejection(m: Readonly<Model>, from: number, to: number): Rejection | null {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return 'non-integer';
  if (Number.isNaN(m.end)) return 'empty';
  if (from > to) return 'reversed';
  if (from < m.start) return 'evicted';
  if (to > m.end) return 'unwritten';
  return null;
}

function modelRead(m: Readonly<Model>, from: number, to: number): number[] | typeof RANGE_ERROR {
  const rejected = rejection(m, from, to);
  if (rejected !== null) {
    seen[rejected] += 1;
    return RANGE_ERROR;
  }
  const out: number[] = [];
  for (let f = from; f < to; f++) {
    const value = m.frames.get(f);
    if (value === undefined) throw new Error(`model is missing frame ${f}`);
    out.push(value);
  }
  return out;
}

function attempt<T>(fn: () => T): T | typeof RANGE_ERROR {
  try {
    return fn();
  } catch (error) {
    if (error instanceof RangeError) return RANGE_ERROR;
    throw error;
  }
}

function expectSameState(m: Readonly<Model>, r: RingBuffer): void {
  expect(r.capacity).toBe(m.capacity);
  expect(r.isEmpty).toBe(Number.isNaN(m.end));
  expect(r.startFrame).toBe(m.start);
  expect(r.endFrame).toBe(m.end);
  expect(r.gapCount).toBe(m.gapCount);
  expect(r.gapFrames).toBe(m.gapFrames);
}

function expectSameContents(m: Readonly<Model>, r: RingBuffer): void {
  expectSameState(m, r);
  if (!Number.isNaN(m.end)) expect(Array.from(r.read(m.start, m.end))).toEqual(modelRead(m, m.start, m.end));
}

function writeAndCompare(m: Model, r: RingBuffer, block: Float32Array, startFrame: number): void {
  const startBefore = m.start;
  r.write(block, startFrame);
  expect(modelWrite(m, block, startFrame)).toBe('ok');
  if (m.start > startBefore) seen.evictingWrites += 1;
  expectSameContents(m, r);
}

function command(
  name: string,
  check: (m: Readonly<Model>) => boolean,
  run: (m: Model, r: RingBuffer) => void,
): RingCommand {
  return { check, run, toString: () => name };
}

interface RangeSpec {
  anchor: 'start' | 'end';
  offset: number;
  length: number;
  /** Fold the range into [start, end], so it is valid whenever the buffer is not empty. */
  clamp: boolean;
  /** Make one index non-integer (only when not clamped). */
  fraction: boolean;
}

/** Integer `from` and `length` for a spec against the model's current state (anchored at 0 while empty). */
function resolveRange(m: Readonly<Model>, s: RangeSpec): { from: number; length: number } {
  if (Number.isNaN(m.end)) return { from: s.offset, length: s.length };
  if (s.clamp) {
    const from = m.start + (Math.abs(s.offset) % (m.end - m.start + 1));
    return { from, length: Math.abs(s.length) % (m.end - from + 1) };
  }
  return { from: (s.anchor === 'start' ? m.start : m.end) + s.offset, length: s.length };
}

function rangeSpec(capacity: number, minLength: number): Arbitrary<RangeSpec> {
  return fc.record({
    anchor: fc.constantFrom<'start' | 'end'>('start', 'end'),
    offset: fc.integer({ min: -(capacity + 2), max: capacity + 2 }),
    length: fc.integer({ min: minLength, max: capacity + 2 }),
    clamp: fc.boolean(),
    fraction: fc.oneof(
      { arbitrary: fc.constant(false), weight: 9 },
      { arbitrary: fc.constant(true), weight: 1 },
    ),
  });
}

function commandArbitraries(capacity: number): Arbitrary<RingCommand>[] {
  const block = (minLength: number) => fc.float32Array({ minLength, maxLength: 2 * capacity });
  const distance = fc.integer({ min: 1, max: 2 * capacity });
  const base = fc.oneof(
    fc.constant(0),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.integer({ min: 2 ** 52, max: 2 ** 53 - 2 ** 24 }),
  );
  return [
    fc.tuple(block(1), base).map(([samples, first]) =>
      command(
        `ContiguousWrite(n=${samples.length}, base=${first})`,
        () => true,
        (m, r) => writeAndCompare(m, r, samples, Number.isNaN(m.end) ? first : m.end),
      ),
    ),
    fc.tuple(distance, block(0)).map(([gap, samples]) =>
      command(
        `GapWrite(gap=${gap}, n=${samples.length})`,
        (m) => !Number.isNaN(m.end),
        (m, r) => {
          seen.gapWrites += 1;
          writeAndCompare(m, r, samples, m.end + gap);
        },
      ),
    ),
    fc.tuple(distance, block(1)).map(([back, samples]) =>
      command(
        `OverlapWrite(back=${back}, n=${samples.length})`,
        (m) => !Number.isNaN(m.end),
        (m, r) => {
          seen.overlapWrites += 1;
          const startFrame = m.end - back;
          expectRangeError(() => r.write(samples, startFrame), 'overlap');
          expect(modelWrite(m, samples, startFrame)).toBe('overlap');
          expectSameContents(m, r);
        },
      ),
    ),
    rangeSpec(capacity, -2).map((s) =>
      command(
        `Read(${JSON.stringify(s)})`,
        () => true,
        (m, r) => {
          const { from: first, length } = resolveRange(m, s);
          let from = first;
          let to = first + length;
          if (!s.clamp && s.fraction) {
            if (s.offset % 2 === 0) from += 0.5;
            else to += 0.5;
          }
          const expected = modelRead(m, from, to);
          if (expected !== RANGE_ERROR) seen.validReads += 1;
          expect(attempt(() => Array.from(r.read(from, to)))).toEqual(expected);
          expectSameState(m, r);
        },
      ),
    ),
    rangeSpec(capacity, 0).map((s) =>
      command(
        `ReadInto(${JSON.stringify(s)})`,
        () => true,
        (m, r) => {
          const { from: first, length } = resolveRange(m, s);
          const from = !s.clamp && s.fraction ? first + 0.5 : first;
          const out = new Float32Array(length).fill(-7);
          const expected = modelRead(m, from, from + length);
          const result = attempt(() => r.readInto(from, out));
          if (expected === RANGE_ERROR) {
            expect(result).toBe(RANGE_ERROR);
            expect(Array.from(out)).toEqual(Array.from({ length }, () => -7));
          } else {
            seen.validReadIntos += 1;
            expect(result).toBeUndefined();
            expect(Array.from(out)).toEqual(expected);
          }
          expectSameState(m, r);
        },
      ),
    ),
  ];
}

describe('RingBuffer model', () => {
  test('random writes, gaps, overlaps and reads match a Map model', () => {
    const scenario = fc
      .integer({ min: 1, max: 300 })
      .chain((capacity) =>
        fc.tuple(
          fc.constant(capacity),
          fc.commands(commandArbitraries(capacity), { maxCommands: 60, size: 'max' }),
        ),
      );
    fc.assert(
      fc.property(scenario, ([capacity, commands]) => {
        fc.modelRun(() => ({ model: emptyModel(capacity), real: new RingBuffer(capacity) }), commands);
      }),
      { numRuns: 300 },
    );
    for (const [what, count] of Object.entries(seen)) expect(count, what).toBeGreaterThan(0);
  });
});
