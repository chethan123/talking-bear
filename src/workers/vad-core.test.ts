// VadCore (energy backend) driven by the synthetic fixtures, plus a smoke test of the worker glue.
// Fixtures are 48 kHz; like the capture worklet, the test decimates them to 16 kHz and feeds 512-sample
// frames tagged with the ctx frame of their first sample (ctxRate 48000, so frame i starts at i·512·3).

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWav } from '../../test/wav.ts';
import type { WorkerToMain } from '../audio/messages.ts';
import { resampleOffline } from '../dsp/resample.ts';
import type { SegEvent } from '../dsp/segmenter.ts';
import { PRESETS } from '../dsp/types.ts';
import { SILERO_UNAVAILABLE_MESSAGE, VadCore } from './vad-core.ts';

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

/** The 16 kHz signal cut into 512-sample frames: the last partial frame is zero-filled, then PAD_FRAMES
 *  zero frames follow. Each frame is its own buffer, like a transferred worklet frame. */
function frames16k(x48: Float32Array): Float32Array[] {
  const x16 = resampleOffline(x48, 1 / 3);
  const n = Math.ceil(x16.length / FRAME) + PAD_FRAMES;
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

function newCore(ctxRate = CTX_RATE): Run {
  const msgs: WorkerToMain[] = [];
  return { core: new VadCore(ctxRate, (m) => msgs.push(m)), msgs };
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
    const a = newCore();
    a.core.reset(1, 'energy');
    feed(a, 1, frames.slice(0, 70)); // stop mid-utterance, with a hop remainder pending
    a.core.reset(2, 'energy');
    a.msgs.length = 0;
    feed(a, 2, frames, 777);
    const b = newCore();
    b.core.reset(2, 'energy');
    feed(b, 2, frames, 777);
    expect(a.msgs).toEqual(b.msgs);
  });

  it("reset(e, 'silero') posts the M1 error and continues with energy", () => {
    const run = newCore();
    run.core.reset(3, 'silero');
    expect(run.msgs).toEqual([{ t: 'error', where: 'vad', message: SILERO_UNAVAILABLE_MESSAGE }]);
    expect(SILERO_UNAVAILABLE_MESSAGE).toBe('silero backend not available in M1; using energy');
    feed(run, 3, frames16k(fixture('vowel_f0-140')));
    expect(kinds(run.msgs)).toEqual(['start', 'end']);
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

  beforeEach(async () => {
    vi.resetModules();
    self = new FakeSelf();
    vi.stubGlobal('self', self);
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

  it('turns handler exceptions into error messages', () => {
    self.dispatch({ t: 'reset', epoch: 1, vad: 'energy' });
    const port = new FakePort();
    self.dispatch({ t: 'init', ctxRate: Number.NaN, port });
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
