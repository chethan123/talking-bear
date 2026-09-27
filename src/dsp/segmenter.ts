// Shared VAD segmenter (plan §3.3, §4.2.3). One segmenter serves both VAD backends: it turns a per-step
// speech probability (Silero p every 32 ms, or 0/1 from the energy gate every 10 ms) into start / end /
// misfire events, with hysteresis, a hangover, a minimum speech length and a maximum utterance length.
//
// Durations are counted in steps (the counter `k`), never from frame-label differences: `frame` is an
// opaque label that is only copied into the events.

export type SegEvent =
  | { kind: 'start'; frame: number }
  | { kind: 'end'; frame: number; lastSpeechFrame: number; reason: 'silence' | 'maxLength' }
  | { kind: 'misfire'; frame: number };

export interface SegParams {
  posThreshold: number;
  negThreshold: number;
  hangoverMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  frameMs: number;
}

export const SILERO_SEG_PARAMS: SegParams = {
  posThreshold: 0.5,
  negThreshold: 0.35,
  hangoverMs: 600,
  minSpeechMs: 150,
  maxUtteranceMs: 10000,
  frameMs: 32,
};

export const ENERGY_SEG_PARAMS: SegParams = {
  posThreshold: 0.5,
  negThreshold: 0.5,
  hangoverMs: 800,
  minSpeechMs: 150,
  maxUtteranceMs: 10000,
  frameMs: 10,
};

export interface SegState {
  /** Step counter: the index of the next step. Incremented on every `segmenterStep` call. */
  k: number;
  /** True between a `start` and the `end` or `misfire` that closes it. */
  inSpeech: boolean;
  /** Step and frame label of the current segment's `start`. */
  startStep: number;
  startFrame: number;
  /** Step and frame label of the current segment's latest step with `prob ≥ posThreshold`. */
  lastSpeechStep: number;
  lastSpeechFrame: number;
  /** Step at which the current silence run began (first `prob < negThreshold` after speech), or null. */
  silenceStartStep: number | null;
}

export function initialSegState(): SegState {
  return {
    k: 0,
    inSpeech: false,
    startStep: 0,
    startFrame: 0,
    lastSpeechStep: 0,
    lastSpeechFrame: 0,
    silenceStartStep: null,
  };
}

/** Mutates s. Returns the event emitted by this step, or null. `frame` is an opaque, strictly increasing label
 *  (the worker passes the context-rate frame index of the step's first sample).
 *  A NaN `prob` fails every comparison, so it counts as a value between the thresholds. */
export function segmenterStep(s: SegState, p: SegParams, frame: number, prob: number): SegEvent | null {
  const k = s.k;
  s.k = k + 1;

  if (!s.inSpeech) {
    if (prob >= p.posThreshold) {
      s.inSpeech = true;
      s.startStep = k;
      s.startFrame = frame;
      s.lastSpeechStep = k;
      s.lastSpeechFrame = frame;
      s.silenceStartStep = null;
      return { kind: 'start', frame };
    }
    return null;
  }

  if (prob >= p.posThreshold) {
    s.lastSpeechStep = k;
    s.lastSpeechFrame = frame;
    s.silenceStartStep = null;
  } else if (prob < p.negThreshold && s.silenceStartStep === null) {
    s.silenceStartStep = k;
  }
  // Otherwise the value is between the thresholds: nothing changes.

  if (s.silenceStartStep !== null && (k - s.silenceStartStep + 1) * p.frameMs >= p.hangoverMs) {
    const speechMs = (s.lastSpeechStep - s.startStep + 1) * p.frameMs;
    s.inSpeech = false;
    s.silenceStartStep = null;
    return speechMs >= p.minSpeechMs
      ? { kind: 'end', frame, lastSpeechFrame: s.lastSpeechFrame, reason: 'silence' }
      : { kind: 'misfire', frame };
  }
  if ((k - s.startStep + 1) * p.frameMs >= p.maxUtteranceMs) {
    s.inSpeech = false;
    s.silenceStartStep = null;
    return { kind: 'end', frame, lastSpeechFrame: s.lastSpeechFrame, reason: 'maxLength' };
  }
  return null;
}
