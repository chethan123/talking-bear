# 05 — Vite 8 + vite-plugin-pwa under the planned CSP

A minimal app built with the plan's exact Vite and PWA config, served with the plan's exact header strings and driven by headless Chromium. It checks that the CSP, the service worker and the update flow behave as the plan claims.

The app has:

- a `?worker&url` capture worklet;
- a module worker that fetches `weights.bin`;
- a lazy JS and CSS chunk;
- `getUserMedia` on the fake device;
- `workbox-window` registration in `prompt` mode.

## Findings (Vite 8.3.1, vite-plugin-pwa 1.3.0, Workbox 7.4.1, Chromium 141)

- **CSP.** The plan's CSP allowed the whole flow, with zero enforce-mode violations: SW precache (`offlineReady`), `addModule` of the worklet, the worker fetching a 600 KB `.bin`, lazy chunks, the modulepreload polyfill, `getUserMedia` and CSSOM.
- **Trusted Types.** Under Report-Only, the only sinks hit were `new Worker(…)` and `serviceWorker.register(…)`. With a `default` policy providing `createScriptURL` and TT **enforced**, violations were zero. `Worklet.addModule` is not a sink.
- **`style-src 'self'`** blocks `setAttribute('style')`, `style=""` in HTML strings and injected `<style>` (`runcss.mjs`, `csstest/`). It allows CSSOM. Vite's production output has no inline script or style.
- **Update flow.**
  - `prompt` mode never calls `clients.claim()`, so the first page stays uncontrolled. That's why the plan sets `clientsClaim: true`.
  - `updateSW()` only reloads when called after `onNeedRefresh`. That's why the plan enables the settings restart only when `updateReady`.
  - Scripts: `run3.mjs`, `run4.mjs`, `run5.mjs`, with `server2.mjs` switching between v1 and v2 builds.
- **Headless visibility.** `runhidden.mjs` shows that page visibility can't be driven from headless Playwright; see `06-browser-experiments/headless-visibility`.
- **Inlining.** `vite.config.default.ts` has the default `assetsInlineLimit`. `?worker&url` is emitted as a file anyway, and inlining applies to plain `?url` assets.

## Run

```sh
npm install
./exp.sh     # creates src/weights.bin (random 600 KB stand-in), builds dist/, runs report-only and enforced passes
```

`exp.sh` expects a `dist-tt/` for the enforced pass: a copy of `dist/` whose entry chunk starts with

```js
trustedTypes.createPolicy('default', { createScriptURL: (u) => { const x = new URL(u, location.href); if (x.origin !== location.origin) throw new TypeError(u); return u; } });
```

The v1/v2 update scripts expect two builds (`dist-v2`, …) that differ in content. They were produced by hand during the review.
