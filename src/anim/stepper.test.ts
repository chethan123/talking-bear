import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Ch, createPose, lerpPose } from './pose.ts';
import { IO_ALPHA, IO_FRAME_DT, MAX_FRAME_DT, MAX_SUBSTEPS, SUBSTEP, Stepper } from './stepper.ts';

interface Frame {
  substeps: number;
  alpha: number;
}

/** Advances `stepper` by one frame and reports the substeps it ran (checking each one's dt) and the alpha. */
function frame(stepper: Stepper, frameDt: number): Frame {
  let substeps = 0;
  const alpha = stepper.advance(frameDt, (dt) => {
    expect(dt).toBe(SUBSTEP);
    substeps++;
  });
  return { substeps, alpha };
}

function expectAlphaInRange(alpha: number): void {
  expect(alpha).toBeGreaterThanOrEqual(0);
  expect(alpha).toBeLessThan(1);
}

/** The frame dt the stepper accounts for after its clamp. */
function clamped(frameDt: number): number {
  return frameDt > 0 ? Math.min(frameDt, MAX_FRAME_DT) : 0;
}

/** Frame dts that mix display rates, sub-substep frames, catch-up frames and stalls beyond the clamp. */
const frameDt = fc.oneof(
  fc.constantFrom(0, 0.001, 1 / 240, 1 / 144, SUBSTEP, 1 / 90, 1 / 60, 0.01667, 1 / 30, MAX_FRAME_DT, 0.2, 1),
  fc.double({ min: 0, max: 0.3, noNaN: true }),
);

/** A monotone target ramp: strictly increasing, and not linear, so the check doesn't rely on linearity. */
function ramp(t: number): number {
  return 2 * t + t * t;
}

/**
 * Runs `frames` over a physics state that follows a monotone target ramp, keeping the state before and
 * after the last substep (`prev`, `cur`) as the loop does, and renders `prev + (cur − prev)·alpha` both as a
 * number and through `lerpPose` on a pose channel.
 */
function rampRun(frames: readonly number[]): { frames: Frame[]; rendered: number[]; renderedPose: number[] } {
  const stepper = new Stepper();
  let t = 0;
  let prev = 0;
  let cur = 0;
  const prevPose = createPose();
  const curPose = createPose();
  const outPose = createPose();
  const out = { frames: [] as Frame[], rendered: [] as number[], renderedPose: [] as number[] };
  for (const dt of frames) {
    let substeps = 0;
    const alpha = stepper.advance(dt, (h) => {
      t += h;
      prev = cur;
      cur = ramp(t);
      prevPose.set(curPose);
      curPose[Ch.HeadX] = cur;
      substeps++;
    });
    out.frames.push({ substeps, alpha });
    out.rendered.push(prev + (cur - prev) * alpha);
    out.renderedPose.push(lerpPose(prevPose, curPose, alpha, outPose)[Ch.HeadX]!);
  }
  return out;
}

function expectNonDecreasing(values: readonly number[]): void {
  for (let i = 1; i < values.length; i++) {
    if (!(values[i]! >= values[i - 1]!)) {
      expect.fail(`not monotone at frame ${i}: ${values[i - 1]} then ${values[i]}`);
    }
  }
}

describe('Stepper constants', () => {
  it('are 1/120 s substeps, a 50 ms frame clamp and a budget of 6 substeps', () => {
    expect(SUBSTEP).toBe(1 / 120);
    expect(MAX_FRAME_DT).toBe(0.05);
    expect(MAX_SUBSTEPS).toBe(6);
    expect(MAX_FRAME_DT / SUBSTEP).toBeCloseTo(MAX_SUBSTEPS, 12);
  });
});

describe('Stepper.advance', () => {
  it('runs 6 substeps of SUBSTEP for a 50 ms frame', () => {
    const { substeps, alpha } = frame(new Stepper(), 0.05);
    expect(substeps).toBe(6);
    expect(alpha).toBeCloseTo(0, 9);
    expectAlphaInRange(alpha);
  });

  it('runs exactly 6 substeps for a 50 ms frame whatever phase earlier frames left', () => {
    fc.assert(
      fc.property(fc.array(frameDt, { maxLength: 40 }), (earlier) => {
        const stepper = new Stepper();
        for (const dt of earlier) frame(stepper, dt);
        const { substeps, alpha } = frame(stepper, 0.05);
        expect(substeps).toBe(6);
        expectAlphaInRange(alpha);
      }),
      { numRuns: 500, seed: 0x7063 },
    );
  });

  it('clamps a 0.2 s frame to 0.05 s: 6 substeps, and none of the excess is carried', () => {
    const clampedStepper = new Stepper();
    const reference = new Stepper();
    for (const dt of [0.004, 0.01667, 0.011]) {
      frame(clampedStepper, dt);
      frame(reference, dt);
    }
    const long = frame(clampedStepper, 0.2);
    const short = frame(reference, 0.05);
    expect(long.substeps).toBe(6);
    expect(long).toEqual(short);
    for (let i = 0; i < 20; i++) expect(frame(clampedStepper, 0.01667)).toEqual(frame(reference, 0.01667));
    expect(frame(new Stepper(), 0.2).substeps).toBe(6);
  });

  it('accumulates frames shorter than a substep', () => {
    const stepper = new Stepper();
    const a = frame(stepper, SUBSTEP / 3);
    const b = frame(stepper, SUBSTEP / 3);
    const c = frame(stepper, SUBSTEP / 2);
    expect([a.substeps, b.substeps, c.substeps]).toEqual([0, 0, 1]);
    expect(a.alpha).toBeCloseTo(1 / 3, 9);
    expect(b.alpha).toBeCloseTo(2 / 3, 9);
    expect(c.alpha).toBeCloseTo(1 / 6, 9);
  });

  it('counts a negative or NaN frame as 0 and clamps an infinite one', () => {
    const stepper = new Stepper();
    const { alpha } = frame(stepper, 0.004);
    expect(frame(stepper, -0.01)).toEqual({ substeps: 0, alpha });
    expect(frame(stepper, Number.NaN)).toEqual({ substeps: 0, alpha });
    expect(frame(stepper, Number.POSITIVE_INFINITY).substeps).toBe(6);
  });

  it('keeps alpha in [0, 1) over constant 16.67 ms frames, with 2 or 3 substeps each and no drift', () => {
    const stepper = new Stepper();
    let total = 0;
    let substeps = 0;
    for (let i = 0; i < 10_000; i++) {
      const f = frame(stepper, 0.01667);
      expectAlphaInRange(f.alpha);
      expect([2, 3]).toContain(f.substeps);
      total += 0.01667;
      substeps += f.substeps;
      expect(Math.abs((substeps + f.alpha) * SUBSTEP - total)).toBeLessThan(1e-6);
    }
  });

  it('keeps the render interpolation monotone over a monotone target ramp, through catch-up frames', () => {
    const frames = [
      ...Array.from({ length: 10 }, () => 0.01667),
      0.05, // catch-up: 6 substeps
      0.003,
      0.003, // shorter than a substep: interpolation only
      0.2, // a stall, clamped to 0.05: 6 substeps
      ...Array.from({ length: 5 }, () => 1 / 30), // 4 substeps each
      0.001,
      0.05,
      0.05,
      ...Array.from({ length: 10 }, () => 1 / 144),
    ];
    const run = rampRun(frames);
    const substeps = run.frames.map((f) => f.substeps);
    expect(Math.max(...substeps)).toBe(MAX_SUBSTEPS);
    expect(substeps).toContain(0);
    for (const f of run.frames) expectAlphaInRange(f.alpha);
    expectNonDecreasing(run.rendered);
    expectNonDecreasing(run.renderedPose);
  });

  it('property: ≤ 6 substeps a frame, alpha in [0, 1), time conserved, interpolation monotone', () => {
    fc.assert(
      fc.property(fc.array(frameDt, { minLength: 1, maxLength: 200 }), (frames) => {
        const run = rampRun(frames);
        let simulated = 0;
        let wall = 0;
        run.frames.forEach((f, i) => {
          const dt = clamped(frames[i]!);
          expect(f.substeps).toBeLessThanOrEqual(MAX_SUBSTEPS);
          if (dt === MAX_FRAME_DT) expect(f.substeps).toBe(MAX_SUBSTEPS);
          expectAlphaInRange(f.alpha);
          simulated += f.substeps * SUBSTEP;
          wall += dt;
          // Nothing is dropped below the clamp: substeps plus alpha account for every clamped second.
          expect(Math.abs(simulated + f.alpha * SUBSTEP - wall)).toBeLessThanOrEqual(2e-9 * (i + 1));
        });
        expectNonDecreasing(run.rendered);
        expectNonDecreasing(run.renderedPose);
      }),
      { numRuns: 500, seed: 0x7063 },
    );
  });
});

/** stepper.ts's private `STEP_EPS`, copied with the reference. */
const STEP_EPS_REF = 1e-9;

/** A stepper with main's `advance` (0b2a413) verbatim (its `frameDt` renamed `dt`), before #229: the reference `run` and `advance` must match. */
class ReferenceStepper {
  readonly #acc = new Float64Array(1);

  advance(dt: number, step: (dt: number) => void): number {
    // min(dt, MAX_FRAME_DT), written out: where V8 doesn't inline Math.min, it boxes the arguments.
    let acc = this.#acc[0]! + (dt > 0 ? (dt < MAX_FRAME_DT ? dt : MAX_FRAME_DT) : 0);
    let substeps = 0;
    while (substeps < MAX_SUBSTEPS && acc >= SUBSTEP - STEP_EPS_REF) {
      step(SUBSTEP);
      acc -= SUBSTEP;
      substeps++;
    }
    // A negative residue is rounding from the tolerance; a residue of a whole substep is over budget.
    if (acc < 0 || acc >= SUBSTEP - STEP_EPS_REF) acc = 0;
    this.#acc[0] = acc;
    return acc / SUBSTEP;
  }
}
describe("Stepper.run and Stepper.advance against main's advance (#229)", () => {
  it('both match the reference bit for bit, frame after frame: alpha (Object.is) and substeps', () => {
    const special = fc.constantFrom(
      -1,
      -0,
      0,
      1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      Number.MAX_VALUE,
      1e308,
      1e9,
      MAX_FRAME_DT,
      MAX_FRAME_DT - 2 ** -57,
      MAX_FRAME_DT + 2 ** -57,
      SUBSTEP - STEP_EPS_REF,
    );
    fc.assert(
      fc.property(
        fc.array(fc.oneof(frameDt, special, fc.double()), { minLength: 1, maxLength: 200 }),
        (frames) => {
          const reference = new ReferenceStepper();
          const viaAdvance = new Stepper();
          const viaRun = new Stepper();
          for (const dt of frames) {
            let expectedSubsteps = 0;
            const expected = reference.advance(dt, () => {
              expectedSubsteps++;
            });
            const a = frame(viaAdvance, dt);
            let substeps = 0;
            viaRun.io[IO_FRAME_DT] = dt;
            viaRun.run((h) => {
              expect(h).toBe(SUBSTEP);
              substeps++;
            });
            expect(a.substeps).toBe(expectedSubsteps);
            expect(substeps).toBe(expectedSubsteps);
            expect(Object.is(a.alpha, expected), `advance alpha at dt ${dt}`).toBe(true);
            expect(Object.is(viaRun.io[IO_ALPHA], expected), `run alpha at dt ${dt}`).toBe(true);
          }
        },
      ),
      { numRuns: 500, seed: 0x7063 },
    );
  });
});
