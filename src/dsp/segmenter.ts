// Shared VAD segmenter (plan §3.3, §4.2.3). One segmenter serves both VAD backends: it turns a per-step
// speech probability (Silero p every 32 ms, or 0/1 from the energy gate every 10 ms) into start / end /
// misfire events, with hysteresis, a hangover, a minimum speech length and a maximum utterance length.
//
// Durations are counted in steps (the counter `k`), never from frame-label differences: `frame` is an
// opaque label that is only copied into the events.
//
// Voiced ratio (#116, plan §4.4): the caller records the voicing of each 10 ms hop of an open segment with
// `segmenterVoicing` (it only counts between a `start` and its `end` or `misfire`), and every `end` carries the
// fraction of those hops that were voiced, so the session can tell a capped take of noise from a long utterance.
// A capped energy segment that the worker's voicing rule turns into a `misfire` keeps its reason and ratio on the
// misfire (#289).

export type SegEvent =
  | { kind: 'start'; frame: number }
  | {
      kind: 'end';
      frame: number;
      lastSpeechFrame: number;
      reason: 'silence' | 'maxLength';
      /**
       * The fraction of the segment's recorded voicing hops (`segmenterVoicing`) that were voiced (#116). Set on
       * every end `segmenterStep` and the worker's VadCore produce: NaN when no hop was recorded (a caller that
       * feeds no voicing). Absent means unknown.
       */
      voicedRatio?: number;
    }
  | {
      kind: 'misfire';
      frame: number;
      /**
       * #289: set only by the worker's VadCore on the energy voicing rule's misfire of a capped segment (an `end`
       * with reason 'maxLength' and under MIN_VOICED_MS voiced), together with that segment's voiced ratio, so
       * the session counts it as a noisy cap (plan §4.4). Absent on every other misfire.
       */
      reason?: 'maxLength';
      voicedRatio?: number;
    };

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
  /** Voicing hops recorded (`segmenterVoicing`) since the current segment's start, and how many were voiced. */
  hops: number;
  voicedHops: number;
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
    hops: 0,
    voicedHops: 0,
  };
}

/**
 * Records the voicing of one 10 ms hop of the open segment (#116). Only hops recorded while a segment is open
 * (from its `start` to its `end` or `misfire`) count; outside one this is a no-op. Doesn't allocate.
 */
export function segmenterVoicing(s: SegState, voiced: boolean): void {
  if (!s.inSpeech) return;
  s.hops++;
  if (voiced) s.voicedHops++;
}

/** voicedHops / hops of the current (or just-closed) segment; NaN when no hop was recorded. */
export function segmentVoicedRatio(s: SegState): number {
  return s.hops > 0 ? s.voicedHops / s.hops : Number.NaN;
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
      s.hops = 0;
      s.voicedHops = 0;
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
      ? {
          kind: 'end',
          frame,
          lastSpeechFrame: s.lastSpeechFrame,
          reason: 'silence',
          voicedRatio: segmentVoicedRatio(s),
        }
      : { kind: 'misfire', frame };
  }
  if ((k - s.startStep + 1) * p.frameMs >= p.maxUtteranceMs) {
    s.inSpeech = false;
    s.silenceStartStep = null;
    return {
      kind: 'end',
      frame,
      lastSpeechFrame: s.lastSpeechFrame,
      reason: 'maxLength',
      voicedRatio: segmentVoicedRatio(s),
    };
  }
  return null;
}
