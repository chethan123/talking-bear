// Node tests of the capture AudioWorklet processor (issue #25) against the stub AudioWorkletGlobalScope in
// test/worklet-scope.ts. The module is loaded with `await import(...)` inside each test, after the setup file
// has defined the scope (plan §4.9.1).

import { afterEach, describe, expect, test } from 'vitest';

import { mulberry32, sine, toneLevelDb } from '../../test/dsp-helpers.ts';
import {
  create,
  flushMessages,
  processors,
  QUANTUM,
  runQuanta,
  setSampleRate,
} from '../../test/worklet-scope.ts';
import type { ProcessorLike } from '../../test/worklet-scope.ts';
import { butterworthHighpass } from '../dsp/biquad.ts';
import { resampleOffline } from '../dsp/resample.ts';
import { CHUNK_MAX, HPF_CLIP_HZ, RING_SECONDS, VAD_FRAME, VAD_RATE } from './constants.ts';
import type { MainToWorklet, WorkletToMain, WorkletToWorker } from './messages.ts';

type Chunk = Extract<WorkletToMain, { t: 'clipChunk' }>;
type Frame = WorkletToWorker;

/** Ports the tests open themselves; the scope closes the processors' own ports. */
const testPorts: MessagePort[] = [];
afterEach(() => {
  for (const p of testPorts.splice(0)) p.close();
});

/** Rounds seconds of audio at fs up to whole quanta. */
function quantaLength(seconds: number, fs: number): number {
  return Math.ceil((seconds * fs) / QUANTUM) * QUANTUM;
}

/** A linear ramp from −0.9 to +0.9. */
function linearRamp(n: number): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = -0.9 + (1.8 * i) / n;
  return x;
}

/** A repeating ramp (sawtooth, period 997 frames): every frame differs from its neighbours. */
function sawRamp(n: number): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (i % 997) / 997 - 0.5;
  return x;
}

function noise(n: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rnd() - 0.5;
  return x;
}

/** The capture path's reference: x through a fresh 80 Hz Butterworth high-pass. */
function hpfRef(x: Float32Array, fs: number): Float32Array {
  return butterworthHighpass(fs, HPF_CLIP_HZ).process(x);
}

function concat(parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

/** A capture processor wired like the engine does it: main port listener, worker channel sent by `init`. */
interface Rig {
  proc: ProcessorLike;
  /** Messages received on the main-thread port, in order. */
  main: WorkletToMain[];
  /** Frames received on the worker end of the worklet↔worker channel, in order. */
  frames: Frame[];
  /** currentFrame of the next quantum. */
  next: number;
  send(msg: MainToWorklet, transfer?: Transferable[]): void;
  /** Posts anything, for malformed-message tests. */
  sendRaw(msg: unknown): void;
  /** Runs `input` from `next` on and advances `next`; returns the output buffers. */
  run(input: Float32Array | readonly Float32Array[]): Float32Array[];
}

async function rig(options: { worker?: boolean; startFrame?: number } = {}): Promise<Rig> {
  await import('./capture.worklet.ts');
  const { proc, mainPort } = create('capture');
  const main: WorkletToMain[] = [];
  const frames: Frame[] = [];
  mainPort.addEventListener('message', (e: MessageEvent<WorkletToMain>): void => {
    main.push(e.data);
  });
  mainPort.start();
  const r: Rig = {
    proc,
    main,
    frames,
    next: options.startFrame ?? 0,
    send(msg, transfer = []) {
      mainPort.postMessage(msg, transfer);
    },
    sendRaw(msg) {
      mainPort.postMessage(msg, []);
    },
    run(input) {
      const outs = runQuanta(proc, input, r.next);
      r.next += (input instanceof Float32Array ? input : input[0]!).length;
      return outs;
    },
  };
  if (options.worker !== false) {
    const port = workerPort(frames);
    r.send({ t: 'init', port }, [port]);
  }
  await flushMessages();
  return r;
}

/** A new worklet↔worker channel whose worker end appends to `sink`; returns the worklet end. */
function workerPort(sink: Frame[]): MessagePort {
  const ch = new MessageChannel();
  ch.port2.addEventListener('message', (e: MessageEvent<Frame>): void => {
    sink.push(e.data);
  });
  ch.port2.start();
  testPorts.push(ch.port2);
  return ch.port1;
}

function chunksOf(r: Rig): Chunk[] {
  return r.main.filter((m): m is Chunk => m.t === 'clipChunk');
}

/** seq 0, 1, …; only the final chunk is `last`; every chunk has 1…CHUNK_MAX samples; all of one take. */
function expectWellFormed(chunks: readonly Chunk[], epoch: number, id: number, fs: number): void {
  expect(chunks.length).toBeGreaterThan(0);
  chunks.forEach((c, i) => {
    expect(c.epoch).toBe(epoch);
    expect(c.id).toBe(id);
    expect(c.seq).toBe(i);
    expect(c.last).toBe(i === chunks.length - 1);
    expect(c.pcm.length).toBeGreaterThan(0);
    expect(c.pcm.length).toBeLessThanOrEqual(CHUNK_MAX);
    expect(c.sampleRate).toBe(fs);
  });
}

const FS = 48000;
const RING = RING_SECONDS * FS; // 576 000 frames

test("registers the processor as 'capture'", async () => {
  await import('./capture.worklet.ts');
  expect(processors.get('capture')).toBeTypeOf('function');
});

describe('take', () => {
  test.each([
    ['a linear ramp', linearRamp],
    ['a sawtooth ramp', sawRamp],
  ])(
    'take{from 48000, to 96000} over 3 s of %s equals the input through a fresh 80 Hz high-pass',
    async (_, gen) => {
      const r = await rig();
      const x = gen(3 * FS);
      r.run(x);
      r.send({ t: 'take', epoch: 1, id: 1, fromFrame: 48000, toFrame: 96000 });
      await flushMessages();
      r.run(new Float32Array(4 * QUANTUM));
      await flushMessages();
      const chunks = chunksOf(r);
      expect(r.main.filter((m) => m.t === 'takeFailed')).toEqual([]);
      expectWellFormed(chunks, 1, 1, FS);
      const pcm = concat(chunks.map((c) => c.pcm));
      expect(maxAbsDiff(pcm, hpfRef(x, FS).subarray(48000, 96000))).toBeLessThanOrEqual(1e-6);
    },
  );

  test('a 2.5 s take is streamed as chunks of ≤ 48 000 samples, one per quantum, seq 0, 1, 2', async () => {
    const r = await rig();
    const x = sawRamp(3 * FS);
    r.run(x);
    const from = 12345;
    const to = from + 120000;
    r.send({ t: 'take', epoch: 2, id: 5, fromFrame: from, toFrame: to });
    await flushMessages();
    for (let q = 1; q <= 3; q++) {
      r.run(new Float32Array(QUANTUM));
      await flushMessages();
      expect(chunksOf(r)).toHaveLength(q);
    }
    r.run(new Float32Array(4 * QUANTUM));
    await flushMessages();
    const chunks = chunksOf(r);
    expect(chunks.map((c) => c.pcm.length)).toEqual([48000, 48000, 24000]);
    expectWellFormed(chunks, 2, 5, FS);
    const pcm = concat(chunks.map((c) => c.pcm));
    expect(maxAbsDiff(pcm, hpfRef(x, FS).subarray(from, to))).toBeLessThanOrEqual(1e-6);
  });

  test('a take whose toFrame is 1 s in the future posts nothing until it is recorded, then completes', async () => {
    const r = await rig();
    const x = sawRamp(3 * FS);
    r.run(x.subarray(0, FS)); // ring end: 48 000
    r.send({ t: 'take', epoch: 3, id: 1, fromFrame: 24000, toFrame: 96000 });
    await flushMessages();
    r.run(x.subarray(FS, 96000 - QUANTUM)); // one quantum short of toFrame
    await flushMessages();
    expect(r.main).toEqual([]);
    r.run(x.subarray(96000 - QUANTUM, 96000)); // endFrame reaches toFrame: chunk 0
    await flushMessages();
    expect(chunksOf(r).map((c) => [c.seq, c.last])).toEqual([[0, false]]);
    r.run(x.subarray(96000, 96000 + QUANTUM)); // chunk 1, the last
    await flushMessages();
    const chunks = chunksOf(r);
    expectWellFormed(chunks, 3, 1, FS);
    expect(chunks).toHaveLength(2);
    expect(
      maxAbsDiff(concat(chunks.map((c) => c.pcm)), hpfRef(x, FS).subarray(24000, 96000)),
    ).toBeLessThanOrEqual(1e-6);
  });

  test.each([
    ['13 s old', 0],
    ['12 s + 1 frame old', 624000 + QUANTUM - RING - 1],
  ])('a take whose fromFrame is %s gets takeFailed{evicted}', async (_, from) => {
    const r = await rig();
    r.run(sawRamp(13 * FS)); // ring end 624 000; after the next quantum, startFrame = 624 128 − 576 000
    r.send({ t: 'take', epoch: 4, id: 9, fromFrame: from, toFrame: from + 4800 });
    await flushMessages();
    r.run(new Float32Array(4 * QUANTUM));
    await flushMessages();
    expect(r.main).toEqual([{ t: 'takeFailed', epoch: 4, id: 9, reason: 'evicted' }]);
  });

  test('a 12 s take whose fromFrame is evicted after its first chunk still completes (next-chunk check)', async () => {
    const r = await rig();
    const x = sawRamp(13 * FS + 20 * QUANTUM);
    r.run(x.subarray(0, 13 * FS));
    // Exactly 12 s long (the longest accepted take). Served first in the next quantum, when
    // fromFrame === ring.startFrame exactly; one quantum later the original fromFrame is evicted, but the next
    // chunk's start is not.
    const to = 13 * FS + QUANTUM;
    const from = to - RING;
    r.send({ t: 'take', epoch: 5, id: 1, fromFrame: from, toFrame: to });
    await flushMessages();
    r.run(x.subarray(13 * FS));
    await flushMessages();
    expect(r.main.filter((m) => m.t === 'takeFailed')).toEqual([]);
    const chunks = chunksOf(r);
    expect(chunks).toHaveLength(RING / CHUNK_MAX);
    expectWellFormed(chunks, 5, 1, FS);
    expect(
      maxAbsDiff(concat(chunks.map((c) => c.pcm)), hpfRef(x, FS).subarray(from, to)),
    ).toBeLessThanOrEqual(1e-6);
  });

  test.each([
    ['fromFrame not an integer', 1.5, 4800],
    ['toFrame not an integer', 0, 4800.5],
    ['fromFrame NaN', Number.NaN, 4800],
    ['toFrame Infinity', 0, Number.POSITIVE_INFINITY],
    ['fromFrame −Infinity', Number.NEGATIVE_INFINITY, 4800],
    ['frames beyond 2^53', 2 ** 53, 2 ** 53 + 4800],
    ['fromFrame a string', '0', 4800],
    ['toFrame null', 0, null],
    ['fromFrame === toFrame', 4800, 4800],
    ['fromFrame > toFrame', 9600, 4800],
    ['longer than 12 s', 0, RING + 1],
  ])('a take with %s gets takeFailed{evicted} at once and is never served', async (_, from, to) => {
    const r = await rig();
    r.run(sawRamp(FS));
    r.sendRaw({ t: 'take', epoch: 6, id: 2, fromFrame: from, toFrame: to }); // as a buggy main thread could
    await flushMessages();
    expect(r.main).toEqual([{ t: 'takeFailed', epoch: 6, id: 2, reason: 'evicted' }]);
    expect(() => r.run(sawRamp(FS))).not.toThrow();
    await flushMessages();
    expect(r.main).toHaveLength(1);
  });

  test('the queue holds 4 takes: a 5th fails at once, the 4 are served in order', async () => {
    const r = await rig();
    const x = sawRamp(2 * FS);
    r.run(x.subarray(0, 24064));
    for (let id = 1; id <= 5; id++) {
      r.send({ t: 'take', epoch: 8, id, fromFrame: 1000 * id, toFrame: 60000 + 1000 * id });
    }
    await flushMessages();
    expect(r.main).toEqual([{ t: 'takeFailed', epoch: 8, id: 5, reason: 'evicted' }]);
    r.run(x.subarray(24064));
    await flushMessages();
    const chunks = chunksOf(r);
    expect(chunks.map((c) => c.id)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    const ref = hpfRef(x, FS);
    for (let id = 1; id <= 4; id++) {
      const own = chunks.filter((c) => c.id === id);
      expectWellFormed(own, 8, id, FS);
      expect(
        maxAbsDiff(concat(own.map((c) => c.pcm)), ref.subarray(1000 * id, 60000 + 1000 * id)),
      ).toBeLessThanOrEqual(1e-6);
    }
  });

  test('stereo input is down-mixed to the mean of its channels', async () => {
    const r = await rig();
    const a = sawRamp(FS);
    const b = sine(440, FS, 1, 0.7);
    r.run([a, b]);
    r.send({ t: 'take', epoch: 9, id: 1, fromFrame: 1000, toFrame: 41000 });
    await flushMessages();
    r.run(new Float32Array(QUANTUM));
    await flushMessages();
    const mean = a.map((v, i) => (v + b[i]!) / 2);
    const chunks = chunksOf(r);
    expectWellFormed(chunks, 9, 1, FS);
    expect(
      maxAbsDiff(concat(chunks.map((c) => c.pcm)), hpfRef(mean, FS).subarray(1000, 41000)),
    ).toBeLessThanOrEqual(1e-6);
  });

  test('an input with no channels records zeros', async () => {
    const r = await rig();
    for (let q = 0; q < 100; q++) {
      globalThis.currentFrame = q * QUANTUM;
      expect(r.proc.process([[]], [[new Float32Array(QUANTUM)]], {})).toBe(true);
    }
    r.send({ t: 'take', epoch: 9, id: 2, fromFrame: 0, toFrame: 99 * QUANTUM });
    await flushMessages();
    globalThis.currentFrame = 100 * QUANTUM;
    r.proc.process([], [], {});
    await flushMessages();
    const chunks = chunksOf(r);
    expectWellFormed(chunks, 9, 2, FS);
    expect(chunks[0]!.pcm.every((v) => v === 0)).toBe(true);
  });
});

describe('arm and frames', () => {
  test('arm{7}: armed{7, armFrame} at the next quantum, 512-sample epoch-7 frames every 1536 ± 1 frames, none before armFrame; disarm{6} is ignored, disarm{7} stops them', async () => {
    const r = await rig();
    const x = noise(6 * FS, 1);
    r.run(x.subarray(0, 24064)); // disarmed: the decimator runs, nothing is posted
    await flushMessages();
    expect(r.frames).toEqual([]);
    expect(r.main).toEqual([]);

    r.send({ t: 'arm', epoch: 7 });
    await flushMessages();
    const armFrame = r.next;
    r.run(x.subarray(24064, 24064 + 2 * FS));
    await flushMessages();
    expect(r.main).toEqual([{ t: 'armed', epoch: 7, armFrame }]);
    expect(r.frames.length).toBeGreaterThanOrEqual(60);
    for (const f of r.frames) {
      expect(f.t).toBe('frame');
      expect(f.epoch).toBe(7);
      expect(f.pcm16k.length).toBe(VAD_FRAME);
      expect(f.firstFrame).toBeGreaterThanOrEqual(armFrame);
    }
    expect(r.frames[0]!.firstFrame - armFrame).toBeLessThan(3); // the frame starts at the first output ≥ armFrame
    for (let i = 1; i < r.frames.length; i++) {
      expect(Math.abs(r.frames[i]!.firstFrame - r.frames[i - 1]!.firstFrame - 1536)).toBeLessThanOrEqual(1);
    }

    r.send({ t: 'disarm', epoch: 6 });
    await flushMessages();
    const before = r.frames.length;
    r.run(x.subarray(24064 + 2 * FS, 24064 + 3 * FS));
    await flushMessages();
    expect(r.frames.length).toBeGreaterThan(before + 25);

    r.send({ t: 'disarm', epoch: 7 });
    await flushMessages();
    const stopped = r.frames.length;
    r.run(x.subarray(24064 + 3 * FS, 24064 + 5 * FS));
    await flushMessages();
    expect(r.frames).toHaveLength(stopped);
    expect(r.main).toHaveLength(1);
  });

  test('frame samples are the 16 kHz decimation of the high-passed input at the tagged position (group delay removed)', async () => {
    const r = await rig({ startFrame: 1_000_000 });
    const x = noise(2 * FS, 2);
    r.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    r.run(x);
    await flushMessages();
    const ref = resampleOffline(hpfRef(x, FS), VAD_RATE / FS);
    expect(r.frames.length).toBeGreaterThan(50);
    for (const f of r.frames) {
      const j = (f.firstFrame - 1_000_000) / 3; // output j sits at input 3j
      expect(Number.isInteger(j)).toBe(true);
      expect(maxAbsDiff(f.pcm16k, ref.subarray(j, j + VAD_FRAME))).toBeLessThanOrEqual(1e-6);
    }
  });

  test('a 440 Hz sine at −6.02 dBFS keeps its level within 0.5 dB and its frequency within 1 %', async () => {
    const r = await rig();
    r.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    r.run(sine(440, FS, 2, 0.5));
    await flushMessages();
    const pcm = concat(r.frames.map((f) => f.pcm16k));
    const from = 1600; // skip 100 ms of filter start-up
    const to = from + VAD_RATE;
    expect(pcm.length).toBeGreaterThanOrEqual(to);
    expect(Math.abs(toneLevelDb(pcm, 440, VAD_RATE, from, to) - 20 * Math.log10(0.5))).toBeLessThanOrEqual(
      0.5,
    );
    let peak = 0;
    let peakDb = Number.NEGATIVE_INFINITY;
    for (let f = 400; f <= 480; f += 0.25) {
      const db = toneLevelDb(pcm, f, VAD_RATE, from, to);
      if (db > peakDb) {
        peakDb = db;
        peak = f;
      }
    }
    expect(Math.abs(peak - 440) / 440).toBeLessThanOrEqual(0.01);
  });

  test('at 44.1 kHz the mean firstFrame spacing over 20 frames is 1411.2 ± 0.05', async () => {
    setSampleRate(44100);
    const r = await rig();
    r.send({ t: 'arm', epoch: 3 });
    await flushMessages();
    const armFrame = r.next;
    r.run(noise(quantaLength(1, 44100), 3));
    await flushMessages();
    expect(r.frames.length).toBeGreaterThanOrEqual(21);
    const f = r.frames.map((m) => m.firstFrame);
    expect(Math.abs((f[20]! - f[0]!) / 20 - 1411.2)).toBeLessThanOrEqual(0.05);
    for (let i = 1; i < f.length; i++) expect(Math.abs(f[i]! - f[i - 1]! - 1411.2)).toBeLessThanOrEqual(1);
    expect(f[0]!).toBeGreaterThanOrEqual(armFrame);
  });

  test('at 44.1 kHz a take reports sampleRate 44100 and the 44.1 kHz high-passed input', async () => {
    setSampleRate(44100);
    const r = await rig();
    const x = sawRamp(quantaLength(2, 44100));
    r.run(x);
    r.send({ t: 'take', epoch: 1, id: 1, fromFrame: 44100, toFrame: 88200 });
    await flushMessages();
    r.run(new Float32Array(QUANTUM));
    await flushMessages();
    const chunks = chunksOf(r);
    expectWellFormed(chunks, 1, 1, 44100);
    expect(
      maxAbsDiff(concat(chunks.map((c) => c.pcm)), hpfRef(x, 44100).subarray(44100, 88200)),
    ).toBeLessThanOrEqual(1e-6);
  });

  test('a disarm that overtakes its own arm (both before the next quantum) cancels it', async () => {
    const r = await rig();
    r.send({ t: 'arm', epoch: 4 });
    r.send({ t: 'disarm', epoch: 4 });
    await flushMessages();
    r.run(noise(FS, 4));
    await flushMessages();
    expect(r.main).toEqual([]);
    expect(r.frames).toEqual([]);
  });

  test('arm{8} + disarm{8} before the next quantum, while armed with 7, stops the epoch-7 feed too', async () => {
    const r = await rig();
    const x = noise(2 * FS, 13);
    r.send({ t: 'arm', epoch: 7 });
    await flushMessages();
    r.run(x.subarray(0, FS));
    await flushMessages();
    const sevens = r.frames.length;
    expect(sevens).toBeGreaterThan(25);
    r.send({ t: 'arm', epoch: 8 });
    r.send({ t: 'disarm', epoch: 8 });
    await flushMessages();
    r.run(x.subarray(FS));
    await flushMessages();
    expect(r.frames).toHaveLength(sevens); // no frames at all: neither epoch 8 nor epoch 7
    expect(r.main).toEqual([{ t: 'armed', epoch: 7, armFrame: 0 }]);
  });

  test('arm{8} while armed with 7 re-arms: armed{8}, the partial epoch-7 frame is dropped', async () => {
    const r = await rig();
    const x = noise(3 * FS, 5);
    r.send({ t: 'arm', epoch: 7 });
    await flushMessages();
    r.run(x.subarray(0, FS));
    await flushMessages();
    const sevens = r.frames.length;
    r.send({ t: 'arm', epoch: 8 });
    await flushMessages();
    const armFrame = r.next;
    r.run(x.subarray(FS, 2 * FS));
    await flushMessages();
    expect(r.main).toEqual([
      { t: 'armed', epoch: 7, armFrame: 0 },
      { t: 'armed', epoch: 8, armFrame },
    ]);
    const eights = r.frames.slice(sevens);
    expect(eights.length).toBeGreaterThan(25);
    expect(eights.every((f) => f.epoch === 8 && f.firstFrame >= armFrame)).toBe(true);
    expect(eights[0]!.firstFrame - armFrame).toBeLessThan(3);
  });

  test('frames go to the latest init port; without one they are dropped', async () => {
    const r = await rig({ worker: false });
    const x = noise(3 * FS, 6);
    r.send({ t: 'arm', epoch: 2 });
    await flushMessages();
    expect(() => r.run(x.subarray(0, FS))).not.toThrow();
    const second: Frame[] = [];
    const port = workerPort(second);
    r.send({ t: 'init', port }, [port]);
    await flushMessages();
    r.run(x.subarray(FS, 2 * FS));
    await flushMessages();
    expect(second.length).toBeGreaterThan(25);
    const third: Frame[] = [];
    const port3 = workerPort(third);
    r.send({ t: 'init', port: port3 }, [port3]);
    await flushMessages();
    const n = second.length;
    r.run(x.subarray(2 * FS, 3 * FS));
    await flushMessages();
    expect(second).toHaveLength(n);
    expect(third.length).toBeGreaterThan(25);
  });
});

describe('render-thread rules', () => {
  test('every output sample is exactly 0 and process() returns true', async () => {
    const r = await rig();
    r.send({ t: 'arm', epoch: 1 });
    r.send({ t: 'take', epoch: 1, id: 1, fromFrame: 0, toFrame: 24000 });
    await flushMessages();
    const outs = r.run(noise(FS, 7));
    expect(outs).toHaveLength(FS / QUANTUM);
    expect(outs.every((o) => o.every((v) => v === 0))).toBe(true);
    const out = new Float32Array(QUANTUM).fill(1);
    globalThis.currentFrame = r.next;
    expect(r.proc.process([[noise(QUANTUM, 8)]], [[out]], {})).toBe(true);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  test('process() allocates only the transferred buffers: one per posted frame and per clip chunk, each detached once posted', async () => {
    const r = await rig();
    const x = noise(4 * FS, 9);
    const quanta: Float32Array[][][] = [];
    for (let at = 0; at < x.length; at += QUANTUM) quanta.push([[x.slice(at, at + QUANTUM)]]);
    const out = [[new Float32Array(QUANTUM)]];
    let q = 0;
    const Real = globalThis.Float32Array;
    let created: Float32Array[] = [];
    const counting = new Proxy(Real, {
      construct(target, args, newTarget): Float32Array {
        const made: Float32Array = Reflect.construct(target, args, newTarget);
        created.push(made);
        return made;
      },
    });
    /** Runs n quanta with Float32Array construction counted; returns the arrays constructed. */
    const runCounted = (n: number): Float32Array[] => {
      created = [];
      globalThis.Float32Array = counting;
      try {
        for (const end = q + n; q < end; q++) {
          globalThis.currentFrame = q * QUANTUM;
          r.proc.process(quanta[q]!, out, {});
        }
      } finally {
        globalThis.Float32Array = Real;
      }
      return created;
    };

    expect(runCounted(375)).toHaveLength(0); // 1 s disarmed, no take
    r.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    const newFrames = runCounted(375); // 1 s armed
    await flushMessages();
    expect(r.frames.length).toBeGreaterThan(25);
    expect(newFrames).toHaveLength(r.frames.length); // one new frame per posted frame
    // Each new frame but the last (still filling) was posted later, transferred: its buffer is detached.
    expect(newFrames.slice(0, -1).every((f) => f.buffer.byteLength === 0)).toBe(true);
    expect(newFrames.at(-1)!.length).toBe(VAD_FRAME);

    r.send({ t: 'disarm', epoch: 1 });
    r.send({ t: 'take', epoch: 1, id: 1, fromFrame: 0, toFrame: 100000 });
    await flushMessages();
    const chunkArrays = runCounted(375);
    await flushMessages();
    expect(chunksOf(r).map((c) => c.pcm.length)).toEqual([48000, 48000, 4000]);
    expect(chunkArrays).toHaveLength(3); // one array per chunk…
    expect(chunkArrays.every((c) => c.buffer.byteLength === 0)).toBe(true); // …each transferred (detached)
  });

  test('the message handler ignores unknown and malformed messages and never throws', async () => {
    const r = await rig();
    const junk: unknown[] = [
      null,
      42,
      'arm',
      [],
      {},
      { t: 'bogus', epoch: 1 },
      { t: 'arm' },
      { t: 'arm', epoch: '7' },
      { t: 'disarm', epoch: null },
      { t: 'init', port: 'not a port' },
      { t: 'init' },
      { t: 'take', epoch: '1', id: 1, fromFrame: 0, toFrame: 10 },
      { t: 'take', epoch: 1, fromFrame: 0, toFrame: 10 },
    ];
    for (const m of junk) r.sendRaw(m);
    await flushMessages();
    expect(() => r.run(noise(FS, 11))).not.toThrow();
    await flushMessages();
    expect(r.main).toEqual([]);
    expect(r.frames).toEqual([]);
  });

  test('process() does not throw on a repeated or non-integer currentFrame', async () => {
    const r = await rig();
    const x = noise(4 * QUANTUM, 12);
    expect(() => runQuanta(r.proc, x, 0)).not.toThrow();
    expect(() => runQuanta(r.proc, x, 0)).not.toThrow(); // behind the ring's end: these quanta continue it
    expect(() => runQuanta(r.proc, x, 0.5)).not.toThrow();
  });
});

/** b posted the same frames as a: the same epochs and tags, then bit-identical samples. */
function expectSameFrames(b: Rig, a: Rig): void {
  expect(b.frames.map((f) => [f.epoch, f.firstFrame])).toEqual(a.frames.map((f) => [f.epoch, f.firstFrame]));
  b.frames.forEach((f, i) => expect(maxAbsDiff(f.pcm16k, a.frames[i]!.pcm16k)).toBe(0));
}

/** Asks r for a take of epoch 1 over [fromFrame, toFrame), serves it with one more quantum: its samples. */
async function takeOf(r: Rig, id: number, fromFrame: number, toFrame: number): Promise<Float32Array> {
  r.send({ t: 'take', epoch: 1, id, fromFrame, toFrame });
  await flushMessages();
  r.run(new Float32Array(QUANTUM));
  await flushMessages();
  const chunks = chunksOf(r).filter((c) => c.id === id);
  expectWellFormed(chunks, 1, id, 44100);
  return concat(chunks.map((c) => c.pcm));
}

/** The tags of r's frames 20 and 40: a take range cut the way the reducer cuts one, by frame tags. */
function cutOf(r: Rig): [number, number] {
  return [r.frames[20]!.firstFrame, r.frames[40]!.firstFrame];
}

/**
 * Runs 200 quanta at 44.1 kHz through r, silent but for an impulse at quantum 100 + 37, and returns how far
 * the tag of the frame sample where it peaks lies from the impulse's ring frame, in ctx frames (the output
 * samples are 44100 / 16000 ≈ 2.76 frames apart).
 */
async function impulseTagError(r: Rig): Promise<number> {
  const x = new Float32Array(200 * QUANTUM);
  const n0 = 100 * QUANTUM + 37;
  x[n0] = 1;
  const ringFrame = r.next + n0;
  r.run(x);
  await flushMessages();
  let peak = 0;
  let pos = Number.NaN;
  for (const f of r.frames) {
    for (let i = 0; i < f.pcm16k.length; i++) {
      if (Math.abs(f.pcm16k[i]!) > peak) {
        peak = Math.abs(f.pcm16k[i]!);
        pos = f.firstFrame + (i * 44100) / VAD_RATE;
      }
    }
  }
  return Math.abs(pos - ringFrame);
}

describe('currentFrame steps other than one quantum (issue #237)', () => {
  /** The start-up jump of the failing CI run (#237): 76 quanta, ≈ 0.22 s at 44.1 kHz. */
  const JUMP = 76 * QUANTUM;

  test('a jump ahead: the frames and a take cut by their tags equal those of the same input with the skipped frames as zeros', async () => {
    setSampleRate(44100);
    const x = noise(quantaLength(1.5, 44100), 21);
    // Reference: currentFrame steps one quantum per call, and the skipped stretch is explicit silence.
    const a = await rig();
    a.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    a.run(new Float32Array(QUANTUM));
    a.run(new Float32Array(JUMP));
    a.run(x);
    // Chrome at start-up: one silent quantum, then currentFrame jumps JUMP frames ahead.
    const b = await rig();
    b.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    b.run(new Float32Array(QUANTUM));
    b.next += JUMP;
    b.run(x);
    expect(b.next).toBe(a.next);
    await flushMessages();
    expect(a.frames.length).toBeGreaterThan(50);
    expectSameFrames(b, a);
    // The reducer cuts takes by the worker's frame tags: a take cut by the tags of frames 20 and 40 holds the
    // same audio in both rigs (with tags that lag the ring by JUMP, b's take would be JUMP frames early).
    expect(maxAbsDiff(await takeOf(b, 1, ...cutOf(b)), await takeOf(a, 1, ...cutOf(a)))).toBe(0);
  });

  test('a repeated currentFrame, then a catch-up: the stale quanta continue the ring, nothing is lost or moved', async () => {
    setSampleRate(44100);
    const x = noise(quantaLength(1, 44100), 22);
    const a = await rig();
    a.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    a.run(x);
    // Seen under load: currentFrame stuck for four quanta (99's frame), then back on time at quantum 104.
    const b = await rig();
    b.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    for (let q = 0; q * QUANTUM < x.length; q++) {
      const at = q >= 100 && q <= 103 ? 99 * QUANTUM : q * QUANTUM;
      runQuanta(b.proc, x.subarray(q * QUANTUM, (q + 1) * QUANTUM), at);
    }
    b.next = x.length;
    await flushMessages();
    expectSameFrames(b, a);
    expect(maxAbsDiff(await takeOf(b, 1, 0, x.length), await takeOf(a, 1, 0, x.length))).toBe(0);
  });

  test.each(['before', 'after'] as const)(
    'a jump with the arm %s it: an impulse is tagged at its ring frame',
    async (when) => {
      setSampleRate(44100);
      const r = await rig();
      if (when === 'before') {
        r.send({ t: 'arm', epoch: 1 });
        await flushMessages();
      }
      r.run(new Float32Array(QUANTUM));
      r.next += JUMP;
      r.run(new Float32Array(4 * QUANTUM));
      if (when === 'after') {
        r.send({ t: 'arm', epoch: 1 });
        await flushMessages();
      }
      expect(await impulseTagError(r)).toBeLessThanOrEqual(4);
    },
  );

  test('a 60 s jump while armed re-anchors the decimator: no frames of gap zeros, and an impulse after it is tagged at its ring frame', async () => {
    setSampleRate(44100);
    const r = await rig();
    r.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    r.run(new Float32Array(QUANTUM));
    r.next += 60 * 44100;
    r.run(new Float32Array(4 * QUANTUM));
    await flushMessages();
    // Fed as zeros, the gap would post ≈ 1,900 frames in one process() call.
    expect(r.frames).toHaveLength(0);
    expect(await impulseTagError(r)).toBeLessThanOrEqual(4);
  });

  test.each([
    [22050, true],
    [22051, false],
  ])('a %i-frame jump while armed at 44.1 kHz: gap zeros fed = %s (the cap is 0.5 s)', async (gap, fed) => {
    setSampleRate(44100);
    const r = await rig();
    r.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    r.run(new Float32Array(QUANTUM));
    r.next += gap;
    r.run(new Float32Array(QUANTUM));
    await flushMessages();
    expect(r.frames.length > 0).toBe(fed);
    expect(await impulseTagError(r)).toBeLessThanOrEqual(4);
  });

  test('a jump that is not a whole number of quanta: the frames equal those of the same input with the skipped frames as zeros', async () => {
    setSampleRate(44100);
    const x = noise(quantaLength(1, 44100), 7);
    const J = 76 * QUANTUM + 37;
    const ref = new Float32Array(J + x.length);
    ref.set(x, J);
    const a = await rig();
    a.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    a.run(new Float32Array(QUANTUM));
    a.run(ref.subarray(0, Math.floor(ref.length / QUANTUM) * QUANTUM));
    const b = await rig();
    b.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    b.run(new Float32Array(QUANTUM));
    b.next += J;
    b.run(x);
    await flushMessages();
    expect(b.frames.length).toBe(a.frames.length);
    expectSameFrames(b, a);
  });

  test('an arm on the jump quantum or on a stale quantum: armFrame is the placed frame, and so are the frame tags', async () => {
    setSampleRate(44100);
    const a = await rig();
    a.run(new Float32Array(QUANTUM));
    a.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    a.next += 76 * QUANTUM;
    a.run(new Float32Array(QUANTUM));
    await flushMessages();
    expect(a.main.find((m) => m.t === 'armed')).toMatchObject({ armFrame: 77 * QUANTUM });
    a.run(new Float32Array(20 * QUANTUM));
    await flushMessages();
    expect(a.frames[0]!.firstFrame - 77 * QUANTUM).toBeGreaterThanOrEqual(0);
    expect(a.frames[0]!.firstFrame - 77 * QUANTUM).toBeLessThan(3);
    const b = await rig();
    b.run(new Float32Array(4 * QUANTUM));
    b.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    runQuanta(b.proc, new Float32Array(QUANTUM), 3 * QUANTUM); // a repeated currentFrame
    await flushMessages();
    expect(b.main.find((m) => m.t === 'armed')).toMatchObject({ armFrame: 4 * QUANTUM });
    runQuanta(b.proc, new Float32Array(20 * QUANTUM), 5 * QUANTUM);
    await flushMessages();
    expect(b.frames[0]!.firstFrame - 4 * QUANTUM).toBeGreaterThanOrEqual(0);
    expect(b.frames[0]!.firstFrame - 4 * QUANTUM).toBeLessThan(3);
  });

  test('a re-anchor mid-frame drops the partial frame: the next frame is tagged at the jump frame', async () => {
    setSampleRate(44100);
    const r = await rig();
    r.send({ t: 'arm', epoch: 1 });
    await flushMessages();
    r.run(noise(3 * QUANTUM, 5));
    const at = r.next + 2 * 44100;
    r.next = at;
    r.run(noise(40 * QUANTUM, 6));
    await flushMessages();
    expect(r.frames.length).toBeGreaterThan(0);
    expect(r.frames[0]!.firstFrame).toBe(at);
  });

  test('a currentFrame within one quantum of Number.MAX_SAFE_INTEGER: process() drops the quantum and does not throw', async () => {
    const r = await rig();
    r.run(new Float32Array(4 * QUANTUM));
    const x = new Float32Array(QUANTUM);
    expect(() => runQuanta(r.proc, x, Number.MAX_SAFE_INTEGER - 64)).not.toThrow();
    const empty = await rig();
    expect(() => runQuanta(empty.proc, x, Number.MAX_SAFE_INTEGER - 64)).not.toThrow();
  });
});
