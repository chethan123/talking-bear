# Talking Bear: agent working conventions

## Project

Talking Bear is a client-side-only, installable, offline PWA for Android Chrome. You speak, the bear (Juni) replays you pitched up, and you can touch it for reactions. There is no backend and no analytics, and audio never leaves the device. [`docs/plan.md`](docs/plan.md) is the source of truth; the work is split into one GitHub issue per task, listed in the [Task index](https://github.com/chethan123/talking-bear/issues/3) issue.

## Source of truth

- `docs/plan.md` wins over code comments and issues.
- If an issue and the plan disagree, comment on the issue and stop.
- Decisions Q1–Q8 in plan §12 are final.

## Layout

```
talking-bear/
├── .github/
│   ├── workflows/ci.yml            # PR + main: verify, build, image-smoke, e2e
│   ├── workflows/release.yml       # tag v*.*.*: multi-arch build + push to GHCR
│   └── dependabot.yml              # npm, gomod, docker (digests), github-actions (SHAs)
├── Dockerfile
├── .dockerignore                   # node_modules, dist*, .git, test-results
├── server/                         # Go static server (stdlib only)
│   ├── go.mod
│   ├── main.go                     # embed, handler, probe flag
│   ├── headers.json                # single source of response headers: Go server + vite preview (e2e from M1)
│   ├── headers.go                  # loads headers.json; cache / MIME tables
│   └── main_test.go                # table-driven header, ETag, 304, 206, 404, 405 tests
├── index.html
├── art/
│   ├── bear.svg                    # source art: one id per part, data-pivot, data-parent
│   ├── duck.svg                    # source art for Fenn, same rules
│   └── icon.svg                    # icon source → generated PNGs committed in public/icons
├── public/
│   ├── icons/                      # generated once by @vite-pwa/assets-generator
│   └── screenshots/                # installer screenshots (not precached)
├── src/
│   ├── main.ts                     # bootstrap + wiring
│   ├── app/     machine.ts effects.ts events.ts settings.ts clock.ts
│   ├── audio/   engine.ts capture.worklet.ts player.ts output-clock.ts sfx.ts messages.ts
│   ├── workers/ dsp.worker.ts
│   ├── dsp/     biquad.ts ring-buffer.ts resample.ts energy-gate.ts voicing.ts segmenter.ts
│   │            envelope.ts fft.ts normalize.ts fades.ts yin.ts duck.ts
│   │            silero/{model.ts,weights.ts,weights.bin,weights.provenance.json}
│   ├── anim/    rig.ts pose.ts springs.ts director.ts renderer.ts loop.ts layers/*.ts clips/*.ts
│   │            clips/fenn.ts
│   ├── art/     bear-parts.gen.ts duck-parts.gen.ts   # generated from art/bear.svg, art/duck.svg (committed)
│   ├── characters/ types.ts index.ts juni.ts fenn.ts   # one CharacterSpec per character
│   ├── input/   recognizer.ts pointer-adapter.ts regions.ts
│   ├── reactions/ table.ts fenn-table.ts
│   ├── platform/ wake-lock.ts visibility.ts permissions.ts storage.ts
│   ├── pwa/     register.ts
│   ├── ui/      overlay.ts debug-overlay.ts character-switch.ts styles.css
│   └── test-hooks.ts               # only reachable when VITE_BEAR_TEST_HOOKS==='1'
├── lab/                            # dev-only pages: routing, latency, vad-trace, vad-live, voices, spectrum, bench, gestures, duck
│                                   #   (no page ever stores or downloads captured audio: Q2)
├── scripts/
│   ├── gen-bear-parts.ts   extract-silero-weights.ts   gen-fixtures.ts   gen-corpus.ts
│   ├── precompress.mjs     check-dist.mjs              check-headers.sh
│   ├── bench-voice.ts              duck-svg.test.ts
│   └── vad-eval.ts                 # offline VAD evaluation harness (same TS modules)
├── test/                           # helpers: wav.ts, worklet-scope.ts, fixtures/*.wav(+.json),
│                                   #   traces/<session>/{trace.json,trace.bin} (real-voice feature traces, no audio)
├── e2e/                            # Playwright specs + fixtures/*.wav
├── docs/
│   ├── plan.md                     # this document
│   ├── research/spikes/            # throwaway planning experiments (excluded from lint/build; delete as modules land)
│   ├── device-notes.md             # experiment results per device / Chrome version
│   └── adr/                        # one short ADR per gated decision (VAD backend, default voice, …)
├── package.json  pnpm-lock.yaml  pnpm-workspace.yaml (saveExact, allowBuilds allow-list)
├── tsconfig.json                   # references: app, worklet, worker, node, test
├── tsconfig.app.json  tsconfig.worklet.json  tsconfig.worker.json  tsconfig.node.json  tsconfig.test.json
├── vite.config.ts  vitest.config.ts  playwright.config.ts
├── .oxlintrc.json  .prettierrc  .size-limit.cjs
└── LICENSE  README.md  THIRD_PARTY_NOTICES.md   # Silero (MIT) weights notice, etc.
```

## Commands

- `pnpm dev`: starts the Vite dev server.
- `pnpm build`: builds the production bundle into `dist/`.
- `pnpm preview`: serves `dist/` with `vite preview` on port 4173 (fails if the port is taken).
- `pnpm lint`: runs oxlint with the type-aware rules (oxlint-tsgolint) across all five TypeScript projects.
- `pnpm format`: rewrites every file Prettier handles (`.prettierignore` skips `docs/`, `.claude/`, root Markdown and generated files).
- `pnpm format:check`: checks formatting without writing.
- `pnpm typecheck`: runs `tsc -b` over the five project references (app, worklet, worker, node, test).
- `pnpm test`: runs the Vitest `node` and `worklet` projects once.
- `pnpm test:browser`: runs the Vitest `browser` project (`src/**/*.browser.test.ts` in headless Chromium via Playwright, `channel: 'chromium'`, fake-media flags) in three Vitest processes: `src/anim/frame-alloc.browser.test.ts` (the frame-allocation smoke on Juni) alone first, because the test files of one run share a renderer and a V8 isolate, then `src/anim/frame-alloc-fenn.browser.test.ts` (the same smoke on Fenn) alone, then the rest of the project with both files excluded. Under an agent (`CLAUDECODE` or `AI_AGENT` set) the reporter prints no `[I214 smoke]` line on a pass: unset both, or run the files with `--silent=false`. It is not part of `pnpm verify`; CI runs it as its own step. It needs a Playwright Chromium (`pnpm exec playwright install --no-shell chromium`).
- `pnpm build:e2e`: builds the e2e-mode bundle into `dist-e2e/` (`vite build --mode e2e`, which loads `.env.e2e`: `VITE_BEAR_TEST_HOOKS=1`).
- `pnpm preview:e2e`: serves `dist-e2e/` with `vite preview` on port 4173 (fails if the port is taken), with the production headers from `server/headers.json`.
- `pnpm e2e`: runs `build:e2e`, then the Playwright specs in `e2e/` (`playwright.config.ts`: `channel: 'chromium'`, one worker, no retries). Playwright starts `preview:e2e` itself; locally it reuses whatever already listens on port 4173, so stop other preview servers first. It is not part of `pnpm verify`; CI runs it as the `e2e` job. It needs a Playwright Chromium (`pnpm exec playwright install --no-shell chromium`).
- `pnpm verify`: runs lint, format:check, typecheck and test in that order; it must pass before every PR.

## Rules

1. TypeScript `strict`; no `any` without a `// reason:` comment on the same line.
2. `src/dsp/**` is pure. No DOM, no globals, no timers, `Float32Array` in and out. It must type-check without the DOM lib.
3. No allocation in hot paths: AudioWorklet `process()`, the rAF frame, per-frame DSP. Preallocate and reuse.
4. Runtime dependencies are limited to the plan §8 "Runtime" table (only `workbox-window`). Dev dependencies are limited to the §8 tables and those named in a task.
5. Never commit captured or real-voice audio (plan Q2). Lab pages must never store or download captured audio; exporting aggregate numbers and feature traces is allowed.
6. `docs/research/**` is reference material only. Never import from it.
7. Tests live next to the code as `*.test.ts` (Node) or `*.browser.test.ts` (Vitest Browser Mode). E2E specs live in `e2e/`.
8. One task = one branch `task/tNN-slug` = one PR titled `[TNN] …` containing `Closes #<issue>`.
9. Run the task's **Validation** commands before opening the PR. Never skip, disable or weaken tests or thresholds.
10. If blocked or anything is ambiguous, comment on the issue with the exact question or output and stop.
11. Relative imports inside `src/dsp`, `src/workers` and `src/audio/constants.ts` always end in `.ts`, and only erasable TypeScript syntax is used (no enums, no parameter properties, no namespaces), so Node scripts can import them with type stripping.
12. `src/platform/visibility.ts` is the app's only source of page visibility. No other app code (anything under `src/` except tests) reads `document.visibilityState` or `document.hidden`, or listens for `visibilitychange`, `pagehide`, `freeze` or `resume`: it subscribes to the `Visibility` from `createVisibility()` instead, so the e2e hook `visibility.simulate()` (plan §4.9.3) drives the whole app.

## Glossary

- **epoch**: a per-listen counter. Every `arm` starts a new epoch; every VAD event, clip chunk and processing result carries its epoch or request id, and the session reducer ignores stale ones (plan §3.1).
- **ctx frame** (context-rate frame index): a sample index in the capture worklet's `currentFrame` domain at the `AudioContext` rate. It is the one canonical timeline; 16 kHz VAD frames are converted to it (plan §3.1).
- **take**: the clip cut from the capture ring buffer for one utterance, `take{epoch, id, fromFrame, toFrame}`, deferred by the worklet until `currentFrame ≥ toFrame` and streamed back in transferred chunks (plan §3.1, §3.4 row 20).
- **pre-roll**: the 300 ms before the detected speech onset that a take includes, clamped so it never reaches before `armFrame` (plan §4.2.3, §4.4).
- **hangover**: how long the segmenter waits after speech falls below the negative threshold before it ends the segment; defaults 600 ms (Silero) and 800 ms (energy fallback) (plan §4.2.3).
- **SfxGated**: the session state in which a reaction sound effect is playing and the VAD feed is stopped, so `arm` never overlaps sound; it leaves for `Cooldown` once the latest sfx has left the speaker (plan §3.4 row 34).
- **D1**: the reference device, a mid-range Pixel (6a/7a/8a class, plan Q7); every budget and exit criterion is measured on it (plan §4.10, §5).
