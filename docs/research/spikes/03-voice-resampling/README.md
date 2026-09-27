# 03 — Voice effect: resampling, aliasing and pitch-shifter comparison

**Convention warning.** In these scripts, `r` is the **pitch ratio** (input rate / output rate, so r = 2 means an octave up). The production API in plan §3.3 uses `ratio = outRate/inRate` (= 1/p). Don't copy the formulas across without converting.

## Results (Node 22, 2.1 GHz Xeon VM, synthetic 5 s voice at 48 kHz)

**Aliasing (`alias.mjs`).** A clone of Chromium's `AudioBufferSourceNode` linear interpolation, at r = 2.0, aliases 14/18/20 kHz tones at full level (−6 dBFS in → −6 dBFS out). An 8-zero-crossing Kaiser polyphase sinc brings aliasing to ≤ −100 dB relative.

**Cost per 5 s clip:**

| Method | Time |
|---|---|
| Own sinc (8 zero-crossings) | 12–15 ms |
| Own TD-PSOLA + YIN | 47–62 ms |
| Own WSOLA + sinc | 60–108 ms |
| SoundTouchJS core (Lanczos / linear) | 88–116 ms / 22–26 ms |
| Signalsmith Stretch | 37–72 ms (85–102 ms with formant compensation) |
| `@audio/shift` formant | ~118 ms |

**Formants.** The voiced-frame spectral centroid ratio is ≈ 1.37× at r = 1.5 for resampling. Formant-preserving methods (PSOLA, LPC) come out at ≈ 1.0–1.1×.

## Files

| File | Purpose |
|---|---|
| `dsp.mjs` | synthetic voice (glottal pulses, formants, fricatives), sinc resampler, biquads, FFT, benchmark helpers |
| `alias.mjs` | aliasing tables: linear vs pre-filtered linear vs Chromium-style SincResampler vs own sinc |
| `algos.mjs` | own WSOLA, TD-PSOLA, YIN-lite pitch tracker |
| `fastsinc.mjs` | nearest-phase polyphase sinc timing |
| `pitch.mjs` | full comparison, including SoundTouchJS variants, Signalsmith and the formant proxy |
| `shiftbench.mjs` | `@audio/shift` algorithms |
| `t3.mjs`, `t4.mjs`, `t5.mjs` | SoundTouch option sweeps and tone-based aliasing tests |
| `cold.mjs` | cold-start timing |
| `make_ss_module.mjs` | regenerates `ss_module.cjs` (below) |

## Run

```sh
npm install
node make_ss_module.mjs   # required by pitch.mjs, t4.mjs, t5.mjs
node alias.mjs
node pitch.mjs
```

`ss_module.cjs` is the Emscripten module factory embedded in `signalsmith-stretch`'s `SignalsmithStretch.js` (MIT), exported for Node. It isn't committed. The generator output was verified byte-identical to the file used in the research.

**Licences, dev-only:** SoundTouchJS core is MPL-2.0 (with an LGPL provenance question, see plan §4.3.2); legacy `soundtouchjs` is LGPL-2.1; Signalsmith is MIT; `@audio/shift` is MIT. None of these ship in the app.
