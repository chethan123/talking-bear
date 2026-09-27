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
