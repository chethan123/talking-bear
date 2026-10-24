// Throwaway spike, round 2 (duck-plan research, 2026-10-24). Run from the repo root with Node 24:
//   node docs/research/spikes/09-duck-voice/bench2.mjs
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { readWav } from '../../../../test/wav.ts';
import { resampleOffline } from '../../../../src/dsp/resample.ts';
import { hpfTrim, voiceStages, processVoice } from '../../../../src/dsp/voice.ts';
import {
  addedDb, aliasDbV2, centroid, f0PerSample, fastTrack, nasal, pitchSyncMod, ringMod, softClip, softClipAdaa,
  softClipHalfband, stoi,
} from './duck-lib.mjs';

const FS = 48000;
const RUNS = 11;
const WARM = 3;
const manifest = JSON.parse(readFileSync('test/corpus/speech/manifest.json', 'utf8'));
const load = (file) => {
  const w = readWav(readFileSync(`test/corpus/speech/${file}`));
  return resampleOffline(w.channels[0], FS / w.sampleRate);
};
const sentences = manifest.filter((m) => m.kind === 'sentence').map((m) => ({ ...m, x: load(m.file) }));
const x5 = (() => {
  const out = new Float32Array(5 * FS);
  let o = 0;
  for (const s of sentences) {
    if (o >= out.length) break;
    const n = Math.min(s.x.length, out.length - o);
    out.set(s.x.subarray(0, n), o);
    o += n + Math.round(0.1 * FS);
  }
  return out;
})();
const time = (fn) => {
  for (let i = 0; i < WARM; i++) fn();
  const t = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return t[t.length >> 1];
};
const sinc = (x, p) => resampleOffline(hpfTrim(x, FS, false), 1 / p);

// ---- the duck stage candidates (stage only: input y = the pitch-shifted clip) -----------------------------------
const DEPTH = 0.45;
const DRIVE = 2.5;
const AM_HZ = 70;
const AM_MIX = 0.35;
const stageA = (y) => softClipAdaa(nasal(pitchSyncMod(y, FS, fastTrack(y, FS), { mode: 'sub', depth: DEPTH }), FS), FS, { drive: DRIVE });
const stageC = (y) => softClipAdaa(nasal(ringMod(y, FS, { fc: AM_HZ, mix: AM_MIX }), FS), FS, { drive: DRIVE });

const P = 1.4;
const y5 = sinc(x5, P);
console.log(`## Round 2 CPU per 5 s clip at 48 kHz (median of ${RUNS}), node ${process.version}, ${process.arch}`);
const T = {
  'fastTrack (YIN @8 kHz, 10 ms hop, 100–1000 Hz)': () => fastTrack(y5, FS),
  'lab trackPitch (YIN-lite @12 kHz, 5 ms hop)': () => f0PerSample(y5, FS),
  'tanh 1x (naive)': () => softClip(y5, FS, { drive: 3, os: 1 }),
  'tanh ADAA-1 1x': () => softClipAdaa(y5, FS, { drive: 3 }),
  'tanh 2x half-band 31 taps': () => softClipHalfband(y5, FS, { drive: 3, taps: 31 }),
  'tanh 2x production sinc (resampleOffline ×2, ×½)': () => softClip(y5, FS, { drive: 3, os: 2 }),
  'nasal EQ (5 biquads)': () => nasal(y5, FS),
  'AM 70 Hz': () => ringMod(y5, FS, { fc: AM_HZ, mix: AM_MIX }),
  'stage A: fastTrack + sub + nasal + ADAA': () => stageA(y5),
  'stage C: AM + nasal + ADAA (no tracker)': () => stageC(y5),
};
for (const [k, fn] of Object.entries(T)) console.log(`${k.padEnd(52)} ${time(fn).toFixed(1).padStart(7)} ms`);

// ---- the whole chain as production would run it, with the duck stage after the resample -------------------------
const { clipDetect, resample, isVoiced, applyGain, fades, envelope } = voiceStages;
const duckChain = (pcm, p, stage) => {
  clipDetect(pcm);
  const x = hpfTrim(pcm, FS, false);
  const y = resample(x, p);
  const voiced = isVoiced(y, FS);
  const z = stage(y);
  applyGain(z, FS, voiced);
  fades(z, FS);
  envelope(z, FS, p);
  return z;
};
console.log('\n## Whole chain per 5 s clip (ms) and per second of input audio (ms/s)');
for (const [name, fn] of Object.entries({
  'processVoice cub p=1.6': () => processVoice(x5, FS, { id: 'cub', pitchRatio: 1.6 }, { noTrim: true }),
  'processVoice bigbear p=0.75': () => processVoice(x5, FS, { id: 'bigbear', pitchRatio: 0.75 }, { noTrim: true }),
  'duck chain p=1.4, stage A': () => duckChain(x5, 1.4, stageA),
  'duck chain p=1.4, stage C': () => duckChain(x5, 1.4, stageC),
  'duck chain p=1.25, stage A': () => duckChain(x5, 1.25, stageA),
})) {
  const ms = time(fn);
  console.log(`${name.padEnd(36)} ${ms.toFixed(1).padStart(7)} ms   ${(ms / 5).toFixed(1).padStart(5)} ms/s`);
}

// ---- aliasing of the waveshaper variants -------------------------------------------------------------------------
console.log('\n## Waveshaper alias energy (dB re total; tone amplitude 0.5, drive 3)');
for (const [name, st] of Object.entries({
  'tanh 1x naive': (x) => softClip(x, FS, { drive: 3, os: 1 }),
  'tanh ADAA-1': (x) => softClipAdaa(x, FS, { drive: 3 }),
  'tanh 2x half-band 31': (x) => softClipHalfband(x, FS, { drive: 3, taps: 31 }),
  'tanh 2x production sinc': (x) => softClip(x, FS, { drive: 3, os: 2 }),
  'tanh 4x production sinc': (x) => softClip(x, FS, { drive: 3, os: 4 }),
})) {
  console.log(name.padEnd(28), [2000, 5000, 9000].map((f) => `${f} Hz ${aliasDbV2(st, FS, f).toFixed(1)}`).join('   '));
}

// ---- how much buzz each stage adds on a steady harmonic complex ---------------------------------------------------
console.log('\n## Added (inharmonic) energy share on a harmonic complex, dB re total (higher = more buzz/rasp)');
for (const f0 of [200, 420]) {
  const row = {
    'none (linear EQ)': addedDb((x) => nasal(x, FS), FS, f0),
    'sub f0/2 depth 0.45': addedDb((x, t) => pitchSyncMod(x, FS, t, { mode: 'sub', depth: 0.45 }), FS, f0),
    'AM 70 Hz mix 0.35': addedDb((x) => ringMod(x, FS, { fc: 70, mix: 0.35 }), FS, f0),
    'stage A (track given)': addedDb((x, t) => softClipAdaa(nasal(pitchSyncMod(x, FS, t, { depth: DEPTH }), FS), FS, { drive: DRIVE }), FS, f0),
    'stage C': addedDb((x) => stageC(x), FS, f0),
  };
  console.log(`f0 ${f0} Hz:`, Object.entries(row).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' | '));
}

// ---- intelligibility proxy for the two stages and three pitch ratios, all sentences and child-like (pitch 99) ----
console.log('\n## STOI vs sinc(p) reference: mean / min, all 40 sentence renders and the pitch-99 subset');
for (const p of [1.25, 1.4, 1.6]) {
  for (const [name, st] of Object.entries({ A: stageA, C: stageC })) {
    const vals = [];
    const child = [];
    let cen = 0;
    for (const s of sentences) {
      const ref = sinc(s.x, p);
      const out = st(ref);
      const v = stoi(ref, out, FS);
      vals.push(v);
      if (s.pitch === 99) child.push(v);
      cen += centroid(out, FS) - centroid(ref, FS);
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(`p=${p} stage ${name}: STOI ${mean(vals).toFixed(3)} / min ${Math.min(...vals).toFixed(3)}  (pitch 99: ${mean(child).toFixed(3)} / ${Math.min(...child).toFixed(3)}, n=${child.length})  centroid +${(cen / sentences.length).toFixed(0)} Hz`);
  }
}

// ---- determinism: the same input twice gives bit-identical output ---------------------------------------------------
const a = duckChain(x5, 1.4, stageA);
const b = duckChain(x5, 1.4, stageA);
let same = a.length === b.length;
for (let i = 0; same && i < a.length; i++) same = Object.is(a[i], b[i]);
console.log(`\n## Determinism: stage A chain twice on the 5 s clip → ${same ? 'bit-identical' : 'DIFFERENT'}`);
