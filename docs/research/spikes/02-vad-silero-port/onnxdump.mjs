import fs from 'fs';
const b = fs.readFileSync(process.argv[2]);
function* fields(buf, s, e) { let p = s; while (p < e) { let [tag, p1] = varint(buf, p); p = p1; const fn = Number(tag >> 3n), wt = Number(tag & 7n);
  if (wt === 0) { const [v, p2] = varint(buf, p); p = p2; yield { fn, wt, v }; }
  else if (wt === 2) { const [l, p2] = varint(buf, p); p = p2; yield { fn, wt, s: p, e: p + Number(l) }; p += Number(l); }
  else if (wt === 5) { yield { fn, wt, s: p, e: p+4 }; p += 4; } else if (wt === 1) { yield { fn, wt, s: p, e: p+8 }; p += 8; } else throw new Error('wt'+wt); } }
function varint(buf, p) { let r = 0n, sh = 0n; while (true) { const x = buf[p++]; r |= BigInt(x & 127) << sh; if (!(x & 128)) break; sh += 7n; } return [r, p]; }
const str = (f) => b.toString('utf8', f.s, f.e);
function dumpGraph(s, e, ind) { for (const f of fields(b, s, e)) if (f.fn === 1) dumpNode(f.s, f.e, ind); }
function dumpNode(s, e, ind) { let op = '', name = '', ins = [], outs = [], attrs = [];
  for (const f of fields(b, s, e)) { if (f.fn === 4) op = str(f); else if (f.fn === 3) name = str(f); else if (f.fn === 1) ins.push(str(f)); else if (f.fn === 2) outs.push(str(f));
    else if (f.fn === 5) { let an = '', val = [], sub = null; for (const a of fields(b, f.s, f.e)) { if (a.fn === 1) an = str(a); else if (a.fn === 3) val.push(Number(a.v)); else if (a.fn === 4) val.push(JSON.stringify(str(a)));
        else if (a.fn === 8) { if (a.wt === 0) val.push(Number(a.v)); else { let p=a.s; while(p<a.e){ const [v,p2]=varint(b,p); p=p2; val.push(Number(BigInt.asIntN(64,v))); } } }
        else if (a.fn === 2) val.push(b.readFloatLE(a.s)); else if (a.fn === 6) sub = a; }
      attrs.push(`${an}=${val.join(',')}`); if (sub && process.argv[3]) { console.log(`${ind}  [subgraph ${an}]`); dumpGraph(sub.s, sub.e, ind + '    '); } } }
  if (!['Constant','Shape','Gather','Unsqueeze','Squeeze','Cast','Identity','Concat','Slice','Reshape','ConstantOfShape','Equal','Where','Expand'].includes(op) || process.argv[4]) console.log(`${ind}${op} ${attrs.join(' ')}  in=[${ins.join(',')}] out=[${outs.join(',')}]`); }
for (const f of fields(b, 0, b.length)) if (f.fn === 7) dumpGraph(f.s, f.e, '');
