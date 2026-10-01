// Silero VAD v6 16 kHz: a TypeScript port of the upstream graph (plan §4.2.1, §4.2.3). It is identical to
// the research spike's JsSilero (docs/research/spikes/02-vad-silero-port/lib.mjs):
//   1. input: the 64-sample context from the previous frame + the 512 new samples, reflect-padded right by
//      64 (640 samples); the context becomes frame[448, 512);
//   2. STFT: 4 steps of 256 samples at offsets 0, 128, 256, 384; magnitude of 129 bins over the
//      periodic-Hann DFT basis, regenerated once per model;
//   3. 4 × conv1d (k = 3, pad 1, ReLU): 129→128 s1, 128→64 s2, 64→64 s2, 64→128 s1 (time 4 → 4 → 2 → 1 → 1);
//   4. LSTMCell(128), gate order i, f, g, o;
//   5. p = σ(finalB + Σ finalW[k]·max(0, h[k])).
// Weights: SileroWeights from weights.ts (the shipped weights.bin decoded: fp16, conv biases fp32; or all
// fp32 straight from the ONNX in scripts/silero-parity.ts, which checks parity against onnxruntime-web).
// DOM-free (plan §3.3). process() allocates nothing: every buffer is created in createSilero.

import { WEIGHTS_LAYOUT, type SileroWeights } from './weights.ts';

/** New samples per call to process(): 32 ms at 16 kHz. */
export const SILERO_FRAME = 512;
/** Samples carried over from the end of one frame to the start of the next model input. */
export const SILERO_CONTEXT = 64;

export interface SileroModel {
  /** Zeroes the LSTM state (h, c) and the context. */
  reset(): void;
  /** Speech probability for the next 512 samples at 16 kHz. Throws a RangeError on any other length. */
  process(frame16k: Float32Array /* 512 */): number;
}

/** Reflect padding on the right of the 576-sample model input. */
const PAD = 64;
const INPUT = SILERO_CONTEXT + SILERO_FRAME; // 576
const N_FFT = 256;
const HOP = 128;
const STEPS = 4;
const BINS = N_FFT / 2 + 1; // 129
const HIDDEN = 128;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * out[o, t] = max(0, b[o] + Σ_i Σ_k w[o, i, k] · in[i, t·stride + k − 1]), with in = 0 outside [0, tin).
 * Row-major layouts: in [cin, tin], w [cout, cin, 3], out [cout, tout], tout = ⌊(tin − 1) / stride⌋ + 1.
 */
function conv1d(
  inp: Float32Array,
  cin: number,
  tin: number,
  w: Float32Array,
  b: Float32Array,
  cout: number,
  stride: number,
  out: Float32Array,
): void {
  const tout = Math.floor((tin - 1) / stride) + 1;
  for (let o = 0; o < cout; o++) {
    for (let t = 0; t < tout; t++) {
      const t0 = t * stride - 1;
      let s = b[o]!;
      for (let i = 0; i < cin; i++) {
        const wo = (o * cin + i) * 3;
        const io = i * tin;
        for (let k = 0; k < 3; k++) {
          const ti = t0 + k;
          if (ti >= 0 && ti < tin) s += w[wo + k]! * inp[io + ti]!;
        }
      }
      out[o * tout + t] = s > 0 ? s : 0;
    }
  }
}

/**
 * A model over `w`, whose tensors are used in place (not copied). Throws a RangeError if a tensor's length
 * isn't the product of its WEIGHTS_LAYOUT dims.
 */
export function createSilero(w: SileroWeights): SileroModel {
  for (const { key, dims } of WEIGHTS_LAYOUT) {
    let expected = 1;
    for (const d of dims) expected *= d;
    if (w[key].length !== expected) {
      throw new RangeError(`Silero weights: ${key} has ${w[key].length} values, expected ${expected}`);
    }
  }
  const { conv1W, conv1B, conv2W, conv2B, conv3W, conv3B, conv4W, conv4B } = w;
  const { lstmWih, lstmWhh, lstmBih, lstmBhh, finalW, finalB } = w;

  // STFT basis [2·129, 256]: row f is cos(2πfk/256)·win[k], row 129 + f is −sin(2πfk/256)·win[k], with
  // win[k] = 0.5 − 0.5·cos(2πk/256) (periodic Hann). f·k is reduced mod 256 before scaling, which is exact.
  const basis = new Float32Array(2 * BINS * N_FFT);
  for (let f = 0; f < BINS; f++) {
    for (let k = 0; k < N_FFT; k++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / N_FFT);
      const phase = (2 * Math.PI * ((f * k) % N_FFT)) / N_FFT;
      basis[f * N_FFT + k] = Math.cos(phase) * win;
      basis[(BINS + f) * N_FFT + k] = -Math.sin(phase) * win;
    }
  }

  const h = new Float32Array(HIDDEN);
  const c = new Float32Array(HIDDEN);
  const context = new Float32Array(SILERO_CONTEXT);
  const buf = new Float32Array(INPUT + PAD); // 640
  const mag = new Float32Array(BINS * STEPS); // [129, 4]
  const a1 = new Float32Array(128 * 4);
  const a2 = new Float32Array(64 * 2);
  const a3 = new Float32Array(64 * 1);
  const x = new Float32Array(128 * 1);
  const gates = new Float32Array(4 * HIDDEN);

  return {
    reset(): void {
      h.fill(0);
      c.fill(0);
      context.fill(0);
    },

    process(frame16k: Float32Array): number {
      if (frame16k.length !== SILERO_FRAME) {
        throw new RangeError(`Silero: expected a ${SILERO_FRAME}-sample frame, got ${frame16k.length}`);
      }
      // 1. Input: context + frame, then reflect-pad right: buf[576 + j] = buf[576 − 2 − j].
      buf.set(context, 0);
      buf.set(frame16k, SILERO_CONTEXT);
      for (let j = 0; j < PAD; j++) buf[INPUT + j] = buf[INPUT - 2 - j]!;
      for (let j = 0; j < SILERO_CONTEXT; j++) context[j] = frame16k[SILERO_FRAME - SILERO_CONTEXT + j]!;

      // 2. STFT magnitude: mag[f, t].
      for (let t = 0; t < STEPS; t++) {
        const off = t * HOP;
        for (let f = 0; f < BINS; f++) {
          const wr = f * N_FFT;
          const wi = (BINS + f) * N_FFT;
          let re = 0;
          let im = 0;
          for (let k = 0; k < N_FFT; k++) {
            const s = buf[off + k]!;
            re += basis[wr + k]! * s;
            im += basis[wi + k]! * s;
          }
          mag[f * STEPS + t] = Math.sqrt(re * re + im * im);
        }
      }

      // 3. Encoder.
      conv1d(mag, BINS, 4, conv1W, conv1B, 128, 1, a1);
      conv1d(a1, 128, 4, conv2W, conv2B, 64, 2, a2);
      conv1d(a2, 64, 2, conv3W, conv3B, 64, 2, a3);
      conv1d(a3, 64, 1, conv4W, conv4B, 128, 1, x);

      // 4. LSTMCell: gates = Wih·x + bih + Whh·h + bhh, in the order i, f, g, o.
      for (let r = 0; r < 4 * HIDDEN; r++) {
        const o = r * HIDDEN;
        let s = lstmBih[r]! + lstmBhh[r]!;
        for (let k = 0; k < HIDDEN; k++) s += lstmWih[o + k]! * x[k]! + lstmWhh[o + k]! * h[k]!;
        gates[r] = s;
      }
      for (let k = 0; k < HIDDEN; k++) {
        const i = sigmoid(gates[k]!);
        const f = sigmoid(gates[HIDDEN + k]!);
        const g = Math.tanh(gates[2 * HIDDEN + k]!);
        const o = sigmoid(gates[3 * HIDDEN + k]!);
        c[k] = f * c[k]! + i * g;
        h[k] = o * Math.tanh(c[k]!);
      }

      // 5. Decoder: ReLU, 1×1 conv, sigmoid.
      let s = finalB[0]!;
      for (let k = 0; k < HIDDEN; k++) {
        const hk = h[k]!;
        if (hk > 0) s += finalW[k]! * hk;
      }
      return sigmoid(s);
    },
  };
}
