// Front-end configuration of the real-voice feature traces (plan §7 M2 "Stale traces"): every value upstream
// of the scalars a trace logs (raw dB, band dB, voicing, Silero p). `frontEndHash` (format.ts) hashes it into
// trace.json, and a trace recorded under a different hash is stale.
//
// The values are literals on purpose: format.test.ts pins each one to the constant the pipeline really uses
// (the drift guard), so changing a module without updating this file fails `pnpm test`, and updating it
// changes the hash. `constraints` is the production object itself (the issue's `constraints: CONSTRAINTS`).
//
// DOM-free at runtime (mic.ts references no DOM value at module scope), so Node scripts, the DSP worker and
// the page can all import it. Relative imports end in `.ts` and the syntax is erasable (CLAUDE.md rule 11).
// src/audio/mic.ts must keep that too (no imports, or only `.ts` relative ones): Node scripts (the T42/T50
// eval harness and trace replay, scripts/vad-eval.ts) reach it through this file.

import { CONSTRAINTS } from '../audio/mic.ts';

export interface FrontEndConfig {
  /** The capture worklet's 16 kHz decimator (`createResampler(sampleRate, VAD_RATE)` with default options). */
  readonly decimator: {
    readonly zeroCrossings: number;
    readonly beta: number;
    /** Anti-alias cutoff as a fraction of the input Nyquist, at the 48 kHz reference rate. */
    readonly cutoff: number;
  };
  /** `createGateFilter`: Butterworth high-pass stages (Hz, in order), then one Butterworth low-pass. */
  readonly gateFilter: { readonly hpfHz: readonly number[]; readonly lpfHz: number };
  /** getUserMedia audio constraints. */
  readonly constraints: MediaTrackConstraints;
  /** Energy hop length (ms). */
  readonly hopMs: number;
  /**
   * Voicing score: F0 search range (Hz) and window length (16 kHz samples). `window` has no code constant yet:
   * #46 (T35) exports VOICING_WINDOW from src/audio/constants.ts and pins it in format.test.ts.
   */
  readonly voicing: { readonly fminHz: number; readonly fmaxHz: number; readonly window: number };
  /**
   * Raw frames the optional Silero pre-gate replays to warm the LSTM up. No code constant yet: #46 (T35)
   * exports PREGATE_WARMUP_FRAMES from src/audio/constants.ts and pins it in format.test.ts.
   */
  readonly pregateWarmupFrames: number;
  /** The capture worklet's high-pass ahead of the decimator (Hz). */
  readonly hpfClipHz: number;
}

export const FRONT_END_CONFIG: FrontEndConfig = {
  decimator: { zeroCrossings: 8, beta: 6, cutoff: 0.9 / 3 },
  gateFilter: { hpfHz: [200, 200], lpfHz: 3400 },
  constraints: CONSTRAINTS,
  hopMs: 10,
  voicing: { fminHz: 70, fmaxHz: 600, window: 512 },
  pregateWarmupFrames: 10,
  hpfClipHz: 80,
};
