/** Gain of the master bus that voice and sfx share before `destination` (plan §4.3.4). */
const MASTER_GAIN = 0.7;

export interface MasterBus {
  /** Voice and sfx connect here: the 0.7 master gain. */
  input: GainNode;
  /**
   * The bus's last node, the only one connected to `ctx.destination`. In M1 it is `input` itself; M3
   * adds the Quiet gain in series and makes it `output`. Anything that taps the final signal connects
   * after `output`.
   */
  output: AudioNode;
  /** Quiet mode (plan §4.3.4). A no-op in M1; M3 implements it. */
  setQuiet(on: boolean): void;
}

/** The master output bus: voice and sfx → 0.7 gain → `destination`. */
export function createMasterBus(ctx: BaseAudioContext): MasterBus {
  const input = new GainNode(ctx, { gain: MASTER_GAIN });
  input.connect(ctx.destination);
  return {
    input,
    output: input,
    setQuiet: (_on: boolean): void => {
      // M3 implements Quiet mode.
    },
  };
}
