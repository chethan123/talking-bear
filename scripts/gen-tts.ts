// Clean text-to-speech regression speech for the M2 VAD corpus (plan §7 M2, issue #50). Every text in
// test/corpus/texts.json is rendered twice by espeak-ng, then resampled to 16 kHz, trimmed, peak-normalised to
// −6 dBFS and labelled from the clean signal. The noise mixes are built from these files later (gen-corpus.ts).
//
// espeak-ng (GPL-3.0) runs once, on a dev machine or in the pinned container scripts/tts/Dockerfile. Its output is
// committed; it is never bundled and never a CI dependency (plan §8 "Tools", §11). No real voices (plan Q2).
//
// Usage:
//   node scripts/gen-tts.ts                   espeak-ng from PATH (a local install)
//   node scripts/gen-tts.ts --docker <image>  espeak-ng in an image built from scripts/tts/Dockerfile
//
// Writes test/corpus/speech/*.wav, test/corpus/speech/manifest.json and test/corpus/PROVENANCE.md. The WAVs and
// the manifest are byte-identical on every run with the same espeak-ng build.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import { resampleOffline } from '../src/dsp/resample.ts';
import { readWav, writeWav } from '../test/wav.ts';

/** The repository root: the parent of scripts/. */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const TEXTS_PATH = join(REPO_ROOT, 'test/corpus/texts.json');
export const SPEECH_DIR = join(REPO_ROOT, 'test/corpus/speech');
export const MANIFEST_PATH = join(SPEECH_DIR, 'manifest.json');
export const PROVENANCE_PATH = join(REPO_ROOT, 'test/corpus/PROVENANCE.md');
export const DOCKERFILE_PATH = join(REPO_ROOT, 'scripts/tts/Dockerfile');

export const VOICES = ['en-us', 'en-gb', 'en-us+f2', 'en-us+f4', 'en-gb+m3', 'en-us+whisper'] as const;
export type Voice = (typeof VOICES)[number];
export const PITCHES = [30, 50, 80, 99] as const;
export const SPEEDS = [130, 175, 220] as const;

/**
 * The `-v` argument for each voice. espeak-ng 1.51 silently drops a variant written after `en-gb` (`-v en-gb+m3`
 * renders byte-identically to `-v en-gb`), so `en-gb+m3` is passed as `gmw/en+m3`: `gmw/en` names the voice file
 * that `en-gb` selects (byte-identical output) and keeps the variant.
 */
export const VOICE_ARGS: Readonly<Record<Voice, string>> = {
  'en-us': 'en-us',
  'en-gb': 'en-gb',
  'en-us+f2': 'en-us+f2',
  'en-us+f4': 'en-us+f4',
  'en-gb+m3': 'gmw/en+m3',
  'en-us+whisper': 'en-us+whisper',
};

/** espeak-ng writes 22.05 kHz mono PCM16. */
export const ESPEAK_RATE = 22_050;
export const SAMPLE_RATE = 16_000;
const SAMPLES_PER_MS = SAMPLE_RATE / 1000;
export const PEAK_DBFS = -6;
/** Label hop: 10 ms. */
export const HOP = 160;
/** Speech is every hop strictly above (max hop dB − THRESHOLD_DB). */
export const THRESHOLD_DB = 35;
/** Gaps shorter than this are merged, per kind. */
export const MERGE_GAP_MS = { word: 150, sentence: 150, passage: 300 } as const;
/** Runs shorter than this are dropped (after merging). */
export const MIN_RUN_MS = 50;
/** Sentences are under 3 s. */
export const MAX_SENTENCE_SAMPLES = 3 * SAMPLE_RATE;
/** test/corpus/speech/ must stay within 8 MB (taken as 8 000 000 bytes, which also satisfies 8 MiB). */
export const SIZE_BUDGET_BYTES = 8_000_000;

export const KINDS = ['word', 'sentence', 'passage'] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_COUNTS: Readonly<Record<Kind, number>> = { word: 30, sentence: 20, passage: 4 };
/** A half-open [start, end) speech span in samples. */
export type Span = [start: number, end: number];

export interface Texts {
  words: string[];
  sentences: string[];
  passages: string[];
}

/** One espeak-ng render: text `t` (global index) rendered for the `r`-th time. */
export interface Render {
  id: string;
  kind: Kind;
  text: string;
  voice: Voice;
  pitch: number;
  speed: number;
}

export interface ManifestEntry extends Render {
  /** The WAV's file name, relative to the manifest's directory. */
  file: string;
  samples: number;
  spans: Span[];
}

/** The (voice, pitch, speed) of global render index g = 2·t + r. */
export function combo(g: number): { voice: Voice; pitch: number; speed: number } {
  return {
    voice: VOICES[g % VOICES.length]!,
    pitch: PITCHES[(g >> 1) % PITCHES.length]!,
    speed: SPEEDS[(g >> 2) % SPEEDS.length]!,
  };
}

/** Throws unless `value` has the texts.json shape: exactly 30 words, 20 sentences and 4 passages. */
export function parseTexts(value: unknown): Texts {
  const lists: Record<Kind, string[]> = { word: [], sentence: [], passage: [] };
  const keys: Record<Kind, keyof Texts> = { word: 'words', sentence: 'sentences', passage: 'passages' };
  if (typeof value !== 'object' || value === null) throw new Error('texts.json: expected an object');
  for (const kind of KINDS) {
    const list: unknown = Reflect.get(value, keys[kind]);
    if (!Array.isArray(list) || list.length !== KIND_COUNTS[kind]) {
      throw new Error(`texts.json: ${keys[kind]} must be an array of ${KIND_COUNTS[kind]} strings`);
    }
    for (const text of list) {
      // A leading '-' would be read as an espeak-ng option.
      if (typeof text !== 'string' || text.trim() !== text || text === '' || text.startsWith('-')) {
        throw new Error(`texts.json: invalid ${kind} ${JSON.stringify(text)}`);
      }
      lists[kind].push(text);
    }
  }
  return { words: lists.word, sentences: lists.sentence, passages: lists.passage };
}

/**
 * Every render in manifest order: words, then sentences, then passages (texts.json order), each text twice.
 * The text index t runs over all 54 texts, so render r of text t has the global index g = 2·t + r.
 */
export function planRenders(texts: Texts): Render[] {
  const items: { kind: Kind; text: string; index: number }[] = [
    ...texts.words.map((text, index) => ({ kind: 'word' as const, text, index })),
    ...texts.sentences.map((text, index) => ({ kind: 'sentence' as const, text, index })),
    ...texts.passages.map((text, index) => ({ kind: 'passage' as const, text, index })),
  ];
  return items.flatMap(({ kind, text, index }, t) =>
    [0, 1].map((r) => ({
      id: `${kind}-${String(index).padStart(2, '0')}-r${r}`,
      kind,
      text,
      ...combo(2 * t + r),
    })),
  );
}

const isKind = (v: unknown): v is Kind => KINDS.some((k) => k === v);
const isVoice = (v: unknown): v is Voice => VOICES.some((k) => k === v);
const isInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isSpan = (v: unknown): v is Span => Array.isArray(v) && v.length === 2 && v.every(isInteger);

/** Throws unless `value` is a manifest.json array; returns its entries. */
export function parseManifest(value: unknown): ManifestEntry[] {
  if (!Array.isArray(value)) throw new Error('manifest.json: expected an array');
  return value.map((item: unknown, i) => {
    const get = (key: string): unknown =>
      typeof item === 'object' && item !== null ? Reflect.get(item, key) : undefined;
    const [id, file, kind, text, voice, pitch, speed, samples, spans] = [
      'id',
      'file',
      'kind',
      'text',
      'voice',
      'pitch',
      'speed',
      'samples',
      'spans',
    ].map(get);
    if (
      typeof id !== 'string' ||
      typeof file !== 'string' ||
      !isKind(kind) ||
      typeof text !== 'string' ||
      !isVoice(voice) ||
      !isInteger(pitch) ||
      !isInteger(speed) ||
      !isInteger(samples) ||
      !Array.isArray(spans) ||
      !spans.every(isSpan)
    ) {
      throw new Error(`manifest.json: entry ${i} is malformed`);
    }
    return { id, file, kind, text, voice, pitch, speed, samples, spans: spans.map(([s, e]): Span => [s, e]) };
  });
}

/** True when `v` writes as PCM16 0 (`writeWav` rounds half away from zero): digital silence in the output. */
export function isDigitalSilence(v: number): boolean {
  return Math.abs(v) * 32768 < 0.5;
}

/**
 * espeak's 22.05 kHz signal → 16 kHz with `resampleOffline`, trimmed of its leading and trailing digital silence
 * (samples that would write as PCM16 0 at the output gain), peak-normalised to −6 dBFS. No padding is added.
 */
export function postProcess(x: Float32Array): Float32Array {
  const y = resampleOffline(x, SAMPLE_RATE / ESPEAK_RATE);
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  if (!(peak > 0)) throw new Error('espeak-ng rendered digital silence');
  const gain = 10 ** (PEAK_DBFS / 20) / peak;
  const z = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) z[i] = y[i]! * gain;
  let start = 0;
  while (start < z.length && isDigitalSilence(z[start]!)) start++;
  let end = z.length;
  while (end > start && isDigitalSilence(z[end - 1]!)) end--;
  return z.slice(start, end);
}

/**
 * Speech spans of a clean 16 kHz signal: the energy (mean square) of each 10 ms hop of 160 samples (the last hop
 * may be shorter) in dB; speech is every hop strictly above (max hop dB − thresholdDb); runs of speech hops are
 * merged across gaps shorter than mergeGapMs, then runs shorter than minRunMs are dropped. Spans are half-open
 * [start, end) sample indices, hop-aligned, with the last end clamped to x.length.
 */
export function labelSpans(
  x: Float32Array,
  mergeGapMs: number,
  thresholdDb = THRESHOLD_DB,
  minRunMs = MIN_RUN_MS,
): Span[] {
  const hops = Math.ceil(x.length / HOP);
  const db = new Float64Array(hops);
  let max = -Infinity;
  for (let h = 0; h < hops; h++) {
    const from = h * HOP;
    const to = Math.min(x.length, from + HOP);
    let sum = 0;
    for (let i = from; i < to; i++) sum += x[i]! * x[i]!;
    db[h] = 10 * Math.log10(sum / (to - from));
    if (db[h]! > max) max = db[h]!;
  }
  const floor = max - thresholdDb;
  const runs: Span[] = [];
  for (let h = 0; h < hops; h++) {
    if (!(db[h]! > floor)) continue;
    const start = h * HOP;
    const end = Math.min(x.length, start + HOP);
    const last = runs.at(-1);
    if (last !== undefined && last[1] === start) last[1] = end;
    else runs.push([start, end]);
  }
  const mergeGap = mergeGapMs * SAMPLES_PER_MS;
  const merged: Span[] = [];
  for (const [start, end] of runs) {
    const last = merged.at(-1);
    if (last !== undefined && start - last[1] < mergeGap) last[1] = end;
    else merged.push([start, end]);
  }
  const minRun = minRunMs * SAMPLES_PER_MS;
  return merged.filter(([start, end]) => end - start >= minRun);
}

/** Post-processes one espeak-ng WAV and labels it: the committed PCM16 bytes and their manifest entry. */
export function processRender(
  render: Render,
  espeakWav: Uint8Array,
): { wav: Uint8Array; entry: ManifestEntry } {
  const { sampleRate, channels } = readWav(espeakWav);
  if (sampleRate !== ESPEAK_RATE || channels.length !== 1) {
    throw new Error(
      `${render.id}: expected ${ESPEAK_RATE} Hz mono from espeak-ng, got ${sampleRate} Hz × ${channels.length}`,
    );
  }
  const wav = writeWav([postProcess(channels[0]!)], SAMPLE_RATE, 'pcm16');
  // Labels come from the decoded file, exactly as committed, so they can be recomputed from it.
  const clean = readWav(wav).channels[0]!;
  const entry: ManifestEntry = {
    id: render.id,
    file: `${render.id}.wav`,
    kind: render.kind,
    text: render.text,
    voice: render.voice,
    pitch: render.pitch,
    speed: render.speed,
    samples: clean.length,
    spans: labelSpans(clean, MERGE_GAP_MS[render.kind]),
  };
  return { wav, entry };
}

/** Runs a command and returns its stdout; throws with its stderr if it fails. */
function run(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error !== undefined) throw new Error(`${cmd}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}: ${res.stderr}`);
  return res.stdout;
}

/** `Package Version Architecture` for each stanza of `dpkg -s` output. */
export function parseDpkgStatus(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((stanza) => {
      const field = (name: string): string => new RegExp(`^${name}: (.*)$`, 'm').exec(stanza)?.[1] ?? '?';
      return `${field('Package')} ${field('Version')} ${field('Architecture')}`;
    })
    .filter((line) => line !== '? ? ?');
}

const PACKAGES = ['espeak-ng', 'libespeak-ng1', 'espeak-ng-data'];

/** When the Dockerfile's base digest and package pins were resolved (they are unverified until the first build). */
export const DOCKER_PINS_RESOLVED = '2026-10-01';

/**
 * The base image and the espeak-ng package pins (`name=version`, in file order) of scripts/tts/Dockerfile, ignoring
 * comment lines; throws if the base or the espeak-ng pin is missing.
 */
export function parseDockerfile(text: string): { from: string; pins: string[]; espeakVersion: string } {
  const code = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const from = /^FROM\s+(\S+)/m.exec(code)?.[1];
  const pins = [...code.matchAll(/\b(espeak-ng|libespeak-ng1|espeak-ng-data)=([^\s\\]+)/g)].map(
    ([, name, version]) => `${name}=${version}`,
  );
  const espeakVersion = pins.find((pin) => pin.startsWith('espeak-ng='))?.slice('espeak-ng='.length);
  if (from === undefined || espeakVersion === undefined) {
    throw new Error('scripts/tts/Dockerfile: expected a FROM line and an espeak-ng=<version> pin');
  }
  return { from, pins, espeakVersion };
}

interface Espeak {
  /** Renders `text` and returns the WAV bytes espeak-ng wrote. */
  render(voiceArg: string, pitch: number, speed: number, text: string): Uint8Array;
  /** Provenance lines describing the espeak-ng build. */
  describe(): string[];
}

/** espeak-ng from PATH. */
function localEspeak(work: string): Espeak {
  const out = join(work, 'out.wav');
  return {
    render(voiceArg, pitch, speed, text) {
      run('espeak-ng', ['-v', voiceArg, '-p', String(pitch), '-s', String(speed), '-w', out, text]);
      return readFileSync(out);
    },
    describe() {
      let packages: string[];
      try {
        packages = parseDpkgStatus(run('dpkg', ['-s', ...PACKAGES]));
      } catch {
        packages = ['(dpkg is not available)'];
      }
      let os = '(unknown)';
      try {
        os = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? os;
      } catch {
        // Not Linux: keep "(unknown)".
      }
      return [
        `espeak-ng --version: \`${run('espeak-ng', ['--version']).trim()}\``,
        'Install: **local install** (`apt-get install -y --no-install-recommends espeak-ng`), not the Docker image',
        `OS packages (\`dpkg -s ${PACKAGES.join(' ')}\`): ${packages.map((p) => `\`${p}\``).join(', ')}`,
        `OS: ${os} (${process.arch})`,
      ];
    },
  };
}

/** The arguments of `docker run --rm --network none <args>`. */
function dockerRun(args: string[]): string[] {
  return ['run', '--rm', '--network', 'none', ...args];
}

/** espeak-ng in a container built from scripts/tts/Dockerfile (its entrypoint is espeak-ng). */
function dockerEspeak(work: string, image: string): Espeak {
  return {
    render(voiceArg, pitch, speed, text) {
      const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
      run(
        'docker',
        dockerRun([
          '--user',
          user,
          '-v',
          `${work}:/work`,
          image,
          '-v',
          voiceArg,
          '-p',
          String(pitch),
          '-s',
          String(speed),
          '-w',
          '/work/out.wav',
          text,
        ]),
      );
      return readFileSync(join(work, 'out.wav'));
    },
    describe() {
      const packages = parseDpkgStatus(
        run('docker', dockerRun(['--entrypoint', 'dpkg', image, '-s', ...PACKAGES])),
      );
      return [
        `espeak-ng --version: \`${run('docker', dockerRun([image, '--version'])).trim()}\``,
        `Install: **Docker image** \`${image}\` (image ID \`${run('docker', ['image', 'inspect', '--format', '{{.Id}}', image]).trim()}\`) built from \`scripts/tts/Dockerfile\``,
        `Image packages (\`dpkg -s ${PACKAGES.join(' ')}\`): ${packages.map((p) => `\`${p}\``).join(', ')}`,
      ];
    },
  };
}

/** Prettier-formats `text` as the file at `path` would be, so `pnpm format:check` accepts the output as is. */
async function prettierFormat(text: string, path: string): Promise<string> {
  const config = (await resolveConfig(path)) ?? {};
  return format(text, { ...config, filepath: path });
}

interface ProvenanceInput {
  date: string;
  argv: string[];
  espeak: string[];
  docker: boolean;
  dockerfile: { from: string; pins: string[]; espeakVersion: string };
  entries: ManifestEntry[];
  totalBytes: number;
}

function seconds(samples: number): string {
  return (samples / SAMPLE_RATE).toFixed(2);
}

/** test/corpus/PROVENANCE.md (before Prettier). */
export function provenanceMarkdown(p: ProvenanceInput): string {
  const kinds = KINDS.map((kind) => {
    const lengths = p.entries.filter((e) => e.kind === kind).map((e) => e.samples);
    return `- ${kind}: ${lengths.length} files, ${seconds(Math.min(...lengths))}–${seconds(Math.max(...lengths))} s`;
  });
  const command = ['node scripts/gen-tts.ts', ...p.argv].join(' ');
  const { from, pins, espeakVersion } = p.dockerfile;
  const container = `\`scripts/tts/Dockerfile\` pins \`FROM ${from}\` and ${pins.map((pin) => `\`${pin}\``).join(', ')}`;
  return [
    '# TTS regression speech: provenance',
    '',
    'Generated by `scripts/gen-tts.ts` (T39, issue #50): the clean-speech half of the M2 VAD regression corpus',
    '(plan §7 M2). Every voice is synthetic (espeak-ng); no real voice is involved (plan Q2).',
    '',
    '## Generation',
    '',
    `- Date (UTC): ${p.date}`,
    ...p.espeak.map((line) => `- ${line}`),
    `- Node: ${process.version}`,
    `- Command: \`${command}\``,
    '- Per render: `espeak-ng -v <voice argument> -p <pitch> -s <speed> -w out.wav "<text>"`',
    p.docker
      ? `- Container: ${container}`
      : `- Container (not used for these files): ${container}; resolved ${DOCKER_PINS_RESOLVED}: digest from ` +
        'registry-1.docker.io; package version from secondary sources because the Debian archive was unreachable ' +
        'from the agent sandbox; the image has not been built. Verify on first `docker build` ' +
        `(\`docker run --rm --entrypoint dpkg <image> -s espeak-ng\` must report ${espeakVersion}).`,
    '',
    ...(p.docker
      ? []
      : [
          'The committed files were rendered by the local install above (no Docker daemon in the agent sandbox), not',
          "by `scripts/tts/Dockerfile`, which pins Debian trixie's espeak-ng, a different version. espeak-ng output is",
          'deterministic per build but differs between versions, so regenerating with the image changes every WAV and',
          'label. Regenerate the whole corpus with one build; never mix builds.',
          '',
        ]),
    '## Renders',
    '',
    '`test/corpus/texts.json` holds 30 words, 20 sentences and 4 passages, all written for this corpus. Each text is',
    'rendered twice. Texts are numbered t = 0…53 in file order (words, sentences, passages); render r ∈ {0, 1} of',
    'text t has the global index g = 2·t + r and uses `voices[g % 6]`, `pitches[(g >> 1) % 4]`, `speeds[(g >> 2) % 3]`:',
    '',
    `- voices: ${VOICES.map((v) => `\`${v}\``).join(', ')}`,
    `- pitches (\`-p\`): ${PITCHES.join(', ')} (99 is the "child-like" proxy, not a child's voice)`,
    `- speeds (\`-s\`, words per minute): ${SPEEDS.join(', ')}`,
    '',
    `The voice argument is the voice name, except \`en-gb+m3\`, which is passed as \`-v ${VOICE_ARGS['en-gb+m3']}\`:`,
    'espeak-ng 1.51 drops a variant written after `en-gb` (`-v en-gb+m3` renders byte-identically to `-v en-gb`),',
    'while `gmw/en` names the voice file that `en-gb` selects and keeps the variant. The manifest records the voice',
    'name.',
    '',
    '## Post-processing (Node)',
    '',
    "1. Read espeak-ng's 22.05 kHz mono WAV and resample it to 16 kHz with `resampleOffline` (`src/dsp/resample.ts`).",
    '2. Trim the leading and trailing digital silence: every sample that would write as PCM16 0 at the output gain.',
    '3. Peak-normalise to −6 dBFS.',
    '4. Write PCM16 mono 16 kHz with no lead or tail padding (the mixer adds it).',
    '',
    '## Labels',
    '',
    'Labels come from the clean signal, as committed (the decoded PCM16): the energy of each 10 ms hop (160 samples,',
    'mean square, in dB); speech is every hop above (max hop dB − 35 dB); gaps shorter than 150 ms (words and',
    'sentences) or 300 ms (passages) are merged, then runs shorter than 50 ms are dropped. Spans are half-open',
    '`[start, end)` sample indices at 16 kHz.',
    '',
    '## Files',
    '',
    '`speech/manifest.json` lists every render in order:',
    '`{ id, file, kind, text, voice, pitch, speed, samples, spans: [[start, end], …] }`, with `file` relative to',
    '`speech/`.',
    '',
    `- ${p.entries.length} WAV files, ${p.totalBytes} bytes in \`test/corpus/speech/\` with the manifest (budget: ${SIZE_BUDGET_BYTES} bytes)`,
    ...kinds,
    '',
    '## Licence',
    '',
    'espeak-ng is GPL-3.0. Program output is generally not covered by the GPL (plan §11); the tool is never bundled',
    'with the app or run in CI.',
    '',
  ].join('\n');
}

function parseArgs(argv: string[]): { docker?: string } {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === '--docker' && argv[1] !== undefined && argv[1] !== '')
    return { docker: argv[1] };
  throw new Error('usage: node scripts/gen-tts.ts [--docker <image>]');
}

async function main(argv: string[]): Promise<void> {
  const { docker } = parseArgs(argv);
  const dockerfile = parseDockerfile(readFileSync(DOCKERFILE_PATH, 'utf8'));
  const renders = planRenders(parseTexts(JSON.parse(readFileSync(TEXTS_PATH, 'utf8'))));
  const work = mkdtempSync(join(tmpdir(), 'gen-tts-'));
  try {
    const espeak = docker === undefined ? localEspeak(work) : dockerEspeak(work, docker);
    const outputs = renders.map((render) => {
      const out = processRender(
        render,
        espeak.render(VOICE_ARGS[render.voice], render.pitch, render.speed, render.text),
      );
      if (render.kind === 'sentence' && out.entry.samples >= MAX_SENTENCE_SAMPLES) {
        throw new Error(`${render.id}: ${seconds(out.entry.samples)} s; sentences must be under 3 s`);
      }
      return out;
    });
    const entries = outputs.map((o) => o.entry);
    const manifest = await prettierFormat(JSON.stringify(entries), MANIFEST_PATH);
    const totalBytes = outputs.reduce((sum, o) => sum + o.wav.length, Buffer.byteLength(manifest));
    if (totalBytes > SIZE_BUDGET_BYTES) {
      throw new Error(
        `test/corpus/speech would be ${totalBytes} bytes, over the ${SIZE_BUDGET_BYTES}-byte budget`,
      );
    }
    mkdirSync(SPEECH_DIR, { recursive: true });
    const files = new Set(entries.map((e) => e.file));
    for (const name of readdirSync(SPEECH_DIR)) {
      if (name.endsWith('.wav') && !files.has(name)) rmSync(join(SPEECH_DIR, name));
    }
    for (const { wav, entry } of outputs) writeFileSync(join(SPEECH_DIR, entry.file), wav);
    writeFileSync(MANIFEST_PATH, manifest);
    const provenance = provenanceMarkdown({
      date: new Date().toISOString().slice(0, 10),
      argv,
      espeak: espeak.describe(),
      docker: docker !== undefined,
      dockerfile,
      entries,
      totalBytes,
    });
    writeFileSync(PROVENANCE_PATH, await prettierFormat(provenance, PROVENANCE_PATH));
    console.log(
      `wrote ${entries.length} WAVs (${totalBytes} bytes with the manifest), manifest.json and PROVENANCE.md`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) await main(process.argv.slice(2));
