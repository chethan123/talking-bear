import fs from 'fs'; import { loadSafetensors } from './lib.mjs';
const b = fs.readFileSync(process.env.ONNX);
function varint(buf, p) { let r = 0n, sh = 0n; while (true) { const x = buf[p++]; r |= BigInt(x & 127) << sh; if (!(x & 128)) break; sh += 7n; } return [r, p]; }
function* fields(buf, s, e) { let p = s; while (p < e) { let [tag, p1] = varint(buf, p); p = p1; const fn = Number(tag >> 3n), wt = Number(tag & 7n);
  if (wt === 0) { const [v, p2] = varint(buf, p); p = p2; yield { fn, wt, v }; } else if (wt === 2) { const [l, p2] = varint(buf, p); p = p2; yield { fn, wt, s: p, e: p + Number(l) }; p += Number(l); }
  else if (wt === 5) { yield { fn, wt, s: p, e: p+4 }; p += 4; } else if (wt === 1) { yield { fn, wt, s: p, e: p+8 }; p += 8; } } }
const inits = {};
function scanGraph(s, e) { for (const f of fields(b, s, e)) { if (f.fn === 5) { let name='', dims=[], raw=null, dt=0; for (const t of fields(b, f.s, f.e)) { if (t.fn===8) name=b.toString('utf8',t.s,t.e); else if (t.fn===1) { if (t.wt===0) dims.push(Number(t.v)); else { let p=t.s; while(p<t.e){const [v,p2]=varint(b,p);p=p2;dims.push(Number(v));} } } else if (t.fn===9) raw=b.subarray(t.s,t.e); else if (t.fn===2) dt=Number(t.v); }
      if (raw && dt===1) inits[name] = { dims, data: new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.length)) }; }
    if (f.fn === 1) { for (const n of fields(b, f.s, f.e)) if (n.fn === 5) for (const a of fields(b, n.s, n.e)) if (a.fn === 6) scanGraph(a.s, a.e); } } }
for (const f of fields(b, 0, b.length)) if (f.fn === 7) scanGraph(f.s, f.e);
export const INITS = inits;
