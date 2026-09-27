# Talking Bear: run-to-completion todo list

This is the checklist for taking the 112 task issues (#12–#123) to a released v1.0.0.

- **Task index:** #3. **Epics:** #4–#11.
- **Machine-readable graph:** [`tasks.json`](../../.claude/skills/orchestrate/tasks.json).
- **How to start:** [`README.md`](README.md).
- **Protocol:** [`.claude/skills/orchestrate/SKILL.md`](../../.claude/skills/orchestrate/SKILL.md).

The orchestrator keeps the live status on GitHub, as `ORCH-STATE` comments on each issue and an `ORCH-DASHBOARD` comment on #3. This file is the plan; GitHub is the ledger.

**Legend:**

- 🤖 = an agent task (the orchestrator runs it); ⭐ = on the path to a talking, animated bear on the phone (scheduled first with `PRIORITY=demo`);
- 🧑 = an owner task (you, with the D1 Pixel or a decision);
- **W** = dependency wave (tasks in the same wave can run in parallel once their blockers are closed).

## Phase 0 — one-time setup (you)

- [ ] **Merge the planning follow-up PR** (branch `claude/talking-bear-planning-k6a0vj`). It carries the plan corrections the issues rely on (Kaiser β = 6.0, the Silero parity tiers, the proximity gate, the escalation windows) and this `.claude/` orchestration package. The orchestrator refuses to start until both are on `main`. (The planning session opens and merges it for you.)
- [ ] **Environment setup script** (Claude Code on the web → the cloud environment menu in the session's title bar → Edit → Setup script). The default container has Node 22, pnpm 10 and a Chromium build for an older Playwright; the repo pins Node 24.21.0, pnpm 12.6.0 and Playwright 1.63.0. Without this, most browser tests can only validate in CI, which is much slower. Suggested script:

  ```bash
  set -eu
  # Node 24.21.0 + pnpm 12.6.0, first on PATH
  mkdir -p /opt/node24 /root/.local/bin
  curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz | tar -xJ -C /opt/node24 --strip-components=1
  /opt/node24/bin/npm install -g pnpm@12.6.0 --ignore-scripts
  ln -sf /opt/node24/bin/node /opt/node24/bin/npm /opt/node24/bin/npx /opt/node24/bin/pnpm /root/.local/bin/
  # Chromium for Playwright 1.63 (needs the Playwright download hosts allowed, below)
  env -u PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    /opt/node24/bin/npx -y playwright@1.63.0 install chromium || echo "Playwright browser download failed: browser tests will validate in CI"
  # espeak-ng for T39 (the one-off TTS corpus)
  apt-get update -qq && apt-get install -y -qq espeak-ng || echo "espeak-ng unavailable: T39 will ask you"
  ```

  Go needs nothing: `server/go.mod` asks for Go 1.27.1, and the installed Go downloads it through `proxy.golang.org`. There is **no Docker daemon** in the sandbox; Docker tasks (T95–T99) validate through their CI jobs.
- [ ] **Network access** (same Edit screen). Allowed today: npm, `proxy.golang.org`, GitHub, `nodejs.org`, `archive.ubuntu.com`. Add the Playwright browser hosts `cdn.playwright.dev` and `playwright.download.prss.microsoft.com` for the script above. For T32 (Silero weights), allow the host the issue fetches from if the task reports it blocked.
- [ ] **Optional labels:** create `task`, `agent`, `owner-device`, `blocked` and `needs-human` in the repo's Labels page. The issue tooling can't create labels, so the tasks currently carry only `m1`–`m8`.
- [ ] **Merge policy.** `auto` (recommended; you asked not to be the bottleneck): the orchestrator squash-merges green, up-to-date, in-scope, Opus-reviewed PRs, and leaves release and workflow-permission changes to you. `human`: you merge every PR.
- [ ] **Parallelism.** Default is 3 concurrent tasks. More means more merge conflicts on shared files.
- [ ] **Start the orchestrator:** a new Claude Code session on this repo, model **Opus 5.5**, with the start message in [`README.md`](README.md) (`/orchestrate …`).
- [ ] **Keep an eye on the session or the dashboard.** The orchestrator push-notifies you when an owner task is ready, a task is blocked on a question, or a PR needs your merge. If push notifications aren't available in the session, it says so, and the "Waiting on you" list on #3 is the place to look.

## Owner checkpoints (plan your device time)

Each owner task becomes *ready* when its blockers close. The orchestrator tells you when. The agent tasks it gates wait for you; everything else keeps going.

| Owner task | Issue | Ready after | Gates (agent work waiting on you) | What you do |
|---|---|---|---|---|
| T31 m1-device | #42 | T26 #37, T27 #38, T28 #39, T29 #40, T30 #41 | — (milestone exit only) | ~2–3 h: M1 lab experiments on D1 (routing, latency, continuity, platform), plus the 50-loop self-trigger check. Do T108 in the same sitting. |
| T47 vad-session-a | #58 | T44 #55, T43 #54, T40 #51 | T48 #59 | ~1.5 h: X-V2 bench; record session-A feature traces (180 phrases + noise); idle CPU |
| T49 vad-session-b | #60 | T48 #59, T46 #57 | T50 #61 | ~1.5 h on a *different day*: session-B traces; live VAD check |
| T59 m3-listening | #70 | T56 #67, T57 #68, T58 #69, T55 #66 | T60 #71 | ~1 h + listeners (≥ 5, kids if possible): voice A/B/X votes, spectrum, voice-chain timing |
| T65 bear-review | #76 | T64 #75 | T73 #84 | 10 min: approve Juni's first render (or list changes) |
| T73 m4-device | #84 | T70 #81, T71 #82, T72 #83, T65 #76 | — (milestone exit only) | ~1.5 h: perf, lip-sync constant L, mouth features, heap check |
| T84 m5-device | #95 | T82 #93, T83 #94 | T85 #96 | ~1.5 h + ≥ 5 people: gesture traces, long-press hygiene, sfx never records |
| T91 m6-device | #102 | T101 #112 (plus T89, T90) | — (milestone exit only) | ~1 h, **same sitting as T101**, on the deployed origin: install the WebAPK, airplane-mode cold start, permissions, update propagation |
| T101 release-v010 | #112 | T100 #111, T98 #109 | T91 #102 | 20 min: tag v0.1.0, make the GHCR package public, verify; then deploy and do T91 |
| T108 x-e8-e4 | #119 | same as T31 | T109 #120 | ~45 min, **same sitting as T31**: phone call/alarm during listening and playback, Bluetooth headset (remote DevTools snippets in the issue) |
| T112 m8-final | #123 | T110 #121, T111 #122, T103 #114 | — (milestone exit only) | ~half day: full §10 checklist, battery/thermal runs, budgets, tag v1.0.0 |

**Critical path:** with 3 tasks in parallel, throughput (112 tasks) matters more than any single chain. The device-gated chains still set the pace late in the project: T47 → T48 → T49 → T50 (VAD tuning; session B at least a day after session A) and T101 → T91 (release, then the M6 phone checks). Do T47 as soon as it's ready.

## Milestone checklists

Tick these as the issues close. The orchestrator's dashboard on #3 is the live view.

### M1 — Audio loop with a placeholder circle (epic #4)

| ✓ | Task | Issue | W | Kind | Title | Blocked by |
|---|---|---|---|---|---|---|
| ☐ | T01 | #12 | 1 | 🤖⭐ | Repo conventions: CLAUDE.md, editor config, device-notes and ADR templates | — |
| ☐ | T02 | #13 | 2 | 🤖⭐ | Toolchain scaffold: pnpm, Vite 8, TypeScript 7 project references, oxlint, Prettier, Vitest (node) | #12 |
| ☐ | T03 | #14 | 3 | 🤖⭐ | CI: verify workflow (lint, format, typecheck, unit, build) and Dependabot | #13 |
| ☐ | T04 | #15 | 4 | 🤖⭐ | Vitest Browser Mode project (Chromium via Playwright) with fake-media flags | #13, #14 |
| ☐ | T05 | #16 | 3 | 🤖⭐ | WAV read/write utilities and a deterministic synthetic fixture generator | #13 |
| ☐ | T06 | #17 | 3 | 🤖⭐ | Single source of response headers (server/headers.json) and vite preview headers | #13 |
| ☐ | T07 | #18 | 5 | 🤖⭐ | Playwright e2e harness against vite preview with production headers (fake mic, CSP recorder, CI job) | #14, #15, #16, #17 |
| ☐ | T08 | #19 | 3 | 🤖⭐ | DSP: biquad filters (Butterworth HPF/LPF, cascade) with tests | #13 |
| ☐ | T09 | #20 | 3 | 🤖⭐ | DSP: frame-indexed ring buffer with model-based tests | #13 |
| ☐ | T10 | #21 | 3 | 🤖⭐ | DSP: Kaiser-windowed polyphase sinc resampler (streaming + offline) with property tests | #13 |
| ☐ | T11 | #22 | 4 | 🤖⭐ | DSP: energy gate with adaptive noise floor (asymmetric EMA, hysteresis, digital-silence guard) | #19 |
| ☐ | T12 | #23 | 3 | 🤖⭐ | DSP: shared VAD segmenter (hysteresis, hangover, min speech, max utterance) with property tests | #13 |
| ☐ | T13 | #24 | 4 | 🤖⭐ | Typed message protocol and shared audio constants/types | #23 |
| ☐ | T14 | #25 | 5 | 🤖⭐ | Capture AudioWorklet: HPF, 12 s ring, continuous 16 kHz decimation, tagged frames, deferred chunked take (+ Node tests) | #19, #20, #21, #24 |
| ☐ | T15 | #26 | 6 | 🤖 | Browser Mode test: real capture worklet in an OfflineAudioContext | #25, #15 |
| ☐ | T16 | #27 | 5 | 🤖⭐ | DSP worker (energy backend): VadCore + worker glue, reset/epoch protocol, fixture-driven tests | #22, #23, #24, #21, #16 |
| ☐ | T17 | #28 | 5 | 🤖⭐ | Session state machine: pure reducer implementing all of plan §3.4 (rows 1–46, 35b, 40b; entry/exit actions) | #24 |
| ☐ | T18 | #29 | 6 | 🤖 | Session reducer property tests (plan §4.9.1 invariants) with a discrete-event environment simulator | #28 |
| ☐ | T19 | #30 | 5 | 🤖⭐ | Audio output: master bus, output clock (getOutputTimestamp), placeholder player and test-beep sfx with at-speaker end detection | #24, #15 |
| ☐ | T20 | #31 | 3 | 🤖⭐ | Platform adapters: injectable Clock, visibility (single source), wake lock, mic permission | #13 |
| ☐ | T21 | #32 | 6 | 🤖⭐ | Audio engine: AudioContext lifecycle, mic manager (req ids), worklet+worker wiring, take assembly, restart; X-T2 build check | #25, #27, #30 |
| ☐ | T22 | #33 | 7 | 🤖 | Coverage thresholds (≥ 90 % lines and branches) on the pure modules, enforced in CI | #29, #27, #25 |
| ☐ | T23 | #34 | 7 | 🤖⭐ | Effect runner + session store: executes reducer effects against engine/player/sfx/platform, named timers, event queue | #32, #28, #31 |
| ☐ | T24 | #35 | 8 | 🤖⭐ | Placeholder UI + app bootstrap: level/state circle, tap-to-wake, parent sheet, mic-denied screen, data-state | #34 |
| ☐ | T25 | #36 | 9 | 🤖⭐ | E2E test hooks (dead-code-eliminated in production): transition log, visibility control, level probe, output tap; YIN | #35, #18 |
| ☐ | T26 | #37 | 10 | 🤖⭐ | E2E specs for M1: loop (3 fixtures), too-short, too-long, deny — all with zero CSP violations | #36 |
| ☐ | T27 | #38 | 3 | 🤖 | Lab infrastructure + lab/routing (X-E1 output routing, X-E2 input processing spectrum) | #13 |
| ☐ | T28 | #39 | 4 | 🤖 | lab/platform: X-E6 backgrounding, X-E10 rates, X-E11 wake lock event logger | #38, #31 |
| ☐ | T29 | #40 | 7 | 🤖 | lab/latency: X-E5 loopback click latency vs getOutputTimestamp prediction, echo-tail → cooldown | #38, #32 |
| ☐ | T30 | #41 | 7 | 🤖 | lab/continuity: X-R4 silent-sink suspension vs capture gaps (graph A/B, load generator, resume latency) | #38, #32 |
| ☐ | T31 | #42 | 11 | 🧑 | Owner: M1 device experiments on D1 and M1 exit criteria | #37, #38, #39, #40, #41 |

### M2 — VAD tuning (epic #5)

| ✓ | Task | Issue | W | Kind | Title | Blocked by |
|---|---|---|---|---|---|---|
| ☐ | T32 | #43 | 3 | 🤖 | Silero weights: pinned ONNX fetch, protobuf reader, fp16 weights.bin + provenance, decoder, licence notices | #13 |
| ☐ | T33 | #44 | 4 | 🤖 | Silero v6 TS port (DOM-free, allocation-free) + two-tier parity vs onnxruntime-web + golden test | #43, #16, #21 |
| ☐ | T34 | #45 | 5 | 🤖⭐ | DSP: voicing score (normalised autocorrelation, F0 70–600 Hz, 32 ms window) | #22 |
| ☐ | T35 | #46 | 7 | 🤖 | Worker: Silero backend in VadCore (per-epoch LSTM reset, fallback to energy, optional pre-gate, vadStats) + energy voicing rule | #44, #45, #27, #32 |
| ☐ | T36 | #47 | 8 | 🤖 | Worker: proximity gate on Silero segments (active level vs onset floor ≥ X dB, else misfire) | #46 |
| ☐ | T37 | #48 | 3 | 🤖 | VAD feature-trace format (trace.json + trace.bin), front-end config hash, staleness check | #13 |
| ☐ | T38 | #49 | 9 | 🤖 | Worker feature-trace stream (setTrace) for lab/vad-trace and the debug overlay | #46, #48, #47 |
| ☐ | T39 | #50 | 10 | 🤖 | TTS regression speech: espeak-ng generation (pinned), clean 16 kHz WAVs + exact labels, e2e TTS fixtures, committed | #16, #21, #36 |
| ☐ | T40 | #51 | 12 | 🤖 | Make Silero the default VAD backend; TTS e2e specs; keep e2e green | #46, #50, #37, #66 |
| ☐ | T41 | #52 | 11 | 🤖 | Deterministic corpus mixer: noises (fan, AM, TV babble, music, clatter), RIR + phone band, SNR mixing, scenes + labels | #50, #19 |
| ☐ | T42 | #53 | 12 | 🤖 | VAD eval harness (corpus + trace replay), metrics, CI TTS gate (fast subset on PR, full nightly) | #52, #48, #47 |
| ☐ | T43 | #54 | 6 | 🤖 | lab/bench: X-V2 Silero TS vs ORT per-frame timing in a Worker, worklet-DSP quantum timing | #44, #38, #25 |
| ☐ | T44 | #55 | 11 | 🤖 | lab/vad-trace: listen-only capture on D1, hold-to-talk labels, scripts, export trace.json/.bin (no audio) | #49, #38, #50 |
| ☐ | T45 | #56 | 10 | 🤖 | Debug overlay (?debug=1): Silero p, band dB, floor, gate, inference timings, state/epoch | #49, #35 |
| ☐ | T46 | #57 | 11 | 🤖 | lab/vad-live: production pipeline + debug overlay + tally UI (aggregate counts only) | #56, #38, #50 |
| ☐ | T47 | #58 | 13 | 🧑 | Owner: X-V2 bench + session A real-voice traces on D1 (tuning set) + idle CPU | #55, #54, #51 |
| ☐ | T48 | #59 | 14 | 🤖 | Grid search on session A traces, freeze VAD params, ADR 0001 (backend + pre-gate) | #58, #53 |
| ☐ | T49 | #60 | 15 | 🧑 | Owner: session B held-out traces with frozen params + live check (vad-live) + idle CPU re-check | #59, #57 |
| ☐ | T50 | #61 | 16 | 🤖 | CI real-voice gate on session-B traces + stale-trace policy (needs-retrace) + retrace issue template | #60, #53 |

### M3 — Voice effect (epic #6)

| ✓ | Task | Issue | W | Kind | Title | Blocked by |
|---|---|---|---|---|---|---|
| ☐ | T51 | #62 | 4 | 🤖⭐ | DSP: real FFT, BS.1770 loudness (gated + short-clip), true-peak (4×), gain rule, fades | #21, #19 |
| ☐ | T52 | #63 | 5 | 🤖⭐ | DSP: mouth envelope analysis (jaw, width, round, teeth @ 10 ms) from the processed buffer | #62 |
| ☐ | T53 | #64 | 6 | 🤖⭐ | DSP: processVoice — HPF → trim → sinc resample 1/p → loudness → ceiling → fades → envelope; clipping flag | #62, #63, #45, #24 |
| ☐ | T54 | #65 | 5 | 🤖⭐ | Settings store (pure): defaults, validation, persistence in localStorage with try/catch, subscriptions | #24 |
| ☐ | T55 | #66 | 11 | 🤖⭐ | Wire the voice chain: worker process, rate-1 player, Quiet mode bus, settings sheet (voice + Quiet), e2e update | #64, #65, #37 |
| ☐ | T56 | #67 | 11 | 🤖 | lab/voices: X-F1 blind A/B/X listening test (linear playbackRate vs sinc vs PSOLA; 1.4/1.7/2.0), votes only | #64, #38, #50 |
| ☐ | T57 | #68 | 5 | 🤖 | lab/spectrum: X-F2 energy share above 8 kHz of live captures, statistics only | #38, #62 |
| ☐ | T58 | #69 | 7 | 🤖 | lab/bench: X-F3 voice-chain timing (1/5/10 s clips) | #54, #64 |
| ☐ | T59 | #70 | 12 | 🧑 | Owner: X-F1 listening test (≥ 5 listeners incl. children), X-F2, X-F3 on D1; clicks by ear | #67, #68, #69, #66 |
| ☐ | T60 | #71 | 13 | 🤖 | ADR 0002: default voice preset from X-F1 (and whether formant presets are worth it); apply default | #70 |

### M4 — The bear and animation (epic #7)

| ✓ | Task | Issue | W | Kind | Title | Blocked by |
|---|---|---|---|---|---|---|
| ☐ | T61 | #72 | 2 | 🤖⭐ | Art: author art/bear.svg (Juni) — one id per part, data-pivot, data-parent, palette-only fills | #12 |
| ☐ | T62 | #73 | 3 | 🤖⭐ | scripts/gen-bear-parts.ts: compile art/bear.svg → src/art/bear-parts.gen.ts (+ --check in CI) | #72 |
| ☐ | T63 | #74 | 3 | 🤖⭐ | Anim core: pose channels (Ch), spring bank (semi-implicit Euler @ 1/120 s), fixed-step accumulator with interpolation | #13 |
| ☐ | T64 | #75 | 5 | 🤖⭐ | Rig + Canvas 2D renderer (Path2D once, setTransform walk, parametric mouth, eye clip, DPR cap) + screenshot tests | #73, #74, #15 |
| ☐ | T65 | #76 | 6 | 🧑 | Owner: review Juni's first render (Q4) and optional reverse-image search (X-L1) | #75 |
| ☐ | T66 | #77 | 4 | 🤖⭐ | Anim: base-state poses and keyframed clips (wake, sleep, doze, attentive, thinking, confused, earTwitch, shrug) + clip sampler | #74 |
| ☐ | T67 | #78 | 4 | 🤖⭐ | Anim layers: blink (Poisson), breathing, gaze/saccades with head follow, ear twitch, mood; seeded RNG | #74 |
| ☐ | T68 | #79 | 6 | 🤖⭐ | Animation director: pure reducer for plan §3.5 base states, crossfades, session anim events (reaction rules in M5) | #77, #28 |
| ☐ | T69 | #80 | 6 | 🤖⭐ | Mouth layer: envelope → Jaw/MouthW/MouthRound/Teeth sampled at clipTimeNow + L; head bob; brow lift | #74, #63, #30 |
| ☐ | T70 | #81 | 12 | 🤖⭐ | Replace the circle with Juni: rAF loop (fixed step, throttling, hidden pause, reduced motion), director ← session, mouth ← processed envelope | #75, #78, #79, #80, #66 |
| ☐ | T71 | #82 | 6 | 🤖 | lab/rig: SVG DOM debug view + channel sliders + canvas side by side + perf stress (X-A1 helper) | #75, #38, #78 |
| ☐ | T72 | #83 | 7 | 🤖 | lab/envelope: X-A3 plot jaw/width/round/teeth for spoken phrases (in memory, no audio stored) | #64, #38 |
| ☐ | T73 | #84 | 13 | 🧑 | Owner: M4 device checks on D1 — X-A1 perf, X-A2 fit L, X-A3 mouth features, X-A4 flat heap, X-E5 re-check | #81, #82, #83, #76 |

### M5 — Interactions (epic #8)

| ✓ | Task | Issue | W | Kind | Title | Blocked by |
|---|---|---|---|---|---|---|
| ☐ | T74 | #85 | 6 | 🤖 | Input: bone-attached hit regions with padding and priority; hitTest in CSS px | #75, #86 |
| ☐ | T75 | #86 | 3 | 🤖 | Input: pure gesture recogniser (tap/multi-poke, long-press, stroke/pet, tickle, flick, pinch, hug, all-over) with tests | #13 |
| ☐ | T76 | #87 | 4 | 🤖 | Input: DOM pointer adapter (coalesced events, capture, touch-action, contextmenu, ticks) → recogniser | #86 |
| ☐ | T77 | #88 | 6 | 🤖 | Synthesised sound effects for all reactions (Web Audio; no assets); peak ≤ −9 dBFS, ≥ 5 ms attack | #30 |
| ☐ | T78 | #89 | 13 | 🤖 | Reaction animation clips (sneeze, boing, pet, wobble, dizzy, ear droop, squish, giggle, laugh fit, hug, …) + gentle variants | #77, #81 |
| ☐ | T79 | #90 | 14 | 🤖 | Reactions table: (region × gesture) → reaction {name, priority, sfx, clip, gentle, P4 variant, haptic} | #86, #88, #89 |
| ☐ | T80 | #91 | 15 | 🤖 | Director reaction rules: priorities, interruption, queue(1, 500 ms), 800 ms cooldown, ×3 escalation, Sustained, talking rules | #79, #90 |
| ☐ | T81 | #92 | 6 | 🤖 | Haptics: navigator.vibrate patterns gated by settings and sticky activation; X-A6 logging | #87, #65 |
| ☐ | T82 | #93 | 16 | 🤖 | Wire interactions: adapter → recogniser → table → director → session; sfx synths; lookAt; e2e gestures + sfx-gating | #91, #87, #92, #81, #85 |
| ☐ | T83 | #94 | 7 | 🤖 | lab/gestures: record labelled pointer traces (X-A7) + scripts/gesture-eval.ts confusion matrix | #87, #82 |
| ☐ | T84 | #95 | 17 | 🧑 | Owner: M5 device checks — X-A5 long-press hygiene, X-A6 vibrate, X-A7 traces (≥ 5 people), sfx never records, barge-in | #93, #94 |
| ☐ | T85 | #96 | 18 | 🤖 | Tune recogniser thresholds on recorded traces to ≥ 90 %; CI replay test on committed traces | #95 |

### M6 — PWA and offline (epic #9)

| ✓ | Task | Issue | W | Kind | Title | Blocked by |
|---|---|---|---|---|---|---|
| ☐ | T86 | #97 | 13 | 🤖 | art/icon.svg → committed PNG icons (assets-generator, run once) + installer screenshots (WebP via canvas) | #81 |
| ☐ | T87 | #98 | 14 | 🤖 | vite-plugin-pwa (generateSW, prompt) + manifest + register.ts update policy + persist + beforeinstallprompt; settings Install/Restart | #97, #66 |
| ☐ | T88 | #99 | 15 | 🤖 | scripts/check-dist.mjs: precache completeness, no data: JS, no __bearTest, self-contained worklet, no dist/lab, licences present | #98 |
| ☐ | T89 | #100 | 16 | 🤖 | E2E: offline (SW → setOffline → reload → full loop) and installability (CDP, with negative control) | #99 |
| ☐ | T90 | #101 | 17 | 🤖 | E2E: update flow at one origin via a v1/v2 switching proxy — no reload while Recording/Playing; applied on hidden | #99, #100 |
| ☐ | T91 | #102 | 22 | 🧑 | Owner: M6 device checks — install WebAPK, airplane-mode cold start, X-E7 permissions, X-E9 autoplay, X-P2 update propagation, X-P3 persistence | #100, #101, #112 |

### M7 — Image, headers and CI (epic #10)

| ✓ | Task | Issue | W | Kind | Title | Blocked by |
|---|---|---|---|---|---|---|
| ☐ | T92 | #103 | 4 | 🤖 | server/: Go stdlib static server (embed all:dist, headers.json, ETags, variants, 304/206/416/404/405, healthz, -probe) + tests | #17 |
| ☐ | T93 | #104 | 16 | 🤖 | scripts/precompress.mjs: brotli q11 + gzip -9 for html/js/css/json/webmanifest/svg/bin (skip files under 1 KB or saving under 5 %) | #99 |
| ☐ | T94 | #105 | 16 | 🤖 | .size-limit.cjs budgets (initial JS/CSS, total precache ≤ 1 MB brotli over manifest URLs) + CI step | #99 |
| ☐ | T95 | #106 | 17 | 🤖 | Dockerfile (multi-stage, digests re-resolved, BUILD_MODE, SBOM scan stage) + .dockerignore + Dependabot docker | #103, #104, #105 |
| ☐ | T96 | #107 | 18 | 🤖 | CI image-smoke: buildx amd64 production image, production run flags, scripts/check-headers.sh, hook-free Playwright smoke | #106, #100 |
| ☐ | T97 | #108 | 19 | 🤖 | Switch the CI e2e job to run against the e2e-mode image (+ v1/v2 image upstreams for the update spec) | #107, #101 |
| ☐ | T98 | #109 | 19 | 🤖 | Trusted Types in Report-Only (HTML only) + default policy as first import + csp e2e spec collecting the X-P5 list | #107 |
| ☐ | T99 | #110 | 19 | 🤖 | CI compose-headers (X-P4): front Caddy + sidecar Caddy + image; exact headers per path, no duplicates | #107 |
| ☐ | T100 | #111 | 20 | 🤖 | release.yml: on v*.*.* tag — reusable ci (contents: read), arm64 QEMU smoke, multi-arch push to GHCR with provenance + SBOM | #108, #110 |
| ☐ | T101 | #112 | 21 | 🧑 | Owner: tag v0.1.0, make the GHCR package public, verify the image and record the digest | #111, #109 |

### M8 — Polish (epic #11)

| ✓ | Task | Issue | W | Kind | Title | Blocked by |
|---|---|---|---|---|---|---|
| ☐ | T102 | #113 | 17 | 🤖 | Settings sheet v2: behind a 1 s long-press gear; voice, Quiet, Gentle, haptics, noisy-room NS, sleep timeout — all wired | #98, #93, #92 |
| ☐ | T103 | #114 | 18 | 🤖 | Settings parent section: mic retry + site-settings help, Install, restart-when-ready, privacy note, licences screen; no outbound links | #113 |
| ☐ | T104 | #115 | 19 | 🤖 | Kid-first text-free UI: pulsing paw tap-to-wake, mic-denied icon + cupped-ear mime, mic-muted/error icons, ≥ 48 dp targets | #114 |
| ☐ | T105 | #116 | 20 | 🤖 | Too-noisy hint (floor above −35 dBFS), margin/proximity raise after 3 noisy cap hits, hold-to-talk fallback | #115, #47 |
| ☐ | T106 | #117 | 21 | 🤖 | Playful 'too loud!' reaction after replaying a clipped take | #115, #66, #116 |
| ☐ | T107 | #118 | 20 | 🤖 | Accessibility: accessible names, aria-live only on entering non-listening states, reduced motion + Gentle verified | #115 |
| ☐ | T108 | #119 | 11 | 🧑 | Owner: X-E8 phone call/alarm during capture & playback, X-E4 Bluetooth, optional X-P6 (in the M1 device session) | #37, #38, #39, #40, #41 |
| ☐ | T109 | #120 | 18 | 🤖 | Bluetooth input policy (per X-E4) + phone-call/interruption handling (per X-E8) | #119, #113 |
| ☐ | T110 | #121 | 22 | 🤖 | Enforce Trusted Types on HTML (X-P5 clean) — merged CSP for text/html; e2e asserts zero report-only and enforce violations | #109, #118, #116, #117 |
| ☐ | T111 | #122 | 17 | 🤖 | Performance marks (first frame, tap→listening) + debug readout + optional Lighthouse CI on main | #81, #105 |
| ☐ | T112 | #123 | 23 | 🧑 | Owner: §10 manual checklist on D1 + desktop, battery/thermal runs, X-D1 (optional), budget sign-off/waivers, tag v1.0.0 | #121, #122, #114 |

## Phase 9 — wrap-up

- [ ] All 112 task issues are closed. Epics #4–#11 are closed by the orchestrator once all their sub-issues are closed.
- [ ] `v0.1.0` (T101) and `v1.0.0` (T112) are published to GHCR, with the digests recorded in the issues.
- [ ] The research spikes under `docs/research/spikes` are deleted as their "delete when" conditions are met. The orchestrator files a small cleanup PR at the end.
- [ ] The orchestrator posts a final summary on #3 and releases its lock.

