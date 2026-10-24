// Round 4 (final, after review R2-02): the revised stage (AM → HPF, dip, 2 peaks → 4 RBJ LPF sections at 5 kHz →
// peak-normalised cubic). CPU and whole-chain cost (median / p95 of 30), loudness, 70 Hz marker, envelope tracks.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { readWav } from '../../../../test/wav.ts';
import { resampleOffline } from '../../../../src/dsp/resample.ts';
import { createRealFft } from '../../../../src/dsp/fft.ts';
import { hpfTrim, voiceStages, processVoice } from '../../../../src/dsp/voice.ts';
import { truePeakDbtp, integratedLoudness } from '../../../../src/dsp/normalize.ts';
import { stoi, centroid } from './duck-lib.mjs';
import { stage } from './alias-onset.mjs';
const FS = 48000;
const man = JSON.parse(readFileSync('test/corpus/speech/manifest.json', 'utf8'));
const load = (f) => { const w = readWav(readFileSync('test/corpus/speech/' + f)); return resampleOffline(w.channels[0], FS / w.sampleRate); };
const sents = man.filter((m) => m.kind === 'sentence').map((m) => ({ ...m, x: load(m.file) }));
const x5 = (() => { const o5 = new Float32Array(5 * FS); let o = 0; for (const s of sents) { if (o >= o5.length) break; const n = Math.min(s.x.length, o5.length - o); o5.set(s.x.subarray(0, n), o); o += n + 4800; } return o5; })();
const time = (fn) => { for (let i = 0; i < 4; i++) fn(); const t = []; for (let i = 0; i < 30; i++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); } t.sort((a, b) => a - b); return [t[15], t[Math.ceil(0.95 * 30) - 1]]; };
const { clipDetect, resample, isVoiced, applyGain, fades, envelope } = voiceStages;
const duck = (y) => stage(y, FS);
const chain = (pcm, p, st) => { clipDetect(pcm); const x = hpfTrim(pcm, FS, false); const y = resample(x, p); const v = isVoiced(y, FS); const z = st ? st(y) : y; applyGain(z, FS, v); fades(z, FS); return { z, env: envelope(z, FS, p) }; };
const y5 = resampleOffline(hpfTrim(x5, FS, false), 1 / 1.45);
console.log(`## CPU (median / p95 of 30), node ${process.version} ${process.arch}`);
for (const [k, fn] of Object.entries({
  'duck stage': () => duck(y5),
  'chain duck p1.45': () => chain(x5, 1.45, duck),
  'chain plain p1.45': () => chain(x5, 1.45, null),
  'processVoice cub': () => processVoice(x5, FS, { id: 'cub', pitchRatio: 1.6 }, { noTrim: true }),
  'processVoice chipmunk': () => processVoice(x5, FS, { id: 'chipmunk', pitchRatio: 2 }, { noTrim: true }),
  'processVoice bigbear': () => processVoice(x5, FS, { id: 'bigbear', pitchRatio: 0.75 }, { noTrim: true }),
})) { const [m, p] = time(fn); console.log(`${k.padEnd(24)} ${m.toFixed(1)} / ${p.toFixed(1)} ms   ${(m / 5).toFixed(1)} / ${(p / 5).toFixed(1)} ms/s`); }
console.log('\n## STOI (40 sentences; pitch-99 subset) and centroid shift, per p');
for (const p of [1.3, 1.45, 1.6]) {
  const all = [], kid = []; let cen = 0;
  for (const s of sents) { const ref = resampleOffline(hpfTrim(s.x, FS, false), 1 / p); const out = duck(ref); const v = stoi(ref, out, FS); all.push(v); if (s.pitch === 99) kid.push(v); cen += centroid(out, FS) - centroid(ref, FS); }
  const mean = (a) => a.reduce((x, y) => x + y) / a.length;
  console.log(`p ${p}: ${mean(all).toFixed(3)} (min ${Math.min(...all).toFixed(3)}), pitch-99 ${mean(kid).toFixed(3)} (min ${Math.min(...kid).toFixed(3)}), centroid +${(cen / all.length).toFixed(0)} Hz`);
}
console.log('\n## Loudness after the production gain rule');
const a = chain(x5, 1.45, duck).z; console.log(`normal ${integratedLoudness(a, FS).toFixed(2)} LUFS ${truePeakDbtp(a).toFixed(2)} dBTP`);
const b = chain(Float32Array.from(x5, (v) => Math.max(-1, Math.min(1, 4 * v))), 1.45, duck).z; console.log(`shout ${integratedLoudness(b, FS).toFixed(2)} LUFS ${truePeakDbtp(b).toFixed(2)} dBTP`);
const c = chain(Float32Array.from(x5, (v) => v * 0.03), 1.45, duck).z, c0 = chain(Float32Array.from(x5, (v) => v * 0.03), 1.45, null).z;
console.log(`whisper duck ${integratedLoudness(c, FS).toFixed(2)} vs plain ${integratedLoudness(c0, FS).toFixed(2)} LUFS`);
console.log('\n## Envelope tracks (sentence-00-r0, sentence-03-r1): mean width, mean round, max teeth — plain vs duck');
for (const id of ['sentence-00-r0', 'sentence-03-r1']) {
  const x = sents.find((s) => s.id === id).x; const P = chain(x, 1.45, null).env, D = chain(x, 1.45, duck).env;
  const mean = (t) => t.reduce((q, v) => q + v, 0) / t.length; const mx = (t) => t.reduce((q, v) => Math.max(q, v), 0);
  console.log(`${id}: width ${mean(P.width).toFixed(2)} → ${mean(D.width).toFixed(2)}, round ${mean(P.round).toFixed(2)} → ${mean(D.round).toFixed(2)}, teeth max ${mx(P.teeth).toFixed(2)} → ${mx(D.teeth).toFixed(2)}, jaw max ${mx(P.jaw).toFixed(2)} → ${mx(D.jaw).toFixed(2)}`);
}
console.log('\n## 70 Hz envelope line, vowel fixtures');
for (const f of ['vowel_f0-140', 'vowel_f0-300', 'vowel_f0-140_pink_snr10']) for (const rate of [48000, 44100]) {
  const w = readWav(readFileSync(`test/fixtures/${f}.wav`)); const xx = rate === w.sampleRate ? w.channels[0] : resampleOffline(w.channels[0], rate / w.sampleRate);
  const y = resample(hpfTrim(xx, rate), 1.45); const v = isVoiced(y, rate); const z = stage(y, rate); applyGain(z, rate, v); fades(z, rate);
  const plain = processVoice(xx, rate, { id: 'custom', pitchRatio: 1.45 }).pcm;
  const line = (q) => { const dec = Math.round(rate / 1000), n = Math.floor(q.length / dec), N = Math.min(n, 4096), e = new Float32Array(4096), env = new Float32Array(n); let m = 0;
    for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < dec; j++) s += Math.abs(q[i * dec + j]); env[i] = s / dec; m += env[i]; } m /= n;
    for (let i = 0; i < N; i++) e[i] = (env[i] - m) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    const re = new Float32Array(2049), im = new Float32Array(2049); createRealFft(4096).forward(e, re, im); const pw = Array.from(re, (r, k) => r * r + im[k] * im[k]); const hz = (k) => (k * 1000) / 4096;
    let pk = 0; for (let k = 0; k < pw.length; k++) if (Math.abs(hz(k) - 70) <= 1) pk = Math.max(pk, pw[k]);
    const ref = pw.filter((_, k) => hz(k) >= 40 && hz(k) <= 100 && Math.abs(hz(k) - 70) > 3).sort((x, y) => x - y); return 10 * Math.log10(pk / ref[ref.length >> 1]); };
  console.log(`${f} @${rate}: duck ${line(z).toFixed(1)} dB, plain ${line(plain).toFixed(1)} dB`);
}
// added inharmonic energy on a steady harmonic complex (the rasp), final stage
{
  const { addedDb } = await import('./duck-lib.mjs');
  console.log(`\n## Added inharmonic energy, final stage: f0 200 Hz ${addedDb((x) => stage(x, FS), FS, 200).toFixed(1)} dB, f0 420 Hz ${addedDb((x) => stage(x, FS), FS, 420).toFixed(1)} dB; linear EQ only (amMix 0, shapeMix via cubic off): ${addedDb((x) => stage(x, FS, { amMix: 0 }), FS, 420).toFixed(1)} dB`);
}
