import { readFileSync } from 'node:fs';
const R = new URL('../../../../', import.meta.url).pathname;
const { readWav } = await import(R + 'test/wav.ts');
const { yinF0 } = await import(R + 'src/dsp/yin.ts');
const { hpfTrim, voiceStages } = await import(R + 'src/dsp/voice.ts');
const { stage } = await import('./alias-onset.mjs');
const duckStage = (y, fs) => stage(y, fs); // the final stage: four LPF sections at 5 kHz
const { resample, isVoiced, applyGain, fades, envelope } = voiceStages;
for (const f of ['vowel_f0-140', 'vowel_f0-300', 'vowel_f0-140_pink_snr10']) {
  const w = readWav(readFileSync(R + `test/fixtures/${f}.wav`)); const fs = w.sampleRate; const x = w.channels[0];
  const meta = JSON.parse(readFileSync(R + `test/fixtures/${f}.json`, 'utf8'));
  for (const p of [1.3, 1.45, 1.6]) {
    const y = resample(hpfTrim(x, fs), p); const v = isVoiced(y, fs); const z = duckStage(y, fs); applyGain(z, fs, v); fades(z, fs);
    const env = envelope(z, fs, p); let jmax = 0; for (const j of env.jaw) jmax = Math.max(jmax, j);
    const fin = yinF0(x, fs); const fout = yinF0(z, fs); const fplain = yinF0(y, fs);
    console.log(`${f} fs=${fs} p=${p}: f0 in ${fin.toFixed(1)}, plain ${(fplain / fin).toFixed(3)}×, duck ${(fout / fin).toFixed(3)}× (err ${((fout / fin / p - 1) * 100).toFixed(2)} %), voiced ${v}, jaw max ${jmax.toFixed(2)}`);
  }
}
