import { EnergyVad } from './energy.mjs';
// Kaiser-windowed sinc lowpass for 48k->16k decimation
function i0(x){ let s=1, t=1; for (let k=1;k<30;k++){ t*= (x/(2*k))**2; s+=t; } return s; }
function design(taps, fc, fs, beta){ const h=new Float32Array(taps), M=taps-1; let sum=0; for (let n=0;n<taps;n++){ const m=n-M/2; const sinc = m===0 ? 2*fc/fs : Math.sin(2*Math.PI*fc/fs*m)/(Math.PI*m); const w = i0(beta*Math.sqrt(1-(2*n/M-1)**2))/i0(beta); h[n]=sinc*w; sum+=h[n]; } for (let n=0;n<taps;n++) h[n]/=sum; return h; }
function resp(h, f, fs){ let re=0, im=0; for (let n=0;n<h.length;n++){ re+=h[n]*Math.cos(2*Math.PI*f/fs*n); im-=h[n]*Math.sin(2*Math.PI*f/fs*n); } return 20*Math.log10(Math.hypot(re,im)); }
class Decim3 { constructor(h){ this.h=h; this.L=h.length; this.buf=new Float32Array(2*this.L); this.pos=0; this.phase=0; }
  process(inp, out){ let o=0; const h=this.h, L=this.L, b=this.buf; for (let i=0;i<inp.length;i++){ b[this.pos]=inp[i]; b[this.pos+L]=inp[i]; this.pos=(this.pos+1)%L; if (++this.phase===3){ this.phase=0; let s=0; const p=this.pos; for (let k=0;k<L;k++) s+=h[k]*b[p+k]; out[o++]=s; } } return o; } }
for (const [taps, fc, beta] of [[48, 7000, 7], [64, 7200, 8], [96, 7500, 8]]) { const h = design(taps, fc, 48000, beta);
  console.log(`FIR ${taps} taps fc=${fc}: ${[1000,4000,6000,7000,8000,9000,10000,12000,16000].map(f=>`${f/1000}k:${resp(h,f,48000).toFixed(1)}`).join(' ')} dB`);
  const d = new Decim3(h), N = 48000*60, x = new Float32Array(N).map(()=>Math.random()-0.5), out = new Float32Array(128); let t0=performance.now(); for (let i=0;i<N;i+=128) d.process(x.subarray(i,i+128), out); const dt=performance.now()-t0; console.log(`   cost: ${(dt/60).toFixed(3)} ms per second of audio (${(dt/60/1000*100).toFixed(3)}% of one core)`); }
const box = [1/3,1/3,1/3]; console.log(`boxcar-3 (vad-web style): ${[4000,6000,8000,10000,12000,14000].map(f=>`${f/1000}k:${resp(box,f,48000).toFixed(1)}`).join(' ')} dB`);
for (const fs of [16000, 48000]) { const v = new EnergyVad(fs), H = fs/100, N = fs*60, x = new Float32Array(N).map(()=>0.01*(Math.random()-0.5)); let t0=performance.now(); for (let i=0;i+H<=N;i+=H) v.frame(x.subarray(i,i+H)); const dt = performance.now()-t0; console.log(`energy VAD incl. voicing @${fs}: ${(dt/6000*1000).toFixed(1)} us/frame(10ms)`); }
