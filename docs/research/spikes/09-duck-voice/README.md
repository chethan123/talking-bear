# 09 — duck voice (throwaway)

Planning spike for `docs/research/duck-plan.md` (2026-10-24). Not application code: nothing under `src/` may import it.

**Machine:** an aarch64 Neoverse-N1 VM (4 vCPU), Node 24.21.0. This is **not** the plan §0 sandbox (2.1 GHz Xeon, Node 22) and not D1. The duck plan tags these numbers `[E N1]`.

**Input:** the committed espeak-ng TTS corpus (`test/corpus/speech`, 16 kHz, synthetic voices only, plan Q2), upsampled to 48 kHz with the production sinc kernel, and the committed synthetic fixtures (`test/fixtures/vowel_*.wav`). No real voice is used, and nothing is written to disk.

Run from the repo root with Node 24 (type stripping is on by default).

**Current: the recommended stage** (AM 70 Hz → HPF 320, dip 700, peaks 1.6 k/3.1 k → four RBJ LPF sections at 5 kHz → peak-normalised cubic):

| Script | What it measures |
|---|---|
| `bench4.mjs` | CPU and whole-chain cost (median / p95 of 30), STOI by p, loudness after the gain rule, envelope tracks, 70 Hz envelope line, added inharmonic energy |
| `alias-onset.mjs` | Alias in dBFS with a 2048-sample raised-cosine onset, 13 tones × fs × the tuning bounds (`--variants` compares 2/3/4/6 LPF sections) |
| `corners2.mjs` | STOI on T115's 10 sentences at the bound corners (worst mean and worst min) |
| `golden.mjs` | Golden STOI values for the `test/stoi.ts` port |
| `f0check.mjs` | YIN f0 on the duck output (unusable, by design) |

**Superseded** (rounds 1–3, kept for the comparison table; they use the earlier two-section LPF at 5.5 kHz):

| Script | What it measured |
|---|---|
| `bench.mjs` | Round 1: the six algorithm families and three combined chains (CPU, STOI, centroid, loudness gain) |
| `bench2.mjs` | Round 2: ADAA-1 and half-band waveshaping, a cheaper YIN tracker, whole-chain cost, added-component meter, determinism |
| `bench3.mjs` | Round 3: the two-section stage |
| `alias3.mjs`, `alias-corners.mjs` | Alias with an abrupt tone onset, which let the onset click set the cubic's peak (an artefact the review found, R2-02) |
| `corners.mjs` | STOI corners for the two-section stage |
| `amcheck.mjs` | 70 Hz envelope line, two-section stage |

`duck-lib.mjs` holds the candidate stages, the simplified STOI (Taal et al. 2011; silent frames dropped in the STFT domain, not by time-domain OLA), the alias meters and the descriptors.

Delete when `src/dsp/duck.ts` lands (duck plan T115).
