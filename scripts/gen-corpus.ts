// Builds the M2 TTS regression corpus deterministically (plan §7 M2, issue #52): the committed clean speech
// (test/corpus/speech/, from gen-tts.ts) mixed with synthetic noises through a synthetic room and phone band, at
// fixed SNRs, from a fixed seed. The mixes are not committed (> 100 MB); test/corpus/mix-hashes.json holds the
// SHA-256 of every output so any nondeterminism is caught. The recipes live in scripts/corpus-lib.ts.
//
// Usage:
//   node scripts/gen-corpus.ts --subset fast|full [--check | --write-hashes]
//
//   --subset fast    fan and tv at SNR 10 and 5 (20 utterances each) and 2 min of fan noise-only (fast-* files)
//   --subset full    everything: the 20 noise × SNR scenes, 15 min of fan and of music noise-only, the passages
//                    scene, and the fast subset
//   --check          compare the SHA-256 of every output with test/corpus/mix-hashes.json; exit 1 on any mismatch
//   --write-hashes   record the outputs' SHA-256 in test/corpus/mix-hashes.json (full: replace the whole file;
//                    fast: update the fast entries)
//
// Every mode writes .cache/corpus/<scene>.f32 (raw Float32 LE, 16 kHz mono, no header) and
// .cache/corpus/<scene>.json ({ sampleRate, samples, noise, snrDb, rt60, spans, kinds, ids }; `ids` names the
// utterance of each span, since a few renders have 2 spans).
//
// For consumers (the VAD harness, #53):
// - Select scenes with planCorpus(subset, entries) and its `group` field, not by listing .cache/corpus: the full
//   subset also contains the fast-* scenes, so a full pooled metric must take group 'full' only, or the fast
//   scenes are counted twice.
// - Samples are not limited to ±1: scenes keep the exact RMS SNR, so sparse loud noise peaks above full scale
//   (music-snr0 1.33, clatter-snr10/5/0 2.39/3.98/5.93). Don't clamp, don't assert |x| ≤ 1 and don't convert the
//   scenes to PCM16.
// - Each SNR scene is a contiguous run of the cyclic word+sentence list (60 words, then 40 sentences), so one scene
//   can be all words or all sentences; the rotation (corpus-lib.ts rotationStart) balances them per SNR level and
//   per noise. Words/sentences per scene: fan-snr20 28/0, fan-snr10 29/0, fan-snr5 10/15, fan-snr0 0/23,
//   amfan-snr20 29/0, amfan-snr10 15/11, amfan-snr5 0/23, amfan-snr0 21/5, tv-snr20 20/6, tv-snr10 0/24,
//   tv-snr5 15/10, tv-snr0 29/0, music-snr20 0/23, music-snr10 8/15, music-snr5 28/0, music-snr0 25/2,
//   clatter-snr20 3/20, clatter-snr10 29/0, clatter-snr5 28/0, clatter-snr0 5/19, fast-fan-snr10 20/0,
//   fast-fan-snr5 10/10, fast-tv-snr10 0/20, fast-tv-snr5 10/10 (per SNR 20/10/5/0: 80/49, 81/50, 81/48, 80/49).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { format, resolveConfig } from 'prettier';

import { readWav } from '../test/wav.ts';
import {
  SAMPLE_RATE,
  SUBSETS,
  type AudioLookup,
  type CorpusEntry,
  type Subset,
  f32leBytes,
  metaBytes,
  planCorpus,
  renderScene,
} from './corpus-lib.ts';
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

type Mode = 'generate' | 'check' | 'write-hashes';

export function parseArgs(argv: readonly string[]): { subset: Subset; mode: Mode } {
  const usage = 'usage: node scripts/gen-corpus.ts --subset fast|full [--check | --write-hashes]';
  let subset: Subset | undefined;
  let mode: Mode = 'generate';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--subset') {
      const value = argv[++i];
      const match = SUBSETS.find((s) => s === value);
      if (match === undefined || subset !== undefined) throw new Error(usage);
      subset = match;
    } else if ((arg === '--check' || arg === '--write-hashes') && mode === 'generate') {
      mode = arg === '--check' ? 'check' : 'write-hashes';
    } else {
      throw new Error(usage);
    }
  }
  if (subset === undefined) throw new Error(usage);
  return { subset, mode };
}

/** Throws unless `value` maps file names to 64-digit lowercase hex SHA-256 strings. */
export function parseHashes(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('mix-hashes.json: expected an object');
  }
  const out: Record<string, string> = {};
  for (const [name, hash] of Object.entries(value)) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`mix-hashes.json: invalid hash for ${name}`);
    }
    out[name] = hash;
  }
  return out;
}

/**
 * The mismatches between the generated hashes and the recorded ones: every generated file whose hash is missing or
 * different, and (for the full subset, which generates everything) every recorded file that wasn't generated.
 */
export function compareHashes(
  subset: Subset,
  generated: Readonly<Record<string, string>>,
  recorded: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  for (const [name, hash] of Object.entries(generated)) {
    const want = recorded[name];
    if (want === undefined) problems.push(`${name}: not in mix-hashes.json (got ${hash})`);
    else if (want !== hash) problems.push(`${name}: expected ${want}, got ${hash}`);
  }
  if (subset === 'full') {
    for (const name of Object.keys(recorded)) {
      if (!(name in generated)) problems.push(`${name}: recorded but not generated`);
    }
  }
  return problems;
}

/** The hash file after --write-hashes: full replaces every entry, fast updates its own; keys sorted. */
export function mergeHashes(
  subset: Subset,
  generated: Readonly<Record<string, string>>,
  recorded: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged = { ...(subset === 'full' ? {} : recorded), ...generated };
  return Object.fromEntries(
    Object.keys(merged)
      .toSorted()
      .map((k) => [k, merged[k]!]),
  );
}

/** Lowercase hex SHA-256 of `bytes`. */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Renders every scene of `subset` in plan order and returns its output files: `<scene>.f32` (raw Float32 LE) then
 * `<scene>.json`, per scene. A noise-only stream takes the noise level of its levelFrom scene, rendered before it.
 * `log` gets one line per scene.
 */
export function renderSubset(
  subset: Subset,
  corpus: { entries: readonly CorpusEntry[]; audio: AudioLookup },
  log?: (line: string) => void,
): { name: string; bytes: Uint8Array }[] {
  const files: { name: string; bytes: Uint8Array }[] = [];
  const levels = new Map<string, number>();
  for (const plan of planCorpus(subset, corpus.entries)) {
    const levelRms = plan.levelFrom === null ? undefined : levels.get(plan.levelFrom);
    const scene = renderScene(plan, corpus.entries, corpus.audio, levelRms);
    levels.set(plan.name, scene.noiseRms);
    files.push(
      { name: `${plan.name}.f32`, bytes: f32leBytes(scene.audio) },
      { name: `${plan.name}.json`, bytes: metaBytes(scene.meta) },
    );
    if (log !== undefined) {
      let peak = 0;
      for (const v of scene.audio) peak = Math.max(peak, Math.abs(v));
      const words = plan.placements.filter((p) => p.kind === 'word').length;
      log(
        `${plan.name}: ${(plan.samples / SAMPLE_RATE).toFixed(1)} s, ${plan.placements.length} utterances ` +
          `(${words} words), rt60 ${plan.rt60} s, peak ${peak.toFixed(3)}`,
      );
    }
  }
  return files;
}

async function main(argv: string[]): Promise<void> {
  const t0 = performance.now();
  const elapsed = (): string => `${((performance.now() - t0) / 1000).toFixed(1)} s`;
  const { subset, mode } = parseArgs(argv);
  const outputs = renderSubset(subset, loadCorpus(), (line) => console.log(`${line}, ${elapsed()} elapsed`));
  mkdirSync(CORPUS_DIR, { recursive: true });
  const generated: Record<string, string> = {};
  for (const { name, bytes } of outputs) {
    writeFileSync(join(CORPUS_DIR, name), bytes);
    generated[name] = sha256(bytes);
  }
  let failed = false;
  if (mode === 'check') {
    const recorded = parseHashes(JSON.parse(readFileSync(HASHES_PATH, 'utf8')));
    const problems = compareHashes(subset, generated, recorded);
    for (const p of problems) console.error(`MISMATCH ${p}`);
    failed = problems.length > 0;
    console.log(
      failed
        ? `check failed: ${problems.length} mismatch(es)`
        : `check passed: ${Object.keys(generated).length} files match`,
    );
  } else if (mode === 'write-hashes') {
    let recorded: Record<string, string> = {};
    if (subset !== 'full' && existsSync(HASHES_PATH)) {
      recorded = parseHashes(JSON.parse(readFileSync(HASHES_PATH, 'utf8')));
    }
    const merged = mergeHashes(subset, generated, recorded);
    const config = (await resolveConfig(HASHES_PATH)) ?? {};
    writeFileSync(HASHES_PATH, await format(JSON.stringify(merged), { ...config, filepath: HASHES_PATH }));
    console.log(`wrote ${Object.keys(merged).length} hashes to test/corpus/mix-hashes.json`);
  }
  console.log(`${subset}: ${outputs.length / 2} scenes, ${outputs.length} files in ${elapsed()}`);
  if (failed) process.exitCode = 1;
}

if (import.meta.main) await main(process.argv.slice(2));
