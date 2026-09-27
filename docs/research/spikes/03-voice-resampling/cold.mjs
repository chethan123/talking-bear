import { synthVoice } from './dsp.mjs';
import { sinc8, psola, wsolaPitch } from './algos.mjs';
const x = synthVoice(5); const which = process.argv[2];
const f = { sinc8: () => sinc8(x, 1.7), psola: () => psola(x, 1.7), wsola: () => wsolaPitch(x, 1.7) }[which];
const t0 = performance.now(); f(); const t1 = performance.now(); f(); const t2 = performance.now();
console.log(which, 'cold first run', (t1 - t0).toFixed(1), 'ms; second run', (t2 - t1).toFixed(1), 'ms');
