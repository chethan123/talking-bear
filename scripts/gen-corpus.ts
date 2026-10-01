// Corpus loading for the M2 TTS regression corpus mixer (plan §7 M2, issue #52): the committed clean speech
// (test/corpus/speech/, from gen-tts.ts) decoded for scripts/corpus-lib.ts. The command line follows.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readWav } from '../test/wav.ts';
import { SAMPLE_RATE, type AudioLookup, type CorpusEntry } from './corpus-lib.ts';
import { MANIFEST_PATH, REPO_ROOT, SPEECH_DIR, parseManifest } from './gen-tts.ts';

export const CORPUS_DIR = join(REPO_ROOT, '.cache/corpus');
export const HASHES_PATH = join(REPO_ROOT, 'test/corpus/mix-hashes.json');

/** The manifest entries and their decoded 16 kHz clean audio. */
export function loadCorpus(): { entries: CorpusEntry[]; audio: AudioLookup } {
  const manifest = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
  const clips = new Map<string, Float32Array>();
  for (const entry of manifest) {
    const { sampleRate, channels } = readWav(readFileSync(join(SPEECH_DIR, entry.file)));
    if (sampleRate !== SAMPLE_RATE || channels.length !== 1 || channels[0]!.length !== entry.samples) {
      throw new Error(`${entry.file}: expected ${entry.samples} samples of 16 kHz mono`);
    }
    clips.set(entry.id, channels[0]!);
  }
  const entries = manifest.map(({ id, kind, text, samples, spans }) => ({ id, kind, text, samples, spans }));
  return {
    entries,
    audio: (id) => {
      const clip = clips.get(id);
      if (clip === undefined) throw new Error(`unknown utterance ${id}`);
      return clip;
    },
  };
}
