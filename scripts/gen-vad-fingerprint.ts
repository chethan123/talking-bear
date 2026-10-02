// VAD front-end fingerprint (issue #171, plan §7 M2 "Stale traces"). frontEndHash (src/vad-trace/format.ts)
// hashes FRONT_END_CONFIG's values only, so a change to the front end's implementation (the resampler's
// kernel, the biquads, frameDb, the voicing normalisation, the Silero model code) would leave committed
// real-voice traces looking current. This file runs a seeded synthetic signal through the production front
// end and keeps the four logged streams in src/vad-trace/fingerprint.golden.json; fingerprint.test.ts checks
// that the build still reproduces them under the golden's revision, which must be FRONT_END_CONFIG.revision.
//
// The streams follow the trace format (#48, format.ts), at 48 and 44.1 kHz, with exported production code
// only:
//   capture worklet  per 128-frame quantum, butterworthHighpass(rate, hpfClipHz), then the 16 kHz decimator
//                    built as src/audio/capture.worklet.ts builds it, createResampler(rate, VAD_RATE);
//   DSP worker       512-sample frames from decimator output 0 (an arm at the first quantum); per 10 ms hop
//                    of the 16 kHz stream, rawDb = frameDb of the unfiltered hop, bandDb = frameDb of the hop
//                    after createGateFilter(16000) (run frame by frame, state carried), and voicing =
//                    createVoicing's score of the most recent 512 gate-filtered samples (zeros before the
//                    first), as src/workers/vad-core.ts keeps them; per frame, sileroP = the shipped Silero
//                    model (weights.bin, fresh state) on the raw frame.
//
// Usage: pnpm gen:vad-fingerprint. It recomputes the streams and writes the golden when there is none yet or
// FRONT_END_CONFIG.revision is above the golden's. Under the golden's revision it rewrites the golden
// unchanged (byte for byte) when the streams still match it, and otherwise refuses (exit 1) without writing.
//
// Node script (type stripping): relative imports end in `.ts` and the syntax is erasable (CLAUDE.md rule 11).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { VAD_FRAME, VAD_RATE } from '../src/audio/constants.ts';
import { butterworthHighpass } from '../src/dsp/biquad.ts';
import { createGateFilter, frameDb } from '../src/dsp/energy-gate.ts';
import { createResampler } from '../src/dsp/resample.ts';
import { createSilero } from '../src/dsp/silero/model.ts';
import { decodeWeights, type SileroWeights } from '../src/dsp/silero/weights.ts';
import { createVoicing } from '../src/dsp/voicing.ts';
import { FRONT_END_CONFIG, type FrontEndConfig } from '../src/vad-trace/config.ts';
import { mulberry32 } from '../test/dsp-helpers.ts';

/** The capture rates the fingerprint covers (the usual AudioContext rates). */
export const FINGERPRINT_RATES = [48000, 44100] as const;
export type FingerprintRate = (typeof FINGERPRINT_RATES)[number];
/** The logged streams, in trace.bin order. */
export const STREAM_NAMES = ['rawDb', 'bandDb', 'voicing', 'sileroP'] as const;
export type StreamName = (typeof STREAM_NAMES)[number];
export type FingerprintStreams = Record<StreamName, number[]>;

/** The golden file's contents. The keys of `rates` are the rates as decimal strings. */
export interface Fingerprint {
  revision: number;
  rates: Record<`${FingerprintRate}`, FingerprintStreams>;
}

/** Relative tolerance of a stream value against the golden. */
export const RTOL = 1e-6;
/** Absolute tolerance, which takes over near zero (|golden| < ATOL / RTOL = 1e-3). */
export const ATOL = 1e-9;
/** Significant digits of the golden's numbers (enough to round-trip any binary32 value exactly). */
export const SIGNIFICANT_DIGITS = 9;

/** The test's and the generator's failure message. */
export const FINGERPRINT_MESSAGE =
  "The VAD front end's output changed. If intended, bump FRONT_END_CONFIG.revision (this marks committed traces stale) and run pnpm gen:vad-fingerprint.";

export const GOLDEN_PATH = fileURLToPath(
  new URL('../src/vad-trace/fingerprint.golden.json', import.meta.url),
);
const WEIGHTS_PATH = fileURLToPath(new URL('../src/dsp/silero/weights.bin', import.meta.url));

// --- The synthetic signal --------------------------------------------------------------------------------

export const SIGNAL_SECONDS = 1.5;
export const SIGNAL_SEED = 171;
/**
 * Digital silence (exact zeros) from the start, like a microphone that is still opening (s): the first hops
 * log frameDb's floor, its epsilon alone.
 */
export const SILENCE_END_S = 0.05;
/**
 * The anti-alias probe: a PROBE_HZ tone, alone in the signal from SILENCE_END_S to PROBE_END_S (raised-cosine
 * edges of PROBE_EDGE_S). PROBE_HZ is above the 16 kHz stream's Nyquist, so all that reaches the stream is
 * the decimator's stopband leakage, which depends on every detail of its kernel (the phase table, the Kaiser
 * window's Bessel series): changes that move in-band audio by less than a float32 ulp.
 */
export const PROBE_HZ = 9000;
export const PROBE_AMPLITUDE = 0.5;
export const PROBE_END_S = 0.1;
const PROBE_EDGE_S = 0.005;
/** Fundamental of the vowel-like tone (Hz). */
export const F0_HZ = 140;
/** Harmonics up to this frequency (Hz). */
const MAX_HARMONIC_HZ = 4000;
/** /a/-like formants: centre (Hz), bandwidth (Hz), peak gain. */
const FORMANTS: ReadonlyArray<readonly [number, number, number]> = [
  [700, 130, 1],
  [1220, 70, 0.5],
  [2600, 160, 0.25],
];
/** RMS of the tone at full envelope (−20 dBFS). */
export const TONE_RMS = 0.1;
/** Tone RMS at full envelope over the noise RMS (dB). */
export const SNR_DB = 20;
/** The tone's envelope (s): 0 until ATTACK_START_S, a raised-cosine rise to 1 at ATTACK_END_S, 1 until
 *  RELEASE_START_S, a raised-cosine fall to 0 at RELEASE_END_S, then 0. */
export const ATTACK_START_S = 0.3;
export const ATTACK_END_S = 0.4;
export const RELEASE_START_S = 1.1;
export const RELEASE_END_S = 1.3;

/** 0 → 1 raised cosine over u in [0, 1]. */
function rise(u: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * u);
}

/** The tone's amplitude envelope at time t (s), in [0, 1]. */
function envelope(t: number): number {
  if (t < ATTACK_START_S || t >= RELEASE_END_S) return 0;
  if (t < ATTACK_END_S) return rise((t - ATTACK_START_S) / (ATTACK_END_S - ATTACK_START_S));
  if (t < RELEASE_START_S) return 1;
  return rise((RELEASE_END_S - t) / (RELEASE_END_S - RELEASE_START_S));
}

/** The probe's gate at time t (s), in [0, 1]. */
function probeGate(t: number): number {
  if (t < SILENCE_END_S || t >= PROBE_END_S) return 0;
  return rise(Math.min(1, (t - SILENCE_END_S) / PROBE_EDGE_S, (PROBE_END_S - t) / PROBE_EDGE_S));
}

/**
 * The fingerprint's input at `rate` Hz: SIGNAL_SECONDS long (Math.round(1.5 · rate) samples), the same on
 * every call for a given rate. Exact zeros until SILENCE_END_S; the anti-alias probe alone until PROBE_END_S;
 * from there to the end, seeded white Gaussian noise of RMS TONE_RMS / 10 (SNR_DB below the tone) plus a
 * vowel-like tone: the harmonics of F0_HZ up to 4 kHz with /a/-like formant amplitudes and seeded phases,
 * scaled to TONE_RMS and shaped by the envelope. No audio fixtures.
 */
export function fingerprintSignal(rate: number): Float32Array {
  const n = Math.round(SIGNAL_SECONDS * rate);
  const rand = mulberry32(SIGNAL_SEED);
  const harmonics = Math.floor(MAX_HARMONIC_HZ / F0_HZ);
  const amp = new Float64Array(harmonics + 1);
  const phase = new Float64Array(harmonics + 1);
  let power = 0;
  for (let k = 1; k <= harmonics; k++) {
    let a = 0;
    for (const [hz, bw, gain] of FORMANTS) {
      const d = (k * F0_HZ - hz) / bw;
      a += gain / (1 + d * d);
    }
    amp[k] = a;
    phase[k] = 2 * Math.PI * rand();
    power += (a * a) / 2;
  }
  const scale = TONE_RMS / Math.sqrt(power);
  const noiseRms = TONE_RMS * 10 ** (-SNR_DB / 20);
  const x = new Float32Array(n);
  const noiseStart = Math.round(PROBE_END_S * rate);
  for (let i = Math.round(SILENCE_END_S * rate); i < noiseStart; i++) {
    const t = i / rate;
    x[i] = PROBE_AMPLITUDE * probeGate(t) * Math.sin(2 * Math.PI * PROBE_HZ * t);
  }
  for (let i = noiseStart; i < n; i++) {
    const t = i / rate;
    const e = envelope(t);
    let tone = 0;
    if (e > 0) {
      for (let k = 1; k <= harmonics; k++)
        tone += amp[k]! * Math.sin(2 * Math.PI * k * F0_HZ * t + phase[k]!);
    }
    // Box–Muller: 1 − rand() is in (0, 1], so the logarithm is finite.
    const gauss = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    x[i] = scale * e * tone + noiseRms * gauss;
  }
  return x;
}

// --- The production front end ----------------------------------------------------------------------------

/** The capture worklet's render quantum. */
const QUANTUM = 128;

/** The shipped Silero weights, decoded as the app decodes them (as scripts/silero-parity.ts loads them). */
function shippedWeights(): SileroWeights {
  const bytes = readFileSync(WEIGHTS_PATH);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return decodeWeights(buf);
}

/** The capture worklet's chain on x at `rate`: per quantum, the clip high-pass, then the 16 kHz decimator. */
function capture16k(x: Float32Array, rate: number, cfg: FrontEndConfig): Float32Array {
  const hpf = butterworthHighpass(rate, cfg.hpfClipHz);
  // No options, as in the worklet: cfg.decimator states the cutoff at the 48 kHz reference rate (at 44.1 kHz
  // the default is CUTOFF_FACTOR · 16000 / 44100), and format.test.ts pins the defaults to it.
  const dec = createResampler(rate, VAD_RATE);
  const hp = new Float32Array(QUANTUM);
  const decOut = new Float32Array(Math.ceil(QUANTUM * dec.ratio) + 2);
  const out = new Float32Array(Math.ceil(x.length * dec.ratio) + 2);
  let n = 0;
  for (let off = 0; off < x.length; off += QUANTUM) {
    const len = Math.min(QUANTUM, x.length - off);
    const h = hp.subarray(0, len);
    hpf.process(x.subarray(off, off + len), h);
    const m = dec.processInto(h, decOut);
    out.set(decOut.subarray(0, m), n);
    n += m;
  }
  return out.subarray(0, n);
}

/** x rounded to SIGNIFICANT_DIGITS; throws on a non-finite value (the golden holds JSON numbers). */
function rounded(x: Float32Array): number[] {
  return Array.from(x, (v) => {
    if (!Number.isFinite(v)) throw new RangeError(`non-finite stream value ${v}`);
    return Number(v.toPrecision(SIGNIFICANT_DIGITS));
  });
}

/** The DSP worker's side: the four trace streams over the whole 512-sample frames of the 16 kHz stream. */
function workerStreams(pcm16k: Float32Array, w: SileroWeights, cfg: FrontEndConfig): FingerprintStreams {
  const frames = Math.floor(pcm16k.length / VAD_FRAME);
  const raw = pcm16k.subarray(0, frames * VAD_FRAME);
  const hop = Math.round((cfg.hopMs * VAD_RATE) / 1000);
  const hops = Math.floor(raw.length / hop);
  const gate = createGateFilter(VAD_RATE);
  const model = createSilero(w);
  const band = new Float32Array(raw.length);
  const sileroP = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const frame = raw.subarray(f * VAD_FRAME, (f + 1) * VAD_FRAME);
    gate.process(frame, band.subarray(f * VAD_FRAME, (f + 1) * VAD_FRAME));
    sileroP[f] = model.process(frame);
  }
  const voicing = createVoicing(VAD_RATE, cfg.voicing.fminHz, cfg.voicing.fmaxHz);
  const win = new Float32Array(cfg.voicing.window);
  const rawDb = new Float32Array(hops);
  const bandDb = new Float32Array(hops);
  const score = new Float32Array(hops);
  for (let i = 0; i < hops; i++) {
    const from = i * hop;
    const to = from + hop;
    rawDb[i] = frameDb(raw, from, to);
    bandDb[i] = frameDb(band, from, to);
    win.copyWithin(0, hop);
    win.set(band.subarray(from, to), win.length - hop);
    score[i] = voicing.score(win);
  }
  return {
    rawDb: rounded(rawDb),
    bandDb: rounded(bandDb),
    voicing: rounded(score),
    sileroP: rounded(sileroP),
  };
}

/** The fingerprint of the current build under cfg.revision: the four streams at each rate, rounded. */
export function computeFingerprint(cfg: FrontEndConfig = FRONT_END_CONFIG): Fingerprint {
  const w = shippedWeights();
  const at = (rate: FingerprintRate): FingerprintStreams =>
    workerStreams(capture16k(fingerprintSignal(rate), rate, cfg), w, cfg);
  return { revision: cfg.revision, rates: { '48000': at(48000), '44100': at(44100) } };
}

// --- Comparison ------------------------------------------------------------------------------------------

/** |actual − golden| / max(|golden|, ATOL / RTOL): within the tolerance iff it is at most RTOL. */
export function relativeError(actual: number, golden: number): number {
  return Math.abs(actual - golden) / Math.max(Math.abs(golden), ATOL / RTOL);
}

/**
 * Where actual departs from golden: one line per stream whose length differs or that has values outside the
 * tolerance (how many, the first one, and the largest relative error). Empty when they match.
 */
export function compareFingerprints(golden: Fingerprint, actual: Fingerprint): string[] {
  const problems: string[] = [];
  for (const rate of FINGERPRINT_RATES) {
    for (const name of STREAM_NAMES) {
      const g = golden.rates[rate][name];
      const a = actual.rates[rate][name];
      if (g.length !== a.length) {
        problems.push(`${rate} Hz ${name}: ${a.length} values, the golden has ${g.length}`);
        continue;
      }
      let bad = 0;
      let first = -1;
      let max = 0;
      for (let i = 0; i < g.length; i++) {
        const e = relativeError(a[i]!, g[i]!);
        if (e > max) max = e;
        if (e > RTOL) {
          bad++;
          if (first < 0) first = i;
        }
      }
      if (bad > 0) {
        problems.push(
          `${rate} Hz ${name}: ${bad} of ${g.length} values out of tolerance (first [${first}]: golden ${g[first]}, now ${a[first]}); max relative error ${max.toExponential(2)}`,
        );
      }
    }
  }
  return problems;
}

// --- The golden file -------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Parses and checks a golden file's text; throws (SyntaxError, TypeError) naming what is wrong. */
export function parseGolden(text: string): Fingerprint {
  const v: unknown = JSON.parse(text);
  if (!isRecord(v)) throw new TypeError('fingerprint golden: not an object');
  const revision = v.revision;
  if (!(typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 1)) {
    throw new TypeError('fingerprint golden: revision must be an integer >= 1');
  }
  const rates = v.rates;
  if (!isRecord(rates)) throw new TypeError('fingerprint golden: rates must be an object');
  const streams = (rate: FingerprintRate): FingerprintStreams => {
    const r = rates[rate];
    if (!isRecord(r)) throw new TypeError(`fingerprint golden: rates.${rate} must be an object`);
    const stream = (name: StreamName): number[] => {
      const s: unknown = r[name];
      if (!(Array.isArray(s) && s.every(isFiniteNumber))) {
        throw new TypeError(`fingerprint golden: rates.${rate}.${name} must be an array of finite numbers`);
      }
      return s;
    };
    return {
      rawDb: stream('rawDb'),
      bandDb: stream('bandDb'),
      voicing: stream('voicing'),
      sileroP: stream('sileroP'),
    };
  };
  return { revision, rates: { '48000': streams(48000), '44100': streams(44100) } };
}

/** The golden file's text for f: fixed key order, formatted by Prettier with the repository's config. */
export async function formatGolden(f: Fingerprint): Promise<string> {
  const rates: Record<string, FingerprintStreams> = {};
  for (const rate of FINGERPRINT_RATES) {
    const s = f.rates[rate];
    rates[rate] = { rawDb: s.rawDb, bandDb: s.bandDb, voicing: s.voicing, sileroP: s.sileroP };
  }
  const config = (await resolveConfig(GOLDEN_PATH)) ?? {};
  return format(JSON.stringify({ revision: f.revision, rates }), { ...config, filepath: GOLDEN_PATH });
}

export type Decision = { write: true; golden: Fingerprint; why: string } | { write: false; why: string };

/**
 * What the generator does with the computed fingerprint, given the existing golden (null: there is none):
 * - computed.revision not an integer >= 1: refuse;
 * - no golden, or computed.revision above the golden's: write the computed fingerprint;
 * - computed.revision below the golden's: refuse (revisions only go up: committed traces may carry the hash
 *   of any earlier revision);
 * - the golden's revision: refuse with FINGERPRINT_MESSAGE when any stream is out of tolerance, else write
 *   the golden back as it is (byte-identical; the golden never moves without a revision bump).
 */
export function decide(existing: Fingerprint | null, computed: Fingerprint): Decision {
  if (!(Number.isSafeInteger(computed.revision) && computed.revision >= 1)) {
    return {
      write: false,
      why: `FRONT_END_CONFIG.revision must be an integer >= 1 (got ${computed.revision}).`,
    };
  }
  if (existing === null) return { write: true, golden: computed, why: 'no golden yet' };
  if (computed.revision < existing.revision) {
    return {
      write: false,
      why: `FRONT_END_CONFIG.revision ${computed.revision} is below the golden's ${existing.revision}: revisions only go up.`,
    };
  }
  if (computed.revision > existing.revision) {
    return { write: true, golden: computed, why: `revision ${existing.revision} -> ${computed.revision}` };
  }
  const problems = compareFingerprints(existing, computed);
  if (problems.length > 0) {
    return { write: false, why: [FINGERPRINT_MESSAGE, ...problems.map((p) => `  ${p}`)].join('\n') };
  }
  return { write: true, golden: existing, why: `unchanged at revision ${existing.revision}` };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissingFile(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

async function main(): Promise<number> {
  let existing: Fingerprint | null = null;
  try {
    existing = parseGolden(readFileSync(GOLDEN_PATH, 'utf8'));
  } catch (err) {
    if (!isMissingFile(err)) {
      console.error(`cannot read ${GOLDEN_PATH}: ${errorMessage(err)}`);
      return 1;
    }
  }
  const d = decide(existing, computeFingerprint());
  if (!d.write) {
    console.error(d.why);
    return 1;
  }
  writeFileSync(GOLDEN_PATH, await formatGolden(d.golden));
  console.log(`${d.why}: wrote ${GOLDEN_PATH}`);
  return 0;
}

if (import.meta.main) process.exitCode = await main();
