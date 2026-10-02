# Lab pages

The `lab/` pages are dev-only experiment pages for the plan §5 experiments (X-E1, X-E2, …). They are extra Vite entry points that `pnpm dev` serves; `pnpm build` builds only `index.html`, so no lab page ever reaches `dist/` (M6's `check-dist` will also fail the build if `dist/lab` exists).

`lab/index.html` links every lab page. Today:

| Page | Experiment |
|---|---|
| `lab/routing.html` | X-E1 output routing and volume stream with the mic open; X-E2 input preset and residual processing (live spectrum, energy above 8 kHz) |
| `lab/sfx.html` | Every reaction sound effect, with its duration and peak |
| `lab/gestures.html` | X-A7 labelled pointer traces (tap, long-press, pet, tickle) for the recogniser's confusion matrix (`scripts/gesture-eval.ts`); exports them as JSON |
| `lab/vad-trace.html` | M2 real-voice feature traces on D1 (listen-only, Silero on every frame, hold-to-talk labels); exports `trace.json` and `trace.bin`, never audio |

## Privacy rule (plan Q2)

**No lab page may store or download captured audio.** This is a hard rule (CLAUDE.md rule 5):

- Captured audio may live only in memory, for the experiment in progress: `lab/routing` keeps its 3 s recording in a `Float32Array`, plays it back in place, and zeroes and drops it on Close and on `pagehide`.
- No lab page writes captured audio anywhere: no file save or download, no `createObjectURL`, no `showSaveFilePicker`, no IndexedDB, no `localStorage`, no network.
- Exporting text and numbers is fine: every page has a log panel with a "Copy log" button (plain text, to the clipboard).
- There are two named exceptions, and neither exports audio:
  - `lab/vad-trace` (M2) exports **feature traces** (per-frame probabilities, energies and voicing scores).
  - `lab/gestures` (M5, X-A7) exports **pointer traces**: coordinates and times only, labelled with an anonymous participant id (P1, P2, …) and an age group (adult or child), never a name. It never touches the microphone or any audio, and it stores nothing in the browser (no IndexedDB, no `localStorage`): its one export is a JSON file the browser saves when Export is pressed.
- Never commit captured or real-voice audio, and never paste it into `docs/device-notes.md`.

Validation for every lab task includes this check, which must find nothing:

```sh
grep -rnE "download|createObjectURL|showSaveFilePicker|indexedDB|localStorage" lab/ --exclude='vad-trace.*' --exclude='gestures.*'
```

So none of those words may appear anywhere under `lab/` (except `lab/vad-trace.*` and `lab/gestures.*`), not even in a comment.

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

## `lab/gestures` (X-A7)

- **Procedure** (plan §5 X-A7): at least 5 people, children included, at least 20 trials each. For each person, set the participant number (P1, P2, …) and the age group; the first trial locks both. The page prompts a random gesture (each of tap, long-press, pet and tickle once in every 4 trials) and outlines its region: tap the nose, press and hold a paw, pet (stroke) the head, tickle the belly. The prompt and the recogniser's gestures, as they happen, show below the bear (nothing above it changes size, so the bear never moves under a finger). Export saves the participant's trials; New participant clears them once they are exported. Leaving the page with unexported trials asks first.
- **The bear** is drawn once, in the neutral pose with no animation, so the regions never move. Lab pages have no CSS sizing that fits the bear's aspect (`lab.css` has none; pages set no style attributes), so the canvas's backing store has its CSS size (the page's width, the bear's aspect, at most 85 % of the viewport's height, fixed at load): the hit test uses the same CSS px view as the renderer, and the bear looks soft on a high-DPR screen.
- **A trial** holds every `PointerSample` the app's pointer adapter (`src/input/pointer-adapter.ts`) feeds its recogniser, in order: each down, every coalesced move, each up and cancel, and the frame ticks (`id` −1) that let a still long-press fire. It runs from the first down until 600 ms after the last up or cancel; a down within those 600 ms continues it. The page closes a trial 100 ms after its tail; a down in between starts the next trial before its prompt is shown, and the log says so (`trial n started … ms after the tail, before its prompt was shown`), so the operator can note it. The page replays each trial through `recognize` from a fresh state as the samples come, so the live verdict is exactly what `gesture-eval` computes.
- **The file**, `gestures-P<n>-<YYYYMMDDTHHMMSSZ>.json` (UTC, ISO 8601 basic format):

  ```json
  {
    "format": "talking-bear-gestures",
    "version": 1,
    "canvas": { "cssWidth": 380, "cssHeight": 532, "dpr": 2.625 },
    "trials": [
      {
        "participant": "P1",
        "age": "child",
        "intended": "pet",
        "samples": [
          { "id": 7, "t": 15234.5, "x": 120.25, "y": 88.5, "type": "down", "pointerType": "touch" },
          { "id": -1, "t": 15248.9, "x": 0, "y": 0, "type": "tick" }
        ]
      }
    ]
  }
  ```

  `x`, `y` are CSS px relative to the canvas; `t` is ms on `performance.now()`'s time origin; `intended` is one of `tap`, `long-press`, `pet`, `tickle`; `age` is `adult` or `child`.
- **Evaluation:** `node scripts/gesture-eval.ts <files…> [--min 0.9]` replays every trial through `recognize` with the neutral-pose `hitTest` of the file's canvas and maps the emitted gestures to a class: `tap up` → tap, `longPress start` → long-press, a `stroke` with `pathPx` ≥ `STROKE_MIN_PATH` (120) → pet, `tickle` → tickle, none of these → none; with several, the highest of tickle > pet > long-press > tap wins. It prints the confusion matrix, the per-class, overall and per-age-group accuracy, and every misclassified trial with its gestures. Exit 1 when `--min` is given and the overall accuracy is below it; exit 2 on a usage error or an invalid file.

## `lab/vad-trace` (M2 real-voice feature traces)

- **What it records** (plan §7 M2, Q2): listen-only capture with the app's constraints (all browser processing off), Silero on every 32 ms frame, and no playback. Per 10 ms hop: the raw (unfiltered) and the band-limited level in dBFS and the voicing score; per 32 ms Silero frame: the speech probability. Plus the hold-to-talk marks, `press` and `release` in ctx frames (`Math.round(ctx.currentTime · ctx.sampleRate)`), on the same clock as the trace.
- **Setup:** session (A for tuning, B for gating, or other), condition (quiet, fan, tv, music), placement (arm, table, none), speaker (adult, child), script, device (prefilled from `navigator.userAgentData`) and optional notes (read at Export). Chrome's full version comes from `userAgentData`'s `fullVersionList`. Each cell's script is preselected: S1 quiet × arm, S2 quiet × table, S3 fan × arm, S4 fan × table, S5 TV × arm, S6 TV × table (30 short phrases each); music or placement `none` preselect `noise`, the 15 min noise-only recording. For fan and TV noise-only, switch the script to `noise` by hand. Start snapshots the setup and locks it until Discard or the next Start (a failed or cancelled recording unlocks it).
- **Procedure:** press Start and keep the page in front. A wake lock keeps the screen on; if it is refused (battery saver), set the screen timeout to 30 min first. For each phrase, hold the big button, or a Bluetooth page-turner key (Space, Page Down, Page Up, Right arrow or Enter), from just before you start speaking until just after you finish. The next phrase appears 2.0 s after the release. A press during that countdown is still recorded and logged as an extra label (early press); holds under 50 ms are dropped and logged; a key hold is dropped if the window loses focus. Press Stop at the end: the page records at least 1.5 s more (to the end of the next 250 ms batch), then stops. The noise-only recording stops by itself after exactly 15 min.
- **Fails closed:** a recording ends with an error, and can't be exported, if Silero isn't running from its first frame, a batch doesn't continue the previous one, the engine reports an error (VAD, worker, context, or a denied, missing, lost or muted mic), the page is hidden, the audio context stops running, or no batch arrives for 1 s. Record it again.
- **Incomplete runs:** a run stopped before the end of its script (fewer than 30 phrases, or less than 15 min of noise) still exports, but the line next to Export, and the log, flag it: `Stopped early: … (incomplete: not a protocol trace)`. Don't commit those as protocol traces.
- **Export** saves 2 files, `trace-<session>-<condition>-<placement>-<speaker>-<YYYYMMDDTHHMMSSZ>.json` and `.bin` (UTC, ISO 8601 basic; the format is `src/vad-trace/format.ts`). If Chrome asks to download multiple files, choose Allow, then check that both files are in Downloads; Export stays available until Discard or the next Start. Rename them to `trace.json` and `trace.bin` in their own folder (scripts/vad-eval.ts finds only `trace.json`): speech cells go in `test/traces/session-<A|B>/<condition>-<placement>[-child]/`, and noise-only recordings in `test/traces/session-<A|B>/<condition>-noise/` (`fan-noise/`, `tv-noise/`, `music-noise/`), because fan and TV noise recorded at `table` would otherwise land in `fan-table/` and `tv-table/`, the folders of the S4 and S6 speech cells. The file names don't include the script; the Export log line names it after the two file names, and trace.json holds it as `scriptId`. If the status line says labels fell outside the trace and were dropped, report it.
- **Until T40 (#51)**, `DEFAULT_VAD_BACKEND` is `'energy'`, so the page's `Worker` subclass sends each `reset` with `vad: 'silero'`; the log says `reset shim: n reset(s) rewritten to silero` (n counts since the page loaded) whenever a recording ends.
- **Privacy:** feature traces only. The page never cuts a clip (no `take`, `getClip`, `process` or `getProcessed`), stores nothing in the browser, and discards everything on `pagehide`.

## Writing a new lab page

- Add `lab/<name>.html` and `lab/<name>.ts`, and link the page from `lab/index.html`.
- Use `lab/common.ts` (`el`, `fmt`, `logPanel`) and `lab/lab.css`. No inline script or style, and no HTML strings.
- A lab-only AudioWorklet goes in `lab/<name>.worklet.ts` and is loaded with `import url from './<name>.worklet.ts?worker&url'` and `ctx.audioWorklet.addModule(url)`.
- `pnpm typecheck` and `pnpm lint` cover `lab/`: pages through the `"lab"` entry in `tsconfig.app.json`, and lab worklets (`lab/**/*.worklet.ts`) through `tsconfig.worklet.json` (audioworklet types, no DOM), like `src` worklets.
