// Lab page for X-V2 and X-F3 (plan §5) and the worklet DSP budget (plan §4.10): the Silero TS port's per-frame
// cost, with onnxruntime-web for comparison, the capture worklet's DSP cost per 128-frame quantum, and the voice
// chain's time on 1, 5 and 10 s clips with its per-stage breakdown, each timed in a Worker (lab/bench.worker.ts,
// one fresh worker per run). Dev-only: `pnpm dev`, then /lab/bench.html (docs/lab.md). The input is synthetic;
// nothing is captured, stored or exported (plan Q2), and the log is text only.

import type {
  BenchName,
  BenchReply,
  BenchRequest,
  FrameStats,
  QuantumStats,
  VoiceRow,
  VoiceStageName,
  VoiceStats,
} from './bench.worker.ts';
import benchWorkerUrl from './bench.worker.ts?worker&url';
import { el, fmt, logPanel } from './common.ts';

/** The X-V2 gate (plan §5, §4.10): silero-ts p95 ≤ 8 ms per 32 ms frame. */
const X_V2_GATE_MS = 8;
/** The worklet DSP budget (plan §4.10): p99 ≤ 50 µs per quantum; shown for reference, not a gate here. */
const WORKLET_BUDGET_US = 50;
/** The X-F3 gate (plan §4.10, §7 M3): voice-chain p95 ≤ 15 ms per second of audio, on every clip and preset. */
const VOICE_BUDGET_MS_PER_S = 15;
/** The long run, after which the thermal state is captured. */
const LONG_SECONDS = 600;
const BENCHES: readonly BenchName[] = ['silero-ts', 'silero-ort', 'worklet-dsp', 'voice-chain'];
/** The voiceStages functions (src/dsp/voice.ts) in chain order: the stage table's columns. */
const STAGE_KEYS: readonly VoiceStageName[] = [
  'clipDetect',
  'hpfTrim',
  'resample',
  'isVoiced',
  'applyGain',
  'fades',
  'envelope',
];
/** Labels of the voiceStages functions in the stage table and the log. */
const STAGE_LABELS: Readonly<Record<VoiceStageName, string>> = {
  clipDetect: 'clipDetect',
  hpfTrim: 'hpfTrim',
  resample: 'resample',
  isVoiced: 'isVoiced',
  applyGain: 'applyGain (loudness + ceiling)',
  fades: 'fades',
  envelope: 'envelope',
};
const THERMAL_CMD = 'adb shell dumpsys thermalservice';

type Outcome =
  | { readonly kind: 'result'; readonly stats: FrameStats | QuantumStats | VoiceStats }
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
const voiceResults = el('tbody');
const stageResults = el('tbody');
const voiceGateHead = `X-F3 gate (voice-chain p95 ≤ ${VOICE_BUDGET_MS_PER_S} ms per s of audio, every clip and preset):`;
const voiceGateLine = el('h2', { 'aria-live': 'polite' }, `${voiceGateHead} not run yet`);

function headRow(cells: readonly string[]): HTMLTableSectionElement {
  return el('thead', {}, el('tr', {}, ...cells.map((h) => el('th', {}, h))));
}

root.append(
  el(
    'p',
    {},
    'voice-chain (X-F3, plan §5): processVoice (src/dsp/voice.ts) on synthetic 1, 5 and 10 s clips (400 ms ' +
      'vowel bursts, each followed by 100 ms of pink noise: 20 % noise) at the context rate below, for the ' +
      'cub, chipmunk and bigbear presets: after an untimed pre-warm, one warm-up call, then 30 timed calls ' +
      'each, back to back (steady state; the pre-warm log line gives the cold first call). Each voiceStages ' +
      'function is then timed on its own input, as batch means. Gate: p95 ≤ ' +
      `${VOICE_BUDGET_MS_PER_S} ms per second of audio (plan §4.10) for every clip and preset. Not part of ` +
      'the 10-min thermal soak.',
  ),
  el(
    'fieldset',
    {},
    el('legend', {}, 'Settings'),
    el(
      'p',
      {},
      el('label', {}, 'Input: ', durationSelect),
      ' of synthetic audio per benchmark (voice-chain: always 1, 5 and 10 s clips)',
    ),
    el('p', {}, el('label', {}, 'Context rate (worklet-dsp, voice-chain): ', rateSelect)),
    el(
      'p',
      {},
      el(
        'label',
        {},
        realtimeBox,
        ' Real time: one frame per 32 ms (worklet-dsp: one batch per 100 quanta) instead of back to back; ' +
          'voice-chain always runs back to back',
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
  el('h2', {}, 'Voice chain (X-F3)'),
  el(
    'table',
    {},
    headRow([
      'Clip',
      'Preset (p)',
      'Calls',
      'p50',
      'p95',
      'max',
      'p50 per s',
      'p95 per s',
      'max per s',
      `p95 ≤ ${VOICE_BUDGET_MS_PER_S} ms/s`,
    ]),
    voiceResults,
  ),
  el(
    'p',
    {},
    'Stages: p50 ms per second of audio, per call, as batch means (each timed batch repeats the stage ' +
      'until it lasts at least 2 ms and 20 timer steps; batch sizes, p95 and max are in the log). Σ stages ' +
      'next to processVoice shows how well the separately timed stages add up to the chain.',
  ),
  el(
    'table',
    {},
    headRow(['Clip', 'Preset (p)', ...STAGE_KEYS.map((k) => STAGE_LABELS[k]), 'Σ stages', 'processVoice']),
    stageResults,
  ),
  voiceGateLine,
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
  if (req.bench === 'voice-chain') return `1, 5 and 10 s clips at ${req.rate} Hz, back to back`;
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

/** ms per second of audio. */
function msPerS(v: number): string {
  return `${fmt(v, 3)} ms/s`;
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

function updateVoiceGate(outcome: Outcome): void {
  let line: string;
  if (outcome.kind === 'result' && outcome.stats.kind === 'voice' && outcome.stats.rows.length > 0) {
    const { rows, rate } = outcome.stats;
    let worst = rows[0]!;
    let failing = 0;
    for (const row of rows) {
      if (row.p95Ms / row.clipS > worst.p95Ms / worst.clipS) worst = row;
      if (!(row.p95Ms / row.clipS <= VOICE_BUDGET_MS_PER_S)) failing++;
    }
    const worstPerS = worst.p95Ms / worst.clipS;
    const verdict = failing === 0 ? 'PASS' : 'FAIL';
    line =
      `${voiceGateHead} ${verdict} (${failing} of ${rows.length} rows fail), worst p95 ${msPerS(worstPerS)} ` +
      `(${worst.preset}, ${worst.clipS} s clip, ${rate} Hz)`;
  } else {
    const why =
      outcome.kind === 'result' ? 'no voice-chain stats' : `voice-chain did not finish: ${outcome.message}`;
    line = `${voiceGateHead} no result, ${why}`;
  }
  voiceGateLine.textContent = line;
  log(line);
}

/** One voice-chain row: the processVoice table row, the stage table row, and their log lines. */
function reportVoiceRow(row: VoiceRow, rate: number): void {
  const perS = (v: number): number => v / row.clipS;
  const clip = `${row.clipS} s`;
  const preset = `${row.preset} (${row.pitchRatio})`;
  const verdict = perS(row.p95Ms) <= VOICE_BUDGET_MS_PER_S ? 'PASS' : 'FAIL';
  voiceResults.append(
    el(
      'tr',
      {},
      ...[
        clip,
        preset,
        String(row.calls),
        ms(row.p50Ms),
        ms(row.p95Ms),
        ms(row.maxMs),
        msPerS(perS(row.p50Ms)),
        msPerS(perS(row.p95Ms)),
        msPerS(perS(row.maxMs)),
        verdict,
      ].map((c) => el('td', {}, c)),
    ),
  );
  let sum = 0;
  for (const s of row.stages) sum += s.p50Ms;
  stageResults.append(
    el(
      'tr',
      {},
      ...[
        clip,
        preset,
        ...STAGE_KEYS.map((k) => row.stages.find((s) => s.stage === k)).map((s) =>
          s === undefined ? '—' : fmt(perS(s.p50Ms), 3),
        ),
        fmt(perS(sum), 3),
        fmt(perS(row.p50Ms), 3),
      ].map((c) => el('td', {}, c)),
    ),
  );
  const head = `voice-chain ${clip} clip, ${row.preset} (p ${row.pitchRatio}), ${rate} Hz`;
  log(
    `${head}: ${row.inSamples} → ${row.outSamples} samples; ${row.calls} calls: p50 ${ms(row.p50Ms)} ` +
      `(${msPerS(perS(row.p50Ms))}), p95 ${ms(row.p95Ms)} (${msPerS(perS(row.p95Ms))}), max ${ms(row.maxMs)} ` +
      `(${msPerS(perS(row.maxMs))}); warm-up call ${ms(row.warmupMs)}; ` +
      `p95 ≤ ${VOICE_BUDGET_MS_PER_S} ms/s: ${verdict}; calls (ms, ascending): ` +
      row.sortedMs.map((v) => fmt(v, 1)).join(' '),
  );
  for (const s of row.stages) {
    log(
      `${head}: ${STAGE_LABELS[s.stage]} (ms per call: means of ${s.batches} batches of ${s.batch} ` +
        `call${s.batch === 1 ? '' : 's'}): ` +
        `p50 ${ms(s.p50Ms)} (${msPerS(perS(s.p50Ms))}), p95 ${ms(s.p95Ms)}, max ${ms(s.maxMs)}; ` +
        `timed call reproduces processVoice's result: ${s.matches ? 'yes' : 'NO'}`,
    );
  }
  const matching = row.stages.filter((s) => s.matches).length;
  log(
    `${head}: Σ stage p50 ${ms(sum)} vs processVoice p50 ${ms(row.p50Ms)}; stage inputs reproduce ` +
      `processVoice's output: ${row.composed ? 'yes' : 'NO'}; timed calls reproduce it: ` +
      `${matching} of ${row.stages.length} stages`,
  );
}

/**
 * Puts one outcome in the results tables and the log; a silero-ts outcome also sets the X-V2 gate line, a
 * voice-chain outcome the X-F3 one.
 */
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
  } else if (outcome.stats.kind === 'quantum') {
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
  } else {
    const s = outcome.stats;
    for (const row of s.rows) reportVoiceRow(row, s.rate);
    log(`${req.bench}: ${s.rows.length} clip × preset rows (${input}), wall ${fmt(s.wallS, 1)} s`);
  }
  if (req.bench === 'silero-ts') updateGate(req, outcome);
  if (req.bench === 'voice-chain') updateVoiceGate(outcome);
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
    // The voice chain runs back to back at full CPU and ignores Real time: keep it out of the thermal soak.
    const series = soak ? benches.filter((b) => b !== 'voice-chain') : benches;
    if (series.length < benches.length)
      log('voice-chain skipped: not part of the 10-min thermal soak; run it on its own');
    for (const bench of series) await runBench(bench);
    // The verdicts again, so a copied log ends with them.
    if (series.includes('silero-ts')) log(gateLine.textContent);
    if (series.includes('voice-chain')) log(voiceGateLine.textContent);
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
