// Lab page for the M2 live end-to-end VAD check on D1 (plan §7 M2 "Live end-to-end check without storing audio"
// and its exit criteria; issue #57): the production app, booted by src/main.ts's `boot` with the debug overlay,
// above a tally panel. It covers what feature traces can't: the whole loop on the device, the LSTM reset at every
// re-arm and the pre-gate warm-up. Dev-only: `pnpm dev`, then /lab/vad-live.html (docs/lab.md).
//
// Privacy (plan Q2): aggregate counts only. The tally is 3 × 9 integers in this page's memory (plus the last mark,
// for Undo). The transition listener reads the two state names and the seg event's kind and reason, nothing else:
// no audio, no levels, no frames, no times. Nothing is stored in the browser or sent anywhere; Copy summary puts
// the counts on the clipboard, and reloading the page resets them. The app keeps each take in memory only until
// its replay ends.
//
// The debug overlay turns the worker's feature trace on while it is mounted, and the trace suspends the Silero
// pre-gate's skipping: Silero runs on every frame (src/workers/vad-core.ts). The status line and the summary
// report the overlay as it actually is (boot's `onDebugOverlay`: mounted, or failed to load or mount), not as the
// URL asked for it. `?debug=0` boots the app without the overlay, to measure the pre-gate once it is enabled
// (PREGATE_ENABLED).
//
// One arming rule (D15) keeps every count true to the labels: the page tallies only while `tallying()`, i.e. the app
// has booted (`app` 'ok': `boot` resolved, the whole pipeline wired) and the overlay is settled (off, on or failed,
// never loading). A take is armed at its Listening → Recording if `tallying()` holds then, and its later transitions
// count only while it is armed; it is disarmed when the take ends (into Listening, Asleep, Paused or Error). So a
// phrase that started while the overlay was loading is never counted, even in part, and every count of a run shares
// one trace state. The marks are enabled only while `tallying()`. A failed boot is terminal: nothing is tallied, the
// status line says so, and the summary carries `app: "failed"`.
//
// Layout: all of the app's layers are position: fixed, so the app root gets a height and `contain: strict`, which
// makes it their containing block, and the tally panel follows it. The rules come from a constructed stylesheet
// that this module adopts: no style attribute, no <style>, no new CSS file. The same sheet restores lab.css's
// centred body, which src/ui/styles.css (imported by main.ts) overrides.

import type { SessionEvent, StateName } from '../src/app/events.ts';
import { PREGATE_ENABLED } from '../src/audio/constants.ts';
import { boot } from '../src/main.ts';
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
type Counter = Mark | Auto;
type Counts = Record<Counter, number>;
type OverlayState = 'off' | 'loading' | 'on' | 'failed';
type AppState = 'booting' | 'ok' | 'failed';
/** A table row: a counter, or `phrases` (derived: hits + misses + splits). */
type Row = 'phrases' | Counter;
const ROWS: readonly Row[] = ['phrases', ...MARKS, ...AUTOS];

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
/** The current take is tallied: `tallying()` held at its Listening → Recording, and it hasn't ended yet. */
let takeArmed = false;
/** The states that end a take (a misfire ends in Listening, after it is counted). */
const TAKE_ENDS: ReadonlySet<StateName> = new Set<StateName>(['Listening', 'Asleep', 'Paused', 'Error']);

/** D15: marks and new takes are tallied only once the app has booted and the overlay's trace state is settled. */
function tallying(): boolean {
  return app === 'ok' && overlay !== 'loading';
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
  return text[overlay];
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
    if (!tallying()) return;
    counts[condition][m]++;
    lastMark = { condition, mark: m };
    lastLine.textContent = `Marked ${MARK_LABELS[m]} (${condition}).`;
    render();
  });
  markRow.append(b);
}
undo.addEventListener('click', () => {
  if (lastMark === null || !tallying()) return;
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
  undo.disabled = lastMark === null || !tallying();
  for (const b of markButtons) b.disabled = !tallying();
  json.textContent = summary();
}
render();

// ---- the app -----------------------------------------------------------------------------------------------------

boot(appRoot, {
  debug,
  onSession: (s) => {
    s.addTransitionListener((from, to, e) => {
      if (from === 'Listening' && to === 'Recording') takeArmed = tallying();
      const k = autoCounter(from, to, e);
      if (k !== null && takeArmed) {
        counts[condition][k]++;
        render();
      }
      if (TAKE_ENDS.has(to)) takeArmed = false;
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
