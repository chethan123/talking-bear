/**
 * Fixed-step accumulator for the frame loop (plan §4.6.6): the physics runs at 120 Hz whatever the display
 * rate, and the renderer interpolates between the last two physics states with the returned alpha.
 */

/** Physics substep: 1/120 s. */
export const SUBSTEP = 1 / 120;
/** Longest frame the loop accepts; longer frames (a stall, a hidden tab) are clamped to this. */
export const MAX_FRAME_DT = 0.05;
/** Substep budget per frame: 0.05 / (1/120) = 6. */
export const MAX_SUBSTEPS = 6;

/**
 * Defensive tolerance for the substep comparison, in seconds (1.2e-7 of a substep). The accumulator is
 * built by repeatedly adding frame times and subtracting `SUBSTEP` in doubles; no case is known where an
 * exact comparison makes a 50 ms frame miss its 6th substep, but a residue a few ulps short of `SUBSTEP`
 * still runs that substep. With the reset in `advance`, it also keeps alpha below 1.
 */
const STEP_EPS = 1e-9;

export class Stepper {
  /** Simulated time owed to the physics, in seconds; always in [0, SUBSTEP − STEP_EPS). */
  #acc = 0;

  /**
   * Adds one frame's time and runs as many whole `SUBSTEP`s as are due, at most `MAX_SUBSTEPS`.
   *
   * - `frameDt` is clamped to [0, `MAX_FRAME_DT`]; a negative or NaN frame counts as 0.
   * - If the budget is exceeded, the remainder is dropped (the accumulator is reset to 0).
   *
   * Returns alpha = accumulator / `SUBSTEP`, in [0, 1): how far the render time is past the last substep.
   * Never allocates.
   */
  advance(frameDt: number, step: (dt: number) => void): number {
    let acc = this.#acc + (frameDt > 0 ? Math.min(frameDt, MAX_FRAME_DT) : 0);
    let substeps = 0;
    while (substeps < MAX_SUBSTEPS && acc >= SUBSTEP - STEP_EPS) {
      step(SUBSTEP);
      acc -= SUBSTEP;
      substeps++;
    }
    // A negative residue is rounding from the tolerance; a residue of a whole substep is over budget.
    if (acc < 0 || acc >= SUBSTEP - STEP_EPS) acc = 0;
    this.#acc = acc;
    return acc / SUBSTEP;
  }
}
