# Icons and installer screenshots

The web app manifest (plan §4.7, written by #98) lists three icons and four installer screenshots. They are generated **once**, by hand, and committed. CI never generates them: the build copies the committed files from `public/` into `dist/`.

| File | Size | Purpose |
|---|---|---|
| `public/icons/icon-192.png` | 192 × 192 | manifest icon, purpose `any`; also the page's `<link rel="icon">` in `index.html` |
| `public/icons/icon-512.png` | 512 × 512 | manifest icon, purpose `any` |
| `public/icons/maskable-512.png` | 512 × 512 | manifest icon, purpose `maskable` |
| `public/screenshots/phone-1.webp` | 1080 × 1920 | `form_factor: narrow`: the bear listening |
| `public/screenshots/phone-2.webp` | 1080 × 1920 | `form_factor: narrow`: the bear talking back |
| `public/screenshots/phone-3.webp` | 1080 × 1920 | `form_factor: narrow`: the duckling (Fenn) talking back (T127) |
| `public/screenshots/desktop-1.webp` | 1920 × 1080 | `form_factor: wide`: desktop |

The service worker (plan §4.7, #98) precaches the icons but **not the screenshots**, which only the installer uses. The icons are also WebAPK update fields: changing an icon makes every installed WebAPK update (plan §4.7). So regenerate the icons only when the art really changes.

## The icon source: `art/icon.svg`

`art/icon.svg` is Juni's head, taken from `art/bear.svg`'s paths, on a `#2F7A6D` circle. It is a 1000 × 1000 viewBox:

1. `<circle id="background">`: the `#2F7A6D` disc, r = 500, filling the canvas.
2. `<g id="juniHead" transform="translate(-35 158.7) scale(1.07)">`, which contains:
   - `<g id="rim">`: the outline described below;
   - the head itself.

**The head** is the neutral rest face the renderer draws. It has every `<path>` of `bear.svg`'s `<g id="head">` subtree, in document order, with the same `id`, `d`, `fill` and `fill-opacity` (23 paths). These are left out:

- `lidUpperL` and `lidUpperR`: `bear.svg` draws the upper lids closed, and the renderer hides them at rest, so the eyes are open;
- `blushL`: reaction-only, and `fill-opacity="0"` anyway;
- `mouthPreview`: `data-skip`. The neutral pose draws no mouth interior.

`browRArch` is added right after `browLArch`. It is browLArch mirrored about x = 500 (every x becomes 1000 − x), which is geometrically identical to the copy the renderer mirrors.

**The rim.** The icon adds one thing the issue doesn't name: a 12-unit #225A51 outline drawn from the head's own silhouette paths, because Juni's fur is the same #2F7A6D as the circle, so without it the ears, notch and tuft vanish into the background; dropping the `rim` group restores the literal version. The rim is `earLFur`, `earRFur`, `tuftFur` and `headFur` again, filled and stroked `#225A51` (the palette's fur shade) with `stroke-width="24"` and round joins. It is drawn before the head, so only the outer 12 units show.

**The maskable safe zone** is a circle of radius 40 % of the canvas, centred on it. Launchers may crop anything outside it. The transform moves the centre of the head's smallest enclosing circle, (500, 319) in `bear.svg` units, to the canvas centre. With the rim, the head reaches 36.9 % of the canvas size on the sampled outline. Measured on the committed `maskable-512.png`, the farthest head pixel is 189.3 px from the centre (37.0 %), and no head pixel lies outside the 40 % circle (204.8 px). That leaves a margin of about 3 % (15 px at 512).

**Authoring rules.** The rules in `art/README.md` apply to `bear.svg` only. `icon.svg` may use `<circle>`, `transform` and `stroke`. Nothing compiles it except the generator.

**If Juni's head changes in `bear.svg`**, redo `icon.svg` the same way:

1. Copy the head paths again, with the same exclusions, the mirrored brow and the rim paths.
2. Re-check the safe zone (see "Checking the icons").
3. Regenerate the icons.

## Regenerating the icons

From the repo root, with no arguments:

```sh
mkdir -p public/icons
pnpm dlx @vite-pwa/assets-generator@2.0.0
```

- **Config.** The generator reads `pwa-assets.config.ts` from the current directory. That config imports nothing, because the generator isn't installed in the project. It emits exactly the three PNGs:
  - **purpose `any`:** the disc on a transparent square, with 5 % padding;
  - **purpose `maskable`:** padding 0 on a `#2F7A6D` background, so the whole square is teal and the head stays inside the safe zone.
  - The PNGs are palette-quantised (the generator's defaults: compression level 9, quality 60), which keeps `#2F7A6D` exact.
- **Output folder.** The generator writes each file next to the source image, so the config's `assetName` steps from `art/` over to `public/icons/`. Don't pass an image path or `--root`: that moves the output folder too. `public/icons/` must already exist; without it the generator fails with ENOENT and writes nothing.
- **The `<link rel="icon" href="/icon.svg" …>` line it prints:** ignore it. `index.html` keeps `<link rel="icon" href="/icons/icon-192.png">` (plan §4.7), and the generator writes no HTML.
- **Not a dependency.** It needs npm registry access. sharp downloads its prebuilt libvips. If pnpm ever blocks sharp's install script, add the flag to this command only: `pnpm dlx --allow-build=sharp @vite-pwa/assets-generator@2.0.0`. Never add the generator or sharp to `package.json`, so `git diff -- package.json pnpm-lock.yaml` must stay empty. That also keeps sharp and libvips out of CI (plan §8).

## Checking the icons

- `file public/icons/*.png` must report `192 x 192` for `icon-192.png` and `512 x 512` for the other two.
- **The safe zone (issue #97, Validation 1)** is checked with a throwaway Playwright script (not committed):
  1. Decode `maskable-512.png` in Chromium.
  2. Count the pixels farther than 0.4 × 512 = 204.8 px from the centre (256, 256) that differ from `#2F7A6D` by more than 2 in any channel. The count must be **0**.
  3. Report the farthest pixel that isn't background, which is the head's extent.
  4. Draw the 40 % circle over the icon, and attach that overlay image to the PR.
  5. As a negative control, the same count on an icon whose head is scaled by 1.3 must be above 0.
- **The `any` icons** must have transparent corners (alpha 0).

## Regenerating the screenshots

```sh
node scripts/gen-screenshots.ts
```

**What it needs:**

- a Playwright Chromium: set `PLAYWRIGHT_BROWSERS_PATH`, or run `pnpm exec playwright install --no-shell chromium`;
- port 4173 free. If something already answers there, the script refuses to run rather than capture another build.

**What it does:**

1. Runs `pnpm build:e2e`.
2. Serves the result with `pnpm preview:e2e` on port 4173, in a process group of its own.
3. Opens each screenshot in Chromium (`channel: 'chromium'`), with the viewport at the screenshot's real size and DPR 1.
4. Calls `__bearTest.showPose(pose, { cssWidth, cssHeight })` with the pose for that file:

   | File | Pose | Size |
   |---|---|---|
   | `phone-1` | `listening` | 1080 × 1920 |
   | `phone-2` | `talkOpen` | 1080 × 1920 |
   | `phone-3` | `talkOpen`, on Fenn | 1080 × 1920 |
   | `desktop-1` | `neutral` | 1920 × 1080 |

   For `phone-3` (a shot with `character: 'fenn'`), the script first clicks `.character-switch`, which exists only while the app is Asleep (where it boots), and waits for the stage canvas's `aria-label` to be "Fenn the duckling" and for its fade-in to end. Then it draws the pose on Fenn.

5. Encodes the canvas in the page with `canvas.toBlob(…, 'image/webp', 0.9)` and writes the bytes.
6. Stops the server: SIGTERM first, then SIGKILL, and it fails if port 4173 still answers. pnpm reports the stopped server as `[ELIFECYCLE] Command failed.`; that line is expected and doesn't affect the exit code.
7. Checks every file. Each must have a RIFF/WEBP header, and Chromium's `createImageBitmap` must decode it to exactly its size.

**Other details:**

- **Determinism.** With the same Chromium, reruns give byte-identical files.
- **Check only.** `node scripts/gen-screenshots.ts --check` runs just the final check on the committed files. It needs no build and no server.
- **When to rerun.** Regenerate the screenshots when a character's look changes. The script redraws all four; the unchanged ones come out byte-identical, so `git status` shows only the files that really changed. A Chromium bump may change the bytes; that is harmless.
