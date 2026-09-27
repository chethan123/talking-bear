import { WebrtcVad } from 'auditok-webrtcvad';
for (const sr of [16000, 48000]) for (const ms of [10,30]) {
  const vad = await WebrtcVad.create(2, sr);
  const n = sr*ms/1000; const secs=60; const N = sr*secs; const x = new Int16Array(N); for (let i=0;i<N;i++) x[i]=3000*Math.sin(i*0.05)+300*(Math.random()-0.5);
  const t0=performance.now(); let c=0; for (let off=0; off+n<=N; off+=n) c+= vad.isSpeech(x.subarray(off, off+n)) ? 1:0; const dt=performance.now()-t0;
  console.log(`fvad sr=${sr} frame=${ms}ms per-frame ${(dt/(N/n)*1000).toFixed(1)} us RTF ${(dt/(secs*1000)).toFixed(5)}`);
}
