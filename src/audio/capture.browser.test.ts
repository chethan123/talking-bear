// The real capture worklet in headless Chromium (issue #26, plan §4.9.2): the module the app loads
// (`capture.worklet.ts?worker&url`, served by the Vite dev server in Browser Mode) runs in an
// OfflineAudioContext on 3 s of synthesised input: 1 s of zeros, 1 s of a 440 Hz sine at amplitude 0.5, then
// 1 s of zeros. Every command is handled before rendering starts, so the run is deterministic and needs no
// microphone. It covers module loading, message framing, the 16 kHz decimation and the chunked take.

import { beforeAll, describe, expect, test } from 'vitest';

import { rmsDb, sine } from '../../test/dsp-helpers.ts';
import { butterworthHighpass } from '../dsp/biquad.ts';
import workletUrl from './capture.worklet.ts?worker&url';
import { HPF_CLIP_HZ, VAD_FRAME } from './constants.ts';
import { transferList } from './messages.ts';
import type { MainToWorklet, WorkletToMain, WorkletToWorker } from './messages.ts';

type Chunk = Extract<WorkletToMain, { t: 'clipChunk' }>;

const SAMPLE_RATE = 48000;
/** RMS of a sine of amplitude 0.5: 20·log10(0.5 / √2) = −9.03 dBFS. */
const TONE_RMS_DBFS = -9.03;
/** Ctx frames between the first samples of consecutive 512-sample frames at 48 kHz: 512 · 48000 / 16000. */
const FRAME_STRIDE = 1536;
/** The take under test: the tone second. */
const TAKE_ID = 1;
/** An empty take (fromFrame === toFrame), which the worklet's message handler fails at once. */
const BARRIER_ID = 2;

interface Run {
  /** The 3 s the source played. */
  input: Float32Array;
  /** Everything the worklet posted on node.port (armed, clipChunk, takeFailed), in order. */
  toMain: WorkletToMain[];
  /** Everything the worklet posted on the `init` port (frames), in order. */
  frames: WorkletToWorker[];
}

/** Resolves after one macrotask, so MessagePort deliveries already queued land first. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function render(): Promise<Run> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: 3 * SAMPLE_RATE,
    sampleRate: SAMPLE_RATE,
  });
  await ctx.audioWorklet.addModule(workletUrl);

  const input = new Float32Array(3 * SAMPLE_RATE);
  input.set(sine(440, SAMPLE_RATE, 1, 0.5), SAMPLE_RATE); // the middle second; the rest stays 0
  const buffer = new AudioBuffer({ numberOfChannels: 1, length: 3 * SAMPLE_RATE, sampleRate: SAMPLE_RATE });
  buffer.copyToChannel(input, 0);
  const source = new AudioBufferSourceNode(ctx, { buffer });
  const node = new AudioWorkletNode(ctx, 'capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  source.connect(node).connect(ctx.destination);

  const toMain: WorkletToMain[] = [];
  node.port.addEventListener('message', (e: MessageEvent<WorkletToMain>): void => {
    toMain.push(e.data);
  });
  const barrier = new Promise<void>((resolve) => {
    node.port.addEventListener('message', (e: MessageEvent<WorkletToMain>): void => {
      if (e.data.t === 'takeFailed' && e.data.id === BARRIER_ID) resolve();
    });
  });
  node.port.start();
  const ch = new MessageChannel();
  const frames: WorkletToWorker[] = [];
  ch.port2.addEventListener('message', (e: MessageEvent<WorkletToWorker>): void => {
    frames.push(e.data);
  });
  ch.port2.start();
  const post = (msg: MainToWorklet): void => {
    node.port.postMessage(msg, transferList(msg)); // init transfers its port
  };
  post({ t: 'init', port: ch.port1 });
  post({ t: 'arm', epoch: 1 });
  post({ t: 'take', epoch: 1, id: TAKE_ID, fromFrame: 48000, toFrame: 96000 });
  // Chromium renders an OfflineAudioContext in one task on the worklet thread, so messages posted just before
  // startRendering() race it: any of them (even the first) may be handled only after rendering ends. The
  // empty take fails from the message handler, without a render quantum, and the port keeps message order:
  // its takeFailed proves init, arm and take were all handled.
  post({ t: 'take', epoch: 1, id: BARRIER_ID, fromFrame: 0, toFrame: 0 });
  source.start(0);
  await Promise.race([
    barrier,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(
          new Error(
            'no takeFailed{id 2} before rendering: the worklet must fail an empty take from its message handler (D1 barrier)',
          ),
        );
      }, 5000),
    ),
  ]);

  await ctx.startRendering();
  await macrotask();
  await macrotask();
  node.port.close();
  ch.port2.close();
  return { input, toMain, frames };
}

describe('the capture worklet in an OfflineAudioContext: 1 s of zeros, 1 s of 440 Hz at 0.5, 1 s of zeros', () => {
  let run: Run;
  beforeAll(async () => {
    run = await render();
  });

  test('one armed{epoch 1} at quantum 0; only the empty barrier take fails', () => {
    expect(run.toMain.filter((m) => m.t === 'armed')).toEqual([{ t: 'armed', epoch: 1, armFrame: 0 }]);
    expect(run.toMain.filter((m) => m.t === 'takeFailed')).toEqual([
      { t: 'takeFailed', epoch: 1, id: BARRIER_ID, reason: 'evicted' },
    ]);
  });

  test('90–94 frames of 512 samples, epoch 1, firstFrame strictly increasing by 1536 ± 1', () => {
    const { frames } = run;
    expect(frames.length).toBeGreaterThanOrEqual(90);
    expect(frames.length).toBeLessThanOrEqual(94);
    for (const f of frames) {
      expect(f.t).toBe('frame');
      expect(f.epoch).toBe(1);
      expect(f.pcm16k).toHaveLength(VAD_FRAME);
    }
    const armed = run.toMain.find((m) => m.t === 'armed');
    expect(frames[0]!.firstFrame).toBeGreaterThanOrEqual(armed?.t === 'armed' ? armed.armFrame : Infinity);
    for (let i = 1; i < frames.length; i++) {
      const step = frames[i]!.firstFrame - frames[i - 1]!.firstFrame;
      expect(Math.abs(step - FRAME_STRIDE), `step before frame ${i}`).toBeLessThanOrEqual(1);
    }
  });

  test('frames in the middle of the tone are within 1 dB of −9.03 dBFS; frames inside the leading second are below −100 dBFS', () => {
    // The window [52 800, 91 200] is 25 strides long and the leading second holds 31 whole frames; the
    // lower bounds leave room for the ±1 stride tolerance and keep both checks from passing vacuously.
    const tone = run.frames.filter((f) => f.firstFrame >= 52800 && f.firstFrame <= 91200);
    expect(tone.length).toBeGreaterThanOrEqual(24);
    for (const f of tone) {
      expect(Math.abs(rmsDb(f.pcm16k) - TONE_RMS_DBFS), `frame at ${f.firstFrame}`).toBeLessThanOrEqual(1);
    }
    // Entirely inside: every sample's position (firstFrame + 3·i, i < 512; 3 = 48000 / 16000) is before the
    // tone starts at 48 000.
    const silent = run.frames.filter((f) => f.firstFrame + (VAD_FRAME - 1) * 3 < SAMPLE_RATE);
    expect(silent.length).toBeGreaterThanOrEqual(30);
    for (const f of silent) {
      expect(rmsDb(f.pcm16k), `frame at ${f.firstFrame}`).toBeLessThan(-100);
    }
  });

  test('take 1 streams exactly 48 000 samples, seq 0, 1, …, last: true only on the final chunk, RMS within 0.5 dB of −9.03 dBFS, equal to the high-passed input over [48 000, 96 000)', () => {
    const chunks = run.toMain.filter((m): m is Chunk => m.t === 'clipChunk' && m.id === TAKE_ID);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
    expect(chunks.map((c) => c.last)).toEqual(chunks.map((_, i) => i === chunks.length - 1));
    for (const c of chunks) {
      expect(c.epoch).toBe(1);
      expect(c.sampleRate).toBe(SAMPLE_RATE);
    }
    const total = chunks.reduce((n, c) => n + c.pcm.length, 0);
    expect(total).toBe(48000);
    const clip = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
      clip.set(c.pcm, offset);
      offset += c.pcm.length;
    }
    // The 80 Hz high-pass barely touches 440 Hz (−0.005 dB).
    expect(Math.abs(rmsDb(clip) - TONE_RMS_DBFS)).toBeLessThanOrEqual(0.5);
    // Alignment: the clip is the high-passed input over exactly [48 000, 96 000) (bit-exact here; shifting the
    // take by one sample gives 0.029, by one quantum 0.57).
    const ref = butterworthHighpass(SAMPLE_RATE, HPF_CLIP_HZ).process(run.input).subarray(48000, 96000);
    let maxErr = 0;
    for (let i = 0; i < 48000; i++) maxErr = Math.max(maxErr, Math.abs(clip[i]! - ref[i]!));
    expect(maxErr, 'clip vs HPF(input)[48000, 96000)').toBeLessThanOrEqual(1e-6);
  });
});
