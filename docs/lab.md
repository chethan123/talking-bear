# Lab pages

The `lab/` pages are dev-only experiment pages for the plan §5 experiments (X-E1, X-E2, …). They are extra Vite entry points that `pnpm dev` serves; `pnpm build` builds only `index.html`, so no lab page ever reaches `dist/` (M6's `check-dist` will also fail the build if `dist/lab` exists).

`lab/index.html` links every lab page. Today:

| Page | Experiment |
|---|---|
| `lab/routing.html` | X-E1 output routing and volume stream with the mic open; X-E2 input preset and residual processing (live spectrum, energy above 8 kHz) |
| `lab/sfx.html` | Every reaction sound effect, with its duration and peak |

## Privacy rule (plan Q2)

**No lab page may store or download captured audio.** This is a hard rule (CLAUDE.md rule 5):

- Captured audio may live only in memory, for the experiment in progress: `lab/routing` keeps its 3 s recording in a `Float32Array`, plays it back in place, and zeroes and drops it on Close and on `pagehide`.
- No lab page writes captured audio anywhere: no file save or download, no `createObjectURL`, no `showSaveFilePicker`, no IndexedDB, no `localStorage`, no network.
- Exporting text and numbers is fine: every page has a log panel with a "Copy log" button (plain text, to the clipboard).
- The one exception is `lab/vad-trace` (M2), which exports **feature traces** (per-frame probabilities, energies and voicing scores), never audio.
- Never commit captured or real-voice audio, and never paste it into `docs/device-notes.md`.

Validation for every lab task includes this check, which must find nothing:

```sh
grep -rnE "download|createObjectURL|showSaveFilePicker|indexedDB|localStorage" lab/ --exclude='vad-trace.*'
```

So none of those words may appear anywhere under `lab/` (except `lab/vad-trace.*`), not even in a comment.

## Running the labs on desktop

```sh
pnpm dev
```

Then open `http://localhost:5173/lab/` (Vite's default port; if it is taken, Vite prints the port it picked). `localhost` is a secure context, so `getUserMedia` and AudioWorklets work.

## Running the labs on D1 (the reference Pixel) with `adb reverse`

`getUserMedia` needs a secure context. Over the LAN the dev server would be plain `http://<ip>`, which isn't one, so the phone reaches it as `http://localhost` through an `adb reverse` port forward instead (plan §7, §10).

1. **One-time phone setup:** enable Developer options and USB debugging on D1, connect it by USB, and accept the "Allow USB debugging" prompt. `adb devices` must list it as `device`.
2. **Start the dev server** on the computer: `pnpm dev`. Note the port (default `5173`).
3. **Forward the port** from the phone to the computer:

   ```sh
   adb reverse tcp:5173 tcp:5173
   adb reverse --list    # shows the forward
   ```

4. **On D1**, open Chrome at `http://localhost:5173/lab/` and pick a page. Allow the microphone when Chrome asks.
5. **Remote DevTools (optional):** on the computer, open `chrome://inspect/#devices` in Chrome to see the phone's tab, its console and its errors.
6. **Record the result:** press "Copy log", paste the log into `docs/device-notes.md` using its template (as `### <Txx> — <YYYY-MM-DD>`), and add the phone model, the Android version and the Chrome version from `chrome://version`. The `lab/routing` log also starts with the page's user agent, which includes the Chrome version.
7. **Clean up:** `adb reverse --remove tcp:5173` (or `adb reverse --remove-all`).

Wireless debugging (`adb pair` / `adb connect`) works the same way; use it for battery measurements, because USB charging distorts power numbers (plan §4.10, §10).

## `lab/routing` (X-E1, X-E2)

- **Settings** (they apply on the next Open mic):
  - **EC:** checked requests `{echoCancellation: true, noiseSuppression: true, autoGainControl: true}`, unchecked all three `false` (the app's setting, plan §4.1.1).
  - **Context: before / after `getUserMedia`:** whether the `AudioContext` is created and resumed before the mic is requested, or after the stream arrives. The app creates it before.
- **Buttons:** Open mic (opening again closes the current session first), Record 3 s, Play recording, Play 1 kHz tone (1 s, −12 dBFS), Close.
- **Displays,** refreshed on Open mic: `ctx.sampleRate`, `ctx.baseLatency`, `ctx.outputLatency`, `track.getSettings()`, and the `enumerateDevices()` audio input and output labels in order. The spectrum shows the mic input from 50 Hz to Nyquist on a log axis, with markers at 4, 8 and 16 kHz, and the energy above 8 kHz relative to the energy from 50 Hz to 8 kHz, in dB.
- **Log:** every action and value, with a local `HH:MM:SS.mmm` timestamp, plus the energy share once per second while the mic is open.

**X-E1 procedure** (plan §5): for each EC setting and each context order, press Open mic, then Play recording or Play tone, and observe whether the sound comes from the loudspeaker or the earpiece, and which volume slider (media or call) the volume keys move. Meanwhile, on the computer:

```sh
adb shell dumpsys audio | grep -i mode     # MODE_NORMAL vs MODE_IN_COMMUNICATION
adb shell dumpsys media.audio_flinger      # output device (speaker / earpiece) and usage of the active tracks
```

Optional: SPL at 10 cm at maximum media volume with a sound-level meter (or a meter app on another phone), playing the tone. The lab plays straight to `destination`, while the app's master bus (`src/audio/bus.ts`) applies a gain of 0.7 (−3.1 dB) after its own levels: when comparing SPL with the app's output, the −12 dBFS lab tone is 3.1 dB hotter than an app sound at the same pre-bus level.

**X-E2 procedure** (plan §5): play white noise from a second device near D1's mic, with EC off and then on. Compare the spectra (a cutoff near 8 kHz means voice processing), the energy share above 8 kHz, and drift in the recording's level over repeated Record 3 s runs (OEM AGC). Plug in a wired headset and check which input `enumerateDevices()` and `track.getSettings()` report.

## Writing a new lab page

- Add `lab/<name>.html` and `lab/<name>.ts`, and link the page from `lab/index.html`.
- Use `lab/common.ts` (`el`, `fmt`, `logPanel`) and `lab/lab.css`. No inline script or style, and no HTML strings.
- A lab-only AudioWorklet goes in `lab/<name>.worklet.ts` and is loaded with `import url from './<name>.worklet.ts?worker&url'` and `ctx.audioWorklet.addModule(url)`.
- `pnpm typecheck` and `pnpm lint` cover `lab/`: pages through the `"lab"` entry in `tsconfig.app.json`, and lab worklets (`lab/**/*.worklet.ts`) through `tsconfig.worklet.json` (audioworklet types, no DOM), like `src` worklets.
