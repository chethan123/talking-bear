// Node timing of the voice chain (src/dsp/voice.ts processVoice; plan §4.3.4, budget §4.10: p95 ≤ 15 ms per
// second of audio on D1). Duck plan T114: run it before and after a voice-chain change on the same machine.
//
// For each rate (48 and 44.1 kHz), clip length (1, 5 and 10 s) and preset (cub, chipmunk, bigbear, duck), it calls
// processVoice(clip, rate, preset) WARMUPS times untimed, then RUNS times with performance.now() around each
// call, and prints the median and p95 (nearest rank) in ms and in ms per second of input audio. Each row also
// prints the output length and an FNV-1a hash of the output's float32 bits, so the outputs of two runs (before
// and after a change) can be checked for bit-identity.
//
// The input is lab/bench.worker.ts's synthetic voice-chain clip: 500 ms units of a 400 ms synthetic vowel
// burst then 100 ms of pink noise at −40 dBFS RMS. lab/bench.worker.ts is a Worker module whose generators are
// module-private, so SEED, mulberry32, pinkNoise, resonate, vowel and speechClip and the constants they read
// are copied here verbatim. Nothing is captured, stored or exported (plan Q2).
//
// Usage: node scripts/bench-voice.ts
// Node script (type stripping): relative imports end in `.ts` and the syntax is erasable (CLAUDE.md rule 11).

import { PRESETS, type VoicePreset } from '../src/dsp/types.ts';
import { processVoice } from '../src/dsp/voice.ts';

/** Untimed calls before the timed ones, per rate, clip and preset. */
const WARMUPS = 4;
/** Timed calls per rate, clip and preset. */
const RUNS = 30;
const RATES: readonly number[] = [48000, 44100];
const CLIPS_S: readonly number[] = [1, 5, 10];
const VOICE_PRESETS: readonly VoicePreset[] = [PRESETS.cub, PRESETS.chipmunk, PRESETS.bigbear, PRESETS.duck];

// ---- copied verbatim from lab/bench.worker.ts ---------------------------------------------------------------

// Synthetic input (scripts/gen-fixtures.ts recipes, at the benchmark's rate).
const SEED = 43;
const NOISE_DBFS = -40;
const VOWEL_F0 = 140;
const VOWEL_PEAK_DBFS = -12;
const FADE_S = 0.02;
/** Formants (Hz) and bandwidths (Hz) of the synthetic vowel: F1 700/80, F2 1220/90, F3 2600/120. */
const FORMANTS: readonly (readonly [number, number])[] = [
  [700, 80],
  [1220, 90],
  [2600, 120],
];

/** A clip is 500 ms units of a 400 ms vowel burst then 100 ms of pink noise: 20 % of it is noise. */
const BURST_S = 0.4;
const NOISE_GAP_S = 0.1;

/** Seeded 32-bit PRNG (mulberry32, as test/dsp-helpers.ts): uniform values in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n samples of pink noise (Paul Kellet's refined filter on white noise from rng), scaled to `db` dBFS RMS. */
function pinkNoise(rng: () => number, n: number, db: number): Float64Array {
  const x = new Float64Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const w = 2 * rng() - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    x[i] = v;
    sumSq += v * v;
  }
  const gain = 10 ** (db / 20) / Math.sqrt(sumSq / n);
  for (let i = 0; i < n; i++) x[i] = x[i]! * gain;
  return x;
}

/** One 2nd-order Klatt resonator at `rate`, in place: y = A·x + B·y1 + C·y2 (unity gain at DC). */
function resonate(x: Float64Array, rate: number, freq: number, bandwidth: number): void {
  const c = -Math.exp((-2 * Math.PI * bandwidth) / rate);
  const b = 2 * Math.exp((-Math.PI * bandwidth) / rate) * Math.cos((2 * Math.PI * freq) / rate);
  const a = 1 - b - c;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = a * x[i]! + b * y1 + c * y2;
    x[i] = v;
    y2 = y1;
    y1 = v;
  }
}

/**
 * n samples of a synthetic vowel at `rate`: an impulse train at f0 (±1 % period jitter) through the three
 * FORMANTS resonators, times a 4 Hz syllabic envelope and 20 ms raised-cosine fades, peak-normalised.
 */
function vowel(rng: () => number, rate: number, n: number): Float64Array {
  const x = new Float64Array(n);
  for (let pos = 0; Math.round(pos) < n; pos += (rate / VOWEL_F0) * (1 + 0.01 * (2 * rng() - 1))) {
    x[Math.round(pos)] = 1;
  }
  for (const [freq, bandwidth] of FORMANTS) resonate(x, rate, freq, bandwidth);
  const fade = Math.round(FADE_S * rate);
  const fadeGain = (i: number): number => 0.5 * (1 - Math.cos((Math.PI * i) / fade));
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let gain = 0.5 * (1 - Math.cos((2 * Math.PI * 4 * i) / rate));
    if (i < fade) gain *= fadeGain(i);
    if (i >= n - fade) gain *= fadeGain(n - 1 - i);
    const v = x[i]! * gain;
    x[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  const g = 10 ** (VOWEL_PEAK_DBFS / 20) / peak;
  for (let i = 0; i < n; i++) x[i] = x[i]! * g;
  return x;
}

/**
 * A voice-chain clip of `seconds` (a multiple of 0.5) at `rate`: 500 ms units, each a 400 ms vowel burst (the
 * vowel above: 4 Hz syllabic envelope, 20 ms fades, peak −12 dBFS) then 100 ms of pink noise at −40 dBFS RMS,
 * so 20 % of the clip is noise. Seeded: the same arguments always give the same clip.
 */
function speechClip(rate: number, seconds: number): Float32Array {
  const rng = mulberry32(SEED);
  const n = Math.round(seconds * rate);
  const burst = Math.round(BURST_S * rate);
  const gap = Math.round(NOISE_GAP_S * rate);
  const clip = new Float32Array(n);
  for (let pos = 0; pos < n;) {
    const b = Math.min(burst, n - pos);
    clip.set(vowel(rng, rate, b), pos);
    pos += b;
    const g = Math.min(gap, n - pos);
    if (g > 0) clip.set(pinkNoise(rng, g, NOISE_DBFS), pos);
    pos += g;
  }
  return clip;
}

// ---- end of the copy ----------------------------------------------------------------------------------------

/** Nearest-rank percentile of ascending `sorted` (n ≥ 1), as lab/bench.worker.ts computes it. */
function percentile(sorted: Float64Array, p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

/** FNV-1a (32-bit) over the float32 bit patterns of a, as 8 hex digits. */
function hashBits(a: Float32Array): string {
  const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) {
    let w = u[i]!;
    for (let k = 0; k < 4; k++) {
      h = Math.imul(h ^ (w & 0xff), 0x01000193);
      w >>>= 8;
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function main(): void {
  console.log(
    `bench-voice: processVoice, ${WARMUPS} untimed warm-ups then ${RUNS} timed runs per row; ` +
      `median and p95 are nearest-rank; Node ${process.version} on ${process.platform}/${process.arch}`,
  );
  console.log(
    '| rate | clip | preset | median ms | p95 ms | median ms/s | p95 ms/s | out samples | out hash |',
  );
  console.log('|---:|---:|---|---:|---:|---:|---:|---:|---|');
  for (const rate of RATES) {
    for (const clipS of CLIPS_S) {
      const pcm = speechClip(rate, clipS);
      const seconds = pcm.length / rate;
      for (const preset of VOICE_PRESETS) {
        let out = processVoice(pcm, rate, preset);
        for (let k = 1; k < WARMUPS; k++) out = processVoice(pcm, rate, preset);
        const times = new Float64Array(RUNS);
        for (let i = 0; i < RUNS; i++) {
          const t0 = performance.now();
          processVoice(pcm, rate, preset);
          times[i] = performance.now() - t0;
        }
        times.sort();
        const p50 = percentile(times, 50);
        const p95 = percentile(times, 95);
        console.log(
          `| ${rate} | ${clipS} s | ${preset.id} | ${p50.toFixed(2)} | ${p95.toFixed(2)} | ` +
            `${(p50 / seconds).toFixed(2)} | ${(p95 / seconds).toFixed(2)} | ${out.pcm.length} | ` +
            `${hashBits(out.pcm)} |`,
        );
      }
    }
  }
}

main();
