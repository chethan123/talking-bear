// Throwaway spike (duck-plan research, 2026-10-24): candidate "duck voice" stages, an intelligibility proxy
// (STOI, Taal et al. 2011, simplified), an alias meter and a roughness descriptor. Not application code; nothing
// under src/ may import it. Imports the production DSP modules read-only (Node 24 type stripping).
import { resampleOffline } from '../../../../src/dsp/resample.ts';
import { createRealFft } from '../../../../src/dsp/fft.ts';
import { trackPitch } from '../../../../lab/algos/psola.ts';

// ---------------------------------------------------------------------------------------------------------------
// RBJ cookbook biquads (Direct Form II transposed, float64 state), in place on a Float32Array.
export function rbj(kind, fs, f0, q, gainDb = 0) {
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const A = 10 ** (gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (kind) {
    case 'peak':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'bandpass': // constant 0 dB peak gain
      b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'hp':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'lp':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    default:
      throw new Error(kind);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function biquadInPlace(y, c) {
  let s1 = 0;
  let s2 = 0;
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < y.length; i++) {
    const x = y[i];
    const o = b0 * x + s1;
    s1 = b1 * x - a1 * o + s2;
    s2 = b2 * x - a2 * o;
    y[i] = o;
  }
  return y;
}

// ---------------------------------------------------------------------------------------------------------------
// Candidate stages. Every stage takes the pitch-shifted clip y (fs) and returns a new buffer of the same length.

/** Ring / amplitude modulation: y·((1 − mix) + mix·sin(2π fc t)). mix 1 = full ring modulation. */
export function ringMod(y, fs, { fc = 90, mix = 0.5 } = {}) {
  const out = new Float32Array(y.length);
  const w = (2 * Math.PI * fc) / fs;
  for (let i = 0; i < y.length; i++) out[i] = y[i] * (1 - mix + mix * Math.sin(w * i));
  return out;
}

/** Nasal / "squawk" EQ: HPF, two resonant peaks, a nasal anti-resonance notch, LPF. */
export const NASAL = {
  hpHz: 320, hpQ: 0.707,
  notchHz: 700, notchQ: 1.4, notchDb: -9,
  peak1Hz: 1600, peak1Q: 3, peak1Db: 10,
  peak2Hz: 3100, peak2Q: 2.5, peak2Db: 6,
  lpHz: 5600, lpQ: 0.707,
};
export function nasal(y, fs, p = NASAL) {
  const out = Float32Array.from(y);
  biquadInPlace(out, rbj('hp', fs, p.hpHz, p.hpQ));
  biquadInPlace(out, rbj('peak', fs, p.notchHz, p.notchQ, p.notchDb));
  biquadInPlace(out, rbj('peak', fs, p.peak1Hz, p.peak1Q, p.peak1Db));
  biquadInPlace(out, rbj('peak', fs, p.peak2Hz, p.peak2Q, p.peak2Db));
  biquadInPlace(out, rbj('lp', fs, p.lpHz, p.lpQ));
  return out;
}

/**
 * Waveshaping: tanh(drive·x / ref) · ref / tanh(drive), ref = the clip's peak, at `os`× oversampling (the production
 * sinc kernel up, tanh, down). os = 1 is the naive version.
 */
export function softClip(y, fs, { drive = 3, os = 2 } = {}) {
  let peak = 1e-9;
  for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
  const up = os === 1 ? Float32Array.from(y) : resampleOffline(y, os);
  const k = drive / peak;
  const norm = peak / Math.tanh(drive);
  for (let i = 0; i < up.length; i++) up[i] = Math.tanh(k * up[i]) * norm;
  if (os === 1) return up;
  const down = resampleOffline(up, 1 / os);
  const out = new Float32Array(y.length);
  out.set(down.subarray(0, Math.min(down.length, y.length)));
  return out;
}

/** Per-sample f0 (Hz, 0 = unvoiced) from the lab tracker (YIN-lite at fs/4, 5 ms hop), linearly interpolated. */
export function f0PerSample(y, fs) {
  const tr = trackPitch(y, fs, { fmin: 70, fmax: 1000 });
  const out = new Float32Array(y.length);
  const hop = tr.hopSamples;
  for (let i = 0; i < y.length; i++) {
    const h = i / hop;
    const a = Math.min(tr.f0.length - 1, Math.floor(h));
    const b = Math.min(tr.f0.length - 1, a + 1);
    const fa = tr.f0[a] ?? 0;
    const fb = tr.f0[b] ?? 0;
    out[i] = fa > 0 && fb > 0 ? fa + (fb - fa) * (h - a) : Math.max(fa, fb) > 0 && h - a < 0.5 ? fa || fb : 0;
  }
  return out;
}

/** A voicing weight 0…1 per sample: f0 > 0, smoothed by a one-pole with a 15 ms time constant (no clicks). */
function voicingWeight(f0, fs) {
  const w = new Float32Array(f0.length);
  const a = Math.exp(-1 / (0.015 * fs));
  let s = 0;
  for (let i = 0; i < f0.length; i++) {
    s = a * s + (1 - a) * (f0[i] > 0 ? 1 : 0);
    w[i] = s;
  }
  return w;
}

/**
 * Pitch-synchronous modulation. mode 'sub': gain 1 − depth·(½ + ½cos φ/2), i.e. AM at f0/2: every other glottal
 * period is quieter (period doubling, a subharmonic series at (k + ½)·f0: "fry" / rasp). mode 'pulse': gain
 * (1 − depth) + depth·c·((½ + ½cos φ)^shape), AM at f0 with a narrow pulse ("pressed buzz"). Smooth gains, so no
 * aliasing. Unvoiced samples get gain 1 (crossfaded by the voicing weight).
 */
export function pitchSyncMod(y, fs, f0, { mode = 'sub', depth = 0.5, shape = 6 } = {}) {
  const out = new Float32Array(y.length);
  const vw = voicingWeight(f0, fs);
  // normalise the pulse gain to unit mean power over a period
  let meanSq = 0;
  for (let k = 0; k < 256; k++) meanSq += (0.5 + 0.5 * Math.cos((2 * Math.PI * k) / 256)) ** (2 * shape);
  const c = 1 / Math.sqrt(meanSq / 256);
  let phase = 0;
  for (let i = 0; i < y.length; i++) {
    const f = f0[i];
    if (f > 0) phase += (2 * Math.PI * f) / fs;
    let g;
    if (mode === 'sub') g = 1 - depth * (0.5 + 0.5 * Math.cos(phase / 2));
    else g = 1 - depth + depth * c * (0.5 + 0.5 * Math.cos(phase)) ** shape;
    const w = vw[i];
    out[i] = y[i] * (1 - w + w * g);
  }
  return out;
}

/** Autocorrelation LPC by Levinson-Durbin; a[0] = 1. */
function lpc(frame, order, a, r, tmp) {
  for (let k = 0; k <= order; k++) {
    let s = 0;
    for (let i = k; i < frame.length; i++) s += frame[i] * frame[i - k];
    r[k] = s;
  }
  r[0] *= 1 + 1e-9;
  r[0] += 1e-12;
  a.fill(0);
  a[0] = 1;
  let e = r[0];
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / e;
    tmp.set(a);
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    e *= 1 - k * k;
    if (e <= 0) break;
  }
  return e;
}

/**
 * LPC source-filter at 16 kHz: decimate, per 10 ms hop (20 ms Hann window) estimate an order-`order` envelope,
 * inverse-filter to the residual, replace a fraction `buzz` of the voiced residual by a pulse train at the tracked
 * f0 with the residual's RMS (plus the rest of the residual), re-synthesise through the all-pole filter with
 * bandwidth expansion γ, and upsample back to fs. Output is band-limited to 7.2 kHz.
 */
export function lpcBuzz(y, fs, f0full, { order = 18, buzz = 0.7, gamma = 0.98 } = {}) {
  const FS = 16000;
  const x = resampleOffline(y, FS / fs);
  const n = x.length;
  const f0 = new Float32Array(n);
  for (let i = 0; i < n; i++) f0[i] = f0full[Math.min(f0full.length - 1, Math.round((i * fs) / FS))];
  const hop = 160;
  const win = 320;
  const hann = new Float64Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / win);
  const frame = new Float64Array(win);
  const a = new Float64Array(order + 1);
  const r = new Float64Array(order + 1);
  const tmp = new Float64Array(order + 1);
  const out = new Float32Array(n);
  const mem = new Float64Array(order); // inverse filter memory (past inputs)
  const smem = new Float64Array(order); // synthesis memory (past outputs)
  let phase = 1;
  for (let s = 0; s < n; s += hop) {
    for (let i = 0; i < win; i++) {
      const j = s + i - (win - hop) / 2;
      frame[i] = j >= 0 && j < n ? x[j] * hann[i] : 0;
    }
    lpc(frame, order, a, r, tmp);
    let g = 1;
    for (let k = 1; k <= order; k++) {
      g *= gamma;
      a[k] *= g;
    }
    const end = Math.min(n, s + hop);
    // residual RMS of this hop
    let ss = 0;
    const res = new Float64Array(end - s);
    for (let i = s; i < end; i++) {
      let e = x[i];
      for (let k = 1; k <= order; k++) e += a[k] * mem[k - 1];
      for (let k = order - 1; k > 0; k--) mem[k] = mem[k - 1];
      mem[0] = x[i];
      res[i - s] = e;
      ss += e * e;
    }
    const rms = Math.sqrt(ss / Math.max(1, end - s));
    for (let i = s; i < end; i++) {
      const f = f0[i];
      let exc = res[i - s];
      if (f > 0) {
        phase += f / FS;
        let pulse = 0;
        if (phase >= 1) {
          phase -= 1;
          pulse = rms * Math.sqrt(FS / f); // unit-RMS impulse train scaled to the residual RMS
        }
        exc = (1 - buzz) * exc + buzz * pulse;
      }
      let o = exc;
      for (let k = 1; k <= order; k++) o -= a[k] * smem[k - 1];
      for (let k = order - 1; k > 0; k--) smem[k] = smem[k - 1];
      smem[0] = o;
      out[i] = o;
    }
  }
  const up = resampleOffline(out, fs / FS);
  const res = new Float32Array(y.length);
  res.set(up.subarray(0, Math.min(up.length, y.length)));
  return res;
}

// ---------------------------------------------------------------------------------------------------------------
// STOI (Taal, Hendriks, Heusdens, Jensen 2011), simplified: 10 kHz, 256-sample Hann frames, hop 128, 512-point
// FFT, 15 one-third-octave bands from 150 Hz, 30-frame (384 ms) segments, clipping at β = −15 dB. Deviation from
// the reference implementation: silent frames (clean frame energy below max − 40 dB) are dropped in the STFT
// domain instead of being removed and overlap-added in the time domain.
export function stoi(clean, proc, fs) {
  const FS = 10000;
  const x = resampleOffline(clean, FS / fs);
  const y = resampleOffline(proc, FS / fs);
  const n = Math.min(x.length, y.length);
  const N = 256;
  const H = 128;
  const NFFT = 512;
  const fft = createRealFft(NFFT);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (N + 1));
  const bands = [];
  for (let j = 0; j < 15; j++) {
    const cf = 150 * 2 ** (j / 3);
    const lo = Math.round((cf * 2 ** (-1 / 6) * NFFT) / FS);
    const hi = Math.round((cf * 2 ** (1 / 6) * NFFT) / FS);
    bands.push([lo, Math.min(hi, NFFT / 2)]);
  }
  const frames = [];
  const energies = [];
  const buf = new Float32Array(NFFT);
  const spec = (sig, start) => {
    buf.fill(0);
    for (let i = 0; i < N; i++) buf[i] = sig[start + i] * win[i];
    return fft.powerSpectrum ? fft.powerSpectrum(buf) : power(fft, buf, NFFT);
  };
  for (let s = 0; s + N <= n; s += H) {
    let e = 0;
    for (let i = 0; i < N; i++) e += (x[s + i] * win[i]) ** 2;
    energies.push(10 * Math.log10(e + 1e-20));
    frames.push(s);
  }
  const maxE = Math.max(...energies);
  const keep = frames.filter((_, k) => energies[k] > maxE - 40);
  const X = [];
  const Y = [];
  for (const s of keep) {
    const px = spec(x, s).slice();
    const py = spec(y, s).slice();
    X.push(bands.map(([lo, hi]) => Math.sqrt(sum(px, lo, hi))));
    Y.push(bands.map(([lo, hi]) => Math.sqrt(sum(py, lo, hi))));
  }
  const M = 30;
  const clip = 1 + 10 ** (-15 / 20);
  let total = 0;
  let count = 0;
  for (let m = M; m <= X.length; m++) {
    for (let j = 0; j < 15; j++) {
      const xs = [];
      const ys = [];
      for (let t = m - M; t < m; t++) {
        xs.push(X[t][j]);
        ys.push(Y[t][j]);
      }
      const nx = Math.hypot(...xs);
      const ny = Math.hypot(...ys) + 1e-12;
      const ysc = ys.map((v, t) => Math.min((v * nx) / ny, clip * xs[t]));
      total += corr(xs, ysc);
      count++;
    }
  }
  return count === 0 ? Number.NaN : total / count;
}

function power(fft, buf, nfft) {
  const re = new Float32Array(nfft / 2 + 1);
  const im = new Float32Array(nfft / 2 + 1);
  fft.forward(buf, re, im);
  const p = new Float64Array(nfft / 2 + 1);
  for (let k = 0; k <= nfft / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}
function sum(a, lo, hi) {
  let s = 0;
  for (let k = lo; k < hi; k++) s += a[k];
  return s;
}
function corr(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return sab / (Math.sqrt(saa * sbb) + 1e-12);
}

// ---------------------------------------------------------------------------------------------------------------
// Alias meter: a stage applied to a pure tone at f; energy within ±3 bins of every multiple of f (and of f/2,
// for subharmonic stages) is "wanted"; everything else above 50 Hz is alias/noise. Returns dB re total.
export function aliasDb(stage, fs, f, amp = 0.5) {
  const n = 1 << 16;
  const x = new Float32Array(n + 8192);
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / fs);
  const y = stage(x).subarray(4096, 4096 + n);
  const fft = createRealFft(n);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = y[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const p = power(fft, buf, n);
  const binHz = fs / n;
  let want = 0;
  let other = 0;
  for (let k = Math.ceil(50 / binHz); k < p.length; k++) {
    const hz = k * binHz;
    const near = (base) => {
      const m = Math.round(hz / base);
      return m >= 1 && Math.abs(hz - m * base) <= 3 * binHz;
    };
    if (near(f / 2) || near(f)) want += p[k];
    else other += p[k];
  }
  return 10 * Math.log10(other / (want + other) + 1e-30);
}

// ---------------------------------------------------------------------------------------------------------------
// Roughness proxy: in 4 bands (300–800, 800–1600, 1600–3200, 3200–6400 Hz) take the 1 kHz-sampled Hilbert-free
// envelope (rectify + 1 ms one-pole), and report the share of envelope-modulation power in 30–150 Hz (roughness)
// relative to 1–150 Hz. Speech is ≈ dominated by 2–16 Hz syllabic modulation; a rough/buzzy voice raises the share.
export function roughness(y, fs) {
  const edges = [300, 800, 1600, 3200, 6400];
  let rough = 0;
  let all = 0;
  for (let b = 0; b < 4; b++) {
    const z = Float32Array.from(y);
    const fc = Math.sqrt(edges[b] * edges[b + 1]);
    const q = fc / (edges[b + 1] - edges[b]);
    biquadInPlace(z, rbj('bandpass', fs, fc, q));
    biquadInPlace(z, rbj('bandpass', fs, fc, q));
    const dec = Math.round(fs / 1000);
    const env = new Float32Array(Math.floor(z.length / dec));
    const a = Math.exp(-1 / (0.001 * fs));
    let s = 0;
    for (let i = 0; i < env.length * dec; i++) {
      s = a * s + (1 - a) * Math.abs(z[i]);
      if (i % dec === 0) env[i / dec] = s;
    }
    let m = 0;
    for (const v of env) m += v;
    m /= env.length;
    const nfft = 1 << Math.ceil(Math.log2(env.length));
    const buf = new Float32Array(nfft);
    for (let i = 0; i < env.length; i++) buf[i] = env[i] - m;
    const p = power(createRealFft(nfft), buf, nfft);
    for (let k = 1; k < p.length; k++) {
      const hz = (k * 1000) / nfft;
      if (hz >= 1 && hz <= 150) all += p[k];
      if (hz >= 30 && hz <= 150) rough += p[k];
    }
  }
  return rough / all;
}

/** Spectral centroid in Hz (whole clip, 4096-point frames). */
export function centroid(y, fs) {
  const N = 4096;
  const fft = createRealFft(N);
  const buf = new Float32Array(N);
  let num = 0;
  let den = 0;
  for (let s = 0; s + N <= y.length; s += N / 2) {
    for (let i = 0; i < N; i++) buf[i] = y[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    const p = power(fft, buf, N);
    for (let k = 1; k < p.length; k++) {
      num += ((k * fs) / N) * p[k];
      den += p[k];
    }
  }
  return num / den;
}

// ---------------------------------------------------------------------------------------------------------------
// Round 2: cheaper anti-aliased waveshaping, a cheaper tracker, better meters.

/** ln(cosh(v)), overflow-safe. */
function logCosh(v) {
  const a = Math.abs(v);
  return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2;
}

/**
 * First-order antiderivative anti-aliasing (ADAA, Parker et al. DAFx 2016) of tanh at 1×:
 * y[n] = (F(u[n]) − F(u[n−1])) / (u[n] − u[n−1]), F = ln cosh, u = k·x; tanh of the midpoint when |Δu| < 1e-5.
 * Output scaled like softClip (peak-referenced), so drive means the same.
 */
export function softClipAdaa(y, fs, { drive = 3 } = {}) {
  let peak = 1e-9;
  for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
  const k = drive / peak;
  const norm = peak / Math.tanh(drive);
  const out = new Float32Array(y.length);
  let u1 = 0;
  let F1 = 0;
  for (let i = 0; i < y.length; i++) {
    const u = k * y[i];
    const F = logCosh(u);
    const d = u - u1;
    out[i] = (Math.abs(d) < 1e-5 ? Math.tanh(0.5 * (u + u1)) : (F - F1) / d) * norm;
    u1 = u;
    F1 = F;
  }
  return out;
}

/** A Kaiser-windowed half-band FIR (odd length 4m+3), cutoff fs/4. */
function halfband(taps = 31, beta = 8) {
  const h = new Float64Array(taps);
  const c = (taps - 1) / 2;
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
  for (let i = 0; i < taps; i++) {
    const t = i - c;
    const sinc = t === 0 ? 0.5 : Math.sin((Math.PI * t) / 2) / (Math.PI * t);
    const w = i0(beta * Math.sqrt(1 - (t / c) ** 2)) / i0(beta);
    h[i] = sinc * w;
  }
  return h;
}

/** tanh at 2× with a half-band up/down pair (`taps`-tap FIR each way). */
export function softClipHalfband(y, fs, { drive = 3, taps = 31 } = {}) {
  const h = halfband(taps);
  const L = h.length;
  const c = (L - 1) / 2;
  let peak = 1e-9;
  for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
  const k = drive / peak;
  const norm = peak / Math.tanh(drive);
  const n = y.length;
  // up: z[2i] = y[i], z[2i+1] = 0, filtered by 2h; computed as polyphase
  const up = new Float32Array(2 * n);
  for (let j = 0; j < 2 * n; j++) {
    let s = 0;
    // z index m contributes h[j - m + c] for even m = 2i
    const lo = Math.max(0, Math.ceil((j - c) / 2));
    const hi = Math.min(n - 1, Math.floor((j + c) / 2));
    for (let i = lo; i <= hi; i++) s += y[i] * h[j - 2 * i + c];
    up[j] = Math.tanh(k * 2 * s);
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const j0 = 2 * i;
    const lo = Math.max(0, j0 - c);
    const hi = Math.min(2 * n - 1, j0 + c);
    for (let j = lo; j <= hi; j++) s += up[j] * h[j - j0 + c];
    out[i] = s * norm;
  }
  return out;
}

/**
 * A cheaper pitch track for the duck stage: YIN (difference function + CMND + absolute threshold 0.15 +
 * parabolic refinement) on an 8 kHz copy, 32 ms windows (256 samples), 10 ms hop, f0 in [100, 1000] Hz (the input
 * is already pitched up ×p ≥ 1.25, so an adult male's 85 Hz arrives at ≥ 106 Hz). Returns f0 per output sample.
 */
export function fastTrack(y, fs, { fmin = 100, fmax = 1000 } = {}) {
  const SR = 8000;
  const z = resampleOffline(y, SR / fs);
  const W = 256 - Math.ceil(SR / fmin) - 1; // integration length so a window is 256 samples incl. lags
  const tmin = Math.floor(SR / fmax);
  const tmax = Math.ceil(SR / fmin);
  const hop = 80;
  const frames = Math.max(0, Math.floor((z.length - W - tmax - 1) / hop) + 1);
  const f0 = new Float32Array(frames);
  const d = new Float64Array(tmax + 2);
  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    let e = 0;
    for (let j = 0; j < W; j++) e += z[s + j] * z[s + j];
    if (e / W < 1e-7) continue;
    let run = 0;
    for (let t = 1; t <= tmax + 1; t++) {
      let acc = 0;
      for (let j = 0; j < W; j++) { const q = z[s + j] - z[s + j + t]; acc += q * q; }
      run += acc;
      d[t] = run > 0 ? (acc * t) / run : 1;
    }
    for (let t = tmin; t <= tmax; t++) {
      if (d[t] >= 0.15) continue;
      while (t + 1 <= tmax && d[t + 1] < d[t]) t++;
      const a = d[t - 1], b = d[t], c2 = d[t + 1];
      const den = a - 2 * b + c2;
      const tt = den > 0 ? t + (a - c2) / (2 * den) : t;
      f0[f] = SR / tt;
      break;
    }
  }
  const out = new Float32Array(y.length);
  const hopOut = (hop * fs) / SR;
  const centre = ((W + tmax) / 2) * (fs / SR);
  for (let i = 0; i < y.length; i++) {
    const h = (i - centre) / hopOut;
    const a = Math.floor(h);
    if (a < 0 || a + 1 >= frames) { out[i] = a >= 0 && a < frames ? f0[a] : 0; continue; }
    const fa = f0[a], fb = f0[a + 1];
    out[i] = fa > 0 && fb > 0 ? fa + (fb - fa) * (h - a) : h - a < 0.5 ? fa : fb;
  }
  return out;
}

/** 4-term Blackman-Harris window (−92 dB sidelobes). */
function bh(i, n) {
  const x = (2 * Math.PI * i) / n;
  return 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
}

/**
 * Alias meter v2: tone at f (amplitude 0.5), Blackman-Harris, 65536 points; "wanted" = within ±8 bins of k·f.
 * Returns the energy elsewhere (50 Hz … Nyquist) in dB re the total. For a memoryless odd nonlinearity every
 * non-aliased product is an odd harmonic, so the rest is aliasing (plus the stage's own noise floor).
 */
export function aliasDbV2(stage, fs, f) {
  const n = 1 << 16;
  const x = new Float32Array(n + 8192);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / fs);
  const y = stage(x).subarray(4096, 4096 + n);
  const fft = createRealFft(n);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = y[i] * bh(i, n);
  const p = power(fft, buf, n);
  const binHz = fs / n;
  let want = 0;
  let other = 0;
  for (let k = Math.ceil(50 / binHz); k < p.length; k++) {
    const hz = k * binHz;
    const m = Math.round(hz / f);
    if (m >= 1 && Math.abs(hz - m * f) <= 8 * binHz) want += p[k];
    else other += p[k];
  }
  return 10 * Math.log10(other / (want + other) + 1e-30);
}

/**
 * "Added component" meter: a steady harmonic complex at f0 (harmonics 1/k up to 0.45·fs, so nothing aliases at
 * input), through `stage(x, f0track)`; the share of output energy farther than ±8 bins from every k·f0, in dB.
 * This is how much buzz / rasp / sideband energy a stage adds (wanted here), on a known pitched input.
 */
export function addedDb(stage, fs, f0) {
  const n = 1 << 16;
  const x = new Float32Array(n + 8192);
  const K = Math.floor((0.45 * fs) / f0);
  let s = 0;
  for (let k = 1; k <= K; k++) s += 1 / k;
  for (let i = 0; i < x.length; i++) {
    let v = 0;
    for (let k = 1; k <= K; k++) v += Math.sin((2 * Math.PI * k * f0 * i) / fs) / k;
    x[i] = (0.5 * v) / s;
  }
  const track = new Float32Array(x.length).fill(f0);
  const y = stage(x, track).subarray(4096, 4096 + n);
  const fft = createRealFft(n);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = y[i] * bh(i, n);
  const p = power(fft, buf, n);
  const binHz = fs / n;
  let want = 0;
  let other = 0;
  for (let k = Math.ceil(50 / binHz); k < p.length; k++) {
    const hz = k * binHz;
    const m = Math.round(hz / f0);
    if (m >= 1 && Math.abs(hz - m * f0) <= 8 * binHz) want += p[k];
    else other += p[k];
  }
  return 10 * Math.log10(other / (want + other) + 1e-30);
}

// ---------------------------------------------------------------------------------------------------------------
// Round 3: the recommended stage. Nasal EQ with a 4th-order low-pass, then a peak-normalised cubic shaper
// y = peak·(u − u³/3)·(3/2), u = x/peak ∈ [−1, 1]: a pure cubic, so its output bandwidth is exactly 3× its input's.
export const NASAL4 = { ...NASAL, lpHz: 5500 };
export function nasal4(y, fs, p = NASAL4) {
  const out = nasal(y, fs, p); // HPF, notch, 2 peaks, LPF (2nd order)
  biquadInPlace(out, rbj('lp', fs, p.lpHz, 0.707)); // second LPF section → 4th order
  return out;
}
export function cubicShape(y, { mix = 1 } = {}) {
  let peak = 1e-12;
  for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
  const out = new Float32Array(y.length);
  const inv = 1 / peak;
  for (let i = 0; i < y.length; i++) {
    const u = y[i] * inv;
    const c = 1.5 * (u - (u * u * u) / 3) * peak; // 1.5 keeps the peak at ±peak
    out[i] = (1 - mix) * y[i] + mix * c;
  }
  return out;
}
export const DUCK = { amHz: 70, amMix: 0.35, shapeMix: 1 };
/** The recommended duck stage: AM → nasal EQ (4th-order LPF) → cubic shaper. */
export function duckStage(y, fs, d = DUCK) {
  return cubicShape(nasal4(ringMod(y, fs, { fc: d.amHz, mix: d.amMix }), fs), { mix: d.shapeMix });
}
