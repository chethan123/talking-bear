import fs from 'fs'; import zlib from 'zlib';
import { readWav16, JsSilero } from './lib.mjs';
process.env.ONNX = './silero-vad/src/silero_vad/data/silero_vad_16k_op15.onnx';
const { INITS: I } = await import('./onnxinit.mjs');
const names = { 'stft_conv.weight':'model.stft.forward_basis_buffer','conv1.weight':'model.encoder.0.reparam_conv.weight','conv1.bias':'model.encoder.0.reparam_conv.bias','conv2.weight':'model.encoder.1.reparam_conv.weight','conv2.bias':'model.encoder.1.reparam_conv.bias','conv3.weight':'model.encoder.2.reparam_conv.weight','conv3.bias':'model.encoder.2.reparam_conv.bias','conv4.weight':'model.encoder.3.reparam_conv.weight','conv4.bias':'model.encoder.3.reparam_conv.bias','lstm_cell.weight_ih':'model.decoder.rnn.weight_ih','lstm_cell.weight_hh':'model.decoder.rnn.weight_hh','lstm_cell.bias_ih':'model.decoder.rnn.bias_ih','lstm_cell.bias_hh':'model.decoder.rnn.bias_hh','final_conv.weight':'model.decoder.decoder.2.weight','final_conv.bias':'model.decoder.decoder.2.bias' };
const W = {}; let tot = 0; for (const [k, o] of Object.entries(names)) { W[k] = I[o].data; tot += W[k].length; }
const all = new Float32Array(tot); let off = 0; for (const k in W) { all.set(W[k], off); off += W[k].length; }
const noStft = all.subarray(W['stft_conv.weight'].length);
const f16 = a => { const u = new Uint16Array(a.length); const f = new Float32Array(1), i = new Uint32Array(f.buffer); for (let j=0;j<a.length;j++){ f[0]=a[j]; const x=i[0]; const s=(x>>>16)&0x8000; let e=((x>>>23)&0xff)-127+15; let m=(x>>>13)&0x3ff; if (e<=0){ u[j]=s; } else if (e>=31){ u[j]=s|0x7c00; } else { const r=(x>>>12)&1; let v=s|(e<<10)|m; if (r) v++; u[j]=v; } } return u; };
const unf16 = u => { const out = new Float32Array(u.length); for (let j=0;j<u.length;j++){ const h=u[j], s=(h&0x8000)?-1:1, e=(h>>10)&0x1f, m=h&0x3ff; out[j] = e===0 ? s*m*Math.pow(2,-24) : s*(1+m/1024)*Math.pow(2,e-15); } return out; };
const sz = (name, buf) => { const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength); console.log(`${name}: raw ${b.length} gzip9 ${zlib.gzipSync(b,{level:9}).length} br11 ${zlib.brotliCompressSync(b,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}}).length}`); };
console.log('params', tot);
sz('all f32', all); sz('f32 minus STFT basis', noStft); sz('all f16', f16(all)); sz('f16 minus STFT basis', f16(noStft));
// is the STFT basis a windowed DFT? check against hann-windowed cos/sin
const B = W['stft_conv.weight']; let best = null;
for (const win of ['hann-periodic','hann-sym','none']) { let mx = 0; for (let f=0; f<129; f++) for (let k=0;k<256;k++){ const w = win==='none'?1: win==='hann-periodic'? 0.5-0.5*Math.cos(2*Math.PI*k/256) : 0.5-0.5*Math.cos(2*Math.PI*k/255); const c = Math.cos(2*Math.PI*f*k/256)*w, s = -Math.sin(2*Math.PI*f*k/256)*w; mx = Math.max(mx, Math.abs(B[f*256+k]-c), Math.abs(B[(f+129)*256+k]-s), ); } console.log(`STFT basis vs ${win} DFT: max abs diff ${mx.toExponential(2)}`); }
// f16 parity
const { x } = readWav16('./silero-vad/tests/data/test.wav'); const W16 = {}; for (const k in W) W16[k] = unf16(f16(W[k]));
const a = new JsSilero(W), b = new JsSilero(W16); let mx = 0, fl = 0; const n = Math.floor(x.length/512);
for (let i=0;i<n;i++){ const fr = x.subarray(i*512,i*512+512); const p = a.process(fr), q = b.process(fr); mx = Math.max(mx, Math.abs(p-q)); if ((p>=0.5)!==(q>=0.5)) fl++; }
console.log(`f16-weights vs f32: max|dp| ${mx.toExponential(2)}, flips@0.5 ${fl}/${n}`);
