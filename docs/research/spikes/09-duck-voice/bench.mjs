// Throwaway spike (duck-plan research, 2026-10-24). Run from the repo root with Node 24:
//   node docs/research/spikes/09-duck-voice/bench.mjs [--quick]
// Speech: the committed espeak-ng TTS corpus (test/corpus/speech, 16 kHz, synthetic voices only, plan Q2),
// upsampled to 48 kHz with the production sinc kernel. No real voice, nothing written to disk.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { readWav } from '../../../../test/wav.ts';
import { resampleOffline } from '../../../../src/dsp/resample.ts';
import { processVoice, hpfTrim } from '../../../../src/dsp/voice.ts';
import { voiceGainDb } from '../../../../src/dsp/normalize.ts';
import { psola } from '../../../../lab/algos/psola.ts';
import {
  aliasDb, centroid, f0PerSample, lpcBuzz, nasal, pitchSyncMod, ringMod, roughness, softClip, stoi,
} from './duck-lib.mjs';

const FS = 48000;
const quick = process.argv.includes('--quick');
const RUNS = quick ? 3 : 11;
const WARM = quick ? 1 : 3;

const manifest = JSON.parse(readFileSync('test/corpus/speech/manifest.json', 'utf8'));
const load = (file) => {
  const w = readWav(readFileSync(`test/corpus/speech/${file}`));
  return resampleOffline(w.channels[0], FS / w.sampleRate);
};
const sentences = manifest.filter((m) => m.kind === 'sentence').map((m) => ({ id: m.id, voice: m.voice, pitch: m.pitch, x: load(m.file) }));

// A 5 s clip: sentences concatenated (with 100 ms gaps) and cut to exactly 5 s at 48 kHz.
function clip5s() {
  const out = new Float32Array(5 * FS);
  let o = 0;
  for (const s of sentences) {
    if (o >= out.length) break;
    const n = Math.min(s.x.length, out.length - o);
    out.set(s.x.subarray(0, n), o);
    o += n + Math.round(0.1 * FS);
  }
  return out;
}
const x5 = clip5s();

function time(fn) {
  for (let i = 0; i < WARM; i++) fn();
  const t = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return { med: t[t.length >> 1], max: t[t.length - 1] };
}

const sinc = (x, p) => resampleOffline(hpfTrim(x, FS, false), 1 / p);
const P = 1.4; // the duck's pitch ratio under test

// ---- candidate transforms D(x) and their timing-matched clean reference R(x) ----------------------------------
const C = {
  'sinc p=1.6 (Bear cub)': { D: (x) => sinc(x, 1.6), R: (x) => sinc(x, 1.6) },
  'sinc p=1.4 (duck base)': { D: (x) => sinc(x, P), R: (x) => sinc(x, P) },
  '1 PSOLA pitch 1.8, formant 1.35': { D: (x) => psola(hpfTrim(x, FS, false), FS, 1.8, { formant: 1.35 }), R: (x) => hpfTrim(x, FS, false) },
  '2 ring mod 90 Hz, mix 0.5': { D: (x) => ringMod(sinc(x, P), FS, { fc: 90, mix: 0.5 }), R: (x) => sinc(x, P) },
  '2b ring mod 90 Hz, mix 1.0': { D: (x) => ringMod(sinc(x, P), FS, { fc: 90, mix: 1 }), R: (x) => sinc(x, P) },
  '3 nasal EQ': { D: (x) => nasal(sinc(x, P), FS), R: (x) => sinc(x, P) },
  '4 soft clip drive 3, 1x': { D: (x) => softClip(sinc(x, P), FS, { drive: 3, os: 1 }), R: (x) => sinc(x, P) },
  '4 soft clip drive 3, 2x': { D: (x) => softClip(sinc(x, P), FS, { drive: 3, os: 2 }), R: (x) => sinc(x, P) },
  '4 soft clip drive 3, 4x': { D: (x) => softClip(sinc(x, P), FS, { drive: 3, os: 4 }), R: (x) => sinc(x, P) },
  '5 subharmonic f0/2, depth 0.5': { D: (x) => { const y = sinc(x, P); return pitchSyncMod(y, FS, f0PerSample(y, FS), { mode: 'sub', depth: 0.5 }); }, R: (x) => sinc(x, P) },
  '5b pulse buzz at f0, depth 0.6': { D: (x) => { const y = sinc(x, P); return pitchSyncMod(y, FS, f0PerSample(y, FS), { mode: 'pulse', depth: 0.6, shape: 6 }); }, R: (x) => sinc(x, P) },
  '6 LPC-18 buzz 0.7 @16k': { D: (x) => { const y = sinc(x, P); return lpcBuzz(y, FS, f0PerSample(y, FS), { buzz: 0.7 }); }, R: (x) => sinc(x, P) },
  'DUCK-A: sub 0.45 + nasal + clip 2.5 (2x)': {
    D: (x) => { const y = sinc(x, P); const f = f0PerSample(y, FS); return softClip(nasal(pitchSyncMod(y, FS, f, { mode: 'sub', depth: 0.45 }), FS), FS, { drive: 2.5, os: 2 }); },
    R: (x) => sinc(x, P),
  },
  'DUCK-B: LPC buzz 0.6 + nasal': {
    D: (x) => { const y = sinc(x, P); return nasal(lpcBuzz(y, FS, f0PerSample(y, FS), { buzz: 0.6 }), FS); },
    R: (x) => sinc(x, P),
  },
  'DUCK-C: AM 70 Hz 0.35 + nasal + clip 2.5 (2x)': {
    D: (x) => softClip(nasal(ringMod(sinc(x, P), FS, { fc: 70, mix: 0.35 }), FS), FS, { drive: 2.5, os: 2 }),
    R: (x) => sinc(x, P),
  },
};

// ---- stage-only timing on the 5 s clip: the stage after the resample, on y = sinc(x5, P) ------------------------
const y5 = sinc(x5, P);
const f05 = f0PerSample(y5, FS);
const stageTimes = {
  'resample p=1.4 (production kernel)': time(() => resampleOffline(x5, 1 / P)),
  'processVoice p=1.6 (whole production chain)': time(() => processVoice(x5, FS, { id: 'cub', pitchRatio: 1.6 })),
  'pitch track (lab YIN-lite, fs/4, 5 ms hop)': time(() => f0PerSample(y5, FS)),
  'PSOLA 1.8 / formant 1.35 incl. its track': time(() => psola(x5, FS, 1.8, { formant: 1.35 })),
  'ring mod': time(() => ringMod(y5, FS)),
  'nasal EQ (5 biquads)': time(() => nasal(y5, FS)),
  'soft clip 1x': time(() => softClip(y5, FS, { os: 1 })),
  'soft clip 2x': time(() => softClip(y5, FS, { os: 2 })),
  'soft clip 4x': time(() => softClip(y5, FS, { os: 4 })),
  'pitch-sync mod (track given)': time(() => pitchSyncMod(y5, FS, f05, { mode: 'sub', depth: 0.5 })),
  'LPC-18 buzz @16k (track given)': time(() => lpcBuzz(y5, FS, f05)),
  'DUCK-A stage (track + sub + nasal + clip 2x)': time(() => { const f = f0PerSample(y5, FS); softClip(nasal(pitchSyncMod(y5, FS, f, { depth: 0.45 }), FS), FS, { drive: 2.5, os: 2 }); }),
  'DUCK-C stage (AM + nasal + clip 2x)': time(() => softClip(nasal(ringMod(y5, FS, { fc: 70, mix: 0.35 }), FS), FS, { drive: 2.5, os: 2 })),
};
console.log(`\n## CPU per 5 s clip at 48 kHz (median / max of ${RUNS} after ${WARM} warm-up), node ${process.version}, ${process.arch}`);
for (const [k, v] of Object.entries(stageTimes)) console.log(`${k.padEnd(48)} ${v.med.toFixed(1).padStart(7)} ms  (max ${v.max.toFixed(1)})`);

// ---- STOI proxy, roughness, centroid over the 20 sentences ------------------------------------------------------
const items = quick ? sentences.filter((_, i) => i % 4 === 0) : sentences;
console.log(`\n## Intelligibility proxy (STOI vs timing-matched reference), roughness share, centroid; n = ${items.length} sentences`);
console.log('candidate'.padEnd(48), 'STOI mean', ' min ', 'rough', 'centroid Hz');
const rows = {};
for (const [name, c] of Object.entries(C)) {
  let s = 0;
  let mn = 1;
  let r = 0;
  let cen = 0;
  for (const it of items) {
    const ref = c.R(it.x);
    const out = c.D(it.x);
    const v = stoi(ref, out, FS);
    s += v;
    mn = Math.min(mn, v);
    r += roughness(out, FS);
    cen += centroid(out, FS);
  }
  rows[name] = { stoi: s / items.length, min: mn, rough: r / items.length, cen: cen / items.length };
  console.log(name.padEnd(48), (s / items.length).toFixed(3).padStart(9), mn.toFixed(3).padStart(6), (r / items.length).toFixed(3).padStart(6), (cen / items.length).toFixed(0).padStart(8));
}

// ---- aliasing on pure tones ---------------------------------------------------------------------------------------
console.log('\n## Alias/noise energy outside k·f and (k+½)·f, dB re total, tone 0.5 FS');
const tones = [3000, 7000];
const aliasStages = {
  'ring mod 90 Hz, mix 1': (x) => ringMod(x, FS, { fc: 90, mix: 1 }),
  'nasal EQ': (x) => nasal(x, FS),
  'soft clip drive 3, 1x': (x) => softClip(x, FS, { drive: 3, os: 1 }),
  'soft clip drive 3, 2x': (x) => softClip(x, FS, { drive: 3, os: 2 }),
  'soft clip drive 3, 4x': (x) => softClip(x, FS, { drive: 3, os: 4 }),
  'soft clip drive 2.5, 2x': (x) => softClip(x, FS, { drive: 2.5, os: 2 }),
};
for (const [name, st] of Object.entries(aliasStages)) {
  console.log(name.padEnd(30), tones.map((f) => `${f} Hz: ${aliasDb(st, FS, f).toFixed(1)} dB`).join('   '));
}
// ring-mod sidebands at f ± 90 are by design: report the ring mod separately as "sidebands", not aliases.

// ---- loudness: what the −20 LUFS stage does after each duck stage --------------------------------------------------
console.log('\n## Gain the production loudness rule applies after the stage (voiced, 5 s clip)');
for (const [name, c] of Object.entries(C)) {
  const out = c.D(x5);
  console.log(name.padEnd(48), `${voiceGainDb(out, FS, true).toFixed(2)} dB`);
}
