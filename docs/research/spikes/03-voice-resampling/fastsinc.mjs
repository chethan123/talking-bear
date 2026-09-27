import { SR, synthVoice, bench, bandEnergy, makeSincResampler } from './dsp.mjs';
function bessel0(x) { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; }
// nearest-phase polyphase windowed sinc, one dot product per output sample
export function fastSinc(x, r, { zc = 8, beta = 7, phases = 1024, cutoff = 0.9 } = {}) {
  const scale = Math.min(1, 1 / r) * cutoff, half = Math.ceil(zc / scale), taps = 2 * half;
  const table = new Float32Array(phases * taps), i0b = bessel0(beta);
  for (let p = 0; p < phases; p++) for (let j = 0; j < taps; j++) {
    const t = (j - half + 1) - p / phases, u = t / half;
    const w = Math.abs(u) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - u * u)) / i0b, a = Math.PI * t * scale;
    table[p * taps + j] = w * scale * (a === 0 ? 1 : Math.sin(a) / a);
  }
  const N = x.length, M = Math.floor((N - 1) / r), y = new Float32Array(M);
  const xp = new Float32Array(N + 2 * taps); xp.set(x, taps); // zero padded, no bounds checks
  let pos = 0;
  for (let i = 0; i < M; i++) {
    const k = Math.floor(pos), p = ((pos - k) * phases + 0.5) | 0;
    const kk = p === phases ? k + 1 : k, pp = p === phases ? 0 : p;
    const b = pp * taps, s = kk - half + 1 + taps; let acc = 0;
    for (let j = 0; j < taps; j++) acc += table[b + j] * xp[s + j];
    y[i] = acc; pos += r;
  }
  return y;
}
const x = synthVoice(5);
const ref = makeSincResampler({ zc: 64, beta: 10, phases: 2048, cutoff: 0.97 });
for (const r of [1.5, 1.7, 2.0]) {
  const ms = bench(() => fastSinc(x, r));
  const y = fastSinc(x, r), R = ref(x, r); const d = new Float32Array(y.length); for (let i = 0; i < y.length; i++) d[i] = y[i] - R[i];
  console.log(`r=${r} fastSinc zc8 nearest-phase: ${ms.toFixed(1)} ms per 5 s clip; err vs ref 0-8k ${(10*Math.log10(bandEnergy(d,0,8000)/bandEnergy(R,0,24000))).toFixed(1)} dB`);
}
