// Lab page for X-F4 (duck plan §5 T117, §6): the owner's pre-tune of the Duckling voice, then the duck listening
// test. Dev-only: `pnpm dev`, then /lab/duck.html (docs/lab.md).
//
// Capture is lab/voices' pattern: the speaker holds Record (≤ 4 s), and the clip is an engine take from the app's
// capture worklet ring (production constraints). Everything plays through the engine's master bus.
//
// Pre-tune: four sliders bounded by DUCK_TUNE_BOUNDS (p, amHz, amMix, peak1Db). Play renders the pre-tune
// recording by composing the stages itself, because processVoice reads the constant DUCK:
//   x = hpfTrim(clip) → y = resample(x, p) → voiced = isVoiced(y) → z = duck(y, fs, {...DUCK, amHz, amMix,
//   peak1Db}) → applyGain(z, voiced) → fades(z)
// "Copy params (JSON)" copies {p, amHz, amMix, peak1Db}, numbers only.
//
// Test: the frozen params are typed (or pasted) into a field (default DUCK at DUCK_PITCH_RATIO). Each trial
// shows the speaker a word and its picture (lab/duck-words.ts), and replays it in one of three conditions:
//   cub       processVoice(clip, fs, PRESETS.cub) (the production default voice);
//   duck      the composition above with the frozen params;
//   duckSoft  the same with softenDuck(frozen params) (duck plan §3.1.3) and the frozen p.
// Each listener gets the conditions in random order, in blocks of 3 (each condition once per block). The
// experimenter taps ✓ or ✗ (the word the listener said), then "sounds like a duck?" yes or no. Kept per trial:
// {listener, ageGroup, route, condition, correct, duckLike}; listener codes L1, L2, … come from the page.
//
// Privacy (plan Q2): only votes are kept. Where every buffer is released:
// - the captured clip (engine.getClip): zero-filled in finishRecording's `finally` as soon as it is rendered (or
//   rejected); a clip that arrives after its wait has timed out is zero-filled by the event listener;
// - the pre-tune segment (hpfTrim of the pre-tune clip, kept so Play can re-render it with new slider values):
//   zero-filled on a new pre-tune recording, on Forget recording, on Close, on pagehide and on dispose;
// - every render's intermediates (the hpfTrim copy of a test clip, the resampled copy, the duck output once
//   copied into its AudioBuffer, processVoice's output): zero-filled before the render returns or throws. Copies
//   made inside library calls (processVoice's own high-pass copy, isVoiced's 8 kHz copy, the K-weighted copies of
//   the loudness measurement, duckStage's filter states) are not reachable from here and are dropped unzeroed;
// - the AudioBuffer that plays: a pre-tune buffer when its playback ends or is stopped; a trial's buffer once the
//   trial is scored or discarded (a new recording, Close, pagehide, dispose);
// - engine-owned copies outside the page's reach (a take still being assembled, the 12 s capture ring): as in
//   lab/voices, Close keeps the context running for RING_SECONDS + 0.5 s so silence overwrites the ring.
// Nothing captured is stored or exported; Copy params, Copy results and Copy log copy text only.

import { RING_SECONDS } from '../src/audio/constants.ts';
import { createEngine, type Engine, type EngineEvent } from '../src/audio/engine.ts';
import { DUCK, DUCK_TUNE_BOUNDS, softenDuck, type DuckParams } from '../src/dsp/duck.ts';
import { DUCK_PITCH_RATIO, PRESETS } from '../src/dsp/types.ts';
import { processVoice, voiceStages } from '../src/dsp/voice.ts';
import { el, fmt, logPanel } from './common.ts';
import { DUCK_WORDS, type DuckWord } from './duck-words.ts';

// ---- constants ----------------------------------------------------------------------------------------------

/** The test conditions (duck plan §5 T117, §6 X-F4). */
export const CONDITIONS = ['cub', 'duck', 'duckSoft'] as const;
export type Condition = (typeof CONDITIONS)[number];
export type AgeGroup = 'adult' | 'child';
export type Route = 'speaker' | 'headphones';

/** The pre-tune values: the pitch ratio and the three duck-stage parameters the sliders move. */
export interface TuneParams {
  readonly p: number;
  readonly amHz: number;
  readonly amMix: number;
  readonly peak1Db: number;
}
type TuneKey = keyof TuneParams;
const TUNE_KEYS: readonly TuneKey[] = ['p', 'amHz', 'amMix', 'peak1Db'];
/** Slider steps (duck plan T117) and the decimals a slider value is rounded to. */
const TUNE_STEP: Readonly<Record<TuneKey, number>> = { p: 0.05, amHz: 5, amMix: 0.05, peak1Db: 1 };
const TUNE_DECIMALS: Readonly<Record<TuneKey, number>> = { p: 2, amHz: 0, amMix: 2, peak1Db: 0 };
const TUNE_LABEL: Readonly<Record<TuneKey, string>> = {
  p: 'Pitch ratio p',
  amHz: 'AM rate (Hz)',
  amMix: 'AM mix',
  peak1Db: 'Peak at 1.6 kHz (dB)',
};
/** The frozen values the page starts with: DUCK at DUCK_PITCH_RATIO. */
const DEFAULT_TUNE: TuneParams = Object.freeze({
  p: DUCK_PITCH_RATIO,
  amHz: DUCK.amHz,
  amMix: DUCK.amMix,
  peak1Db: DUCK.peak1Db,
});

/** One scored trial: all the page keeps (plan Q2). */
export interface TrialRecord {
  readonly listener: string;
  readonly ageGroup: AgeGroup;
  readonly route: Route;
  readonly condition: Condition;
  readonly correct: boolean;
  readonly duckLike: boolean;
}

/** Longest capture: the take ends here even if Record is still held. */
const MAX_SEC = 4;
/** Shortest capture that makes a recording; a shorter hold is a slip. */
const MIN_SEC = 0.5;
/** The take ends this long after the release, so the mic's input latency doesn't cut the last word. */
const RELEASE_TAIL_SEC = 0.15;
/** Playback starts this long after it is scheduled. */
const LEAD_SEC = 0.1;
/** How long to wait for the context and the mic (the permission prompt). */
const SETUP_TIMEOUT_MS = 30000;
/** How long to wait for a take's clipReady or takeFailed once the context has reached its end. */
const EVENT_TIMEOUT_MS = 2000;
/** After Close the context runs this long, so silence overwrites the capture ring, before it suspends. */
const RING_WIPE_MS = (RING_SECONDS + 0.5) * 1000;
/** Engine events too frequent, or irrelevant here, to log. */
const QUIET_EVENTS: ReadonlySet<EngineEvent['t']> = new Set(['level', 'seg', 'floorSnapshot', 'vadStats']);

// ---- params -------------------------------------------------------------------------------------------------

function roundTo(v: number, decimals: number): number {
  const k = 10 ** decimals;
  return Math.round(v * k) / k;
}

/**
 * Parses frozen params: a JSON object with exactly the keys p, amHz, amMix and peak1Db, each a finite number within
 * DUCK_TUNE_BOUNDS. Returns the params, or a message saying what is wrong.
 */
export function parseTuneParams(text: string): TuneParams | string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return 'not JSON';
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'not a JSON object';
  const keys = Object.keys(v).toSorted();
  if (keys.join() !== TUNE_KEYS.toSorted().join()) return `the keys must be exactly ${TUNE_KEYS.join(', ')}`;
  const out: Record<TuneKey, number> = { ...DEFAULT_TUNE };
  for (const k of TUNE_KEYS) {
    const n: unknown = Reflect.get(v, k);
    const [lo, hi] = DUCK_TUNE_BOUNDS[k];
    if (typeof n !== 'number' || !Number.isFinite(n)) return `${k} is not a number`;
    if (n < lo - 1e-9 || n > hi + 1e-9) return `${k} = ${n} is outside ${lo}–${hi}`;
    out[k] = n;
  }
  return Object.freeze(out);
}

/** The duck-stage parameters of a pre-tune: DUCK with its amHz, amMix and peak1Db. */
function duckParams(t: TuneParams): Readonly<DuckParams> {
  return Object.freeze({ ...DUCK, amHz: t.amHz, amMix: t.amMix, peak1Db: t.peak1Db });
}

// ---- rendering ----------------------------------------------------------------------------------------------

/** Zero-fills the whole buffer behind `view` (hpfTrim returns a view of its high-passed copy). */
function zeroBacking(view: Float32Array): void {
  new Float32Array(view.buffer).fill(0);
}

function zeroBuffer(b: AudioBuffer | null): void {
  b?.getChannelData(0).fill(0);
}

function peakAbs(y: Float32Array): number {
  let m = 0;
  for (let i = 0; i < y.length; i++) m = Math.max(m, Math.abs(y[i]!));
  return m;
}

/** What a render returns: the buffer that plays and numbers for the log. */
interface Rendered {
  readonly buffer: AudioBuffer;
  readonly peak: number;
  readonly detail: string;
}

/**
 * The Duckling chain on a conditioned segment x (hpfTrim's output) with params d at pitch ratio p:
 * y = resample(x, p); voiced = isVoiced(y, fs); z = duck(y, fs, d); applyGain(z, fs, voiced); fades(z, fs).
 * Returns z as a mono AudioBuffer; y and z are zero-filled before it returns or throws. Never modifies x.
 */
function renderDuck(x: Float32Array, fs: number, p: number, d: Readonly<DuckParams>): Rendered {
  let y: Float32Array | null = null;
  let z: Float32Array | null = null;
  try {
    y = voiceStages.resample(x, p);
    const voiced = voiceStages.isVoiced(y, fs);
    z = voiceStages.duck(y, fs, d);
    const g = voiceStages.applyGain(z, fs, voiced);
    voiceStages.fades(z, fs);
    const peak = peakAbs(z);
    return {
      buffer: toBuffer(z, fs),
      peak,
      detail: `${fmt(z.length / fs, 3)} s, voiced ${voiced}, gain ${fmt(g, 2)} dB, peak ${fmt(peak, 3)}`,
    };
  } finally {
    y?.fill(0);
    z?.fill(0);
  }
}

/** One test condition on a captured clip `pcm`; every intermediate is zero-filled before it returns or throws. */
function renderCondition(pcm: Float32Array, fs: number, c: Condition, frozen: TuneParams): Rendered {
  if (c === 'cub') {
    const out = processVoice(pcm, fs, PRESETS.cub).pcm;
    try {
      const peak = peakAbs(out);
      return {
        buffer: toBuffer(out, fs),
        peak,
        detail: `${fmt(out.length / fs, 3)} s, peak ${fmt(peak, 3)}`,
      };
    } finally {
      out.fill(0);
    }
  }
  const d = c === 'duck' ? duckParams(frozen) : softenDuck(duckParams(frozen));
  const x = voiceStages.hpfTrim(pcm, fs);
  try {
    return renderDuck(x, fs, frozen.p, d);
  } finally {
    zeroBacking(x);
  }
}

/** A mono AudioBuffer holding a copy of y at sampleRate. */
function toBuffer(y: Float32Array, sampleRate: number): AudioBuffer {
  const b = new AudioBuffer({ length: y.length, numberOfChannels: 1, sampleRate });
  b.getChannelData(0).set(y);
  return b;
}

/** The context frame now (the capture worklet's currentFrame domain). */
function frameNow(ctx: AudioContext): number {
  return Math.round(ctx.currentTime * ctx.sampleRate);
}

/** A button with its `data-role` (the Browser Mode test finds controls by it). */
function button(role: string, label: string): HTMLButtonElement {
  return el('button', { type: 'button', 'data-role': role }, label);
}

// ---- random -------------------------------------------------------------------------------------------------

/** A uniform integer in [0, n) from crypto.getRandomValues (rejection sampling, no modulo bias). */
function randomInt(n: number): number {
  const word = new Uint32Array(1);
  const limit = Math.floor(2 ** 32 / n) * n;
  for (;;) {
    crypto.getRandomValues(word);
    const v = word[0]!;
    if (v < limit) return v % n;
  }
}

/** A uniformly random permutation of `items` (Fisher–Yates with randomInt). */
function shuffled<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

// ---- page ---------------------------------------------------------------------------------------------------

/** What mountDuckLab returns. */
export interface DuckLab {
  /** The scored trials as JSON text (an array of TrialRecord): what "Copy results (JSON)" copies. */
  results(): string;
  /** The latest captured clip (the object the engine handed over), for tests; zero-filled once rendered. */
  lastClip(): Float32Array | null;
  /** Closes the mic, zero-fills every buffer, suspends the context, removes the page's listeners and its DOM. */
  dispose(): void;
}

/**
 * Optional dependencies. Without `engine`, the page creates its own (createEngine). An injected engine needs
 * `subscribe`, which must hand the page every event of that engine (the Engine interface has no event API: its
 * creator receives them) and return the unsubscribe function.
 */
export interface DuckLabDeps {
  engine?: Engine;
  subscribe?: (listener: (e: EngineEvent) => void) => () => void;
}

/** A pending waitEvent: resolved with the first matching event, or null on timeout or Close. */
interface Waiter {
  readonly match: (e: EngineEvent) => boolean;
  readonly resolve: (e: EngineEvent | null) => void;
}

/** An open mic: the engine's running context, its master bus and the take epoch of this session. */
interface Session {
  readonly ctx: AudioContext;
  readonly bus: AudioNode;
  readonly epoch: number;
}

/** A Record hold in progress, for the pre-tune or for a test trial. */
interface Recording {
  readonly purpose: 'tune' | 'test';
  readonly fromFrame: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** The pre-tune recording: its conditioned segment, kept for Play. */
interface TuneClip {
  readonly x: Float32Array;
  readonly fs: number;
}

/** A rendered test trial waiting for its two answers. */
interface Trial {
  readonly n: number;
  readonly condition: Condition;
  readonly route: Route;
  /** The frozen params this trial was rendered with (duck and duckSoft use them). */
  readonly frozen: TuneParams;
  readonly buffer: AudioBuffer;
  readonly detail: string;
  /** It has played once: scoring is open. */
  played: boolean;
  correct: boolean | null;
}

/** The current listener: a page-assigned code, the age group locked by the first trial, the condition block. */
interface Listener {
  readonly code: string;
  ageGroup: AgeGroup;
  trials: number;
  /** The rest of the current block of 3; block[0] is the next trial's condition. */
  block: Condition[];
}

/**
 * Builds the X-F4 page in `root` and wires it to the engine. The page's module body calls it on #duck-lab, so
 * importing this module elsewhere (the Browser Mode test) has no side effect.
 */
export function mountDuckLab(root: HTMLElement, deps: DuckLabDeps = {}): DuckLab {
  // ---- DOM ----------------------------------------------------------------------------------------------------
  const openButton = button('open', 'Open mic');
  const closeButton = button('close', 'Close');
  const status = el('p', { 'aria-live': 'polite' }, 'Press Open mic.');

  const tuneRecord = button('tune-record', `Hold to record (≤ ${MAX_SEC} s)`);
  const tunePlay = button('tune-play', 'Play');
  const tuneForget = button('tune-forget', 'Forget recording');
  const copyParams = button('copy-params', 'Copy params (JSON)');
  const useParams = button('use-params', 'Use these values for the test');
  const sliderRows: HTMLElement[] = [];
  /** A range input for k, its value display, and its row in sliderRows. */
  const slider = (k: TuneKey): HTMLInputElement => {
    const [lo, hi] = DUCK_TUNE_BOUNDS[k];
    const input = el('input', {
      type: 'range',
      min: String(lo),
      max: String(hi),
      step: String(TUNE_STEP[k]),
      value: String(DEFAULT_TUNE[k]),
      'data-param': k,
    });
    const out = el('output', {}, fmt(DEFAULT_TUNE[k], TUNE_DECIMALS[k]));
    input.addEventListener('input', () => {
      out.textContent = fmt(tuneValue(k), TUNE_DECIMALS[k]);
    });
    sliderRows.push(el('p', {}, el('label', {}, `${TUNE_LABEL[k]} (${lo}–${hi}) `, input), ' ', out));
    return input;
  };
  const sliders: Readonly<Record<TuneKey, HTMLInputElement>> = {
    p: slider('p'),
    amHz: slider('amHz'),
    amMix: slider('amMix'),
    peak1Db: slider('peak1Db'),
  };

  const listenerCode = el('strong', {});
  const newListener = button('new-listener', 'New listener');
  const ageSelect = el(
    'select',
    { 'data-role': 'age' },
    el('option', { value: 'adult' }, 'Adult'),
    el('option', { value: 'child' }, 'Child'),
  );
  const routeSelect = el(
    'select',
    { 'data-role': 'route' },
    el('option', { value: 'speaker' }, 'Phone speaker'),
    el('option', { value: 'headphones' }, 'Headphones'),
  );
  const frozenInput = el('textarea', { rows: '2', cols: '60', spellcheck: 'false', 'data-role': 'frozen' });
  frozenInput.value = JSON.stringify(DEFAULT_TUNE);
  const picture = el('span', { 'aria-hidden': 'true' });
  const wordText = el('span', {});
  const testRecord = button('test-record', `Hold to record (≤ ${MAX_SEC} s)`);
  const replay = button('replay', 'Replay');
  const correctButton = button('correct', '✓ Said the word');
  const wrongButton = button('wrong', '✗ Something else');
  const duckYes = button('duck-yes', 'Yes');
  const duckNo = button('duck-no', 'No');
  const copyResults = button('copy-results', 'Copy results (JSON)');
  const tallyRows = el('tbody');
  const details = el('details');

  root.append(
    el('div', { class: 'lab-buttons' }, openButton, closeButton),
    status,
    el(
      'section',
      {},
      el('h2', {}, '1. Pre-tune (the owner, alone, on the phone speaker)'),
      el(
        'p',
        {},
        'Hold Record and say a phrase (at most 4 s); it plays at once. Move the sliders and press Play to hear ' +
          'the same recording again. When it sounds right, press Copy params (JSON) and keep the text.',
      ),
      el('p', {}, tuneRecord),
      ...sliderRows,
      el('div', { class: 'lab-buttons' }, tunePlay, tuneForget, copyParams, useParams),
    ),
    el(
      'section',
      {},
      el('h2', {}, '2. Listening test (X-F4)'),
      el(
        'p',
        {},
        'The frozen params (from Copy params) are used for the duck and duckSoft conditions; the field locks ' +
          'at the first scored trial.',
      ),
      el('p', {}, el('label', {}, 'Frozen params (JSON) ', frozenInput)),
      el(
        'fieldset',
        {},
        el('legend', {}, 'Listener and output route'),
        'Listener ',
        listenerCode,
        ' ',
        newListener,
        el('label', {}, 'Age group ', ageSelect),
        ' ',
        el('label', {}, 'Route ', routeSelect),
      ),
      el('p', {}, 'Speaker, say:'),
      // The largest default type (lab pages have no page CSS): the speaker reads it at arm's length.
      el('h1', {}, picture, ' ', wordText),
      el('p', {}, testRecord, ' ', replay),
      el('fieldset', {}, el('legend', {}, 'What the listener said'), correctButton, wrongButton),
      el('fieldset', {}, el('legend', {}, 'Sounds like a duck?'), duckYes, duckNo),
      el('div', { class: 'lab-buttons' }, copyResults),
    ),
    details,
  );
  details.append(
    el('summary', {}, 'Results and log (for the operator: open after the listener is done)'),
    el('h2', {}, 'Tally'),
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          ...['Condition', 'Age group', 'Trials', 'Correct', 'Duck-like'].map((h) => el('th', {}, h)),
        ),
      ),
      tallyRows,
    ),
  );
  const log = logPanel(details);

  // ---- state --------------------------------------------------------------------------------------------------
  const waiters = new Set<Waiter>();
  let disposed = false;
  let session: Session | null = null;
  let recording: Recording | null = null;
  let tune: TuneClip | null = null;
  let trial: Trial | null = null;
  let clip: Float32Array | null = null;
  /** A take is being fetched or rendered: Record is ignored meanwhile. */
  let busy = false;
  let opening = false;
  /** Bumped by Open, Close, pagehide and dispose: work that finds it changed after an await was superseded. */
  let generation = 0;
  let nextReq = 1;
  let nextEpoch = 1;
  let nextTakeId = 1;
  let trialCount = 0;
  let pendingTake: { readonly epoch: number; readonly id: number } | null = null;
  /** The playing source and what to do when it is stopped (its ended listener handles the end). */
  let playing: { readonly src: AudioBufferSourceNode; readonly onStop: () => void } | null = null;
  let wipeTimer: ReturnType<typeof setTimeout> | null = null;
  const records: TrialRecord[] = [];
  let listenerCount = 0;
  let listener: Listener = nextListener();
  let deck: DuckWord[] = [];
  let word: DuckWord = nextWord();

  let engine: Engine;
  let unsubscribe: () => void;
  if (deps.engine !== undefined) {
    if (deps.subscribe === undefined) throw new TypeError('mountDuckLab: an injected engine needs subscribe');
    engine = deps.engine;
    unsubscribe = deps.subscribe(onEvent);
  } else {
    engine = createEngine({ connectWorkletOutput: false, onEvent: (e) => onEvent(e) });
    unsubscribe = () => {};
  }

  function nextListener(): Listener {
    listenerCount++;
    return { code: `L${listenerCount}`, ageGroup: 'adult', trials: 0, block: [] };
  }

  function nextWord(): DuckWord {
    if (deck.length === 0) deck = shuffled(DUCK_WORDS);
    return deck.pop()!;
  }

  /** The listener's next condition (block[0]); a new block of the 3, shuffled, when the last one is used up. */
  function nextCondition(): Condition {
    if (listener.block.length === 0) listener.block = shuffled(CONDITIONS);
    return listener.block[0]!;
  }

  function say(text: string): void {
    status.textContent = text;
  }

  function tuneValue(k: TuneKey): number {
    return roundTo(Number(sliders[k].value), TUNE_DECIMALS[k]);
  }

  function tuneParams(): TuneParams {
    return {
      p: tuneValue('p'),
      amHz: tuneValue('amHz'),
      amMix: tuneValue('amMix'),
      peak1Db: tuneValue('peak1Db'),
    };
  }

  function route(): Route {
    return routeSelect.value === 'headphones' ? 'headphones' : 'speaker';
  }

  function ageGroup(): AgeGroup {
    return ageSelect.value === 'child' ? 'child' : 'adult';
  }

  function render(): void {
    const noMic = session === null || busy;
    openButton.disabled = session !== null || opening;
    closeButton.disabled = session === null;
    tuneRecord.disabled = noMic;
    testRecord.disabled = noMic;
    tunePlay.disabled = tune === null || session === null;
    tuneForget.disabled = tune === null;
    useParams.disabled = records.length > 0;
    frozenInput.readOnly = records.length > 0;
    listenerCode.textContent = listener.code;
    newListener.disabled = listener.trials === 0;
    ageSelect.disabled = listener.trials > 0;
    replay.disabled = trial === null || session === null;
    const canScore = trial !== null && trial.played && trial.correct === null;
    correctButton.disabled = !canScore;
    wrongButton.disabled = !canScore;
    const canDuck = trial !== null && trial.correct !== null;
    duckYes.disabled = !canDuck;
    duckNo.disabled = !canDuck;
    picture.textContent = word.picture;
    wordText.textContent = word.word;
  }

  function renderTally(): void {
    const rows: HTMLElement[] = [];
    for (const c of CONDITIONS) {
      for (const a of ['adult', 'child'] as const) {
        const rs = records.filter((r) => r.condition === c && r.ageGroup === a);
        const pct = (k: number): string =>
          rs.length === 0 ? '–' : `${k} (${fmt((100 * k) / rs.length, 0)} %)`;
        rows.push(
          el(
            'tr',
            {},
            el('td', {}, c),
            el('td', {}, a),
            el('td', {}, String(rs.length)),
            el('td', {}, pct(rs.filter((r) => r.correct).length)),
            el('td', {}, pct(rs.filter((r) => r.duckLike).length)),
          ),
        );
      }
    }
    tallyRows.replaceChildren(...rows);
  }

  function results(): string {
    return JSON.stringify(records, null, 2);
  }

  function copyText(text: string, what: string): void {
    // Through a promise, so a missing clipboard API (not a secure context) is logged too, never thrown.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => log(`${what} copied (${text.length} characters)`),
        (err: unknown) => log(`copy failed: ${String(err)}`),
      );
  }

  // ---- engine -------------------------------------------------------------------------------------------------

  function onEvent(e: EngineEvent): void {
    if (disposed) {
      // A clip that completes after dispose has no taker: zero it (plan Q2).
      if (e.t === 'clipReady') engine.getClip(e.epoch, e.id)?.fill(0);
      return;
    }
    if (!QUIET_EVENTS.has(e.t)) log(`engine: ${JSON.stringify(e)}`);
    let matched = false;
    for (const w of waiters) {
      if (!w.match(e)) continue;
      matched = true;
      w.resolve(e);
    }
    // A clip whose wait already timed out (or was cancelled) has no taker: zero it now (plan Q2).
    if (e.t === 'clipReady' && !matched) {
      const late = engine.getClip(e.epoch, e.id);
      if (late !== undefined) {
        late.fill(0);
        log(`take ${e.id}: late clip zeroed (${late.length} frames)`);
      }
    }
    // A mic that another app or the OS took away records silence: close, as on Close (outside the engine's call).
    if (e.t === 'trackEnded' && session !== null) setTimeout(() => close('mic track ended'), 0);
  }

  /** The next engine event that `match`es, or null after `timeoutMs` or on Close. Register before the call. */
  function waitEvent(match: (e: EngineEvent) => boolean, timeoutMs: number): Promise<EngineEvent | null> {
    return new Promise((resolve) => {
      const w: Waiter = {
        match,
        resolve(e: EngineEvent | null): void {
          waiters.delete(w);
          clearTimeout(timer);
          resolve(e);
        },
      };
      const timer = setTimeout(() => w.resolve(null), timeoutMs);
      waiters.add(w);
    });
  }

  async function openMic(): Promise<void> {
    if (session !== null || opening) return;
    const gen = ++generation;
    if (wipeTimer !== null) clearTimeout(wipeTimer);
    wipeTimer = null;
    opening = true;
    render();
    say('Opening the mic…');
    try {
      await openSession(gen);
    } finally {
      if (gen === generation) opening = false;
      if (!disposed) render();
    }
  }

  async function openSession(gen: number): Promise<void> {
    const running = waitEvent((e) => e.t === 'ctxRunning' || e.t === 'ctxResumeFailed', SETUP_TIMEOUT_MS);
    engine.resume().catch((err: unknown) => log(`resume failed: ${String(err)}`));
    const c = await running;
    if (gen !== generation) return;
    const ctx = engine.context();
    const bus = engine.masterBus();
    if (c?.t !== 'ctxRunning' || ctx === null || bus === null) {
      say(`No running audio context (${c?.t ?? 'no answer'}).`);
      return;
    }
    const req = nextReq++;
    const answer = waitEvent(
      (e) => (e.t === 'micGranted' || e.t === 'micDenied' || e.t === 'noDevice') && e.req === req,
      SETUP_TIMEOUT_MS,
    );
    engine.openMic(req);
    const m = await answer;
    if (gen !== generation) return;
    if (m?.t !== 'micGranted') {
      engine.closeMic();
      suspendEngine('no mic');
      say(`No mic (${m?.t ?? 'no answer'}).`);
      return;
    }
    session = { ctx, bus, epoch: nextEpoch++ };
    const busGain = bus instanceof GainNode ? fmt(bus.gain.value, 3) : 'n/a';
    log(
      `open: sampleRate ${ctx.sampleRate} Hz, baseLatency ${fmt(ctx.baseLatency * 1000, 1)} ms, outputLatency ` +
        `${fmt(ctx.outputLatency * 1000, 1)} ms; playback → the engine's master bus (gain ${busGain}) → ` +
        'any Quiet-mode stage → destination',
    );
    render();
    say('Pre-tune: hold Record and say a phrase. Test: the speaker holds Record and says the word.');
  }

  function suspendEngine(why: string): void {
    engine.suspend().then(
      () => log(`context suspended (${why})`),
      (err: unknown) => log(`suspend failed: ${String(err)}`),
    );
  }

  /**
   * Stops the mic, playback and every recording in progress, and zero-fills every buffer; the results stay. With
   * `wipeRing` (Close, a lost mic track) the context runs for RING_WIPE_MS, so the capture worklet overwrites its
   * ring with silence, then suspends unless the page opened again meanwhile; pagehide and dispose suspend at once.
   */
  function close(why: string, wipeRing = true): void {
    const gen = ++generation;
    for (const w of waiters) w.resolve(null);
    discardRecording();
    releaseTrial();
    releaseTune();
    stopPlayback();
    discardPendingTake();
    engine.closeMic(); // stops the tracks and drops the engine's last clip and any take being assembled
    session = null;
    busy = false;
    opening = false;
    if (wipeTimer !== null) clearTimeout(wipeTimer);
    wipeTimer = null;
    if (wipeRing) {
      wipeTimer = setTimeout(() => {
        wipeTimer = null;
        if (gen === generation) suspendEngine('capture ring overwritten with silence');
      }, RING_WIPE_MS);
      log(
        `${why}: mic closed, buffers zeroed; the context suspends in ${fmt(RING_WIPE_MS / 1000, 1)} s, once ` +
          'silence has overwritten the capture ring',
      );
    } else {
      suspendEngine(why);
      log(`${why}: mic closed, buffers zeroed`);
    }
    if (disposed) return;
    render();
    say('Mic closed. Open it again to go on.');
  }

  // ---- playback -----------------------------------------------------------------------------------------------

  /** Stops and disconnects the playing source, if any, and runs its onStop. */
  function stopPlayback(): void {
    const p = playing;
    playing = null;
    if (p === null) return;
    try {
      p.src.stop();
    } catch {
      // Already stopped.
    }
    p.src.disconnect();
    p.onStop();
  }

  /** Plays `buffer` through the master bus; `onEnd(true)` when it ends, `onEnd(false)` when it is stopped. */
  function play(buffer: AudioBuffer, onEnd: (ended: boolean) => void): void {
    const s = session;
    if (s === null) return;
    stopPlayback();
    const src = new AudioBufferSourceNode(s.ctx, { buffer });
    src.connect(s.bus);
    const entry = { src, onStop: () => onEnd(false) };
    src.addEventListener('ended', () => {
      if (playing !== entry) return;
      playing = null;
      src.disconnect();
      onEnd(true);
    });
    playing = entry;
    src.start(s.ctx.currentTime + LEAD_SEC);
  }

  // ---- pre-tune -----------------------------------------------------------------------------------------------

  function releaseTune(): void {
    const t = tune;
    tune = null;
    if (t !== null) zeroBacking(t.x);
  }

  function playTune(): void {
    const t = tune;
    if (t === null) return say('Record a phrase first.');
    if (session === null) return say('Open the mic first.');
    const params = tuneParams();
    const r = renderDuck(t.x, t.fs, params.p, duckParams(params));
    if (r.peak === 0) {
      zeroBuffer(r.buffer);
      return say('Nothing audible was recorded: record again, closer to the phone.');
    }
    log(`pre-tune play ${JSON.stringify(params)}: ${r.detail}`);
    say(
      `Playing p ${fmt(params.p, 2)}, AM ${params.amHz} Hz × ${fmt(params.amMix, 2)}, peak ${params.peak1Db} dB.`,
    );
    play(r.buffer, () => zeroBuffer(r.buffer));
    render();
  }

  // ---- test ---------------------------------------------------------------------------------------------------

  /** Stops playback and zero-fills and drops the pending trial's buffer (plan Q2). */
  function releaseTrial(): void {
    const t = trial;
    trial = null;
    if (t === null) return;
    stopPlayback();
    zeroBuffer(t.buffer);
  }

  function playTrial(t: Trial): void {
    play(t.buffer, (ended) => {
      if (!ended || trial !== t || disposed) return;
      t.played = true;
      render();
      say(
        t.correct === null
          ? `Trial ${t.n}: did the listener say "${word.word}"? Tap ✓ or ✗.`
          : `Trial ${t.n}: does it sound like a duck? Yes or No.`,
      );
    });
  }

  function score(correct: boolean): void {
    const t = trial;
    if (t === null || !t.played || t.correct !== null) return;
    t.correct = correct;
    render();
    say(`Trial ${t.n}: does it sound like a duck? Yes or No.`);
  }

  function answerDuck(duckLike: boolean): void {
    const t = trial;
    if (t === null || t.correct === null) return;
    if (listener.trials === 0) listener.ageGroup = ageGroup();
    const rec: TrialRecord = {
      listener: listener.code,
      ageGroup: listener.ageGroup,
      route: t.route,
      condition: t.condition,
      correct: t.correct,
      duckLike,
    };
    if (records.length === 0) log(`frozen params of the test: ${JSON.stringify(t.frozen)}`);
    records.push(rec);
    listener.trials++;
    listener.block.shift();
    releaseTrial();
    log(`trial ${t.n} (word "${word.word}"): ${JSON.stringify(rec)}; ${t.detail}; buffer zeroed`);
    word = nextWord();
    renderTally();
    render();
    say(`Trial ${t.n} recorded. Next word: speaker, hold Record and say it.`);
  }

  // ---- capture ------------------------------------------------------------------------------------------------

  /** A backstop on Close: zero-fills the pending take's clip if it has arrived but was not yet taken over. */
  function discardPendingTake(): void {
    const p = pendingTake;
    pendingTake = null;
    if (p !== null) engine.getClip(p.epoch, p.id)?.fill(0);
  }

  function startRecording(purpose: Recording['purpose']): void {
    const s = session;
    if (s === null) return say('Open the mic first.');
    if (busy || recording !== null) return;
    if (purpose === 'test') {
      const frozen = parseTuneParams(frozenInput.value);
      if (typeof frozen === 'string') return say(`Frozen params: ${frozen}. Fix the field first.`);
    }
    stopPlayback();
    if (trial !== null) {
      log(`trial ${trial.n}: discarded without a score (re-record)`);
      releaseTrial();
    }
    const timer = setTimeout(() => endHold(`${MAX_SEC} s cap`), MAX_SEC * 1000);
    recording = { purpose, fromFrame: frameNow(s.ctx), timer };
    render();
    say('Recording: release when done.');
  }

  /** Ends the hold without a take (an interrupted hold, a hidden page, Close). */
  function discardRecording(): void {
    const r = recording;
    if (r === null) return;
    recording = null;
    clearTimeout(r.timer);
    log('recording discarded (no take was cut)');
  }

  /** Ends the hold (finishRecording); a failure is logged and shown, so the status never stays "Preparing…". */
  function endHold(why: string): void {
    finishRecording(why).catch((err: unknown) => {
      log(`record (${why}): ${String(err)}`);
      say('That recording failed (see the log): record again.');
    });
  }

  /** Ends the hold: takes [fromFrame, toFrame) from the capture ring and renders it for its purpose. */
  async function finishRecording(why: string): Promise<void> {
    const s = session;
    const r = recording;
    if (s === null || r === null) return;
    recording = null;
    clearTimeout(r.timer);
    const sr = s.ctx.sampleRate;
    const toFrame = Math.min(
      frameNow(s.ctx) + Math.round(RELEASE_TAIL_SEC * sr),
      r.fromFrame + Math.round(MAX_SEC * sr),
    );
    const frames = toFrame - r.fromFrame;
    if (frames < MIN_SEC * sr) {
      say(`Too short (${fmt(frames / sr, 2)} s): hold Record for the whole word or phrase.`);
      log(`recording (${why}): ${fmt(frames / sr, 2)} s, under ${MIN_SEC} s: no take`);
      render();
      return;
    }
    const gen = generation;
    busy = true;
    render();
    say('Preparing…');
    try {
      const id = nextTakeId++;
      const wait = Math.max(0, (toFrame / sr - s.ctx.currentTime) * 1000) + EVENT_TIMEOUT_MS;
      const done = waitEvent(
        (e) => (e.t === 'clipReady' || e.t === 'takeFailed') && e.epoch === s.epoch && e.id === id,
        wait,
      );
      pendingTake = { epoch: s.epoch, id };
      engine.take(s.epoch, id, r.fromFrame, toFrame);
      const e = await done;
      if (gen !== generation) return; // closed first: close() cancelled this wait and closeMic() dropped the take
      pendingTake = null; // from here on this function zero-fills the clip it gets
      if (e?.t !== 'clipReady') {
        say(`No recording (${e === null ? 'timeout' : 'take failed'}): try again.`);
        log(`take ${id} (${why}): ${e === null ? 'no clip in time' : 'take failed'}`);
        return;
      }
      const pcm = engine.getClip(s.epoch, id);
      if (pcm === undefined) {
        say('No recording: try again.');
        log(`take ${id} (${why}): no clip`);
        return;
      }
      clip = pcm;
      try {
        if (pcm.length !== frames) {
          say('The recording came back incomplete: try again.');
          log(`take ${id} (${why}): wrong length (${pcm.length} of ${frames}); discarded`);
          return;
        }
        if (r.purpose === 'tune') acceptTune(pcm, sr, why);
        else acceptTrial(pcm, sr, why);
      } finally {
        pcm.fill(0); // plan Q2: the clip is zeroed once rendered, even if rendering throws
      }
    } finally {
      if (gen === generation) busy = false;
      if (!disposed) render();
    }
  }

  function acceptTune(pcm: Float32Array, fs: number, why: string): void {
    releaseTune();
    tune = { x: voiceStages.hpfTrim(pcm, fs), fs };
    log(
      `pre-tune recording (${why}): ${pcm.length} frames, segment ${fmt(tune.x.length / fs, 2)} s kept for Play; ` +
        'clip zeroed',
    );
    playTune();
  }

  function acceptTrial(pcm: Float32Array, fs: number, why: string): void {
    const frozen = parseTuneParams(frozenInput.value);
    if (typeof frozen === 'string') {
      say(`Frozen params: ${frozen}. Fix the field, then record again.`);
      return;
    }
    const condition = nextCondition();
    const t0 = performance.now();
    const r = renderCondition(pcm, fs, condition, frozen);
    const ms = performance.now() - t0;
    if (r.peak === 0) {
      zeroBuffer(r.buffer);
      say('Nothing audible was recorded: record again, closer to the phone.');
      log(`trial (${why}): a silent render; discarded`);
      return;
    }
    trialCount++;
    const t: Trial = {
      n: trialCount,
      condition,
      route: route(),
      frozen,
      buffer: r.buffer,
      detail: `${condition}: ${r.detail}, rendered in ${fmt(ms, 0)} ms`,
      played: false,
      correct: null,
    };
    trial = t;
    // The log stays blind until the trial is scored: no condition yet.
    log(`trial ${t.n} (${why}): captured ${pcm.length} frames (${fmt(pcm.length / fs, 2)} s); clip zeroed`);
    say(`Trial ${t.n}: playing…`);
    playTrial(t);
  }

  // ---- wiring -------------------------------------------------------------------------------------------------

  function guard(what: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      log(`${what}: ${String(err)}`);
    }
  }

  /** The pointer holding a Record button, or null. */
  let holdPointer: number | null = null;

  for (const [b, purpose] of [
    [tuneRecord, 'tune'],
    [testRecord, 'test'],
  ] as const) {
    b.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      holdPointer = e.pointerId;
      guard('record', () => startRecording(purpose));
    });
    // A finger that drifts during the hold must not scroll the page, open a menu or select text.
    b.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('selectstart', (e) => e.preventDefault());
  }

  /** The release is heard on the window, so lifting off the button counts; a cancelled pointer discards the hold. */
  function release(e: PointerEvent): void {
    if (e.pointerId !== holdPointer) return;
    holdPointer = null;
    if (e.type === 'pointerup') {
      endHold('released');
    } else {
      guard('cancel', discardRecording);
      render();
      say('Hold interrupted: record again.');
    }
  }

  function onPagehide(): void {
    close('pagehide', false);
  }

  /** A hidden page ends a hold unseen and must not keep playing: discard the hold, stop playback. */
  function onVisibility(): void {
    if (document.visibilityState !== 'hidden') return;
    guard('hidden', () => {
      if (recording !== null) {
        discardRecording();
        say('Page hidden: record again.');
      }
      stopPlayback();
      render();
    });
  }

  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('pagehide', onPagehide);
  document.addEventListener('visibilitychange', onVisibility);

  openButton.addEventListener('click', () => {
    openMic().catch((err: unknown) => log(`open: ${String(err)}`));
  });
  closeButton.addEventListener('click', () => close('close'));
  tunePlay.addEventListener('click', () => guard('play', playTune));
  tuneForget.addEventListener('click', () =>
    guard('forget', () => {
      stopPlayback();
      releaseTune();
      log('pre-tune recording zeroed');
      render();
      say('Pre-tune recording forgotten.');
    }),
  );
  copyParams.addEventListener('click', () => copyText(JSON.stringify(tuneParams()), 'params'));
  useParams.addEventListener('click', () => {
    if (records.length > 0) return;
    frozenInput.value = JSON.stringify(tuneParams());
    log(`frozen params set from the sliders: ${frozenInput.value}`);
  });
  newListener.addEventListener('click', () => {
    if (listener.trials === 0) return;
    if (trial !== null) {
      log(`trial ${trial.n}: discarded without a score (new listener)`);
      releaseTrial();
    }
    listener = nextListener();
    log(`new listener ${listener.code}`);
    render();
    say(`Listener ${listener.code}: choose the age group, then the speaker holds Record.`);
  });
  replay.addEventListener('click', () => {
    const t = trial;
    if (t !== null) guard('replay', () => playTrial(t));
  });
  correctButton.addEventListener('click', () => guard('score', () => score(true)));
  wrongButton.addEventListener('click', () => guard('score', () => score(false)));
  duckYes.addEventListener('click', () => guard('duck', () => answerDuck(true)));
  duckNo.addEventListener('click', () => guard('duck', () => answerDuck(false)));
  copyResults.addEventListener('click', () => copyText(results(), `results (${records.length} trials)`));

  render();
  renderTally();
  log(`lab/duck ready: ${navigator.userAgent}`);
  if (!window.isSecureContext) {
    log('not a secure context: the mic needs https or http://localhost (docs/lab.md: adb reverse)');
  }

  return {
    results,
    lastClip: () => clip,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      close('dispose', false);
      if (wipeTimer !== null) clearTimeout(wipeTimer);
      wipeTimer = null;
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('pagehide', onPagehide);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
      root.replaceChildren();
    },
  };
}

// Only the page itself mounts (lab/duck.html has #duck-lab); an import elsewhere has no side effect.
const pageRoot = document.getElementById('duck-lab');
if (pageRoot instanceof HTMLElement) mountDuckLab(pageRoot);
