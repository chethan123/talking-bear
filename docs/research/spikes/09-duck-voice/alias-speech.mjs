// Throwaway spike, round 3: aliasing of the waveshaper on speech. Reference = the same stage with tanh at 8×
// oversampling (production sinc kernel); alias residual = (stage − reference), in dB re the reference, over the
// 5 s TTS clip. Also the residual in the 1–5 kHz band where it is most audible.
import { readFileSync } from 'node:fs';
import { readWav } from '../../../../test/wav.ts';
import { resampleOffline } from '../../../../src/dsp/resample.ts';
import { hpfTrim } from '../../../../src/dsp/voice.ts';
import { biquadInPlace, nasal, rbj, ringMod, softClip, softClipAdaa } from './duck-lib.mjs';
const FS = 48000;
const manifest = JSON.parse(readFileSync('test/corpus/speech/manifest.json', 'utf8'));
const sents = manifest.filter((m) => m.kind === 'sentence').map((m) => { const w = readWav(readFileSync(`test/corpus/speech/${m.file}`)); return resampleOffline(w.channels[0], FS / w.sampleRate); });
const x = new Float32Array(5 * FS); let o = 0;
for (const s of sents) { if (o >= x.length) break; const n = Math.min(s.length, x.length - o); x.set(s.subarray(0, n), o); o += n + 4800; }
const y = resampleOffline(hpfTrim(x, FS, false), 1 / 1.4);
const pre = nasal(ringMod(y, FS, { fc: 70, mix: 0.35 }), FS);
const energy = (a) => a.reduce((s, v) => s + v * v, 0);
const band = (a) => { const b = Float32Array.from(a); biquadInPlace(b, rbj('hp', FS, 1000, 0.707)); biquadInPlace(b, rbj('hp', FS, 1000, 0.707)); biquadInPlace(b, rbj('lp', FS, 5000, 0.707)); biquadInPlace(b, rbj('lp', FS, 5000, 0.707)); return b; };
for (const drive of [1.5, 2.0, 2.5, 3.0]) {
  const ref = softClip(pre, FS, { drive, os: 8 });
  for (const [name, out] of [['naive 1x', softClip(pre, FS, { drive, os: 1 })], ['ADAA-1', softClipAdaa(pre, FS, { drive })], ['sinc 2x', softClip(pre, FS, { drive, os: 2 })]]) {
    // ADAA has a half-sample delay; align by trying 0 and 0.5-sample (via 2x interpolation is overkill): compare after a 1-sample average of ref
    let refA = ref;
    if (name === 'ADAA-1') { refA = new Float32Array(ref.length); for (let i = 1; i < ref.length; i++) refA[i] = 0.5 * (ref[i] + ref[i - 1]); }
    const d = out.map((v, i) => v - refA[i]);
    const all = 10 * Math.log10(energy(d) / energy(refA));
    const mid = 10 * Math.log10(energy(band(d)) / energy(band(refA)));
    console.log(`drive ${drive} ${name.padEnd(9)} residual vs 8x: whole ${all.toFixed(1)} dB, 1–5 kHz ${mid.toFixed(1)} dB`);
  }
}
