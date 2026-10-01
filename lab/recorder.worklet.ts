// Lab-only recorder AudioWorklet processor `lab-recorder` (lab/routing, plan §5 X-E1/X-E2). Every 128-frame
// render quantum it copies its mono input (the node down-mixes with channelCount 1, 'explicit') into a new
// block and transfers it to the main thread, which fills its preallocated in-memory buffer. It keeps no audio
// itself and its output is silence. A 'stop' message from the main thread ends it: process() then returns
// false, so the disconnected node can be garbage-collected. Lab-only: the app's capture worklet is
// src/audio/capture.worklet.ts.
//
// Render-thread rules: process() never throws; the only allocation is the block it transfers each quantum.

class LabRecorder extends AudioWorkletProcessor {
  #stopped = false;
  /** Reused transfer list (as in the capture worklet), so a quantum allocates only the block it posts. */
  readonly #transfer: Transferable[] = [];

  constructor() {
    super();
    this.port.addEventListener('message', () => {
      this.#stopped = true;
    });
    this.port.start(); // addEventListener, unlike the onmessage setter, doesn't start the port
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.#stopped) return false;
    const channel = inputs[0]?.[0];
    if (channel !== undefined && channel.length > 0) {
      const block = new Float32Array(channel);
      this.#transfer[0] = block.buffer;
      this.port.postMessage(block, this.#transfer);
    }
    return true;
  }
}

registerProcessor('lab-recorder', LabRecorder);
