// Lab page for X-V2 (plan §5) and the worklet DSP budget (plan §4.10): the Silero TS port's per-frame cost,
// with onnxruntime-web for comparison, and the capture worklet's DSP cost per 128-frame quantum, each timed in
// a Worker (lab/bench.worker.ts, one fresh worker per run). Dev-only: `pnpm dev`, then /lab/bench.html
// (docs/lab.md). The input is synthetic; nothing is captured, stored or exported (plan Q2), and the log is
// text only.

import type { BenchName, BenchReply, BenchRequest, FrameStats, QuantumStats } from './bench.worker.ts';
import benchWorkerUrl from './bench.worker.ts?worker&url';
import { el, fmt, logPanel } from './common.ts';

/** The X-V2 gate (plan §5, §4.10): silero-ts p95 ≤ 8 ms per 32 ms frame. */
const X_V2_GATE_MS = 8;
/** The worklet DSP budget (plan §4.10): p99 ≤ 50 µs per quantum; shown for reference, not a gate here. */
const WORKLET_BUDGET_US = 50;
/** The long run, after which the thermal state is captured. */
const LONG_SECONDS = 600;
const BENCHES: readonly BenchName[] = ['silero-ts', 'silero-ort', 'worklet-dsp'];
const THERMAL_CMD = 'adb shell dumpsys thermalservice';

type Outcome =
  | { readonly kind: 'result'; readonly stats: FrameStats | QuantumStats }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

// ---- page ---------------------------------------------------------------------------------------------------

const root = document.getElementById('lab');
if (!(root instanceof HTMLElement)) throw new Error('lab/bench: missing #lab');

const durationSelect = el(
  'select',
  {},
  el('option', { value: '60', selected: '' }, '60 s'),
  el('option', { value: String(LONG_SECONDS) }, '10 min'),
);
const rateSelect = el(
  'select',
  {},
  el('option', { value: '48000', selected: '' }, '48 000 Hz'),
  el('option', { value: '44100' }, '44 100 Hz'),
);
const realtimeBox = el('input', { type: 'checkbox' });
const benchButtons = BENCHES.map((bench) => ({ bench, button: el('button', { type: 'button' }, bench) }));
const runAllButton = el('button', { type: 'button' }, 'Run all');
const controls: readonly (HTMLButtonElement | HTMLInputElement | HTMLSelectElement)[] = [
  durationSelect,
  rateSelect,
  realtimeBox,
  runAllButton,
  ...benchButtons.map((b) => b.button),
];
const status = el('p', { 'aria-live': 'polite' }, 'Idle.');
const results = el('tbody');
const gateLine = el(
  'h2',
  { 'aria-live': 'polite' },
  `X-V2 gate (silero-ts p95 ≤ ${X_V2_GATE_MS} ms): not run yet`,
);

root.append(
  el(
    'fieldset',
    {},
    el('legend', {}, 'Settings'),
    el('p', {}, el('label', {}, 'Input: ', durationSelect), ' of synthetic audio per benchmark'),
    el('p', {}, el('label', {}, 'worklet-dsp rate: ', rateSelect)),
    el(
      'p',
      {},
      el(
        'label',
        {},
        realtimeBox,
        ' Real time: one frame per 32 ms (worklet-dsp: one batch per 100 quanta) instead of back to back',
      ),
    ),
  ),
  el('div', { class: 'lab-buttons' }, ...benchButtons.map((b) => b.button), runAllButton),
  status,
  el('h2', {}, 'Results'),
  el(
    'table',
    {},
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        ...['Benchmark', 'Input', 'Count', 'p50', 'p95', 'p99', 'max', `> ${X_V2_GATE_MS} ms`, 'Wall'].map(
          (h) => el('th', {}, h),
        ),
      ),
    ),
    results,
  ),
  gateLine,
);
const log = logPanel(root);

log(`userAgent: ${navigator.userAgent}`);
log(`hardwareConcurrency: ${navigator.hardwareConcurrency}`);

// The worker imports onnxruntime-web/wasm, but Vite's dependency scan doesn't follow `?worker&url` imports: on
// its own, the first silero-ort run would make Vite optimize the package then, and reload this page mid-run
// whenever other dependencies were already optimized. Importing it here (for its version) puts it in the scan.
import('onnxruntime-web/wasm').then(
  (ort) => log(`onnxruntime-web: ${ort.env.versions.web ?? '?'}`),
  (err: unknown) => log(`onnxruntime-web: not loadable here: ${String(err)}`),
);

// ---- runs ---------------------------------------------------------------------------------------------------

function readRequest(bench: BenchName): BenchRequest {
  return {
    bench,
    seconds: Number(durationSelect.value),
    rate: Number(rateSelect.value),
    realtime: realtimeBox.checked,
    overMs: X_V2_GATE_MS,
  };
}

function describeInput(req: BenchRequest): string {
  const duration = req.seconds === LONG_SECONDS ? '10 min' : `${req.seconds} s`;
  const rate = req.bench === 'worklet-dsp' ? req.rate : 16000;
  return `${duration} at ${rate} Hz, ${req.realtime ? 'real time' : 'back to back'}`;
}

/** Runs one benchmark in a fresh worker and resolves with its outcome; the worker is terminated after. */
function runInWorker(req: BenchRequest): Promise<Outcome> {
  return new Promise((resolve) => {
    const worker = new Worker(benchWorkerUrl, { type: 'module', name: `lab-bench-${req.bench}` });
    let settled = false;
    const finish = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve(outcome);
    };
    worker.addEventListener('message', (e: MessageEvent<BenchReply>) => {
      const msg = e.data;
      switch (msg.t) {
        case 'info':
          log(`${req.bench}: ${msg.line}`);
          break;
        case 'progress':
          status.textContent = `${req.bench}: ${msg.done} / ${msg.total}`;
          log(`${req.bench}: ${msg.done} / ${msg.total}`);
          break;
        case 'result':
          finish({ kind: 'result', stats: msg.stats });
          break;
        case 'unavailable':
          finish({ kind: 'unavailable', message: msg.message });
          break;
        case 'error':
          finish({ kind: 'error', message: msg.message });
          break;
      }
    });
    worker.addEventListener('error', (e: ErrorEvent) => {
      e.preventDefault();
      finish({ kind: 'error', message: e.message === '' ? 'the worker failed to load' : e.message });
    });
    worker.postMessage(req, []); // the second argument is the (empty) transfer list
  });
}

function ms(v: number): string {
  return `${fmt(v, 3)} ms`;
}

function us(v: number): string {
  return `${fmt(v, 2)} µs`;
}

function addRow(cells: readonly string[]): void {
  results.append(el('tr', {}, ...cells.map((c) => el('td', {}, c))));
}

function updateGate(req: BenchRequest, outcome: Outcome): void {
  const head = `X-V2 gate (silero-ts p95 ≤ ${X_V2_GATE_MS} ms):`;
  let line: string;
  if (outcome.kind === 'result' && outcome.stats.kind === 'frame') {
    const verdict = outcome.stats.p95Ms <= X_V2_GATE_MS ? 'PASS' : 'FAIL';
    line = `${head} ${verdict}, p95 ${ms(outcome.stats.p95Ms)} (${describeInput(req)})`;
  } else {
    line = `${head} no result, silero-ts did not finish: ${outcome.kind === 'result' ? 'no frame stats' : outcome.message}`;
  }
  gateLine.textContent = line;
  log(line);
}

/** Puts one outcome in the results table and the log; a silero-ts outcome also sets the gate line. */
function report(req: BenchRequest, outcome: Outcome): void {
  const input = describeInput(req);
  if (outcome.kind === 'unavailable') {
    const text = `ORT unavailable: ${outcome.message}`;
    results.append(
      el('tr', {}, el('td', {}, req.bench), el('td', {}, input), el('td', { colspan: '7' }, text)),
    );
    log(`${req.bench}: ${text}`);
  } else if (outcome.kind === 'error') {
    const text = `error: ${outcome.message}`;
    results.append(
      el('tr', {}, el('td', {}, req.bench), el('td', {}, input), el('td', { colspan: '7' }, text)),
    );
    log(`${req.bench}: ${text}`);
  } else if (outcome.stats.kind === 'frame') {
    const s = outcome.stats;
    const wall = `${fmt(s.wallS, 1)} s`;
    addRow([
      req.bench,
      input,
      String(s.count),
      ms(s.p50Ms),
      ms(s.p95Ms),
      ms(s.p99Ms),
      ms(s.maxMs),
      `${fmt(s.overPct, 1)} %`,
      wall,
    ]);
    log(
      `${req.bench}: ${s.count} frames (${input}): p50 ${ms(s.p50Ms)}, p95 ${ms(s.p95Ms)}, p99 ${ms(s.p99Ms)}, ` +
        `max ${ms(s.maxMs)} (first frame ${ms(s.firstMs)}), over ${X_V2_GATE_MS} ms ${fmt(s.overPct, 1)} %, ` +
        `wall ${wall}, mean p ${fmt(s.meanP, 3)}`,
    );
  } else {
    const s = outcome.stats;
    const wall = `${fmt(s.wallS, 1)} s`;
    addRow([
      req.bench,
      input,
      `${s.batches} batches × ${s.quantaPerBatch} quanta (batch means; armed path: frames posted with transfer)`,
      us(s.p50Us),
      '—',
      us(s.p99Us),
      us(s.maxUs),
      '—',
      wall,
    ]);
    log(
      `${req.bench} (armed path: frames posted with transfer): µs per quantum (mean of each ` +
        `${s.quantaPerBatch}-quantum batch) over ${s.batches} batches ` +
        `(${input}): p50 ${us(s.p50Us)}, p99 ${us(s.p99Us)}, max ${us(s.maxUs)} (first batch ${us(s.firstUs)}), ` +
        `wall ${wall} (plan §4.10 budget: p99 ≤ ${WORKLET_BUDGET_US} µs)`,
    );
  }
  if (req.bench === 'silero-ts') updateGate(req, outcome);
}

async function runBench(bench: BenchName): Promise<void> {
  const req = readRequest(bench);
  log(`${bench}: start (${describeInput(req)})`);
  status.textContent = `${bench}: starting`;
  report(req, await runInWorker(req));
}

/**
 * Runs `benches` in order with the controls disabled. Around a real-time 10-min run (10 min of wall time: the
 * thermal soak) it logs the thermal reminders; a back-to-back 10-min run ends far sooner, so it says it isn't one.
 */
async function runSeries(label: string, benches: readonly BenchName[]): Promise<void> {
  for (const c of controls) c.disabled = true;
  const long = Number(durationSelect.value) === LONG_SECONDS;
  const soak = long && realtimeBox.checked;
  try {
    if (soak) log(`10-min run: capture \`${THERMAL_CMD}\` now, before it starts`);
    else if (long)
      log('10-min back-to-back run: not a thermal soak (check "Real time" for the 10-min thermal test)');
    log(`${label}: start`);
    for (const bench of benches) await runBench(bench);
    // The verdict again, so a copied log ends with it.
    if (benches.includes('silero-ts')) log(gateLine.textContent);
    log(`${label}: done`);
    if (soak) log(`10-min run finished: capture \`${THERMAL_CMD}\` now`);
    status.textContent = `${label}: done.`;
  } finally {
    for (const c of controls) c.disabled = false;
  }
}

function start(label: string, benches: readonly BenchName[]): void {
  runSeries(label, benches).catch((err: unknown) => {
    log(`${label}: failed: ${String(err)}`);
    status.textContent = `${label}: failed.`;
  });
}

for (const { bench, button } of benchButtons) button.addEventListener('click', () => start(bench, [bench]));
runAllButton.addEventListener('click', () => {
  start('run all', BENCHES);
});
