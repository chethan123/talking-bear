// Proposed energy VAD: rate-agnostic, 10 ms frames. Returns per-frame {active, inactive} for the shared segmenter,
// plus an optional per-frame voicing flag.
export function biquad(type, f0, fs, Q = Math.SQRT1_2) { // RBJ cookbook
  const w = 2*Math.PI*f0/fs, c = Math.cos(w), s = Math.sin(w), a = s/(2*Q); let b0,b1,b2,a0=1+a,a1=-2*c,a2=1-a;
  if (type === 'hp') { b0=(1+c)/2; b1=-(1+c); b2=(1+c)/2; } else { b0=(1-c)/2; b1=1-c; b2=(1-c)/2; }
  const B0=b0/a0,B1=b1/a0,B2=b2/a0,A1=a1/a0,A2=a2/a0; let z1=0,z2=0;
  return x => { const y = B0*x + z1; z1 = B1*x - A1*y + z2; z2 = B2*x - A2*y; return y; }; // TDF-II
}
export class EnergyVad {
  constructor(fs, o = {}) {
    this.fs = fs; this.H = Math.round(fs*0.01);
    this.o = Object.assign({ hp: 200, lp: 3400, onDb: 10, offDb: 5, absFloorDb: -65, alphaDown: 0.2, alphaUp: 0.004, alphaUpSpeech: 0.0005, minStatsMs: 1500, mode: 'ema' }, o);
    this.hp1 = biquad('hp', this.o.hp, fs); this.hp2 = biquad('hp', this.o.hp, fs); this.lp1 = biquad('lp', Math.min(this.o.lp, fs*0.45), fs);
    this.N = null; this.speaking = false; this.hist = []; this.eS = null;
    this.vbuf = new Float32Array(Math.round(fs*0.03)); // 30 ms voicing window
  }
  setSpeaking(s) { this.speaking = s; }
  frame(x) { // x: H samples
    let s = 0; const v = this.vbuf; v.copyWithin(0, x.length); const base = v.length - x.length;
    for (let i=0;i<x.length;i++){ const y = this.lp1(this.hp2(this.hp1(x[i]))); s += y*y; v[base+i] = y; }
    const E = 10*Math.log10(s/x.length + 1e-12);
    if (this.N === null) this.N = E;
    const o = this.o;
    if (o.mode === 'ema') {
      if (!this.speaking) this.N += (E < this.N ? o.alphaDown : o.alphaUp) * (E - this.N);
      else if (E > this.N) this.N += o.alphaUpSpeech * (E - this.N); else this.N += o.alphaDown * (E - this.N);
    } else { // minimum statistics over sliding window of smoothed energy, always updated
      this.eS = this.eS === null ? E : this.eS + 0.3*(E - this.eS);
      this.hist.push(this.eS); const W = Math.round(o.minStatsMs/10); if (this.hist.length > W) this.hist.shift();
      let m = Infinity; for (const h of this.hist) if (h < m) m = h; this.N = m + 1.5; // small bias comp.
    }
    const active = E > this.N + o.onDb && E > o.absFloorDb;
    const inactive = E < this.N + o.offDb || E < o.absFloorDb;
    return { E, N: this.N, active, inactive, voiced: this.voicing() };
  }
  voicing() { // normalized autocorrelation peak for F0 in 80..400 Hz over 30 ms window
    const v = this.vbuf, n = v.length, lo = Math.floor(this.fs/400), hi = Math.ceil(this.fs/80); let e0 = 0; for (let i=0;i<n;i++) e0 += v[i]*v[i];
    if (e0 < 1e-9) return 0; let best = 0;
    for (let L = lo; L <= hi; L++) { let r = 0, e1 = 0; for (let i=0;i+L<n;i++){ r += v[i]*v[i+L]; e1 += v[i+L]*v[i+L]; } const c = r/Math.sqrt(e0*e1+1e-12); if (c > best) best = c; }
    return best;
  }
}
