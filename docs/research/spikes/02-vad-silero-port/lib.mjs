import fs from 'fs';
export function readWav16(path) {
  const b = fs.readFileSync(path); let o = 12, sr = 0, data = null;
  while (o < b.length) { const id = b.toString('ascii', o, o+4); const sz = b.readUInt32LE(o+4);
    if (id === 'fmt ') sr = b.readUInt32LE(o+12);
    if (id === 'data') { data = new Int16Array(b.buffer.slice(b.byteOffset+o+8, b.byteOffset+o+8+sz)); }
    o += 8 + sz + (sz & 1); }
  const f = new Float32Array(data.length); for (let i=0;i<data.length;i++) f[i]=data[i]/32768; return { sr, x: f };
}
// ---------- hand-written Silero (16k) from safetensors ----------
export function loadSafetensors(path) {
  const b = fs.readFileSync(path); const n = Number(b.readBigUInt64LE(0)); const h = JSON.parse(b.slice(8, 8+n).toString());
  const base = 8 + n; const W = {};
  for (const [k, v] of Object.entries(h)) { if (k === '__metadata__') continue; const [s, e] = v.data_offsets;
    W[k] = new Float32Array(b.buffer.slice(b.byteOffset + base + s, b.byteOffset + base + e)); W[k].shape = v.shape; }
  return W;
}
export class JsSilero {
  constructor(W) { this.W = W; this.h = new Float32Array(128); this.c = new Float32Array(128); this.ctx = new Float32Array(64);
    this.buf = new Float32Array(640); this.mag = new Float32Array(129*4); this.a1 = new Float32Array(128*4); this.a2 = new Float32Array(64*2);
    this.a3 = new Float32Array(64); this.a4 = new Float32Array(128); this.g = new Float32Array(512); }
  reset() { this.h.fill(0); this.c.fill(0); this.ctx.fill(0); }
  process(frame512) {
    const W = this.W, buf = this.buf; buf.set(this.ctx, 0); buf.set(frame512, 64);
    for (let j = 0; j < 64; j++) buf[576 + j] = buf[576 - 2 - j]; // reflect pad right
    this.ctx.set(frame512.subarray(448));
    const sw = W['stft_conv.weight'], mag = this.mag;
    for (let t = 0; t < 4; t++) { const off = t*128;
      for (let f = 0; f < 129; f++) { let re = 0, im = 0; const wr = f*256, wi = (f+129)*256;
        for (let k = 0; k < 256; k++) { const s = buf[off+k]; re += sw[wr+k]*s; im += sw[wi+k]*s; }
        mag[f*4+t] = Math.sqrt(re*re + im*im); } }
    conv1d(mag, 129, 4, W['conv1.weight'], W['conv1.bias'], 128, 1, this.a1);
    conv1d(this.a1, 128, 4, W['conv2.weight'], W['conv2.bias'], 64, 2, this.a2);
    conv1d(this.a2, 64, 2, W['conv3.weight'], W['conv3.bias'], 64, 2, this.a3);
    conv1d(this.a3, 64, 1, W['conv4.weight'], W['conv4.bias'], 128, 1, this.a4);
    const x = this.a4, h = this.h, c = this.c, g = this.g, wi = W['lstm_cell.weight_ih'], wh = W['lstm_cell.weight_hh'], bi = W['lstm_cell.bias_ih'], bh = W['lstm_cell.bias_hh'];
    for (let r = 0; r < 512; r++) { let s = bi[r] + bh[r]; const o = r*128; for (let k = 0; k < 128; k++) s += wi[o+k]*x[k] + wh[o+k]*h[k]; g[r] = s; }
    const sig = v => 1/(1+Math.exp(-v));
    for (let k = 0; k < 128; k++) { const i = sig(g[k]), f = sig(g[128+k]), gg = Math.tanh(g[256+k]), o = sig(g[384+k]);
      c[k] = f*c[k] + i*gg; h[k] = o*Math.tanh(c[k]); }
    let s = W['final_conv.bias'][0]; const fw = W['final_conv.weight']; for (let k = 0; k < 128; k++) s += fw[k]*Math.max(0, h[k]);
    return sig(s);
  }
}
function conv1d(inp, cin, tin, w, b, cout, stride, out) { // k=3, pad=1, relu
  const tout = Math.floor((tin + 2 - 3)/stride) + 1;
  for (let o = 0; o < cout; o++) for (let t = 0; t < tout; t++) { let s = b[o];
    for (let i = 0; i < cin; i++) { const wo = (o*cin + i)*3, io = i*tin;
      for (let k = 0; k < 3; k++) { const ti = t*stride + k - 1; if (ti >= 0 && ti < tin) s += w[wo+k]*inp[io+ti]; } }
    out[o*tout + t] = s > 0 ? s : 0; }
}
// ---------- ORT Silero ----------
export async function makeOrtSilero(ort, path) {
  const sess = await ort.InferenceSession.create(fs.readFileSync(path), { executionProviders: ['wasm'] });
  let state = new ort.Tensor('float32', new Float32Array(256), [2,1,128]); const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]));
  let ctx = new Float32Array(64);
  return { async process(fr) { const x = new Float32Array(576); x.set(ctx); x.set(fr, 64); ctx = fr.slice(448);
      const feeds = { input: new ort.Tensor('float32', x, [1,576]), state }; if (sess.inputNames.includes('sr')) feeds.sr = sr;
      const o = await sess.run(feeds); state = o.stateN; return o.output.data[0]; },
    reset() { state = new ort.Tensor('float32', new Float32Array(256), [2,1,128]); ctx = new Float32Array(64); } };
}
// ---------- noise ----------
export function rng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
export function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
export function pinkNoise(n, seed=1) { // Paul Kellet filter
  const r = rng(seed); const y = new Float32Array(n); let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for (let i=0;i<n;i++){ const w = gauss(r); b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759; b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856; b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980; y[i]=b0+b1+b2+b3+b4+b5+b6+w*0.5362; b6=w*0.115926; }
  return y;
}
export function rms(x) { let s=0; for (const v of x) s+=v*v; return Math.sqrt(s/x.length); }
export function scaleTo(x, dbfs) { const g = Math.pow(10, dbfs/20)/rms(x); const y = new Float32Array(x.length); for (let i=0;i<x.length;i++) y[i]=x[i]*g; return y; }
export function add(a, b) { const y = new Float32Array(a.length); for (let i=0;i<a.length;i++) y[i]=a[i]+(b[i]||0); return y; }
