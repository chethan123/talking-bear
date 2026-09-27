import workletUrl from './capture.worklet.js?worker&url';
import DspWorker from './dsp.worker.js?worker';
import { hpf } from './shared.js';
if (import.meta.env.VITE_BEAR_TEST_HOOKS === '1') {
  window.__bearTest = { log: [], marker: 'MAIN_HOOK_MARKER' };
}
const w = new DspWorker();
w.postMessage(hpf(new Float32Array(4)));
console.log(workletUrl);
