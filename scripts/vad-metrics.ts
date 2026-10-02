// VAD evaluation metrics (plan §7 M2 "Harness", §4.2.3 end-of-speech latency; issue #53). Pure functions over
// segments and truth spans in ctx frames (context-rate sample indices), shared by scripts/vad-eval.ts (TTS corpus
// scenes run through VadCore, and replayed real-voice traces) and the grid search (#59).
//
// Conventions:
// - Every interval is half-open [start, end) in ctx frames; two intervals overlap iff aStart < bEnd and
//   bStart < aEnd, so intervals that only touch don't overlap.
// - A segment covers [startFrame, endFrame): from its `start` step to the step that ended it.
// - Only segments the app replies to count for overlaps: `silence` and `maxLength` ends, plus a segment still
//   `open` when the input ends. A `misfire` (too short, too far from the floor, or the energy backend's voicing
//   rule) never becomes a take, so it is counted on its own and is never a hit, a split or a false trigger.
// - A truth span is one utterance: the hull of its labelled spans (a corpus render can have 2), or a trace's
//   hold-to-talk press/release widened by TRACE_SPAN_PAD_MS on each side. `offset` is the true end of speech
//   (the corpus label end, or the trace release) that end-of-speech latency is measured against.
//
// Metrics (issue #53):
//   hit           a short-phrase span that overlaps exactly one segment
//   miss          a short-phrase span that overlaps no segment
//   split         a short-phrase span that overlaps ≥ 2 segments
//   truncation    a span (short phrase or passage) whose overlapping segments' latest lastSpeechFrame L has
//                 L + 150 ms < span end − 150 ms (the take, which ends at L + TAIL_MS, misses > 150 ms of speech)
//   EoS latency   endFrame − offset in ms, for every hit (plan §4.2.3: includes the hangover); p50 and p90
//   false trigger a segment that overlaps no span; reported per minute of evaluated audio
//   cap ends      segments that ended at the maximum utterance length (`maxLength`)
// Passages are used only for truncation and cap ends (plan §7 M2).

/** Why a segment ended: the segmenter's end reasons, `misfire`, or `open` (still in speech when the input ended). */
export type SegmentReason = 'silence' | 'maxLength' | 'misfire' | 'open';

/** One VAD segment, [startFrame, lastSpeechFrame, endFrame, reason], in ctx frames. */
export interface Segment {
  startFrame: number;
  /** The segment's last speech step; null for a misfire (its event carries none) and for an open segment. */
  lastSpeechFrame: number | null;
  /** The frame of the step that ended it (the `end`/`misfire` event frame), or the input end when open. */
  endFrame: number;
  reason: SegmentReason;
}

/** Short phrases count for hits, misses, splits and EoS latency; passages only for truncation and cap ends. */
export type TruthKind = 'short' | 'passage';

/** One truth utterance, in ctx frames. */
export interface TruthSpan {
  id: string;
  kind: TruthKind;
  /** Half-open [start, end): the hull of the utterance's spans (traces: press − 150 ms, release + 150 ms). */
  start: number;
  end: number;
  /** True end of speech: the corpus label end, or the trace release. */
  offset: number;
}

export interface SceneInput {
  ctxRate: number;
  /** Length of the evaluated input in ctx frames (the false-trigger rate's denominator). */
  durationFrames: number;
  truth: readonly TruthSpan[];
  segments: readonly Segment[];
}

export interface Metrics {
  /** N: short-phrase spans evaluated (hits + misses + splits). */
  shortPhrases: number;
  hits: number;
  misses: number;
  splits: number;
  /** Spans (short phrases and passages) overlapped by at least one segment with a lastSpeechFrame. */
  truncChecked: number;
  truncations: number;
  capEnds: number;
  misfires: number;
  /** Segments that count for overlaps (every reason but misfire). */
  segments: number;
  falseTriggers: number;
  minutes: number;
  /** falseTriggers / minutes; 0 when minutes is 0. */
  falseTriggersPerMin: number;
  /** EoS latency of every hit whose segment has ended (not open), in ms, in truth order. */
  eosMs: number[];
  /** Nearest-rank percentiles of eosMs; null when it is empty. */
  eosP50Ms: number | null;
  eosP90Ms: number | null;
}

/** The truncation margin on both sides of the comparison, in ms (issue #53; TAIL_MS is the take's tail). */
export const TRUNCATION_MS = 150;
/** Trace truth spans are the hold-to-talk press/release widened by this on each side (plan §7 M2: ±150 ms). */
export const TRACE_SPAN_PAD_MS = 150;
/** Trace utterances shorter than this (release − press) are short phrases; longer ones passages (plan §7 M2). */
export const SHORT_PHRASE_MAX_MS = 3000;

/** True iff the half-open intervals [aStart, aEnd) and [bStart, bEnd) share a frame; touching ones don't. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Nearest-rank percentile (0 < p ≤ 100) of values: the ⌈p/100 · n⌉-th smallest. null when values is empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile must be in (0, 100] (got ${p})`);
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]!;
}

/** Misses (and, separately, splits) allowed for N short phrases: floor(3·N/180) (plan §7 M2: 3 in 180). */
export function allowedErrors(n: number): number {
  return Math.floor((3 * n) / 180);
}

/** Converts ms to ctx frames (unrounded). */
function framesOf(ms: number, ctxRate: number): number {
  return (ms * ctxRate) / 1000;
}

/** The metrics of one scene or trace. */
export function evaluateScene(input: SceneInput): Metrics {
  const { ctxRate, durationFrames, truth } = input;
  if (!(ctxRate > 0)) throw new RangeError(`ctxRate must be > 0 (got ${ctxRate})`);
  const counted = input.segments.filter((s) => s.reason !== 'misfire');
  const margin = framesOf(TRUNCATION_MS, ctxRate);
  const m: Metrics = {
    shortPhrases: 0,
    hits: 0,
    misses: 0,
    splits: 0,
    truncChecked: 0,
    truncations: 0,
    capEnds: counted.filter((s) => s.reason === 'maxLength').length,
    misfires: input.segments.length - counted.length,
    segments: counted.length,
    falseTriggers: 0,
    minutes: durationFrames / ctxRate / 60,
    falseTriggersPerMin: 0,
    eosMs: [],
    eosP50Ms: null,
    eosP90Ms: null,
  };
  for (const t of truth) {
    const over = counted.filter((s) => overlaps(s.startFrame, s.endFrame, t.start, t.end));
    let last: number | null = null;
    for (const s of over) {
      if (s.lastSpeechFrame !== null && (last === null || s.lastSpeechFrame > last)) last = s.lastSpeechFrame;
    }
    if (last !== null) {
      m.truncChecked++;
      if (last + margin < t.end - margin) m.truncations++;
    }
    if (t.kind !== 'short') continue;
    m.shortPhrases++;
    if (over.length === 0) {
      m.misses++;
    } else if (over.length === 1) {
      m.hits++;
      const s = over[0]!;
      if (s.reason !== 'open') m.eosMs.push(((s.endFrame - t.offset) * 1000) / ctxRate);
    } else {
      m.splits++;
    }
  }
  m.falseTriggers = counted.filter(
    (s) => !truth.some((t) => overlaps(s.startFrame, s.endFrame, t.start, t.end)),
  ).length;
  m.falseTriggersPerMin = m.minutes > 0 ? m.falseTriggers / m.minutes : 0;
  m.eosP50Ms = percentile(m.eosMs, 50);
  m.eosP90Ms = percentile(m.eosMs, 90);
  return m;
}

/** Pools scene metrics: counts and minutes add up, the rate is recomputed, latencies are concatenated. */
export function poolMetrics(list: readonly Metrics[]): Metrics {
  const sum = (key: Exclude<keyof Metrics, 'eosMs' | 'eosP50Ms' | 'eosP90Ms'>): number =>
    list.reduce((acc, m) => acc + m[key], 0);
  const eosMs = list.flatMap((m) => m.eosMs);
  const minutes = sum('minutes');
  const falseTriggers = sum('falseTriggers');
  return {
    shortPhrases: sum('shortPhrases'),
    hits: sum('hits'),
    misses: sum('misses'),
    splits: sum('splits'),
    truncChecked: sum('truncChecked'),
    truncations: sum('truncations'),
    capEnds: sum('capEnds'),
    misfires: sum('misfires'),
    segments: sum('segments'),
    falseTriggers,
    minutes,
    falseTriggersPerMin: minutes > 0 ? falseTriggers / minutes : 0,
    eosMs,
    eosP50Ms: percentile(eosMs, 50),
    eosP90Ms: percentile(eosMs, 90),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Corpus truth

/** The label fields of a corpus sidecar (`.cache/corpus/<scene>.json`, SceneMeta in scripts/corpus-lib.ts). */
export interface CorpusLabels {
  sampleRate: number;
  /** Half-open [start, end) speech spans in samples, in order. */
  spans: readonly (readonly [number, number])[];
  /** The kind of each span's utterance. */
  kinds: readonly ('word' | 'sentence' | 'passage')[];
  /** The utterance (manifest id) of each span: a render can have 2 spans. */
  ids: readonly string[];
}

/**
 * The truth spans of a corpus scene in ctx frames: one per utterance, i.e. per run of consecutive spans with the
 * same id, from its first span's start to its last span's end (the true offset). Words and sentences are short
 * phrases, passages passages.
 */
export function corpusTruth(labels: CorpusLabels, ctxRate: number): TruthSpan[] {
  const scale = ctxRate / labels.sampleRate;
  const out: TruthSpan[] = [];
  for (let i = 0; i < labels.spans.length; i++) {
    const [start, end] = labels.spans[i]!;
    const id = labels.ids[i]!;
    const prev = out.at(-1);
    if (prev !== undefined && i > 0 && labels.ids[i - 1] === id) {
      prev.end = end * scale;
      prev.offset = end * scale;
      continue;
    }
    out.push({
      id,
      kind: labels.kinds[i] === 'passage' ? 'passage' : 'short',
      start: start * scale,
      end: end * scale,
      offset: end * scale,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// TTS gate (issue #53, plan §7 M2 "On the TTS corpus")

/** SNR levels pooled for the miss and split checks; SNR 0 is reported but not gated. */
export const TTS_GATE_SNRS: readonly number[] = [20, 10, 5];
/** Noises whose false-trigger rate is gated, on their noise-only streams and on their scenes at SNR ≥ 10 dB. */
export const FT_GATE_NOISES: readonly string[] = ['fan', 'music'];
export const FT_GATE_MIN_SNR = 10;
/** ≤ 2 false triggers per 15 min (plan §7 M2: ≈ 0.13/min). */
export const MAX_FALSE_TRIGGERS_PER_MIN = 0.13;

/** A corpus scene with its metrics, as the gate sees it. */
export interface GateScene {
  name: string;
  type: 'snr' | 'passages' | 'noise-only' | 'trace';
  noise: string;
  snrDb: number | null;
  metrics: Metrics;
}

export interface GateCheck {
  name: string;
  value: number;
  limit: number;
  pass: boolean;
  /** The scenes the check pools. */
  scenes: string[];
}

export interface GateResult {
  pass: boolean;
  checks: GateCheck[];
}

/**
 * The TTS gate over a corpus group's scenes:
 * - misses ≤ floor(3·N/180) and splits ≤ floor(3·N/180), pooled over the SNR scenes at 20, 10 and 5 dB (N = their
 *   short phrases); it fails when there is no such scene;
 * - for fan and for music, each present population on its own: the noise-only stream(s), and the scenes at
 *   ≥ 10 dB SNR (the SNR scenes and the passages scene), pooled: false triggers ≤ 0.13/min.
 */
export function ttsGate(scenes: readonly GateScene[]): GateResult {
  const checks: GateCheck[] = [];
  const pool = scenes.filter((s) => s.type === 'snr' && s.snrDb !== null && TTS_GATE_SNRS.includes(s.snrDb));
  const pooled = poolMetrics(pool.map((s) => s.metrics));
  const allowed = allowedErrors(pooled.shortPhrases);
  const names = pool.map((s) => s.name);
  for (const [what, value] of [
    ['misses', pooled.misses],
    ['splits', pooled.splits],
  ] as const) {
    checks.push({
      name: `${what} (SNR ${TTS_GATE_SNRS.join('/')}, N = ${pooled.shortPhrases})`,
      value,
      limit: allowed,
      pass: pool.length > 0 && value <= allowed,
      scenes: names,
    });
  }
  for (const noise of FT_GATE_NOISES) {
    const populations: [string, GateScene[]][] = [
      [`${noise} noise-only`, scenes.filter((s) => s.type === 'noise-only' && s.noise === noise)],
      [
        `${noise} SNR ≥ ${FT_GATE_MIN_SNR}`,
        scenes.filter(
          (s) =>
            (s.type === 'snr' || s.type === 'passages') &&
            s.noise === noise &&
            s.snrDb !== null &&
            s.snrDb >= FT_GATE_MIN_SNR,
        ),
      ],
    ];
    for (const [label, list] of populations) {
      if (list.length === 0) continue;
      const m = poolMetrics(list.map((s) => s.metrics));
      const value = Math.round(m.falseTriggersPerMin * 1000) / 1000;
      checks.push({
        name: `false triggers/min, ${label} (${m.falseTriggers} in ${m.minutes.toFixed(1)} min)`,
        value,
        limit: MAX_FALSE_TRIGGERS_PER_MIN,
        pass: m.falseTriggersPerMin <= MAX_FALSE_TRIGGERS_PER_MIN,
        scenes: list.map((s) => s.name),
      });
    }
  }
  return { pass: checks.every((c) => c.pass), checks };
}
