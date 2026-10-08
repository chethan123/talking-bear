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

/** Slot of `Stepper.io` that `run` reads: the frame time to add, in seconds (`advance`'s `frameDt`). */
export const IO_FRAME_DT = 0;
/** Slot of `Stepper.io` that `run` writes: alpha (`advance`'s return value). */
export const IO_ALPHA = 1;

export class Stepper {
  /**
   * Simulated time owed to the physics, in seconds; always in [0, SUBSTEP − STEP_EPS). A one-slot
   * `Float64Array`, not a class field: V8's mid tier boxes a double written to a class field as a new heap number
   * on every write (#214).
   */
  readonly #acc = new Float64Array(1);

  /**
   * `run`'s input and output, by slot (`IO_FRAME_DT`, `IO_ALPHA`): the frame loop's doubles cross into the stepper
   * and back through these slots rather than as an argument and a return value, which V8's mid tier boxes as a new
   * heap number at a call it doesn't inline (#229).
   */
  readonly io = new Float64Array(2);

  /**
   * Adds one frame's time and runs as many whole `SUBSTEP`s as are due, at most `MAX_SUBSTEPS`.
   *
   * - `frameDt` is clamped to [0, `MAX_FRAME_DT`]; a negative or NaN frame counts as 0.
   * - If the budget is exceeded, the remainder is dropped (the accumulator is reset to 0).
   *
   * Returns alpha = accumulator / `SUBSTEP`, in [0, 1): how far the render time is past the last substep.
   * It is `run` with `frameDt` in `io[IO_FRAME_DT]` and alpha read back from `io[IO_ALPHA]`. Allocates nothing
   * itself; a caller V8 doesn't inline it into boxes `frameDt` and the alpha, so the frame loop calls `run`.
   */
  advance(frameDt: number, step: (dt: number) => void): number {
    const io = this.io;
    io[IO_FRAME_DT] = frameDt;
    this.run(step);
    return io[IO_ALPHA]!;
  }

  /**
   * `advance(io[IO_FRAME_DT], step)`, with alpha written to `io[IO_ALPHA]` instead of returned: no double crosses
   * the call. Never allocates.
   */
  run(step: (dt: number) => void): void {
    const io = this.io;
    const frameDt = io[IO_FRAME_DT]!;
    // acc + min(frameDt, MAX_FRAME_DT) for frameDt > 0, written out as branches: where V8 doesn't inline Math.min,
    // it boxes the arguments, and a `?:` mixing this double with a module constant can stay a tagged value that boxes
    // the double on every call (an imported constant does in both tiers, measured; #229). Otherwise nothing is
    // added: the accumulator is never −0, so that equals adding 0.
    let acc = this.#acc[0]!;
    if (frameDt > 0) {
      if (frameDt < MAX_FRAME_DT) acc += frameDt;
      else acc += MAX_FRAME_DT;
    }
    let substeps = 0;
    while (substeps < MAX_SUBSTEPS && acc >= SUBSTEP - STEP_EPS) {
      step(SUBSTEP);
      acc -= SUBSTEP;
      substeps++;
    }
    // A negative residue is rounding from the tolerance; a residue of a whole substep is over budget.
    if (acc < 0 || acc >= SUBSTEP - STEP_EPS) acc = 0;
    this.#acc[0] = acc;
    io[IO_ALPHA] = acc / SUBSTEP;
  }
}
