// Lab page for X-F1 (plan §5, §4.3.2–§4.3.3): a blind A/B/X listening test of three pitch shifters on the
// listener's own phrase. Dev-only: `pnpm dev`, then /lab/voices.html (docs/lab.md).
//
// Each trial: the listener holds Record and speaks (≤ 4 s); the clip comes from the app's capture worklet ring
// (an engine take, production constraints). The page picks p ∈ {1.4, 1.7, 2.0} at random, renders the three
// candidates from the same conditioned segment x (the production HPF + trim, voiceStages.hpfTrim), and plays
// them as X1, X2, X3 in a random order with 600 ms gaps, through the app's master bus:
//   linear  AudioBufferSourceNode.playbackRate = p on x (Chromium's linear interpolation), rendered by an
//           OfflineAudioContext, then the production gain rule and fades;
//   sinc    the production processVoice on the clip (its own HPF + trim give exactly x);
//   psola   psola(x, p) with formant = 1 (lab/algos/psola.ts), then the production gain rule and fades.
// The three are then loudness-matched (BS.1770 integrated loudness) to the quietest of them by a playback
// gain ≤ 0 dB each, so a level difference can't decide the vote. The listener taps a favourite (or "all the
// same"); the page keeps {p, order, choiceAlgorithm} with the listener label and output route.
//
// Privacy (plan Q2): only votes are kept. Where every trial buffer is released:
// - the captured clip (engine.getClip): zero-filled in finishRecording's `finally` as soon as the candidates
//   are rendered (or the clip is rejected); a clip that arrives after its wait has timed out is zero-filled
//   by the engine listener ("late clip zeroed");
// - engine-owned copies, outside the page's reach (memory only; nothing is stored): getClip() returns only
//   completed clips, so a take still being assembled is dropped by closeMic() or the next take(), and the
//   engine's chunk copies of a take over 48 000 frames are dropped unzeroed (the engine's chunk assembly is
//   not reachable from here); the capture worklet's 12 s ring (RING_SECONDS) holds the latest audio, so Close
//   keeps the context running for RING_SECONDS + 0.5 s after closeMic(), until silence has overwritten it,
//   before it suspends (pagehide suspends at once: the page is going away);
// - renderTrial's intermediates (the HPF copy holding x, the resampled copy for the voiced check, the offline
//   render's input buffer, the processVoice and psola outputs): zero-filled in its `finally`. Copies made
//   inside library calls (processVoice's own HPF and voicing copies, isVoiced's 8 kHz copy, the K-weighted
//   copies of the loudness measurement, the OfflineAudioContext's internals) are not reachable from here and
//   are dropped unzeroed (memory only);
// - the three candidate AudioBuffers: zero-filled and dropped by releaseTrial, on every vote, on a new Record
//   while a trial is pending, on Close and on pagehide, after their sources are stopped and disconnected.
// Nothing captured is stored or exported; Copy results (JSON) and Copy log copy text only.

import { RING_SECONDS } from '../src/audio/constants.ts';
import { createEngine, type EngineEvent } from '../src/audio/engine.ts';
import { applyFades } from '../src/dsp/fades.ts';
import { integratedLoudness, voiceGainDb } from '../src/dsp/normalize.ts';
import { FADE_MS, processVoice, trimRange, voiceStages } from '../src/dsp/voice.ts';
import { psola } from './algos/psola.ts';
import { el, fmt, logPanel } from './common.ts';

/** The pitch ratios under test (plan §5 X-F1). */
const RATIOS = [1.4, 1.7, 2.0] as const;
type Ratio = (typeof RATIOS)[number];
/** The candidates (issue #67): A linear playbackRate, B production sinc chain, C formant-preserving PSOLA. */
const ALGORITHMS = ['linear', 'sinc', 'psola'] as const;
type Algorithm = (typeof ALGORITHMS)[number];
type Choice = Algorithm | 'same';
const ROUTES = [
  { value: 'speaker', label: 'Phone speaker' },
  { value: 'headphones', label: 'Headphones' },
] as const;
type Route = (typeof ROUTES)[number]['value'];

/** Longest capture: the take ends here even if Record is still held. */
const MAX_SEC = 4;
/** Shortest capture that makes a trial; a shorter hold is a slip. */
const MIN_SEC = 0.5;
/** The take ends this long after the release, so the mic's input latency doesn't cut the last word. */
const RELEASE_TAIL_SEC = 0.15;
/** Silence between consecutive candidates. */
const GAP_SEC = 0.6;
/** The first candidate starts this long after playback is scheduled. */
const LEAD_SEC = 0.1;
/** How long to wait for the context and the mic (the permission prompt). */
const SETUP_TIMEOUT_MS = 30000;
/** How long to wait for a take's clipReady or takeFailed once the context has reached its end. */
const EVENT_TIMEOUT_MS = 2000;
/** After Close the context runs this long, so silence overwrites the capture ring, before it suspends. */
const RING_WIPE_MS = (RING_SECONDS + 0.5) * 1000;

/** One vote: all the page keeps of a trial. */
interface Vote {
  readonly trial: number;
  readonly listener: string;
  readonly route: Route;
  readonly p: Ratio;
  /** order[k] is the algorithm played as X(k + 1). */
  readonly order: readonly Algorithm[];
  readonly choiceAlgorithm: Choice;
}

/** A rendered trial waiting for its vote. */
interface Trial {
  readonly n: number;
  readonly p: Ratio;
  readonly order: readonly Algorithm[];
  /** Each candidate as it plays (rate 1), and its loudness-matching playback gain in dB (≤ 0). */
  readonly buffers: Record<Algorithm, AudioBuffer>;
  readonly trimDb: Record<Algorithm, number>;
  /** Numbers for the log after the vote. */
  readonly detail: string;
  /** The whole sequence has played once: voting is open. */
  played: boolean;
}

/** An open mic: the engine's running context and the take epoch of this session. */
interface Session {
  readonly ctx: AudioContext;
  readonly bus: AudioNode;
  readonly epoch: number;
}

/** A Record hold in progress. */
interface Recording {
  readonly fromFrame: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

// ---- rendering ----------------------------------------------------------------------------------------------

/** What renderTrial returns: the three candidates and their matching gains, plus numbers for the log. */
interface Rendered {
  readonly buffers: Record<Algorithm, AudioBuffer>;
  readonly trimDb: Record<Algorithm, number>;
  readonly detail: string;
}

/** Multiplies y in place by 10^(db/20). */
function scaleDb(y: Float32Array, db: number): void {
  const k = 10 ** (db / 20);
  for (let i = 0; i < y.length; i++) y[i] = y[i]! * k;
}

/** A mono AudioBuffer holding a copy of y at sampleRate. */
function toBuffer(y: Float32Array, sampleRate: number): AudioBuffer {
  const b = new AudioBuffer({ length: y.length, numberOfChannels: 1, sampleRate });
  b.getChannelData(0).set(y);
  return b;
}

function zeroBuffer(b: AudioBuffer | null): void {
  b?.getChannelData(0).fill(0);
}

/**
 * Renders the three candidates of `pcm` (a take at sampleRate) at pitch ratio p, loudness-matched.
 * - x = the production HPF + trim of pcm (voiceStages.hpfTrim without trim, then trimRange: exactly the
 *   segment processVoice resamples);
 * - voiced = voiceStages.isVoiced(voiceStages.resample(x, p)): exactly processVoice's own voiced decision,
 *   so the gain rule below treats every candidate alike;
 * - linear: an OfflineAudioContext of ceil(|x| / p) frames plays x through an AudioBufferSourceNode at
 *   playbackRate p, then g = voiceGainDb(y, fs, voiced) is applied and applyFades(y, fs, 8);
 * - sinc: processVoice(pcm, fs, { id: 'custom', pitchRatio: p }).pcm, untouched;
 * - psola: psola(x, fs, p, { formant: 1 }), then the same gain rule and fades as linear;
 * - matching: L = integratedLoudness of each result; every candidate gets trimDb = min(L) − L ≤ 0, played as
 *   a GainNode gain, so all three play at the quietest one's loudness and stay within the production caps.
 * Returns null (all buffers zeroed) when a candidate is silent (L = −Infinity). Every intermediate copy it holds
 * is zero-filled before it returns or throws.
 */
async function renderTrial(pcm: Float32Array, sampleRate: number, p: Ratio): Promise<Rendered | null> {
  const fs = sampleRate;
  let full: Float32Array | null = null;
  let resampled: Float32Array | null = null;
  let input: AudioBuffer | null = null;
  let sinc: Float32Array | null = null;
  let shifted: Float32Array | null = null;
  const made: AudioBuffer[] = [];
  let done = false;
  try {
    full = voiceStages.hpfTrim(pcm, fs, false);
    const span = trimRange(full, fs);
    const x = full.subarray(span.start, span.end);
    resampled = voiceStages.resample(x, p);
    const voiced = voiceStages.isVoiced(resampled, fs);

    sinc = processVoice(pcm, fs, { id: 'custom', pitchRatio: p }).pcm;
    const bufSinc = toBuffer(sinc, fs);
    made.push(bufSinc);

    shifted = psola(x, fs, p, { formant: 1 });
    const gPsola = voiceGainDb(shifted, fs, voiced);
    scaleDb(shifted, gPsola);
    applyFades(shifted, fs, FADE_MS);
    const bufPsola = toBuffer(shifted, fs);
    made.push(bufPsola);

    input = toBuffer(x, fs);
    const off = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.ceil(x.length / p),
      sampleRate: fs,
    });
    const src = new AudioBufferSourceNode(off, { buffer: input, playbackRate: p });
    src.connect(off.destination);
    src.start(0);
    const bufLinear = await off.startRendering();
    made.push(bufLinear);
    const linear = bufLinear.getChannelData(0);
    const gLinear = voiceGainDb(linear, fs, voiced);
    scaleDb(linear, gLinear);
    applyFades(linear, fs, FADE_MS);

    const buffers: Record<Algorithm, AudioBuffer> = { linear: bufLinear, sinc: bufSinc, psola: bufPsola };
    const loud: Record<Algorithm, number> = {
      linear: integratedLoudness(linear, fs),
      sinc: integratedLoudness(sinc, fs),
      psola: integratedLoudness(shifted, fs),
    };
    if (!ALGORITHMS.every((a) => Number.isFinite(loud[a]))) return null;
    const target = Math.min(...ALGORITHMS.map((a) => loud[a]));
    const trimDb: Record<Algorithm, number> = {
      linear: target - loud.linear,
      sinc: target - loud.sinc,
      psola: target - loud.psola,
    };
    const detail =
      `x ${fmt(x.length / fs, 3)} s (trim ${span.start}..${span.end} of ${pcm.length}), voiced ${voiced}; ` +
      ALGORITHMS.map(
        (a) =>
          `${a}: ${fmt(buffers[a].duration, 3)} s, ${fmt(loud[a], 2)} LUFS, playback gain ${fmt(trimDb[a], 2)} dB`,
      ).join('; ') +
      `; gain rule linear ${fmt(gLinear, 2)} dB, psola ${fmt(gPsola, 2)} dB`;
    done = true;
    return { buffers, trimDb, detail };
  } finally {
    // Plan Q2: no intermediate copy outlives the render; the candidates too unless they are returned.
    full?.fill(0);
    resampled?.fill(0);
    zeroBuffer(input);
    sinc?.fill(0);
    shifted?.fill(0);
    if (!done) for (const b of made) zeroBuffer(b);
  }
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

const root = document.getElementById('lab');
if (!(root instanceof HTMLElement)) throw new Error('lab/voices: missing #lab');

const listenerInput = el('input', {
  type: 'text',
  placeholder: 'e.g. adult 1, child 1',
  autocomplete: 'off',
});
const routeSelect = el('select', {}, ...ROUTES.map((r) => el('option', { value: r.value }, r.label)));
const openButton = el('button', { type: 'button' }, 'Open mic');
const closeButton = el('button', { type: 'button' }, 'Close');
const recordButton = el('button', { type: 'button' }, `Hold to record (≤ ${MAX_SEC} s)`);
const replayButton = el('button', { type: 'button' }, 'Replay');
const voteButtons = [0, 1, 2].map((k) => el('button', { type: 'button' }, `X${k + 1}`));
const sameButton = el('button', { type: 'button' }, 'All the same');
const copyButton = el('button', { type: 'button' }, 'Copy results (JSON)');
const status = el(
  'p',
  { 'aria-live': 'polite' },
  'Enter the listener label, choose the route, then Open mic.',
);
const tallyRows = el('tbody');
const results = el('details');

root.append(
  el(
    'fieldset',
    {},
    el('legend', {}, 'Listener and output route'),
    el('label', {}, 'Listener ', listenerInput),
    ' ',
    el('label', {}, 'Route ', routeSelect),
  ),
  el('div', { class: 'lab-buttons' }, openButton, closeButton, copyButton),
  el('p', {}, recordButton),
  status,
  el('fieldset', {}, el('legend', {}, 'Your favourite'), ...voteButtons, sameButton, replayButton),
  results,
);
results.append(
  el('summary', {}, 'Results and log (for the operator: open after the listener is done)'),
  el('h2', {}, 'Votes per algorithm'),
  el(
    'table',
    {},
    el(
      'thead',
      {},
      el('tr', {}, ...['Route', 'p', ...ALGORITHMS, 'same', 'trials'].map((h) => el('th', {}, h))),
    ),
    tallyRows,
  ),
);
const log = logPanel(results);

// ---- state --------------------------------------------------------------------------------------------------

/** A pending waitEvent: resolved with the first matching event, or null on timeout or Close. */
interface Waiter {
  readonly match: (e: EngineEvent) => boolean;
  readonly resolve: (e: EngineEvent | null) => void;
}
const waiters = new Set<Waiter>();
/** Engine events too frequent, or irrelevant here, to log. */
const QUIET_EVENTS: ReadonlySet<EngineEvent['t']> = new Set(['level', 'seg', 'floorSnapshot', 'vadStats']);

const engine = createEngine({
  connectWorkletOutput: false,
  onEvent(e: EngineEvent): void {
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
  },
});

let session: Session | null = null;
let recording: Recording | null = null;
/** The trial waiting for its vote, if any. */
let trial: Trial | null = null;
/** A take is being fetched or rendered: Record is ignored meanwhile. */
let busy = false;
/** Open mic is in progress (the context or the permission prompt). */
let opening = false;
/** Bumped by Open, Close and pagehide: work that finds it changed after an await was superseded. */
let generation = 0;
let nextReq = 1;
let nextEpoch = 1;
let nextTakeId = 1;
let trialCount = 0;
/** The take requested and not yet handed to rendering (see discardPendingTake). */
let pendingTake: { readonly epoch: number; readonly id: number } | null = null;
/** The scheduled or playing candidate sources with their matching gains, and the sequence's status timers. */
const sources = new Map<AudioBufferSourceNode, GainNode>();
const timers = new Set<ReturnType<typeof setTimeout>>();
/** Bumped by every playback start and stop: a stale sequence's `ended` must not open the vote. */
let playToken = 0;
const votes: Vote[] = [];
let sampleRate: number | null = null;
let busGain: number | null = null;

function say(text: string): void {
  status.textContent = text;
}

function listenerLabel(): string {
  return listenerInput.value.trim();
}

function route(): Route {
  return routeSelect.value === 'headphones' ? 'headphones' : 'speaker';
}

function render(): void {
  openButton.disabled = session !== null || opening;
  closeButton.disabled = session === null;
  recordButton.disabled = session === null || busy;
  const canVote = trial !== null && trial.played;
  for (const b of voteButtons) b.disabled = !canVote;
  sameButton.disabled = !canVote;
  replayButton.disabled = trial === null;
}

/** Votes per choice for one route and ratio. */
interface TallyRow {
  readonly route: Route;
  readonly p: Ratio;
  readonly counts: Record<Choice, number>;
  readonly n: number;
}

function tally(): TallyRow[] {
  const out: TallyRow[] = [];
  for (const r of ROUTES) {
    for (const p of RATIOS) {
      const counts: Record<Choice, number> = { linear: 0, sinc: 0, psola: 0, same: 0 };
      let n = 0;
      for (const v of votes) {
        if (v.route !== r.value || v.p !== p) continue;
        counts[v.choiceAlgorithm]++;
        n++;
      }
      out.push({ route: r.value, p, counts, n });
    }
  }
  return out;
}

function renderTally(): void {
  tallyRows.replaceChildren(
    ...tally().map((t) =>
      el(
        'tr',
        {},
        el('td', {}, t.route),
        el('td', {}, String(t.p)),
        ...[...ALGORITHMS, 'same' as const].map((c) => el('td', {}, String(t.counts[c]))),
        el('td', {}, String(t.n)),
      ),
    ),
  );
}

/** The votes only (plan Q2): who, which route, p, the blind order and the choice; no audio, no levels. */
function resultsJson(): string {
  return JSON.stringify(
    {
      experiment: 'X-F1',
      userAgent: navigator.userAgent,
      sampleRate,
      masterBusGain: busGain,
      ratios: RATIOS,
      algorithms: {
        linear: 'AudioBufferSourceNode.playbackRate = p (Chromium linear interpolation)',
        sinc: 'processVoice (production sinc chain)',
        psola: 'TD-PSOLA, formant = 1, production gain rule and fades',
      },
      levelMatching: 'BS.1770 integrated loudness matched to the quietest candidate (playback gain <= 0 dB)',
      votes,
      tally: tally().map((t) => ({ route: t.route, p: t.p, ...t.counts, trials: t.n })),
    },
    null,
    2,
  );
}

// ---- engine -------------------------------------------------------------------------------------------------

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
  opening = true;
  render();
  say('Opening the mic…');
  try {
    await openSession(gen);
  } finally {
    if (gen === generation) opening = false;
    render();
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
    engine.suspend().catch((err: unknown) => log(`suspend failed: ${String(err)}`));
    say(`No mic (${m?.t ?? 'no answer'}).`);
    return;
  }
  session = { ctx, bus, epoch: nextEpoch++ };
  sampleRate = ctx.sampleRate;
  busGain = bus instanceof GainNode ? Math.round(bus.gain.value * 1000) / 1000 : null;
  log(
    `open: sampleRate ${ctx.sampleRate} Hz, baseLatency ${fmt(ctx.baseLatency * 1000, 1)} ms, outputLatency ` +
      `${fmt(ctx.outputLatency * 1000, 1)} ms`,
  );
  log(
    `playback: every candidate → its matching GainNode → the engine's master bus (gain ` +
      `${busGain === null ? 'n/a' : fmt(busGain, 3)}) → any Quiet-mode stage → destination, the same for all three`,
  );
  render();
  say('Hold Record, say a short phrase, then release.');
}

function suspendEngine(why: string): void {
  engine.suspend().then(
    () => log(`context suspended (${why})`),
    (err: unknown) => log(`suspend failed: ${String(err)}`),
  );
}

/**
 * Stops the mic and every trial in progress; the votes stay. With `wipeRing` (Close, a lost mic track) the
 * context keeps running for RING_WIPE_MS, so the capture worklet overwrites its ring with silence, and then
 * suspends unless the page opened or closed again meanwhile; pagehide suspends at once.
 */
function close(why: string, wipeRing = true): void {
  const gen = ++generation;
  for (const w of waiters) w.resolve(null);
  discardRecording();
  releaseTrial();
  discardPendingTake();
  engine.closeMic(); // stops the tracks and drops the engine's last clip and any take being assembled
  session = null;
  busy = false;
  opening = false;
  render();
  say('Mic closed. Open it again to go on.');
  if (wipeRing) {
    setTimeout(() => {
      if (gen === generation) suspendEngine('capture ring overwritten with silence');
    }, RING_WIPE_MS);
    log(
      `${why}: mic closed, trial buffers released; the context suspends in ${fmt(RING_WIPE_MS / 1000, 1)} s, ` +
        'once silence has overwritten the capture ring',
    );
  } else {
    suspendEngine(why);
    log(`${why}: mic closed, trial buffers released`);
  }
}

// ---- playback -----------------------------------------------------------------------------------------------

/** Stops and disconnects every scheduled or playing candidate, and clears the sequence's status timers. */
function stopPlayback(): void {
  playToken++;
  for (const t of timers) clearTimeout(t);
  timers.clear();
  for (const [s, gain] of sources) {
    try {
      s.stop();
    } catch {
      // Already stopped.
    }
    s.disconnect();
    gain.disconnect();
  }
  sources.clear();
}

/** Plays the trial's candidates as X1, X2, X3 in its order, GAP_SEC apart; the vote opens when X3 ends. */
function playSequence(t: Trial): void {
  const s = session;
  if (s === null) return;
  stopPlayback();
  const token = playToken;
  const ctx = s.ctx;
  let at = ctx.currentTime + LEAD_SEC;
  t.order.forEach((a, k) => {
    const gain = new GainNode(ctx, { gain: 10 ** (t.trimDb[a] / 20) });
    const src = new AudioBufferSourceNode(ctx, { buffer: t.buffers[a] });
    src.connect(gain);
    gain.connect(s.bus);
    src.addEventListener('ended', () => {
      src.disconnect();
      gain.disconnect();
      sources.delete(src);
      if (k !== t.order.length - 1 || token !== playToken) return;
      t.played = true;
      render();
      say(`Trial ${t.n}: tap your favourite (X1, X2 or X3), or All the same. Replay to hear them again.`);
    });
    sources.set(src, gain);
    src.start(at);
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        say(`Trial ${t.n}: playing X${k + 1} of ${t.order.length}…`);
      },
      Math.max(0, (at - ctx.currentTime) * 1000),
    );
    timers.add(timer);
    at += t.buffers[a].duration + GAP_SEC;
  });
}

/** Stops playback and zero-fills and drops the pending trial's three candidates (plan Q2). */
function releaseTrial(): void {
  stopPlayback();
  const t = trial;
  trial = null;
  if (t === null) return;
  for (const a of ALGORITHMS) zeroBuffer(t.buffers[a]);
}

// ---- capture ------------------------------------------------------------------------------------------------

/** The context frame now (the capture worklet's currentFrame domain). */
function frameNow(ctx: AudioContext): number {
  return Math.round(ctx.currentTime * ctx.sampleRate);
}

/**
 * A backstop on Close and pagehide: zero-fills the pending take's clip if it has arrived but was not yet taken
 * over. The wait hands an arrived clip to finishRecording in the same microtask checkpoint, so this normally
 * finds none; the clip's release points are finishRecording's `finally` and the late-clip listener.
 */
function discardPendingTake(): void {
  const p = pendingTake;
  pendingTake = null;
  if (p !== null) engine.getClip(p.epoch, p.id)?.fill(0);
}

function startRecording(): void {
  const s = session;
  if (s === null) return say('Open the mic first.');
  if (busy || recording !== null) return;
  if (trial !== null) {
    log(`trial ${trial.n}: discarded without a vote (re-record)`);
    releaseTrial();
  }
  const timer = setTimeout(() => {
    endHold(`${MAX_SEC} s cap`);
  }, MAX_SEC * 1000);
  recording = { fromFrame: frameNow(s.ctx), timer };
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

/** Ends the hold: takes [fromFrame, toFrame) from the capture ring, renders the trial and plays it. */
async function finishRecording(why: string): Promise<void> {
  const s = session;
  const r = recording;
  if (s === null || r === null) return;
  recording = null;
  clearTimeout(r.timer);
  const sr = s.ctx.sampleRate;
  const maxFrames = Math.round(MAX_SEC * sr);
  const toFrame = Math.min(frameNow(s.ctx) + Math.round(RELEASE_TAIL_SEC * sr), r.fromFrame + maxFrames);
  const frames = toFrame - r.fromFrame;
  if (frames < MIN_SEC * sr) {
    say(`Too short (${fmt(frames / sr, 2)} s): hold Record for the whole phrase.`);
    log(`recording (${why}): ${fmt(frames / sr, 2)} s, under ${MIN_SEC} s: no take`);
    render();
    return;
  }
  const gen = generation;
  busy = true;
  render();
  say('Preparing the three versions…');
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
    let rendered: Rendered | null = null;
    const p = RATIOS[randomInt(RATIOS.length)]!;
    const n = trialCount + 1;
    const t0 = performance.now();
    try {
      if (pcm.length !== frames) {
        say('The recording came back incomplete: try again.');
        log(`take ${id} (${why}): wrong length (${pcm.length} of ${frames}); discarded`);
        return;
      }
      rendered = await renderTrial(pcm, sr, p);
    } finally {
      pcm.fill(0); // plan Q2: the clip is discarded once rendered, even if rendering throws
    }
    const ms = performance.now() - t0;
    if (gen !== generation) {
      for (const a of ALGORITHMS) zeroBuffer(rendered?.buffers[a] ?? null);
      return;
    }
    if (rendered === null) {
      say('Nothing audible was recorded: try again, closer to the phone.');
      log(`take ${id} (${why}): ${fmt(frames / sr, 2)} s, a silent candidate; discarded`);
      return;
    }
    trialCount = n;
    const t: Trial = {
      n,
      p,
      order: shuffled(ALGORITHMS),
      buffers: rendered.buffers,
      trimDb: rendered.trimDb,
      detail: rendered.detail,
      played: false,
    };
    trial = t;
    // The log stays blind until the vote: no p, no order, no per-candidate numbers yet.
    log(
      `trial ${n} (${why}): captured ${frames} frames (${fmt(frames / sr, 2)} s), rendered in ${fmt(ms, 0)} ms; ` +
        'clip zeroed',
    );
    playSequence(t);
  } finally {
    if (gen === generation) busy = false;
    render();
  }
}

// ---- vote ---------------------------------------------------------------------------------------------------

function vote(k: number | 'same'): void {
  const t = trial;
  if (t === null || !t.played) return;
  const choiceAlgorithm: Choice = k === 'same' ? 'same' : t.order[k]!;
  const v: Vote = {
    trial: t.n,
    listener: listenerLabel(),
    route: route(),
    p: t.p,
    order: t.order,
    choiceAlgorithm,
  };
  votes.push(v);
  releaseTrial();
  renderTally();
  render();
  say(`Vote recorded (trial ${t.n}). Hold Record for the next trial.`);
  log(
    `vote ${votes.length}: trial ${v.trial}, listener "${v.listener}", route ${v.route}, p ${v.p}, order ` +
      `${v.order.map((a, i) => `X${i + 1}=${a}`).join(' ')}, choice ${k === 'same' ? 'same' : `X${k + 1}`} → ` +
      `${choiceAlgorithm}; ${t.detail}; buffers released`,
  );
}

// ---- wiring -------------------------------------------------------------------------------------------------

function guard(what: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    log(`${what}: ${String(err)}`);
  }
}

/** The pointer holding Record, or null. */
let holdPointer: number | null = null;

recordButton.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary || e.button !== 0) return;
  holdPointer = e.pointerId;
  guard('record', startRecording);
});
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
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);
// A finger that drifts during the hold must not scroll the page, open a menu or select text.
recordButton.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
recordButton.addEventListener('contextmenu', (e) => e.preventDefault());
recordButton.addEventListener('selectstart', (e) => e.preventDefault());

openButton.addEventListener('click', () => {
  openMic().catch((err: unknown) => log(`open: ${String(err)}`));
});
closeButton.addEventListener('click', () => close('close'));
replayButton.addEventListener('click', () => {
  const t = trial;
  if (t !== null) guard('replay', () => playSequence(t));
});
voteButtons.forEach((b, k) => b.addEventListener('click', () => guard('vote', () => vote(k))));
sameButton.addEventListener('click', () => guard('vote', () => vote('same')));
copyButton.addEventListener('click', () => {
  const text = resultsJson();
  // Through a promise, so a missing clipboard API (not a secure context) is logged too, never thrown.
  Promise.resolve()
    .then(() => navigator.clipboard.writeText(text))
    .then(
      () => log(`results copied (${votes.length} votes, ${text.length} characters)`),
      (err: unknown) => log(`copy failed: ${String(err)}`),
    );
});
window.addEventListener('pagehide', () => close('pagehide', false));
// A hidden page ends a hold unseen and must not keep playing: discard the hold, stop playback.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  guard('hidden', () => {
    if (recording !== null) {
      discardRecording();
      say('Page hidden: record again.');
    }
    if (sources.size > 0) {
      stopPlayback();
      if (trial !== null) say(`Trial ${trial.n}: playback stopped (page hidden). Replay to hear it.`);
    }
    render();
  });
});

render();
renderTally();
log(`lab/voices ready: ${navigator.userAgent}`);
if (!window.isSecureContext) {
  log('not a secure context: the mic needs https or http://localhost (docs/lab.md: adb reverse)');
}
