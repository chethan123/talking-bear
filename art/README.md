# `art/`: Juni's source art

`bear.svg` is the text source of truth for Juni (plan §4.6.1 and §4.6.5). `scripts/gen-bear-parts.ts` compiles it into `src/art/bear-parts.gen.ts`, and `scripts/bear-svg.test.ts` checks the rules below. Keep to them when you edit the file, or it stops compiling.

## Authoring rules

### The file

- The root is exactly `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1400">`: a design box of 1000 × 1400 units, with y pointing down.
- The only allowed elements are `<svg>`, `<defs>`, `<g>` and `<path>`. Write ellipses and circles as `<path d>` arcs or Béziers.
- No `<ellipse>`, `<circle>`, `<rect>`, `<use>`, `transform`, CSS (`style`, `class`, `<style>`) or gradients.
- No comments, XML declaration, `<title>` or text content, and every attribute is double-quoted. The test parses the file with regexes and rejects anything else.

### Bones

- A rig bone is a `<g id="…" data-pivot="x,y" data-parent="…">`. Its children are the paths and bones nested in it, and its `data-parent` names the bone it is nested in. `root` has no `data-parent`.
- `data-pivot` is in design units. A bone without one takes its parent's pivot. This file gives every bone an explicit pivot.
- The bones and their parents follow the plan §4.6.5 rig:
  - `root` (pivot 500,1340, the feet contact) → `body` (500,1250, squash about the base);
  - `body` → `legL`/`legR` → `footL`/`footR`;
  - `body` → `belly`, `neckerchief` → `knot` → `tailA`, `tailB`;
  - `body` → `armL`/`armR` (300,700 and 700,700) → `pawL`/`pawR`;
  - `body` → `neck` → `head` (500,600);
  - `head` → `earL`/`earR` (pivots at their bases) → `innerEarL`/`innerEarR`;
  - `head` → `tuft`, `blaze`, `browL`, `browR`, `eyeL`, `eyeR`, `cheekBlushL`, `cheekBlushR`, `muzzle`;
  - `muzzle` → `nose`, `upperLip`, `jaw`.

### Parts

Every drawable `<path>` has:

- a unique `id`;
- `fill`: an uppercase `#RRGGBB` colour from the palette below;
- optionally `fill-opacity`;
- `data-parent`: the bone it is nested in, or `root`;
- optionally `data-mirror="…"`: this path is the left part, and the generator also emits a copy mirrored about x = 500 with that id. The copy draws right after its source and belongs to the matching right bone (`legL` → `legR`).

**Draw order** is document order, back to front. Because a mirrored copy draws right after its source, only mirror a part whose right-hand copy may draw at that point.

### Special parts

- **Eyes.** Inside `eyeL` the parts are `scleraL`, `irisL`, `pupilL`, `highlightL`, `lidUpperL` and `lidLowerL`, in that order (and the same with `R`). The sclera has `data-clip="true"`: the renderer clips the iris, pupil and highlight drawn right after it. Eye parts are never mirrored, because a mirrored copy would land between a sclera and its iris.
- **Lids.** `lidUpperL` and `lidUpperR` are drawn **closed**. The renderer scales them in y about their top edge by the `LidL`/`LidR` channel (0 = hidden, 1 = closed), so the raw file shows Juni with closed eyes. The lower lids are static.
- **Mouth.** The mouth interior, tongue and teeth are drawn in code, at the anchor (500, 525). The SVG only has the neutral preview `mouthPreview`, with `data-skip="true"`, which the generator ignores.
- **Blush.** `blushL` (mirrored to `blushR`) ships with `fill-opacity="0"`. It is reaction-only, and the renderer drives its alpha (at most 0.35).
- **Ears.** The right ear has the notch, so neither ear is mirrored.

### Palette

Only these fills are allowed:

- fur `#2F7A6D`, shade `#225A51`, highlight `#3F9282`;
- oat (muzzle, belly, inner ears) `#EBD9B4`, blaze `#F6EEDC`;
- nose `#2B1D2A`, mouth `#5A1E2E`, tongue `#E07A7A`, pads `#7B4B5A`;
- iris `#E3A43A`, pupil `#1A1216`, eye highlight `#FFFFFF`;
- neckerchief `#E2B33C`, stitch `#B9861E`;
- blush `#F2A07B`, always with `fill-opacity="0"`.

## Conventions in this file

- Path data uses only absolute `M`, `L`, `C` and `Z` commands, with at most one decimal place. Prefer the same: the generator computes bounding boxes from path coordinates, including control points, and the renderer scales the upper lids about their top edge.
- Mirrored parts: `legShadeL`, `thighL`, `soleL`, `padL`, `beansL`, `armShadeL`, `armFurL`, `pawFurL`, `pawTipsL`, `blushL` and `browLArch`.
- The file has 54 drawn parts, counting mirrored copies twice and leaving out the skipped mouth preview. The test allows 45 to 80.

## Previewing

Open `art/bear.svg` in any browser. It shows the source only: the mirrored right-hand parts are missing (the generator emits them), the upper lids are closed and the blush is transparent. The renderer draws the finished bear.

`pnpm test` runs `scripts/bear-svg.test.ts`.
