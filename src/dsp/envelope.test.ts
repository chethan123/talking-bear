import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../test/dsp-helpers.ts';
import { analyzeEnvelope } from './envelope.ts';
import type { Envelope } from './types.ts';

const RATES = [44100, 48000] as const;

/** Hop in samples, as analyzeEnvelope computes it. */
function hopOf(fs: number): number {
  return Math.round(0.01 * fs);
}

/** A sine component: [amplitude, frequency in Hz]. */
type Tone = readonly [amp: number, hz: number];

/** Concatenated segments, each a sum of sines held for `sec` (no tones = silence); phase referenced to sample 0. */
function segments(fs: number, segs: readonly { sec: number; tones: readonly Tone[] }[]): Float32Array {
  const x = new Float32Array(segs.reduce((n, seg) => n + Math.round(seg.sec * fs), 0));
  let offset = 0;
  for (const seg of segs) {
    const end = offset + Math.round(seg.sec * fs);
    for (let i = offset; i < end; i++) {
      let v = 0;
      for (const [amp, hz] of seg.tones) v += amp * Math.sin((2 * Math.PI * hz * i) / fs);
      x[i] = v;
    }
    offset = end;
  }
  return x;
}

/** RMS level in dB of a sine of amplitude `amp`: the dB analyzeEnvelope measures on a steady tone. */
function sineDb(amp: number): number {
  return 20 * Math.log10(amp / Math.SQRT2);
}

/** Envelope (48 kHz, p = 1) of 0.5 s of quiet `tones` (n = 0 there), then 0.5 s of a loud 300 Hz tone. */
function quietTonesThenLoudTone(tones: readonly Tone[]): Envelope {
  const x = segments(48000, [
    { sec: 0.5, tones },
    { sec: 0.5, tones: [[0.5, 300]] },
  ]);
  return analyzeEnvelope(x, 48000, 1);
}

/** 0.8 s: a 300 ms 300 Hz burst at amplitude 0.5, then 500 ms of digital silence (validation 4). */
function burstThenSilence(fs: number): Float32Array {
  return segments(fs, [
    { sec: 0.3, tones: [[0.5, 300]] },
    { sec: 0.5, tones: [] },
  ]);
}

/**
 * Band-limited noise: 200 sinusoids with seeded frequencies uniform in [loHz, hiHz] and uniform phases,
 * scaled so the total RMS is `amp`. Exactly band-limited and deterministic (the codebase has no inverse FFT).
 */
function bandNoise(
  fs: number,
  seconds: number,
  loHz: number,
  hiHz: number,
  seed: number,
  amp = 0.3,
): Float32Array {
  const x = new Float32Array(Math.round(seconds * fs));
  addBandNoise(x, 0, x.length, fs, loHz, hiHz, seed, amp);
  return x;
}

/** Writes band-limited noise (see bandNoise) into x[from, to), with the phase referenced to sample 0. */
function addBandNoise(
  x: Float32Array,
  from: number,
  to: number,
  fs: number,
  loHz: number,
  hiHz: number,
  seed: number,
  amp: number,
): void {
  const count = 200;
  const rand = mulberry32(seed);
  const w = new Float64Array(count);
  const ph = new Float64Array(count);
  for (let c = 0; c < count; c++) {
    w[c] = (2 * Math.PI * (loHz + (hiHz - loHz) * rand())) / fs;
    ph[c] = 2 * Math.PI * rand();
  }
  const a = amp / Math.sqrt(count / 2);
  for (let i = from; i < to; i++) {
    let s = 0;
    for (let c = 0; c < count; c++) s += Math.sin(w[c]! * i + ph[c]!);
    x[i] = a * s;
  }
}

/** 2 s of a 500 Hz sine with 100 % 4 Hz amplitude modulation; the modulator is 0.5·(1 + sin) or 0.5·(1 + cos). */
function amTone(fs: number, modulator: 'sin' | 'cos'): Float32Array {
  const x = new Float32Array(2 * fs);
  for (let i = 0; i < x.length; i++) {
    const t = i / fs;
    const phase = 2 * Math.PI * 4 * t;
    const m = 0.5 * (1 + (modulator === 'sin' ? Math.sin(phase) : Math.cos(phase)));
    x[i] = 0.5 * m * Math.sin(2 * Math.PI * 500 * t);
  }
  return x;
}

/** 1 s: 0–0.4 s quiet high-band noise, 0.4–0.7 s loud high-band noise, 0.7–1.0 s a loud 300 Hz tone. */
function sibilanceClip(fs: number, loHz: number, hiHz: number): Float32Array {
  const x = new Float32Array(fs);
  addBandNoise(x, 0, Math.round(0.4 * fs), fs, loHz, hiHz, 7, 0.02);
  addBandNoise(x, Math.round(0.4 * fs), Math.round(0.7 * fs), fs, loHz, hiHz, 8, 0.5);
  for (let i = Math.round(0.7 * fs); i < fs; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / fs);
  return x;
}

function median(a: Float32Array): number {
  const s = a.toSorted();
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Indices i in 1…len−2 with a[i−1] < a[i] ≥ a[i+1]. */
function localMaxima(a: Float32Array): number[] {
  const peaks: number[] = [];
  for (let i = 1; i < a.length - 1; i++) if (a[i - 1]! < a[i]! && a[i]! >= a[i + 1]!) peaks.push(i);
  return peaks;
}

/** Minimum of jaw between each pair of consecutive peaks (inclusive). */
function troughs(jaw: Float32Array, peaks: number[]): number[] {
  const out: number[] = [];
  for (let p = 0; p + 1 < peaks.length; p++) {
    let m = Infinity;
    for (let i = peaks[p]!; i <= peaks[p + 1]!; i++) m = Math.min(m, jaw[i]!);
    out.push(m);
  }
  return out;
}

function tracks(env: Envelope): Float32Array[] {
  return [env.jaw, env.width, env.round, env.teeth];
}

describe('analyzeEnvelope', () => {
  describe('silence (validation 1)', () => {
    it.each(RATES)('1 s of zeros gives all four tracks exactly 0 at %i Hz', (fs) => {
      const env = analyzeEnvelope(new Float32Array(fs), fs, 1);
      expect(env.hopMs).toBe(10);
      for (const track of tracks(env)) {
        expect(track).toBeInstanceOf(Float32Array);
        expect(track.length).toBe(100);
        expect(track.findIndex((v) => v !== 0)).toBe(-1);
      }
    });

    it('an empty buffer gives four empty tracks', () => {
      const env = analyzeEnvelope(new Float32Array(0), 48000, 1.6);
      expect(env.hopMs).toBe(10);
      for (const track of tracks(env)) expect(track.length).toBe(0);
    });
  });

  describe('AM tone (validation 2)', () => {
    // The modulator phase is not fixed by the spec. With 0.5·(1 + sin), the 8 AM peaks fall at 62.5 + 250k ms,
    // away from the zero-padded edges, so the test checks tracking (measured: 8 peaks, 7.5 ms late, troughs
    // 0.350). With 0.5·(1 + cos) the first AM peak is at t = 0, where the one-pole is still rising from 0: the
    // first jaw peak is then exactly 30 ms late (8 peaks, troughs 0.349–0.366), which tests the edge rather
    // than the tracking. That phase is checked below for peak count and troughs only.
    it.each(RATES)('jaw has 8 ± 1 peaks within ±30 ms of the AM peaks and troughs < 0.5 at %i Hz', (fs) => {
      const { jaw } = analyzeEnvelope(amTone(fs, 'sin'), fs, 1);
      expect(jaw.length).toBe(200);
      const peaks = localMaxima(jaw);
      expect(peaks.length).toBeGreaterThanOrEqual(7);
      expect(peaks.length).toBeLessThanOrEqual(9);
      const amPeaks = Array.from({ length: 8 }, (_, k) => 0.0625 + 0.25 * k);
      const hop = hopOf(fs);
      for (const i of peaks) {
        const t = (i * hop) / fs;
        const err = Math.min(...amPeaks.map((a) => Math.abs(t - a)));
        expect(err).toBeLessThanOrEqual(0.03);
      }
      for (const m of troughs(jaw, peaks)) expect(m).toBeLessThan(0.5);
    });

    it.each(RATES)('cos-phase modulator: 8 ± 1 peaks and troughs < 0.5 at %i Hz', (fs) => {
      const { jaw } = analyzeEnvelope(amTone(fs, 'cos'), fs, 1);
      const peaks = localMaxima(jaw);
      expect(peaks.length).toBeGreaterThanOrEqual(7);
      expect(peaks.length).toBeLessThanOrEqual(9);
      for (const m of troughs(jaw, peaks)) expect(m).toBeLessThan(0.5);
    });

    it.each(RATES)('every track is in [0, 1] and round = jaw·(1 − width) at %i Hz', (fs) => {
      const env = analyzeEnvelope(amTone(fs, 'sin'), fs, 1);
      for (const track of tracks(env)) {
        for (const v of track) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
      for (let i = 0; i < env.jaw.length; i++) {
        expect(Math.abs(env.round[i]! - env.jaw[i]! * (1 - env.width[i]!))).toBeLessThanOrEqual(1e-6);
      }
    });
  });

  describe('width ordering (validation 3)', () => {
    it.each(RATES)('1.5–4.5 kHz noise gives median width > 0.8, 150–900 Hz < 0.2 at p = 1, %i Hz', (fs) => {
      expect(median(analyzeEnvelope(bandNoise(fs, 1, 1500, 4500, 1), fs, 1).width)).toBeGreaterThan(0.8);
      expect(median(analyzeEnvelope(bandNoise(fs, 1, 150, 900, 2), fs, 1).width)).toBeLessThan(0.2);
    });

    it('the bands scale with the pitch ratio (p = 2 at 48 kHz)', () => {
      const fs = 48000;
      expect(median(analyzeEnvelope(bandNoise(fs, 1, 3000, 9000, 3), fs, 2).width)).toBeGreaterThan(0.8);
      expect(median(analyzeEnvelope(bandNoise(fs, 1, 300, 1800, 4), fs, 2).width)).toBeLessThan(0.2);
    });

    // Two equal tones placed just inside or outside the band edges (E_lo [150p, 900p], E_hi [1500p, 4500p]):
    // [p, tone a Hz, tone b Hz, expected width]. 0.5 = one tone in each band, 1 = only E_hi, 0 = only E_lo.
    const bandEdgeCases: [number, number, number, number][] = [
      [1, 260, 4380, 0.5],
      [1, 790, 1620, 0.5],
      [1, 1020, 2500, 1],
      [1, 40, 2500, 1],
      [1, 500, 4620, 0],
      [1, 500, 1380, 0],
      [1.6, 1300, 2600, 0.5],
      [1.6, 500, 7000, 0.5],
      [1.6, 150, 3000, 1],
      [1.6, 1560, 3000, 1],
      [1.6, 500, 7400, 0],
      [1.6, 500, 2280, 0],
    ];
    it.each(bandEdgeCases)('band edges scale with p: p = %s, tones %s + %s Hz → width %s', (p, fa, fb, w) => {
      const x = segments(48000, [
        {
          sec: 0.3,
          tones: [
            [0.2, fa],
            [0.2, fb],
          ],
        },
      ]);
      const { width } = analyzeEnvelope(x, 48000, p);
      for (let i = 3; i < 27; i++) expect(Math.abs(width[i]! - w), `width[${i}]`).toBeLessThan(0.03);
    });

    it('uses a larger FFT when the window exceeds 2048 samples (96 kHz, W = 2400)', () => {
      const fs = 96000;
      const hi = analyzeEnvelope(bandNoise(fs, 1, 1500, 4500, 5), fs, 1);
      expect(hi.jaw.length).toBe(100);
      expect(median(hi.width)).toBeGreaterThan(0.8);
      expect(median(analyzeEnvelope(bandNoise(fs, 1, 150, 900, 6), fs, 1).width)).toBeLessThan(0.2);
    });

    it('the 96 kHz FFT covers the whole 2400-sample window (a tone only in its last quarter is seen)', () => {
      const fs = 96000;
      const x = new Float32Array(fs);
      // Frame 10 spans samples 9600 − 1200 … 9600 + 1199; the tone sits in 10 500 … 10 749, past sample 2048.
      for (let i = 10 * 960 + 900; i < 10 * 960 + 1150; i++)
        x[i] = 0.5 * Math.sin((2 * Math.PI * 3000 * i) / fs);
      expect(analyzeEnvelope(x, fs, 1).width[10]).toBeGreaterThan(0.8);
    });
  });

  describe('mouth close (validation 4)', () => {
    it.each(RATES)(
      'a 300 ms burst then 500 ms of silence: release tail, then jaw = 0 from 120 ms after n reaches 0 at %i Hz',
      (fs) => {
        const { jaw, round } = analyzeEnvelope(burstThenSilence(fs), fs, 1);
        expect(jaw.length).toBe(80);
        // n reaches 0 once the window has left the burst (300 ms + half of 25 ms); the mouth must be shut
        // 120 ms after that, and stay shut to the end.
        const closeFrom = Math.ceil((0.3 + 0.0125 + 0.12) / 0.01);
        expect(closeFrom).toBe(44);
        for (let i = closeFrom; i < jaw.length; i++) {
          expect(jaw[i], `jaw[${i}]`).toBe(0);
          expect(round[i], `round[${i}]`).toBe(0); // round uses the forced jaw
        }
        // Release tail: the mouth is still open, and closing, until 120 ms after the burst. Frame 42 (0.327) is
        // the 11th frame of n = 0, so a close after 110 ms or a shorter window would shut it.
        for (let i = 30; i <= 42; i++) expect(jaw[i]!, `jaw[${i}]`).toBeGreaterThan(0);
        for (let i = 32; i <= 42; i++) {
          if (jaw[i] !== 0) expect(jaw[i]!, `jaw[${i}]`).toBeLessThanOrEqual(jaw[i - 1]!);
        }
      },
    );
  });

  describe('smoothing and jaw shape', () => {
    it.each(RATES)('release and attack follow α = 1 − exp(−hop/τ) with jaw = s^0.7 at %i Hz', (fs) => {
      const { jaw } = analyzeEnvelope(burstThenSilence(fs), fs, 1);
      // Release (n = 0 from frame 32): s shrinks by exp(−hop/70 ms) per hop, so jaw by that to the 0.7.
      for (let i = 33; i <= 42; i++) {
        expect(jaw[i]! / jaw[i - 1]!, `jaw[${i}]/jaw[${i - 1}]`).toBeCloseTo(
          Math.exp((-0.7 * 0.01) / 0.07),
          5,
        );
      }
      // Attack (n = 1 on the burst): 1 − s shrinks by exp(−hop/15 ms) per hop, with s = jaw^(1/0.7).
      const rest = (k: number): number => 1 - jaw[k]! ** (1 / 0.7);
      for (let i = 3; i <= 7; i++) {
        expect(rest(i) / rest(i - 1), `attack at frame ${i}`).toBeCloseTo(Math.exp(-0.01 / 0.015), 4);
      }
    });
  });

  describe('level normalisation', () => {
    it('n uses floor = P20 + 6 dB and ceiling = P95 of the frame levels', () => {
      // Level plateaus of a 300 Hz sine at 48 kHz (250 frames). A (60 frames) sets P20, D/E/D sets P95 = dB(D),
      // and F sits 7 dB above A, just over the floor.
      const [A, F, C, B, D, E] = [0.001, 0.001 * 10 ** (7 / 20), 0.01, 0.1, 0.3, 0.6];
      const x = segments(48000, [
        { sec: 0.6, tones: [[A, 300]] },
        { sec: 0.3, tones: [[F, 300]] },
        { sec: 0.5, tones: [[C, 300]] },
        { sec: 0.85, tones: [[B, 300]] },
        { sec: 0.1, tones: [[D, 300]] },
        { sec: 0.05, tones: [[E, 300]] },
        { sec: 0.1, tones: [[D, 300]] },
      ]);
      const { jaw } = analyzeEnvelope(x, 48000, 1);
      const floor = sineDb(A) + 6;
      const ceil = sineDb(D);
      const nOf = (amp: number): number => (sineDb(amp) - floor) / (ceil - floor);
      for (const i of [55, 58]) expect(jaw[i], `jaw[${i}]`).toBe(0); // A: below the floor, mouth shut
      for (const i of [80, 88]) expect(jaw[i]!, `jaw[${i}]`).toBeCloseTo(nOf(F) ** 0.7, 3); // n ≈ 0.02: open
      for (const i of [135, 138]) expect(jaw[i]!, `jaw[${i}]`).toBeCloseTo(nOf(C) ** 0.7, 3);
      for (const i of [215, 222]) expect(jaw[i]!, `jaw[${i}]`).toBeCloseTo(nOf(B) ** 0.7, 3);
    });
  });

  describe('length (validation 5)', () => {
    it.each(RATES)('every track has ceil(n / H) frames at %i Hz', (fs) => {
      const hop = hopOf(fs);
      for (const n of [1, hop - 1, hop, hop + 1, 12345, fs, 2 * fs + 7]) {
        const x = new Float32Array(n);
        for (let i = 0; i < n; i++) x[i] = 0.1 * Math.sin((2 * Math.PI * 440 * i) / fs);
        const env = analyzeEnvelope(x, fs, 1.6);
        expect(env.hopMs).toBe(10);
        for (const track of tracks(env)) expect(track.length, `n = ${n}`).toBe(Math.ceil(n / hop));
      }
    });
  });

  describe('teeth', () => {
    it.each(RATES)('quiet sibilance shows teeth; loud sibilance and a loud vowel do not, at %i Hz', (fs) => {
      const { teeth } = analyzeEnvelope(sibilanceClip(fs, 6000, 9000), fs, 1);
      expect(teeth.length).toBe(100);
      for (let i = 0; i <= 37; i++) expect(teeth[i]!, `teeth[${i}]`).toBeGreaterThan(0.9);
      for (let i = 42; i < 100; i++) expect(teeth[i], `teeth[${i}]`).toBe(0);
    });

    it('the top band is empty when 5000·p reaches 0.95·fs/2 (16 kHz, p = 2): no teeth', () => {
      const fs = 16000;
      const { teeth } = analyzeEnvelope(sibilanceClip(fs, 5000, 7500), fs, 2);
      expect(teeth.length).toBe(100);
      expect(teeth.findIndex((v) => v !== 0)).toBe(-1);
    });

    it('sib = E_top/(E_lo + E_hi + E_top) and teeth = min(1, (sib − 0.4)/0.4), top band [5000p, 0.95·fs/2]', () => {
      const a = 0.001;
      // Energies 1 : 1 : 4 in E_lo, E_hi, E_top → sib = 4/6, width = 1/2.
      const three = quietTonesThenLoudTone([
        [a, 500],
        [a, 2500],
        [2 * a, 10000],
      ]);
      for (let i = 5; i < 45; i++) {
        expect(three.teeth[i]!, `teeth[${i}]`).toBeCloseTo((4 / 6 - 0.4) / 0.4, 2);
        expect(three.width[i]!, `width[${i}]`).toBeCloseTo(0.5, 2);
      }
      // 4750 Hz is between E_hi and E_top; 23 400 Hz is above 0.95·fs/2 = 22 800 Hz: neither counts as sibilance.
      for (const hz of [4750, 23400]) {
        const { teeth } = quietTonesThenLoudTone([
          [a, 500],
          [a, hz],
        ]);
        for (let i = 5; i < 45; i++) expect(teeth[i], `${hz} Hz: teeth[${i}]`).toBe(0);
      }
    });

    it('the teeth gate uses the raw level n < 0.5, not the smoothed jaw', () => {
      // Quiet floor A, a loud 300 Hz tone, then a sibilant mix whose level gives n ≈ 0.4 (E_top : E_lo = 4 : 1).
      const A = 0.001;
      const b = Math.sqrt((A * A * 10 ** (25.2 / 10)) / 2.5);
      const x = segments(48000, [
        { sec: 0.4, tones: [[A, 300]] },
        { sec: 0.4, tones: [[0.5, 300]] },
        {
          sec: 0.4,
          tones: [
            [b, 500],
            [2 * b, 10000],
          ],
        },
      ]);
      const { teeth, jaw } = analyzeEnvelope(x, 48000, 1);
      for (let i = 83; i < 118; i++) expect(teeth[i]!, `teeth[${i}]`).toBeGreaterThan(0.9);
      expect(jaw[84]!).toBeGreaterThan(0.5 ** 0.7); // the smoothed level is still above 0.5 there
    });
  });

  describe('input contract', () => {
    it.each([0, 40, 49, -48000, Number.NaN, Number.POSITIVE_INFINITY])(
      'throws RangeError for fs = %d',
      (fs) => {
        expect(() => analyzeEnvelope(new Float32Array(100), fs, 1)).toThrow(RangeError);
      },
    );

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('throws RangeError for pitchRatio = %d', (p) => {
      expect(() => analyzeEnvelope(new Float32Array(100), 48000, p)).toThrow(RangeError);
    });

    it('accepts fs = 50 (hop and window of one sample)', () => {
      const x = new Float32Array(10);
      for (let i = 0; i < x.length; i++) x[i] = (i % 3) - 1;
      const env = analyzeEnvelope(x, 50, 1);
      for (const track of tracks(env)) expect(track.length).toBe(10);
    });

    it('does not modify its input', () => {
      const x = amTone(48000, 'sin');
      const copy = x.slice();
      analyzeEnvelope(x, 48000, 1.6);
      expect(x).toEqual(copy);
    });
  });

  describe('scaleBandsWithP (X-A3, lab/envelope)', () => {
    /** 1 s at 48 kHz: loud broadband noise (100 Hz–20 kHz), then quiet noise, so every track and n vary. */
    function broadband(): Float32Array {
      const fs = 48000;
      const x = new Float32Array(fs);
      addBandNoise(x, 0, fs / 2, fs, 100, 20000, 31, 0.3);
      addBandNoise(x, fs / 2, fs, fs, 100, 20000, 32, 0.01);
      return x;
    }

    it('omitted opts, {} and { scaleBandsWithP: true } give identical tracks (the default scales with p)', () => {
      const x = broadband();
      const base = analyzeEnvelope(x, 48000, 1.6);
      expect(analyzeEnvelope(x, 48000, 1.6, {})).toEqual(base);
      expect(analyzeEnvelope(x, 48000, 1.6, { scaleBandsWithP: true })).toEqual(base);
    });

    it.each([0.75, 1.6, 2, 2.2])('false at p = %s gives exactly the p = 1 tracks (the fixed edges)', (p) => {
      const x = broadband();
      const fixed = analyzeEnvelope(x, 48000, p, { scaleBandsWithP: false });
      expect(fixed).toEqual(analyzeEnvelope(x, 48000, 1));
      // Not vacuous: with the default scaling the same p moves the edges and changes width.
      expect(analyzeEnvelope(x, 48000, p).width).not.toEqual(fixed.width);
    });

    it('a 1600 Hz tone at p = 2 is in E_hi with the fixed edges (width 1) and in E_lo when scaled (width 0)', () => {
      const x = segments(48000, [{ sec: 0.3, tones: [[0.4, 1600]] }]);
      const fixed = analyzeEnvelope(x, 48000, 2, { scaleBandsWithP: false }).width;
      const scaled = analyzeEnvelope(x, 48000, 2).width;
      for (let i = 3; i < 27; i++) {
        expect(fixed[i]!, `fixed width[${i}]`).toBeGreaterThan(0.97);
        expect(scaled[i]!, `scaled width[${i}]`).toBeLessThan(0.03);
      }
    });

    it('jaw does not depend on the band edges: identical with scaleBandsWithP true and false', () => {
      const x = broadband();
      for (const p of [0.75, 2]) {
        expect(analyzeEnvelope(x, 48000, p, { scaleBandsWithP: false }).jaw).toEqual(
          analyzeEnvelope(x, 48000, p).jaw,
        );
      }
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'still throws RangeError for pitchRatio = %d with scaleBandsWithP: false',
      (p) => {
        expect(() => analyzeEnvelope(new Float32Array(100), 48000, p, { scaleBandsWithP: false })).toThrow(
          RangeError,
        );
      },
    );
  });
});
