// Throwaway spike, round 3 (duck-plan research, 2026-10-24): the recommended stage (AM → nasal EQ 4th-order LPF →
// cubic shaper), its CPU, aliasing in dBFS, intelligibility proxy and the whole-chain cost. Node 24, repo root:
//   node docs/research/spikes/09-duck-voice/bench3.mjs
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { readWav } from '../../../../test/wav.ts';
import { resampleOffline } from '../../../../src/dsp/resample.ts';
import { createRealFft } from '../../../../src/dsp/fft.ts';
import { hpfTrim, voiceStages, processVoice } from '../../../../src/dsp/voice.ts';
import { truePeakDbtp, integratedLoudness } from '../../../../src/dsp/normalize.ts';
import { centroid, duckStage, fastTrack, nasal4, pitchSyncMod, cubicShape, stoi, softClipAdaa, ringMod } from './duck-lib.mjs';

const FS = 48000;
const manifest = JSON.parse(readFileSync('test/corpus/speech/manifest.json', 'utf8'));
const load = (file) => { const w = readWav(readFileSync(`test/corpus/speech/${file}`)); return resampleOffline(w.channels[0], FS / w.sampleRate); };
const sentences = manifest.filter((m) => m.kind === 'sentence').map((m) => ({ ...m, x: load(m.file) }));
const words = manifest.filter((m) => m.kind === 'word').map((m) => ({ ...m, x: load(m.file) }));
const x5 = (() => { const out = new Float32Array(5 * FS); let o = 0; for (const s of sentences) { if (o >= out.length) break; const n = Math.min(s.x.length, out.length - o); out.set(s.x.subarray(0, n), o); o += n + 4800; } return out; })();
const time = (fn, runs = 15, warm = 4) => { for (let i = 0; i < warm; i++) fn(); const t = []; for (let i = 0; i < runs; i++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); } t.sort((a, b) => a - b); return { med: t[t.length >> 1], p95: t[Math.min(t.length - 1, Math.ceil(0.95 * t.length) - 1)] }; };
const sinc = (x, p) => resampleOffline(hpfTrim(x, FS, false), 1 / p);
const { clipDetect, resample, isVoiced, applyGain, fades, envelope } = voiceStages;
const chain = (pcm, p, stage) => { clipDetect(pcm); const x = hpfTrim(pcm, FS, false); const y = resample(x, p); const v = isVoiced(y, FS); const z = stage ? stage(y) : y; applyGain(z, FS, v); fades(z, FS); envelope(z, FS, p); return z; };

console.log(`## CPU, 5 s clip at 48 kHz, node ${process.version} ${process.arch} (median / p95 of 15)`);
const y5 = sinc(x5, 1.45);
for (const [k, fn] of Object.entries({
  'AM': () => ringMod(y5, FS, { fc: 70, mix: 0.35 }),
  'nasal EQ, 6 biquads': () => nasal4(y5, FS),
  'cubic shaper': () => cubicShape(y5),
  'duck stage (AM + EQ + cubic)': () => duckStage(y5, FS),
  'chain: processVoice cub 1.6': () => processVoice(x5, FS, { id: 'cub', pitchRatio: 1.6 }, { noTrim: true }),
  'chain: processVoice chipmunk 2.0': () => processVoice(x5, FS, { id: 'chipmunk', pitchRatio: 2 }, { noTrim: true }),
  'chain: processVoice bigbear 0.75': () => processVoice(x5, FS, { id: 'bigbear', pitchRatio: 0.75 }, { noTrim: true }),
  'chain: duck p=1.45 (stage after resample)': () => chain(x5, 1.45, (y) => duckStage(y, FS)),
  'chain: plain sinc p=1.45 (no duck stage)': () => chain(x5, 1.45, null),
})) { const t = time(fn); console.log(`${k.padEnd(44)} ${t.med.toFixed(1).padStart(6)} ms (p95 ${t.p95.toFixed(1)})  ${(t.med / 5).toFixed(1)} ms/s`); }

// alias in dBFS: tone at −6 dBFS (amp 0.5), non-commensurate frequencies; wanted = ±8 bins of k·f and k·f ± 70 Hz
const n = 1 << 16;
const bh = (i) => { const x = (2 * Math.PI * i) / n; return 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x); };
const fft = createRealFft(n); const re = new Float32Array(n / 2 + 1), im = new Float32Array(n / 2 + 1);
const spec = (y) => { const b = new Float32Array(n); for (let i = 0; i < n; i++) b[i] = y[i] * bh(i); fft.forward(b, re, im); return Array.from(re, (r, k) => r * r + im[k] * im[k]); };
const fullScale = (() => { const s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * 1234.5 * i) / 48000); return spec(s).reduce((a, b) => a + b, 0); })();
function aliasDbfs(stage, fs, f) {
  const x = new Float32Array(n + 8192); for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / fs);
  const p = spec(stage(x).subarray(4096, 4096 + n)); const bin = fs / n; let other = 0;
  for (let k = Math.ceil(50 / bin); k < p.length; k++) {
    const hz = k * bin; let ok = false;
    for (const off of [0, 70, -70, 140, -140, 210, -210]) { const m = Math.round((hz - off) / f); if (m >= 1 && Math.abs(hz - off - m * f) <= 8 * bin) ok = true; }
    if (!ok) other += p[k];
  }
  return 10 * Math.log10(other / fullScale + 1e-30);
}
console.log('\n## Alias energy in dBFS (tone −6 dBFS), duck stage and its shaper variants');
const tones = [1130, 2310, 3710, 4930, 7310, 11330, 17990];
for (const fs of [48000, 44100]) for (const [name, st] of [
  ['duck stage (cubic)', (x) => duckStage(x, fs)],
  ['EQ4 + tanh ADAA d2.5', (x) => softClipAdaa(nasal4(x, fs), fs, { drive: 2.5 })],
]) console.log(`fs ${fs} ${name.padEnd(22)}`, tones.map((f) => `${f}:${aliasDbfs(st, fs, f).toFixed(0)}`).join(' '));

// intelligibility proxy and loudness behaviour, per pitch ratio, sentences and words, all and pitch-99
console.log('\n## STOI (vs sinc(p)), duck stage, by pitch ratio');
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
for (const p of [1.3, 1.45, 1.6]) {
  const all = [], kid = [], wd = [];
  let cen = 0;
  for (const s of sentences) { const ref = sinc(s.x, p); const out = duckStage(ref, FS); const v = stoi(ref, out, FS); all.push(v); if (s.pitch === 99) kid.push(v); cen += centroid(out, FS) - centroid(ref, FS); }
  for (const w of words) { const ref = sinc(w.x, p); if (ref.length < 0.45 * FS) continue; const out = duckStage(ref, FS); const v = stoi(ref, out, FS); if (Number.isFinite(v)) wd.push(v); }
  console.log(`p=${p}: sentences ${mean(all).toFixed(3)} (min ${Math.min(...all).toFixed(3)}), pitch-99 ${mean(kid).toFixed(3)} (min ${Math.min(...kid).toFixed(3)}), words ≥0.45 s ${wd.length ? mean(wd).toFixed(3) : 'n/a'} (n=${wd.length}); centroid +${(cen / all.length).toFixed(0)} Hz`);
}
// variant: pitch-synchronous subharmonic instead of fixed AM (fallback)
{
  const all = [];
  for (const s of sentences) { const ref = sinc(s.x, 1.45); const out = cubicShape(nasal4(pitchSyncMod(ref, FS, fastTrack(ref, FS), { depth: 0.45 }), FS)); all.push(stoi(ref, out, FS)); }
  console.log(`fallback (pitch-sync sub 0.45 instead of AM), p=1.45: sentences ${mean(all).toFixed(3)} (min ${Math.min(...all).toFixed(3)})`);
  const t = time(() => cubicShape(nasal4(pitchSyncMod(y5, FS, fastTrack(y5, FS), { depth: 0.45 }), FS)));
  console.log(`fallback stage CPU: ${t.med.toFixed(1)} ms per 5 s`);
}
// loudness safety after the chain: output loudness and true peak for the 5 s clip and the loudest sentence ×4 (shout)
{
  const z = chain(x5, 1.45, (y) => duckStage(y, FS));
  console.log(`\n## Chain output: ${integratedLoudness(z, FS).toFixed(2)} LUFS, true peak ${truePeakDbtp(z).toFixed(2)} dBTP`);
  const loud = Float32Array.from(x5, (v) => Math.max(-1, Math.min(1, 4 * v)));
  const z2 = chain(loud, 1.45, (y) => duckStage(y, FS));
  console.log(`Shouted (×4, clipped) input: ${integratedLoudness(z2, FS).toFixed(2)} LUFS, true peak ${truePeakDbtp(z2).toFixed(2)} dBTP`);
  const quiet = Float32Array.from(x5, (v) => v * 0.03);
  const z3 = chain(quiet, 1.45, (y) => duckStage(y, FS));
  const zr = chain(quiet, 1.45, null);
  console.log(`Whisper-level (×0.03) input: duck ${integratedLoudness(z3, FS).toFixed(2)} LUFS vs plain ${integratedLoudness(zr, FS).toFixed(2)} LUFS (make-up cap holds)`);
}
