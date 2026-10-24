// Round 4: STOI on T115's 10 sentences for the revised stage (4 LPF sections at 5 kHz) at every corner of the bounds.
import { readFileSync } from 'node:fs';
import { resampleOffline } from '../../../../src/dsp/resample.ts';
import { hpfTrim } from '../../../../src/dsp/voice.ts';
import { readWav } from '../../../../test/wav.ts';
import { stoi } from './duck-lib.mjs';
import { stage } from './alias-onset.mjs';
const FS = 48000;
const man = JSON.parse(readFileSync('test/corpus/speech/manifest.json', 'utf8'));
const S = ['00', '01', '02', '03', '04'].flatMap((k) => ['r0', 'r1'].map((r) => { const m = man.find((q) => q.id === `sentence-${k}-${r}`); const w = readWav(readFileSync('test/corpus/speech/' + m.file)); return resampleOffline(w.channels[0], FS / w.sampleRate); }));
let worst = 1, wat = '', worstMean = 1, wmat = '';
for (const p of [1.3, 1.45, 1.6]) for (const amHz of [60, 70, 80]) for (const amMix of [0.2, 0.4]) for (const peak1Db of [6, 12]) {
  const v = S.map((x) => { const ref = resampleOffline(hpfTrim(x, FS, false), 1 / p); return stoi(ref, stage(ref, FS, { amHz, amMix, peak1Db, lpHz: 5000, sections: 4 }), FS); });
  const mean = v.reduce((a, b) => a + b) / v.length, mn = Math.min(...v);
  if (mean < worstMean) { worstMean = mean; wmat = `p ${p} amHz ${amHz} amMix ${amMix} peak1Db ${peak1Db}`; }
  if (mn < worst) { worst = mn; wat = `p ${p} amHz ${amHz} amMix ${amMix} peak1Db ${peak1Db} (mean ${mean.toFixed(3)})`; }
  if (false) console.log(`p ${p} amHz ${amHz} amMix ${amMix} peak1Db ${peak1Db}: mean ${mean.toFixed(3)} min ${mn.toFixed(3)}`);
}
console.log('worst mean', worstMean.toFixed(3), 'at', wmat);
console.log('worst min', worst.toFixed(3), 'at', wat);
const d = S.map((x) => { const ref = resampleOffline(hpfTrim(x, FS, false), 1 / 1.45); return stoi(ref, stage(ref, FS, { lpHz: 5000, sections: 4 }), FS); });
console.log('DUCK p1.45', (d.reduce((a, b) => a + b) / d.length).toFixed(3), Math.min(...d).toFixed(3), 'sentence-00-r0', d[0].toFixed(4));
