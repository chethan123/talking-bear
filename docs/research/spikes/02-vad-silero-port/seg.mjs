import { readWav16 } from './lib.mjs';
for (const f of ['./silero-vad/tests/data/test.wav', './silero-vad/examples/c++/aepyx.wav']) {
const { x, sr } = readWav16(f); const H = sr/100; const n = Math.floor(x.length/H); const e = new Float32Array(n);
for (let i=0;i<n;i++){ let s=0; for (let k=0;k<H;k++){ const v=x[i*H+k]; s+=v*v; } e[i]=10*Math.log10(s/H+1e-12); }
const sorted=[...e].sort((a,b)=>a-b); const p10=sorted[Math.floor(n*0.1)], p50=sorted[Math.floor(n*0.5)], p95=sorted[Math.floor(n*0.95)];
const thr = p95 - 35; const act = [...e].map(v => v > thr);
const segs=[]; let st=-1, gap=0; for (let i=0;i<n;i++){ if (act[i]) { if (st<0) st=i; gap=0; } else if (st>=0) { gap++; if (gap>=30) { segs.push([st, i-gap]); st=-1; gap=0; } } } if (st>=0) segs.push([st,n-1]);
console.log(f, `dur=${(x.length/sr).toFixed(1)}s p10=${p10.toFixed(1)} p50=${p50.toFixed(1)} p95=${p95.toFixed(1)} dBFS; segs(gap>=300ms)=${segs.length}`, segs.slice(0,12).map(([a,b])=>`${(a/100).toFixed(2)}-${(b/100).toFixed(2)}`).join(' '));
}
