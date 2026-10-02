import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ATOL,
  ATTACK_END_S,
  ATTACK_START_S,
  FINGERPRINT_MESSAGE,
  FINGERPRINT_RATES,
  GOLDEN_PATH,
  PROBE_END_S,
  RELEASE_START_S,
  RTOL,
  SIGNAL_SECONDS,
  SILENCE_END_S,
  SNR_DB,
  STREAM_NAMES,
  TONE_RMS,
  compareFingerprints,
  computeFingerprint,
  decide,
  fingerprintSignal,
  formatGolden,
  parseGolden,
  relativeError,
  type Fingerprint,
} from '../../scripts/gen-vad-fingerprint.ts';
import { rmsDb } from '../../test/dsp-helpers.ts';
import { ENERGY_HOP, VAD_FRAME, VAD_RATE } from '../audio/constants.ts';
import { FRONT_END_CONFIG } from './config.ts';

// The VAD front-end fingerprint (issue #171): the production front end must still produce the streams of
// fingerprint.golden.json, recorded under FRONT_END_CONFIG.revision. scripts/gen-vad-fingerprint.ts holds the
// signal, the pipeline and the comparison, shared with the generator (pnpm gen:vad-fingerprint).

const goldenText = readFileSync(GOLDEN_PATH, 'utf8');
const golden = parseGolden(goldenText);

describe('VAD front-end fingerprint', () => {
  it('FRONT_END_CONFIG.revision is an integer >= 1', () => {
    expect(Number.isSafeInteger(FRONT_END_CONFIG.revision)).toBe(true);
    expect(FRONT_END_CONFIG.revision).toBeGreaterThanOrEqual(1);
  });

  it('(a) the golden was generated under FRONT_END_CONFIG.revision', () => {
    expect(
      golden.revision,
      `${FINGERPRINT_MESSAGE} (golden revision ${golden.revision}, FRONT_END_CONFIG.revision ${FRONT_END_CONFIG.revision})`,
    ).toBe(FRONT_END_CONFIG.revision);
  });

  it('(b) every stream at 48 and 44.1 kHz matches the golden (relative 1e-6, absolute 1e-9 near zero)', () => {
    expect(compareFingerprints(golden, computeFingerprint()), FINGERPRINT_MESSAGE).toEqual([]);
  });

  it("the golden is in the generator's canonical form (pnpm gen:vad-fingerprint rewrites it byte for byte)", async () => {
    expect(await formatGolden(golden)).toBe(goldenText);
  });
});

describe('fingerprint signal', () => {
  it('is 1.5 s long at each rate and the same on every call', () => {
    for (const rate of FINGERPRINT_RATES) {
      const x = fingerprintSignal(rate);
      expect(x.length).toBe(Math.round(SIGNAL_SECONDS * rate));
      expect(Buffer.from(fingerprintSignal(rate).buffer).equals(Buffer.from(x.buffer))).toBe(true);
    }
  });

  it('is digital silence, then the probe alone, then noise ~20 dB below the vowel', () => {
    for (const rate of FINGERPRINT_RATES) {
      const x = fingerprintSignal(rate);
      const at = (s: number): number => Math.round(s * rate);
      expect(x.subarray(0, at(SILENCE_END_S)).every((v) => v === 0)).toBe(true);
      const noiseDb = rmsDb(x, at(PROBE_END_S), at(ATTACK_START_S));
      const vowelDb = rmsDb(x, at(ATTACK_END_S), at(RELEASE_START_S));
      expect(noiseDb).toBeCloseTo(20 * Math.log10(TONE_RMS) - SNR_DB, 0);
      expect(vowelDb - noiseDb).toBeGreaterThan(SNR_DB - 0.5);
      expect(vowelDb - noiseDb).toBeLessThan(SNR_DB + 0.5);
    }
  });

  it('exercises every stream: digital silence, probe leakage, noise and voiced speech', () => {
    for (const rate of FINGERPRINT_RATES) {
      const s = golden.rates[rate];
      expect(s.sileroP.length).toBeGreaterThanOrEqual(
        Math.floor((SIGNAL_SECONDS * VAD_RATE) / VAD_FRAME) - 1,
      );
      expect(s.rawDb.length).toBe(Math.floor((s.sileroP.length * VAD_FRAME) / ENERGY_HOP));
      expect(s.bandDb.length).toBe(s.rawDb.length);
      expect(s.voicing.length).toBe(s.rawDb.length);
      expect(Math.min(...s.rawDb)).toBe(-120); // frameDb's floor: 10 · log10(1e-12)
      expect(s.rawDb.some((db) => db > -100 && db < -60)).toBe(true); // the probe's stopband leakage
      expect(Math.min(...s.voicing)).toBeLessThan(0.01);
      expect(Math.max(...s.voicing)).toBeGreaterThan(0.9);
      expect(Math.min(...s.sileroP)).toBeLessThan(0.05);
      expect(Math.max(...s.sileroP)).toBeGreaterThan(0.9);
    }
  });
});

/** A fingerprint whose every stream is [v, 1, 0]. */
function uniform(revision: number, v: number): Fingerprint {
  const streams = (): Fingerprint['rates']['48000'] => ({
    rawDb: [v, 1, 0],
    bandDb: [v, 1, 0],
    voicing: [v, 1, 0],
    sileroP: [v, 1, 0],
  });
  return { revision, rates: { '48000': streams(), '44100': streams() } };
}

describe('comparison', () => {
  it('allows a relative error of 1e-6, or 1e-9 absolute near zero', () => {
    expect(relativeError(1 + 0.9e-6, 1)).toBeLessThanOrEqual(RTOL);
    expect(relativeError(1 + 1.1e-6, 1)).toBeGreaterThan(RTOL);
    expect(relativeError(-120 * (1 + 0.9e-6), -120)).toBeLessThanOrEqual(RTOL);
    expect(relativeError(0.9 * ATOL, 0)).toBeLessThanOrEqual(RTOL);
    expect(relativeError(1.1 * ATOL, 0)).toBeGreaterThan(RTOL);
  });

  it('names each stream that is out of tolerance or of another length', () => {
    const g = uniform(1, 0.5);
    expect(compareFingerprints(g, uniform(1, 0.5 * (1 + 0.5e-6)))).toEqual([]);
    const off = uniform(1, 0.5);
    off.rates['44100'].voicing[1] = 1.01;
    off.rates['48000'].sileroP.push(0);
    const problems = compareFingerprints(g, off);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^48000 Hz sileroP: 4 values, the golden has 3/);
    expect(problems[1]).toMatch(/^44100 Hz voicing: 1 of 3 values out of tolerance \(first \[1\]/);
    expect(STREAM_NAMES).toEqual(['rawDb', 'bandDb', 'voicing', 'sileroP']);
  });
});

describe('generator decision', () => {
  it('writes the computed fingerprint when there is no golden or the revision went up', () => {
    const computed = uniform(2, 0.25);
    expect(decide(null, computed)).toMatchObject({ write: true, golden: computed });
    expect(decide(uniform(1, 0.5), computed)).toMatchObject({ write: true, golden: computed });
  });

  it('under the same revision, keeps the golden when the streams match and refuses when they changed', () => {
    const existing = uniform(1, 0.5);
    expect(decide(existing, uniform(1, 0.5))).toMatchObject({ write: true, golden: existing });
    const near = decide(existing, uniform(1, 0.5 * (1 + 0.5e-6)));
    expect(near).toMatchObject({ write: true, golden: existing });
    const changed = decide(existing, uniform(1, 0.5 * (1 + 2e-6)));
    expect(changed.write).toBe(false);
    expect(changed.why.startsWith(FINGERPRINT_MESSAGE)).toBe(true);
  });

  it("refuses a revision below the golden's, or one that is not an integer >= 1", () => {
    expect(decide(uniform(3, 0.5), uniform(2, 0.5)).write).toBe(false);
    expect(decide(null, uniform(1.5, 0.5)).write).toBe(false);
    expect(decide(null, uniform(0, 0.5)).write).toBe(false);
  });
});
