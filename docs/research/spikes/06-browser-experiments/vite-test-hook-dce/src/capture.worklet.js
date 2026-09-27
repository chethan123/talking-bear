import { hpf } from './shared.js';
class Cap extends AudioWorkletProcessor {
  process(inputs) {
    const x = inputs[0][0] || new Float32Array(128);
    const y = hpf(x);
    if (import.meta.env.VITE_BEAR_TEST_HOOKS === '1') { this.port.postMessage({ marker: 'WORKLET_HOOK_MARKER', y }); }
    return true;
  }
}
registerProcessor('cap', Cap);
