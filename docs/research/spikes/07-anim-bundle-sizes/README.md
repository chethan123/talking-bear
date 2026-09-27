# 07 — Animation runtime size measurements

These are minimal entry points bundled with esbuild (`--bundle --minify`) and then gzipped, to size the runtimes compared in plan §4.6.1.

| Entry | Measures |
|---|---|
| `rive-min.js` | `@rive-app/canvas-lite` JS. The wasm is fetched separately: 360 KB gzip lite, up to 907 KB for webgl2. |
| `lottie-min.js` | `lottie-web` light canvas build (54 KB gzip; no `eval`, unlike the full build) |
| `dl-min.js` | `@lottiefiles/dotlottie-web` JS (13.8 KB) plus a 496 KB gzip ThorVG wasm |
| `three-min.js` | three.js renderer + GLTFLoader + AnimationMixer: 629 KB raw / 159 KB gzip |
| `ug.js` | `@use-gesture/vanilla` drag + pinch (9 KB gzip) |

```sh
npm install
for f in *-min.js ug.js; do npx esbuild $f --bundle --minify --format=esm --outfile=out/$f; gzip -9 -c out/$f | wc -c; done
```

The plan chose none of these runtimes; the bear is procedural Canvas 2D. This is kept only as the evidence behind that table.
