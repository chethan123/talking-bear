import * as ort from 'onnxruntime-web';
import fs from 'fs';
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
const models = process.argv.slice(2);
for (const m of models) {
  const buf = fs.readFileSync(m);
  const t0 = performance.now();
  const sess = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const tLoad = performance.now() - t0;
  const legacy = sess.inputNames.includes('h');
  const N = legacy ? 1536 : 512 + 64;
  let state = legacy ? null : new ort.Tensor('float32', new Float32Array(256), [2,1,128]);
  let h = new ort.Tensor('float32', new Float32Array(128), [2,1,64]), c = new ort.Tensor('float32', new Float32Array(128), [2,1,64]);
  const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]));
  const x = new Float32Array(N); for (let i=0;i<N;i++) x[i]=0.1*Math.sin(i*0.05)+0.01*(Math.random()-0.5);
  const feeds = () => { const f = { input: new ort.Tensor('float32', x, [1,N]) }; if (sess.inputNames.includes('sr')) f.sr = sr; if (legacy) { f.h=h; f.c=c; } else f.state = state; return f; };
  for (let i=0;i<50;i++){ const o = await sess.run(feeds()); if (legacy){h=o.hn;c=o.cn;} else state=o.stateN; }
  const iters = 2000; const t1 = performance.now();
  let out;
  for (let i=0;i<iters;i++){ out = await sess.run(feeds()); if (legacy){h=out.hn;c=out.cn;} else state=out.stateN; }
  const per = (performance.now()-t1)/iters;
  const frameMs = legacy ? 96 : 32;
  console.log(m.split('/').pop(), 'inputs', sess.inputNames.join(','), 'outputs', sess.outputNames.join(','), `load ${tLoad.toFixed(0)} ms`, `per-frame ${(per*1000).toFixed(0)} us`, `frame ${frameMs} ms`, `RTF ${(per/frameMs).toFixed(4)}`, 'prob', out.output.data[0].toFixed(3));
}
