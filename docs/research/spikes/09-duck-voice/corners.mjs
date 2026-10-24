import { readFileSync } from 'node:fs';
const R = new URL('../../../../', import.meta.url).pathname;
const { readWav } = await import(R + 'test/wav.ts');
const { resampleOffline } = await import(R + 'src/dsp/resample.ts');
const { hpfTrim } = await import(R + 'src/dsp/voice.ts');
const L = await import(R + 'docs/research/spikes/09-duck-voice/duck-lib.mjs');
const FS = 48000;
const man = JSON.parse(readFileSync(R + 'test/corpus/speech/manifest.json', 'utf8'));
const ids = ['sentence-00-r0','sentence-00-r1','sentence-01-r0','sentence-01-r1','sentence-02-r0','sentence-02-r1','sentence-03-r0','sentence-03-r1','sentence-04-r0','sentence-04-r1'];
const S = ids.map((id) => { const m = man.find((q) => q.id === id); const w = readWav(readFileSync(R + 'test/corpus/speech/' + m.file)); return resampleOffline(w.channels[0], FS / w.sampleRate); });
const stage = (y, d) => L.cubicShape(L.nasal4(L.ringMod(y, FS, { fc: d.amHz, mix: d.amMix }), FS, { ...L.NASAL4, peak1Db: d.peak1Db }));
const run = (p, d) => { const v = S.map((x) => { const ref = resampleOffline(hpfTrim(x, FS, false), 1 / p); return L.stoi(ref, stage(ref, d), FS); }); return [v.reduce((a, b) => a + b) / v.length, Math.min(...v)]; };
for (const p of [1.3, 1.6]) for (const amMix of [0.4]) for (const amHz of [60, 90]) for (const peak1Db of [6, 12]) {

  const [m, mn] = run(p, { amHz, amMix, peak1Db });
  console.log(`p ${p} amHz ${amHz} amMix ${amMix} peak1Db ${peak1Db}: mean ${m.toFixed(3)} min ${mn.toFixed(3)}`);
}
