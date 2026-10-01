// Lab-only TD-PSOLA pitch shifter and YIN-lite pitch tracker for lab/voices (X-F1, plan §5, §4.3.2–§4.3.3): a
// TypeScript port of `psola` and `trackPitch` from docs/research/spikes/03-voice-resampling/algos.mjs, with
// the spike's sinc decimator (`makeSincResampler` in that folder's dsp.mjs) as a private helper. Dev-only: it
// is never part of the app (CLAUDE.md rule 6: nothing imports from docs/research; this is a copy).
//
// Convention (the spike README's warning): `pitchRatio` here is the PITCH ratio p (2 = an octave up), the
// spike's `r`. It is not the production resampler's `ratio` (= outRate / inRate = 1/p, plan §3.3).
//
// Changes from the spike, none of which changes an output sample at 48 kHz:
// - The spike hard-codes SR = 48000. Here the sample rate `fs` is a parameter: the tracker runs at fs / 4,
//   periods are fs / f0 samples, and the unvoiced grid is round(0.005·fs) samples (240 at 48 kHz, as in the
//   spike).
// - psola takes its pitch track and formant factor in one options object.
// - Both functions throw RangeError on an invalid fs or pitch ratio (the spike loops forever on p ≤ 0).
// - An empty input gives an empty track and output (the spike's decimator throws on it).
// - trackPitch zero-fills its decimated copy of the input before returning (plan Q2: no stray audio copy).

/** A pitch track: f0 in Hz per hop (0 = unvoiced or silent), hops of `hopSamples` input samples. */
export interface PitchTrack {
  readonly f0: Float32Array;
  readonly hopSamples: number;
}

export interface TrackPitchOpts {
  /** Hop in ms (default 5). */
  readonly hopMs?: number;
  /** F0 search range in Hz (defaults 70 and 900). */
  readonly fmin?: number;
  readonly fmax?: number;
  /** YIN absolute threshold on the cumulative-mean-normalised difference (default 0.15). */
  readonly thresh?: number;
}

export interface PsolaOpts {
  /** The pitch track of x; default trackPitch(x, fs). */
  readonly track?: PitchTrack;
  /**
   * Grain resampling factor in voiced regions: 1 (the default) copies each grain unchanged, which preserves
   * the formants; f > 1 reads grains f× faster, which shifts the formants up by f.
   */
  readonly formant?: number;
}

function checkRate(fs: number): void {
  if (!(Number.isFinite(fs) && fs > 0)) throw new RangeError(`fs must be finite and > 0 (fs = ${fs})`);
}

/** Modified Bessel function of the first kind, order 0: the spike's 30-term series. */
function bessel0(x: number): number {
  let s = 1;
  let t = 1;
  for (let k = 1; k < 30; k++) {
    t *= (x / (2 * k)) ** 2;
    s += t;
  }
  return s;
}

/**
 * The spike's makeSincResampler({ zc: 6, beta: 6, phases: 64, cutoff: 0.9 }) applied with rate r = 4: a
 * Kaiser-windowed sinc (polyphase table, linear interpolation between phases) that reads x at positions
 * 0, r, 2r, …; floor((n − 1) / r) output samples.
 */
function decimate(x: Float32Array, r: number): Float32Array {
  const zc = 6;
  const beta = 6;
  const phases = 64;
  const cutoff = 0.9;
  const scale = Math.min(1, 1 / r) * cutoff; // normalised cutoff (1 = input Nyquist)
  const half = Math.ceil(zc / scale); // taps per side in input samples
  const taps = 2 * half;
  // table[p][j] for fractional offset p / phases
  const table = new Float32Array((phases + 1) * taps);
  const i0b = bessel0(beta);
  for (let p = 0; p <= phases; p++) {
    const frac = p / phases;
    for (let j = 0; j < taps; j++) {
      const t = j - half + 1 - frac; // distance from the output instant in input samples
      const u = t / half;
      const w = Math.abs(u) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - u * u)) / i0b;
      const a = Math.PI * t * scale;
      table[p * taps + j] = w * scale * (a === 0 ? 1 : Math.sin(a) / a);
    }
  }
  const n = x.length;
  const m = Math.floor((n - 1) / r);
  const y = new Float32Array(Math.max(0, m));
  let pos = 0;
  for (let i = 0; i < m; i++) {
    const k = Math.floor(pos);
    const frac = pos - k;
    const pf = frac * phases;
    const p = pf | 0;
    const pa = pf - p;
    const b0 = p * taps;
    const b1 = b0 + taps;
    const start = k - half + 1;
    let acc0 = 0;
    let acc1 = 0;
    if (start >= 0 && start + taps <= n) {
      for (let j = 0; j < taps; j++) {
        const s = x[start + j]!;
        acc0 += table[b0 + j]! * s;
        acc1 += table[b1 + j]! * s;
      }
    } else {
      for (let j = 0; j < taps; j++) {
        const idx = start + j;
        if (idx < 0 || idx >= n) continue;
        const s = x[idx]!;
        acc0 += table[b0 + j]! * s;
        acc1 += table[b1 + j]! * s;
      }
    }
    y[i] = acc0 + pa * (acc1 - acc0);
    pos += r;
  }
  return y;
}

/**
 * YIN-lite pitch tracker (the spike's trackPitch): on a 4× sinc-decimated copy of x (rate sr = fs / 4), frames
 * of W = round(0.025·sr) samples every hop = round(hopMs·sr/1000) samples; a frame whose mean square is below
 * 1e-5 is unvoiced (0); otherwise the first lag τ > tmin + 1 whose cumulative-mean-normalised difference has a
 * local minimum below `thresh` (searched up to tmax = ceil(sr / fmin), tmin = floor(sr / fmax)) is refined
 * parabolically and f0 = sr / τ; no such lag gives 0. Returns the f0 per frame and hopSamples = 4·hop (input
 * samples per frame). Throws RangeError unless fs is finite and > 0.
 */
export function trackPitch(x: Float32Array, fs: number, opts: TrackPitchOpts = {}): PitchTrack {
  checkRate(fs);
  const { hopMs = 5, fmin = 70, fmax = 900, thresh = 0.15 } = opts;
  const xd = decimate(x, 4);
  const sr = fs / 4;
  const hop = Math.round((hopMs * sr) / 1000);
  const w = Math.round(0.025 * sr);
  const tmin = Math.floor(sr / fmax);
  const tmax = Math.ceil(sr / fmin);
  const frames = Math.floor((xd.length - w - tmax) / hop);
  const f0 = new Float32Array(Math.max(0, frames));
  const d = new Float32Array(tmax + 1);
  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    let en = 0;
    for (let i = 0; i < w; i++) en += xd[s + i]! * xd[s + i]!;
    if (en / w < 1e-5) {
      f0[f] = 0;
      continue;
    }
    let run = 0;
    d[0] = 1;
    let found = 0;
    for (let t = 1; t <= tmax; t++) {
      let acc = 0;
      for (let i = 0; i < w; i++) {
        const v = xd[s + i]! - xd[s + i + t]!;
        acc += v * v;
      }
      run += acc;
      d[t] = (acc * t) / (run || 1);
      if (t > tmin + 1 && !found && d[t - 1]! < thresh && d[t - 1]! <= d[t]! && d[t - 1]! <= d[t - 2]!) {
        found = t - 1;
        break;
      }
    }
    if (found) {
      // parabolic refinement
      const a = d[found - 1]!;
      const b = d[found]!;
      const c = d[found + 1]!;
      const den = a - 2 * b + c;
      const tt = found + (den ? (0.5 * (a - c)) / den : 0);
      f0[f] = sr / tt;
    } else {
      f0[f] = 0;
    }
  }
  xd.fill(0); // the decimated copy of the input is not kept (plan Q2)
  return { f0, hopSamples: hop * 4 };
}

/**
 * TD-PSOLA (the spike's psola): a duration-preserving pitch shift of x (at fs) by the pitch ratio
 * `pitchRatio` p. Analysis marks follow the pitch track (each snapped to the largest sample within ±P/3 of its
 * nominal place, P = fs / f0 the local period; unvoiced stretches use a fixed round(0.005·fs)-sample grid).
 * Synthesis marks advance by P / p in voiced regions (by P in unvoiced ones, so those keep their pitch); each
 * takes the nearest analysis mark's Hann grain of 2·round(P) samples (read `formant`× faster when voiced;
 * linear interpolation), overlap-added and normalised by the window sum. Returns a new buffer of x.length
 * samples; x is not modified. Throws RangeError unless fs and pitchRatio are finite and > 0.
 */
export function psola(x: Float32Array, fs: number, pitchRatio: number, opts: PsolaOpts = {}): Float32Array {
  checkRate(fs);
  if (!(Number.isFinite(pitchRatio) && pitchRatio > 0)) {
    throw new RangeError(`pitchRatio must be finite and > 0 (pitchRatio = ${pitchRatio})`);
  }
  const r = pitchRatio;
  const { track = trackPitch(x, fs), formant = 1 } = opts;
  const { f0, hopSamples } = track;
  const n = x.length;
  const unvoicedStep = Math.round(0.005 * fs); // 240 at 48 kHz, the spike's constant
  const periodAt = (at: number): number => {
    const i = Math.min(f0.length - 1, Math.max(0, Math.round(at / hopSamples)));
    const v = f0[i];
    return v !== undefined && v > 0 ? fs / v : 0;
  };
  // analysis marks
  const marks: number[] = [];
  const per: number[] = [];
  let pos = 0;
  while (pos < n) {
    const p = periodAt(pos);
    if (p > 0) {
      // snap to the local max of x within ±P/3 around pos
      const lo = Math.max(0, Math.round(pos - p / 3));
      const hi = Math.min(n - 1, Math.round(pos + p / 3));
      let m = lo;
      let mv = -1;
      for (let i = lo; i <= hi; i++) {
        const v = x[i]!;
        if (v > mv) {
          mv = v;
          m = i;
        }
      }
      const last = marks[marks.length - 1];
      if (last !== undefined && m <= last + p / 2) m = Math.round(last + p);
      marks.push(m);
      per.push(p);
      pos = m + p;
    } else {
      // unvoiced: a 5 ms grid, no pitch change
      marks.push(pos);
      per.push(unvoicedStep);
      pos += unvoicedStep;
    }
  }
  const y = new Float32Array(n);
  const ws = new Float32Array(n);
  let t = marks[0] ?? 0;
  let mi = 0;
  while (t < n) {
    while (mi + 1 < marks.length && Math.abs(marks[mi + 1]! - t) < Math.abs(marks[mi]! - t)) mi++;
    const m = marks[mi]!;
    const p = per[mi]!;
    const voiced = periodAt(m) > 0;
    const len = Math.round(p);
    const ti = Math.round(t);
    for (let i = -len; i < len; i++) {
      const w = 0.5 + 0.5 * Math.cos((Math.PI * i) / len);
      const src = m + i * (voiced ? formant : 1);
      const o = ti + i;
      if (o < 0 || o >= n) continue;
      const k = Math.floor(src);
      const fr = src - k;
      if (k < 0 || k + 1 >= n) continue;
      y[o] = y[o]! + w * ((1 - fr) * x[k]! + fr * x[k + 1]!);
      ws[o] = ws[o]! + w;
    }
    t += voiced ? p / r : p;
  }
  for (let i = 0; i < n; i++) if (ws[i]! > 1e-3) y[i] = y[i]! / ws[i]!;
  return y;
}
