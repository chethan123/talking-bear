# 06 — Small browser experiments from the adversarial review

## `offline-audiocontext-worklet/`

**Question:** can Vitest Browser Mode test the real worklet deterministically, without a mic?

**Result** (headless Chromium 141):

- `OfflineAudioContext` exposes `audioWorklet`.
- A processor's transferred `port.postMessage` is delivered to the main thread **during** `startRendering()`: 18 of 18 messages arrived before the promise resolved.
- A message posted from the main thread before rendering is seen at quantum 0.
- 5 s rendered in 16–20 ms.
- Static `import` inside a worklet module works, and `import.meta.url` is defined (`run2.cjs`).

```sh
npm install && node run.cjs && node run2.cjs
```

## `vite-test-hook-dce/`

**Question:** do test hooks behind `if (import.meta.env.VITE_BEAR_TEST_HOOKS === '1')` disappear from production bundles, including worker and worklet sub-bundles?

**Result** (Vite 8.3.1, `worker.format: 'es'`):

- The hooks are fully removed from the main bundle, the `?worker` bundle and the `?worker&url` worklet in `--mode production`.
- They are kept in `--mode e2e` via `.env.e2e`.
- The worklet chunk is self-contained: the shared module is inlined, with no `import`.

```sh
npm install
npx vite build --outDir dist-prod
npx vite build --mode e2e --outDir dist-e2e
grep -r MAIN_HOOK_MARKER dist-prod dist-e2e
```

## `headless-visibility/`

**Question:** can Playwright drive `visibilitychange` in headless Chromium?

**Result: no.** Opening a second page, `bringToFront()`, CDP `Page.setWebLifecycleState` and focus emulation all left `visibilityState === 'visible'`, and no events fired. Hence the plan's `__bearTest.setVisibility()` hook, with real hide, freeze and lock behaviour kept as a device check (X-E6).

```sh
npm install && node run.cjs
```
