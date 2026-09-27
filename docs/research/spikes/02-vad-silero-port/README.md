# 02 — Silero VAD port, VAD comparison, DSP micro-benchmarks

**Main result.** `lib.mjs` contains a ~60-line plain-JS implementation of the Silero VAD v6 16 kHz graph:

1. reflect-pad 64;
2. STFT as a 258×256 stride-128 conv, then magnitude;
3. 4 × conv (k = 3) with ReLU;
4. LSTMCell(128);
5. ReLU → 1×1 conv → sigmoid.

The graph is documented upstream in `tinygrad_model.py`. Its weights are read straight from the upstream `silero_vad_16k_op15.onnx` by `onnxinit.mjs`, a dependency-free protobuf reader for `TensorProto` initializers.

`parity.mjs` output (reproduced twice):

```
reorder=false max|dp|=2.40e-6 flips=0/1875 per-frame=~0.9-1.0 ms   ← correct gate order
reorder=true  max|dp|=1.00e+0 flips=1452/1875                    ← negative control (wrong LSTM gate order)
```

`weights.mjs` stores the weights as fp16 without the STFT basis, which is regenerated as a periodic-Hann DFT. That gives 487 KB raw / 435 KB brotli, still with 0 flips (max |Δp| 1.9e-3).

## Other scripts

| Script | What it does | Headline result |
|---|---|---|
| `eval.mjs` (`SWEEP=1` for the hangover sweep) | Synthetic comparison of energy + voicing, WebRTC VAD (`auditok-webrtcvad`) and Silero on 10 utterances with fan, modulated fan, TV and knock noise | Silero needs 600 ms of hangover for 0 splits, energy needs ≥ 800 ms; WebRTC latches in noise; nobody rejects TV speech |
| `energy.mjs`, `segmenter.mjs` | Energy VAD (adaptive floor, hysteresis, voicing) and a shared segmenter | — |
| `seg.mjs` | Energy-oracle labels for the test clips | — |
| `dsp_bench.mjs` | 64-tap Kaiser 48k→16k decimator and energy VAD cost | ≈ 1.5 ms per second of audio for the decimator |
| `worklet_bench.mjs` | Per-render-quantum cost of energy + ring write | 0.64 µs per quantum (x86 VM) |
| `bench_ort.mjs <model.onnx>…` | onnxruntime-web 1.30 (wasm, 1 thread) per-frame cost | 0.41 ms per 32 ms frame (16k op15) |
| `bench_fvad.mjs` | WebRTC VAD per-frame cost | 2–6 µs per 10 ms |
| `onnxdump.mjs <model.onnx>` | Lists graph nodes and initializers | — |

## Run

```sh
git clone https://github.com/snakers4/silero-vad silero-vad
git -C silero-vad checkout 5cd7945676eb32225748052e2e6a0580e4686a08   # the commit used (2026-09-23)
npm install
node parity.mjs
node weights.mjs
node eval.mjs
SWEEP=1 node eval.mjs
```

## Caveats

- **Test audio:** `eval.mjs` and `parity.mjs` use `tests/data/test.wav` and `examples/c++/aepyx.wav` from the Silero repo (MIT, real voices). They come from the clone and are **not committed** here.
- **Synthetic evaluation:** single speaker, synthetic noise, n = 10. The results are directional; plan M2 replaces them with real-voice feature traces.
- **Language:** this is JS, not the production TS. The M2 module re-implements it in TypeScript behind the `SileroModel` interface, and keeps the same parity test in CI.
