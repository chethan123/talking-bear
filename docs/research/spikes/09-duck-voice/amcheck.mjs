import { readFileSync } from 'node:fs';
const R = new URL('../../../../', import.meta.url).pathname;
const { readWav } = await import(R + 'test/wav.ts');
const { createRealFft } = await import(R + 'src/dsp/fft.ts');
const { resampleOffline } = await import(R + 'src/dsp/resample.ts');
const { hpfTrim, voiceStages, processVoice } = await import(R + 'src/dsp/voice.ts');
const { duckStage } = await import('./duck-lib.mjs');
const { resample, isVoiced, applyGain, fades } = voiceStages;
// envelope line: |x| decimated to 1 kHz by block mean (10 ms resolution not needed), FFT 4096 at 1 kHz → 0.24 Hz bins
function amLine(z, fs) {
  const dec = Math.round(fs / 1000); const n = Math.floor(z.length / dec); const e = new Float32Array(4096);
  let m = 0; const env = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < dec; j++) s += Math.abs(z[i * dec + j]); env[i] = s / dec; m += env[i]; }
  m /= n; for (let i = 0; i < Math.min(n, 4096); i++) e[i] = (env[i] - m) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / Math.min(n, 4096)));
  const re = new Float32Array(2049), im = new Float32Array(2049); createRealFft(4096).forward(e, re, im);
  const p = Array.from(re, (r, k) => r * r + im[k] * im[k]); const hz = (k) => k * 1000 / 4096;
  let peak = 0; for (let k = 0; k < p.length; k++) if (Math.abs(hz(k) - 70) <= 1) peak = Math.max(peak, p[k]);
  const ref = p.filter((_, k) => hz(k) >= 40 && hz(k) <= 100 && Math.abs(hz(k) - 70) > 3).sort((a, b) => a - b);
  return 10 * Math.log10(peak / ref[ref.length >> 1]);
}
for (const f of ['vowel_f0-140', 'vowel_f0-300', 'vowel_f0-140_pink_snr10']) {
  const w = readWav(readFileSync(R + `test/fixtures/${f}.wav`)); let fs = w.sampleRate; let x = w.channels[0];
  for (const rate of [48000, 44100]) {
    const xx = rate === fs ? x : resampleOffline(x, rate / fs);
    const y = resample(hpfTrim(xx, rate), 1.45); const v = isVoiced(y, rate); const z = duckStage(y, rate); applyGain(z, rate, v); fades(z, rate);
    const plain = processVoice(xx, rate, { id: 'custom', pitchRatio: 1.45 }).pcm;
    console.log(`${f} @${rate}: 70 Hz envelope line duck ${amLine(z, rate).toFixed(1)} dB, plain ${amLine(plain, rate).toFixed(1)} dB`);
  }
}
