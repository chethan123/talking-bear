// The e2e TTS fake-mic fixtures e2e/fixtures/tts_sentence_{a,b}.wav + .json (issue #50), built from two committed
// sentence renders of test/corpus/speech (scripts/gen-tts.ts). It needs no espeak-ng, and reruns are byte-identical.
//
// Each fixture is the 16 kHz render upsampled to 48 kHz with resampleOffline(x, 3), between 1.0 s of leading and
// 1.0 s of trailing digital zeros (Chromium's fake mic re-delivers its last buffer forever after the end of the
// file, so it needs ≥ 300 ms of trailing zeros; plan §4.9.3), as 48 kHz mono PCM16 like the other e2e fixtures.
// The sidecar has their shape (scripts/gen-fixtures.ts) without `seed`, since nothing here is random:
// `{ sampleRate, lengthSamples, speech: [{ start, end }], f0 }`, the speech spans being the manifest's × 3 plus
// the 48 000-sample lead, and f0 the YIN estimate (src/dsp/yin.ts) of the fixture, rounded to 0.1 Hz.
//
// Usage: node scripts/gen-e2e-tts-fixtures.ts

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resampleOffline } from '../src/dsp/resample.ts';
import { yinF0 } from '../src/dsp/yin.ts';
import { readWav, writeWav } from '../test/wav.ts';
import type { ManifestEntry, Voice } from './gen-tts.ts';
import { MANIFEST_PATH, REPO_ROOT, SAMPLE_RATE, SPEECH_DIR, parseManifest } from './gen-tts.ts';

export const E2E_DIR = join(REPO_ROOT, 'e2e/fixtures');
export const E2E_RATE = 48_000;
/** 16 kHz → 48 kHz. */
export const UPSAMPLE = E2E_RATE / SAMPLE_RATE;
/** 1.0 s of digital zeros before and after the speech. */
export const PAD_SAMPLES = E2E_RATE;

export interface E2eSource {
  name: string;
  pitch: number;
  voice: Voice;
}

/**
 * The fixture sources: the first sentence render (manifest order) with this pitch and voice. `a` is the plain
 * voice at the lowest pitch; `b` is pitch 99 (the "child-like" proxy) with the female variant f2. Neither is the
 * whisper variant, whose unvoiced speech has no f0.
 */
export const E2E_SOURCES: readonly E2eSource[] = [
  { name: 'tts_sentence_a', pitch: 30, voice: 'en-us' },
  { name: 'tts_sentence_b', pitch: 99, voice: 'en-us+f2' },
];

export interface E2eSidecar {
  sampleRate: number;
  lengthSamples: number;
  /** Half-open [start, end) sample-index spans at 48 kHz. */
  speech: { start: number; end: number }[];
  f0: number;
}

/** The source entry for `source`; throws unless exactly one span labels it (the e2e specs time one utterance). */
export function selectSource(manifest: readonly ManifestEntry[], source: E2eSource): ManifestEntry {
  const entry = manifest.find(
    (e) => e.kind === 'sentence' && e.pitch === source.pitch && e.voice === source.voice,
  );
  if (entry === undefined)
    throw new Error(`${source.name}: no sentence with pitch ${source.pitch} and voice ${source.voice}`);
  if (entry.spans.length !== 1)
    throw new Error(`${source.name}: ${entry.id} has ${entry.spans.length} spans, expected 1`);
  return entry;
}

/** Builds one fixture from its source entry and the decoded 16 kHz render. */
export function buildE2eFixture(
  entry: ManifestEntry,
  speech: Float32Array,
): { wav: Uint8Array; sidecar: E2eSidecar } {
  if (speech.length !== entry.samples)
    throw new Error(`${entry.id}: ${speech.length} samples, manifest says ${entry.samples}`);
  const up = resampleOffline(speech, UPSAMPLE);
  const samples = new Float32Array(PAD_SAMPLES + up.length + PAD_SAMPLES);
  samples.set(up, PAD_SAMPLES);
  const wav = writeWav([samples], E2E_RATE, 'pcm16');
  const decoded = readWav(wav).channels[0]!;
  const f0 = yinF0(decoded, E2E_RATE);
  if (!Number.isFinite(f0)) throw new Error(`${entry.id}: YIN finds no f0`);
  const sidecar: E2eSidecar = {
    sampleRate: E2E_RATE,
    lengthSamples: decoded.length,
    speech: entry.spans.map(([start, end]) => ({
      start: start * UPSAMPLE + PAD_SAMPLES,
      end: end * UPSAMPLE + PAD_SAMPLES,
    })),
    f0: Math.round(f0 * 10) / 10,
  };
  return { wav, sidecar };
}

const isInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const get = (from: unknown, key: string): unknown =>
  typeof from === 'object' && from !== null ? Reflect.get(from, key) : undefined;

/** Throws unless `value` is an e2e TTS sidecar; returns it. */
export function parseE2eSidecar(value: unknown): E2eSidecar {
  const [sampleRate, lengthSamples, speech, f0] = ['sampleRate', 'lengthSamples', 'speech', 'f0'].map((k) =>
    get(value, k),
  );
  if (
    !isInteger(sampleRate) ||
    !isInteger(lengthSamples) ||
    !Array.isArray(speech) ||
    typeof f0 !== 'number' ||
    Object.keys(value ?? {}).length !== 4
  ) {
    throw new Error('e2e sidecar: expected { sampleRate, lengthSamples, speech, f0 }');
  }
  return {
    sampleRate,
    lengthSamples,
    speech: speech.map((span: unknown) => {
      const start = get(span, 'start');
      const end = get(span, 'end');
      if (!isInteger(start) || !isInteger(end)) throw new Error('e2e sidecar: malformed speech span');
      return { start, end };
    }),
    f0,
  };
}

/** The sidecar's file content (Prettier-stable, like gen-fixtures.ts). */
export function encodeSidecar(sidecar: E2eSidecar): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

/** Builds every fixture from the committed corpus. */
export function buildE2eFixtures(): { name: string; wav: Uint8Array; json: string }[] {
  const manifest = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
  return E2E_SOURCES.map((source) => {
    const entry = selectSource(manifest, source);
    const speech = readWav(readFileSync(join(SPEECH_DIR, entry.file))).channels[0]!;
    const { wav, sidecar } = buildE2eFixture(entry, speech);
    return { name: source.name, wav, json: encodeSidecar(sidecar) };
  });
}

if (import.meta.main) {
  mkdirSync(E2E_DIR, { recursive: true });
  for (const { name, wav, json } of buildE2eFixtures()) {
    writeFileSync(join(E2E_DIR, `${name}.wav`), wav);
    writeFileSync(join(E2E_DIR, `${name}.json`), json);
    console.log(`wrote e2e/fixtures/${name}.wav and .json`);
  }
}
