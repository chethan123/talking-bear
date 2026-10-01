// Deterministic noise mixer for the M2 TTS regression corpus (plan §7 M2, issue #52): noise generators, a synthetic
// room impulse response, FFT overlap-add convolution, the phone-band high-pass, SNR mixing, and the scene plans of
// the fast and full subsets. scripts/gen-corpus.ts drives it and writes .cache/corpus/.
//
// Every random value comes from one mulberry32 PRNG per scene, seeded with (BASE_SEED + the scene's offset), and is
// drawn in a fixed order, so the same code on the same Node build produces the same bytes. All signals are 16 kHz;
// intermediate sums are float64, outputs Float32.

import { butterworthHighpass, butterworthLowpass } from '../src/dsp/biquad.ts';
import { mulberry32 } from '../test/dsp-helpers.ts';

export const SAMPLE_RATE = 16_000;
/** The corpus seed: scene k uses mulberry32((BASE_SEED + offset_k) >>> 0). */
export const BASE_SEED = 0xc0a5;

export const NOISES = ['fan', 'amfan', 'tv', 'music', 'clatter'] as const;
export type Noise = (typeof NOISES)[number];
export const SNRS_DB = [20, 10, 5, 0] as const;
export const SUBSETS = ['fast', 'full'] as const;
export type Subset = (typeof SUBSETS)[number];

export type Kind = 'word' | 'sentence' | 'passage';
/** A half-open [start, end) span in samples. */
export type Span = [start: number, end: number];
/** One clean render from test/corpus/speech/manifest.json (the fields the mixer uses). */
export interface CorpusEntry {
  id: string;
  kind: Kind;
  /** The rendered text; the two renders of a text (`…-r0`, `…-r1`) share it. */
  text: string;
  samples: number;
  spans: Span[];
}
/** The decoded clean audio of a manifest entry, by id. */
export type AudioLookup = (id: string) => Float32Array;

// Scene layout
/** Every SNR, passages and noise-only scene starts with 1 s of noise only. */
export const LEAD_SAMPLES = SAMPLE_RATE;
/** Each utterance is followed by a gap drawn uniformly from [GAP_MIN, GAP_MAX] samples (2–3 s). */
export const GAP_MIN = 2 * SAMPLE_RATE;
export const GAP_MAX = 3 * SAMPLE_RATE;
/** Full SNR scenes take utterances while the scene still fits in 90 s with a maximal gap after the next one. */
export const SCENE_MAX_SAMPLES = 90 * SAMPLE_RATE;
/** Fast SNR scenes hold exactly 20 utterances. */
export const FAST_UTTERANCES = 20;
/** Noise-only streams: 15 min each (full), 2 min of fan (fast). */
export const NOISE_ONLY_SAMPLES: Readonly<Record<Subset, number>> = {
  full: 15 * 60 * SAMPLE_RATE,
  fast: 2 * 60 * SAMPLE_RATE,
};

// Device approximation
export const RT60S = [0.2, 0.4, 0.6] as const;
/** Direct-to-reverb energy ratio of the synthetic RIR, in dB. */
export const DRR_DB = 6;
/** Phone-band high-pass (2nd-order Butterworth); the 8 kHz upper edge is the corpus Nyquist, so no low-pass. */
export const PHONE_HPF_HZ = 150;

// Noise recipes
export const FAN_PINK_WEIGHT = 0.7;
export const FAN_BROWN_WEIGHT = 0.3;
/** DC block of the integrated-white (brown) component: 2nd-order Butterworth high-pass. */
export const BROWN_HPF_HZ = 20;
export const AM_DEPTH = 0.6;
export const AM_HZ_MIN = 0.5;
export const AM_HZ_MAX = 3;
export const TV_STREAMS = 3;
/** Each TV stream is low-passed by a 2nd-order Butterworth low-pass at 3 kHz. */
export const TV_LPF_HZ = 3000;
/** Gaps between TV-stream utterances: uniform in [0, 0.5 s]. */
export const TV_GAP_MAX = SAMPLE_RATE / 2;
/** Each TV stream's relative level: uniform in [TV_LEVEL_MIN_DB, 0] dB. */
export const TV_LEVEL_MIN_DB = -6;
/** The fixed chord progression (I–V–vi–IV in C major) as MIDI notes; one chord per second, cycling. */
export const CHORDS_MIDI: readonly (readonly number[])[] = [
  [60, 64, 67],
  [55, 59, 62],
  [57, 60, 64],
  [53, 57, 60],
];
/** Each chord note is a sine plus 2 harmonics with amplitudes 1, 1/2, 1/3. */
export const CHORD_HARMONICS = 3;
export const CHORD_SAMPLES = SAMPLE_RATE;
/** Raised-cosine fade at both ends of each chord (10 ms), so chord changes don't click. */
export const CHORD_FADE_SAMPLES = 160;
/** Percussion: one burst per beat at 120 bpm. */
export const BEAT_SAMPLES = SAMPLE_RATE / 2;
/** Percussion burst: 30 ms of white noise × exp(−i / 120), i.e. a 7.5 ms time constant (−35 dB at its end). */
export const BURST_SAMPLES = 480;
export const BURST_TAU_SAMPLES = 120;
/** Percussion RMS relative to the chords' RMS (−6 dB). */
export const PERCUSSION_GAIN = 0.5;
/** Clatter: Poisson arrivals at 0.5 per second. */
export const CLATTER_RATE_HZ = 0.5;
/** Clatter burst length: uniform integer in [10 ms, 60 ms]. */
export const CLATTER_MIN_SAMPLES = 160;
export const CLATTER_MAX_SAMPLES = 960;
/** Clatter burst level: uniform in [CLATTER_LEVEL_MIN_DB, 0] dB; envelope exp(−4·i/length). */
export const CLATTER_LEVEL_MIN_DB = -20;

export type Rng = () => number;

/** A uniform integer in [lo, hi] (both inclusive). */
export function uniformInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** A uniform white sample in [−1, 1). */
function white(rng: Rng): number {
  return 2 * rng() - 1;
}

/** RMS of x over [from, to), in float64. */
export function rms(x: ArrayLike<number>, from = 0, to = x.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i]! * x[i]!;
  return to > from ? Math.sqrt(sum / (to - from)) : 0;
}

/** RMS of x over the union of the (disjoint) spans. */
export function activeRms(x: ArrayLike<number>, spans: readonly Span[]): number {
  let sum = 0;
  let count = 0;
  for (const [s, e] of spans) {
    for (let i = s; i < e; i++) sum += x[i]! * x[i]!;
    count += e - s;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/** Scales x in place to an RMS of `target` (default 1); throws on a silent signal. */
export function normaliseRms(x: Float32Array, target = 1): Float32Array {
  const r = rms(x);
  if (!(r > 0)) throw new Error('cannot normalise a silent signal');
  const g = target / r;
  for (let i = 0; i < x.length; i++) x[i] = x[i]! * g;
  return x;
}

// ---------------------------------------------------------------------------------------------------------------
// FFT and overlap-add convolution

export interface Fft {
  readonly size: number;
  /** In-place forward DFT: X[k] = Σ x[n]·e^{−j2πkn/N}. */
  forward(re: Float64Array, im: Float64Array): void;
  /** In-place inverse DFT, scaled by 1/N. */
  inverse(re: Float64Array, im: Float64Array): void;
}

/** An iterative radix-2 complex FFT of size n (a power of two ≥ 2), float64, with precomputed tables. */
export function createFft(n: number): Fft {
  if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) {
    throw new RangeError(`FFT size must be a power of two >= 2 (got ${n})`);
  }
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
    rev[i] = r >>> 0;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }
  const transform = (re: Float64Array, im: Float64Array, sign: number): void => {
    if (re.length !== n || im.length !== n) throw new RangeError(`FFT buffers must have length ${n}`);
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * step]!;
          const wi = sign * sin[j * step]!;
          const a = start + j;
          const b = a + half;
          const br = re[b]!;
          const bi = im[b]!;
          const tr = br * wr - bi * wi;
          const ti = br * wi + bi * wr;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
  };
  return {
    size: n,
    forward: (re, im) => transform(re, im, -1),
    inverse: (re, im) => {
      transform(re, im, 1);
      const scale = 1 / n;
      for (let i = 0; i < n; i++) {
        re[i] = re[i]! * scale;
        im[i] = im[i]! * scale;
      }
    },
  };
}

/** The smallest power of two ≥ n. */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * The first `outLength` samples (default x.length: the input's length) of the linear convolution x ∗ h, by FFT
 * overlap-add in float64: FFT size N = nextPow2(4·h.length) (at least 64), input blocks of N − h.length + 1
 * samples. Each block's tail (h.length − 1 samples) is carried in float64 into the next block, and every output
 * sample is rounded to Float32 once. outLength may be up to x.length + h.length − 1 (the full convolution).
 */
export function convolve(x: Float32Array, h: ArrayLike<number>, outLength = x.length): Float32Array {
  const L = h.length;
  if (L < 1) throw new RangeError('h must not be empty');
  if (!Number.isInteger(outLength) || outLength < 0 || outLength > x.length + L - 1) {
    throw new RangeError(`outLength must be an integer in [0, ${x.length + L - 1}] (got ${outLength})`);
  }
  const n = nextPow2(Math.max(64, 4 * L));
  const block = n - L + 1;
  const fft = createFft(n);
  const hr = new Float64Array(n);
  const hi = new Float64Array(n);
  for (let i = 0; i < L; i++) hr[i] = h[i]!;
  fft.forward(hr, hi);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const carry = new Float64Array(L - 1);
  const y = new Float32Array(outLength);
  for (let b = 0; b < outLength; b += block) {
    re.fill(0);
    im.fill(0);
    const end = Math.min(x.length, b + block);
    for (let i = b; i < end; i++) re[i - b] = x[i]!;
    fft.forward(re, im);
    for (let k = 0; k < n; k++) {
      const xr = re[k]!;
      const xi = im[k]!;
      re[k] = xr * hr[k]! - xi * hi[k]!;
      im[k] = xr * hi[k]! + xi * hr[k]!;
    }
    fft.inverse(re, im);
    const count = Math.min(block, outLength - b);
    for (let i = 0; i < count; i++) y[b + i] = re[i]! + (i < L - 1 ? carry[i]! : 0);
    // Block + carry overlap: the next block's first L − 1 outputs get this block's tail (block ≥ L − 1 here).
    for (let i = 0; i < L - 1; i++) carry[i] = re[block + i]!;
  }
  return y;
}

// ---------------------------------------------------------------------------------------------------------------
// Device approximation

/**
 * A synthetic room impulse response of round(rt60 · fs) taps: h[0] = 1 (the direct path), and for n ≥ 1
 * h[n] = g · w[n] · 10^(−3·n / (rt60·fs)) with w[n] uniform white noise in [−1, 1) (one draw per tap, in order), so
 * the reverb energy decays 60 dB in rt60. g is set so the direct-to-reverb energy ratio is exactly DRR_DB.
 */
export function makeRir(rng: Rng, rt60: number, fs = SAMPLE_RATE): Float64Array {
  const taps = Math.round(rt60 * fs);
  if (taps < 2) throw new RangeError(`RT60 ${rt60} s gives fewer than 2 taps`);
  const h = new Float64Array(taps);
  const decay = (-3 * Math.LN10) / (rt60 * fs);
  let energy = 0;
  for (let n = 1; n < taps; n++) {
    h[n] = white(rng) * Math.exp(decay * n);
    energy += h[n]! * h[n]!;
  }
  const g = Math.sqrt(10 ** (-DRR_DB / 10) / energy);
  for (let n = 1; n < taps; n++) h[n] = h[n]! * g;
  h[0] = 1;
  return h;
}

/** The device approximation of one signal: convolution with the RIR (truncated to x.length), then the 150 Hz HPF. */
export function deviceChain(x: Float32Array, rir: ArrayLike<number>): Float32Array {
  const y = convolve(x, rir);
  return butterworthHighpass(SAMPLE_RATE, PHONE_HPF_HZ).process(y, y);
}

// ---------------------------------------------------------------------------------------------------------------
// Noise generators. Each draws its random values from rng in the documented order and returns a unit-RMS signal.

/** Pink noise by Paul Kellet's refined filter (7 one-pole sections) on uniform white noise; not normalised. */
export function pinkNoise(rng: Rng, n: number): Float32Array {
  const y = new Float32Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = white(rng);
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    y[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return y;
}

/** Brown noise: the running sum (float64) of uniform white noise, DC-blocked by a 20 Hz Butterworth high-pass. */
export function brownNoise(rng: Rng, n: number): Float32Array {
  const y = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += white(rng);
    y[i] = acc;
  }
  return butterworthHighpass(SAMPLE_RATE, BROWN_HPF_HZ).process(y, y);
}

/** fan: 0.7 × unit-RMS pink + 0.3 × unit-RMS brown (pink drawn first), normalised to unit RMS. */
export function fanNoise(rng: Rng, n: number): Float32Array {
  const pink = normaliseRms(pinkNoise(rng, n));
  const brown = normaliseRms(brownNoise(rng, n));
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = FAN_PINK_WEIGHT * pink[i]! + FAN_BROWN_WEIGHT * brown[i]!;
  return normaliseRms(y);
}

/** amfan: unit-RMS pink × (1 + 0.6·sin(2π·f·i/fs)), f = 0.5 + 2.5·rng() Hz drawn before the pink; normalised. */
export function amfanNoise(rng: Rng, n: number): { noise: Float32Array; amHz: number } {
  const amHz = AM_HZ_MIN + (AM_HZ_MAX - AM_HZ_MIN) * rng();
  const pink = normaliseRms(pinkNoise(rng, n));
  const w = (2 * Math.PI * amHz) / SAMPLE_RATE;
  for (let i = 0; i < n; i++) pink[i] = pink[i]! * (1 + AM_DEPTH * Math.sin(w * i));
  return { noise: normaliseRms(pink), amHz };
}

/** MIDI note → Hz (A4 = 440 Hz, equal temperament). */
export function midiHz(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

/**
 * The 4-chord cycle (4 s): chord c = CHORDS_MIDI[c] fills [c·1 s, (c + 1)·1 s); each of its 3 notes contributes
 * Σ_{h=1..3} sin(2π·h·f·t)/h, t = the time since the chord started, under a 10 ms raised-cosine fade in and out.
 */
function chordCycle(): Float32Array {
  const cycle = new Float32Array(CHORDS_MIDI.length * CHORD_SAMPLES);
  CHORDS_MIDI.forEach((chord, c) => {
    const omegas = chord.map((note) => (2 * Math.PI * midiHz(note)) / SAMPLE_RATE);
    for (let pos = 0; pos < CHORD_SAMPLES; pos++) {
      const edge = Math.min(pos, CHORD_SAMPLES - pos);
      const env = edge < CHORD_FADE_SAMPLES ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / CHORD_FADE_SAMPLES) : 1;
      let v = 0;
      for (const omega of omegas) {
        for (let h = 1; h <= CHORD_HARMONICS; h++) v += Math.sin(h * omega * pos) / h;
      }
      cycle[c * CHORD_SAMPLES + pos] = env * v;
    }
  });
  return cycle;
}

/**
 * music: chords + percussion. The chords repeat the 4 s chord cycle from sample 0. Percussion: on every beat (every
 * 0.5 s from 0), 480 white samples × exp(−i/120) (all 480 drawn, even past the end). Chords and percussion are
 * each normalised to unit RMS, mixed as chords + 0.5 × percussion, and the sum normalised.
 */
export function musicNoise(rng: Rng, n: number): Float32Array {
  const cycle = chordCycle();
  const chords = new Float32Array(n);
  for (let i = 0; i < n; i++) chords[i] = cycle[i % cycle.length]!;
  const perc = new Float32Array(n);
  for (let start = 0; start < n; start += BEAT_SAMPLES) {
    for (let i = 0; i < BURST_SAMPLES; i++) {
      const v = white(rng) * Math.exp(-i / BURST_TAU_SAMPLES);
      if (start + i < n) perc[start + i] = v;
    }
  }
  normaliseRms(chords);
  normaliseRms(perc);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = chords[i]! + PERCUSSION_GAIN * perc[i]!;
  return normaliseRms(y);
}

/**
 * clatter: Poisson(0.5/s) bursts. Per event, in order: the inter-arrival time −ln(1 − u)/0.5 s (the onset is
 * round(t·fs); generation stops at the first onset ≥ n), the length uniform in [160, 960] samples, the level
 * −20·u dB, then one white draw per sample of exp(−4·i/length)-decaying noise; overlapping bursts add. Normalised.
 */
export function clatterNoise(rng: Rng, n: number): Float32Array {
  const y = new Float32Array(n);
  let t = 0;
  for (;;) {
    t += -Math.log(1 - rng()) / CLATTER_RATE_HZ;
    const start = Math.round(t * SAMPLE_RATE);
    if (start >= n) break;
    const length = uniformInt(rng, CLATTER_MIN_SAMPLES, CLATTER_MAX_SAMPLES);
    const gain = 10 ** ((CLATTER_LEVEL_MIN_DB * rng()) / 20);
    for (let i = 0; i < length; i++) {
      const v = gain * white(rng) * Math.exp((-4 * i) / length);
      if (start + i < n) y[start + i] = y[start + i]! + v;
    }
  }
  return normaliseRms(y);
}

/** One TV stream: its relative level and its utterances (in order) with their onsets. */
export interface BabbleStream {
  levelDb: number;
  items: { id: string; offset: number }[];
}

/**
 * The babble pool of a scene: every corpus entry (any kind) that is neither one of the scene's own utterances nor
 * another render of one of their texts, so the TV never speaks the scene's own words.
 */
export function babblePool(entries: readonly CorpusEntry[], sceneIds: readonly string[]): CorpusEntry[] {
  const ownIds = new Set(sceneIds);
  const ownTexts = new Set(entries.filter((e) => ownIds.has(e.id)).map((e) => e.text));
  return entries.filter((e) => !ownIds.has(e.id) && !ownTexts.has(e.text));
}

/**
 * Draws the TV streams: for each of the 3 streams, its level −6·u dB, a leading gap uniform in [0, 0.5 s], then
 * repeatedly an utterance drawn uniformly (with replacement) from the pool followed by a gap in [0, 0.5 s], until
 * the next onset is at or past n.
 */
export function planBabble(rng: Rng, pool: readonly CorpusEntry[], n: number): BabbleStream[] {
  if (pool.length === 0) throw new Error('empty babble pool');
  const streams: BabbleStream[] = [];
  for (let s = 0; s < TV_STREAMS; s++) {
    const levelDb = TV_LEVEL_MIN_DB * rng();
    const items: BabbleStream['items'] = [];
    let pos = uniformInt(rng, 0, TV_GAP_MAX);
    while (pos < n) {
      const entry = pool[Math.floor(rng() * pool.length)]!;
      items.push({ id: entry.id, offset: pos });
      pos += entry.samples + uniformInt(rng, 0, TV_GAP_MAX);
    }
    streams.push({ levelDb, items });
  }
  return streams;
}

/** tv: each stream's utterances placed (truncated at n), low-passed at 3 kHz, scaled by its level; summed, normalised. */
export function tvNoise(streams: readonly BabbleStream[], audio: AudioLookup, n: number): Float32Array {
  const y = new Float32Array(n);
  for (const { levelDb, items } of streams) {
    const stream = new Float32Array(n);
    for (const { id, offset } of items) {
      const a = audio(id);
      stream.set(a.subarray(0, Math.min(a.length, n - offset)), offset);
    }
    butterworthLowpass(SAMPLE_RATE, TV_LPF_HZ).process(stream, stream);
    const g = 10 ** (levelDb / 20);
    for (let i = 0; i < n; i++) y[i] = y[i]! + g * stream[i]!;
  }
  return normaliseRms(y);
}

// ---------------------------------------------------------------------------------------------------------------
// SNR mixing

/**
 * speech + g·noise with g chosen so that the speech RMS over the spans is snrDb above the RMS of g·noise over the
 * same samples. Returns the mix (Float32) and g.
 */
export function mixAtSnr(
  speech: Float32Array,
  noise: Float32Array,
  spans: readonly Span[],
  snrDb: number,
): { mix: Float32Array; noiseGain: number } {
  if (speech.length !== noise.length) throw new RangeError('speech and noise lengths differ');
  const s = activeRms(speech, spans);
  const v = activeRms(noise, spans);
  if (!(s > 0) || !(v > 0)) throw new Error('speech or noise is silent over the spans');
  const noiseGain = s / (v * 10 ** (snrDb / 20));
  const mix = new Float32Array(speech.length);
  for (let i = 0; i < mix.length; i++) mix[i] = speech[i]! + noiseGain * noise[i]!;
  return { mix, noiseGain };
}

// ---------------------------------------------------------------------------------------------------------------
// Scene plans

export type SceneType = 'snr' | 'passages' | 'noise-only';

export interface Placement {
  id: string;
  kind: Kind;
  /** Onset in the scene, in samples. */
  offset: number;
}

export interface ScenePlan {
  /** File stem: `<name>.f32` and `<name>.json` in .cache/corpus/. */
  name: string;
  /** The subset the scene belongs to; `--subset full` generates both. */
  group: Subset;
  type: SceneType;
  noise: Noise;
  snrDb: number | null;
  /** The PRNG seed is (BASE_SEED + offset) >>> 0; offsets are unique across all scenes. */
  offset: number;
  seed: number;
  rt60: number;
  samples: number;
  /** Index into the cyclic word+sentence list of the first utterance (SNR scenes). */
  start: number | null;
  placements: Placement[];
  /** rng() calls consumed by the layout (the RT60 choice and the gaps); rendering skips this many. */
  layoutDraws: number;
  /** noise-only: the SNR-10 scene whose absolute noise level the stream copies. */
  levelFrom: string | null;
}

interface SceneSpec {
  name: string;
  group: Subset;
  type: SceneType;
  noise: Noise;
  snrDb: number | null;
  offset: number;
  levelFrom: string | null;
}

/**
 * Every scene spec in seed-offset order: the 20 full SNR scenes (noise-major: fan, amfan, tv, music, clatter; SNR
 * 20, 10, 5, 0) at offsets 0–19, the 15-min fan and music noise-only streams (20, 21), the passages scene (22), then
 * the fast subset: fan and tv at SNR 10 and 5 (23–26) and 2 min of fan noise-only (27).
 */
export function sceneSpecs(): SceneSpec[] {
  const specs: SceneSpec[] = [];
  const add = (spec: Omit<SceneSpec, 'offset'>): void => {
    specs.push({ ...spec, offset: specs.length });
  };
  for (const noise of NOISES) {
    for (const snrDb of SNRS_DB) {
      add({ name: `${noise}-snr${snrDb}`, group: 'full', type: 'snr', noise, snrDb, levelFrom: null });
    }
  }
  for (const noise of ['fan', 'music'] as const) {
    add({
      name: `${noise}-noise`,
      group: 'full',
      type: 'noise-only',
      noise,
      snrDb: null,
      levelFrom: `${noise}-snr10`,
    });
  }
  add({ name: 'passages', group: 'full', type: 'passages', noise: 'fan', snrDb: 20, levelFrom: null });
  for (const noise of ['fan', 'tv'] as const) {
    for (const snrDb of [10, 5]) {
      add({ name: `fast-${noise}-snr${snrDb}`, group: 'fast', type: 'snr', noise, snrDb, levelFrom: null });
    }
  }
  add({
    name: 'fast-fan-noise',
    group: 'fast',
    type: 'noise-only',
    noise: 'fan',
    snrDb: null,
    levelFrom: 'fast-fan-snr10',
  });
  return specs;
}

/**
 * The layout draws (rendering skips them with sceneRng): rt60 = RT60S[floor(3·u)], then one gap per utterance taken.
 * `candidates` are tried in order; with `maxSamples` an utterance is taken only while the cursor + its length +
 * GAP_MAX still fits (no draw for the first that doesn't), with `maxCount` at most that many are taken.
 */
function drawLayout(
  rng: Rng,
  candidates: Iterable<CorpusEntry>,
  limit: { maxSamples?: number; maxCount?: number },
): { rt60: number; placements: Placement[]; cursor: number; draws: number } {
  let draws = 1;
  const rt60 = RT60S[Math.floor(rng() * RT60S.length)]!;
  const placements: Placement[] = [];
  let cursor = LEAD_SAMPLES;
  for (const entry of candidates) {
    if (limit.maxCount !== undefined && placements.length >= limit.maxCount) break;
    if (limit.maxSamples !== undefined && cursor + entry.samples + GAP_MAX > limit.maxSamples) break;
    placements.push({ id: entry.id, kind: entry.kind, offset: cursor });
    cursor += entry.samples + uniformInt(rng, GAP_MIN, GAP_MAX);
    draws++;
  }
  return { rt60, placements, cursor, draws };
}

/** The word and sentence renders in manifest order, cycled from `start` (at most `count` items). */
function* cyclic(list: readonly CorpusEntry[], start: number, count: number): Generator<CorpusEntry> {
  for (let i = 0; i < count; i++) yield list[(start + i) % list.length]!;
}

/** The (BASE_SEED + offset) seed, as an unsigned 32-bit integer. */
export function sceneSeed(offset: number): number {
  return (BASE_SEED + offset) >>> 0;
}

/**
 * The rotation of the cyclic word+sentence list for the SNR scene with noise index i (NOISES order) and SNR index j
 * (SNRS_DB order): floor(len·(4i + 5j) / 20) mod len, i.e. (20i + 25j) mod 100 for the 100 short renders. A noise's
 * four SNR scenes start a quarter of the list apart, and an SNR's five noise scenes a fifth apart, so neither the
 * noise nor the SNR is confounded with words vs sentences (the list is 60 words, then 40 sentences).
 */
export function rotationStart(noise: Noise, snrDb: number, length: number): number {
  const i = NOISES.indexOf(noise);
  const j = SNRS_DB.findIndex((s) => s === snrDb);
  if (i < 0 || j < 0) throw new RangeError(`no rotation for ${noise} at ${snrDb} dB`);
  return Math.floor((length * (4 * i + 5 * j)) / 20) % length;
}

/**
 * Plans every scene of `subset` from the manifest entries. An SNR scene takes word/sentence renders in cyclic
 * manifest order (words, then sentences) from rotationStart: a full scene as many as fit in 90 s, a fast scene
 * exactly 20 (so it starts like the full scene with the same noise and SNR). The passages scene holds every passage
 * render in manifest order. `full` returns all 28 scenes (the fast ones included), `fast` only the 5 fast ones.
 */
export function planCorpus(subset: Subset, entries: readonly CorpusEntry[]): ScenePlan[] {
  const short = entries.filter((e) => e.kind === 'word' || e.kind === 'sentence');
  const passages = entries.filter((e) => e.kind === 'passage');
  if (short.length === 0 || passages.length === 0)
    throw new Error('the manifest needs short utterances and passages');
  const plans: ScenePlan[] = [];
  for (const spec of sceneSpecs()) {
    if (subset !== 'full' && spec.group !== subset) continue;
    const seed = sceneSeed(spec.offset);
    const rng = mulberry32(seed);
    let start: number | null = null;
    let layout: ReturnType<typeof drawLayout>;
    if (spec.type === 'snr') {
      start = rotationStart(spec.noise, spec.snrDb!, short.length);
      layout =
        spec.group === 'full'
          ? drawLayout(rng, cyclic(short, start, Infinity), { maxSamples: SCENE_MAX_SAMPLES })
          : drawLayout(rng, cyclic(short, start, FAST_UTTERANCES), { maxCount: FAST_UTTERANCES });
    } else if (spec.type === 'passages') {
      layout = drawLayout(rng, passages, {});
    } else {
      layout = drawLayout(rng, [], {});
    }
    plans.push({
      ...spec,
      seed,
      rt60: layout.rt60,
      samples: spec.type === 'noise-only' ? NOISE_ONLY_SAMPLES[spec.group] : layout.cursor,
      start,
      placements: layout.placements,
      layoutDraws: layout.draws,
    });
  }
  return plans;
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

/** The scene's PRNG, positioned after its layout draws: the next draws are the RIR tail, then the noise. */
export function sceneRng(plan: Pick<ScenePlan, 'seed' | 'layoutDraws'>): Rng {
  const rng = mulberry32(plan.seed);
  for (let i = 0; i < plan.layoutDraws; i++) rng();
  return rng;
}

/** The `<scene>.json` sidecar. */
export interface SceneMeta {
  sampleRate: number;
  samples: number;
  noise: Noise;
  snrDb: number | null;
  rt60: number;
  /** Speech spans (the clean labels of each placed utterance, shifted to its onset), in order. */
  spans: Span[];
  /** The kind of each span's utterance. */
  kinds: Kind[];
  /** The manifest id of each span's utterance. */
  ids: string[];
}

export interface RenderedScene {
  /** The scene: device-processed speech + scaled device-processed noise. */
  audio: Float32Array;
  meta: SceneMeta;
  /** Device-processed speech (zeros for noise-only scenes). */
  speech: Float32Array;
  /** Device-processed noise, scaled as mixed. */
  noise: Float32Array;
  /** RMS of `noise` over the whole scene: the absolute noise level a noise-only stream copies. */
  noiseRms: number;
  /** tv scenes: every utterance id used by the babble. */
  babbleIds: string[];
}

/**
 * Renders a planned scene. Draw order after the layout draws: the RIR tail (round(rt60·fs) − 1 draws), then the
 * noise. Speech and noise each go through the device chain (same RIR); SNR scenes are mixed at snrDb over the
 * spans; a noise-only stream is scaled so its RMS equals `levelRms` (the noiseRms of its levelFrom scene).
 */
export function renderScene(
  plan: ScenePlan,
  entries: readonly CorpusEntry[],
  audio: AudioLookup,
  levelRms?: number,
): RenderedScene {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const rng = sceneRng(plan);
  const rir = makeRir(rng, plan.rt60);
  const n = plan.samples;
  const sceneIds = plan.placements.map((p) => p.id);
  let raw: Float32Array;
  let babbleIds: string[] = [];
  switch (plan.noise) {
    case 'fan':
      raw = fanNoise(rng, n);
      break;
    case 'amfan':
      raw = amfanNoise(rng, n).noise;
      break;
    case 'tv': {
      const streams = planBabble(rng, babblePool(entries, sceneIds), n);
      babbleIds = streams.flatMap((s) => s.items.map((item) => item.id));
      raw = tvNoise(streams, audio, n);
      break;
    }
    case 'music':
      raw = musicNoise(rng, n);
      break;
    case 'clatter':
      raw = clatterNoise(rng, n);
      break;
  }
  const noise = deviceChain(raw, rir);
  const spans: Span[] = [];
  const kinds: Kind[] = [];
  const ids: string[] = [];
  const clean = new Float32Array(n);
  for (const { id, kind, offset } of plan.placements) {
    const entry = byId.get(id);
    if (entry === undefined) throw new Error(`${plan.name}: unknown utterance ${id}`);
    const a = audio(id);
    if (a.length !== entry.samples)
      throw new Error(`${id}: ${a.length} samples, manifest says ${entry.samples}`);
    clean.set(a, offset);
    for (const [s, e] of entry.spans) {
      spans.push([offset + s, offset + e]);
      kinds.push(kind);
      ids.push(id);
    }
  }
  let out: Float32Array;
  let speech: Float32Array;
  let scaled: Float32Array;
  if (plan.type === 'noise-only') {
    if (levelRms === undefined || !(levelRms > 0))
      throw new Error(`${plan.name}: needs the level of ${plan.levelFrom}`);
    speech = clean;
    scaled = normaliseRms(noise, levelRms);
    out = Float32Array.from(scaled);
  } else {
    speech = deviceChain(clean, rir);
    const { mix, noiseGain } = mixAtSnr(speech, noise, spans, plan.snrDb!);
    for (let i = 0; i < n; i++) noise[i] = noiseGain * noise[i]!;
    scaled = noise;
    out = mix;
  }
  const meta: SceneMeta = {
    sampleRate: SAMPLE_RATE,
    samples: n,
    noise: plan.noise,
    snrDb: plan.snrDb,
    rt60: plan.rt60,
    spans,
    kinds,
    ids,
  };
  return { audio: out, meta, speech, noise: scaled, noiseRms: rms(scaled), babbleIds };
}

/** Raw little-endian Float32 bytes of x. */
export function f32leBytes(x: Float32Array): Uint8Array {
  const bytes = new Uint8Array(x.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < x.length; i++) view.setFloat32(i * 4, x[i]!, true);
  return bytes;
}

/** The `<scene>.json` bytes: compact JSON plus a newline. */
export function metaBytes(meta: SceneMeta): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(meta)}\n`);
}
