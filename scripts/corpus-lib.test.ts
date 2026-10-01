import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { butterworthHighpass, cascade } from '../src/dsp/biquad.ts';
import { mulberry32, sine, toneLevelDb } from '../test/dsp-helpers.ts';
import {
  AM_DEPTH,
  AM_HZ_MAX,
  AM_HZ_MIN,
  BASE_SEED,
  BEAT_SAMPLES,
  BROWN_HPF_HZ,
  BURST_SAMPLES,
  BURST_TAU_SAMPLES,
  CHORDS_MIDI,
  CLATTER_LEVEL_MIN_DB,
  CLATTER_MAX_SAMPLES,
  CLATTER_MIN_SAMPLES,
  CLATTER_RATE_HZ,
  DRR_DB,
  FAN_BROWN_WEIGHT,
  FAN_PINK_WEIGHT,
  FAST_UTTERANCES,
  GAP_MAX,
  GAP_MIN,
  LEAD_SAMPLES,
  NOISES,
  NOISE_ONLY_SAMPLES,
  PHONE_HPF_HZ,
  RT60S,
  SAMPLE_RATE,
  SCENE_MAX_SAMPLES,
  SNRS_DB,
  TV_GAP_MAX,
  TV_LEVEL_MIN_DB,
  TV_LPF_HZ,
  TV_STREAMS,
  type CorpusEntry,
  type ScenePlan,
  activeRms,
  amfanNoise,
  babblePool,
  brownNoise,
  clatterNoise,
  convolve,
  createFft,
  deviceChain,
  f32leBytes,
  fanNoise,
  makeRir,
  metaBytes,
  midiHz,
  mixAtSnr,
  musicNoise,
  pinkNoise,
  planBabble,
  planCorpus,
  renderScene,
  rms,
  rotationStart,
  sceneRng,
  tvNoise,
} from './corpus-lib.ts';
import {
  HASHES_PATH,
  compareHashes,
  loadCorpus,
  mergeHashes,
  parseArgs,
  parseHashes,
  renderSubset,
  sha256,
} from './gen-corpus.ts';

// The issue's literal numbers (#52), so a changed constant fails here instead of moving every expectation with it.
const ISSUE_RT60S = [0.2, 0.4, 0.6];
const ISSUE_DRR_DB = 6;
const ISSUE_SNRS_DB = [20, 10, 5, 0];

const dB = (ratio: number): number => 20 * Math.log10(ratio);

/** Direct linear convolution in float64 (the reference for the overlap-add). */
function directConvolve(x: ArrayLike<number>, h: ArrayLike<number>): Float64Array {
  const y = new Float64Array(x.length + h.length - 1);
  for (let i = 0; i < x.length; i++) {
    for (let k = 0; k < h.length; k++) y[i + k] = y[i + k]! + x[i]! * h[k]!;
  }
  return y;
}

/**
 * RT60 by Schroeder backward integration: the energy decay curve EDC(n) = Σ_{k≥n} h[k]², in dB relative to the
 * total energy; a least-squares line through the EDC between −5 and −25 dB (T20), extrapolated to −60 dB.
 */
function schroederRt60(h: ArrayLike<number>, fs: number): number {
  const edc = new Float64Array(h.length);
  let acc = 0;
  for (let i = h.length - 1; i >= 0; i--) {
    acc += h[i]! * h[i]!;
    edc[i] = acc;
  }
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < h.length; i++) {
    const level = 10 * Math.log10(edc[i]! / acc);
    if (level > -5 || level < -25) continue;
    const t = i / fs;
    n++;
    sx += t;
    sy += level;
    sxx += t * t;
    sxy += t * level;
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return -60 / slope;
}

function randomSignal(seed: number, n: number): Float32Array {
  const rng = mulberry32(seed);
  return Float32Array.from({ length: n }, () => 2 * rng() - 1);
}

/** Mean energy per sample of x[from, to). */
function meanEnergy(x: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i]! * x[i]!;
  return sum / (to - from);
}

/** The steady-state gain in dB of `process` for a sine at `freq` (1 s at amplitude 0.5, measured on the last 0.5 s). */
function sineGainDb(process: (x: Float32Array) => Float32Array, freq: number): number {
  const x = sine(freq, SAMPLE_RATE, 1, 0.5);
  const y = process(x);
  const from = SAMPLE_RATE / 2;
  return toneLevelDb(y, freq, SAMPLE_RATE, from) - toneLevelDb(x, freq, SAMPLE_RATE, from);
}

/** The device chain with a one-tap (identity) RIR: just the phone-band high-pass. */
function phoneChain(x: Float32Array): Float32Array {
  return deviceChain(x, [1]);
}

/** A word entry for babble-pool tests. */
function fakeEntry(id: string, text: string): CorpusEntry {
  return { id, kind: 'word', text, samples: 10, spans: [] };
}

describe('constants are the issue’s numbers', () => {
  test('device approximation, layout and seed', () => {
    expect(SAMPLE_RATE).toBe(16_000);
    expect(BASE_SEED).toBe(0xc0a5);
    expect([...NOISES]).toEqual(['fan', 'amfan', 'tv', 'music', 'clatter']);
    expect([...SNRS_DB]).toEqual([20, 10, 5, 0]);
    expect([...RT60S]).toEqual([0.2, 0.4, 0.6]);
    expect(DRR_DB).toBe(6);
    expect(PHONE_HPF_HZ).toBe(150);
    expect(LEAD_SAMPLES).toBe(16_000);
    expect([GAP_MIN, GAP_MAX]).toEqual([32_000, 48_000]);
    expect(SCENE_MAX_SAMPLES).toBe(90 * 16_000);
    expect(FAST_UTTERANCES).toBe(20);
    expect(NOISE_ONLY_SAMPLES).toEqual({ full: 15 * 60 * 16_000, fast: 2 * 60 * 16_000 });
  });

  test('noise recipes', () => {
    expect([FAN_PINK_WEIGHT, FAN_BROWN_WEIGHT]).toEqual([0.7, 0.3]);
    expect(BROWN_HPF_HZ).toBe(20);
    expect([AM_HZ_MIN, AM_HZ_MAX, AM_DEPTH]).toEqual([0.5, 3, 0.6]);
    expect([TV_STREAMS, TV_LPF_HZ, TV_GAP_MAX, TV_LEVEL_MIN_DB]).toEqual([3, 3000, 8000, -6]);
    expect([BEAT_SAMPLES, BURST_SAMPLES, BURST_TAU_SAMPLES]).toEqual([8000, 480, 120]);
    expect(CLATTER_RATE_HZ).toBe(0.5);
    expect([CLATTER_MIN_SAMPLES, CLATTER_MAX_SAMPLES, CLATTER_LEVEL_MIN_DB]).toEqual([160, 960, -20]);
  });
});

describe('FFT and overlap-add convolution', () => {
  test('the FFT matches a direct DFT and inverts', () => {
    const n = 32;
    const x = randomSignal(1, n);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    createFft(n).forward(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        sr += x[t]! * Math.cos((2 * Math.PI * k * t) / n);
        si -= x[t]! * Math.sin((2 * Math.PI * k * t) / n);
      }
      expect(re[k]).toBeCloseTo(sr, 10);
      expect(im[k]).toBeCloseTo(si, 10);
    }
    createFft(n).inverse(re, im);
    for (let t = 0; t < n; t++) expect(re[t]).toBeCloseTo(x[t]!, 12);
  });

  test.each([
    { name: 'several blocks', xLength: 5000, hLength: 300 },
    { name: 'a signal shorter than the RIR', xLength: 700, hLength: 2000 },
    { name: 'a one-tap RIR', xLength: 1000, hLength: 1 },
  ])('matches direct convolution within 1e-5 ($name)', ({ xLength, hLength }) => {
    const x = randomSignal(2, xLength);
    const rng = mulberry32(3);
    const h = Float32Array.from({ length: hLength }, (_, i) => (2 * rng() - 1) * Math.exp(-i / 100));
    const ref = directConvolve(x, h);
    const full = convolve(x, h, ref.length);
    const truncated = convolve(x, h);
    expect(truncated.length).toBe(x.length);
    let maxErr = 0;
    for (let i = 0; i < ref.length; i++) maxErr = Math.max(maxErr, Math.abs(full[i]! - ref[i]!));
    for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(truncated[i]! - ref[i]!));
    expect(maxErr).toBeLessThanOrEqual(1e-5);
  });

  test('rejects an out-of-range output length', () => {
    expect(() => convolve(new Float32Array(10), [1, 2], 12)).toThrow(RangeError);
  });
});

describe('synthetic RIR and device chain', () => {
  test.each(ISSUE_RT60S.flatMap((rt60) => [11, 22, 33].map((seed) => ({ rt60, seed }))))(
    'RT60 $rt60 s (seed $seed): Schroeder RT60 within ±10 %, DRR 6 dB, unit direct path',
    ({ rt60, seed }) => {
      const h = makeRir(mulberry32(seed), rt60);
      expect(h.length).toBe(Math.round(rt60 * 16_000));
      expect(h[0]).toBe(1);
      let reverb = 0;
      for (let i = 1; i < h.length; i++) reverb += h[i]! * h[i]!;
      expect(10 * Math.log10(1 / reverb)).toBeCloseTo(ISSUE_DRR_DB, 9);
      const estimate = schroederRt60(h, 16_000);
      expect(Math.abs(estimate / rt60 - 1)).toBeLessThanOrEqual(0.1);
    },
  );

  test('the device chain high-passes at 150 Hz (2nd-order Butterworth)', () => {
    expect(sineGainDb(phoneChain, 75)).toBeLessThanOrEqual(-11);
    expect(Math.abs(sineGainDb(phoneChain, 150) + 3)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(sineGainDb(phoneChain, 1000))).toBeLessThanOrEqual(0.1);
  });
});

describe('noise generators', () => {
  const n = 10 * SAMPLE_RATE;

  test('every generator returns finite unit-RMS noise', () => {
    const signals = [
      fanNoise(mulberry32(1), n),
      amfanNoise(mulberry32(2), n).noise,
      musicNoise(mulberry32(3), n),
      clatterNoise(mulberry32(4), n),
    ];
    for (const x of signals) {
      expect(x.every(Number.isFinite)).toBe(true);
      expect(rms(x)).toBeCloseTo(1, 5);
    }
  });

  test('pink noise falls 3 dB per octave (Paul Kellet)', () => {
    const x = pinkNoise(mulberry32(5), 64 * 4096);
    const size = 4096;
    const fft = createFft(size);
    const power = new Float64Array(size / 2);
    for (let b = 0; b < x.length; b += size) {
      const re = new Float64Array(size);
      const im = new Float64Array(size);
      for (let i = 0; i < size; i++) re[i] = x[b + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
      fft.forward(re, im);
      for (let k = 0; k < size / 2; k++) power[k] = power[k]! + re[k]! ** 2 + im[k]! ** 2;
    }
    /** Mean power density in [lo, hi) Hz. */
    const band = (lo: number, hi: number): number => {
      const k0 = Math.round((lo * size) / SAMPLE_RATE);
      const k1 = Math.round((hi * size) / SAMPLE_RATE);
      let sum = 0;
      for (let k = k0; k < k1; k++) sum += power[k]!;
      return sum / (k1 - k0);
    };
    // 3 octaves from 250–500 Hz to 2–4 kHz: −9 dB of power density.
    expect(Math.abs(10 * Math.log10(band(2000, 4000) / band(250, 500)) + 9)).toBeLessThanOrEqual(0.5);
  });

  test('brown noise is DC-blocked', () => {
    const x = brownNoise(mulberry32(6), 60 * SAMPLE_RATE);
    let mean = 0;
    for (const v of x) mean += v;
    expect(Math.abs(mean / x.length) / rms(x)).toBeLessThan(0.01);
  });

  test.each([1, 2, 3])('amfan (seed %i): envelope at the drawn rate in [0.5, 3] Hz, depth 0.6', (seed) => {
    const { noise, amHz } = amfanNoise(mulberry32(seed), 60 * SAMPLE_RATE);
    expect(amHz).toBeGreaterThanOrEqual(0.5);
    expect(amHz).toBeLessThanOrEqual(3);
    // 10 ms RMS envelope at 100 frames/s.
    const frames = noise.length / 160;
    const env = new Float64Array(frames);
    let mean = 0;
    for (let k = 0; k < frames; k++) {
      env[k] = Math.sqrt(meanEnergy(noise, k * 160, (k + 1) * 160));
      mean += env[k]! / frames;
    }
    /** Amplitude of the envelope's component at f Hz. */
    const amplitude = (f: number): number => {
      let re = 0;
      let im = 0;
      for (let k = 0; k < frames; k++) {
        const v = env[k]! - mean;
        re += v * Math.cos((2 * Math.PI * f * k) / 100);
        im -= v * Math.sin((2 * Math.PI * f * k) / 100);
      }
      return (2 * Math.hypot(re, im)) / frames;
    };
    let best = 0.3;
    for (let f = 0.3; f <= 4; f += 0.01) if (amplitude(f) > amplitude(best)) best = f;
    let peak = best;
    for (let f = best - 0.01; f <= best + 0.01; f += 0.001) if (amplitude(f) > amplitude(peak)) peak = f;
    expect(Math.abs(peak - amHz)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(amplitude(peak) / mean - 0.6)).toBeLessThanOrEqual(0.05);
  });

  test('clatter: about 0.5 bursts per second over 10 min', () => {
    const x = clatterNoise(mulberry32(8), 600 * SAMPLE_RATE);
    let bursts = 0;
    let zeros = Infinity;
    for (const v of x) {
      if (v === 0) {
        zeros++;
        continue;
      }
      if (zeros >= 16) bursts++;
      zeros = 0;
    }
    expect(Math.abs(bursts / 600 - 0.5)).toBeLessThanOrEqual(0.1);
  });

  test('music: percussion onsets every 8000 samples (120 bpm), and the I–V–vi–IV chords in C', () => {
    const x = musicNoise(mulberry32(9), 10 * SAMPLE_RATE);
    const high = cascade(
      butterworthHighpass(SAMPLE_RATE, 4000),
      butterworthHighpass(SAMPLE_RATE, 4000),
    ).process(x);
    for (let beat = 0; beat < 20; beat++) {
      const start = beat * 8000;
      const on = meanEnergy(high, start, start + 480);
      const off = meanEnergy(high, start + 1000, start + 7000);
      expect(10 * Math.log10(on / off)).toBeGreaterThanOrEqual(20);
    }
    const progression = [
      [60, 64, 67],
      [55, 59, 62],
      [57, 60, 64],
      [53, 57, 60],
    ];
    expect(CHORDS_MIDI).toEqual(progression);
    const candidates = [...new Set(progression.flat())];
    for (let second = 0; second < 8; second++) {
      const chord = progression[second % 4]!;
      const from = second * SAMPLE_RATE + 800;
      const to = (second + 1) * SAMPLE_RATE - 800;
      const loudest = candidates
        .map((note) => ({ note, level: toneLevelDb(x, midiHz(note), SAMPLE_RATE, from, to) }))
        .toSorted((a, b) => b.level - a.level)
        .slice(0, 3)
        .map((c) => c.note);
      expect(loudest.toSorted((a, b) => a - b)).toEqual(chord.toSorted((a, b) => a - b));
    }
  });

  test('tv: each stream is low-passed at 3 kHz (2nd-order Butterworth)', () => {
    const tones = Float32Array.from(
      { length: SAMPLE_RATE },
      (_, i) =>
        0.2 *
        (Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE) +
          Math.sin((2 * Math.PI * 3000 * i) / SAMPLE_RATE) +
          Math.sin((2 * Math.PI * 6000 * i) / SAMPLE_RATE)),
    );
    const y = tvNoise([{ levelDb: 0, items: [{ id: 'tones', offset: 0 }] }], () => tones, SAMPLE_RATE);
    const level = (f: number): number => toneLevelDb(y, f, SAMPLE_RATE, SAMPLE_RATE / 2);
    expect(Math.abs(level(3000) - level(1000) + 3)).toBeLessThanOrEqual(0.2);
    expect(level(6000) - level(1000)).toBeLessThanOrEqual(-20);
  });

  test('the babble pool drops the scene’s own utterances and the other render of their texts', () => {
    const entries = [
      fakeEntry('word-00-r0', 'hello'),
      fakeEntry('word-00-r1', 'hello'),
      fakeEntry('word-01-r0', 'bear'),
      fakeEntry('word-01-r1', 'bear'),
      fakeEntry('word-02-r0', 'apple'),
    ];
    expect(babblePool(entries, ['word-00-r1']).map((e) => e.id)).toEqual([
      'word-01-r0',
      'word-01-r1',
      'word-02-r0',
    ]);
    expect(babblePool(entries, []).length).toBe(5);
  });
});

describe('SNR mixing', () => {
  test.each(ISSUE_SNRS_DB)('measured SNR is within ±0.1 dB of %i dB', (snrDb) => {
    const speech = randomSignal(7, 20_000);
    for (let i = 0; i < speech.length; i++) if (i % 5000 >= 3000) speech[i] = 0;
    const noise = randomSignal(8, 20_000);
    const spans: [number, number][] = [
      [0, 3000],
      [5000, 8000],
      [10_000, 13_000],
      [15_000, 18_000],
    ];
    const { mix } = mixAtSnr(speech, noise, spans, snrDb);
    const residual = mix.map((v, i) => v - speech[i]!);
    expect(Math.abs(dB(activeRms(speech, spans) / activeRms(residual, spans)) - snrDb)).toBeLessThanOrEqual(
      0.1,
    );
  });
});

const corpus = loadCorpus();
const { entries, audio } = corpus;
const byId = new Map(entries.map((e) => [e.id, e]));
const textOf = (id: string): string => byId.get(id)!.text;

/** A short SNR scene for `noise` built from the real corpus: 3 utterances, no 90 s fill. */
function shortScene(noise: (typeof NOISES)[number], snrDb: number, seed: number): ScenePlan {
  const full = planCorpus('full', entries).find((p) => p.name === `${noise}-snr${snrDb}`)!;
  const placements = full.placements.slice(0, 3);
  const last = placements.at(-1)!;
  return { ...full, seed, placements, samples: last.offset + byId.get(last.id)!.samples + GAP_MIN };
}

describe('rendered scenes', () => {
  test.each([...NOISES])('%s: measured SNR within ±0.1 dB and labels inside the scene', (noise) => {
    for (const snrDb of ISSUE_SNRS_DB) {
      const plan = shortScene(noise, snrDb, BASE_SEED + 1000);
      const scene = renderScene(plan, entries, audio);
      const { spans } = scene.meta;
      const residual = scene.audio.map((v, i) => v - scene.speech[i]!);
      expect(
        Math.abs(dB(activeRms(scene.speech, spans) / activeRms(residual, spans)) - snrDb),
      ).toBeLessThanOrEqual(0.1);
      expect(scene.meta.samples).toBe(scene.audio.length);
      for (const [s, e] of spans) {
        expect(s).toBeGreaterThanOrEqual(16_000);
        expect(e).toBeGreaterThan(s);
        expect(e).toBeLessThanOrEqual(scene.audio.length);
      }
      expect(scene.meta.kinds.length).toBe(spans.length);
      expect(scene.meta.ids.length).toBe(spans.length);
    }
  });

  test.each([...NOISES])('%s: the same seed gives the same bytes, another seed different bytes', (noise) => {
    const plan = shortScene(noise, 10, BASE_SEED + 2000);
    const a = renderScene(plan, entries, audio);
    const b = renderScene(plan, entries, audio);
    expect(Buffer.from(f32leBytes(a.audio)).equals(Buffer.from(f32leBytes(b.audio)))).toBe(true);
    expect(Buffer.from(metaBytes(a.meta)).equals(Buffer.from(metaBytes(b.meta)))).toBe(true);
    const c = renderScene({ ...plan, seed: plan.seed + 1 }, entries, audio);
    expect(Buffer.from(f32leBytes(a.audio)).equals(Buffer.from(f32leBytes(c.audio)))).toBe(false);
  });

  test('a noise-only stream is scaled to the given absolute level', () => {
    const plan = {
      ...planCorpus('fast', entries).find((p) => p.type === 'noise-only')!,
      samples: 5 * SAMPLE_RATE,
    };
    const scene = renderScene(plan, entries, audio, 0.0123);
    expect(rms(scene.audio)).toBeCloseTo(0.0123, 6);
    expect(scene.meta.spans).toEqual([]);
    expect(scene.meta.snrDb).toBeNull();
    expect(() => renderScene(plan, entries, audio)).toThrow();
  });
});

describe('tv babble', () => {
  const tvPlans = planCorpus('full', entries).filter((p) => p.noise === 'tv');

  test.each(tvPlans.map((p) => [p.name, p] as const))(
    '%s: babble never contains the scene’s own ids or texts',
    (_, plan) => {
      const ownIds = plan.placements.map((p) => p.id);
      const ownTexts = new Set(ownIds.map(textOf));
      // The same draws as renderScene: the layout, the RIR tail, then the babble.
      const rng = sceneRng(plan);
      makeRir(rng, plan.rt60);
      const streams = planBabble(rng, babblePool(entries, ownIds), plan.samples);
      const ids = streams.flatMap((s) => s.items.map((item) => item.id));
      expect(streams.length).toBe(3);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.filter((id) => ownIds.includes(id))).toEqual([]);
      expect(ids.filter((id) => ownTexts.has(textOf(id)))).toEqual([]);
      for (const s of streams) {
        expect(s.levelDb).toBeGreaterThanOrEqual(-6);
        expect(s.levelDb).toBeLessThanOrEqual(0);
      }
    },
  );

  test('renderScene uses those babble draws (fast-tv-snr10)', () => {
    const plan = tvPlans.find((p) => p.name === 'fast-tv-snr10')!;
    const rng = sceneRng(plan);
    makeRir(rng, plan.rt60);
    const own = plan.placements.map((p) => p.id);
    const expected = planBabble(rng, babblePool(entries, own), plan.samples).flatMap((s) =>
      s.items.map((i) => i.id),
    );
    const scene = renderScene(plan, entries, audio);
    expect(scene.babbleIds).toEqual(expected);
    const ownTexts = new Set(own.map(textOf));
    expect(scene.babbleIds.filter((id) => ownTexts.has(textOf(id)))).toEqual([]);
  });
});

describe('scene plans', () => {
  const full = planCorpus('full', entries);
  const fast = planCorpus('fast', entries);
  const short = entries.filter((e) => e.kind !== 'passage');

  test('the full subset has every scene once, with seeds 0xC0A5 + offset', () => {
    expect(full.length).toBe(28);
    expect(new Set(full.map((p) => p.name)).size).toBe(28);
    expect(full.map((p) => p.offset)).toEqual([...Array(28).keys()]);
    for (const p of full) expect(p.seed).toBe(0xc0a5 + p.offset);
    expect(full.filter((p) => p.type === 'snr' && p.group === 'full').length).toBe(20);
    expect(fast).toEqual(full.filter((p) => p.group === 'fast'));
    expect(fast.map((p) => p.name)).toEqual([
      'fast-fan-snr10',
      'fast-fan-snr5',
      'fast-tv-snr10',
      'fast-tv-snr5',
      'fast-fan-noise',
    ]);
    expect(planCorpus('full', entries)).toEqual(full);
  });

  test('every layout is drawn from mulberry32(seed): RT60, then one 2–3 s gap per utterance', () => {
    for (const p of full) {
      const rng = mulberry32(p.seed);
      expect(p.rt60).toBe(ISSUE_RT60S[Math.floor(rng() * 3)]);
      const ends = p.placements.map((pl) => pl.offset + byId.get(pl.id)!.samples);
      const next = [...p.placements.slice(1).map((pl) => pl.offset), p.samples];
      if (p.type !== 'noise-only') {
        ends.forEach((end, i) => expect(next[i]! - end).toBe(32_000 + Math.floor(rng() * 16_001)));
      }
      expect(p.layoutDraws).toBe(p.placements.length + 1);
    }
  });

  test('SNR scenes: rotated word/sentence renders, 1 s lead, ≈ 90 s (full) or 20 utterances (fast)', () => {
    for (const p of full.filter((s) => s.type === 'snr')) {
      expect(p.start).toBe(rotationStart(p.noise, p.snrDb!, short.length));
      expect(p.placements[0]!.offset).toBe(16_000);
      p.placements.forEach((pl, i) => expect(pl.id).toBe(short[(p.start! + i) % short.length]!.id));
      if (p.group === 'full') {
        expect(p.samples).toBeLessThanOrEqual(90 * 16_000);
        expect(p.samples).toBeGreaterThan(84 * 16_000);
      } else {
        expect(p.placements.length).toBe(20);
        expect(p.start).toBe(full.find((s) => s.name === p.name.slice('fast-'.length))!.start);
      }
    }
  });

  test('rotation starts a noise’s SNR scenes a quarter apart and an SNR’s noise scenes a fifth apart', () => {
    expect(NOISES.map((noise) => SNRS_DB.map((snr) => rotationStart(noise, snr, 100)))).toEqual([
      [0, 25, 50, 75],
      [20, 45, 70, 95],
      [40, 65, 90, 15],
      [60, 85, 10, 35],
      [80, 5, 30, 55],
    ]);
  });

  test('passages and noise-only streams', () => {
    const passages = full.find((p) => p.type === 'passages')!;
    expect(passages.noise).toBe('fan');
    expect(passages.snrDb).toBe(20);
    expect(passages.placements.map((p) => p.id)).toEqual(
      entries.filter((e) => e.kind === 'passage').map((e) => e.id),
    );
    const streams = full.filter((p) => p.type === 'noise-only');
    expect(streams.map((p) => [p.name, p.noise, p.samples, p.levelFrom])).toEqual([
      ['fan-noise', 'fan', 900 * 16_000, 'fan-snr10'],
      ['music-noise', 'music', 900 * 16_000, 'music-snr10'],
      ['fast-fan-noise', 'fan', 120 * 16_000, 'fast-fan-snr10'],
    ]);
  });
});

/** A fake 64-digit hash. */
const h = (c: string): string => c.repeat(64);

describe('gen-corpus command line', () => {
  test('parseArgs', () => {
    expect(parseArgs(['--subset', 'fast'])).toEqual({ subset: 'fast', mode: 'generate' });
    expect(parseArgs(['--subset', 'full', '--check'])).toEqual({ subset: 'full', mode: 'check' });
    expect(parseArgs(['--write-hashes', '--subset', 'full'])).toEqual({
      subset: 'full',
      mode: 'write-hashes',
    });
    for (const bad of [
      [],
      ['--subset'],
      ['--subset', 'all'],
      ['--subset', 'fast', '--check', '--write-hashes'],
      ['--subset', 'fast', '--subset', 'full'],
      ['--check'],
      ['-x'],
    ]) {
      expect(() => parseArgs(bad)).toThrow(/usage/);
    }
  });

  test('compareHashes reports missing, different and (full only) stale entries', () => {
    const recorded = { 'a.f32': h('1'), 'b.f32': h('2'), 'stale.f32': h('3') };
    const generated = { 'a.f32': h('1'), 'b.f32': h('9'), 'new.f32': h('4') };
    expect(compareHashes('fast', generated, recorded)).toEqual([
      `b.f32: expected ${h('2')}, got ${h('9')}`,
      `new.f32: not in mix-hashes.json (got ${h('4')})`,
    ]);
    expect(compareHashes('full', generated, recorded)).toHaveLength(3);
    expect(compareHashes('full', { 'a.f32': h('1') }, { 'a.f32': h('1') })).toEqual([]);
  });

  test('mergeHashes replaces everything for full and only the generated entries for fast', () => {
    const recorded = { 'z.f32': h('1'), 'a.f32': h('2') };
    expect(mergeHashes('full', { 'b.f32': h('3') }, recorded)).toEqual({ 'b.f32': h('3') });
    const merged = mergeHashes('fast', { 'b.f32': h('3'), 'a.f32': h('4') }, recorded);
    expect(merged).toEqual({ 'a.f32': h('4'), 'b.f32': h('3'), 'z.f32': h('1') });
    expect(Object.keys(merged)).toEqual(['a.f32', 'b.f32', 'z.f32']);
  });

  test('parseHashes rejects malformed files', () => {
    expect(() => parseHashes([])).toThrow();
    expect(() => parseHashes({ 'a.f32': 'xyz' })).toThrow();
    expect(parseHashes({ 'a.f32': h('a') })).toEqual({ 'a.f32': h('a') });
  });
});

describe('test/corpus/mix-hashes.json', () => {
  const hashes = parseHashes(JSON.parse(readFileSync(HASHES_PATH, 'utf8')));

  test('covers exactly the outputs of the full subset', () => {
    expect(Object.keys(hashes).toSorted()).toEqual(
      planCorpus('full', entries)
        .flatMap((p) => [`${p.name}.f32`, `${p.name}.json`])
        .toSorted(),
    );
  });

  test('the fast subset renders to the recorded SHA-256 of every file', () => {
    const files = renderSubset('fast', corpus);
    expect(files.length).toBe(10);
    for (const { name, bytes } of files) expect(`${name} ${sha256(bytes)}`).toBe(`${name} ${hashes[name]}`);
  }, 60_000);
});
