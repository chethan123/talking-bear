import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { readWav } from '../test/wav.ts';
import {
  E2E_DIR,
  E2E_RATE,
  E2E_SOURCES,
  PAD_SAMPLES,
  buildE2eFixtures,
  parseE2eSidecar,
  selectSource,
} from './gen-e2e-tts-fixtures.ts';
import {
  DOCKERFILE_PATH,
  HOP,
  MANIFEST_PATH,
  MAX_SENTENCE_SAMPLES,
  MERGE_GAP_MS,
  MIN_RUN_MS,
  PROVENANCE_PATH,
  SAMPLE_RATE,
  SIZE_BUDGET_BYTES,
  SPEECH_DIR,
  TEXTS_PATH,
  THRESHOLD_DB,
  combo,
  labelSpans,
  parseDockerfile,
  parseManifest,
  parseTexts,
  planRenders,
} from './gen-tts.ts';

/**
 * The format fields of a canonical 44-byte-header WAV, as writeWav emits it; throws if the header isn't canonical.
 * (readWav decodes PCM16, PCM32 and float32 alike, so the sample format is checked here.)
 */
function canonicalHeader(bytes: Uint8Array): {
  formatTag: number;
  channels: number;
  sampleRate: number;
  bits: number;
  dataBytes: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  expect([id(0), id(8), id(12), id(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
  expect(view.getUint32(16, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(bytes.byteLength - 44);
  return {
    formatTag: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
  };
}

/** `x` filled with `amp` (a square wave of amplitude amp, so every 10 ms hop has energy amp²) over [from, to). */
function block(x: Float32Array, from: number, to: number, amp: number): void {
  for (let i = from; i < to; i++) x[i] = i % 2 === 0 ? amp : -amp;
}

const ms = (n: number): number => n * (SAMPLE_RATE / 1000);

/**
 * sha256 of the 108 committed corpus WAVs, concatenated in manifest order (espeak-ng 1.51+dfsg-12build1, see
 * test/corpus/PROVENANCE.md). It catches silent corruption that the peak, edge and label checks miss; regenerating
 * the corpus with another espeak-ng build changes it on purpose.
 */
const CORPUS_WAV_SHA256 = '6b6dd427adfa5eee3180a904a424f8863132ea018c6ffa4bcc64af633fa0c48e';

describe('labelSpans', () => {
  test("the labelling constants are the issue's numbers", () => {
    expect({ MERGE_GAP_MS, THRESHOLD_DB, MIN_RUN_MS, HOP }).toEqual({
      MERGE_GAP_MS: { word: 150, sentence: 150, passage: 300 },
      THRESHOLD_DB: 35,
      MIN_RUN_MS: 50,
      HOP: 160,
    });
  });

  test('speech is every hop strictly above max hop dB − 35 dB', () => {
    const x = new Float32Array(ms(300));
    block(x, 0, ms(100), 0.5);
    block(x, ms(100), ms(200), 0.5 * 10 ** (-34.9 / 20)); // −34.9 dB: speech
    block(x, ms(200), ms(300), 0.5 * 10 ** (-35.1 / 20)); // −35.1 dB: not speech
    expect(labelSpans(x, 0)).toEqual([[0, ms(200)]]);
  });

  test('merges gaps shorter than the merge gap, then drops runs shorter than 50 ms', () => {
    const x = new Float32Array(ms(1000));
    block(x, 0, ms(100), 0.5);
    block(x, ms(240), ms(340), 0.5); // 140 ms gap: merged at 150 ms
    block(x, ms(490), ms(590), 0.5); // 150 ms gap: kept apart at 150 ms, merged at 300 ms
    block(x, ms(800), ms(840), 0.5); // 40 ms run after a 210 ms gap: dropped at 150 ms
    expect(labelSpans(x, 150)).toEqual([
      [0, ms(340)],
      [ms(490), ms(590)],
    ]);
    expect(labelSpans(x, 300)).toEqual([[0, ms(840)]]);
    expect(labelSpans(x, 0)).toEqual([
      [0, ms(100)],
      [ms(240), ms(340)],
      [ms(490), ms(590)],
    ]);
    expect(labelSpans(x, 0, 35, 0)).toHaveLength(4);
  });

  test('a 50 ms run is kept; the last partial hop ends the span at the signal end', () => {
    const x = new Float32Array(ms(50) + 37);
    block(x, 0, x.length, 0.5);
    expect(labelSpans(x, 150)).toEqual([[0, x.length]]);
    expect(labelSpans(x.subarray(0, ms(50) - 1), 150)).toEqual([]);
    // Sanity check of the setup, not of labelSpans: the signal ends in a partial 37-sample hop.
    expect(x.length % HOP).toBe(37);
  });

  test('silence has no spans', () => {
    expect(labelSpans(new Float32Array(1000), 150)).toEqual([]);
    expect(labelSpans(new Float32Array(0), 150)).toEqual([]);
  });
});

describe('render grid', () => {
  test('render r of text t uses voices[g % 6], pitches[(g >> 1) % 4], speeds[(g >> 2) % 3] with g = 2t + r', () => {
    expect(combo(0)).toEqual({ voice: 'en-us', pitch: 30, speed: 130 });
    expect(combo(1)).toEqual({ voice: 'en-gb', pitch: 30, speed: 130 });
    expect(combo(5)).toEqual({ voice: 'en-us+whisper', pitch: 80, speed: 175 });
    expect(combo(16)).toEqual({ voice: 'en-gb+m3', pitch: 30, speed: 175 });
    expect(combo(107)).toEqual({ voice: 'en-us+whisper', pitch: 50, speed: 220 });
  });

  test('texts.json has 30 words, 20 sentences and 4 passages, giving 108 renders', () => {
    const renders = planRenders(parseTexts(JSON.parse(readFileSync(TEXTS_PATH, 'utf8'))));
    expect(renders).toHaveLength(108);
    expect(renders.filter((r) => r.kind === 'word')).toHaveLength(60);
    expect(renders.filter((r) => r.kind === 'sentence')).toHaveLength(40);
    expect(renders.filter((r) => r.kind === 'passage')).toHaveLength(8);
    expect(renders[60]).toMatchObject({ id: 'sentence-00-r0', ...combo(60) });
    expect(new Set(renders.map((r) => r.id)).size).toBe(108);
  });

  test('parseManifest rejects a malformed entry', () => {
    const entry = {
      id: 'word-00-r0',
      file: 'word-00-r0.wav',
      kind: 'word',
      text: 'hello',
      voice: 'en-us',
      pitch: 30,
      speed: 130,
      samples: 10,
      spans: [[0, 10]],
    };
    expect(parseManifest([entry])).toEqual([entry]);
    expect(() => parseManifest([{ ...entry, spans: [[0, 10.5]] }])).toThrow(/entry 0 is malformed/);
    expect(() => parseManifest([{ ...entry, voice: 'en-xx' }])).toThrow(/entry 0 is malformed/);
    expect(() => parseManifest({})).toThrow(/expected an array/);
  });

  test('parseDockerfile reads the base image and the espeak-ng pins, ignoring comments', () => {
    const text = [
      '# espeak-ng=0.0 in a comment',
      'FROM debian:trixie-slim@sha256:00',
      'RUN apt-get install -y espeak-ng=1.2-3 \\',
      '    libespeak-ng1=1.2-3 espeak-ng-data=1.2-3',
    ].join('\n');
    expect(parseDockerfile(text)).toEqual({
      from: 'debian:trixie-slim@sha256:00',
      pins: ['espeak-ng=1.2-3', 'libespeak-ng1=1.2-3', 'espeak-ng-data=1.2-3'],
      espeakVersion: '1.2-3',
    });
    expect(() => parseDockerfile('RUN apt-get install espeak-ng=1')).toThrow(/FROM/);
    expect(() => parseDockerfile('FROM x\n# espeak-ng=1')).toThrow(/espeak-ng=/);
    const committed = parseDockerfile(readFileSync(DOCKERFILE_PATH, 'utf8'));
    expect(committed.from).toMatch(/^debian:trixie-slim@sha256:[0-9a-f]{64}$/);
    expect(committed.pins.map((pin) => pin.split('=')[0])).toEqual([
      'espeak-ng',
      'libespeak-ng1',
      'espeak-ng-data',
    ]);
  });
});

describe('committed corpus: test/corpus/speech', () => {
  const manifest = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
  const renders = planRenders(parseTexts(JSON.parse(readFileSync(TEXTS_PATH, 'utf8'))));

  test('the manifest lists every render of texts.json, in order, and the directory holds exactly its WAVs', () => {
    expect(
      manifest.map(({ id, kind, text, voice, pitch, speed }) => ({ id, kind, text, voice, pitch, speed })),
    ).toEqual(renders);
    expect(manifest.map((e) => e.file)).toEqual(renders.map((r) => `${r.id}.wav`));
    const files = readdirSync(SPEECH_DIR).toSorted();
    expect(files).toEqual([...manifest.map((e) => e.file), 'manifest.json'].toSorted());
    expect(files.filter((f) => f.endsWith('.wav'))).toHaveLength(108);
  });

  test("PROVENANCE.md names the Dockerfile's base image and package pins", () => {
    const provenance = readFileSync(PROVENANCE_PATH, 'utf8');
    const { from, pins, espeakVersion } = parseDockerfile(readFileSync(DOCKERFILE_PATH, 'utf8'));
    expect(provenance).toContain(`FROM ${from}`);
    for (const pin of pins) expect(provenance).toContain(pin);
    expect(provenance).toContain(
      `Verify on first \`docker build\` (\`docker run --rm --entrypoint dpkg <image> -s espeak-ng\` must report ${espeakVersion}).`,
    );
  });

  test('the committed WAVs match the aggregate sha256 (manifest order)', () => {
    const hash = createHash('sha256');
    for (const entry of manifest) hash.update(readFileSync(join(SPEECH_DIR, entry.file)));
    expect(hash.digest('hex')).toBe(CORPUS_WAV_SHA256);
  });

  test(`the directory is within the ${SIZE_BUDGET_BYTES}-byte budget`, () => {
    const total = readdirSync(SPEECH_DIR).reduce((sum, f) => sum + statSync(join(SPEECH_DIR, f)).size, 0);
    expect(total).toBeLessThanOrEqual(SIZE_BUDGET_BYTES);
  });

  test.each(manifest.map((e) => [e.id, e] as const))('%s', (_id, entry) => {
    const bytes = readFileSync(join(SPEECH_DIR, entry.file));
    // 16 kHz mono PCM16, `samples` long.
    expect(canonicalHeader(bytes)).toEqual({
      formatTag: 1,
      channels: 1,
      sampleRate: SAMPLE_RATE,
      bits: 16,
      dataBytes: entry.samples * 2,
    });
    const { sampleRate, channels } = readWav(bytes);
    expect(sampleRate).toBe(SAMPLE_RATE);
    expect(channels).toHaveLength(1);
    const x = channels[0]!;
    expect(x.length).toBe(entry.samples);
    // No lead or tail padding; peak-normalised to −6 dBFS (0.501 × 32768 = 16423).
    expect(x[0]).not.toBe(0);
    expect(x[x.length - 1]).not.toBe(0);
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    expect(Math.abs(peak * 32768 - 16423)).toBeLessThanOrEqual(1);
    // Spans: integers, ordered, disjoint, inside the file; words and sentences have at least one.
    if (entry.kind !== 'passage') expect(entry.spans.length).toBeGreaterThanOrEqual(1);
    let previousEnd = -1;
    for (const span of entry.spans) {
      expect(span).toHaveLength(2);
      const [start, end] = span;
      expect(Number.isInteger(start) && Number.isInteger(end)).toBe(true);
      expect(start).toBeGreaterThan(previousEnd);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(entry.samples);
      previousEnd = end;
    }
    // The labels are exactly what the labelling rules give on the committed signal.
    expect(entry.spans).toEqual(labelSpans(x, MERGE_GAP_MS[entry.kind]));
    if (entry.kind === 'sentence') expect(entry.samples).toBeLessThan(MAX_SENTENCE_SAMPLES);
  });
});

describe('e2e TTS fixtures: e2e/fixtures/tts_sentence_{a,b}', () => {
  const manifest = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
  const rebuilt = buildE2eFixtures();

  test.each(E2E_SOURCES.map((s, i) => [s.name, s, i] as const))('%s', (name, source, i) => {
    const bytes = readFileSync(join(E2E_DIR, `${name}.wav`));
    const json = readFileSync(join(E2E_DIR, `${name}.json`), 'utf8');
    const sidecar = parseE2eSidecar(JSON.parse(json));
    // 48 kHz mono PCM16.
    const header = canonicalHeader(bytes);
    expect(header).toMatchObject({ formatTag: 1, channels: 1, sampleRate: E2E_RATE, bits: 16 });
    const { channels } = readWav(bytes);
    expect(channels).toHaveLength(1);
    const x = channels[0]!;
    // 1.0 s of leading zeros; at least 300 ms of trailing zeros (the fake mic repeats its last buffer).
    expect(x.subarray(0, PAD_SAMPLES).every((v) => v === 0)).toBe(true);
    expect(x.subarray(x.length - 0.3 * E2E_RATE).every((v) => v === 0)).toBe(true);
    // The sidecar: the file's length, speech spans inside it, a finite f0.
    expect(sidecar.sampleRate).toBe(E2E_RATE);
    expect(sidecar.lengthSamples).toBe(x.length);
    expect(sidecar.speech.length).toBeGreaterThanOrEqual(1);
    for (const { start, end } of sidecar.speech) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(x.length);
    }
    expect(Number.isFinite(sidecar.f0) && sidecar.f0 > 0).toBe(true);
    // Its source: the manifest spans × 3 plus the 1.0 s lead; and the committed bytes are what the script builds.
    const entry = selectSource(manifest, source);
    expect(sidecar.speech).toEqual(
      entry.spans.map(([s, e]) => ({ start: 3 * s + PAD_SAMPLES, end: 3 * e + PAD_SAMPLES })),
    );
    // Sanity check of the pairing below (buildE2eFixtures follows E2E_SOURCES' order), not of the fixture.
    expect(rebuilt[i]!.name).toBe(name);
    expect(Buffer.from(rebuilt[i]!.wav).equals(bytes)).toBe(true);
    expect(rebuilt[i]!.json).toBe(json);
  });
});
