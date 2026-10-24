import { createRealFft } from '../../../../src/dsp/fft.ts';
import { duckStage, nasal4, cubicShape } from './duck-lib.mjs';
const n = 1 << 16;
const bh = (i) => { const x = (2 * Math.PI * i) / n; return 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x); };
const fft = createRealFft(n); const re = new Float32Array(n / 2 + 1), im = new Float32Array(n / 2 + 1);
const spec = (y) => { const b = new Float32Array(n); for (let i = 0; i < n; i++) b[i] = y[i] * bh(i); fft.forward(b, re, im); return Array.from(re, (r, k) => r * r + im[k] * im[k]); };
const fullScale = (() => { const s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * 1234.5 * i) / 48000); return spec(s).reduce((a, b) => a + b, 0); })();
function aliasDbfs(stage, fs, f, offs) {
  const x = new Float32Array(n + 8192); for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / fs);
  const p = spec(stage(x).subarray(4096, 4096 + n)); const bin = fs / n; let other = 0;
  for (let k = Math.ceil(50 / bin); k < p.length; k++) { const hz = k * bin; let ok = false;
    for (const off of offs) { const m = Math.round((hz - off) / f); if (m >= 1 && Math.abs(hz - off - m * f) <= 8 * bin) ok = true; }
    if (!ok) other += p[k]; }
  return 10 * Math.log10(other / fullScale + 1e-30);
}
const tones = [1130, 2310, 3710, 4930, 7310, 11330, 17990, 21000];
for (const fs of [48000, 44100]) {
  console.log(`fs ${fs} EQ4+cubic (no AM)   `, tones.map((f) => `${f}:${aliasDbfs((x) => cubicShape(nasal4(x, fs)), fs, f, [0]).toFixed(0)}`).join(' '));
  console.log(`fs ${fs} full stage (±210 ok)`, tones.map((f) => `${f}:${aliasDbfs((x) => duckStage(x, fs), fs, f, [0, 70, -70, 140, -140, 210, -210]).toFixed(0)}`).join(' '));
}
