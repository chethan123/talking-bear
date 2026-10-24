import { mulberry32 } from '../anim/rng.ts';
import type { SfxId } from './sfx-ids.ts';
import type { SfxSynth } from './sfx.ts';

/*
 * Every reaction sound of plan §4.6.4 as a Web Audio recipe: oscillators, filtered noise and gain envelopes,
 * with no audio files. Every recipe keeps the rules of plan §4.6.4 and #88:
 *
 * - Its sample peak is ≤ −9 dBFS (6 dB below the voice's −3 dBTP ceiling). Each recipe notes its peak
 *   rendered alone at 48 kHz (as the browser test does), so a tweak can see its headroom; `lab/sfx.html`
 *   shows it live.
 * - Every gain envelope starts at 0, and no part of it rises faster than 0 → its peak in 5 ms (`envelope()`
 *   throws otherwise, and the browser test runs every recipe).
 * - It returns its exact duration: every source starts at `when` and stops at `when + duration`, where every
 *   envelope has reached exactly 0 (`run()` throws otherwise). Filters sit before the envelope, so nothing
 *   rings past it.
 * - Its last node connects to `out` (the master bus in the app).
 * - Content (Q3): nothing suggests pain, fear or crying. Voices are short, light and end crisply: no tremolo,
 *   no long falling wail, no sob-like pulses.
 *
 * Each recipe's numbers are in one named constant, so it can be tuned by ear in `lab/sfx.html`.
 */

/** The shortest attack a gain envelope may have (plan §4.6.4). */
export const MIN_ATTACK_SEC = 0.005;

/** A gain-envelope point: [seconds after the envelope's start, gain]. */
export type EnvPoint = readonly [t: number, gain: number];

/** A frequency contour point: [seconds after the sfx's start, Hz]. */
export type ContourPoint = readonly [t: number, hz: number];

/**
 * Schedules a gain envelope on `param`: gain 0 at `t0`, then linear ramps through `points` (times relative to
 * `t0`). Returns the context time at which it is back at 0 (`t0` + the last point's time). Throws a
 * `RangeError`, before scheduling anything, unless the times strictly increase, every gain is ≥ 0, the last
 * gain is 0, and no rising segment is steeper than a `MIN_ATTACK_SEC` ramp from 0 to the envelope's peak.
 */
export function envelope(param: AudioParam, t0: number, points: readonly EnvPoint[]): number {
  let peak = 0;
  for (const [, g] of points) peak = Math.max(peak, g);
  const maxRisePerSec = peak / MIN_ATTACK_SEC;
  let prevT = 0;
  let prevG = 0;
  for (const [t, g] of points) {
    if (!(t > prevT)) throw new RangeError(`envelope: time ${t} s does not follow ${prevT} s`);
    if (!(g >= 0)) throw new RangeError(`envelope: gain ${g} at ${t} s is not ≥ 0`);
    if (g > prevG && (g - prevG) / (t - prevT) > maxRisePerSec * (1 + 1e-9)) {
      throw new RangeError(
        `envelope: the rise to ${t} s is faster than a ${MIN_ATTACK_SEC * 1000} ms attack`,
      );
    }
    prevT = t;
    prevG = g;
  }
  if (points.length === 0 || prevG !== 0) throw new RangeError('envelope: it must end at gain 0');
  param.setValueAtTime(0, t0);
  for (const [t, g] of points) param.linearRampToValueAtTime(g, t0 + t);
  return t0 + prevT;
}

/** Sets `param` to the first point's value at its time, then ramps exponentially through the rest. */
function contour(param: AudioParam, t0: number, points: readonly ContourPoint[]): void {
  const [first, ...rest] = points;
  if (first === undefined) return;
  param.setValueAtTime(first[1], t0 + first[0]);
  for (const [t, hz] of rest) param.exponentialRampToValueAtTime(hz, t0 + t);
}

/**
 * Starts every source at `t0` and stops it at `t0 + dur`, the sfx's exact end. Once they have ended,
 * disconnects `outs` (the nodes connected to the sfx's `out`). Returns `dur`. `ends` are the context times
 * at which the sfx's gain envelopes are back at 0 (what `envelope()` returns); a `RangeError` is thrown,
 * before any source starts, if one is later than `t0 + dur`, since stopping the sources there would cut the
 * sound off mid-envelope.
 */
export function run(
  sources: readonly AudioScheduledSourceNode[],
  outs: readonly AudioNode[],
  ends: readonly number[],
  t0: number,
  dur: number,
): number {
  for (const end of ends) {
    if (!(end <= t0 + dur + 1e-9)) {
      throw new RangeError(`run: an envelope ends ${end - t0} s after the start, past the duration ${dur} s`);
    }
  }
  for (const s of sources) {
    s.start(t0);
    s.stop(t0 + dur);
  }
  sources[0]?.addEventListener(
    'ended',
    () => {
      for (const o of outs) o.disconnect();
    },
    { once: true },
  );
  return dur;
}

/** A sine LFO at `hz`, scaled by a depth gain (in `param`'s units), added to `param`. */
function lfo(
  ctx: BaseAudioContext,
  hz: number,
  depth: number,
  param: AudioParam,
): { osc: OscillatorNode; depth: GainNode } {
  const osc = new OscillatorNode(ctx, { type: 'sine', frequency: hz });
  const gain = new GainNode(ctx, { gain: depth });
  osc.connect(gain).connect(param);
  return { osc, depth: gain };
}

const NOISE_SEC = 2;
const NOISE_SEED = 0x5eed_0b3a;
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();
/**
 * The sample rate of `noise(ctx, true)`'s buffer, whatever the context's. A few-millisecond burst of filtered noise
 * has only a handful of independent peaks, so a buffer at the context's rate (a different waveform at 44.1 kHz) can
 * peak 2.5 dB higher there; one fixed waveform, resampled by the source, peaks the same at every rate.
 */
const FIXED_NOISE_RATE = 48000;
const fixedNoiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

/**
 * A looping white-noise source, uniform on [−1, 1). The buffer is made once per context from a fixed seed, so
 * a recipe sounds (and measures) the same every time. With `fixedRate` the buffer is at `FIXED_NOISE_RATE`
 * (Fenn's bursts, whose level must not depend on the context's rate); otherwise at the context's rate.
 */
function noise(ctx: BaseAudioContext, fixedRate = false): AudioBufferSourceNode {
  const cache = fixedRate ? fixedNoiseBuffers : noiseBuffers;
  let buffer = cache.get(ctx);
  if (buffer === undefined) {
    const sampleRate = fixedRate ? FIXED_NOISE_RATE : ctx.sampleRate;
    buffer = new AudioBuffer({ numberOfChannels: 1, length: Math.round(NOISE_SEC * sampleRate), sampleRate });
    const data = buffer.getChannelData(0);
    const rng = mulberry32(NOISE_SEED);
    for (let i = 0; i < data.length; i++) data[i] = 2 * rng() - 1;
    cache.set(ctx, buffer);
  }
  return new AudioBufferSourceNode(ctx, { buffer, loop: true });
}

/**
 * A voice-like blip (#88): a sawtooth with a pitch contour through two parallel band-pass formants (F1, F2)
 * into one gain envelope. It reads as a cartoon syllable, not speech.
 */
interface VoiceBlip {
  dur: number;
  pitch: readonly ContourPoint[];
  f1: readonly ContourPoint[];
  q1: number;
  f2: readonly ContourPoint[];
  q2: number;
  /** F2's level relative to F1's. */
  f2Mix: number;
  env: readonly EnvPoint[];
}

/**
 * Builds a voice blip at `t0` into `dest`; returns its source, its envelope (the node into `dest`) and when
 * that envelope is back at 0.
 */
function voice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  b: VoiceBlip,
): { saw: OscillatorNode; env: GainNode; end: number } {
  const saw = new OscillatorNode(ctx, { type: 'sawtooth' });
  contour(saw.frequency, t0, b.pitch);
  const f1 = new BiquadFilterNode(ctx, { type: 'bandpass', Q: b.q1 });
  contour(f1.frequency, t0, b.f1);
  const f2 = new BiquadFilterNode(ctx, { type: 'bandpass', Q: b.q2 });
  contour(f2.frequency, t0, b.f2);
  const f2Mix = new GainNode(ctx, { gain: b.f2Mix });
  const env = new GainNode(ctx, { gain: 0 });
  saw.connect(f1).connect(env);
  saw.connect(f2).connect(f2Mix).connect(env);
  const end = envelope(env.gain, t0, b.env);
  env.connect(dest);
  return { saw, env, end };
}

/** A synth that plays one voice blip. */
function blip(b: VoiceBlip): SfxSynth {
  return (ctx, out, when) => {
    const { saw, env, end } = voice(ctx, out, when, b);
    return run([saw], [env], [end], when, b.dur);
  };
}

/**
 * Short chirps on one triangle oscillator: each note starts at its pitch and glides by `glide` over `len`,
 * with a vibrato on `detune`, under its own copy of `env` (relative to the note's onset; it must end by
 * `len`).
 */
export interface Chirps {
  /** [onset (s after the sfx's start), start pitch (Hz)] per chirp, in order, none before the last ends. */
  notes: readonly (readonly [t: number, hz: number])[];
  len: number;
  /** Pitch at the chirp's end relative to its start. */
  glide: number;
  vibratoHz: number;
  vibratoCents: number;
  env: readonly EnvPoint[];
}

/** When `c`'s last chirp ends (s after the sfx's start): the sfx's duration when the chirps come last. */
function chirpsEnd(c: Chirps): number {
  let end = 0;
  for (const [t] of c.notes) end = Math.max(end, t + c.len);
  return end;
}

/**
 * Builds `c`'s chirps at `t0` into `dest`; returns their sources, their envelope and when the last chirp's
 * envelope is back at 0. Throws a `RangeError`, before building anything, if `c.env` ends after `c.len` or a
 * chirp starts before the previous one has ended (they share one oscillator and one envelope, so an overlap
 * would cut the earlier chirp off).
 */
export function chirps(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  c: Chirps,
): { sources: AudioScheduledSourceNode[]; env: GainNode; end: number } {
  const envLen = c.env.at(-1)?.[0] ?? 0;
  if (!(envLen <= c.len)) {
    throw new RangeError(`chirps: the envelope ends at ${envLen} s, after the chirp length ${c.len} s`);
  }
  let prevEnd = -Infinity;
  for (const [t] of c.notes) {
    if (!(t + 1e-9 >= prevEnd)) {
      throw new RangeError(`chirps: the chirp at ${t} s starts before the previous one ends at ${prevEnd} s`);
    }
    prevEnd = t + c.len;
  }
  const osc = new OscillatorNode(ctx, { type: 'triangle' });
  const vib = lfo(ctx, c.vibratoHz, c.vibratoCents, osc.detune);
  const env = new GainNode(ctx, { gain: 0 });
  let end = t0;
  for (const [t, hz] of c.notes) {
    osc.frequency.setValueAtTime(hz, t0 + t);
    osc.frequency.exponentialRampToValueAtTime(hz * c.glide, t0 + t + c.len);
    end = Math.max(end, envelope(env.gain, t0 + t, c.env));
  }
  osc.connect(env).connect(dest);
  return { sources: [osc, vib.osc], env, end };
}

// -----------------------------------------------------------------------------------------------------------
// testBeep (M1, moved here from sfx.ts unchanged)

const BEEP_HZ = 880;
const BEEP_SEC = 0.15;
const BEEP_ATTACK_SEC = 0.005;
const BEEP_RELEASE_SEC = 0.05;
const BEEP_PEAK = 0.25; // −12 dBFS

/** 880 Hz sine, 150 ms: 5 ms linear attack to 0.25 (−12 dBFS), hold, 50 ms linear release to 0. */
const testBeep: SfxSynth = (ctx, out, when) => {
  const osc = new OscillatorNode(ctx, { type: 'sine', frequency: BEEP_HZ });
  const env = new GainNode(ctx, { gain: 0 });
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(BEEP_PEAK, when + BEEP_ATTACK_SEC);
  env.gain.setValueAtTime(BEEP_PEAK, when + BEEP_SEC - BEEP_RELEASE_SEC);
  env.gain.linearRampToValueAtTime(0, when + BEEP_SEC);
  osc.connect(env).connect(out);
  osc.addEventListener('ended', () => env.disconnect(), { once: true });
  osc.start(when);
  osc.stop(when + BEEP_SEC);
  return BEEP_SEC;
};

// -----------------------------------------------------------------------------------------------------------
// Nose: sneeze, and ×3 → bigSneeze

/** A sneeze: a filtered-noise "ah-" swell, then a band-passed noise "choo" (#88). */
interface Sneeze {
  dur: number;
  /** The "ah-": a band-pass sweeping up (an in-breath), its Q, and its envelope from the start. */
  ahHz: readonly ContourPoint[];
  ahQ: number;
  ahEnv: readonly EnvPoint[];
  /**
   * The "choo": when it starts, its band-pass (1.5–4 kHz: centre √(1500·4000) ≈ 2449 Hz, Q = 2449/2500 ≈
   * 0.98), and its envelope from that start.
   */
  chooAt: number;
  chooHz: number;
  chooQ: number;
  chooEnv: readonly EnvPoint[];
}

function sneezeSynth(s: Sneeze): SfxSynth {
  return (ctx, out, when) => {
    const src = noise(ctx);
    const ahBand = new BiquadFilterNode(ctx, { type: 'bandpass', Q: s.ahQ });
    contour(ahBand.frequency, when, s.ahHz);
    const ah = new GainNode(ctx, { gain: 0 });
    const ahEnd = envelope(ah.gain, when, s.ahEnv);
    const chooBand = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: s.chooHz, Q: s.chooQ });
    const choo = new GainNode(ctx, { gain: 0 });
    const chooEnd = envelope(choo.gain, when + s.chooAt, s.chooEnv);
    src.connect(ahBand).connect(ah).connect(out);
    src.connect(chooBand).connect(choo).connect(out);
    return run([src], [ah, choo], [ahEnd, chooEnd], when, s.dur);
  };
}

/**
 * A gentle, cute sneeze: a short breathy swell, then a soft "choo" with a quick fade; no harsh snap. Peak
 * −13.0 dBFS.
 */
const SNEEZE: Sneeze = {
  dur: 0.5,
  ahHz: [
    [0, 700],
    [0.3, 1400],
  ],
  ahQ: 1.5,
  ahEnv: [
    [0.22, 0.25],
    [0.28, 0.45],
    [0.3, 0],
  ],
  chooAt: 0.3,
  chooHz: 2449,
  chooQ: 0.98,
  chooEnv: [
    [0.008, 0.35],
    [0.05, 0.19],
    [0.2, 0],
  ],
};

/** Longer and louder: a two-step "ah… ah-" build-up, then a stronger, longer "choo". Peak −11.1 dBFS. */
const BIG_SNEEZE: Sneeze = {
  dur: 0.85,
  ahHz: [
    [0, 600],
    [0.5, 1600],
  ],
  ahQ: 1.5,
  ahEnv: [
    [0.18, 0.3],
    [0.24, 0.06],
    [0.46, 0.55],
    [0.5, 0],
  ],
  chooAt: 0.5,
  chooHz: 2449,
  chooQ: 0.98,
  chooEnv: [
    [0.01, 0.41],
    [0.09, 0.22],
    [0.35, 0],
  ],
};

// -----------------------------------------------------------------------------------------------------------
// Head: boing (tuft tap), purr (pet), whoa (flick)

/**
 * A cartoon spring: a sine gliding 180 → 520 Hz over 250 ms, with a vibrato that swells, then decays. Peak
 * −12.0 dBFS.
 */
const BOING = {
  dur: 0.55,
  pitch: [
    [0, 180],
    [0.25, 520],
  ],
  vibratoHz: 12,
  /** Vibrato depth: 0 at the start, `vibratoCents` at `vibratoPeakAt`, back to 0 at the end. */
  vibratoCents: 150,
  vibratoPeakAt: 0.25,
  env: [
    [0.008, 0.25],
    [0.25, 0.25],
    [0.55, 0],
  ],
} as const;

const boing: SfxSynth = (ctx, out, when) => {
  const osc = new OscillatorNode(ctx, { type: 'sine' });
  contour(osc.frequency, when, BOING.pitch);
  const vib = lfo(ctx, BOING.vibratoHz, 0, osc.detune);
  vib.depth.gain.setValueAtTime(0, when);
  vib.depth.gain.linearRampToValueAtTime(BOING.vibratoCents, when + BOING.vibratoPeakAt);
  vib.depth.gain.linearRampToValueAtTime(0, when + BOING.dur);
  const env = new GainNode(ctx, { gain: 0 });
  const end = envelope(env.gain, when, BOING.env);
  osc.connect(env).connect(out);
  return run([osc, vib.osc], [env], [end], when, BOING.dur);
};

/**
 * A purr-hum segment: a 110 Hz sawtooth, amplitude-modulated at 25 Hz, low-passed at 600 Hz. 1.2 s is exactly
 * 132 sawtooth and 30 AM periods, so back-to-back segments stay in phase; short fades let them join softly.
 * Peak −16.0 dBFS.
 */
const PURR = {
  dur: 1.2,
  hz: 110,
  amHz: 25,
  /** AM depth: the gain swings between 1 − amDepth and 1. */
  amDepth: 0.8,
  lowpassHz: 600,
  env: [
    [0.04, 0.15],
    [1.16, 0.15],
    [1.2, 0],
  ],
} as const;

const purr: SfxSynth = (ctx, out, when) => {
  const saw = new OscillatorNode(ctx, { type: 'sawtooth', frequency: PURR.hz });
  const am = new GainNode(ctx, { gain: 1 - PURR.amDepth / 2 });
  const mod = lfo(ctx, PURR.amHz, PURR.amDepth / 2, am.gain);
  const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: PURR.lowpassHz, Q: Math.SQRT1_2 });
  const env = new GainNode(ctx, { gain: 0 });
  const end = envelope(env.gain, when, PURR.env);
  saw.connect(am).connect(lowpass).connect(env).connect(out);
  return run([saw, mod.osc], [env], [end], when, PURR.dur);
};

/**
 * "whoa!": a surprised falling glide (not a scream: mid pitch, smooth, no vibrato), "w" opening to "a". Peak
 * −12.1 dBFS.
 */
const WHOA: VoiceBlip = {
  dur: 0.4,
  pitch: [
    [0, 420],
    [0.34, 230],
  ],
  f1: [
    [0, 450],
    [0.2, 700],
  ],
  q1: 5,
  f2: [
    [0, 800],
    [0.2, 1200],
  ],
  q2: 6,
  f2Mix: 0.6,
  env: [
    [0.02, 0.46],
    [0.28, 0.46],
    [0.4, 0],
  ],
};

// -----------------------------------------------------------------------------------------------------------
// Ears: hm; eyes: hmph

/**
 * "hm?": a closed-mouth hum rising 180 → 260 Hz like a question, through a nasal formant. Peak −13.0 dBFS.
 */
const HM: VoiceBlip = {
  dur: 0.25,
  pitch: [
    [0, 180],
    [0.08, 180],
    [0.22, 260],
  ],
  f1: [[0, 280]],
  q1: 3,
  f2: [[0, 1200]],
  q2: 8,
  f2Mix: 0.2,
  env: [
    [0.012, 0.53],
    [0.19, 0.53],
    [0.25, 0],
  ],
};

/**
 * "hmph!": grumpy-cute. A quick 220 → 150 Hz fall through a nasal formant (~250 Hz), a crisp stop and a tiny
 * "ph" puff (`HMPH_PUFF`). It stays indignant, not hurt: short, no tremble, no whimper-like rise. Peak −13.0
 * dBFS.
 */
const HMPH_VOICE: VoiceBlip = {
  dur: 0.3,
  pitch: [
    [0, 220],
    [0.18, 150],
  ],
  f1: [[0, 250]],
  q1: 3,
  f2: [[0, 1200]],
  q2: 8,
  f2Mix: 0.15,
  env: [
    [0.01, 0.46],
    [0.17, 0.46],
    [0.24, 0],
  ],
};

/** The "ph" puff of "hmph!": band-passed noise near the end. */
const HMPH_PUFF = {
  at: 0.2,
  hz: 900,
  q: 0.8,
  env: [
    [0.02, 0.12],
    [0.1, 0],
  ],
} as const;

const hmph: SfxSynth = (ctx, out, when) => {
  const voiced = voice(ctx, out, when, HMPH_VOICE);
  const src = noise(ctx);
  const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: HMPH_PUFF.hz, Q: HMPH_PUFF.q });
  const puff = new GainNode(ctx, { gain: 0 });
  const puffEnd = envelope(puff.gain, when + HMPH_PUFF.at, HMPH_PUFF.env);
  src.connect(band).connect(puff).connect(out);
  return run([voiced.saw, src], [voiced.env, puff], [voiced.end, puffEnd], when, HMPH_VOICE.dur);
};

// -----------------------------------------------------------------------------------------------------------
// Cheeks: pop

/** A short sine blip at 900 Hz with a fast pitch drop: a soft "bloop", not a crack. Peak −13.0 dBFS. */
const POP = {
  dur: 0.06,
  pitch: [
    [0, 900],
    [0.04, 380],
  ],
  env: [
    [0.006, 0.225],
    [0.02, 0.165],
    [0.06, 0],
  ],
} as const;

const pop: SfxSynth = (ctx, out, when) => {
  const osc = new OscillatorNode(ctx, { type: 'sine' });
  contour(osc.frequency, when, POP.pitch);
  const env = new GainNode(ctx, { gain: 0 });
  const end = envelope(env.gain, when, POP.env);
  osc.connect(env).connect(out);
  return run([osc], [env], [end], when, POP.dur);
};

// -----------------------------------------------------------------------------------------------------------
// Belly: boingHehe, giggle, sigh, squeal

/**
 * Delighted chirps: six triangle blips at 700–1100 Hz, 90 ms apart, gliding down a little, with vibrato. Peak
 * −13.3 dBFS.
 */
const GIGGLE: Chirps = {
  notes: [
    [0, 1000],
    [0.09, 1100],
    [0.18, 1040],
    [0.27, 960],
    [0.36, 900],
    [0.45, 820],
  ],
  len: 0.06,
  glide: 0.88,
  vibratoHz: 30,
  vibratoCents: 50,
  env: [
    [0.008, 0.22],
    [0.035, 0.22],
    [0.06, 0],
  ],
};

const giggle: SfxSynth = (ctx, out, when) => {
  const { sources, env, end } = chirps(ctx, out, when, GIGGLE);
  return run(sources, [env], [end], when, chirpsEnd(GIGGLE));
};

/**
 * "boing-hehe": a sine bouncing 300 → 520 Hz with a decaying wobble, then a short "he-he" chirp (`HEHE`).
 * Peak −12.1 dBFS.
 */
const BOING_HEHE = {
  pitch: [
    [0, 300],
    [0.12, 520],
  ],
  vibratoHz: 14,
  vibratoCents: 120,
  vibratoPeakAt: 0.12,
  vibratoEndAt: 0.3,
  env: [
    [0.008, 0.25],
    [0.18, 0.21],
    [0.3, 0],
  ],
} as const;

/** The "he-he" of "boing-hehe": two giggle chirps after the boing. */
const HEHE: Chirps = {
  notes: [
    [0.33, 1050],
    [0.43, 950],
  ],
  len: 0.07,
  glide: 0.9,
  vibratoHz: 30,
  vibratoCents: 50,
  env: [
    [0.008, 0.22],
    [0.04, 0.22],
    [0.07, 0],
  ],
};

const boingHehe: SfxSynth = (ctx, out, when) => {
  const b = BOING_HEHE;
  const osc = new OscillatorNode(ctx, { type: 'sine' });
  contour(osc.frequency, when, b.pitch);
  const vib = lfo(ctx, b.vibratoHz, 0, osc.detune);
  vib.depth.gain.setValueAtTime(0, when);
  vib.depth.gain.linearRampToValueAtTime(b.vibratoCents, when + b.vibratoPeakAt);
  vib.depth.gain.linearRampToValueAtTime(0, when + b.vibratoEndAt);
  const env = new GainNode(ctx, { gain: 0 });
  const end = envelope(env.gain, when, b.env);
  osc.connect(env).connect(out);
  const hehe = chirps(ctx, out, when, HEHE);
  return run([osc, vib.osc, ...hehe.sources], [env, hehe.env], [end, hehe.end], when, chirpsEnd(HEHE));
};

/**
 * A content sigh: a soft, breathy "haah" whose band falls 1600 → 500 Hz; it rises quickly and relaxes. Peak
 * −14.9 dBFS.
 */
const SIGH = {
  dur: 0.6,
  bandHz: [
    [0, 1600],
    [0.6, 500],
  ],
  q: 1.2,
  env: [
    [0.08, 0.35],
    [0.22, 0.315],
    [0.6, 0],
  ],
} as const;

const sigh: SfxSynth = (ctx, out, when) => {
  const src = noise(ctx);
  const band = new BiquadFilterNode(ctx, { type: 'bandpass', Q: SIGH.q });
  contour(band.frequency, when, SIGH.bandHz);
  const env = new GainNode(ctx, { gain: 0 });
  const end = envelope(env.gain, when, SIGH.env);
  src.connect(band).connect(env).connect(out);
  return run([src], [env], [end], when, SIGH.dur);
};

/**
 * A delighted "eee!": a sine + triangle mix rising 600 → 1200 Hz, with a light, fast vibrato. Peak −11.9
 * dBFS.
 */
const SQUEAL = {
  dur: 0.35,
  pitch: [
    [0, 600],
    [0.25, 1200],
  ],
  triangleMix: 0.35,
  vibratoHz: 9,
  vibratoCents: 30,
  env: [
    [0.015, 0.19],
    [0.28, 0.19],
    [0.35, 0],
  ],
} as const;

const squeal: SfxSynth = (ctx, out, when) => {
  const sine = new OscillatorNode(ctx, { type: 'sine' });
  const tri = new OscillatorNode(ctx, { type: 'triangle' });
  contour(sine.frequency, when, SQUEAL.pitch);
  contour(tri.frequency, when, SQUEAL.pitch);
  const vib = lfo(ctx, SQUEAL.vibratoHz, SQUEAL.vibratoCents, sine.detune);
  vib.depth.connect(tri.detune);
  const triMix = new GainNode(ctx, { gain: SQUEAL.triangleMix });
  const env = new GainNode(ctx, { gain: 0 });
  const end = envelope(env.gain, when, SQUEAL.env);
  sine.connect(env);
  tri.connect(triMix).connect(env);
  env.connect(out);
  return run([sine, tri, vib.osc], [env], [end], when, SQUEAL.dur);
};

// -----------------------------------------------------------------------------------------------------------
// Paw: hi; feet: hey

/** "hi!": a rising blip whose formants glide from "a" to "i". Peak −12.0 dBFS. */
const HI: VoiceBlip = {
  dur: 0.2,
  pitch: [
    [0, 240],
    [0.16, 340],
  ],
  f1: [
    [0, 700],
    [0.2, 450],
  ],
  q1: 5,
  f2: [
    [0, 1200],
    [0.2, 1900],
  ],
  q2: 6,
  f2Mix: 0.6,
  env: [
    [0.01, 0.57],
    [0.14, 0.57],
    [0.2, 0],
  ],
};

/** "hey!": two notes, the second a step higher ("he-ey!"), with a small dip between them. Peak −12.0 dBFS. */
const HEY: VoiceBlip = {
  dur: 0.26,
  pitch: [
    [0, 300],
    [0.1, 300],
    [0.125, 400],
  ],
  f1: [
    [0, 700],
    [0.26, 550],
  ],
  q1: 5,
  f2: [
    [0, 1200],
    [0.26, 1700],
  ],
  q2: 6,
  f2Mix: 0.6,
  env: [
    [0.01, 0.6],
    [0.09, 0.6],
    [0.11, 0.3],
    [0.13, 0.6],
    [0.2, 0.6],
    [0.26, 0],
  ],
};

// -----------------------------------------------------------------------------------------------------------
// Neckerchief: rustle

/** The paw adjusting the neckerchief: three soft swishes of band-passed noise. Peak −17.8 dBFS. */
const RUSTLE = {
  dur: 0.4,
  bandHz: 3200,
  q: 0.9,
  env: [
    [0.03, 0.1],
    [0.08, 0.035],
    [0.14, 0.17],
    [0.2, 0.04],
    [0.27, 0.12],
    [0.4, 0],
  ],
} as const;

const rustle: SfxSynth = (ctx, out, when) => {
  const src = noise(ctx);
  const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: RUSTLE.bandHz, Q: RUSTLE.q });
  const env = new GainNode(ctx, { gain: 0 });
  const end = envelope(env.gain, when, RUSTLE.env);
  src.connect(band).connect(env).connect(out);
  return run([src], [env], [end], when, RUSTLE.dur);
};

// -----------------------------------------------------------------------------------------------------------
// Fenn the duckling (duck plan §4.6): quack, bigQuack, nibble, trill, peep, flap, pat
//
// Each recipe's envelope is relative (1 is its peak) and has one gain constant (`*_GAIN`) that sets its level: the
// sample peak, rendered alone at 48 kHz, is −10 ± 1 dBFS (the duck plan's level rule). Every noise burst or click
// rises linearly over 5 ms and falls linearly to 0 over the rest of its length.

/** `points` with every gain × `gain` (module setup only). */
function scaled(points: readonly EnvPoint[], gain: number): EnvPoint[] {
  return points.map(([t, g]): EnvPoint => [t, g * gain]);
}

/** One quack: its onset (s after the sfx's start), its pitch glide, and its envelope from that onset. */
interface QuackNote {
  at: number;
  fromHz: number;
  toHz: number;
  env: readonly EnvPoint[];
}

/** Quacks on one sawtooth through a nasal band-pass, amplitude-modulated, under one envelope. */
interface Quacks {
  dur: number;
  notes: readonly QuackNote[];
}

/** The quack's tone: the band-pass that makes it nasal, and its AM (the gain swings between 1 − amDepth and 1). */
const QUACK_TONE = { bandHz: 1600, q: 3, amHz: 70, amDepth: 0.35 } as const;
/** One quack's relative envelope: 0 → 1 at 6 ms → 0.8 at 160 ms → 0 at 220 ms. */
const QUACK_ENV: readonly EnvPoint[] = [
  [0.006, 1],
  [0.16, 0.8],
  [0.22, 0],
];

/** The level of `quack` (measured peak −10.0 dBFS). */
const QUACK_GAIN = 0.825;
/** The level of `bigQuack` (measured peak −10.0 dBFS). */
const BIG_QUACK_GAIN = 0.752;

/** "quack!": a short, bright sawtooth glide 620 → 440 Hz through a nasal band-pass with a 70 Hz flutter. */
const QUACK: Quacks = {
  dur: 0.22,
  notes: [{ at: 0, fromHz: 620, toHz: 440, env: scaled(QUACK_ENV, QUACK_GAIN) }],
};

/** "quack-quack-quaaack!": three quacks, the last lower and a little longer. */
const BIG_QUACK: Quacks = {
  dur: 0.85,
  notes: [
    { at: 0, fromHz: 620, toHz: 440, env: scaled(QUACK_ENV, BIG_QUACK_GAIN) },
    { at: 0.28, fromHz: 620, toHz: 440, env: scaled(QUACK_ENV, BIG_QUACK_GAIN) },
    {
      at: 0.56,
      fromHz: 560,
      toHz: 380,
      env: scaled(
        [
          [0.006, 1],
          [0.23, 0.8],
          [0.29, 0],
        ],
        BIG_QUACK_GAIN,
      ),
    },
  ],
};

function quackSynth(q: Quacks): SfxSynth {
  return (ctx, out, when) => {
    const saw = new OscillatorNode(ctx, { type: 'sawtooth' });
    const band = new BiquadFilterNode(ctx, {
      type: 'bandpass',
      frequency: QUACK_TONE.bandHz,
      Q: QUACK_TONE.q,
    });
    const am = new GainNode(ctx, { gain: 1 - QUACK_TONE.amDepth / 2 });
    const mod = lfo(ctx, QUACK_TONE.amHz, QUACK_TONE.amDepth / 2, am.gain);
    const env = new GainNode(ctx, { gain: 0 });
    const ends: number[] = [];
    for (const n of q.notes) {
      const len = n.env.at(-1)?.[0] ?? 0;
      saw.frequency.setValueAtTime(n.fromHz, when + n.at);
      saw.frequency.exponentialRampToValueAtTime(n.toHz, when + n.at + len);
      ends.push(envelope(env.gain, when + n.at, n.env));
    }
    saw.connect(band).connect(am).connect(env).connect(out);
    return run([saw, mod.osc], [env], ends, when, q.dur);
  };
}

/** Filtered-noise bursts under one envelope: each `len` s long from its onset, 5 ms up, then linearly down to 0. */
interface Bursts {
  dur: number;
  at: readonly number[];
  len: number;
  filter: BiquadFilterType;
  hz: number;
  q: number;
  /** The level: a burst's envelope peak. */
  gain: number;
}

function burstSynth(b: Bursts): SfxSynth {
  const burst: readonly EnvPoint[] = [
    [MIN_ATTACK_SEC, b.gain],
    [b.len, 0],
  ];
  return (ctx, out, when) => {
    const src = noise(ctx, true);
    const filter = new BiquadFilterNode(ctx, { type: b.filter, frequency: b.hz, Q: b.q });
    const env = new GainNode(ctx, { gain: 0 });
    const ends = b.at.map((t) => envelope(env.gain, when + t, burst));
    src.connect(filter).connect(env).connect(out);
    return run([src], [env], ends, when, b.dur);
  };
}

/** The level of `nibble` (measured peak −10.0 dBFS). */
const NIBBLE_GAIN = 0.952;

/** A beak nibbling the finger: four tiny clicks of band-passed noise, 90 ms apart. */
const NIBBLE: Bursts = {
  dur: 0.29,
  at: [0, 0.09, 0.18, 0.27],
  len: 0.012,
  filter: 'bandpass',
  hz: 2500,
  q: 2,
  gain: NIBBLE_GAIN,
};

/** The level of `flap` (measured peak −10.0 dBFS). */
const FLAP_GAIN = 0.721;

/** Little wings flapping: three soft whooshes of low-passed noise. */
const FLAP: Bursts = {
  dur: 0.28,
  at: [0, 0.11, 0.22],
  len: 0.04,
  filter: 'lowpass',
  hz: 1200,
  q: Math.SQRT1_2,
  gain: FLAP_GAIN,
};

/** The level of `trill` (measured peak −10.0 dBFS). */
const TRILL_GAIN = 0.281;

/** A happy little trill: a 1.4 kHz sine warbling ±80 Hz at 18 Hz, low-passed at 3 kHz. */
const TRILL = {
  dur: 0.5,
  hz: 1400,
  fmHz: 18,
  fmDepthHz: 80,
  lowpassHz: 3000,
  env: scaled(
    [
      [0.02, 1],
      [0.4, 0.7],
      [0.5, 0],
    ],
    TRILL_GAIN,
  ),
} as const;

const trill: SfxSynth = (ctx, out, when) => {
  const osc = new OscillatorNode(ctx, { type: 'sine', frequency: TRILL.hz });
  const fm = lfo(ctx, TRILL.fmHz, TRILL.fmDepthHz, osc.frequency);
  const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: TRILL.lowpassHz, Q: Math.SQRT1_2 });
  const env = new GainNode(ctx, { gain: 0 });
  const end = envelope(env.gain, when, TRILL.env);
  osc.connect(lowpass).connect(env).connect(out);
  return run([osc, fm.osc], [env], [end], when, TRILL.dur);
};

/** The level of `peep` (measured peak −10.0 dBFS). */
const PEEP_GAIN = 0.317;

/** "peep!": a tiny rising sine, 1.8 → 2.3 kHz. */
const PEEP = {
  dur: 0.12,
  pitch: [
    [0, 1800],
    [0.12, 2300],
  ],
  env: scaled(
    [
      [0.008, 1],
      [0.12, 0],
    ],
    PEEP_GAIN,
  ),
} as const;

const peep: SfxSynth = (ctx, out, when) => {
  const osc = new OscillatorNode(ctx, { type: 'sine' });
  contour(osc.frequency, when, PEEP.pitch);
  const env = new GainNode(ctx, { gain: 0 });
  const end = envelope(env.gain, when, PEEP.env);
  osc.connect(env).connect(out);
  return run([osc], [env], [end], when, PEEP.dur);
};

/** The level of `pat` (measured peak −10.0 dBFS). */
const PAT_GAIN = 0.271;

/** A soft webbed-foot pat: a sine thump falling 180 → 90 Hz with a little low-passed noise for the slap. */
const PAT = {
  dur: 0.12,
  pitch: [
    [0, 180],
    [0.12, 90],
  ],
  lowpassHz: 400,
  /** The noise's level relative to the sine's. */
  noiseMix: 1.5,
  env: scaled(
    [
      [0.006, 1],
      [0.12, 0],
    ],
    PAT_GAIN,
  ),
} as const;

const pat: SfxSynth = (ctx, out, when) => {
  const osc = new OscillatorNode(ctx, { type: 'sine' });
  contour(osc.frequency, when, PAT.pitch);
  const src = noise(ctx, true);
  const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: PAT.lowpassHz, Q: Math.SQRT1_2 });
  const noiseMix = new GainNode(ctx, { gain: PAT.noiseMix });
  const env = new GainNode(ctx, { gain: 0 });
  const end = envelope(env.gain, when, PAT.env);
  osc.connect(env);
  src.connect(lowpass).connect(noiseMix).connect(env);
  env.connect(out);
  return run([osc, src], [env], [end], when, PAT.dur);
};

/** Every sound effect, by id (plan §4.6.4). */
export const SYNTHS: Record<SfxId, SfxSynth> = {
  testBeep,
  sneeze: sneezeSynth(SNEEZE),
  bigSneeze: sneezeSynth(BIG_SNEEZE),
  boing,
  purr,
  hm: blip(HM),
  hmph,
  pop,
  boingHehe,
  giggle,
  sigh,
  squeal,
  hi: blip(HI),
  hey: blip(HEY),
  whoa: blip(WHOA),
  rustle,
  quack: quackSynth(QUACK),
  bigQuack: quackSynth(BIG_QUACK),
  nibble: burstSynth(NIBBLE),
  trill,
  peep,
  flap: burstSynth(FLAP),
  pat,
};
