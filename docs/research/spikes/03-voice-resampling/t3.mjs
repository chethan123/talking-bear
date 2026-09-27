import { SR, synthVoice, bench } from './dsp.mjs';
import { SoundTouch, registerInterpolationStrategy } from '@soundtouchjs/core';
import { registerLinearStrategy } from '@soundtouchjs/interpolation-strategy-linear';
registerLinearStrategy({ registerInterpolationStrategy });
const x = synthVoice(5);
function run(opts, r = 1.7) {
  const st = new SoundTouch({ sampleRate: SR, ...opts }); st.pitch = r;
  const B = 4096, inter = new Float32Array(B * 2), tmp = new Float32Array(32768 * 2); let out = 0;
  for (let s = 0; s < x.length + 3 * B; s += B) {
    for (let i = 0; i < B; i++) { const v = x[s + i] || 0; inter[2 * i] = v; inter[2 * i + 1] = v; }
    st.inputBuffer.putSamples(inter, 0, B); st.process();
    const n = st.outputBuffer.frameCount; st.outputBuffer.extract(tmp, 0, Math.min(n, 32768)); st.outputBuffer.receive(n); out += n;
  }
  return [out, st.interpolationStrategy];
}
for (const o of [{}, { sampleBufferType: 'fifo' }, { interpolationStrategy: 'linear' }, { sampleBufferType: 'fifo', interpolationStrategy: 'linear' }]) {
  const [n, strat] = run(o); console.log(JSON.stringify(o).padEnd(60), 'strategy', strat, 'frames', n, bench(() => run(o), 5).toFixed(1), 'ms / 5 s');
}
