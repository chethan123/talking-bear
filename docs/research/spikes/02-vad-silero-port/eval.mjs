import { readWav16, JsSilero, pinkNoise, rng, gauss, rms } from './lib.mjs';
import { EnergyVad, biquad } from './energy.mjs';
import { Segmenter } from './segmenter.mjs';
import { WebrtcVad } from 'auditok-webrtcvad';
process.env.ONNX = './silero-vad/src/silero_vad/data/silero_vad_16k_op15.onnx';
const { INITS: I } = await import('./onnxinit.mjs');
const g = n => I[n].data;
const SW = { 'stft_conv.weight': g('model.stft.forward_basis_buffer'), 'conv1.weight': g('model.encoder.0.reparam_conv.weight'), 'conv1.bias': g('model.encoder.0.reparam_conv.bias'), 'conv2.weight': g('model.encoder.1.reparam_conv.weight'), 'conv2.bias': g('model.encoder.1.reparam_conv.bias'), 'conv3.weight': g('model.encoder.2.reparam_conv.weight'), 'conv3.bias': g('model.encoder.2.reparam_conv.bias'), 'conv4.weight': g('model.encoder.3.reparam_conv.weight'), 'conv4.bias': g('model.encoder.3.reparam_conv.bias'), 'lstm_cell.weight_ih': g('model.decoder.rnn.weight_ih'), 'lstm_cell.weight_hh': g('model.decoder.rnn.weight_hh'), 'lstm_cell.bias_ih': g('model.decoder.rnn.bias_ih'), 'lstm_cell.bias_hh': g('model.decoder.rnn.bias_hh'), 'final_conv.weight': g('model.decoder.decoder.2.weight'), 'final_conv.bias': g('model.decoder.decoder.2.bias') };
const FS = 16000;
const speech = readWav16('./silero-vad/tests/data/test.wav').x;
const tv = readWav16('./silero-vad/examples/c++/aepyx.wav').x;
// --- energy oracle on clean speech
const H = 160, nF = Math.floor(speech.length/H), eC = new Float32Array(nF);
for (let i=0;i<nF;i++){ let s=0; for (let k=0;k<H;k++){ const v=speech[i*H+k]; s+=v*v; } eC[i]=10*Math.log10(s/H+1e-12); }
const p95 = [...eC].sort((a,b)=>a-b)[Math.floor(nF*0.95)], thr = p95 - 35;
let segs=[], st=-1, gap=0; for (let i=0;i<nF;i++){ if (eC[i]>thr){ if(st<0) st=i; gap=0; } else if (st>=0){ gap++; if (gap>=30){ segs.push([st,i-gap]); st=-1; gap=0; } } }
segs = segs.filter(([a,b]) => (b-a+1) >= 30 && (b-a+1) <= 1000 && a >= 10);
let act=0, cnt=0; for (const [a,b] of segs) for (let i=a;i<=b;i++) if (eC[i]>thr) { act += Math.pow(10,eC[i]/10); cnt++; }
const speechDb = 10*Math.log10(act/cnt);
// --- build fixture: 3 s lead-in, then clip (with 100 ms margins) + 3 s gap
function build(noise, withSpeech = true, durS = 60) {
  const parts = [], truth = []; let t = 3*FS;
  if (withSpeech) for (const [a,b] of segs) { const s0 = (a-10)*H, s1 = (b+11)*H; truth.push([t + 10*H, t + (b-a+1+10)*H]); parts.push([t, s0, s1]); t += (s1-s0) + 3*FS; }
  const len = withSpeech ? t : durS*FS; const y = new Float32Array(len);
  for (const [t0, s0, s1] of parts) y.set(speech.subarray(s0, s1), t0);
  const nz = noise(len); for (let i=0;i<len;i++) y[i] += nz[i];
  return { y, truth: truth.map(([a,b]) => [a/FS*1000, b/FS*1000]) };
}
const lvl = (x, db) => { const g = Math.pow(10, db/20)/rms(x); for (let i=0;i<x.length;i++) x[i]*=g; return x; };
const pink = (db, seed=7) => n => lvl(pinkNoise(n, seed), db);
const modPink = (db) => n => { const x = lvl(pinkNoise(n, 11), db); const r = rng(5); let gtar = 1, gcur = 1; for (let i=0;i<n;i++){ if (i % (FS/2) === 0) gtar = Math.pow(10, (gauss(r)*6)/20); gcur += (gtar-gcur)*0.0002; x[i]*=gcur; } return x; };
const tvN = (db) => n => { const lp = biquad('lp', 4000, FS), lp2 = biquad('lp', 4000, FS); const x = new Float32Array(n); for (let i=0;i<n;i++) x[i] = lp2(lp(tv[(i + 20*FS) % tv.length])); lvl(x, db); const p = pink(-70)(n); for (let i=0;i<n;i++) x[i]+=p[i]; return x; };
const knocks = (db) => n => { const x = pink(-60)(n); const r = rng(3); let t = FS; while (t < n - FS) { const L = Math.round(0.04*FS), A = Math.pow(10, db/20)*3; for (let i=0;i<L;i++) x[t+i] += A*gauss(r)*Math.exp(-i/(0.008*FS)); t += Math.round((2 + 2*r())*FS); } return x; };
// --- detectors
function runEnergy(y, opt, segOpt) { const v = new EnergyVad(FS, opt), sg = new Segmenter(10, segOpt); for (let i=0;i+160<=y.length;i+=160){ const r = v.frame(y.subarray(i,i+160)); sg.push(i/FS*1000, r.active, r.inactive, r.voiced > 0.5); v.setSpeaking(sg.speaking); } sg.finish(y.length/FS*1000); return sg; }
async function runFvad(y, mode, segOpt) { const v = await WebrtcVad.create(mode, FS), sg = new Segmenter(30, segOpt); const b = new Int16Array(480);
  for (let i=0;i+480<=y.length;i+=480){ for (let k=0;k<480;k++) b[k] = Math.max(-32768, Math.min(32767, Math.round(y[i+k]*32767))); const s = v.isSpeech(b); sg.push(i/FS*1000, s, !s); } sg.finish(y.length/FS*1000); v.destroy(); return sg; }
function runSilero(y, pos, neg, segOpt) { const m = new JsSilero(SW), sg = new Segmenter(32, segOpt); for (let i=0;i+512<=y.length;i+=512){ const p = m.process(y.subarray(i,i+512)); sg.push(i/FS*1000, p >= pos, p < neg); } sg.finish(y.length/FS*1000); return sg; }
function score(sg, truth, durMs) {
  const out = { hit: 0, split: 0, endLat: [], onLat: [], fp: 0, forced: 0 };
  for (const [ts, te] of truth) { const ov = sg.segs.filter(s => s.end > ts - 200 && s.start < te + 200); if (ov.length) { out.hit++; if (ov.length > 1) out.split++; out.endLat.push(ov[ov.length-1].end - te); out.onLat.push(ov[0].confirm - ts); } }
  for (const s of sg.segs) { if (s.forced) out.forced++; if (!truth.some(([ts,te]) => s.end > ts - 200 && s.start < te + 200)) out.fp++; }
  const q = (a, p) => a.length ? [...a].sort((x,y)=>x-y)[Math.min(a.length-1, Math.floor(p*a.length))] : NaN;
  return truth.length ? `hit ${out.hit}/${truth.length} split ${out.split} fp ${out.fp} forced ${out.forced} | onset(confirm) med ${q(out.onLat,.5).toFixed(0)} | EoS lat med ${q(out.endLat,.5).toFixed(0)} p90 ${q(out.endLat,.9).toFixed(0)} ms`
                      : `false triggers/min ${(sg.segs.length/(durMs/60000)).toFixed(1)} (forced ${out.forced}, misfires ${sg.misfires})`;
}
const segOpt = { hangoverMs: 500, minSpeechMs: 150, maxMs: 10000 };
const detectors = [
  ['energy-ema',      y => runEnergy(y, { mode: 'ema' }, segOpt)],
  ['energy-minstat',  y => runEnergy(y, { mode: 'minstats' }, segOpt)],
  ['energy-ema+voic', y => runEnergy(y, { mode: 'ema' }, { ...segOpt, minVoicedMs: 60 })],
  ['fvad-m1',         y => runFvad(y, 1, segOpt)],
  ['fvad-m3',         y => runFvad(y, 3, segOpt)],
  ['silero-v6 .5/.35',y => runSilero(y, 0.5, 0.35, segOpt)],
];
const S = speechDb;
console.log(`clips=${segs.length} (durations ${segs.map(([a,b])=>((b-a+1)/100).toFixed(1)).join(',')} s), speech active level ${S.toFixed(1)} dBFS`);
const conds = [['quiet (pink -70)', pink(-70)], ['fan SNR20', pink(S-20)], ['fan SNR10', pink(S-10)], ['fan SNR5', pink(S-5)], ['fan SNR0', pink(S)], ['modulated fan SNR10', modPink(S-10)], ['TV speech SNR10', tvN(S-10)], ['knocks', knocks(S)]];
if (!process.env.SWEEP) for (const [name, nz] of conds) { const f = build(nz, true); console.log(`\n== speech + ${name}`); for (const [dn, fn] of detectors) console.log(`  ${dn.padEnd(18)} ${score(await fn(f.y), f.truth, f.y.length/FS*1000)}`); }
if (!process.env.SWEEP) for (const [name, nz] of conds.slice(1)) { const f = build(nz, false, 60); console.log(`\n== noise only: ${name}`); for (const [dn, fn] of detectors) console.log(`  ${dn.padEnd(18)} ${score(await fn(f.y), [], 60000)}`); }

if (process.env.SWEEP) {
  for (const [name, nz] of [conds[0], conds[2], conds[3], conds[5]]) { const f = build(nz, true); console.log(`\n== sweep hangover: speech + ${name}`);
    for (const ho of [200, 300, 400, 600, 800]) { const so = { ...segOpt, hangoverMs: ho };
      console.log(`  ho=${ho} silero .5/.35: ${score(runSilero(f.y, 0.5, 0.35, so), f.truth, 0)}`);
      console.log(`  ho=${ho} silero .3/.25: ${score(runSilero(f.y, 0.3, 0.25, so), f.truth, 0)}`);
      console.log(`  ho=${ho} energy-ema+v : ${score(runEnergy(f.y, { mode: 'ema' }, { ...so, minVoicedMs: 60 }), f.truth, 0)}`); } }
}
