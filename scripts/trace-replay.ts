// Real-voice feature-trace replay (plan §7 M2 "Real-voice feature traces"; issue #53). A trace logs per-frame
// scalars, never audio (src/vad-trace/format.ts), so any segmenter / energy-gate parameter set can be replayed
// offline through the production steps, exactly as the DSP worker's VadCore (src/workers/vad-core.ts) runs them in
// one listen:
// - energy backend: energyGateStep over bandDb (10 ms hops), prob = gate.active (0 during the onset block), one
//   segmenterStep per hop, and the voicing rule on `voicing`: an `end` with fewer than MIN_VOICED_MS of voiced hops
//   (score > VOICED_THRESHOLD, counted from the start hop on) becomes a `misfire`;
// - Silero backend: one segmenterStep per sileroP value (32 ms; 0 during the onset block), then the proximity gate
//   on every `end`: the power mean (activeLevelDb) of the bandDb hops whose ctx frame lies in
//   [start frame, lastSpeechFrame + 512·ctxRate/16000), within the last PROXIMITY_HISTORY_HOPS hops, must be at
//   least X dB above the floor at the onset (the energyGateStep floor replayed over bandDb, as of the end of the
//   start frame's hops; NaN passes), else the `end` becomes a `misfire`.
// A trace starts like one arm: the gate starts uninitialised and onsets are blocked for ONSET_BLOCK_MS.
//
// Known limitation: traces are continuous captures, so there is no re-arm. The re-arm effects the corpus harness
// includes (LSTM reset, floor restore, onset block, the 250 ms cooldown gap) are not replayed, and the logged Silero
// p comes from one continuous LSTM run; lab/vad-live covers them on the device (plan §7 M2).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ENERGY_HOP, ONSET_BLOCK_MS, PROXIMITY_DB, VAD_FRAME, VAD_RATE } from '../src/audio/constants.ts';
import {
  DEFAULT_ENERGY_PARAMS,
  energyGateStep,
  initialEnergyGateState,
  type EnergyGateParams,
  type FrameFeatures,
} from '../src/dsp/energy-gate.ts';
import { activeLevelDb, passesProximity } from '../src/dsp/proximity.ts';
import {
  ENERGY_SEG_PARAMS,
  initialSegState,
  segmenterStep,
  SILERO_SEG_PARAMS,
  type SegEvent,
  type SegParams,
} from '../src/dsp/segmenter.ts';
import { VOICED_THRESHOLD } from '../src/dsp/voicing.ts';
import {
  decodeTrace,
  hopStartFrame,
  sileroStartFrame,
  staleness,
  type TraceMeta,
  type TraceStreams,
} from '../src/vad-trace/format.ts';
import { MIN_VOICED_MS, PROXIMITY_HISTORY_HOPS } from '../src/workers/vad-core.ts';
import { SHORT_PHRASE_MAX_MS, TRACE_SPAN_PAD_MS, type Segment, type TruthSpan } from './vad-metrics.ts';

export interface ReplayOptions {
  backend: 'silero' | 'energy';
  /** Segmenter parameters (default SILERO_SEG_PARAMS or ENERGY_SEG_PARAMS, by backend). */
  seg?: SegParams;
  /** Energy-gate parameters (default DEFAULT_ENERGY_PARAMS). */
  energy?: EnergyGateParams;
  /** Proximity gate X in dB for Silero ends (default PROXIMITY_DB). */
  proximityDb?: number;
}

/** One energy hop in ms (10). */
const HOP_MS = (ENERGY_HOP * 1000) / VAD_RATE;

/**
 * Splits traces into the fresh ones and the stale ones, with `staleness(meta, currentFrontEndHash,
 * currentWeightsSha)`'s reason (plan §7 M2 "Stale traces": changes upstream of the logged scalars invalidate a
 * trace). Order is kept within each list.
 */
export function partitionStale<T extends { meta: TraceMeta }>(
  traces: readonly T[],
  currentFrontEndHash: string,
  currentWeightsSha: string,
): { fresh: T[]; stale: { trace: T; reason: 'frontEnd' | 'weights' }[] } {
  const fresh: T[] = [];
  const stale: { trace: T; reason: 'frontEnd' | 'weights' }[] = [];
  for (const trace of traces) {
    const s = staleness(trace.meta, currentFrontEndHash, currentWeightsSha);
    if (s === null) fresh.push(trace);
    else stale.push({ trace, reason: s.reason });
  }
  return { fresh, stale };
}

/** Reads <dir>/trace.json and <dir>/trace.bin. */
export function loadTrace(dir: string): { meta: TraceMeta; streams: TraceStreams } {
  return decodeTrace(readFileSync(join(dir, 'trace.json'), 'utf8'), readFileSync(join(dir, 'trace.bin')));
}

/**
 * The truth spans of a trace: one per hold-to-talk label, in press order, [press − 150 ms, release + 150 ms) with
 * the release as the true offset; short when release − press < 3 s, else a passage; all gated.
 */
export function traceTruth(meta: TraceMeta): TruthSpan[] {
  const pad = (TRACE_SPAN_PAD_MS * meta.ctxRate) / 1000;
  return meta.labels
    .map((l, i) => ({ ...l, i }))
    .toSorted((a, b) => a.press - b.press)
    .map(({ press, release, i }) => ({
      id: `label-${i}`,
      kind: ((release - press) * 1000) / meta.ctxRate < SHORT_PHRASE_MAX_MS ? 'short' : 'passage',
      gated: true,
      start: press - pad,
      end: release + pad,
      offset: release,
    }));
}

/** Collects segmenter events into segments: a start opens one, an end or misfire closes it. */
function collector(): { add: (ev: SegEvent) => void; segments: Segment[]; openStart: () => number | null } {
  const segments: Segment[] = [];
  let open: number | null = null;
  return {
    segments,
    openStart: () => open,
    add(ev: SegEvent): void {
      if (ev.kind === 'start') {
        open = ev.frame;
        return;
      }
      if (open === null) throw new Error(`${ev.kind} at ${ev.frame} without a start`);
      segments.push(
        ev.kind === 'end'
          ? { startFrame: open, lastSpeechFrame: ev.lastSpeechFrame, endFrame: ev.frame, reason: ev.reason }
          : { startFrame: open, lastSpeechFrame: null, endFrame: ev.frame, reason: 'misfire' },
      );
      open = null;
    },
  };
}

/**
 * Replays a trace through the production segmenter and energy gate (see the header). Returns the segments in ctx
 * frames (a segment still open at the end of the trace is `open`, ending at the trace end) and the replayed length
 * in ctx frames.
 */
export function replayTrace(
  meta: TraceMeta,
  streams: TraceStreams,
  opts: ReplayOptions,
): { segments: Segment[]; durationFrames: number } {
  const silero = opts.backend === 'silero';
  const segParams = opts.seg ?? (silero ? SILERO_SEG_PARAMS : ENERGY_SEG_PARAMS);
  const energy = opts.energy ?? DEFAULT_ENERGY_PARAMS;
  const proximityDb = opts.proximityDb ?? PROXIMITY_DB;
  const { bandDb, voicing, sileroP } = streams;
  const n10 = bandDb.length;
  const onsetBlockEnd = meta.firstFrame + Math.round((ONSET_BLOCK_MS / 1000) * meta.ctxRate);
  const gate = initialEnergyGateState();
  const seg = initialSegState();
  const f: FrameFeatures = { frame: 0, db: 0, floorDb: Number.NaN };
  const out = collector();
  /** Steps the gate over hop i; returns its ctx frame. */
  const stepGate = (i: number): number => {
    f.frame = hopStartFrame(meta, i);
    f.db = bandDb[i]!;
    energyGateStep(gate, f, energy);
    f.floorDb = gate.initialized ? gate.floorDb : Number.NaN;
    return f.frame;
  };

  if (!silero) {
    let voicedHops = 0;
    for (let i = 0; i < n10; i++) {
      const frame = stepGate(i);
      const voiced = voicing[i]! > VOICED_THRESHOLD;
      const prob = gate.active && frame >= onsetBlockEnd ? 1 : 0;
      const wasInSpeech = seg.inSpeech;
      let ev = segmenterStep(seg, segParams, frame, prob);
      if (ev !== null && ev.kind === 'start') voicedHops = voiced ? 1 : 0;
      else if (wasInSpeech && voiced) voicedHops++;
      if (ev !== null && ev.kind === 'end' && voicedHops * HOP_MS < MIN_VOICED_MS) {
        ev = { kind: 'misfire', frame: ev.frame };
      }
      if (ev !== null) out.add(ev);
    }
    const end = hopStartFrame(meta, n10);
    const open = out.openStart();
    if (open !== null)
      out.segments.push({ startFrame: open, lastSpeechFrame: null, endFrame: end, reason: 'open' });
    return { segments: out.segments, durationFrames: end - meta.firstFrame };
  }

  const frameCtx = (VAD_FRAME * meta.ctxRate) / VAD_RATE;
  let hops = 0;
  let onsetFloorDb = Number.NaN;
  /** The proximity gate, as VadCore.nearEnough: hops of [start, lastSpeechFrame + one frame) among the last 1000. */
  const nearEnough = (lastSpeechFrame: number): boolean => {
    const lo = seg.startFrame;
    const hi = lastSpeechFrame + frameCtx;
    const oldest = Math.max(0, hops - PROXIMITY_HISTORY_HOPS);
    let to = hops;
    while (to > oldest && hopStartFrame(meta, to - 1) >= hi) to--;
    let from = to;
    while (from > oldest && hopStartFrame(meta, from - 1) >= lo) from--;
    return passesProximity(activeLevelDb(bandDb, from, to), onsetFloorDb, proximityDb);
  };
  for (let j = 0; j < sileroP.length; j++) {
    // The hops that end within Silero frame j are stepped first, as VadCore does within one frame() call.
    const hopsEnd = Math.min(n10, Math.floor(((j + 1) * VAD_FRAME) / ENERGY_HOP));
    while (hops < hopsEnd) stepGate(hops++);
    const frame = sileroStartFrame(meta, j);
    const p = frame < onsetBlockEnd ? 0 : sileroP[j]!;
    let ev = segmenterStep(seg, segParams, frame, p);
    if (ev !== null && ev.kind === 'end' && !nearEnough(ev.lastSpeechFrame)) {
      ev = { kind: 'misfire', frame: ev.frame };
    }
    if (ev !== null && ev.kind === 'start') onsetFloorDb = gate.initialized ? gate.floorDb : Number.NaN;
    if (ev !== null) out.add(ev);
  }
  const end = sileroStartFrame(meta, sileroP.length);
  const open = out.openStart();
  if (open !== null)
    out.segments.push({ startFrame: open, lastSpeechFrame: null, endFrame: end, reason: 'open' });
  return { segments: out.segments, durationFrames: end - meta.firstFrame };
}
