import { SR, synthVoice, linearRate, makeSincResampler, biquad, biquadCoeffs, bandErrorDb, sineLevelDb, bench } from './dsp.mjs';

// Chromium media::SincResampler emulation (decodeAudioData path): 32-tap Blackman windowed sinc, cutoff 0.90/ratio
function chromiumSinc(x, r) {
  const taps = 32, half = 16, scale = Math.min(1, 1 / r) * 0.90;
  const M = Math.floor((x.length - 1) / r), y = new Float32Array(M);
  let pos = 0;
  for (let i = 0; i < M; i++) {
    const k = Math.floor(pos), frac = pos - k; let acc = 0;
    for (let j = 0; j < taps; j++) {
      const idx = k - half + 1 + j; if (idx < 0 || idx >= x.length) continue;
      const t = idx - pos; const u = (j - frac) / taps; // Blackman over [0,1)
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
      const a = Math.PI * t * scale; acc += x[idx] * w * (a === 0 ? scale : Math.sin(a) / (Math.PI * t));
    }
    y[i] = acc; pos += r;
  }
  return y;
}

const ref = makeSincResampler({ zc: 64, beta: 10, phases: 2048, cutoff: 0.97 });
const sinc16 = makeSincResampler({ zc: 16, beta: 8.6, phases: 256, cutoff: 0.92 });
const sinc8 = makeSincResampler({ zc: 8, beta: 7, phases: 256, cutoff: 0.90 });
const prefLinear = (x, r) => { // 4th-order Butterworth-ish LP at 0.9*Nyquist_out/r (input domain) then linear
  const fc = 0.45 * SR / r; let y = biquad(x, biquadCoeffs('lp', fc, 0.5412)); y = biquad(y, biquadCoeffs('lp', fc, 1.3066)); return linearRate(y, r);
};

const x = synthVoice(5);
import { fftReal, bandEnergy } from './dsp.mjs';
function splitAt(x, fc) { // brickwall FFT split -> [lo, hi]
  let n = 1; while (n < x.length) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n); re.set(x);
  fftReal(re, im);
  for (let k = 0; k < n; k++) { const f = Math.min(k, n - k) * SR / n; if (f > fc) { re[k] = 0; im[k] = 0; } }
  // inverse via conj trick
  for (let k = 0; k < n; k++) im[k] = -im[k];
  fftReal(re, im);
  const lo = new Float32Array(x.length), hi = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { lo[i] = re[i] / n; hi[i] = x[i] - lo[i]; }
  return [lo, hi];
}
const zero = (n) => new Float32Array(n);
const algs = { linear: linearRate, 'biquadLP4+linear': prefLinear, 'chromiumSinc32(decode path)': chromiumSinc, sinc8: sinc8, sinc16: sinc16 };
console.log('Synthetic voice, 5 s @48k.');
for (const r of [1.4, 1.7, 2.0]) {
  const fc = 0.97 * SR / 2 / r;
  const [lo, hi] = splitAt(x, fc);
  let ehi = 0, etot = 0; for (let i = 0; i < x.length; i++) { ehi += hi[i] * hi[i]; etot += x[i] * x[i]; }
  console.log(`r=${r}: input energy above ${fc.toFixed(0)} Hz (would fold) = ${(10 * Math.log10(ehi / etot)).toFixed(1)} dB re total`);
  const Rtot = ref(x, r);
  for (const [name, f] of Object.entries(algs)) {
    const A = f(hi, r), Z = zero(A.length);
    // aliasing: output produced by out-of-band input, per output band, re total reference output energy
    const eRef = bandEnergy(Rtot, 0, 24000);
    const a1 = 10 * Math.log10(bandEnergy(A, 0, 8000) / eRef), a2 = 10 * Math.log10(bandEnergy(A, 8000, 16000) / eRef);
    const refDb = 0;
    const P = f(lo, r), Pr = ref(lo, r);
    const p1 = bandErrorDb(P, Pr, 0, 8000), p2 = bandErrorDb(P, Pr, 8000, 16000);
    console.log(`  ${name.padEnd(28)} alias0-8k ${(a1 - refDb).toFixed(1)}  alias8-16k ${(a2 - refDb).toFixed(1)}  | inband-err0-8k ${p1.toFixed(1)}  8-16k ${p2.toFixed(1)}`);
  }
}

// Tone tests: input sine at f (−6 dBFS); output alias at |r*f - k*48k| folded
console.log('\nTone test: input -6 dBFS sine, level of alias product in output (dBFS)');
for (const [r, f] of [[1.7, 16000], [2.0, 14000], [2.0, 18000], [2.0, 20000], [1.5, 20000]]) {
  const n = SR * 2, s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = 0.5 * Math.sin(2 * Math.PI * f * i / SR);
  let fo = (r * f) % SR; if (fo > SR / 2) fo = SR - fo;
  const row = Object.entries({ linear: linearRate, prefLinear, chromiumSinc, sinc16 }).map(([nm, fn]) => `${nm} ${sineLevelDb(fn(s, r), fo).toFixed(1)}`);
  console.log(`r=${r} fin=${f} -> alias ${fo} Hz: ${row.join(' | ')}`);
}
// Image test for low-frequency content: 3 kHz -6 dBFS sine, find strongest non-harmonic spur
console.log('\nSpur test (images of in-band tone): input 3 kHz -6 dBFS');
for (const r of [1.7, 1.45]) {
  const n = SR * 2, s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = 0.5 * Math.sin(2 * Math.PI * 3000 * i / SR);
  // image at fs_in - f = 45 kHz (input time) -> r*45k in output, folded
  let fi = (r * (SR - 3000)) % SR; if (fi > SR / 2) fi = SR - fi;
  console.log(`r=${r} image at ${fi.toFixed(0)} Hz: linear ${sineLevelDb(linearRate(s, r), fi).toFixed(1)} dBFS, sinc16 ${sineLevelDb(sinc16(s, r), fi).toFixed(1)} dBFS`);
}

console.log('\nCPU, desktop x86 Node ' + process.version + ' (median of 7), ms for 5 s clip:');
for (const r of [1.5, 2.0]) {
  for (const [name, f] of Object.entries({ linear: linearRate, prefLinear, sinc8, sinc16, })) {
    const ms = bench(() => f(x, r));
    console.log(`r=${r} ${name.padEnd(20)} ${ms.toFixed(2)} ms  (${(ms / 5).toFixed(2)} ms per s of audio)`);
  }
}
