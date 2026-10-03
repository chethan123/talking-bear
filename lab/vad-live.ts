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
// pre-gate's skipping: Silero runs on every frame (src/workers/vad-core.ts). The status line says so, and
// `?debug=0` boots the app without the overlay, to measure the pre-gate once it is enabled (PREGATE_ENABLED).
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

/** The pre-gate as this run has it: off in the build, on, or on but suspended by the overlay's feature trace. */
function pregate(): 'off' | 'on' | 'suspended' {
  if (!PREGATE_ENABLED) return 'off';
  return debug ? 'suspended' : 'on';
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
      overlay: debug,
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

const statusLine = el(
  'p',
  {},
  debug
    ? `Debug overlay on: the worker's feature trace is on, so the Silero pre-gate never skips (Silero runs on every frame). Pre-gate in this build: ${PREGATE_ENABLED ? 'on' : 'off'}. Open ?debug=0 to run without the overlay.`
    : `Debug overlay off (?debug=0): no feature trace, so the pre-gate runs as built: ${PREGATE_ENABLED ? 'on' : 'off'}.`,
);
const bootLine = el('p', { hidden: '' });

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
for (const m of MARKS) {
  const b = el('button', { type: 'button' }, MARK_LABELS[m]);
  b.addEventListener('click', () => {
    counts[condition][m]++;
    lastMark = { condition, mark: m };
    lastLine.textContent = `Marked ${MARK_LABELS[m]} (${condition}).`;
    render();
  });
  markRow.append(b);
}
undo.addEventListener('click', () => {
  if (lastMark === null) return;
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

panel.append(statusLine, bootLine, conditionBox, markRow, lastLine, table, el('p', {}, copy, copyLine), json);

function render(): void {
  CONDITIONS.forEach((c, i) => {
    const th = headCells[i];
    if (th !== undefined) th.textContent = c === condition ? `${c} *` : c;
    const values = rowsOf(counts[c]);
    for (const r of ROWS) {
      const td = cells.get(`${c}/${r}`);
      if (td !== undefined) td.textContent = String(values[r]);
    }
  });
  undo.disabled = lastMark === null;
  json.textContent = summary();
}
render();

// ---- the app -----------------------------------------------------------------------------------------------------

boot(appRoot, {
  debug,
  onSession: (s) => {
    s.addTransitionListener((from, to, e) => {
      const k = autoCounter(from, to, e);
      if (k === null) return;
      counts[condition][k]++;
      render();
    });
  },
}).catch((err: unknown) => {
  bootLine.hidden = false;
  bootLine.textContent = `The app failed to boot: ${String(err)}`;
  console.error('vad-live: boot failed', err);
});
