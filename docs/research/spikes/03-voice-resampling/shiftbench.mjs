import { SR, synthVoice, bench } from './dsp.mjs';
import { trackPitch } from './algos.mjs';
import { wsola, psola, formant, lpc, vocoder, phaseLock } from '@audio/shift';
import { fftReal } from './dsp.mjs';
const SECS = 5, x = synthVoice(SECS);
const med = (a) => { const v = [...a].filter(q => q > 0).sort((p, q) => p - q); return v[v.length >> 1]; };
const f0m = med(trackPitch(x).f0);
const centroid = (y) => { const { f0, hopSamples } = trackPitch(y); const n = 2048; const acc = new Float64Array(n / 2 + 1);
  for (let f = 0; f < f0.length; f++) { if (!(f0[f] > 0)) continue; const s0 = f * hopSamples; if (s0 + n > y.length) break;
    const re = new Float64Array(n), im = new Float64Array(n); for (let i = 0; i < n; i++) re[i] = y[s0 + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
    fftReal(re, im); for (let k = 0; k <= n / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k]; }
  let num = 0, den = 0; for (let k = 0; k <= n / 2; k++) { const fr = k * SR / n; if (fr < 200 || fr > 5000) continue; num += acc[k] * fr; den += acc[k]; } return num / den; };
const c0 = centroid(x);
const algs = { wsola, psola, formant, lpc, vocoder, phaseLock };
for (const r of [1.5, 2.0]) for (const [n, f] of Object.entries(algs)) {
  const opt = { ratio: r, sampleRate: SR, maxFreq: 800 };
  let y; try { y = f(x, opt); } catch (e) { console.log(n, 'ERR', e.message); continue; }
  const ms = bench(() => f(x, opt), 3);
  console.log(`r=${r} @audio/shift.${n.padEnd(10)} ${ms.toFixed(1).padStart(7)} ms (${(ms / SECS).toFixed(1)} ms/s)  dur ${(y.length / SR).toFixed(2)}s f0x ${(med(trackPitch(y).f0) / f0m).toFixed(2)} centroid x ${(centroid(y) / c0).toFixed(2)}`);
}
