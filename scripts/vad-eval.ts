// Offline VAD evaluation harness (plan §7 M2 "Harness"; issue #53). It runs the same modules as production:
// - TTS corpus scenes (.cache/corpus/, from `pnpm corpus`) through the DSP worker's VadCore, Silero with the
//   shipped weights.bin (or the energy backend with --backend energy), re-armed after every end or misfire;
// - real-voice feature traces (test/traces/<session>/trace.{json,bin}) replayed through energyGateStep /
//   segmenterStep and the proximity gate (scripts/trace-replay.ts).
// It prints a table per scene and a pooled table (scripts/vad-metrics.ts), and with --gate tts enforces the CI TTS
// regression gate. The espeak-ng whisper renders (UNGATED_VOICES) are reported in their own column and row, never
// gated (#53 Q1, answer A).
//
// Usage:
//   node scripts/vad-eval.ts [--corpus fast|full] [--traces <dir>] [--backend silero|energy] [--gate tts]
//                            [--json <path>]
//     --corpus fast|full   the corpus scenes of that group (planCorpus(subset).group === subset: the full corpus
//                          contains the fast-* scenes, which a full pooled metric must not count twice)
//     --traces <dir>       every trace.json (with its trace.bin) under <dir>, recursively; reported, not gated
//     --backend            silero (default) or energy
//     --gate tts           exit 1 unless the corpus passes the TTS gate (needs --corpus)
//     --json <path>        also write a machine-readable report
// Exit codes: 0 done (and the gate passed); 1 the gate failed, or an error; 2 bad arguments.
//
// Running a corpus scene mirrors the app (plan §3.1, §3.4): 512-sample frames at 16 kHz tagged with synthetic ctx
// frames (ctxRate 48000, firstFrame i·1536) are fed to VadCore after one reset (epoch 1) at the scene start. After
// every `end` or `misfire` the feed stops (the session disarms) and the core is reset again, as the next listen,
// 250 ms (the session cooldown) after the event frame: epoch + 1, the same backend, restoreFloorDb from the last
// floorSnapshot, the production pre-gate setting and the default proximity X. Scenes may exceed ±1 (the corpus keeps
// the exact SNR): samples are used as they are, never clamped.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// The first Node script to import from src/app: events.ts must stay plain-Node runnable (`.ts` relative imports,
// erasable syntax only), because CI's fast TTS gate runs this script with Node's type stripping.
import { DEFAULT_CONFIG } from '../src/app/events.ts';
import { PREGATE_ENABLED, PROXIMITY_DB, VAD_FRAME, VAD_RATE } from '../src/audio/constants.ts';
import type { WorkerToMain } from '../src/audio/messages.ts';
import { SILERO_SEG_PARAMS, ENERGY_SEG_PARAMS } from '../src/dsp/segmenter.ts';
import { createSilero, type SileroModel } from '../src/dsp/silero/model.ts';
import { decodeWeights, WEIGHTS_SHA256 } from '../src/dsp/silero/weights.ts';
import { frontEndHash } from '../src/vad-trace/format.ts';
import { VadCore } from '../src/workers/vad-core.ts';
import { planCorpus, type ScenePlan, type SceneMeta, type Subset, SUBSETS } from './corpus-lib.ts';
import { CORPUS_DIR } from './gen-corpus.ts';
import { MANIFEST_PATH, REPO_ROOT, parseManifest } from './gen-tts.ts';
import { loadTrace, partitionStale, replayTrace, traceTruth } from './trace-replay.ts';
import {
  corpusTruth,
  evaluateScene,
  FT_GATE_REQUIRED,
  poolMetrics,
  TTS_GATE_SNRS,
  ttsGate,
  type CorpusLabels,
  type GateResult,
  type Metrics,
  type Segment,
  type ShortCounts,
} from './vad-metrics.ts';

/** Synthetic context rate of the corpus scenes (the common Android rate). */
export const EVAL_CTX_RATE = 48000;
/** Re-arm delay after an end or misfire: the session cooldown (plan §3.4). */
export const REARM_MS = DEFAULT_CONFIG.cooldownMs;
/**
 * Voices whose short phrases are reported but never gated: Silero v6 scores most espeak-ng whisper renders below
 * 0.5 even clean (#53 Q1, answer A). They stay truth for false triggers and truncation.
 */
export const UNGATED_VOICES: readonly string[] = ['en-us+whisper'];
const WEIGHTS_BIN = join(REPO_ROOT, 'src', 'dsp', 'silero', 'weights.bin');

export type Backend = 'silero' | 'energy';

/** The shipped Silero model: weights.bin decoded as the worker decodes it. */
export function loadShippedSilero(): SileroModel {
  const bytes = readFileSync(WEIGHTS_BIN);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return createSilero(decodeWeights(buf));
}

export interface RunOptions {
  /** Context rate of the synthetic timeline (default EVAL_CTX_RATE). */
  ctxRate?: number;
  /** Builds the core (default `new VadCore(ctxRate, post, { now: () => 0 })`); tests pass a spy. */
  createCore?: (ctxRate: number, post: (m: WorkerToMain) => void) => VadCore;
}

/**
 * Runs 16 kHz audio through a fresh VadCore as the app would (see the header) and returns its segments in ctx
 * frames, plus the evaluated length (whole 512-sample frames; a trailing partial frame is dropped). `model` is
 * required for the silero backend.
 */
export function runVadCore(
  audio: Float32Array,
  backend: Backend,
  model: SileroModel | null,
  opts: RunOptions = {},
): { segments: Segment[]; durationFrames: number } {
  if (backend === 'silero' && model === null) throw new Error('the silero backend needs a model');
  const ctxRate = opts.ctxRate ?? EVAL_CTX_RATE;
  const frameCtx = (VAD_FRAME * ctxRate) / VAD_RATE;
  const rearmCtx = (REARM_MS * ctxRate) / 1000;
  const segments: Segment[] = [];
  let epoch = 1;
  /** The last floorSnapshot of the current listen; undefined until the first one. */
  let floorDb: number | undefined;
  /** Start frame of the open segment, or null. */
  let openStart: number | null = null;
  /** Ctx frame at which the next listen is armed, once the current one has ended; null while listening. */
  let rearmAt: number | null = null;
  const post = (m: WorkerToMain): void => {
    if (m.t === 'error') throw new Error(`VadCore: ${m.message}`); // a model failure or a missing model
    if (rearmAt !== null) return; // disarmed: the session ignores the rest of the frame
    if (m.t === 'floorSnapshot' && m.epoch === epoch) floorDb = m.floorDb;
    if (m.t !== 'seg' || m.epoch !== epoch) return;
    const ev = m.ev;
    if (ev.kind === 'start') {
      openStart = ev.frame;
      return;
    }
    if (openStart === null) throw new Error(`VadCore: ${ev.kind} at ${ev.frame} without a start`);
    segments.push(
      ev.kind === 'end'
        ? {
            startFrame: openStart,
            lastSpeechFrame: ev.lastSpeechFrame,
            endFrame: ev.frame,
            reason: ev.reason,
          }
        : { startFrame: openStart, lastSpeechFrame: null, endFrame: ev.frame, reason: 'misfire' },
    );
    openStart = null;
    rearmAt = ev.frame + rearmCtx;
  };
  const core =
    opts.createCore === undefined
      ? new VadCore(ctxRate, post, { now: () => 0 })
      : opts.createCore(ctxRate, post);
  if (model !== null) core.setModel(model);
  core.reset(epoch, backend, undefined, PREGATE_ENABLED);
  const frames = Math.floor(audio.length / VAD_FRAME);
  for (let i = 0; i < frames; i++) {
    const firstFrame = i * frameCtx;
    if (rearmAt !== null) {
      if (firstFrame < rearmAt) continue;
      epoch++;
      core.reset(epoch, backend, floorDb, PREGATE_ENABLED);
      rearmAt = null;
    }
    core.frame(epoch, firstFrame, audio.subarray(i * VAD_FRAME, (i + 1) * VAD_FRAME));
  }
  const durationFrames = frames * frameCtx;
  if (openStart !== null) {
    segments.push({ startFrame: openStart, lastSpeechFrame: null, endFrame: durationFrames, reason: 'open' });
  }
  return { segments, durationFrames };
}

/** The sidecar fields the harness uses. */
export type SceneLabels = CorpusLabels & { samples: number };

function isSpan(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((x) => Number.isSafeInteger(x));
}

function isKind(v: unknown): v is SceneMeta['kinds'][number] {
  return v === 'word' || v === 'sentence' || v === 'passage';
}

/** Checks a `<scene>.json` sidecar; throws naming the scene when a field the harness uses is malformed. */
export function parseSceneMeta(value: unknown, name: string): SceneLabels {
  const get = (key: string): unknown =>
    typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  const [sampleRate, samples, spans, kinds, ids] = ['sampleRate', 'samples', 'spans', 'kinds', 'ids'].map(
    get,
  );
  if (
    typeof sampleRate !== 'number' ||
    !Number.isSafeInteger(samples) ||
    typeof samples !== 'number' ||
    !Array.isArray(spans) ||
    !spans.every(isSpan) ||
    !Array.isArray(kinds) ||
    !kinds.every(isKind) ||
    !Array.isArray(ids) ||
    !ids.every((id) => typeof id === 'string') ||
    kinds.length !== spans.length ||
    ids.length !== spans.length
  ) {
    throw new Error(`${name}.json: malformed sidecar; run pnpm corpus again`);
  }
  return { sampleRate, samples, spans, kinds, ids };
}

function corpusEntries(): ReturnType<typeof parseManifest> {
  return parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
}

/** Whether an utterance's short phrases are gated: false for UNGATED_VOICES; throws for an unknown id. */
export function gatedByVoice(entries: ReturnType<typeof parseManifest>): (id: string) => boolean {
  const voiceOf = new Map(entries.map((e) => [e.id, e.voice]));
  return (id) => {
    const voice = voiceOf.get(id);
    if (voice === undefined) throw new Error(`unknown utterance ${id}`);
    return !UNGATED_VOICES.includes(voice);
  };
}

/** A scene's samples and sidecar from .cache/corpus/, checked against its plan. */
function loadScene(plan: ScenePlan): { audio: Float32Array; meta: SceneLabels } {
  const f32 = join(CORPUS_DIR, `${plan.name}.f32`);
  const json = join(CORPUS_DIR, `${plan.name}.json`);
  if (!existsSync(f32) || !existsSync(json)) {
    throw new Error(`${plan.name}: not in .cache/corpus; run pnpm corpus --subset ${plan.group} first`);
  }
  const meta = parseSceneMeta(JSON.parse(readFileSync(json, 'utf8')), plan.name);
  const bytes = readFileSync(f32);
  if (
    meta.samples !== plan.samples ||
    bytes.byteLength !== 4 * plan.samples ||
    meta.sampleRate !== VAD_RATE
  ) {
    throw new Error(`${plan.name}: stale or truncated; run pnpm corpus --subset ${plan.group} again`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const audio = new Float32Array(plan.samples);
  for (let i = 0; i < audio.length; i++) audio[i] = view.getFloat32(4 * i, true);
  return { audio, meta };
}

export interface SceneRow {
  name: string;
  kind: 'scene' | 'trace';
  type: ScenePlan['type'] | 'trace';
  noise: string;
  snrDb: number | null;
  metrics: Metrics;
  segments: Segment[];
}

// ---------------------------------------------------------------------------------------------------------------
// Report

const fmt = (v: number | null, digits = 0): string => (v === null ? '-' : v.toFixed(digits));

const COLUMNS = [
  'name',
  'min',
  'N',
  'hit',
  'miss',
  'split',
  'trunc',
  'cap',
  'misfire',
  'FT',
  'FT/min',
  'EoS p50',
  'EoS p90',
  'whisper h/m/s',
] as const;

/** The ungated (whisper) counts as hits/misses/splits, or '-' when there are none. */
function ungatedCell(u: ShortCounts): string {
  return u.shortPhrases === 0 ? '-' : `${u.hits}/${u.misses}/${u.splits}`;
}

function row(name: string, m: Metrics): string[] {
  return [
    name,
    fmt(m.minutes, 1),
    String(m.shortPhrases),
    String(m.hits),
    String(m.misses),
    String(m.splits),
    `${m.truncations}/${m.truncChecked}`,
    String(m.capEnds),
    String(m.misfires),
    String(m.falseTriggers),
    fmt(m.falseTriggersPerMin, 3),
    fmt(m.eosP50Ms),
    fmt(m.eosP90Ms),
    ungatedCell(m.ungated),
  ];
}

/** A row of ungated short-phrase counts only: N, hit, miss and split; '-' elsewhere. */
function ungatedRow(name: string, u: ShortCounts): string[] {
  const cells = COLUMNS.map((): string => '-');
  cells[0] = name;
  cells[2] = String(u.shortPhrases);
  cells[3] = String(u.hits);
  cells[4] = String(u.misses);
  cells[5] = String(u.splits);
  return cells;
}

function table(rows: string[][]): string {
  const all = [[...COLUMNS], ...rows];
  const widths = COLUMNS.map((_, c) => Math.max(...all.map((r) => r[c]!.length)));
  return all
    .map((r) =>
      r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join('  '),
    )
    .join('\n');
}

/** The gate pool's row name: snr20+10+5. */
const GATE_POOL_ROW = `snr${TTS_GATE_SNRS.join('+')}`;

/** Pooled rows: per SNR level (20, 10, 5, 0), then the gate pool (TTS_GATE_SNRS). */
function pooledRows(scenes: readonly SceneRow[]): { name: string; metrics: Metrics }[] {
  const snr = scenes.filter((s) => s.type === 'snr');
  const out: { name: string; metrics: Metrics }[] = [];
  for (const level of [20, 10, 5, 0]) {
    const at = snr.filter((s) => s.snrDb === level);
    if (at.length > 0) out.push({ name: `snr${level}`, metrics: poolMetrics(at.map((s) => s.metrics)) });
  }
  const gate = snr.filter((s) => s.snrDb !== null && TTS_GATE_SNRS.includes(s.snrDb));
  if (gate.length > 0) out.push({ name: GATE_POOL_ROW, metrics: poolMetrics(gate.map((s) => s.metrics)) });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

const USAGE =
  'usage: node scripts/vad-eval.ts [--corpus fast|full] [--traces <dir>] [--backend silero|energy] ' +
  '[--gate tts] [--json <path>]';

export interface Args {
  corpus: Subset | null;
  traces: string | null;
  backend: Backend;
  gate: 'tts' | null;
  json: string | null;
}

/** Parses the command line; throws Error(USAGE) on anything invalid. */
export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { corpus: null, traces: null, backend: 'silero', gate: null, json: null };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    // A missing value, or a flag where the value should be (`--json --gate tts`), is a usage error.
    if (seen.has(flag) || value === undefined || value.startsWith('--')) throw new Error(USAGE);
    seen.add(flag);
    i++;
    if (flag === '--corpus') {
      const subset = SUBSETS.find((s) => s === value);
      if (subset === undefined) throw new Error(USAGE);
      args.corpus = subset;
    } else if (flag === '--traces') {
      args.traces = value;
    } else if (flag === '--backend') {
      if (value !== 'silero' && value !== 'energy') throw new Error(USAGE);
      args.backend = value;
    } else if (flag === '--gate') {
      if (value !== 'tts') throw new Error(USAGE);
      args.gate = value;
    } else if (flag === '--json') {
      args.json = value;
    } else {
      throw new Error(USAGE);
    }
  }
  if (args.corpus === null && args.traces === null) throw new Error(USAGE);
  if (args.gate === 'tts' && args.corpus === null) throw new Error(USAGE);
  return args;
}

/** Every directory under `dir` (itself included) that holds a trace.json, sorted. */
function traceDirs(dir: string): string[] {
  const out: string[] = [];
  if (existsSync(join(dir, 'trace.json'))) out.push(dir);
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' }).toSorted()) {
    if (name.endsWith('/trace.json') || name.endsWith('\\trace.json')) out.push(join(dir, name, '..'));
  }
  return out;
}

async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const t0 = performance.now();
  const model = args.backend === 'silero' ? loadShippedSilero() : null;
  const params = args.backend === 'silero' ? SILERO_SEG_PARAMS : ENERGY_SEG_PARAMS;
  console.log(
    `vad-eval: backend ${args.backend}, segmenter ${JSON.stringify(params)}, proximity X ${PROXIMITY_DB} dB, ` +
      `ctxRate ${EVAL_CTX_RATE}, re-arm ${REARM_MS} ms after each end/misfire`,
  );
  const scenes: SceneRow[] = [];
  if (args.corpus !== null) {
    const subset = args.corpus;
    const entries = corpusEntries();
    const isGated = gatedByVoice(entries);
    for (const plan of planCorpus(subset, entries).filter((p) => p.group === subset)) {
      const { audio, meta } = loadScene(plan);
      const { segments, durationFrames } = runVadCore(audio, args.backend, model);
      const metrics = evaluateScene({
        ctxRate: EVAL_CTX_RATE,
        durationFrames,
        truth: corpusTruth(meta, EVAL_CTX_RATE, isGated),
        segments,
      });
      scenes.push({
        name: plan.name,
        kind: 'scene',
        type: plan.type,
        noise: plan.noise,
        snrDb: plan.snrDb,
        metrics,
        segments,
      });
    }
  }
  const traces: SceneRow[] = [];
  /** Stale traces (plan §7 M2 "Stale traces"): reported and skipped, never replayed. #61 adds the gate policy. */
  const skippedTraces: { name: string; reason: 'frontEnd' | 'weights' }[] = [];
  if (args.traces !== null) {
    const loaded = traceDirs(args.traces).map((dir) => ({
      name: relative(REPO_ROOT, dir) || dir,
      ...loadTrace(dir),
    }));
    const { fresh, stale } = partitionStale(loaded, await frontEndHash(), WEIGHTS_SHA256);
    for (const { trace, reason } of stale) {
      console.log(`WARNING: ${trace.name} is stale (${reason}): skipped; re-record it (plan §7 M2)`);
      skippedTraces.push({ name: trace.name, reason });
    }
    for (const { name, meta, streams } of fresh) {
      const { segments, durationFrames } = replayTrace(meta, streams, { backend: args.backend });
      const metrics = evaluateScene({
        ctxRate: meta.ctxRate,
        durationFrames,
        truth: traceTruth(meta),
        segments,
      });
      traces.push({
        name,
        kind: 'trace',
        type: 'trace',
        noise: meta.condition,
        snrDb: null,
        metrics,
        segments,
      });
    }
  }
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  const pooled = pooledRows(scenes);
  const gate: GateResult | null =
    args.gate === 'tts' && args.corpus !== null ? ttsGate(scenes, FT_GATE_REQUIRED[args.corpus]) : null;
  if (scenes.length > 0) {
    console.log(`\nCorpus ${args.corpus}: per scene`);
    console.log(table(scenes.map((s) => row(s.name, s.metrics))));
    console.log(`\nCorpus ${args.corpus}: pooled`);
    const rows = pooled.map((p) => row(p.name, p.metrics));
    // The whisper row: the gate's own ungated counts, or (without --gate) the gate pool's.
    const whisper = gate?.ungated ?? pooled.find((p) => p.name === GATE_POOL_ROW)?.metrics.ungated;
    if (whisper !== undefined) rows.push(ungatedRow(`whisper ${GATE_POOL_ROW} (not gated)`, whisper));
    console.log(table(rows));
  }
  if (args.traces !== null) {
    console.log(
      `\nTraces under ${args.traces}: ${traces.length} replayed, ${skippedTraces.length} stale (skipped)`,
    );
    for (const t of skippedTraces) console.log(`  skipped: ${t.name} (stale: ${t.reason})`);
    if (traces.length > 0) {
      console.log(
        table([
          ...traces.map((t) => row(t.name, t.metrics)),
          row('pooled', poolMetrics(traces.map((t) => t.metrics))),
        ]),
      );
    }
  }
  if (gate !== null) {
    console.log('\nTTS gate');
    for (const c of gate.checks) {
      const status = c.pass ? 'PASS' : 'FAIL';
      console.log(
        c.scenes.length === 0
          ? `${status} ${c.name}`
          : `${status} ${c.name}: ${c.value} ${c.pass ? '≤' : '>'} ${c.limit} (${c.scenes.join(', ')})`,
      );
    }
    const u = gate.ungated;
    console.log(
      `INFO whisper (not gated, SNR 20/10/5): N ${u.shortPhrases}, hit ${u.hits}, miss ${u.misses}, ` +
        `split ${u.splits}`,
    );
    console.log(`gate tts: ${gate.pass ? 'PASS' : 'FAIL'}`);
  }
  console.log(`\nvad-eval: ${scenes.length} scenes, ${traces.length} traces in ${elapsed} s`);
  if (args.json !== null) {
    const report = {
      version: 1,
      backend: args.backend,
      segmenter: params,
      proximityDb: PROXIMITY_DB,
      ctxRate: EVAL_CTX_RATE,
      rearmMs: REARM_MS,
      ungatedVoices: UNGATED_VOICES,
      corpus: args.corpus,
      scenes,
      pooled,
      traces,
      skippedTraces,
      gate,
    };
    writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${args.json}`);
  }
  return gate === null || gate.pass ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`vad-eval: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
