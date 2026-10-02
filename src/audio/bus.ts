/** Gain of the master bus that voice and sfx share before `destination` (plan §4.3.4). */
const MASTER_GAIN = 0.7;
/** Quiet mode takes another −6 dB for every route (plan §4.3.4): 10^(−6/20) ≈ 0.501. */
const QUIET_GAIN = 10 ** (-6 / 20);
/** Time constant of the Quiet gain's `setTargetAtTime` ramp, in seconds, so a toggle never clicks. */
const QUIET_TAU_SEC = 0.02;

export interface MasterBus {
  /** Voice and sfx connect here: the 0.7 master gain. */
  input: GainNode;
  /**
   * The bus's last node, the only one connected to `ctx.destination`: the Quiet gain, in series after `input`.
   * Anything that taps the final signal (the e2e output tap) connects after `output`.
   */
  output: AudioNode;
  /**
   * Quiet mode (plan §4.3.4). Ramps the Quiet gain to 10^(−6/20) (on) or 1 (off) with `setTargetAtTime`, from
   * the context's current time, τ = 20 ms.
   */
  setQuiet(on: boolean): void;
}

/**
 * The master output bus: voice and sfx → 0.7 gain → Quiet gain → `destination`. The Quiet gain starts at
 * 10^(−6/20) when `quiet` is true (the default: Quiet mode is on by default, plan §4.3.4), else at 1, with no ramp.
 */
export function createMasterBus(ctx: BaseAudioContext, quiet = true): MasterBus {
  const input = new GainNode(ctx, { gain: MASTER_GAIN });
  const quietNode = new GainNode(ctx, { gain: quiet ? QUIET_GAIN : 1 });
  input.connect(quietNode);
  quietNode.connect(ctx.destination);
  return {
    input,
    output: quietNode,
    setQuiet(on: boolean): void {
      quietNode.gain.setTargetAtTime(on ? QUIET_GAIN : 1, ctx.currentTime, QUIET_TAU_SEC);
    },
  };
}
