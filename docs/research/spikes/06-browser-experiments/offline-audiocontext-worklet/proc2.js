import { rms } from './dsp.js';
class Probe2 extends AudioWorkletProcessor {
  constructor() { super(); this.q = 0; }
  process(inputs) { const inp = inputs[0][0]; if (this.q === 0) this.port.postMessage({ t: 'ok', rms: inp ? rms(inp) : -1, hasImportMeta: typeof import.meta.url }); this.q++; return true; }
}
registerProcessor('probe2', Probe2);
