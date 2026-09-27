import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SpringBank } from './springs.ts';

/** The app's physics substep (plan §4.6.6): 1/120 s. */
const DT = 1 / 120;
const TAU = 2 * Math.PI;

/** E = ½v² + ½k·(x − target)² of spring `i`. */
function energy(bank: SpringBank, i: number, k: number): number {
  const x = bank.pos[i]! - bank.target[i]!;
  const v = bank.vel[i]!;
  return 0.5 * v * v + 0.5 * k * x * x;
}

/**
 * Decay rate of the slowest mode of the continuous spring: σ = ω·(ζ − √max(0, ζ² − 1)), which is ζω
 * for ζ ≤ 1.
 */
function slowestRate(omega: number, zeta: number): number {
  return omega * (zeta - Math.sqrt(Math.max(0, zeta * zeta - 1)));
}

/** Position and velocity of spring `i`. */
function state(bank: SpringBank, i = 0): { x: number; v: number } {
  return { x: bank.pos[i]!, v: bank.vel[i]! };
}

/** |actual − expected| ≤ 1e-6·max(1, |expected|): float32 state, float64 expectation. */
function expectClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(expected)));
}

function expectRangeError(fn: () => unknown): void {
  expect(fn).toThrow(RangeError);
}

describe('SpringBank', () => {
  it('preallocates target, pos and vel of length count, all 0', () => {
    const bank = new SpringBank(3);
    for (const array of [bank.target, bank.pos, bank.vel]) {
      expect(array).toBeInstanceOf(Float32Array);
      expect(Array.from(array)).toEqual([0, 0, 0]);
    }
    expect(new SpringBank(0).pos).toHaveLength(0);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects count %s', (count) => {
    expectRangeError(() => new SpringBank(count));
  });

  it.each<[string, number, number, number]>([
    ['index −1', -1, 2, 0.5],
    ['index = count', 2, 2, 0.5],
    ['a fractional index', 0.5, 2, 0.5],
    ['a negative frequency', 0, -1, 0.5],
    ['a NaN frequency', 0, Number.NaN, 0.5],
    ['an infinite frequency', 0, Number.POSITIVE_INFINITY, 0.5],
    ['a negative zeta', 0, 2, -0.1],
    ['a NaN zeta', 0, 2, Number.NaN],
  ])('set rejects %s', (_name, i, freqHz, zeta) => {
    expectRangeError(() => new SpringBank(2).set(i, freqHz, zeta));
  });

  it('one step pins k = (2πf)²: from x = 1, v = 0 towards 0, v = −k·dt and x = 1 − k·dt²', () => {
    const f = 3;
    const k = (TAU * f) ** 2;
    const bank = new SpringBank(1);
    bank.set(0, f, 0.5);
    bank.pos[0] = 1;
    bank.step(DT);
    expectClose(state(bank).v, -k * DT);
    expectClose(state(bank).x, 1 - k * DT * DT);
  });

  it('one step pins c = 2ζ·2πf: from x = 0, v = 1 at the target, v = 1 − c·dt and x = v·dt', () => {
    const f = 3;
    const zeta = 0.5;
    const c = 2 * zeta * TAU * f;
    const bank = new SpringBank(1);
    bank.set(0, f, zeta);
    bank.vel[0] = 1;
    bank.step(DT);
    expectClose(state(bank).v, 1 - c * DT);
    expectClose(state(bank).x, (1 - c * DT) * DT);
  });

  it('pulls towards target: at rest on the target it stays; displaced from it, it moves back', () => {
    const k = (TAU * 3) ** 2;
    const bank = new SpringBank(2);
    bank.set(0, 3, 0.5);
    bank.set(1, 3, 0.5);
    bank.target[0] = 2;
    bank.pos[0] = 2;
    bank.target[1] = 2;
    bank.pos[1] = 3;
    bank.step(DT);
    expect(bank.pos[0]).toBe(2);
    expect(bank.vel[0]).toBe(0);
    expectClose(state(bank, 1).v, -k * DT);
    expectClose(state(bank, 1).x, 3 - k * DT * DT);
  });

  it('impulse adds dv to the velocity of that spring only', () => {
    const bank = new SpringBank(3);
    bank.impulse(1, 2.5);
    bank.impulse(1, -1);
    expect(Array.from(bank.vel)).toEqual([0, 1.5, 0]);
  });

  it('step advances every spring, each with its own constants', () => {
    const params: [number, number][] = [
      [0.5, 0.3],
      [4, 0.8],
      [10, 1.2],
    ];
    const bank = new SpringBank(params.length);
    const singles = params.map(([f, zeta], i) => {
      bank.set(i, f, zeta);
      bank.pos[i] = i + 1;
      bank.impulse(i, -i);
      const single = new SpringBank(1);
      single.set(0, f, zeta);
      single.pos[0] = i + 1;
      single.impulse(0, -i);
      return single;
    });
    for (let n = 0; n < 50; n++) {
      bank.step(DT);
      for (const single of singles) single.step(DT);
    }
    expect(Array.from(bank.pos)).toEqual(singles.map((s) => s.pos[0]));
    expect(Array.from(bank.vel)).toEqual(singles.map((s) => s.vel[0]));
    expect(bank.pos[2]).not.toBe(bank.pos[1]);
  });

  it('a spring that was never set holds its position, and drifts after an impulse', () => {
    const bank = new SpringBank(1);
    bank.pos[0] = 1;
    bank.step(DT);
    expect(bank.pos[0]).toBe(1);
    bank.impulse(0, 1);
    bank.step(DT);
    expectClose(state(bank).x, 1 + DT);
    expect(bank.vel[0]).toBe(1);
  });

  it('step keeps the preallocated state arrays', () => {
    const bank = new SpringBank(2);
    const arrays = [bank.target, bank.pos, bank.vel];
    bank.set(0, 2, 0.8);
    bank.impulse(0, 1);
    for (let n = 0; n < 10; n++) bank.step(DT);
    expect([bank.target, bank.pos, bank.vel]).toEqual(arrays);
    expect(bank.target).toBe(arrays[0]);
    expect(bank.pos).toBe(arrays[1]);
    expect(bank.vel).toBe(arrays[2]);
  });
});

describe('spring stability at the actual substep dt = 1/120 (plan §7 M4)', () => {
  const impulse = fc.record({
    step: fc.integer({ min: 0, max: 240 }),
    dv: fc.double({ min: 0.05, max: 5, noNaN: true }),
    negative: fc.boolean(),
  });

  it('after random impulses, energy stays ≤ 1.3·E0 and falls to ≤ 1e-3·E0 by t_last + 8/σ', () => {
    // E0 is E right after the last impulse. The decay horizon uses the slowest mode's rate σ, not ζω
    // (ORCH-ANSWER on #74: ζω is not the slowest rate for ζ ≳ 0.93). Runs whose E0 is below 1e-4 are
    // discarded: the float32 state quantizes E at about 1e-10, so their ratio says nothing about damping.
    // fast-check prints the seed and the counterexample path when a run fails.
    fc.assert(
      fc.property(
        fc.double({ min: 0.5, max: 10, noNaN: true }),
        fc.double({ min: 0.3, max: 1.2, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.array(impulse, { minLength: 1, maxLength: 4 }),
        (f, zeta, target, offset, impulses) => {
          const omega = TAU * f;
          const k = omega * omega;
          const bank = new SpringBank(1);
          bank.set(0, f, zeta);
          bank.target[0] = target;
          bank.pos[0] = target + offset;

          const schedule = impulses.toSorted((p, q) => p.step - q.step);
          const lastStep = schedule.at(-1)!.step;
          let next = 0;
          for (let s = 0; s <= lastStep; s++) {
            for (; next < schedule.length && schedule[next]!.step === s; next++) {
              const { dv, negative } = schedule[next]!;
              bank.impulse(0, negative ? -dv : dv);
            }
            if (s < lastStep) bank.step(DT);
          }

          const e0 = energy(bank, 0, k);
          fc.pre(e0 >= 1e-4);
          const horizon = Math.ceil(8 / slowestRate(omega, zeta) / DT);
          let maxE = e0;
          for (let n = 0; n < horizon; n++) {
            bank.step(DT);
            maxE = Math.max(maxE, energy(bank, 0, k));
          }
          expect(maxE).toBeLessThanOrEqual(1.3 * e0);
          expect(energy(bank, 0, k)).toBeLessThanOrEqual(1e-3 * e0);
        },
      ),
      { numRuns: 1000, seed: 0x7063 },
    );
  });
});

describe('negative example: semi-implicit Euler is unstable for ω·dt > 2 (plan §7 M4)', () => {
  const f = 10;
  const k = (TAU * f) ** 2;

  it('a 10 Hz spring has ω·dt ≈ 2.09 at dt = 1/30, but ω·dt ≈ 0.52 at dt = 1/120', () => {
    expect((TAU * f) / 30).toBeCloseTo(2.094, 3);
    expect((TAU * f) / 120).toBeCloseTo(0.524, 3);
  });

  it.each([0, 0.3, 0.5, 0.8, 1, 1.2])(
    'ζ = %s at dt = 1/30: energy grows without bound within 200 steps',
    (zeta) => {
      const bank = new SpringBank(1);
      bank.set(0, f, zeta);
      bank.pos[0] = 1;
      const e0 = energy(bank, 0, k);
      let blowUpStep = 0;
      for (let n = 1; n <= 200 && blowUpStep === 0; n++) {
        bank.step(1 / 30);
        const e = energy(bank, 0, k);
        // Not ≤ also catches the Infinity and NaN that float32 overflow ends in.
        if (!(e <= 1e20 * e0)) blowUpStep = n;
      }
      expect(blowUpStep).toBeGreaterThan(0);
    },
  );

  it.each([0.3, 0.5, 0.8, 1, 1.2])('ζ = %s at dt = 1/120: the same spring decays', (zeta) => {
    const bank = new SpringBank(1);
    bank.set(0, f, zeta);
    bank.pos[0] = 1;
    const e0 = energy(bank, 0, k);
    for (let n = 0; n < 200; n++) bank.step(DT);
    expect(energy(bank, 0, k)).toBeLessThanOrEqual(1e-3 * e0);
  });
});
