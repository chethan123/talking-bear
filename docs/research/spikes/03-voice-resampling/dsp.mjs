// Small DSP toolkit for the benchmark (plain JS, mirrors what a TS impl would do).
export const SR = 48000;

// ---------- deterministic RNG ----------
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ---------- biquad (RBJ) ----------
export function biquadCoeffs(type, fc, q, sr = SR) {
  const w = 2 * Math.PI * fc / sr, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  else if (type === 'bp') { b0 = a; b1 = 0; b2 = -a; }
  a0 = 1 + a; a1 = -2 * c; a2 = 1 - a;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
export function biquad(x, [b0, b1, b2, a1, a2]) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi;
  }
  return y;
}

// ---------- synthetic "voice" (glottal source + formants + sibilants + noise floor) ----------
// Not real speech; designed to have realistic HF content (sibilants to ~14 kHz, -60 dBFS floor to 24 kHz)
export function synthVoice(seconds = 5, sr = SR, seed = 7) {
  const N = Math.round(seconds * sr), out = new Float32Array(N), r = rng(seed);
  // segments: [dur s, type, f0, formants]
  const vowels = {
    a: [730, 1090, 2440, 3400], i: [270, 2290, 3010, 3700], u: [300, 870, 2240, 3300], e: [530, 1840, 2480, 3500], o: [570, 840, 2410, 3300],
  };
  const plan = [];
  let t = 0.25; // leading silence
  const seq = ['a', 's', 'i', 'o', 'sh', 'e', 'u', 's', 'a', 'i', 'o', 's', 'e'];
  for (const ph of seq) { const d = ph.length <= 2 && (ph === 's' || ph === 'sh') ? 0.14 : 0.26; plan.push([t, t + d, ph]); t += d + 0.03; if (t > seconds - 0.4) break; }
  // glottal pulse train (Rosenberg-like) with vibrato
  const src = new Float32Array(N);
  let phase = 0;
  for (let n = 0; n < N; n++) {
    const tt = n / sr;
    const f0 = 170 + 40 * Math.sin(2 * Math.PI * 0.7 * tt) + 5 * Math.sin(2 * Math.PI * 5.5 * tt);
    phase += f0 / sr; if (phase >= 1) phase -= 1;
    const tp = 0.4, tn = 0.16;
    let g = 0;
    if (phase < tp) g = 0.5 * (1 - Math.cos(Math.PI * phase / tp));
    else if (phase < tp + tn) g = Math.cos(Math.PI * (phase - tp) / (2 * tn));
    src[n] = g;
  }
  // differentiate (lip radiation) -> pre-emphasis
  for (let n = N - 1; n > 0; n--) src[n] = src[n] - src[n - 1];
  for (const [t0, t1, ph] of plan) {
    const n0 = Math.floor(t0 * sr), n1 = Math.min(N, Math.floor(t1 * sr));
    const len = n1 - n0;
    let seg = new Float32Array(len);
    if (ph === 's' || ph === 'sh') {
      for (let i = 0; i < len; i++) seg[i] = (r() * 2 - 1);
      const lo = ph === 's' ? 5000 : 2500, hi = ph === 's' ? 13000 : 7000;
      seg = biquad(biquad(seg, biquadCoeffs('hp', lo, 0.7)), biquadCoeffs('hp', lo, 0.7));
      seg = biquad(biquad(seg, biquadCoeffs('lp', hi, 0.7)), biquadCoeffs('lp', hi, 0.7));
      for (let i = 0; i < len; i++) seg[i] *= 0.18;
    } else {
      const f = vowels[ph];
      const ex = src.subarray(n0, n1);
      const acc = new Float32Array(len);
      const gains = [1, 0.5, 0.25, 0.12];
      for (let k = 0; k < 4; k++) {
        const y = biquad(ex, biquadCoeffs('bp', f[k], f[k] / 90));
        for (let i = 0; i < len; i++) acc[i] += gains[k] * y[i];
      }
      // aspiration noise shaped by same formants (adds 3-10 kHz breathiness)
      for (let i = 0; i < len; i++) acc[i] = acc[i] * 6 + 0.01 * (r() * 2 - 1);
      seg = acc;
    }
    // envelope 15 ms attack/release
    const ar = Math.floor(0.015 * sr);
    for (let i = 0; i < len; i++) {
      const e = Math.min(1, i / ar, (len - 1 - i) / ar);
      out[n0 + i] += seg[i] * e;
    }
  }
  // normalize to -3 dBFS peak, then add -60 dBFS white noise floor (mic self-noise, full band)
  let pk = 0; for (let n = 0; n < N; n++) pk = Math.max(pk, Math.abs(out[n]));
  const g = 0.707 / pk;
  for (let n = 0; n < N; n++) out[n] = out[n] * g + 0.001 * (r() * 2 - 1);
  return out;
}

// ---------- resamplers: output = input played at rate r (pitch & tempo up by r) ----------
// Chromium AudioBufferSourceHandler::ProcessInterpolatedPath clone (linear interpolation, no filter)
export function linearRate(x, r) {
  const M = Math.floor((x.length - 1) / r);
  const y = new Float32Array(M);
  let pos = 0;
  for (let i = 0; i < M; i++) {
    const k = pos | 0, f = pos - k;
    y[i] = (1 - f) * x[k] + f * x[k + 1];
    pos += r;
  }
  return y;
}

function bessel0(x) { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; }

// Windowed-sinc (Kaiser) polyphase resampler with linear interpolation between table phases.
// zc = zero crossings per side (of the *input-rate* sinc before scaling), cutoff = fraction of output Nyquist.
export function makeSincResampler({ zc = 16, beta = 8.6, phases = 256, cutoff = 0.92 } = {}) {
  return function sincRate(x, r) {
    const scale = Math.min(1, 1 / r) * cutoff;         // normalized cutoff (1 = input Nyquist)
    const half = Math.ceil(zc / scale);                 // taps per side in input samples
    const taps = 2 * half;
    // table[p][j] for fractional offset p/phases
    const table = new Float32Array((phases + 1) * taps);
    const i0b = bessel0(beta);
    for (let p = 0; p <= phases; p++) {
      const frac = p / phases;
      for (let j = 0; j < taps; j++) {
        const t = (j - half + 1) - frac;              // distance from output instant in input samples
        const u = t / (half);
        const w = Math.abs(u) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - u * u)) / i0b;
        const a = Math.PI * t * scale;
        table[p * taps + j] = w * scale * (a === 0 ? 1 : Math.sin(a) / a);
      }
    }
    const M = Math.floor((x.length - 1) / r);
    const y = new Float32Array(M);
    const N = x.length;
    let pos = 0;
    for (let i = 0; i < M; i++) {
      const k = Math.floor(pos), frac = pos - k;
      const pf = frac * phases, p = pf | 0, pa = pf - p;
      const b0 = p * taps, b1 = b0 + taps;
      const start = k - half + 1;
      let acc0 = 0, acc1 = 0;
      if (start >= 0 && start + taps <= N) {
        for (let j = 0; j < taps; j++) { const s = x[start + j]; acc0 += table[b0 + j] * s; acc1 += table[b1 + j] * s; }
      } else {
        for (let j = 0; j < taps; j++) { const idx = start + j; if (idx < 0 || idx >= N) continue; const s = x[idx]; acc0 += table[b0 + j] * s; acc1 += table[b1 + j] * s; }
      }
      y[i] = acc0 + pa * (acc1 - acc0);
      pos += r;
    }
    return y;
  };
}

// ---------- analysis helpers ----------
export function fftReal(re, im) { // in-place radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi; re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Energy of (a-b) within [f0,f1] Hz relative to energy of b in [0, fmaxRef] (dB). Welch, Hann, 4096.
export function bandErrorDb(a, b, f0, f1, sr = SR, fmaxRef = 24000) {
  const n = 4096, hop = 2048, L = Math.min(a.length, b.length);
  let eErr = 0, eRef = 0;
  const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  for (let s = 0; s + n <= L; s += hop) {
    const re = new Float64Array(n), im = new Float64Array(n), re2 = new Float64Array(n), im2 = new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = (a[s + i] - b[s + i]) * w[i]; re2[i] = b[s + i] * w[i]; }
    fftReal(re, im); fftReal(re2, im2);
    for (let k = 0; k <= n / 2; k++) {
      const f = k * sr / n;
      if (f >= f0 && f <= f1) eErr += re[k] * re[k] + im[k] * im[k];
      if (f <= fmaxRef) eRef += re2[k] * re2[k] + im2[k] * im2[k];
    }
  }
  return 10 * Math.log10(eErr / eRef);
}

export function sineLevelDb(y, f, sr = SR) { // amplitude (dBFS) of component near f via Goertzel-like projection over whole signal (Hann)
  const N = y.length; let c = 0, s = 0, wsum = 0;
  for (let n = 0; n < N; n++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)); const ph = 2 * Math.PI * f * n / sr; c += y[n] * w * Math.cos(ph); s += y[n] * w * Math.sin(ph); wsum += w; }
  return 20 * Math.log10(2 * Math.hypot(c, s) / wsum);
}

export function bench(fn, reps = 7) {
  fn(); fn(); // warmup
  const ts = [];
  for (let i = 0; i < reps; i++) { const t0 = performance.now(); fn(); ts.push(performance.now() - t0); }
  ts.sort((p, q) => p - q);
  return ts[Math.floor(ts.length / 2)];
}

export function bandEnergy(a, f0, f1, sr = SR) {
  const n = 4096, hop = 2048; let e = 0;
  const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  for (let s = 0; s + n <= a.length; s += hop) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = a[s + i] * w[i];
    fftReal(re, im);
    for (let k = 0; k <= n / 2; k++) { const f = k * sr / n; if (f >= f0 && f <= f1) e += re[k] * re[k] + im[k] * im[k]; }
  }
  return e;
}
