// Alias energy in dBFS of the duck stage at the DUCK_TUNE_BOUNDS corners (amHz × amMix × peak1Db), 44.1 and 48 kHz.
import { createRealFft } from '../../../../src/dsp/fft.ts';
import { cubicShape, nasal4, NASAL4, ringMod } from './duck-lib.mjs';
const n = 1 << 16;
const bh = (i) => { const x = (2 * Math.PI * i) / n; return 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x); };
const fft = createRealFft(n); const re = new Float32Array(n / 2 + 1), im = new Float32Array(n / 2 + 1);
const spec = (y) => { const b = new Float32Array(n); for (let i = 0; i < n; i++) b[i] = y[i] * bh(i); fft.forward(b, re, im); return Array.from(re, (r, k) => r * r + im[k] * im[k]); };
const fullScale = (() => { const s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * 1234.5 * i) / 48000); return spec(s).reduce((a, b) => a + b, 0); })();
let worst = -Infinity;
for (const fs of [44100, 48000]) for (const amHz of [60, 80]) for (const amMix of [0.2, 0.4]) for (const peak1Db of [6, 12]) for (const f of [1130, 2310, 3710, 4930, 7310, 11330, 17990]) {
  const x = new Float32Array(n + 8192); for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / fs);
  const y = cubicShape(nasal4(ringMod(x, fs, { fc: amHz, mix: amMix }), fs, { ...NASAL4, peak1Db }));
  const p = spec(y.subarray(4096, 4096 + n)); const bin = fs / n; let other = 0;
  for (let k = Math.ceil(50 / bin); k < p.length; k++) { const hz = k * bin; let ok = false;
    for (let j = -3; j <= 3; j++) { const m = Math.round((hz - j * amHz) / f); if (m >= 1 && Math.abs(hz - j * amHz - m * f) <= 8 * bin) ok = true; }
    if (!ok) other += p[k]; }
  const db = 10 * Math.log10(other / fullScale + 1e-30); if (db > worst) { worst = db; console.log(`new worst ${db.toFixed(1)} dBFS at fs ${fs} amHz ${amHz} amMix ${amMix} peak1Db ${peak1Db} f ${f}`); }
}
console.log('worst', worst.toFixed(1));
