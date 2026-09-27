import { SR, sineLevelDb } from './dsp.mjs';
import { SoundTouch, registerInterpolationStrategy } from '@soundtouchjs/core';
import { registerLinearStrategy } from '@soundtouchjs/interpolation-strategy-linear';
import { SoundTouch as Legacy } from 'soundtouchjs';
import { wsolaPitch } from './algos.mjs';
import { createRequire } from 'module';
registerLinearStrategy({ registerInterpolationStrategy });
const require = createRequire(import.meta.url);
const ss = await require('./ss_module.cjs')(); ss._main?.();
const n = SR * 2, s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = 0.5 * Math.sin(2 * Math.PI * 18000 * i / SR);
function st(Ctor, opts, r) { const t = opts === null ? new Ctor() : new Ctor({ sampleRate: SR, ...opts }); t.pitch = r;
  const B = 4096, inter = new Float32Array(B * 2); const out = [];
  for (let k = 0; k < n + 3 * B; k += B) { for (let i = 0; i < B; i++) { const v = s[k + i] || 0; inter[2 * i] = v; inter[2 * i + 1] = v; }
    t.inputBuffer.putSamples(inter, 0, B); t.process(); const m = t.outputBuffer.frameCount; const tmp = new Float32Array(m * 2);
    if (opts === null) t.outputBuffer.receiveSamples(tmp, m); else { t.outputBuffer.extract(tmp, 0, m); t.outputBuffer.receive(m); }
    for (let i = 0; i < m; i++) out.push(tmp[2 * i]); }
  return Float32Array.from(out.slice(4096, n - 4096)); }
function sig(r) { ss._presetDefault(1, SR); const B = 512, p = ss._setBuffers(1, B); ss._setTransposeSemitones(12 * Math.log2(r), 8000 / SR); ss._setFormantSemitones(0, false);
  const y = new Float32Array(n); for (let k = 0; k < n; k += B) { const mem = new Float32Array(ss.HEAP8.buffer); for (let i = 0; i < B; i++) mem[p / 4 + i] = s[k + i] || 0; ss._process(B, B); y.set(new Float32Array(ss.HEAP8.buffer).subarray(p / 4 + B, p / 4 + 2 * B).subarray(0, Math.min(B, n - k)), k); }
  return y.subarray(8192, n - 8192); }
const r = 2.0, fo = 12000;
console.log('18 kHz -6 dBFS tone, pitch x2 (duration kept). Level at 12 kHz alias (dBFS):');
console.log(' ST core lanczos ', sineLevelDb(st(SoundTouch, {}, r), fo).toFixed(1));
console.log(' ST core linear  ', sineLevelDb(st(SoundTouch, { interpolationStrategy: 'linear' }, r), fo).toFixed(1));
console.log(' legacy 0.3.0    ', sineLevelDb(st(Legacy, null, r), fo).toFixed(1));
console.log(' own WSOLA+sinc8 ', sineLevelDb(wsolaPitch(s, r).subarray(4096, n - 4096), fo).toFixed(1));
console.log(' Signalsmith     ', sineLevelDb(sig(r), fo).toFixed(1));
