// Shared DSP types (plan §3.3, §4.3.4). DOM-free: this file is compiled into the worklet and worker
// projects, which have no DOM lib, and Node scripts import it with type stripping.

/** A voice preset: `pitchRatio` p is the pitch (and tempo) factor; the voice chain resamples with ratio 1/p. */
export interface VoicePreset {
  id: 'cub' | 'chipmunk' | 'bigbear' | 'custom';
  pitchRatio: number;
}

/** The built-in presets (plan §4.3.4). `custom` comes from the settings slider (0.7–2.2). */
export const PRESETS: Record<'cub' | 'chipmunk' | 'bigbear', VoicePreset> = {
  cub: { id: 'cub', pitchRatio: 1.6 },
  chipmunk: { id: 'chipmunk', pitchRatio: 2.0 },
  bigbear: { id: 'bigbear', pitchRatio: 0.75 },
};

/** Mouth-shape tracks sampled every `hopMs` over the exact buffer that plays (plan §4.3.4, §4.6.2). */
export interface Envelope {
  hopMs: 10;
  jaw: Float32Array;
  width: Float32Array;
  round: Float32Array;
  teeth: Float32Array;
}

/**
 * An envelope with all four tracks of length 0. Every call allocates fresh arrays: an envelope is
 * transferred with its message, which detaches its buffers, so a shared instance would break the next send.
 */
export function emptyEnvelope(): Envelope {
  return {
    hopMs: 10,
    jaw: new Float32Array(0),
    width: new Float32Array(0),
    round: new Float32Array(0),
    teeth: new Float32Array(0),
  };
}

/**
 * The voice chain's result (plan §4.3.4): the processed clip `pcm`, which plays at rate 1, its mouth envelope
 * (computed from exactly that buffer), its duration `pcm.length / fs` in seconds, and `clipped`, whether the
 * input take was clipped (at least 0.1 % of samples with |x| > 0.99, plan §4.4), for M8's "too loud" reaction.
 */
export interface VoiceResult {
  pcm: Float32Array;
  envelope: Envelope;
  durationSec: number;
  clipped: boolean;
}
