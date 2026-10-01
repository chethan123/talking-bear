// VadCore driven by the synthetic fixtures: the energy backend (M1) and its voicing rule, the Silero backend on
// the shipped weights (fallback, late model, failures, pre-gate, LSTM reset, vadStats), the allocation meters,
// and a smoke test of the worker glue. Fixtures are 48 kHz; like the capture worklet, the test decimates them
// to 16 kHz and feeds 512-sample frames tagged with the ctx frame of their first sample (ctxRate 48000, so
// frame i starts at i·512·3).

import { readFileSync } from 'node:fs';
import { GCProfiler, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mulberry32 } from '../../test/dsp-helpers.ts';
import { readWav } from '../../test/wav.ts';
import {
  DEFAULT_VAD_BACKEND,
  ENERGY_HOP,
  PREGATE_ENABLED,
  PREGATE_WARMUP_FRAMES,
  PROXIMITY_DB,
} from '../audio/constants.ts';
import type { WorkerToMain } from '../audio/messages.ts';
import { createGateFilter, frameDb } from '../dsp/energy-gate.ts';
import { activeLevelDb } from '../dsp/proximity.ts';
import { resampleOffline } from '../dsp/resample.ts';
import type { SegEvent } from '../dsp/segmenter.ts';
import { createSilero, type SileroModel } from '../dsp/silero/model.ts';
import { decodeWeights, type SileroWeights } from '../dsp/silero/weights.ts';
import { PRESETS } from '../dsp/types.ts';
import {
  MIN_VOICED_MS,
  PREGATE_HOLD_FRAMES,
  PROXIMITY_HISTORY_HOPS,
  SILERO_NOT_READY_MESSAGE,
  VAD_STATS_WINDOW,
  VadCore,
  type VadCoreOptions,
} from './vad-core.ts';

const CTX_RATE = 48000;
const FRAME = 512;
/** 1.5 s of zero frames after every fixture (47 · 512 samples ≥ 1.5 s at 16 kHz), so the hangover can end. */
const PAD_FRAMES = Math.ceil((1.5 * 16000) / FRAME);
const SPEECH_START = 1.0 * CTX_RATE; // every fixture's sound starts at 1.0 s
const VOWEL_END = 2.5 * CTX_RATE; // the 1.5 s vowels end at 2.5 s
const ONSET_BLOCK_FRAMES = 4800; // 100 ms at 48 kHz

function fixture(name: string): Float32Array {
  const wav = readWav(readFileSync(new URL(`../../test/fixtures/${name}.wav`, import.meta.url)));
  expect(wav.sampleRate).toBe(CTX_RATE);
  const x = wav.channels[0];
  if (x === undefined) throw new Error(`${name}: no channel`);
  return x;
}

/** The 16 kHz signal cut into 512-sample frames: the last partial frame is zero-filled, then `padFrames`
 *  zero frames follow. Each frame is its own buffer, like a transferred worklet frame. */
function frames16k(x48: Float32Array, padFrames = PAD_FRAMES): Float32Array[] {
  const x16 = resampleOffline(x48, 1 / 3);
  const n = Math.ceil(x16.length / FRAME) + padFrames;
  const out: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const f = new Float32Array(FRAME);
    if (i * FRAME < x16.length) f.set(x16.subarray(i * FRAME, Math.min((i + 1) * FRAME, x16.length)));
    out.push(f);
  }
  return out;
}

interface Run {
  core: VadCore;
  msgs: WorkerToMain[];
}

function newCore(ctxRate = CTX_RATE, opts?: VadCoreOptions): Run {
  const msgs: WorkerToMain[] = [];
  return { core: new VadCore(ctxRate, (m) => msgs.push(m), opts), msgs };
}

/** Feeds frames with firstFrame = offset + round(i·512·3). */
function feed(run: Run, epoch: number, frames: Float32Array[], offset = 0): void {
  frames.forEach((f, i) => run.core.frame(epoch, offset + Math.round(i * FRAME * 3), f));
}

/** A fresh core, reset to epoch 1 (energy), fed the whole fixture plus padding. */
function runFixture(name: string, restoreFloorDb?: number): Run {
  const run = newCore();
  run.core.reset(1, 'energy', restoreFloorDb);
  feed(run, 1, frames16k(fixture(name)));
  return run;
}

function segs(msgs: WorkerToMain[]): SegEvent[] {
  const out: SegEvent[] = [];
  for (const m of msgs) if (m.t === 'seg') out.push(m.ev);
  return out;
}

function kinds(msgs: WorkerToMain[]): string[] {
  return segs(msgs).map((e) => e.kind);
}

function ofType<T extends WorkerToMain['t']>(msgs: WorkerToMain[], t: T): Extract<WorkerToMain, { t: T }>[] {
  return msgs.filter((m): m is Extract<WorkerToMain, { t: T }> => m.t === t);
}

function levels(msgs: WorkerToMain[]): Extract<WorkerToMain, { t: 'level' }>[] {
  return ofType(msgs, 'level');
}

describe('VadCore on the fixtures (energy backend, ctxRate 48000)', () => {
  it.each(['vowel_f0-140', 'vowel_f0-300'])('%s: one start and one silence end', (name) => {
    const { msgs } = runFixture(name);
    const evs = segs(msgs);
    expect(kinds(msgs)).toEqual(['start', 'end']);
    const [start, end] = evs;
    if (start?.kind !== 'start' || end?.kind !== 'end') throw new Error('unreachable');
    expect(end.reason).toBe('silence');
    expect(start.frame).toBeGreaterThanOrEqual(SPEECH_START);
    expect(start.frame).toBeLessThanOrEqual(1.1 * CTX_RATE);
    expect(Math.abs(end.lastSpeechFrame - VOWEL_END)).toBeLessThanOrEqual(0.1 * CTX_RATE);
    expect(Math.abs(end.frame - end.lastSpeechFrame - 0.8 * CTX_RATE)).toBeLessThanOrEqual(0.04 * CTX_RATE);
    const snaps = ofType(msgs, 'floorSnapshot');
    expect(snaps).toHaveLength(1);
    expect(Number.isFinite(snaps[0]!.floorDb)).toBe(true);
    // Posted immediately before the start seg.
    const startIndex = msgs.findIndex((m) => m.t === 'seg' && m.ev.kind === 'start');
    expect(msgs[startIndex - 1]).toBe(snaps[0]);
    for (const m of msgs) expect('epoch' in m && m.epoch).toBe(1);
  });

  it('vowel_f0-140_pink_snr10: exactly one segment (no split, no misfire)', () => {
    expect(kinds(runFixture('vowel_f0-140_pink_snr10').msgs)).toEqual(['start', 'end']);
  });

  it.each(['silence_2s', 'noise_white_-60dbfs_3s'])('%s: no seg messages', (name) => {
    const { msgs } = runFixture(name);
    expect(ofType(msgs, 'seg')).toEqual([]);
    expect(ofType(msgs, 'floorSnapshot')).toEqual([]);
    expect(levels(msgs).length).toBeGreaterThan(0);
  });

  it('knock: at least two misfires and no end', () => {
    const k = kinds(runFixture('knock').msgs);
    expect(k.filter((x) => x === 'misfire').length).toBeGreaterThanOrEqual(2);
    expect(k.filter((x) => x === 'end')).toEqual([]);
  });

  it('long_12s: the first segment is capped by one maxLength end after ≈ 10 s', () => {
    const evs = segs(runFixture('long_12s').msgs);
    const capped = evs.filter((e) => e.kind === 'end' && e.reason === 'maxLength');
    expect(capped).toHaveLength(1);
    const [start, end] = evs;
    if (start?.kind !== 'start' || end?.kind !== 'end') throw new Error('unexpected event order');
    expect(end.reason).toBe('maxLength');
    expect(Math.abs(end.frame - start.frame - 10 * CTX_RATE)).toBeLessThanOrEqual(0.05 * CTX_RATE);
  });

  it('level messages arrive at ≈ 33 per second of audio, every 3rd hop', () => {
    const frames = frames16k(fixture('vowel_f0-140'));
    const run = newCore();
    run.core.reset(1, 'energy');
    feed(run, 1, frames);
    const lv = levels(run.msgs);
    const seconds = (frames.length * FRAME) / 16000;
    expect(Math.abs(lv.length / seconds - 100 / 3)).toBeLessThanOrEqual(1);
    // Hop h starts at ctx frame 480·h; levels are posted on hops 0, 3, 6, …
    lv.forEach((m, j) => expect(m.frame).toBe(1440 * j));
  });
});

describe('VadCore onset blocking', () => {
  it.each([0, 123456])(
    'speech from the first frame (epoch start %i) cannot start a segment within 100 ms',
    (offset) => {
      const cut = fixture('vowel_f0-140').subarray(SPEECH_START); // speech starts at the epoch's first frame
      const run = newCore();
      run.core.reset(1, 'energy');
      feed(run, 1, frames16k(cut), offset);
      const start = segs(run.msgs)[0];
      expect(start?.kind).toBe('start');
      expect(start!.frame).toBeGreaterThanOrEqual(offset + ONSET_BLOCK_FRAMES); // the issue's bound
      // Deterministic on the 480-frame hop grid: the first hop at or after the block end starts it.
      expect(start!.frame).toBe(offset + ONSET_BLOCK_FRAMES);
      // The block is what delayed it: the vowel was already well above the gate's absolute minimum.
      expect(levels(run.msgs).some((m) => m.frame < offset + ONSET_BLOCK_FRAMES && m.db > -50)).toBe(true);
    },
  );
});

describe('VadCore epochs and reset', () => {
  it('drops every frame before the first reset', () => {
    const run = newCore();
    feed(run, 0, frames16k(fixture('vowel_f0-140')));
    expect(run.msgs).toEqual([]);
  });

  it('drops stale- and newer-epoch frames after reset(epoch + 1), and keeps serving the current epoch', () => {
    const frames = frames16k(fixture('vowel_f0-140'));
    const run = newCore();
    run.core.reset(4, 'energy');
    feed(run, 4, frames);
    expect(kinds(run.msgs)).toEqual(['start', 'end']);
    run.msgs.length = 0;
    run.core.reset(5, 'energy');
    feed(run, 4, frames); // stale
    feed(run, 6, frames); // not current either (reset(6) hasn't arrived)
    expect(run.msgs).toEqual([]);
    feed(run, 5, frames, 10 * CTX_RATE);
    expect(kinds(run.msgs)).toEqual(['start', 'end']);
    for (const m of run.msgs) expect('epoch' in m && m.epoch).toBe(5);
  });

  it("reset(e, 'energy', -47) restores the floor: the first level.floorDb is within 1 dB of -47", () => {
    const first = levels(runFixture('vowel_f0-140', -47).msgs)[0];
    expect(first).toBeDefined();
    expect(Math.abs(first!.floorDb - -47)).toBeLessThanOrEqual(1);
  });

  it('level.floorDb is NaN until the floor is initialised', () => {
    const lv = levels(runFixture('vowel_f0-140').msgs);
    expect(lv[0]!.floorDb).toBeNaN();
    expect(lv.some((m) => Number.isFinite(m.floorDb))).toBe(true);
  });

  it('reset clears the hop remainder, segmenter, gate and epoch start', () => {
    const frames = frames16k(fixture('vowel_f0-140'));
    // Epoch 2 has speech from its first frame, so only a fresh epoch start gives the full onset block.
    const cut = frames16k(fixture('vowel_f0-140').subarray(SPEECH_START));
    const a = newCore();
    a.core.reset(1, 'energy');
    // Stop mid-utterance (2.27 s), with a hop remainder pending: 71 · 512 = 227 · 160 + 32 samples.
    feed(a, 1, frames.slice(0, 71));
    a.core.reset(2, 'energy');
    a.msgs.length = 0;
    feed(a, 2, cut, 777);
    const b = newCore();
    b.core.reset(2, 'energy');
    feed(b, 2, cut, 777);
    expect(a.msgs).toEqual(b.msgs);
    expect(segs(a.msgs)[0]).toEqual({ kind: 'start', frame: 777 + ONSET_BLOCK_FRAMES });
  });
});

/** firstFrame of frame k at ctxRate 44100, starting at ctx frame 1000. */
function tag441(k: number): number {
  return 1000 + Math.round((k * FRAME * 44100) / 16000);
}

describe('VadCore framing', () => {
  it('maps each hop to the ctx frame of its first sample at 44.1 kHz, carrying the remainder', () => {
    const run = newCore(44100);
    run.core.reset(1, 'energy');
    const n = 10;
    for (let k = 0; k < n; k++) run.core.frame(1, tag441(k), new Float32Array(FRAME));
    const expected: number[] = [];
    for (let h = 0; h < Math.floor((n * FRAME) / 160); h += 3) {
      const k = Math.floor((160 * h) / FRAME);
      const i = 160 * h - k * FRAME;
      expected.push(Math.round(tag441(k) + (i * 44100) / 16000));
    }
    expect(levels(run.msgs).map((m) => m.frame)).toEqual(expected);
  });

  it('rejects a frame that is not 512 samples, and a bad ctxRate', () => {
    const run = newCore();
    run.core.reset(1, 'energy');
    expect(() => run.core.frame(1, 0, new Float32Array(511))).toThrow(RangeError);
    expect(() => new VadCore(0, () => {})).toThrow(RangeError);
    expect(() => new VadCore(Number.NaN, () => {})).toThrow(RangeError);
  });
});

// ---- Silero backend, pre-gate, stats and the energy voicing rule (T35) ----

/** weights.bin as a fresh ArrayBuffer (a copy: never the Node Buffer, whose memory may be a shared pool). */
function weightsBuffer(): ArrayBuffer {
  const bytes = readFileSync(new URL('../dsp/silero/weights.bin', import.meta.url));
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

/** The shipped weights, as the worker decodes them. */
const W: SileroWeights = decodeWeights(weightsBuffer());

/** Counts reset() and process() calls of a model (by default a fresh real one) and can observe each frame. */
class SpyModel implements SileroModel {
  calls = 0;
  resets = 0;
  onProcess: ((x: Float32Array) => void) | null = null;
  readonly inner: SileroModel;

  constructor(inner: SileroModel = createSilero(W)) {
    this.inner = inner;
  }

  reset(): void {
    this.resets++;
    this.inner.reset();
  }

  process(x: Float32Array): number {
    this.calls++;
    this.onProcess?.(x);
    return this.inner.process(x);
  }
}

/** A model that always answers 0: no inference cost. */
function zeroModel(): SileroModel {
  return { reset: () => undefined, process: () => 0 };
}

/** A counting model that answers `loud` for frames whose mean square is > 1e-4, else `quiet`. */
function scriptedModel(loud: number, quiet: number): SileroModel & { calls: number } {
  const m = {
    calls: 0,
    reset: (): void => undefined,
    process(x: Float32Array): number {
      m.calls++;
      let sum = 0;
      for (let i = 0; i < x.length; i++) sum += x[i]! * x[i]!;
      return sum / x.length > 1e-4 ? loud : quiet;
    },
  };
  return m;
}

/** A fresh core with `model` set, reset to epoch 1 on Silero (pre-gate and proximity X as given), fed `frames`. */
function runSilero(frames: Float32Array[], model: SileroModel, pregate = false, proximityDb?: number): Run {
  const run = newCore();
  run.core.setModel(model);
  run.core.reset(1, 'silero', undefined, pregate, proximityDb);
  feed(run, 1, frames);
  return run;
}

/** Seeded uniform white noise at 48 kHz with the given RMS level (dBFS). */
function whiteNoise48(seed: number, seconds: number, rmsDb: number): Float32Array {
  const rng = mulberry32(seed);
  const a = Math.sqrt(3) * 10 ** (rmsDb / 20);
  return Float32Array.from({ length: Math.round(seconds * CTX_RATE) }, () => (2 * rng() - 1) * a);
}

function concat48(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** x + n, element-wise (same length). */
function addNoise(x: Float32Array, n: Float32Array): Float32Array {
  expect(n.length).toBe(x.length);
  return Float32Array.from(x, (v, i) => v + n[i]!);
}

/** Silero frame labels: every 512-sample frame starts at a multiple of 512 · 3 ctx frames. */
const SILERO_GRID = FRAME * 3;

/** Checks that the message right before the first `start` seg is a floorSnapshot with a finite floor. */
function expectSnapshotBeforeStart(msgs: WorkerToMain[]): void {
  const i = msgs.findIndex((m) => m.t === 'seg' && m.ev.kind === 'start');
  expect(i).toBeGreaterThan(0);
  const before = msgs[i - 1];
  if (before?.t !== 'floorSnapshot')
    throw new Error(`expected a floorSnapshot before the start, got ${before?.t}`);
  expect(Number.isFinite(before.floorDb)).toBe(true);
}

/** 2 s of −70 dBFS noise, vowel_f0-140 (plus noise), 1.5 s of noise: distinct frames, no zero padding. */
function noiseLedVowelFrames(): Float32Array[] {
  const x = concat48(
    whiteNoise48(11, 1.0, -70),
    addNoise(fixture('vowel_f0-140'), whiteNoise48(12, 2.8, -70)),
    whiteNoise48(13, 1.5, -70),
  );
  return frames16k(x, 0);
}

describe('VadCore Silero backend (shipped weights)', () => {
  it('1: silence_2s gives no seg events, with every frame through Silero', () => {
    const frames = frames16k(fixture('silence_2s'));
    const spy = new SpyModel();
    const { msgs } = runSilero(frames, spy);
    expect(ofType(msgs, 'seg')).toEqual([]);
    expect(ofType(msgs, 'floorSnapshot')).toEqual([]);
    expect(spy.calls).toBe(frames.length);
    expect(levels(msgs).length).toBeGreaterThan(0);
  });

  it('2: knock gives no end events', () => {
    const { msgs } = runSilero(frames16k(fixture('knock')), new SpyModel());
    expect(kinds(msgs)).not.toContain('end');
  });

  it("3: without a model, reset(…, 'silero') posts the not-ready error once and runs exactly like energy", () => {
    expect(SILERO_NOT_READY_MESSAGE).toBe('silero not ready; using energy');
    const energy = runFixture('vowel_f0-140').msgs;
    const run = newCore();
    run.core.reset(1, 'silero');
    feed(run, 1, frames16k(fixture('vowel_f0-140')));
    expect(run.msgs[0]).toEqual({ t: 'error', where: 'vad', message: SILERO_NOT_READY_MESSAGE });
    expect(ofType(run.msgs, 'error')).toHaveLength(1);
    expect(run.msgs.slice(1)).toEqual(energy);
    expect(kinds(energy)).toEqual(['start', 'end']);
    run.core.reset(2, 'silero');
    expect(ofType(run.msgs, 'error')).toHaveLength(2);
  });

  it('3b: a model set while the epoch is idle switches it to Silero at once', () => {
    const frames = frames16k(fixture('vowel_f0-140'));
    const run = newCore();
    run.core.reset(1, 'silero');
    feed(run, 1, frames.slice(0, 5)); // lead silence: the segmenter is idle
    const spy = new SpyModel();
    run.core.setModel(spy);
    expect(spy.resets).toBe(1);
    feed(run, 1, frames.slice(5), 5 * SILERO_GRID);
    expect(spy.calls).toBe(frames.length - 5);
    const evs = segs(run.msgs);
    expect(evs.map((e) => e.kind)).toEqual(['start', 'end']);
    for (const e of evs) expect(e.frame % SILERO_GRID).toBe(0);
    const end = evs[1];
    if (end?.kind !== 'end') throw new Error('unreachable');
    expect(end.frame - end.lastSpeechFrame).toBeLessThan(0.7 * CTX_RATE); // Silero hangover (energy: ≈ 0.8 s)
    expectSnapshotBeforeStart(run.msgs);
  });

  it('3c: a model set during an active segment leaves the epoch on energy until the next reset', () => {
    const frames = frames16k(fixture('vowel_f0-140'));
    const energy = runFixture('vowel_f0-140').msgs;
    const run = newCore();
    run.core.reset(1, 'silero');
    let k = 0;
    while (!kinds(run.msgs).includes('start')) {
      expect(k).toBeLessThan(frames.length);
      run.core.frame(1, k * SILERO_GRID, frames[k]!);
      k++;
    }
    const spy = new SpyModel();
    run.core.setModel(spy);
    feed(run, 1, frames.slice(k), k * SILERO_GRID);
    expect(spy.calls).toBe(0);
    expect(spy.resets).toBe(0);
    expect(run.msgs.slice(1)).toEqual(energy);
    run.msgs.length = 0;
    run.core.reset(2, 'silero');
    expect(spy.resets).toBe(1);
    feed(run, 2, frames, 10 * CTX_RATE);
    expect(spy.calls).toBe(frames.length);
    expect(ofType(run.msgs, 'error')).toEqual([]);
  });

  it('4: a model that throws on its 3rd call posts error{vad}, and energy processes the later frames', () => {
    let n = 0;
    const thrower: SileroModel = {
      reset: () => undefined,
      process: () => {
        n++;
        if (n === 3) throw new Error('boom');
        return 0;
      },
    };
    const { msgs } = runSilero(frames16k(fixture('vowel_f0-140')), thrower);
    expect(n).toBe(3);
    expect(ofType(msgs, 'error')).toEqual([
      { t: 'error', where: 'vad', message: 'silero failed: boom; using energy' },
    ]);
    expect(segs(msgs)).toEqual(segs(runFixture('vowel_f0-140').msgs));
  });

  it('4b: a model that throws inside a segment closes it with a misfire before energy takes over', () => {
    // 20 frames of −70 dBFS noise, 10 at −20 dBFS (scripted p = 0.9: a Silero start), then 400 quiet frames
    // (12.8 s, longer than the session's recording watchdog). The model throws on the first quiet frame, so
    // the fresh energy segmenter never sees speech and cannot end the open segment itself.
    const rng = mulberry32(61);
    const noiseFrame = (rmsDb: number): Float32Array => {
      const a = Math.sqrt(3) * 10 ** (rmsDb / 20);
      return Float32Array.from({ length: FRAME }, () => (2 * rng() - 1) * a);
    };
    const frames = [
      ...Array.from({ length: 20 }, () => noiseFrame(-70)),
      ...Array.from({ length: 10 }, () => noiseFrame(-20)),
      ...Array.from({ length: 400 }, () => noiseFrame(-70)),
    ];
    const inner = scriptedModel(0.9, 0.1);
    const model: SileroModel = {
      reset: () => undefined,
      process: (x) => {
        if (inner.calls === 30) throw new Error('boom'); // the 31st call: frame 30, the first quiet one
        return inner.process(x);
      },
    };
    const { msgs } = runSilero(frames, model);
    const error: WorkerToMain = { t: 'error', where: 'vad', message: 'silero failed: boom; using energy' };
    expect(ofType(msgs, 'error')).toEqual([error]);
    expect(segs(msgs)).toEqual([
      { kind: 'start', frame: 20 * SILERO_GRID },
      { kind: 'misfire', frame: 30 * SILERO_GRID },
    ]);
    const at = msgs.indexOf(ofType(msgs, 'error')[0]!);
    expect(msgs[at + 1]).toEqual({ t: 'seg', epoch: 1, ev: { kind: 'misfire', frame: 30 * SILERO_GRID } });
  });

  it('5a: the pre-gate makes ≥ 70 % fewer process calls on noise_white_-60dbfs_3s', () => {
    const frames = frames16k(fixture('noise_white_-60dbfs_3s'));
    const off = new SpyModel();
    const on = new SpyModel();
    const a = runSilero(frames, off, false);
    const b = runSilero(frames, on, true);
    expect(off.calls).toBe(frames.length);
    expect(on.calls).toBeLessThanOrEqual(0.3 * off.calls);
    expect(segs(b.msgs)).toEqual(segs(a.msgs));
    expect(segs(a.msgs)).toEqual([]);
  });

  it('5b: vowel_f0-140 gives identical seg events with and without the pre-gate', () => {
    const frames = frames16k(fixture('vowel_f0-140'));
    const off = new SpyModel();
    const on = new SpyModel();
    const a = runSilero(frames, off, false);
    const b = runSilero(frames, on, true);
    expect(segs(b.msgs)).toEqual(segs(a.msgs));
    expect(kinds(a.msgs)).toEqual(['start', 'end']);
    expect(on.calls).toBeLessThan(off.calls);
    expectSnapshotBeforeStart(a.msgs);
    expectSnapshotBeforeStart(b.msgs);
  });

  it('5c: on gate-open the pre-gate replays the last 10 skipped raw frames in order, then the current one', () => {
    const frames = noiseLedVowelFrames();
    const spy = new SpyModel();
    let feeding = -1;
    const calls: { feeding: number; idx: number }[] = [];
    spy.onProcess = (x) => {
      calls.push({ feeding, idx: frames.findIndex((f) => f.every((v, i) => v === x[i])) });
    };
    const run = newCore();
    run.core.setModel(spy);
    run.core.reset(1, 'silero', undefined, true);
    frames.forEach((f, i) => {
      feeding = i;
      run.core.frame(1, i * SILERO_GRID, f);
    });
    // Every processed frame is a raw fed frame, each at most once, in order.
    for (const [j, c] of calls.entries()) {
      expect(c.idx, `call ${j}`).toBeGreaterThanOrEqual(0);
      if (j > 0) expect(c.idx, `call ${j}`).toBeGreaterThan(calls[j - 1]!.idx);
    }
    const byFrame = new Map<number, number[]>();
    for (const c of calls) byFrame.set(c.feeding, [...(byFrame.get(c.feeding) ?? []), c.idx]);
    for (let i = 0; i < PREGATE_HOLD_FRAMES; i++) expect(byFrame.get(i), `frame ${i}`).toEqual([i]);
    expect(frames.some((_, i) => !byFrame.has(i))).toBe(true); // something was skipped
    for (const [j, idx] of byFrame) {
      expect(idx.length).toBeLessThanOrEqual(PREGATE_WARMUP_FRAMES + 1);
      expect(idx, `frame ${j}`).toEqual(Array.from({ length: idx.length }, (_, i) => j - idx.length + 1 + i));
    }
    expect([...byFrame.values()].some((idx) => idx.length === PREGATE_WARMUP_FRAMES + 1)).toBe(true);
    const continuous = runSilero(frames, new SpyModel(), false);
    expect(segs(run.msgs)).toEqual(segs(continuous.msgs));
    expect(segs(run.msgs).length).toBeGreaterThan(0);
  });

  it('5d: the pre-gate never skips while the segmenter is in a segment', () => {
    const x = concat48(whiteNoise48(41, 1.0, -70), whiteNoise48(42, 0.5, -20), whiteNoise48(43, 3.0, -70));
    const frames = frames16k(x, 0);
    // 0.4 is between the thresholds (0.35, 0.5): once started, the segment stays open through the quiet tail.
    const off = scriptedModel(0.9, 0.4);
    const on = scriptedModel(0.9, 0.4);
    const a = runSilero(frames, off, false);
    const b = runSilero(frames, on, true);
    expect(on.calls).toBe(frames.length);
    expect(segs(b.msgs)).toEqual(segs(a.msgs));
    expect(kinds(a.msgs)).toEqual(['start']);
  });

  it("5e': the hop that initialises the floor after digital silence opens the pre-gate", () => {
    // 16 kHz frames built directly: 70 zero frames, 32 frames of −20 dBFS noise starting on a hop boundary
    // (70 · 512 = 224 · 160), 50 zero frames. Without the rule the floor would initialise at the noise level and
    // the gate would never open, so Silero would never see the noise. The proximity gate is off (X = −∞): the
    // floor initialises at the burst's own level, so with the default X the segment would end as a misfire.
    const rng = mulberry32(51);
    const a = Math.sqrt(3) * 0.1;
    const frames = Array.from({ length: 152 }, (_, k) =>
      k >= 70 && k < 102
        ? Float32Array.from({ length: FRAME }, () => (2 * rng() - 1) * a)
        : new Float32Array(FRAME),
    );
    const off = scriptedModel(0.9, 0.1);
    const on = scriptedModel(0.9, 0.1);
    const r0 = runSilero(frames, off, false, Number.NEGATIVE_INFINITY);
    const r1 = runSilero(frames, on, true, Number.NEGATIVE_INFINITY);
    expect(segs(r1.msgs)).toEqual(segs(r0.msgs));
    expect(kinds(r0.msgs)).toEqual(['start', 'end']);
    expect(on.calls).toBeLessThan(off.calls);
    // Default X: the floor initialised on the burst's own first hop (D7 edge).
    expect(kinds(runSilero(frames, scriptedModel(0.9, 0.1), false).msgs)).toEqual(['start', 'misfire']);
  });

  it('5f: reset empties the pre-gate ring: no frame of an earlier epoch is ever replayed', () => {
    const spy = new SpyModel();
    const seen: Float32Array[] = [];
    spy.onProcess = (x) => seen.push(x);
    const run = newCore();
    run.core.setModel(spy);
    run.core.reset(1, 'silero', undefined, true);
    feed(
      run,
      1,
      Array.from({ length: 40 }, () => new Float32Array(FRAME)),
    ); // 18 skipped: the ring is full
    expect(spy.calls).toBe(PREGATE_HOLD_FRAMES);
    run.core.reset(2, 'silero', undefined, true);
    const next = noiseLedVowelFrames()[0]!;
    seen.length = 0;
    run.core.frame(2, 0, next);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(next);
  });

  it('5g: the hold is exactly PREGATE_HOLD_FRAMES (22) closed frames', () => {
    expect(PREGATE_HOLD_FRAMES).toBe(22);
    const spy = new SpyModel();
    const fed: number[] = [];
    let cur = -1;
    spy.onProcess = () => fed.push(cur);
    const run = newCore();
    run.core.setModel(spy);
    run.core.reset(1, 'silero', undefined, true);
    for (let k = 0; k < 40; k++) {
      cur = k;
      run.core.frame(1, k * SILERO_GRID, new Float32Array(FRAME));
    }
    expect(fed).toEqual(Array.from({ length: PREGATE_HOLD_FRAMES }, (_, k) => k));
  });

  it('6: every reset() of a new epoch resets the LSTM state', () => {
    const spy = new SpyModel();
    const run = newCore();
    run.core.setModel(spy);
    run.core.reset(1, 'silero');
    expect(spy.resets).toBe(1);
    feed(run, 1, frames16k(fixture('vowel_f0-140')).slice(0, 20));
    run.core.reset(2, 'silero');
    expect(spy.resets).toBe(2);
    run.core.reset(3, 'energy');
    expect(spy.resets).toBe(3);
  });

  it('8: vadStats is posted after every 312 inferences, with the p95 of the last 312 times', () => {
    let t = 0;
    let i = 0;
    const clocked: SileroModel = {
      reset: () => undefined,
      process: () => {
        i++;
        // 0.01 … 3.12 ms in the first window, 10.01 … 13.12 ms after it.
        t += (i > VAD_STATS_WINDOW ? 10 : 0) + (((i - 1) % VAD_STATS_WINDOW) + 1) / 100;
        return 0;
      },
    };
    const run = newCore(CTX_RATE, { now: () => t });
    run.core.setModel(clocked);
    run.core.reset(1, 'silero');
    const zeros = new Float32Array(FRAME);
    let k = 0;
    const feedN = (n: number): void => {
      for (let j = 0; j < n; j++, k++) run.core.frame(1, k * SILERO_GRID, zeros);
    };
    expect(VAD_STATS_WINDOW).toBe(312);
    feedN(311);
    expect(ofType(run.msgs, 'vadStats')).toEqual([]);
    feedN(1);
    const first = ofType(run.msgs, 'vadStats');
    expect(first).toHaveLength(1);
    expect(Number.isFinite(first[0]!.p95Ms)).toBe(true);
    expect(first[0]!.p95Ms).toBeCloseTo(2.97, 9); // nearest rank: the 297th of 0.01 … 3.12
    feedN(312);
    const both = ofType(run.msgs, 'vadStats');
    expect(both).toHaveLength(2);
    expect(both[1]!.p95Ms).toBeCloseTo(12.97, 9); // only the last 312 times count
  });
});

// ---- Proximity gate on Silero segments (T36) ----

/** Frames of the proximity scenes: a lead of steady noise, the burst (the stub's speech), a tail for the hangover. */
const LEAD = 40;
const BURST = 30;
const TAIL = 40;

/**
 * 16 kHz frames of seeded white noise, built directly (no resampling): `lead` frames at `floorDb` dBFS, `burst`
 * frames `aboveDb` louder, then `tail` frames at `floorDb`.
 */
function burstFrames(
  seed: number,
  floorDb: number,
  aboveDb: number,
  lead: number,
  burst: number,
  tail: number,
): Float32Array[] {
  const rng = mulberry32(seed);
  return Array.from({ length: lead + burst + tail }, (_, k) => {
    const db = k >= lead && k < lead + burst ? floorDb + aboveDb : floorDb;
    const a = Math.sqrt(3) * 10 ** (db / 20);
    return Float32Array.from({ length: FRAME }, () => (2 * rng() - 1) * a);
  });
}

/** A stub model: p = 0.9 on its calls [from, to), else 0.1. With the pre-gate off, call k is frame k. */
function burstModel(from: number, to: number): SileroModel {
  let k = 0;
  return {
    reset: () => undefined,
    process: () => {
      const i = k++;
      return i >= from && i < to ? 0.9 : 0.1;
    },
  };
}

/**
 * The proximity margin of the one Silero segment in `msgs` (a run with the gate off), recomputed outside the
 * core: the power mean of the band-limited hop levels whose ctx frame lies in [start.frame, lastSpeechFrame +
 * one frame), minus the floorSnapshot. `frames` start at ctx frame 0, so hop h starts at ctx frame 480·h.
 */
function proximityMargin(frames: Float32Array[], msgs: WorkerToMain[]): number {
  const filter = createGateFilter(16000);
  const x = new Float32Array(frames.length * FRAME);
  frames.forEach((f, k) => filter.process(f, x.subarray(k * FRAME, (k + 1) * FRAME)));
  const hopCtx = ENERGY_HOP * 3;
  const hopDb = Float32Array.from({ length: Math.floor(x.length / ENERGY_HOP) }, (_, h) =>
    frameDb(x, h * ENERGY_HOP, (h + 1) * ENERGY_HOP),
  );
  const [start, end] = segs(msgs);
  if (start?.kind !== 'start' || end?.kind !== 'end') throw new Error('expected one start and one end');
  const from = Math.ceil(start.frame / hopCtx);
  const to = Math.ceil((end.lastSpeechFrame + SILERO_GRID) / hopCtx);
  const floor = ofType(msgs, 'floorSnapshot')[0]!.floorDb;
  return activeLevelDb(hopDb, from, to) - floor;
}

describe('VadCore proximity gate (Silero segments)', () => {
  it('a burst 12 dB above a steady noise floor passes with X = 6 and is a misfire with X = 15', () => {
    const frames = burstFrames(71, -50, 12, LEAD, BURST, TAIL);
    const pass = runSilero(frames, burstModel(LEAD, LEAD + BURST), false, 6);
    const fail = runSilero(frames, burstModel(LEAD, LEAD + BURST), false, 15);
    const evs = segs(pass.msgs);
    expect(evs).toEqual([
      { kind: 'start', frame: LEAD * SILERO_GRID },
      {
        kind: 'end',
        frame: evs[1]?.frame,
        lastSpeechFrame: (LEAD + BURST - 1) * SILERO_GRID,
        reason: 'silence',
      },
    ]);
    expectSnapshotBeforeStart(pass.msgs);
    // X = 15: the very same messages, with the end replaced by a misfire at its frame.
    const misfire: WorkerToMain = { t: 'seg', epoch: 1, ev: { kind: 'misfire', frame: evs[1]!.frame } };
    expect(fail.msgs).toEqual(pass.msgs.map((m) => (m.t === 'seg' && m.ev.kind === 'end' ? misfire : m)));
    expect(proximityMargin(frames, pass.msgs)).toBeGreaterThan(6);
  });

  it('X is compared with the power mean over the speech frames’ hops minus the onset floor, exactly', () => {
    const frames = burstFrames(72, -50, 8, LEAD, BURST, TAIL);
    const off = runSilero(frames, burstModel(LEAD, LEAD + BURST), false, Number.NEGATIVE_INFINITY);
    const m = proximityMargin(frames, off.msgs);
    expect(m).toBeGreaterThan(6);
    expect(m).toBeLessThan(10);
    const at = (x: number): string[] =>
      kinds(runSilero(frames, burstModel(LEAD, LEAD + BURST), false, x).msgs);
    expect(at(m - 1e-6)).toEqual(['start', 'end']);
    expect(at(m + 1e-6)).toEqual(['start', 'misfire']);
  });

  it('maxLength ends are gated the same way (a 10 s segment: the history keeps its last 1000 hops)', () => {
    expect(PROXIMITY_HISTORY_HOPS).toBe(1000);
    const burst = 313; // 313 · 32 ms ≥ 10 s: the segment ends by maxLength on the burst's last frame
    const frames = burstFrames(73, -50, 12, LEAD, burst, TAIL);
    const pass = runSilero(frames, burstModel(LEAD, LEAD + burst), false, 6);
    const fail = runSilero(frames, burstModel(LEAD, LEAD + burst), false, 15);
    const end = { kind: 'end', frame: (LEAD + burst - 1) * SILERO_GRID, reason: 'maxLength' } as const;
    expect(segs(pass.msgs)).toEqual([
      { kind: 'start', frame: LEAD * SILERO_GRID },
      { ...end, lastSpeechFrame: end.frame },
    ]);
    expect(segs(fail.msgs)).toEqual([
      { kind: 'start', frame: LEAD * SILERO_GRID },
      { kind: 'misfire', frame: end.frame },
    ]);
  });

  it('reset without proximityDb (or with NaN) uses PROXIMITY_DB = 3 dB; a given X overrides it', () => {
    expect(PROXIMITY_DB).toBe(3);
    // Bursts with margins just below and just above 3 dB (≈ 2.76 and ≈ 3.26, measured with the gate off).
    for (const [seed, aboveDb, want] of [
      [74, 1.75, 'misfire'],
      [75, 2.5, 'end'],
    ] as const) {
      const frames = burstFrames(seed, -50, aboveDb, LEAD, BURST, TAIL);
      const run = (x?: number): Run => runSilero(frames, burstModel(LEAD, LEAD + BURST), false, x);
      const m = proximityMargin(frames, run(Number.NEGATIVE_INFINITY).msgs);
      expect(Math.abs(m - PROXIMITY_DB), `margin ${m}`).toBeLessThan(0.5);
      expect(m >= PROXIMITY_DB ? 'end' : 'misfire').toBe(want);
      expect(kinds(run().msgs)).toEqual(['start', want]);
      expect(kinds(run(Number.NaN).msgs)).toEqual(['start', want]);
      expect(run().msgs).toEqual(run(PROXIMITY_DB).msgs);
      expect(kinds(run(m - 0.01).msgs)).toEqual(['start', 'end']);
      expect(kinds(run(m + 0.01).msgs)).toEqual(['start', 'misfire']);
    }
  });

  it('the override is per epoch: the next reset without it returns to the default', () => {
    const frames = burstFrames(71, -50, 12, LEAD, BURST, TAIL);
    const run = newCore();
    const model = burstModel(LEAD, LEAD + BURST);
    run.core.setModel(model);
    run.core.reset(1, 'silero', undefined, false, 15);
    feed(run, 1, frames);
    expect(kinds(run.msgs)).toEqual(['start', 'misfire']);
    run.msgs.length = 0;
    run.core.setModel(burstModel(LEAD, LEAD + BURST));
    run.core.reset(2, 'silero');
    feed(run, 2, frames, 10 * CTX_RATE);
    expect(kinds(run.msgs)).toEqual(['start', 'end']);
  });

  it('a segment with no floor at its onset (only digital silence before it) always passes', () => {
    const frames = Array.from({ length: LEAD + BURST + TAIL }, () => new Float32Array(FRAME));
    const { msgs } = runSilero(frames, burstModel(LEAD, LEAD + BURST), false, 1000);
    expect(ofType(msgs, 'floorSnapshot')).toEqual([{ t: 'floorSnapshot', epoch: 1, floorDb: Number.NaN }]);
    expect(kinds(msgs)).toEqual(['start', 'end']);
  });

  it('each segment of an epoch is gated against its own onset floor', () => {
    // One epoch, two segments: a −28 dBFS burst over −40 dBFS noise, then a −50 dBFS burst after the noise has
    // dropped to −60 dBFS. The second is ≈ 10 dB above its own onset floor but below the first segment's.
    const rng = mulberry32(81);
    const parts = [
      [40, -40],
      [30, -28],
      [40, -40],
      [40, -60],
      [30, -50],
      [40, -60],
    ] as const;
    const frames = parts.flatMap(([n, db]) => {
      const a = Math.sqrt(3) * 10 ** (db / 20);
      return Array.from({ length: n }, () => Float32Array.from({ length: FRAME }, () => (2 * rng() - 1) * a));
    });
    let k = 0;
    const model: SileroModel = {
      reset: () => undefined,
      process: () => {
        const i = k++;
        return (i >= 40 && i < 70) || (i >= 150 && i < 180) ? 0.9 : 0.1;
      },
    };
    const { msgs } = runSilero(frames, model, false, 6);
    expect(kinds(msgs)).toEqual(['start', 'end', 'start', 'end']);
  });

  it('the energy backend is not gated: proximityDb changes nothing there', () => {
    const energy = runFixture('vowel_f0-140').msgs;
    expect(kinds(energy)).toEqual(['start', 'end']);
    const run = newCore();
    run.core.reset(1, 'energy', undefined, false, 1000);
    feed(run, 1, frames16k(fixture('vowel_f0-140')));
    expect(run.msgs).toEqual(energy);
    const fallback = newCore(); // Silero asked for, no model: the epoch runs on energy
    fallback.core.reset(1, 'silero', undefined, false, 1000);
    feed(fallback, 1, frames16k(fixture('vowel_f0-140')));
    expect(fallback.msgs.slice(1)).toEqual(energy);
  });
});

describe('VadCore energy voicing rule', () => {
  it('7: a 300 ms white-noise burst at −20 dBFS gives misfire, not end', () => {
    expect(MIN_VOICED_MS).toBe(60);
    const x = concat48(whiteNoise48(21, 1.0, -70), whiteNoise48(22, 0.3, -20), whiteNoise48(23, 0.3, -70));
    const run = newCore();
    run.core.reset(1, 'energy');
    feed(run, 1, frames16k(x));
    const evs = segs(run.msgs);
    expect(evs.map((e) => e.kind)).toEqual(['start', 'misfire']);
    // ≥ 200 ms of speech before the 800 ms hangover: not the 150 ms minimum-speech rule, the voicing rule.
    expect(evs[1]!.frame - evs[0]!.frame).toBeGreaterThanOrEqual(1.0 * CTX_RATE);
  });

  it('7b: a maxLength end without voicing is a misfire too', () => {
    const x = concat48(whiteNoise48(31, 1.0, -70), whiteNoise48(32, 10.5, -20));
    const run = newCore();
    run.core.reset(1, 'energy');
    feed(run, 1, frames16k(x));
    const evs = segs(run.msgs);
    expect(evs.slice(0, 2).map((e) => e.kind)).toEqual(['start', 'misfire']);
    expect(Math.abs(evs[1]!.frame - evs[0]!.frame - 10 * CTX_RATE)).toBeLessThanOrEqual(0.05 * CTX_RATE);
  });
});

describe('defaults', () => {
  it("9: the engine's VAD backend is still 'energy' and the pre-gate is off", () => {
    expect(DEFAULT_VAD_BACKEND).toBe('energy');
    expect(PREGATE_ENABLED).toBe(false);
  });
});

// ---- Allocation meters (copied from src/dsp/silero/model.test.ts) ----

type Constructor = new (...args: never[]) => object;

/** Wraps `original` so that every `new` of it, including those inside its static `from` and `of`, calls `onNew`. */
function countingConstructor<C extends Constructor>(original: C, onNew: () => void): C {
  return new Proxy(original, {
    construct(target, args: never[], newTarget: Constructor): object {
      onNew();
      return Reflect.construct(target, args, newTarget);
    },
  });
}

/** `%TypedArray%.prototype`, which every typed array class inherits its methods from. */
const TYPED_ARRAY_PROTOTYPE = Reflect.getPrototypeOf(Float32Array.prototype) ?? Float32Array.prototype;
/** Its methods that return a new typed array. */
const TYPED_ARRAY_METHODS = ['slice', 'map', 'filter', 'subarray', 'toReversed', 'toSorted', 'with'] as const;

/**
 * Runs `fn` and counts the allocations it makes through the array globals (a copy of src/anim/clip.test.ts's
 * meter): every `new` of `Array`, `ArrayBuffer`, `Float32Array` or `Float64Array` (static `from` and `of`
 * included, and `new` through a typed array's `constructor`), and every call of an allocating
 * `%TypedArray%.prototype` method. Everything is restored afterwards.
 */
function countAllocations(fn: () => void): number {
  let count = 0;
  const onNew = (): void => {
    count++;
  };
  const saved: { obj: object; key: string; desc: PropertyDescriptor }[] = [];
  const patch = (obj: object, key: string, value: unknown): void => {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc === undefined) throw new Error(`nothing to patch at ${key}`);
    saved.push({ obj, key, desc });
    Object.defineProperty(obj, key, { ...desc, value });
  };
  const float32 = countingConstructor(Float32Array, onNew);
  const float64 = countingConstructor(Float64Array, onNew);
  patch(Float32Array.prototype, 'constructor', float32);
  patch(Float64Array.prototype, 'constructor', float64);
  patch(globalThis, 'Array', countingConstructor(Array, onNew));
  patch(globalThis, 'ArrayBuffer', countingConstructor(ArrayBuffer, onNew));
  patch(globalThis, 'Float32Array', float32);
  patch(globalThis, 'Float64Array', float64);
  for (const name of TYPED_ARRAY_METHODS) {
    const original: unknown = Reflect.get(TYPED_ARRAY_PROTOTYPE, name);
    if (typeof original !== 'function') throw new Error(`no %TypedArray%.prototype.${name}`);
    patch(TYPED_ARRAY_PROTOTYPE, name, function (this: unknown, ...args: unknown[]): unknown {
      count++;
      return Reflect.apply(original, this, args);
    });
  }
  try {
    fn();
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) {
      const { obj, key, desc } = saved[i]!;
      Object.defineProperty(obj, key, desc);
    }
  }
  return count;
}

/** The `gc` function, exposed once at runtime with Node built-ins only (no `--expose-gc` flag needed). */
let exposedGc: (() => void) | undefined;

/** Runs a full garbage collection. */
function forceGc(): void {
  if (exposedGc === undefined) {
    setFlagsFromString('--expose-gc');
    const gc: unknown = runInNewContext('gc');
    if (typeof gc !== 'function') throw new Error('gc() is not available');
    exposedGc = (): void => {
      gc();
    };
  }
  exposedGc();
}

/**
 * `heapUsed` growth in bytes over `fn`, measured from a freshly collected heap. If any GC ran during `fn`,
 * the reading is meaningless (a scavenge frees the garbage it should count), so it returns +Infinity.
 */
function heapGrowth(fn: () => void): number {
  forceGc();
  const profiler = new GCProfiler();
  profiler.start();
  const before = process.memoryUsage().heapUsed;
  fn();
  const growth = process.memoryUsage().heapUsed - before;
  return profiler.stop().statistics.length > 0 ? Number.POSITIVE_INFINITY : growth;
}

/** The one `post` of every core in the allocation tests, so the call site sees a single closure. */
const NOOP_POST = (): void => {};

/** A core on `vad` (with a real model for Silero) warmed up on 60 frames, and a stepper for more. */
function stepper(frames: Float32Array[], vad: 'silero' | 'energy', pregate: boolean): () => void {
  const core = new VadCore(CTX_RATE, NOOP_POST);
  if (vad === 'silero') core.setModel(createSilero(W));
  core.reset(1, vad, undefined, pregate);
  let k = 0;
  const step = (): void => {
    core.frame(1, k * SILERO_GRID, frames[k % frames.length]!);
    k++;
  };
  for (let i = 0; i < 60; i++) step();
  return step;
}

/** Runs of 1000 frames of noise_white_-60dbfs_3s on Silero with `model`, after 400 warm-up frames. */
function heapRunner(model: SileroModel, pregate: boolean): () => void {
  const frames = frames16k(fixture('noise_white_-60dbfs_3s'), 0);
  const core = new VadCore(CTX_RATE, NOOP_POST);
  core.setModel(model);
  core.reset(1, 'silero', -75, pregate);
  let k = 0;
  const run = (n: number): void => {
    for (let i = 0; i < n; i++, k++) core.frame(1, k * SILERO_GRID, frames[k % frames.length]!);
  };
  run(400);
  return () => run(1000);
}

/** The smallest finite growth over up to 20 runs, stopping early once `done(best)`. */
function bestGrowth(run: () => void, done: (best: number) => boolean = () => false): number {
  let best = Number.POSITIVE_INFINITY;
  for (let trial = 0; trial < 20 && !(Number.isFinite(best) && done(best)); trial++) {
    best = Math.min(best, heapGrowth(run));
  }
  expect(Number.isFinite(best)).toBe(true);
  return best;
}

describe('no allocation on the per-frame path', () => {
  /** 64 B per frame over 1000 frames. */
  const LIMIT = 65_536;

  it.each([
    ['silero', false],
    ['silero', true],
    ['energy', false],
  ] as const)(
    '%s (pregate %s) makes no array allocation over 200 frames (skips and a warm-up included)',
    (vad, pregate) => {
      const step = stepper(noiseLedVowelFrames(), vad, pregate);
      expect(
        countAllocations(() => {
          for (let i = 0; i < 200; i++) step();
        }),
      ).toBe(0);
    },
  );

  it.each([false, true])(
    'the Silero path (pregate %s) grows the heap < 64 KB per 1000 frames more than a zero model',
    { timeout: 120_000 },
    (pregate) => {
      const zero = bestGrowth(heapRunner(zeroModel(), pregate));
      const real = bestGrowth(heapRunner(createSilero(W), pregate), (b) => b - zero < LIMIT);
      expect(real - zero).toBeLessThan(LIMIT);
    },
  );

  it('both meters have teeth (positive controls)', { timeout: 120_000 }, () => {
    const frame = noiseLedVowelFrames()[0]!;
    expect(countAllocations(() => void frame.subarray(1))).toBeGreaterThan(0);
    const kept = Array.from<Float32Array | undefined>({ length: 1000 });
    const leaky = new SpyModel();
    leaky.onProcess = (x) => {
      kept[leaky.calls % 1000] = x.subarray(1);
    };
    const zero = bestGrowth(heapRunner(zeroModel(), false));
    // Retry until a run is GC-free: +Infinity alone would pass the bound without proving anything.
    const leak = bestGrowth(heapRunner(leaky, false), () => true);
    expect(kept.every((v) => v !== undefined)).toBe(true);
    expect(leak - zero).toBeGreaterThanOrEqual(LIMIT);
  });
});

// ---- Worker glue (dsp.worker.ts) with a fake `self` and a fake MessagePort ----

type Listener = (e: { data: unknown }) => void;

class FakeTarget {
  readonly listeners: Listener[] = [];
  addEventListener(type: string, fn: Listener): void {
    if (type === 'message') this.listeners.push(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    const i = this.listeners.indexOf(fn);
    if (type === 'message' && i >= 0) this.listeners.splice(i, 1);
  }
  dispatch(data: unknown): void {
    for (const fn of this.listeners) fn({ data });
  }
}

class FakeSelf extends FakeTarget {
  readonly posted: { msg: WorkerToMain; transfer: Transferable[] }[] = [];
  postMessage(msg: WorkerToMain, transfer: Transferable[]): void {
    this.posted.push({ msg, transfer });
  }
}

class FakePort extends FakeTarget {
  started = false;
  closed = false;
  start(): void {
    this.started = true;
  }
  close(): void {
    this.closed = true;
  }
}

describe('dsp.worker glue', () => {
  let self: FakeSelf;
  /** The worker's `fetch` (of weights.bin): by default it never settles, so no load result arrives. */
  let fetchStub: Mock<(input: unknown) => Promise<Response>>;
  const sent = (): WorkerToMain[] => self.posted.map((p) => p.msg);

  beforeEach(async () => {
    vi.resetModules();
    self = new FakeSelf();
    vi.stubGlobal('self', self);
    fetchStub = vi.fn((_input: unknown) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchStub);
    await import('./dsp.worker.ts');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('process echoes the pcm with durationSec = len / sr / 1.6 for the cub preset', () => {
    const pcm = new Float32Array(24000).fill(0.25);
    self.dispatch({ t: 'process', id: 7, pcm, sampleRate: 48000, preset: PRESETS.cub });
    expect(self.posted).toHaveLength(1);
    const { msg, transfer } = self.posted[0]!;
    if (msg.t !== 'processed') throw new Error(`unexpected ${msg.t}`);
    expect(msg.id).toBe(7);
    expect(msg.pcm).toBe(pcm);
    expect(msg.durationSec).toBeCloseTo(24000 / 48000 / 1.6, 12);
    expect(msg.envelope.hopMs).toBe(10);
    for (const track of [msg.envelope.jaw, msg.envelope.width, msg.envelope.round, msg.envelope.teeth]) {
      expect(track).toHaveLength(0);
    }
    expect(transfer).toContain(pcm.buffer);
  });

  it('init wires the port to a VadCore; reset and frames produce seg messages via self.postMessage', () => {
    const port = new FakePort();
    self.dispatch({ t: 'init', ctxRate: CTX_RATE, port });
    expect(port.started).toBe(true);
    self.dispatch({ t: 'reset', epoch: 9, vad: 'energy' });
    frames16k(fixture('vowel_f0-140')).forEach((pcm16k, i) =>
      port.dispatch({ t: 'frame', epoch: 9, firstFrame: Math.round(i * FRAME * 3), pcm16k }),
    );
    const posted = self.posted.map((p) => p.msg);
    expect(kinds(posted)).toEqual(['start', 'end']);
    expect(ofType(posted, 'floorSnapshot')).toHaveLength(1);
    expect(levels(posted).length).toBeGreaterThan(0);
  });

  it('a later init closes the previous port and detaches it', () => {
    const first = new FakePort();
    const second = new FakePort();
    self.dispatch({ t: 'init', ctxRate: CTX_RATE, port: first });
    self.dispatch({ t: 'init', ctxRate: CTX_RATE, port: second });
    expect(first.closed).toBe(true);
    expect(first.listeners).toHaveLength(0);
    expect(second.listeners).toHaveLength(1);
  });

  it('a failed init closes the new port and keeps the previous wiring', () => {
    const good = new FakePort();
    const bad = new FakePort();
    self.dispatch({ t: 'init', ctxRate: CTX_RATE, port: good });
    self.dispatch({ t: 'init', ctxRate: Number.NaN, port: bad });
    expect(bad.closed).toBe(true);
    expect(bad.listeners).toHaveLength(0);
    expect(good.closed).toBe(false);
    expect(good.listeners).toHaveLength(1);
    const errors = ofType(
      self.posted.map((p) => p.msg),
      'error',
    );
    expect(errors.map((m) => m.where)).toEqual(['vad']);
  });

  it('init loads weights.bin once, sets the model and posts vadReady; Silero epochs then run on it', async () => {
    fetchStub.mockImplementation(() => Promise.resolve(new Response(weightsBuffer())));
    const port = new FakePort();
    self.dispatch({ t: 'init', ctxRate: CTX_RATE, port });
    await vi.waitFor(() => expect(ofType(sent(), 'vadReady')).toHaveLength(1));
    expect(ofType(sent(), 'vadReady')).toEqual([{ t: 'vadReady', backend: 'silero' }]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(String(fetchStub.mock.calls[0]?.[0])).toMatch(/\/src\/dsp\/silero\/weights\.bin$/);
    self.dispatch({ t: 'reset', epoch: 9, vad: 'silero', pregate: false });
    const frames = frames16k(fixture('vowel_f0-140'));
    frames.forEach((pcm16k, i) =>
      port.dispatch({ t: 'frame', epoch: 9, firstFrame: i * SILERO_GRID, pcm16k }),
    );
    expect(ofType(sent(), 'error')).toEqual([]);
    expect(segs(sent())).toEqual(segs(runSilero(frames, createSilero(W)).msgs));
    // A later init reuses the loaded model: vadReady again, no second fetch.
    self.dispatch({ t: 'init', ctxRate: CTX_RATE, port: new FakePort() });
    expect(ofType(sent(), 'vadReady')).toHaveLength(2);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a rejected fetch', (): Promise<Response> => Promise.reject(new TypeError('network down'))],
    ['an HTTP 404', (): Promise<Response> => Promise.resolve(new Response(null, { status: 404 }))],
  ])(
    '%s posts error{vad} and no vadReady; Silero epochs run on energy; the next init retries',
    async (_name, impl) => {
      fetchStub.mockImplementation(impl);
      self.dispatch({ t: 'init', ctxRate: CTX_RATE, port: new FakePort() });
      await vi.waitFor(() => expect(ofType(sent(), 'error')).toHaveLength(1));
      const err = ofType(sent(), 'error')[0]!;
      expect(err.where).toBe('vad');
      expect(err.message.startsWith('silero weights failed to load: ')).toBe(true);
      expect(ofType(sent(), 'vadReady')).toEqual([]);
      self.posted.length = 0;
      const port = new FakePort();
      self.dispatch({ t: 'init', ctxRate: CTX_RATE, port }); // retries the load
      expect(fetchStub).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(ofType(sent(), 'error')).toHaveLength(1));
      self.posted.length = 0;
      self.dispatch({ t: 'reset', epoch: 3, vad: 'silero' });
      expect(sent()).toEqual([{ t: 'error', where: 'vad', message: SILERO_NOT_READY_MESSAGE }]);
      frames16k(fixture('vowel_f0-140')).forEach((pcm16k, i) =>
        port.dispatch({ t: 'frame', epoch: 3, firstFrame: i * SILERO_GRID, pcm16k }),
      );
      expect(segs(sent())).toEqual(segs(runFixture('vowel_f0-140').msgs));
    },
  );

  it('cold start: a Silero epoch armed before the weights arrive switches to Silero when they do', async () => {
    let resolve: ((r: Response) => void) | undefined;
    fetchStub.mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const port = new FakePort();
    self.dispatch({ t: 'init', ctxRate: CTX_RATE, port });
    self.dispatch({ t: 'reset', epoch: 9, vad: 'silero', pregate: false });
    expect(sent()).toEqual([{ t: 'error', where: 'vad', message: SILERO_NOT_READY_MESSAGE }]);
    const frames = frames16k(fixture('vowel_f0-140'));
    const send = (i: number): void => {
      port.dispatch({ t: 'frame', epoch: 9, firstFrame: i * SILERO_GRID, pcm16k: frames[i]! });
    };
    for (let i = 0; i < 5; i++) send(i); // lead silence, on energy
    if (resolve === undefined) throw new Error('fetch was not called');
    resolve(new Response(weightsBuffer()));
    await vi.waitFor(() => expect(ofType(sent(), 'vadReady')).toHaveLength(1));
    for (let i = 5; i < frames.length; i++) send(i);
    const evs = segs(sent());
    expect(evs.map((e) => e.kind)).toEqual(['start', 'end']);
    for (const e of evs) expect(e.frame % SILERO_GRID).toBe(0);
    expect(ofType(sent(), 'error')).toHaveLength(1); // only the not-ready one
  });

  it('reset forwards restoreFloorDb, pregate and proximityDb to the VadCore', async () => {
    const { VadCore: WorkerCore } = await import('./vad-core.ts'); // the worker's instance of the module
    const reset = vi.spyOn(WorkerCore.prototype, 'reset');
    self.dispatch({ t: 'init', ctxRate: CTX_RATE, port: new FakePort() });
    self.dispatch({
      t: 'reset',
      epoch: 2,
      vad: 'silero',
      restoreFloorDb: -50,
      pregate: true,
      proximityDb: 9,
    });
    expect(reset).toHaveBeenCalledWith(2, 'silero', -50, true, 9);
  });

  it('turns handler exceptions into error messages', () => {
    self.dispatch({ t: 'reset', epoch: 1, vad: 'energy' });
    self.dispatch({ t: 'init', ctxRate: Number.NaN, port: new FakePort() });
    const port = new FakePort();
    self.dispatch({ t: 'init', ctxRate: CTX_RATE, port });
    self.dispatch({ t: 'reset', epoch: 1, vad: 'energy' });
    port.dispatch({ t: 'frame', epoch: 1, firstFrame: 0, pcm16k: new Float32Array(3) });
    self.dispatch({ t: 'process', id: 1, pcm: new Float32Array(4), sampleRate: 48000 });
    const errors = ofType(
      self.posted.map((p) => p.msg),
      'error',
    );
    expect(errors.map((m) => m.where)).toEqual(['vad', 'vad', 'vad', 'fx']);
    expect(errors[0]!.message).toBe('reset before init');
  });
});
