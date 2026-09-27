// Minimal reference implementations of duration-preserving pitch shifters (plain JS ~= TS cost)
import { SR, makeSincResampler, linearRate } from './dsp.mjs';

export const sinc8 = makeSincResampler({ zc: 8, beta: 7, phases: 256, cutoff: 0.90 });

// ---------------- WSOLA time stretch (output length ~= input * stretch) ----------------
export function wsolaStretch(x, stretch, { winMs = 30, tolMs = 8 } = {}) {
  const W = Math.round(winMs * SR / 1000) & ~1, Hs = W >> 1, Ha = Hs / stretch, tol = Math.round(tolMs * SR / 1000);
  const outLen = Math.floor(x.length * stretch) + W;
  const y = new Float32Array(outLen), wsum = new Float32Array(outLen);
  const win = new Float32Array(W); for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / W);
  const N = x.length;
  let prev = 0; // input position of previously chosen frame
  for (let k = 0, out = 0; out + W < outLen; k++, out += Hs) {
    const nominal = Math.round(k * Ha);
    let best = nominal;
    if (k > 0) {
      const target = prev + Hs; // natural continuation
      let bestC = -Infinity;
      const lo = Math.max(0, nominal - tol), hi = Math.min(N - W - 1, nominal + tol);
      // coarse search: stride 4 in lag and in samples
      for (let p = lo; p <= hi; p += 4) {
        let c = 0, e = 1e-9;
        for (let i = 0; i < Hs; i += 4) { const a = x[target + i] || 0, b = x[p + i]; c += a * b; e += b * b; }
        c /= Math.sqrt(e); if (c > bestC) { bestC = c; best = p; }
      }
      // fine search +-3 at full resolution
      const c0 = best; bestC = -Infinity;
      for (let p = Math.max(lo, c0 - 3); p <= Math.min(hi, c0 + 3); p++) {
        let c = 0, e = 1e-9;
        for (let i = 0; i < Hs; i++) { const a = x[target + i] || 0, b = x[p + i]; c += a * b; e += b * b; }
        c /= Math.sqrt(e); if (c > bestC) { bestC = c; best = p; }
      }
    }
    if (best + W > N) break;
    for (let i = 0; i < W; i++) { y[out + i] += x[best + i] * win[i]; wsum[out + i] += win[i]; }
    prev = best;
  }
  for (let i = 0; i < outLen; i++) if (wsum[i] > 1e-3) y[i] /= wsum[i];
  return y.subarray(0, Math.floor(x.length * stretch));
}
export const wsolaPitch = (x, r) => sinc8(wsolaStretch(x, r), r);

// ---------------- YIN-lite pitch tracker on 4x-decimated signal ----------------
const dec4 = makeSincResampler({ zc: 6, beta: 6, phases: 64, cutoff: 0.9 });
export function trackPitch(x, { hopMs = 5, fmin = 70, fmax = 900, thresh = 0.15 } = {}) {
  const xd = dec4(x, 4), sr = SR / 4;
  const hop = Math.round(hopMs * sr / 1000), W = Math.round(0.025 * sr), tmin = Math.floor(sr / fmax), tmax = Math.ceil(sr / fmin);
  const frames = Math.floor((xd.length - W - tmax) / hop);
  const f0 = new Float32Array(Math.max(0, frames));
  const d = new Float32Array(tmax + 1);
  for (let f = 0; f < frames; f++) {
    const s = f * hop; let en = 0;
    for (let i = 0; i < W; i++) en += xd[s + i] * xd[s + i];
    if (en / W < 1e-5) { f0[f] = 0; continue; }
    let run = 0; d[0] = 1; let found = 0;
    for (let t = 1; t <= tmax; t++) {
      let acc = 0; for (let i = 0; i < W; i++) { const v = xd[s + i] - xd[s + i + t]; acc += v * v; }
      run += acc; d[t] = acc * t / (run || 1);
      if (t > tmin + 1 && !found && d[t - 1] < thresh && d[t - 1] <= d[t] && d[t - 1] <= d[t - 2]) { found = t - 1; break; }
    }
    if (found) { // parabolic refine
      const a = d[found - 1], b = d[found], c = d[found + 1]; const den = a - 2 * b + c;
      const tt = found + (den ? 0.5 * (a - c) / den : 0); f0[f] = sr / tt;
    } else f0[f] = 0;
  }
  return { f0, hopSamples: hop * 4 };
}

// ---------------- TD-PSOLA (duration preserving, formant preserving) ----------------
export function psola(x, r, track = trackPitch(x), { formant = 1 } = {}) {
  const { f0, hopSamples } = track, N = x.length;
  const periodAt = (n) => { const i = Math.min(f0.length - 1, Math.max(0, Math.round(n / hopSamples))); return f0[i] > 0 ? SR / f0[i] : 0; };
  // analysis marks
  const marks = [], per = [];
  let n = 0;
  while (n < N) {
    const P = periodAt(n);
    if (P > 0) {
      // snap to local max of |x| within +-P/3 around n
      const lo = Math.max(0, Math.round(n - P / 3)), hi = Math.min(N - 1, Math.round(n + P / 3));
      let m = lo, mv = -1; for (let i = lo; i <= hi; i++) { const v = x[i]; if (v > mv) { mv = v; m = i; } }
      if (marks.length && m <= marks[marks.length - 1] + P / 2) m = Math.round(marks[marks.length - 1] + P);
      marks.push(m); per.push(P); n = m + P;
    } else { marks.push(n); per.push(240); n += 240; } // unvoiced: 5 ms grid, no pitch change
  }
  const y = new Float32Array(N), ws = new Float32Array(N);
  let t = marks[0] || 0, mi = 0;
  while (t < N) {
    while (mi + 1 < marks.length && Math.abs(marks[mi + 1] - t) < Math.abs(marks[mi] - t)) mi++;
    const m = marks[mi], P = per[mi], voiced = periodAt(m) > 0;
    const L = Math.round(P);
    const ti = Math.round(t);
    for (let i = -L; i < L; i++) {
      const w = 0.5 + 0.5 * Math.cos(Math.PI * i / L);
      const src = m + i * (voiced ? formant : 1), o = ti + i; if (o < 0 || o >= N) continue;
      const k = Math.floor(src), fr = src - k; if (k < 0 || k + 1 >= N) continue;
      y[o] += w * ((1 - fr) * x[k] + fr * x[k + 1]); ws[o] += w;
    }
    t += voiced ? P / r : P;
  }
  for (let i = 0; i < N; i++) if (ws[i] > 1e-3) y[i] /= ws[i];
  return y;
}

// ---------------- plain resampling pitch (duration shrinks) ----------------
export const resamplePitch = (x, r) => sinc8(x, r);
export { linearRate };
