// Round 4 (after review R2-02): alias in dBFS with a 2048-sample raised-cosine onset (no click sets the peak), for
// the duck stage with 2, 3 or 4 cascaded RBJ LPF sections at lpHz, and the STOI on T115's 10 sentences.
import { readFileSync } from 'node:fs';
import { createRealFft } from '../../../../src/dsp/fft.ts';
import { resampleOffline } from '../../../../src/dsp/resample.ts';
import { hpfTrim } from '../../../../src/dsp/voice.ts';
import { readWav } from '../../../../test/wav.ts';
import { biquadInPlace, cubicShape, nasal, NASAL, rbj, ringMod, stoi, centroid } from './duck-lib.mjs';
const n = 1 << 16;
const bh = (i) => { const x = (2 * Math.PI * i) / n; return 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x); };
const fft = createRealFft(n); const re = new Float32Array(n / 2 + 1), im = new Float32Array(n / 2 + 1);
const spec = (y) => { const b = new Float32Array(n); for (let i = 0; i < n; i++) b[i] = y[i] * bh(i); fft.forward(b, re, im); return Array.from(re, (r, k) => r * r + im[k] * im[k]); };
const fullScale = (() => { const s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * 1234.5 * i) / 48000); return spec(s).reduce((a, b) => a + b, 0); })();
export function stage(y, fs, { amHz = 70, amMix = 0.35, peak1Db = 10, lpHz = 5000, sections = 4 } = {}) {
  const z = nasal(ringMod(y, fs, { fc: amHz, mix: amMix }), fs, { ...NASAL, peak1Db, lpHz }); // includes 1 LPF section
  for (let k = 1; k < sections; k++) biquadInPlace(z, rbj('lp', fs, lpHz, 0.707));
  return cubicShape(z);
}
const RAMP = 2048;
function aliasDbfs(st, fs, f, amHz) {
  const x = new Float32Array(n + 8192);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / fs) * (i < RAMP ? 0.5 - 0.5 * Math.cos((Math.PI * i) / RAMP) : 1);
  const p = spec(st(x).subarray(8192 - 0, 8192 + n - 0).length === n ? st(x).subarray(8192, 8192 + n) : st(x).subarray(0, n));
  const bin = fs / n; let other = 0;
  for (let k = Math.ceil(50 / bin); k < p.length; k++) { const hz = k * bin; let ok = false;
    for (let j = -3; j <= 3; j++) { const m = Math.round((hz - j * amHz) / f); if (m >= 1 && Math.abs(hz - j * amHz - m * f) <= 8 * bin) ok = true; }
    if (!ok) other += p[k]; }
  return 10 * Math.log10(other / fullScale + 1e-30);
}
const tones = [1130, 2310, 3710, 4930, 6130, 7310, 8000, 8500, 9000, 10000, 11330, 13700, 17990];
export const _v = 0;
const variants = process.argv.includes('--variants') ? [
  { sections: 2, lpHz: 5500 }, { sections: 3, lpHz: 5500 }, { sections: 4, lpHz: 5500 }, { sections: 4, lpHz: 5000 }, { sections: 6, lpHz: 5500 },
] : [{ sections: 4, lpHz: 5000 }];
if (import.meta.url === `file://${process.argv[1]}`) main();
function main() {
const FS = 48000;
const man = JSON.parse(readFileSync('test/corpus/speech/manifest.json', 'utf8'));
const S = ['00', '01', '02', '03', '04'].flatMap((k) => ['r0', 'r1'].map((r) => { const m = man.find((q) => q.id === `sentence-${k}-${r}`); const w = readWav(readFileSync('test/corpus/speech/' + m.file)); return resampleOffline(w.channels[0], FS / w.sampleRate); }));
for (const v of variants) {
  let worst = -Infinity, at = '';
  for (const fs of [44100, 48000]) for (const amHz of [60, 70, 80]) for (const amMix of [0.2, 0.35, 0.4]) for (const peak1Db of [6, 10, 12]) for (const f of tones) {
    const db = aliasDbfs((x) => stage(x, fs, { ...v, amHz, amMix, peak1Db }), fs, f, amHz);
    if (db > worst) { worst = db; at = `fs ${fs} amHz ${amHz} amMix ${amMix} peak1Db ${peak1Db} f ${f}`; }
  }
  const st = S.map((x) => { const ref = resampleOffline(hpfTrim(x, FS, false), 1 / 1.45); return stoi(ref, stage(ref, FS, v), FS); });
  const cen = S.reduce((a, x) => { const ref = resampleOffline(hpfTrim(x, FS, false), 1 / 1.45); return a + centroid(stage(ref, FS, v), FS) - centroid(ref, FS); }, 0) / S.length;
  console.log(`${v.sections} sections @ ${v.lpHz} Hz: worst alias ${worst.toFixed(1)} dBFS (${at}); STOI DUCK p1.45 mean ${(st.reduce((a, b) => a + b) / st.length).toFixed(3)} min ${Math.min(...st).toFixed(3)}; centroid +${cen.toFixed(0)} Hz`);
}
}
