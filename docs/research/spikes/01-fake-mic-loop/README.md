# 01 — Fake-mic loop in headless Chromium

**Question:** can the whole capture → VAD → pitched playback loop run in CI with no microphone? And what does the CSP allow for worklets and WASM?

**Result** (Chromium 141 headless-shell and `channel:'chromium'`, Playwright 1.56). Fixture: 1 s silence, 1.5 s "speech-like" harmonic burst at f0 150 Hz, then 2 s tail.

| Check | Expected | Measured |
|---|---|---|
| Onset | ~1000 ms + 30 ms confirmation | 1010–1020 ms |
| End of speech | 2500 ms + 400 ms hangover | 2890–2900 ms |
| Output f0 at ×1.6 | 240 Hz | 239.7 Hz |
| Playback length | 1.175 s | 1.18 s |
| `script-src 'self'`: same-origin worklet | loads | ok |
| `script-src 'self'`: `blob:` worklet | blocked | `AbortError` (loads with no CSP) |
| WASM compile without `'wasm-unsafe-eval'` | blocked | `CompileError … 'unsafe-eval' is not an allowed source` |

**`%noloop` end of file.** The fake device **re-delivers its last buffer forever**. A tone ending abruptly reads −15 dBFS after EOF; with a 300 ms zero tail it reads −120 dB. That's why the plan requires every fixture to end in digital silence.

**Toy-VAD finding.** A noise floor that follows the leading digital silence down to −81 dB made −65 dB background noise look like speech. That led to the plan's "ignore frames below −100 dBFS" rule and the absolute onset minimum.

## Files

- `gen_wav.py`: speech-like fixture (`python3 gen_wav.py speech48k.wav 48000`).
- `gen_tone.py`: tone fixtures with and without a zero tail.
- `server.js`: static server on :8765. Paths: `/` (CSP with `'wasm-unsafe-eval'`), `/nowasm` (CSP without it), `/nocsp`.
- `index.html`, `app.js`, `capture-worklet.js`: the page, a toy energy VAD, and the ×1.6 playback plus output tap.
- `run.js <wav> [path] [channel]`: Playwright driver. Pass `chromium` as the 3rd argument for new headless.
- `rms.html`, `rms.js`, `run_rms.js`: logs input RMS over time for the `%noloop` test.

## Run

```sh
npm install                      # playwright 1.63; or NODE_PATH=<global node_modules>
python3 gen_wav.py speech48k.wav 48000 && python3 gen_tone.py
node server.js &
node run.js speech48k.wav /        # loop + CSP checks
node run.js speech48k.wav /nowasm  # WASM blocked
node run_rms.js tone_notail.wav    # last buffer repeats after EOF
node run_rms.js tone_tail.wav      # silence after EOF
```

The toy VAD, the playback-rate resampling and the inline f0 estimator are deliberately crude. The production versions are specified in plan §4.2–§4.3.
