// Test-only output tap `test-tap` (plan §4.9.3, issue #36): an AudioWorkletProcessor that the e2e test hooks
// (src/test-hooks.ts) insert between the master bus's last node and `destination`. It passes its input through
// unchanged and posts the mono mix of its input (the mean of its channels) to the main thread, in blocks of
// BLOCK frames. A render quantum without an active input counts as silence, so the posted stream is contiguous
// in context time from the first quantum the node renders. The last block is posted only once it is full.
//
// Loaded only from the e2e build (`VITE_BEAR_TEST_HOOKS=1`): nothing in the production graph imports it.
// Render-thread rules: process() never throws and allocates only the block it transfers (a new block after
// each posted one); the transfer list is preallocated and reused.

/** Frames per posted block: 8 render quanta at Chrome's default quantum of 128 frames. */
export const BLOCK = 1024;
/** Frames in a quantum whose input and output have no channels at all (Chrome's default quantum size). */
const QUANTUM = 128;
const NO_CHANNELS: readonly Float32Array[] = [];

class TestTapProcessor extends AudioWorkletProcessor implements AudioWorkletProcessorImpl {
  #block = new Float32Array(BLOCK);
  #fill = 0;
  readonly #transfer: Transferable[] = [this.#block.buffer];

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? NO_CHANNELS;
    const output = outputs[0] ?? NO_CHANNELS;
    // Pass-through. The node's output channel count follows its input's; an output channel without an input
    // channel keeps the zeros the render thread filled it with.
    for (let c = 0; c < output.length; c++) {
      const src = input[c];
      if (src !== undefined) output[c]!.set(src);
    }
    const channels = input.length;
    const frames = input[0]?.length ?? output[0]?.length ?? QUANTUM;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += input[c]![i]!;
      this.#block[this.#fill++] = channels > 0 ? sum / channels : 0;
      if (this.#fill === BLOCK) this.#post();
    }
    return true;
  }

  /** Transfers the full block to the main thread and starts a new one. */
  #post(): void {
    this.#transfer[0] = this.#block.buffer;
    this.port.postMessage(this.#block, this.#transfer);
    this.#block = new Float32Array(BLOCK); // allocation: replaces the transferred block
    this.#fill = 0;
  }
}

registerProcessor('test-tap', TestTapProcessor);
