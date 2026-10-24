# `art/`: the characters' source art

`bear.svg` is the text source of truth for Juni (plan §4.6.1 and §4.6.5). `scripts/gen-bear-parts.ts` compiles it into `src/art/bear-parts.gen.ts`, and `scripts/bear-svg.test.ts` checks the rules below. Keep to them when you edit the file, or it stops compiling.

`duck.svg` is the source of truth for Fenn the duckling (plan §4.6.7, duck plan §4.4). It follows the same rules, with the differences in [Fenn: `duck.svg`](#fenn-ducksvg); `scripts/duck-svg.test.ts` checks it, and the generator compiles it into `src/art/duck-parts.gen.ts`.

The generator compiles every character listed in its `CHARACTER_ART` table (`scripts/gen-bear-parts.ts`); `pnpm gen:bear` regenerates all of them, `pnpm gen:bear --character <id>` one, and `node scripts/gen-bear-parts.ts --check` verifies them all. The `viewBox` and mirror rules are shared by every character.

## Authoring rules

### The file

- The root is exactly `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1400">`: a design box of 1000 × 1400 units, with y pointing down.
- The only allowed elements are `<svg>`, `<defs>`, `<g>` and `<path>`. Write ellipses and circles as `<path d>` arcs or Béziers.
- No `<ellipse>`, `<circle>`, `<rect>`, `<use>`, `transform`, CSS (`style`, `class`, `<style>`) or gradients.
- Every other element sits inside the root `<svg>`.
- No comments, XML declaration, `<title>` or text content, and every attribute is double-quoted. The test parses the file with regexes and rejects anything else.

### Bones

- A rig bone is a `<g id="…" data-pivot="x,y" data-parent="…">`. Its children are the paths and bones nested in it, and its `data-parent` names the bone it is nested in. `root` has no `data-parent`.
- `data-pivot` is in design units. The generator gives a bone without one its parent's pivot, but every bone in this file must have an explicit pivot, and the test checks it.
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
- optionally `data-mirror="…"`: this path is the left part, and the generator also emits a copy mirrored about x = 500 with that id. The copy draws right after its source and belongs to the matching right bone (`legL` → `legR`). Only a part inside a left bone (`…L`, with a matching `…R` bone) can be mirrored, and the copy's id swaps the part id's last `L` for `R` (`legShadeL` → `legShadeR`, `browLArch` → `browRArch`).

**Draw order** is document order, back to front. Because a mirrored copy draws right after its source, only mirror a part whose right-hand copy may draw at that point.

### Special parts

- **Eyes.** Inside `eyeL` the parts are `scleraL`, `irisL`, `pupilL`, `highlightL`, `lidUpperL` and `lidLowerL`, in that order (and the same with `R`). The sclera has `data-clip="true"`: the renderer clips the iris, pupil and highlight drawn right after it. Eye parts are never mirrored, because a mirrored copy would land between a sclera and its iris.
- **Lids.** `lidUpperL` and `lidUpperR` are drawn **closed**. The renderer scales them in y about their top edge by the `LidL`/`LidR` channel (0 = hidden, 1 = closed), so the raw file shows Juni with closed eyes. The lower lids are static.
- **Mouth.** The mouth interior, tongue and teeth are drawn in code, at the anchor (500, 525). The SVG only has the neutral preview `mouthPreview`, with `data-skip="true"`, which the generator ignores. No other path has `data-skip`.
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

## Fenn: `duck.svg`

Everything above applies to `duck.svg` (the file, bones, parts, mirroring, eyes, lids and blush rules), with these differences.

### Rig

The bones, in document order, with their pivots (duck plan §4.4):

- `root` (500,1340) → `body` (500,1250);
- `body` → `tailA` (770,1060), `tailB` (782,1050): the tail feathers, drawn first, behind the body;
- `body` → `legL` (400,1160) → `footL` (370,1275), and `legR` (600,1160) → `footR` (630,1275);
- `body` → `belly` (500,960), `wingL` (290,720), `wingR` (710,720);
- `body` → `neck` (500,640) → `head` (500,600);
- `head` → `fluffL` (230,330), `fluffR` (770,330), `tuft` (500,160), `cheekBlushL` (330,470), `cheekBlushR` (670,470);
- `head` → `bill` (500,505) → `jaw` (500,540);
- `head` → `eyeL` (400,380), `eyeR` (600,380), `browL` (400,312), `browR` (600,312).

`src/characters/fenn.ts` maps Juni's pose channels onto these bones: the ear channels move the fluff tufts, the arm channels the wings, the kerchief channels the tail feathers, `NoseY`/`NoseWrinkle` the bill and `Jaw`/`MouthW` the jaw.

### Rules that differ from Juni's

- **Beak, not mouth.** There is no parametric mouth and no `mouthPreview`: no path has `data-skip`. The beak is ordinary parts, drawn in this order: `billInterior` (on `bill`), `billThroat`, `tongue` and `lowerBill` (on `jaw`), then `upperBill`, `billShine`, `billNail` and `nostrils` (on `bill`). The jaw only translates (`Jaw` × 60 down) and widens (`MouthW`), so the dark `billInterior` (fixed to the bill) and `billThroat` (riding on the jaw, hidden under the upper bill at rest) together fill the gap as the lower bill drops. The tongue peeks above the lower bill's rim once the beak opens.
- **Lids.** `lidUpperL`/`lidUpperR` are drawn closed in the face colour `#F4D27A` and cover their sclera; the lower lids (`#3A2A1E`) are the closed-eye line.
- **Tail first.** The tail feathers are the first parts in the file, so the body hides their bases.
- **Pattern.** The brown cap comes down the sides of the head to meet the eye stripes (`eyeStripeL`, `eyeStripeR`, on `head`, not mirrored because `head` is not a left bone), the mallard-duckling pattern. The fluff tufts are a small scalloped edge on the brown side of the head.
- **Mirrored parts:** `shankL`, `footWebL`, `footToesL`, `wingShadeL`, `wingDownL`, `wingStripeL`, `wingShineL`, `fluffShadeL`, `fluffDownL`, `blushL` and `browLFeather`.
- **Part count:** 58 drawn parts, counting mirrored copies twice. The test allows 40 to 80.

### Palette

Only these fills are allowed in `duck.svg`:

- down (cap, back, wings, fluff, tail) `#7A5A3A`, shade `#5E4329`, highlight `#94714C`;
- face, chest, belly `#F4D27A`, shade `#DDB65A`;
- bill `#F09A4A`, lower bill and bill shade `#D67C30`, nail and nostrils `#8A4A20`;
- feet `#E8893A`, shade (legs, toe lines) `#C46F26`;
- wing stripe (speculum) `#2F7A6D`;
- sclera and eye highlight `#FFFFFF`, iris `#3A2A1E`, pupil `#1A1216`;
- bill interior `#5A1E2E`, tongue `#E07A7A`;
- blush `#F2A07B`, always with `fill-opacity="0"`.

The renderer draws Fenn's background `#E9F5F0` → `#C9E6DC` (`FENN.background`).

## Previewing

Open `art/bear.svg` or `art/duck.svg` in any browser. It shows the source only: the mirrored right-hand parts are missing (the generator emits them), the upper lids are closed and the blush is transparent. The renderer draws the finished character; `lab/rig.html` (`pnpm dev`) shows either character, posed, with its character picker.

`pnpm test` runs `scripts/bear-svg.test.ts` and `scripts/duck-svg.test.ts`.
