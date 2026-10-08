// Lab page for the M2 live end-to-end VAD check on D1 (plan §7 M2 "Live end-to-end check without storing audio"
// and its exit criteria; issue #57): the production app, booted by src/main.ts's `boot` with the debug overlay,
// above a tally panel. It covers what feature traces can't: the whole loop on the device, the LSTM reset at every
// re-arm and the pre-gate warm-up. Dev-only: `pnpm dev`, then /lab/vad-live.html (docs/lab.md).
//
// Privacy (plan Q2): aggregate counts only. The tally is 3 × 10 integers in this page's memory (plus the last mark,
// for Undo). The transition listener reads the two state names, the `ctxRunning` sample rate, and the seg event's
// epoch, kind, reason and onset frame; the level listener reads each `level` event's epoch and frame, never its dB.
// No audio, no wall-clock times and no per-phrase record are kept. For the jump rule below the page holds two ctx
// frame indices (the previous level's and the latest jump's), the sample rate, the previous level's epoch and the
// current take's epoch, in memory only, never shown or exported. Nothing is stored in the browser or sent anywhere;
// Copy summary puts the counts on the clipboard, and reloading the page resets them. The app keeps each take in
// memory only until its replay ends.
//
// The debug overlay turns the worker's feature trace on while it is mounted, and the trace suspends the Silero
// pre-gate's skipping: Silero runs on every frame (src/workers/vad-core.ts). The status line and the summary
// report the overlay as it actually is (boot's `onDebugOverlay`: mounted, or failed to load or mount), not as the
// URL asked for it. `?debug=0` boots the app without the overlay, to measure the pre-gate once it is enabled
// (PREGATE_ENABLED).
//
// One arming rule (D15, D16) keeps every count true to the labels: the page tallies only while `tallying()`, i.e. the
// app has booted (`app` 'ok': `boot` resolved, the whole pipeline wired) and the overlay is settled (off, on or
// failed, never loading). A listen is clean if the session's `arm` effect for it (the worker's `reset`) came while
// `tallying()` held: `setTrace(true)` is posted before the overlay reports, and the worker handles its messages in
// order, so a clean listen, its LSTM and pre-gate warm-up included, runs under the final trace setting. A take is
// armed at its Listening → Recording only in a clean listen; its later transitions count only while it is armed,
// into the condition selected when it started; it is disarmed when it ends. So a phrase whose listen began before
// the tally was live is never counted, even in part. The marks open at the first clean listen and close while an
// unarmed take is the latest phrase. A failed boot is terminal: nothing is tallied, the status line says so, and the
// summary carries `app: "failed"`.
//
// Capture jumps (#268): when the audio thread stalls for over 0.5 s, the capture worklet re-anchors its VAD feed and
// the segment in progress ends at the gap as an `end` or a `misfire` (#244), which the tally can't tell from a normal
// end. So the page applies the e2e helpers' rule (e2e/helpers/app.ts `findCaptureJump`) to the session's level
// stream: two consecutive `level` events of one epoch more than one level interval plus Math.round(sampleRate / 2)
// ctx frames apart are a capture jump. While `tallying()`, each one is counted per condition (`captureJumps`). A take
// that straddles one is excluded like an unarmed take (D16): its auto counts are taken back (it counts neither as
// `recordings` nor as `completed`), it is disarmed, and the marks close until the next armed onset. A take straddles
// a jump of its epoch if the jump comes while it is open (from its onset until the first level of its epoch after its
// segment ended: the worker posts a gap end just before the first level after the gap), or if its pre-roll reaches
// back over the latest jump on the ctx timeline, in any epoch (onset − PREROLL_MS before the first level after the
// jump). The latter is also the rest of a phrase cut as a misfire: the misfire re-arms at once, and the phrase goes on
// as a new take in the new epoch. Only a jump seen while `tallying()` is remembered for this. A new AudioContext
// (`ctxRunning`) restarts the frame count and forgets the jump, and so does an input reselection (the `reselectInput`
// effect): a stall around a device switch belongs to the old input, not to the new input's first phrase.
//
// Layout: all of the app's layers are position: fixed, so the app root gets a height and `contain: strict`, which
// makes it their containing block, and the tally panel follows it. The rules come from a constructed stylesheet
// that this module adopts: no style attribute, no <style>, no new CSS file. The same sheet restores lab.css's
// centred body, which src/ui/styles.css (imported by main.ts) overrides.

import type { SessionEvent, StateName } from '../src/app/events.ts';
import { ENERGY_HOP, PREGATE_ENABLED, PREROLL_MS, VAD_RATE } from '../src/audio/constants.ts';
import { boot } from '../src/main.ts';
import { LEVEL_EVERY_HOPS } from '../src/workers/vad-core.ts';
import { el } from './common.ts';

/** The app's height: this share of the small viewport (Chrome's toolbars shown), the tally panel below it. */
const APP_HEIGHT = '60svh';

const CONDITIONS = ['quiet', 'fan', 'tv'] as const;
type Condition = (typeof CONDITIONS)[number];
/** The manual marks, one button each. */
const MARKS = ['hit', 'miss', 'split', 'falseTrigger', 'truncated'] as const;
type Mark = (typeof MARKS)[number];
/** The counters taken from the session's transitions. */
const AUTOS = ['recordings', 'completed', 'misfires', 'maxLength'] as const;
type Auto = (typeof AUTOS)[number];
/** The capture jumps counted from the session's level stream (#268). */
type Counter = Mark | Auto | 'captureJumps';
type Counts = Record<Counter, number>;
type OverlayState = 'off' | 'loading' | 'on' | 'failed';
type AppState = 'booting' | 'ok' | 'failed';
/** A table row: a counter, or `phrases` (derived: hits + misses + splits). */
type Row = 'phrases' | Counter;
const ROWS: readonly Row[] = ['phrases', ...MARKS, ...AUTOS, 'captureJumps'];

const MARK_LABELS: Readonly<Record<Mark, string>> = {
  hit: 'Hit',
  miss: 'Miss',
  split: 'Split',
  falseTrigger: 'False trigger',
  truncated: 'Truncated',
};
/** The table's row headers; the help text below the panel says what each auto counter counts. */
const ROW_LABELS: Readonly<Record<Row, string>> = {
  phrases: 'phrases spoken',
  ...MARK_LABELS,
  recordings: 'recordings',
  completed: 'completed',
  misfires: 'misfires',
  maxLength: 'maxLength ends',
  captureJumps: 'capture jumps',
};

/**
 * The auto counter a session step bumps, or null: a recording starts (Listening → Recording, row 13), a take is
 * replayed (Processing → Playing), a segment ends as a misfire (Recording → Listening on `seg` misfire, row 21:
 * not the mute of row 22), or a segment ends at the length cap (Recording → Processing on `seg` end, maxLength).
 */
function autoCounter(from: StateName, to: StateName, e: SessionEvent): Auto | null {
  if (from === 'Listening' && to === 'Recording') return 'recordings';
  if (from === 'Processing' && to === 'Playing') return 'completed';
  if (from !== 'Recording' || e.t !== 'seg') return null;
  if (to === 'Listening' && e.ev.kind === 'misfire') return 'misfires';
  if (to === 'Processing' && e.ev.kind === 'end' && e.ev.reason === 'maxLength') return 'maxLength';
  return null;
}

function zero(): Counts {
  return {
    hit: 0,
    miss: 0,
    split: 0,
    falseTrigger: 0,
    truncated: 0,
    recordings: 0,
    completed: 0,
    misfires: 0,
    maxLength: 0,
    captureJumps: 0,
  };
}

/** A condition's counts with `phrases` first: the table's rows and the summary's fields, in order. */
function rowsOf(c: Counts): Record<Row, number> {
  return { phrases: c.hit + c.miss + c.split, ...c };
}

// ---- state: integers only ----------------------------------------------------------------------------------------

const counts: Record<Condition, Counts> = { quiet: zero(), fan: zero(), tv: zero() };
let condition: Condition = 'quiet';
/** The last manual mark, which Undo takes back (once). */
let lastMark: { condition: Condition; mark: Mark } | null = null;
/** `?debug=0` boots the app without the debug overlay (and so without the feature trace). */
const debug = new URLSearchParams(location.search).get('debug') !== '0';
/**
 * The debug overlay as it actually is: off (`?debug=0`), loading, on (mounted: the feature trace is on), or failed
 * (it didn't load or mount: the trace is off). Set by boot's `onDebugOverlay`; it stays loading if the app never
 * gets that far.
 */
let overlay: OverlayState = debug ? 'loading' : 'off';
/** The app: booting until `boot` resolves (session, engine and UI all wired), then ok; failed (terminal) if it rejects. */
let app: AppState = 'booting';
/** Why the boot failed, for the status line. */
let bootError = '';
/** The current listen is clean: the session's `arm` effect for it came while `tallying()` held (D16). */
let cleanArm = false;
/** A clean listen has been seen: the marks can open. */
let cleanEpochSeen = false;
/** The current take is tallied: it started (Listening → Recording) in a clean listen, and it hasn't ended yet. */
let takeArmed = false;
/** The latest take was not armed: neither it nor a mark for it is counted until the next armed take starts. */
let marksBlocked = false;
/** The condition selected when the current take started: all of its counts go there. */
let takeCondition: Condition = 'quiet';
/**
 * The states that end a take (a misfire ends in Listening, after it is counted). Recording → Cooldown (rows 45/46)
 * and Recording → Waking (row 40) end one too; most of this set is defensive, since every counted transition follows
 * its own Listening → Recording.
 */
const TAKE_ENDS: ReadonlySet<StateName> = new Set<StateName>(['Listening', 'Asleep', 'Paused', 'Error']);

/** The latest `ctxRunning`'s sample rate: the level frames' rate (null until the context first runs). */
let sampleRate: number | null = null;
/** The previous `level` event's epoch (null before the first) and ctx frame: the jump rule compares the two. */
let levelEpoch: number | null = null;
let levelFrame = 0;
/**
 * The ctx frame of the first level after the latest capture jump seen while tallying (null: none since the context
 * last started running or the input was last reselected).
 */
let jumpFrame: number | null = null;
/** The latest armed take can still be excluded by a capture jump (#268): see the header. */
let takeOpen = false;
/** The epoch of the latest take's onset (null if the onset carried none). */
let takeEpoch: number | null = null;
/** The latest take's segment has ended (it left Recording). */
let segEnded = false;
/** The auto counts the latest armed take has added to counts[takeCondition], which an exclusion takes back. */
const takeAdded: Record<Auto, number> = { recordings: 0, completed: 0, misfires: 0, maxLength: 0 };
/** The latest phrase was excluded by a capture jump, not by D16: the status line says which. */
let jumpExcluded = false;

/** D15: marks and new takes are tallied only once the app has booted and the overlay's trace state is settled. */
function tallying(): boolean {
  return app === 'ok' && overlay !== 'loading';
}

/** D16: the marks are open once a clean listen has been seen, and not while an unarmed take is the latest phrase. */
function marksOpen(): boolean {
  return tallying() && cleanEpochSeen && !marksBlocked;
}

/** The pre-gate as this run has it: off in the build, on, or on but suspended by the overlay's feature trace. */
function pregate(): 'off' | 'on' | 'suspended' {
  if (!PREGATE_ENABLED) return 'off';
  return overlay === 'on' ? 'suspended' : 'on';
}

/** The status line: the app's boot first, then what the overlay and the feature trace are doing to the pre-gate. */
function statusText(): string {
  if (app === 'failed')
    return `The app failed to boot (${bootError}): nothing is tallied. Reload to try again.`;
  if (app === 'booting') return 'Starting the app: nothing is tallied until it is up.';
  const built = `Pre-gate in this build: ${PREGATE_ENABLED ? 'on' : 'off'}.`;
  const text: Readonly<Record<OverlayState, string>> = {
    on: `Debug overlay on: the worker's feature trace is on, so the Silero pre-gate never skips (Silero runs on every frame). ${built} Open ?debug=0 to run without the overlay.`,
    loading: `Debug overlay loading: nothing is tallied until it is up (the feature trace is still off), not even a phrase that ends after. ${built}`,
    failed: `The debug overlay failed to load or mount (see the console): the feature trace is off and the pre-gate runs as built. ${built} Reload to try again.`,
    off: `Debug overlay off (?debug=0): no feature trace, so the pre-gate runs as built. ${built}`,
  };
  if (overlay === 'loading') return text.loading;
  if (marksBlocked && jumpExcluded) {
    return `${text[overlay]} A capture jump (the audio stalled for over 0.5 s) cut into the latest phrase: it isn't counted or marked. The marks reopen when the bear hears the next phrase.`;
  }
  if (marksBlocked) {
    return `${text[overlay]} A phrase was in flight when the tally started: it isn't counted or marked. Counting starts with the next listen.`;
  }
  return cleanEpochSeen ? text[overlay] : `${text[overlay]} Counting starts when the bear next listens.`;
}

/** The Copy summary JSON: the counts per condition and how the run was set up; no times, no per-phrase data. */
function summary(): string {
  const perCondition: Record<Condition, Record<Row, number>> = {
    quiet: rowsOf(counts.quiet),
    fan: rowsOf(counts.fan),
    tv: rowsOf(counts.tv),
  };
  return JSON.stringify(
    {
      page: 'lab/vad-live',
      app,
      overlay,
      pregate: pregate(),
      userAgent: navigator.userAgent,
      counts: perCondition,
    },
    null,
    2,
  );
}

// ---- DOM ---------------------------------------------------------------------------------------------------------

const appRoot = document.querySelector<HTMLElement>('#vad-live-app');
const panel = document.querySelector<HTMLElement>('#tally');
if (appRoot === null || panel === null) throw new Error('vad-live: #vad-live-app or #tally is missing');
const layout = new CSSStyleSheet();
layout.replaceSync(`#vad-live-app { height: ${APP_HEIGHT}; contain: strict; } body { margin: 0 auto; }`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, layout];

const statusLine = el('p', {});

const conditionBox = el('fieldset', {}, el('legend', {}, 'Condition'));
for (const c of CONDITIONS) {
  const input = el('input', { type: 'radio', name: 'condition', value: c });
  input.checked = c === condition;
  input.addEventListener('change', () => {
    if (!input.checked) return;
    condition = c;
    render();
  });
  conditionBox.append(el('label', {}, input, ` ${c} `));
}

const lastLine = el('p', {}, 'No mark yet.');
const undo = el('button', { type: 'button' }, 'Undo last mark');
const markRow = el('p', {});
const markButtons: HTMLButtonElement[] = [];
for (const m of MARKS) {
  const b = el('button', { type: 'button' }, MARK_LABELS[m]);
  markButtons.push(b);
  b.addEventListener('click', () => {
    if (!marksOpen()) return;
    counts[condition][m]++;
    lastMark = { condition, mark: m };
    lastLine.textContent = `Marked ${MARK_LABELS[m]} (${condition}).`;
    render();
  });
  markRow.append(b);
}
undo.addEventListener('click', () => {
  if (lastMark === null || !marksOpen()) return;
  const { condition: c, mark: m } = lastMark;
  counts[c][m]--;
  lastMark = null;
  lastLine.textContent = `Undid ${MARK_LABELS[m]} (${c}).`;
  render();
});
markRow.append(undo);

const headCells = CONDITIONS.map((c) => el('th', { scope: 'col' }, c));
const cells = new Map<string, HTMLTableCellElement>();
const body = el('tbody', {});
for (const r of ROWS) {
  const tr = el('tr', {}, el('th', { scope: 'row' }, ROW_LABELS[r]));
  for (const c of CONDITIONS) {
    const td = el('td', { id: `count-${c}-${r}` }, '0');
    cells.set(`${c}/${r}`, td);
    tr.append(td);
  }
  body.append(tr);
}
const table = el(
  'table',
  {},
  el('caption', {}, 'Counts per condition (* the condition being tallied)'),
  el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'count'), ...headCells)),
  body,
);

const copy = el('button', { type: 'button' }, 'Copy summary');
const copyLine = el('span', {});
const json = el('pre', { class: 'lab-log' });
copy.addEventListener('click', () => {
  const text = summary();
  // Through a promise, so a missing clipboard API (not a secure context) is reported, never thrown.
  Promise.resolve()
    .then(() => navigator.clipboard.writeText(text))
    .then(
      () => {
        copyLine.textContent = ` Copied (${text.length} characters).`;
      },
      (err: unknown) => {
        copyLine.textContent = ` Copy failed (${String(err)}): select the JSON below and copy it by hand.`;
      },
    );
});

panel.append(statusLine, conditionBox, markRow, lastLine, table, el('p', {}, copy, copyLine), json);

function render(): void {
  statusLine.textContent = statusText();
  CONDITIONS.forEach((c, i) => {
    const th = headCells[i];
    if (th !== undefined) th.textContent = c === condition ? `${c} *` : c;
    const values = rowsOf(counts[c]);
    for (const r of ROWS) {
      const td = cells.get(`${c}/${r}`);
      if (td !== undefined) td.textContent = String(values[r]);
    }
  });
  undo.disabled = lastMark === null || !marksOpen();
  for (const b of markButtons) b.disabled = !marksOpen();
  json.textContent = summary();
}
render();

// ---- capture jumps (#268) ------------------------------------------------------------------------------------------

/**
 * The jump rule, as the e2e helpers have it (e2e/helpers/app.ts `findCaptureJump`): consecutive level frames of one
 * epoch more than one level interval plus Math.round(sr / 2) apart. The worker tags each `level` with its 10 ms hop's
 * first ctx frame, one every LEVEL_EVERY_HOPS-th hop (1440 frames at 48 kHz, ±1). The capture worklet zero-feeds a
 * gap of up to Math.round(sr / 2) frames, so the levels stay contiguous; a longer gap re-anchors the feed (#244) and
 * steps them by more than the gap.
 */
function isCaptureJump(prevFrame: number, frame: number, sr: number): boolean {
  return frame - prevFrame > (LEVEL_EVERY_HOPS * ENERGY_HOP * sr) / VAD_RATE + Math.round(sr / 2);
}

/** Excludes the latest armed take, like an unarmed one (D16): its auto counts are taken back, and the marks close. */
function excludeTake(): void {
  for (const k of AUTOS) {
    counts[takeCondition][k] -= takeAdded[k];
    takeAdded[k] = 0;
  }
  takeArmed = false;
  takeOpen = false;
  marksBlocked = true;
  jumpExcluded = true;
}

/** A `level` event: the jump rule against the previous one. Only frames and epochs are read. */
function onLevel(epoch: number, frame: number): void {
  const jump = sampleRate !== null && levelEpoch === epoch && isCaptureJump(levelFrame, frame, sampleRate);
  levelEpoch = epoch;
  levelFrame = frame;
  const ofTake = takeOpen && epoch === takeEpoch;
  if (!jump) {
    if (ofTake && segEnded) takeOpen = false; // its segment ended before any gap: it no longer straddles one
    return;
  }
  if (!tallying()) return;
  jumpFrame = frame;
  const c = ofTake ? takeCondition : condition;
  if (ofTake) excludeTake();
  counts[c].captureJumps++;
  render();
}

/**
 * The onset of a take at ctx `frame`: does its pre-roll reach back over the latest capture jump? Any epoch: the rest
 * of a phrase cut as a misfire starts a take in the new epoch, just after the jump.
 */
function preRollStraddlesJump(frame: number): boolean {
  if (sampleRate === null || jumpFrame === null) return false;
  return frame - Math.round((PREROLL_MS * sampleRate) / 1000) < jumpFrame;
}

// ---- the app -----------------------------------------------------------------------------------------------------

boot(appRoot, {
  debug,
  onSession: (s) => {
    s.addTransitionListener((from, to, e, effects) => {
      let changed = false;
      if (e.t === 'ctxRunning') {
        sampleRate = e.sampleRate;
        jumpFrame = null; // a new context restarts the frame count
      }
      if (from === 'Listening' && to === 'Recording') {
        const clean = cleanArm && tallying();
        const straddles = e.t === 'seg' && preRollStraddlesJump(e.ev.frame);
        takeArmed = clean && !straddles;
        takeCondition = condition;
        marksBlocked = !takeArmed;
        jumpExcluded = clean && straddles;
        takeOpen = takeArmed;
        takeEpoch = e.t === 'seg' ? e.epoch : null;
        segEnded = false;
        for (const a of AUTOS) takeAdded[a] = 0;
        changed = true;
      }
      const k = autoCounter(from, to, e);
      if (k !== null && takeArmed) {
        counts[takeCondition][k]++;
        takeAdded[k]++;
        changed = true;
      }
      if (from === 'Recording' && to !== 'Recording') segEnded = true;
      if (TAKE_ENDS.has(to)) takeArmed = false;
      // The `arm` effect (the worker's `reset`) starts a listen; a Listening → Listening stay has none.
      for (const fx of effects) {
        if (fx.k === 'reselectInput') jumpFrame = null; // a new input: an earlier stall can't reach its phrases
        if (fx.k !== 'arm') continue;
        cleanArm = tallying();
        if (cleanArm && !cleanEpochSeen) {
          cleanEpochSeen = true;
          changed = true;
        }
      }
      if (changed) render();
    });
    s.subscribeLevel((e) => {
      if (e.t === 'level') onLevel(e.epoch, e.frame);
    });
  },
  onDebugOverlay: (mounted) => {
    overlay = mounted ? 'on' : 'failed';
    render();
  },
}).then(
  () => {
    app = 'ok';
    render();
  },
  (err: unknown) => {
    app = 'failed';
    bootError = String(err);
    takeArmed = false;
    render();
    console.error('vad-live: boot failed', err);
  },
);
