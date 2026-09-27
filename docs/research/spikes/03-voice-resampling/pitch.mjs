import { createRequire } from 'module';
import { SR, synthVoice, bench, bandEnergy } from './dsp.mjs';
import { wsolaPitch, psola, trackPitch, resamplePitch, linearRate } from './algos.mjs';
import { SoundTouch, registerInterpolationStrategy } from '@soundtouchjs/core';
import { registerLinearStrategy } from '@soundtouchjs/interpolation-strategy-linear';
registerLinearStrategy({ registerInterpolationStrategy });
import { SoundTouch as LegacySoundTouch } from 'soundtouchjs';
import { createPhaseVocoderFactory } from '@soundtouchjs/stretch-phase-vocoder';
const require = createRequire(import.meta.url);

const SECS = 5;
const x = synthVoice(SECS);

// ---- SoundTouch (core 2.1.1, MPL) offline wrapper: mono duplicated to interleaved stereo (engine is stereo-only)
function stCore(x, r, opts = {}) {
  const st = new SoundTouch({ sampleRate: SR, sampleBufferType: opts.fifo ? 'fifo' : 'circular', ...(opts.linear ? { interpolationStrategy: 'linear' } : {}), ...(opts.pv ? { stretchFactory: createPhaseVocoderFactory(opts.pvSize || 2048, 4) } : {}) });
  st.pitch = r;
  const B = 4096, inter = new Float32Array(B * 2), outChunks = []; let outLen = 0;
  const tmp = new Float32Array(16384 * 2);
  const drain = () => {
    let n; while ((n = st.outputBuffer.frameCount) > 0) {
      const k = Math.min(n, 16384); st.outputBuffer.extract(tmp, 0, k); st.outputBuffer.receive(k);
      const m = new Float32Array(k); for (let i = 0; i < k; i++) m[i] = tmp[2 * i]; outChunks.push(m); outLen += k;
    }
  };
  for (let s = 0; s < x.length + 3 * B; s += B) {
    for (let i = 0; i < B; i++) { const v = x[s + i] || 0; inter[2 * i] = v; inter[2 * i + 1] = v; }
    st.inputBuffer.putSamples(inter, 0, B); st.process();
    if (opts.pv) { let guard = 0; while (st.stretch.inputBuffer && st.stretch.inputBuffer.frameCount >= st.stretch.sampleReq && guard++ < 1000) st.process(); }
    drain();
  }
  const y = new Float32Array(outLen); let o = 0; for (const c of outChunks) { y.set(c, o); o += c.length; }
  return y.subarray(0, x.length);
}
// ---- legacy soundtouchjs 0.3.0 (LGPL-2.1); its Stretch assumes 44.1 kHz internally
function stLegacy(x, r) {
  const st = new LegacySoundTouch(); st.pitch = r;
  const B = 4096, inter = new Float32Array(B * 2), out = new Float32Array((x.length + 4 * B) * 2); let got = 0;
  for (let s = 0; s < x.length + 3 * B; s += B) {
    for (let i = 0; i < B; i++) { const v = x[s + i] || 0; inter[2 * i] = v; inter[2 * i + 1] = v; }
    st.inputBuffer.putSamples(inter, 0, B); st.process();
    const n = st.outputBuffer.frameCount; const tmp = new Float32Array(n * 2); st.outputBuffer.receiveSamples(tmp, n);
    out.set(tmp.subarray(0, Math.min(tmp.length, out.length - got * 2)), got * 2); got += n;
  }
  const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = out[2 * i]; return y;
}

// ---- Signalsmith Stretch 1.3.2 (MIT) via raw WASM exports (same calls its AudioWorklet makes)
const SSFactory = require('./ss_module.cjs');
const ss = await SSFactory();
ss._main?.();
function signalsmith(x, r, { formantComp = false, formantSemis = 0, cheaper = false, formantBaseHz = 0 } = {}) {
  if (cheaper) ss._presetCheaper(1, SR); else ss._presetDefault(1, SR);
  const inLat = ss._inputLatency(), outLat = ss._outputLatency();
  const B = 512;
  const ptr = ss._setBuffers(1, B);
  ss._setTransposeSemitones(12 * Math.log2(r), 8000 / SR);
  ss._setFormantSemitones(formantSemis, formantComp);
  ss._setFormantBase(formantBaseHz / SR);
  const total = x.length + inLat + outLat + B;
  const y = new Float32Array(total);
  for (let s = 0; s < total; s += B) {
    const mem = new Float32Array(ss.exports ? ss.exports.memory.buffer : ss.HEAP8.buffer);
    const inp = mem.subarray(ptr / 4, ptr / 4 + B), outp = mem.subarray(ptr / 4 + B, ptr / 4 + 2 * B);
    for (let i = 0; i < B; i++) inp[i] = x[s + i] || 0;
    ss._process(B, B);
    y.set(outp.subarray(0, Math.min(B, total - s)), s);
  }
  return y.subarray(inLat + outLat, inLat + outLat + x.length);
}

// ---- objective checks: duration, achieved f0 ratio (median), spectral centroid 300-6000 Hz ratio (formant proxy)
const f0In = trackPitch(x).f0;
const med = (a) => { const v = [...a].filter(q => q > 0).sort((p, q) => p - q); return v[v.length >> 1]; };
const f0InMed = med(f0In);
const medRatio = (y) => med(trackPitch(y).f0) / f0InMed;
import { fftReal } from './dsp.mjs';
const centroid = (y) => { // long-term spectrum of voiced frames only (sibilants excluded), centroid over 200-5000 Hz
  const { f0, hopSamples } = trackPitch(y); const n = 2048; const acc = new Float64Array(n / 2 + 1);
  for (let f = 0; f < f0.length; f++) { if (!(f0[f] > 0)) continue; const s0 = f * hopSamples; if (s0 + n > y.length) break;
    const re = new Float64Array(n), im = new Float64Array(n); for (let i = 0; i < n; i++) re[i] = y[s0 + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
    fftReal(re, im); for (let k = 0; k <= n / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k]; }
  let num = 0, den = 0; for (let k = 0; k <= n / 2; k++) { const fr = k * SR / n; if (fr < 200 || fr > 5000) continue; num += acc[k] * fr; den += acc[k]; } return num / den; };
const c0 = centroid(x);

const cases = [
  ['resample sinc8 (dur/r)', (x, r) => resamplePitch(x, r)],
  ['WSOLA(own)+sinc8', wsolaPitch],
  ['TD-PSOLA(own, incl. YIN)', (x, r) => psola(x, r)],
  ['@soundtouchjs/core 2.1.1', stCore],
  ['ST core fifo+linear interp', (x, r) => stCore(x, r, { fifo: true, linear: true })],
  ['soundtouchjs 0.3.0 legacy', stLegacy],
  ['ST core + phase vocoder 2048', (x, r) => stCore(x, r, { pv: true })],
  ['Signalsmith default', (x, r) => signalsmith(x, r)],
  ['Signalsmith cheaper', (x, r) => signalsmith(x, r, { cheaper: true })],
  ['Signalsmith +formantComp', (x, r) => signalsmith(x, r, { formantComp: true })],
];
console.log(`Desktop x86 (${process.version}), synthetic voice ${SECS} s mono @48k. ms = median of 5 runs for the whole clip.`);
console.log(`input spectral centroid (300-6000 Hz) = ${c0.toFixed(0)} Hz`);
const onlyTime = process.argv.includes('--time');
for (const r of [1.5, 2.0]) {
  for (const [name, fn] of cases) {
    let y;
    try { y = fn(x, r); } catch (e) { console.log(`r=${r} ${name}: ERROR ${e.message}`); continue; }
    const ms = bench(() => fn(x, r), 5);
    let pk = 0; for (const v of y) pk = Math.max(pk, Math.abs(v));
    const q = onlyTime ? '' : `dur ${(y.length / SR).toFixed(2)}s  f0x ${medRatio(y).toFixed(2)}  centroid x ${(centroid(y) / c0).toFixed(2)}  peak ${pk.toFixed(2)}`;
    console.log(`r=${r} ${name.padEnd(30)} ${ms.toFixed(1).padStart(7)} ms (${(ms / SECS).toFixed(1)} ms/s)  ${q}`);
  }
}
const t = bench(() => trackPitch(x), 5); console.log(`YIN-lite pitch track alone: ${t.toFixed(1)} ms`);
