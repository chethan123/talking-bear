import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { mulberry32 } from '../test/dsp-helpers.ts';
import { readWav } from '../test/wav.ts';
import type { WorkerToMain } from '../src/audio/messages.ts';
import { ENERGY_HOP, PROXIMITY_DB, VAD_FRAME, VOICING_WINDOW } from '../src/audio/constants.ts';
import { createGateFilter, frameDb } from '../src/dsp/energy-gate.ts';
import { createSilero, type SileroModel } from '../src/dsp/silero/model.ts';
import { decodeWeights } from '../src/dsp/silero/weights.ts';
import { createVoicing } from '../src/dsp/voicing.ts';
import { decodeTrace, encodeTrace, type TraceMeta, type TraceStreams } from '../src/vad-trace/format.ts';
import { VadCore } from '../src/workers/vad-core.ts';
import { loadTrace, replayTrace, traceTruth } from './trace-replay.ts';
import { runVadCore } from './vad-eval.ts';
import type { Segment } from './vad-metrics.ts';

const CTX = 48_000;
const HOP_CTX = 480; // one 10 ms hop at 48 kHz
const FRAME_CTX = 1536; // one 32 ms Silero frame at 48 kHz

function meta(p: Partial<TraceMeta> & Pick<TraceMeta, 'n10' | 'n32'>): TraceMeta {
  return {
    version: 1,
    device: 'synthetic',
    chrome: '0',
    ctxRate: CTX,
    constraints: {},
    sileroWeightsSha256: '0'.repeat(64),
    frontEndHash: '0'.repeat(64),
    session: 'other',
    condition: 'quiet',
    placement: 'none',
    speaker: 'adult',
    scriptId: 'synthetic',
    startedAt: '2026-10-01T00:00:00Z',
    firstFrame: 0,
    labels: [],
    ...p,
  };
}

/** Round-trips the trace through encodeTrace / decodeTrace, as a committed trace would be read. */
function viaFormat(m: TraceMeta, s: TraceStreams): { meta: TraceMeta; streams: TraceStreams } {
  const { json, bin } = encodeTrace(m, s);
  return decodeTrace(json, bin);
}

/** Streams with constant values; callers overwrite ranges. */
function streams(n10: number, n32: number, bandDb: number, voicing: number, p: number): TraceStreams {
  return {
    rawDb: new Float32Array(n10).fill(bandDb),
    bandDb: new Float32Array(n10).fill(bandDb),
    voicing: new Float32Array(n10).fill(voicing),
    sileroP: new Float32Array(n32).fill(p),
  };
}

describe('traceTruth', () => {
  it('widens each press/release by 150 ms, sorts by press and splits short phrases at 3 s', () => {
    const m = meta({
      n10: 0,
      n32: 0,
      labels: [
        { press: 480_000, release: 480_000 + 144_000 }, // exactly 3 s: a passage
        { press: 96_000, release: 96_000 + 143_999 }, // just under 3 s: short
      ],
    });
    expect(traceTruth(m)).toEqual([
      { id: 'label-1', kind: 'short', start: 96_000 - 7200, end: 239_999 + 7200, offset: 239_999 },
      { id: 'label-0', kind: 'passage', start: 480_000 - 7200, end: 624_000 + 7200, offset: 624_000 },
    ]);
  });
});

describe('replayTrace: Silero', () => {
  // 100 frames (3.2 s); speech p 0.9 on frames 10–29, 0.1 elsewhere.
  const n32 = 100;
  const n10 = 320;
  const build = (
    speechDb: number,
    floorDb = -60,
    firstFrame = 0,
  ): { meta: TraceMeta; streams: TraceStreams } => {
    const s = streams(n10, n32, floorDb, 0, 0.1);
    s.sileroP.fill(0.9, 10, 30);
    // Hops of frames 10–29: 16 kHz samples [5120, 15360), i.e. hops 32–95.
    s.bandDb.fill(speechDb, 32, 96);
    return viaFormat(meta({ n10, n32, firstFrame }), s);
  };

  it('ends a near segment after the 600 ms hangover', () => {
    const t = build(-30);
    expect(replayTrace(t.meta, t.streams, { backend: 'silero' })).toEqual({
      // Silence starts at frame 30; (k − 30 + 1)·32 ≥ 600 first at k = 48.
      segments: [
        {
          startFrame: 10 * FRAME_CTX,
          lastSpeechFrame: 29 * FRAME_CTX,
          endFrame: 48 * FRAME_CTX,
          reason: 'silence',
        },
      ],
      durationFrames: n32 * FRAME_CTX,
    });
  });

  it('keeps the frame labels of a trace that starts at a later ctx frame', () => {
    const t = build(-30, -60, 96_000);
    const r = replayTrace(t.meta, t.streams, { backend: 'silero' });
    expect(r.segments).toEqual([
      {
        startFrame: 96_000 + 10 * FRAME_CTX,
        lastSpeechFrame: 96_000 + 29 * FRAME_CTX,
        endFrame: 96_000 + 48 * FRAME_CTX,
        reason: 'silence',
      },
    ]);
    expect(r.durationFrames).toBe(n32 * FRAME_CTX);
  });

  it('turns a far segment into a misfire with the proximity gate (X = 3), unless X allows it', () => {
    const t = build(-58); // 2 dB above the floor
    expect(replayTrace(t.meta, t.streams, { backend: 'silero' }).segments).toEqual([
      { startFrame: 10 * FRAME_CTX, lastSpeechFrame: null, endFrame: 48 * FRAME_CTX, reason: 'misfire' },
    ]);
    expect(replayTrace(t.meta, t.streams, { backend: 'silero', proximityDb: 1 }).segments[0]!.reason).toBe(
      'silence',
    );
  });

  it('passes a segment whose onset had no floor (only digital silence up to its start frame)', () => {
    // Hops 0–34 (up to the end of start frame 10) are digital silence, so the onset floor is NaN; the speech hops
    // after them are as quiet as the floor they then initialise.
    const s = streams(n10, n32, -120, 0, 0.1);
    s.sileroP.fill(0.9, 10, 30);
    s.bandDb.fill(-58, 35);
    const t = viaFormat(meta({ n10, n32 }), s);
    expect(replayTrace(t.meta, t.streams, { backend: 'silero' }).segments).toEqual([
      {
        startFrame: 10 * FRAME_CTX,
        lastSpeechFrame: 29 * FRAME_CTX,
        endFrame: 48 * FRAME_CTX,
        reason: 'silence',
      },
    ]);
    // The same hops with a floor before the onset: 0 dB above it, a misfire.
    s.bandDb.fill(-58);
    const u = viaFormat(meta({ n10, n32 }), s);
    expect(replayTrace(u.meta, u.streams, { backend: 'silero' }).segments[0]!.reason).toBe('misfire');
  });

  it('blocks onsets for 100 ms after the trace start', () => {
    const s = streams(n10, n32, -60, 0, 0.1);
    s.sileroP.fill(0.9, 0, 3); // frames 0–2 start before ctx frame 4800
    s.sileroP.fill(0.9, 3, 4); // frame 3 starts at 4608 < 4800: still blocked
    expect(replayTrace(meta({ n10, n32 }), s, { backend: 'silero' }).segments).toEqual([]);
    s.sileroP.fill(0.9, 4, 12); // frame 4 starts at 6144: a segment from there
    expect(replayTrace(meta({ n10, n32 }), s, { backend: 'silero' }).segments[0]!.startFrame).toBe(
      4 * FRAME_CTX,
    );
  });

  it('reports a segment still in speech at the end of the trace as open', () => {
    const s = streams(n10, n32, -60, 0, 0.1);
    s.sileroP.fill(0.9, 90);
    expect(replayTrace(meta({ n10, n32 }), s, { backend: 'silero' }).segments).toEqual([
      { startFrame: 90 * FRAME_CTX, lastSpeechFrame: null, endFrame: n32 * FRAME_CTX, reason: 'open' },
    ]);
  });

  it('takes other segmenter parameters (the grid search replays many)', () => {
    const t = build(-30);
    const r = replayTrace(t.meta, t.streams, {
      backend: 'silero',
      seg: {
        posThreshold: 0.95,
        negThreshold: 0.5,
        hangoverMs: 600,
        minSpeechMs: 150,
        maxUtteranceMs: 10_000,
        frameMs: 32,
      },
    });
    expect(r.segments).toEqual([]);
  });
});

describe('replayTrace: energy', () => {
  // 300 hops (3 s) at −60 dBFS; hops 50–99 at −30 dBFS.
  const n10 = 300;
  const n32 = 93;
  const build = (voicedFrom: number, voicedTo: number): { meta: TraceMeta; streams: TraceStreams } => {
    const s = streams(n10, n32, -60, 0, 0);
    s.bandDb.fill(-30, 50, 100);
    s.voicing.fill(0.9, voicedFrom, voicedTo);
    return viaFormat(meta({ n10, n32 }), s);
  };

  it('ends a voiced segment after the 800 ms hangover', () => {
    const t = build(50, 100);
    expect(replayTrace(t.meta, t.streams, { backend: 'energy' })).toEqual({
      // The gate closes at hop 100; (k − 100 + 1)·10 ≥ 800 first at k = 179.
      segments: [
        {
          startFrame: 50 * HOP_CTX,
          lastSpeechFrame: 99 * HOP_CTX,
          endFrame: 179 * HOP_CTX,
          reason: 'silence',
        },
      ],
      durationFrames: n10 * HOP_CTX,
    });
  });

  it('turns a segment with < 60 ms of voiced hops into a misfire (voicing rule)', () => {
    const misfire = {
      startFrame: 50 * HOP_CTX,
      lastSpeechFrame: null,
      endFrame: 179 * HOP_CTX,
      reason: 'misfire',
    };
    expect(replayTrace(build(0, 0).meta, build(0, 0).streams, { backend: 'energy' }).segments).toEqual([
      misfire,
    ]);
    const five = build(60, 65); // 50 ms voiced
    expect(replayTrace(five.meta, five.streams, { backend: 'energy' }).segments).toEqual([misfire]);
    const six = build(60, 66); // 60 ms voiced
    expect(replayTrace(six.meta, six.streams, { backend: 'energy' }).segments[0]!.reason).toBe('silence');
    // Voiced hops before the start hop don't count.
    const early = build(40, 50);
    expect(replayTrace(early.meta, early.streams, { backend: 'energy' }).segments).toEqual([misfire]);
  });
});

describe('loadTrace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-replay-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads trace.json and trace.bin from a directory', () => {
    const m = meta({ n10: 3, n32: 1, labels: [{ press: 10, release: 20 }] });
    const s = streams(3, 1, -50, 0.25, 0.75);
    const { json, bin } = encodeTrace(m, s);
    writeFileSync(join(dir, 'trace.json'), json);
    writeFileSync(join(dir, 'trace.bin'), bin);
    const t = loadTrace(dir);
    expect(t.meta).toEqual(m);
    expect(t.streams).toEqual(s);
  });
});

// The replay must give exactly the segments VadCore gives on the same audio in one listen (no re-arm), with the
// trace streams computed the way the worker computes its features.

function speech(name: string): Float32Array {
  return readWav(readFileSync(new URL(`../test/corpus/speech/${name}`, import.meta.url))).channels[0]!;
}

function shippedModel(): SileroModel {
  const bytes = readFileSync(new URL('../src/dsp/silero/weights.bin', import.meta.url));
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return createSilero(decodeWeights(buf));
}

function gap(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * 16_000));
}

/** Proximity X for the equivalence runs: the near sentence is ≈ 35–40 dB above the floor, the far one < 20 dB. */
const EQUIV_X = 28;

/**
 * 1 s lead, a sentence, 2 s, the same sentence 20 dB quieter (far: a proximity misfire at EQUIV_X), 2 s, a 300 ms
 * white-noise burst (unvoiced: an energy-backend misfire), 2 s, a word, 2 s; over a low noise bed (≈ −60 dBFS
 * band-limited) so the floor is defined.
 */
function equivalenceScene(): Float32Array {
  const a = speech('sentence-00-r0.wav');
  const rng = mulberry32(42);
  const parts = [
    gap(1),
    a,
    gap(2),
    a.map((v) => v * 10 ** (-20 / 20)),
    gap(2),
    Float32Array.from({ length: 4800 }, () => 0.3 * (2 * rng() - 1)),
    gap(2),
    speech('word-00-r0.wav'),
    gap(2),
  ];
  return withBed(parts, rng);
}

/** The parts end to end, plus a low uniform noise bed (≈ −60 dBFS band-limited) drawn from rng. */
function withBed(parts: readonly Float32Array[], rng: () => number): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! + 0.003 * (2 * rng() - 1);
  return out;
}

/** The trace streams of x as the worker computes its features (one listen from sample 0, firstFrame 0). */
function toTrace(x: Float32Array, model: SileroModel): { meta: TraceMeta; streams: TraceStreams } {
  const frames = Math.floor(x.length / VAD_FRAME);
  const n10 = Math.floor((frames * VAD_FRAME) / ENERGY_HOP);
  const filter = createGateFilter(16_000);
  const band = new Float32Array(frames * VAD_FRAME);
  for (let i = 0; i < frames; i++) {
    const range = [i * VAD_FRAME, (i + 1) * VAD_FRAME] as const;
    filter.process(x.subarray(...range), band.subarray(...range));
  }
  const voicing = createVoicing(16_000);
  const win = new Float32Array(VOICING_WINDOW);
  const s: TraceStreams = {
    rawDb: new Float32Array(n10),
    bandDb: new Float32Array(n10),
    voicing: new Float32Array(n10),
    sileroP: new Float32Array(frames),
  };
  for (let i = 0; i < n10; i++) {
    const end = (i + 1) * ENERGY_HOP;
    s.rawDb[i] = frameDb(x, end - ENERGY_HOP, end);
    s.bandDb[i] = frameDb(band, end - ENERGY_HOP, end);
    // The last VOICING_WINDOW band-limited samples, zeros before the start (VadCore's voicing window).
    win.fill(0);
    const from = Math.max(0, end - VOICING_WINDOW);
    win.set(band.subarray(from, end), VOICING_WINDOW - (end - from));
    s.voicing[i] = voicing.score(win);
  }
  model.reset();
  for (let j = 0; j < frames; j++)
    s.sileroP[j] = model.process(x.subarray(j * VAD_FRAME, (j + 1) * VAD_FRAME));
  return viaFormat(meta({ n10, n32: frames }), s);
}

/** VadCore's segments for x in one listen (epoch 1, firstFrame i·1536). */
function vadCoreSegments(
  x: Float32Array,
  backend: 'silero' | 'energy',
  model: SileroModel,
  proximityDb = EQUIV_X,
): Segment[] {
  const out: Segment[] = [];
  let open = Number.NaN;
  const post = (m: WorkerToMain): void => {
    if (m.t !== 'seg') return;
    const ev = m.ev;
    if (ev.kind === 'start') {
      open = ev.frame;
      return;
    }
    out.push(
      ev.kind === 'end'
        ? { startFrame: open, lastSpeechFrame: ev.lastSpeechFrame, endFrame: ev.frame, reason: ev.reason }
        : { startFrame: open, lastSpeechFrame: null, endFrame: ev.frame, reason: 'misfire' },
    );
  };
  const core = new VadCore(CTX, post, { now: () => 0 });
  core.setModel(model);
  core.reset(1, backend, undefined, false, proximityDb);
  for (let i = 0; i + VAD_FRAME <= x.length; i += VAD_FRAME) {
    core.frame(1, (i / VAD_FRAME) * FRAME_CTX, x.subarray(i, i + VAD_FRAME));
  }
  return out;
}

describe('replayTrace matches VadCore on real speech', () => {
  const model = shippedModel();
  const x = equivalenceScene();
  const trace = toTrace(x, model);

  it('Silero: same segments, including the proximity misfire', () => {
    const want = vadCoreSegments(x, 'silero', model);
    expect(want.map((s) => s.reason)).toEqual(['silence', 'misfire', 'silence']);
    expect(
      replayTrace(trace.meta, trace.streams, { backend: 'silero', proximityDb: EQUIV_X }).segments,
    ).toEqual(want);
  });

  it('energy: same segments, including the voicing misfire', () => {
    const want = vadCoreSegments(x, 'energy', model);
    expect(want.filter((s) => s.reason === 'silence').length).toBeGreaterThanOrEqual(2);
    expect(want.some((s) => s.reason === 'misfire')).toBe(true);
    expect(replayTrace(trace.meta, trace.streams, { backend: 'energy' }).segments).toEqual(want);
  });
});

/** A VadCore that records the arguments of every `reset`. */
class SpyCore extends VadCore {
  readonly resets: unknown[][] = [];
  override reset(...args: Parameters<VadCore['reset']>): void {
    this.resets.push(args);
    super.reset(...args);
  }
}

/** Cooldown (250 ms) plus onset block (100 ms) at 48 kHz: the least gap between an end and the next start. */
const REARM_SPACING = 12_000 + 4800;

describe('runVadCore (the corpus runner: re-armed 250 ms after every end or misfire)', () => {
  const model = shippedModel();
  const x = equivalenceScene();

  it.each([
    ['silero', ['silence', 'silence', 'silence']],
    ['energy', ['silence', 'silence', 'misfire', 'silence']],
  ] as const)('%s: one listen up to the first end, then one listen per segment', (backend, reasons) => {
    const one = vadCoreSegments(x, backend, model, PROXIMITY_DB);
    const { segments, durationFrames } = runVadCore(x, backend, model);
    expect(one.map((s) => s.reason)).toEqual(reasons);
    expect(segments.map((s) => s.reason)).toEqual(reasons);
    // Identical until the first re-arm; after it the LSTM (Silero) and the hop grid (energy) restart, so later
    // frames may differ from one listen by a few frames.
    expect(segments[0]).toEqual(one[0]);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.startFrame).toBeGreaterThanOrEqual(segments[i - 1]!.endFrame + REARM_SPACING);
    }
    expect(durationFrames).toBe(Math.floor(x.length / VAD_FRAME) * FRAME_CTX);
  });

  it('skips the cooldown after an end and re-arms with the floor of the last floorSnapshot', () => {
    // A sentence, then a second one starting 0.65 s after the first's speech ends: in one listen it starts at
    // 164352, inside the 250 ms cooldown after the first end (159744).
    const y = withBed(
      [gap(1), speech('sentence-00-r0.wav'), gap(0.65), speech('sentence-01-r0.wav'), gap(2)],
      mulberry32(7),
    );
    expect(vadCoreSegments(y, 'silero', model, PROXIMITY_DB).map((s) => [s.startFrame, s.endFrame])).toEqual([
      [50688, 159744],
      [164352, expect.any(Number)],
    ]);
    const spies: SpyCore[] = [];
    const posts: WorkerToMain[] = [];
    const { segments } = runVadCore(y, 'silero', model, {
      createCore: (rate, post) => {
        const spy = new SpyCore(
          rate,
          (m) => {
            posts.push(m);
            post(m);
          },
          { now: () => 0 },
        );
        spies.push(spy);
        return spy;
      },
    });
    // Frames before 172032 (the first at or after 159744 + 12000) are not fed; the listen re-armed there blocks
    // onsets until 176832, so the second segment starts at the next frame, 178176.
    expect(segments.map((s) => [s.startFrame, s.reason])).toEqual([
      [50688, 'silence'],
      [178176, 'silence'],
    ]);
    // One floorSnapshot per listen (at its start); each re-arm restores the previous listen's. The third listen
    // is armed 250 ms after the second end and hears only the trailing bed.
    const floors = posts.flatMap((m) => (m.t === 'floorSnapshot' ? [[m.epoch, m.floorDb]] : []));
    expect(floors.map(([epoch]) => epoch)).toEqual([1, 2]);
    expect(floors.every(([, db]) => Number.isFinite(db))).toBe(true);
    expect(spies).toHaveLength(1);
    expect(spies[0]!.resets).toEqual([
      [1, 'silero', undefined, false],
      [2, 'silero', floors[0]![1], false],
      [3, 'silero', floors[1]![1], false],
    ]);
  });
});
