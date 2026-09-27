import * as ort from 'onnxruntime-web'; ort.env.wasm.numThreads = 1;
import { readWav16, JsSilero, makeOrtSilero } from './lib.mjs';
process.env.ONNX = './silero-vad/src/silero_vad/data/silero_vad_16k_op15.onnx';
const { INITS: I } = await import('./onnxinit.mjs');
const reorder = (a, cols) => { const H = 128*cols, o = new Float32Array(a.length); o.set(a.subarray(0,H),0); o.set(a.subarray(2*H,3*H),H); o.set(a.subarray(3*H,4*H),2*H); o.set(a.subarray(H,2*H),3*H); return o; };
const g = n => I[n] ? I[n].data : null;
const zeros = n => new Float32Array(n);
function build(re) { const W = { 'stft_conv.weight': g('model.stft.forward_basis_buffer'), 'conv1.weight': g('model.encoder.0.reparam_conv.weight'), 'conv1.bias': g('model.encoder.0.reparam_conv.bias'),
  'conv2.weight': g('model.encoder.1.reparam_conv.weight'), 'conv2.bias': g('model.encoder.1.reparam_conv.bias'), 'conv3.weight': g('model.encoder.2.reparam_conv.weight'), 'conv3.bias': g('model.encoder.2.reparam_conv.bias'),
  'conv4.weight': g('model.encoder.3.reparam_conv.weight'), 'conv4.bias': g('model.encoder.3.reparam_conv.bias'), 'lstm_cell.weight_ih': g('model.decoder.rnn.weight_ih'), 'lstm_cell.weight_hh': g('model.decoder.rnn.weight_hh'),
  'lstm_cell.bias_ih': g('model.decoder.rnn.bias_ih'), 'lstm_cell.bias_hh': g('model.decoder.rnn.bias_hh'), 'final_conv.weight': g('model.decoder.decoder.2.weight'), 'final_conv.bias': g('model.decoder.decoder.2.bias') };
  const missing = Object.entries(W).filter(([k,v]) => !v).map(([k]) => k); if (missing.length) console.log('missing (small, stored elsewhere):', missing.join(','));
  if (re) { W['lstm_cell.weight_ih'] = reorder(W['lstm_cell.weight_ih'],128); W['lstm_cell.weight_hh'] = reorder(W['lstm_cell.weight_hh'],128); W['lstm_cell.bias_ih'] = reorder(W['lstm_cell.bias_ih'],1); W['lstm_cell.bias_hh'] = reorder(W['lstm_cell.bias_hh'],1); }
  return W; }
console.log(Object.keys(I).filter(k => I[k].data.length <= 100).map(k => `${k}[${I[k].data.length}]`).join(' '));
const { x } = readWav16('./silero-vad/tests/data/test.wav');
const ref = await makeOrtSilero(ort, process.env.ONNX);
const nF = Math.floor(x.length/512); const pr = [];
for (let i=0;i<nF;i++) pr.push(await ref.process(x.subarray(i*512, i*512+512)));
for (const re of [false, true]) { const js = new JsSilero(build(re)); let mx=0, fl=0, t=0;
  for (let i=0;i<nF;i++){ const t0=performance.now(); const p = js.process(x.subarray(i*512, i*512+512)); t+=performance.now()-t0; mx=Math.max(mx,Math.abs(p-pr[i])); if ((p>=0.5)!==(pr[i]>=0.5)) fl++; }
  console.log(`reorder=${re} max|dp|=${mx.toExponential(2)} flips=${fl}/${nF} per-frame=${(t/nF*1000).toFixed(0)}us`); }
