/**
 * The debug overlay's VAD section (#56) in Vitest Browser Mode: its lines with a fake engine and session that emit
 * synthetic trace batches, CSP hygiene and unmount (issue #56 Validation 1); the formatters; the backend and
 * vadReady readings; what the plot draws (pixels: p, band, floor, thresholds, the energy-gate bar, the segment
 * markers); the gate replay against a sequential energy gate (large jumps, and levels hovering at the hysteresis
 * thresholds); the ≤ 15 fps redraw and the 250 ms text refresh; and the allocation probes. Then the device lines
 * (#93): the vibrate line, the context state on `statechange`, the mic-track events and the audio inputs. styles.css
 * is not imported. T70's frame-line test stays in src/anim/bear-view.browser.test.ts (#81).
 */
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { FakeClock } from '../../test/fake-clock.ts';
import { MAX_DPR } from '../anim/renderer.ts';
import type { Effect, SessionEvent, SessionState } from '../app/events.ts';
import { initialSessionState } from '../app/machine.ts';
import type { LevelEvent, TransitionListener } from '../app/session.ts';
import type { EngineEvent } from '../audio/engine.ts';
import { DEFAULT_ENERGY_PARAMS, energyGateStep, initialEnergyGateState } from '../dsp/energy-gate.ts';
import { SILERO_SEG_PARAMS } from '../dsp/segmenter.ts';
import {
  batchBackend,
  createVadPlot,
  DEBUG_GATE_BAR_PX,
  DEBUG_PLOT_COLORS,
  DEBUG_PLOT_DB_MAX,
  DEBUG_PLOT_DB_MIN,
  DEBUG_PLOT_HEIGHT,
  DEBUG_PLOT_MS,
  DEBUG_PLOT_SECONDS,
  DEBUG_PLOT_WIDTH,
  DEBUG_REFRESH_MS,
  DEBUG_TRACK_EVENTS,
  formatAudioContext,
  formatCtxState,
  formatInputs,
  formatTrackEvents,
  formatVadBackend,
  formatVadStats,
  formatVadState,
  formatVibrate,
  mountDebugOverlay,
  type DebugDeviceDeps,
  type DebugVadDeps,
  type TraceBatch,
} from './debug-overlay.ts';

const RATE = 48_000;
/** Ctx frames per 10 ms hop at RATE. */
const HOP = RATE / 100;

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  root.remove();
  vi.restoreAllMocks();
});

/**
 * A synthetic trace batch of `hops` hops from ctx frame `hop0Frame` at band dB `db(i)`. With `p`, every whole
 * 512-sample frame the hops span (160 samples each) gets that Silero p and an inference time from `ms` (one
 * value, or cycled through a list); without, there are none (an energy epoch).
 */
function batch(
  epoch: number,
  hop0Frame: number,
  db: (i: number) => number,
  hops: number,
  p?: number,
  ms: number | readonly number[] = 1,
): TraceBatch {
  const n32 = p === undefined ? 0 : Math.floor((hops * 160) / 512);
  const bandDb = new Float32Array(hops);
  for (let i = 0; i < hops; i++) bandDb[i] = db(i);
  return {
    t: 'traceBatch',
    epoch,
    hop0Frame,
    sil0Frame: n32 > 0 ? hop0Frame : Number.NaN,
    rawDb: bandDb.slice(),
    bandDb,
    voicing: new Float32Array(hops),
    sileroP: new Float32Array(n32).fill(p ?? 0),
    inferMs: Float32Array.from({ length: n32 }, (_, j) =>
      typeof ms === 'number' ? ms : (ms[j % ms.length] ?? 0),
    ),
  };
}

interface Rig {
  deps: DebugVadDeps;
  setTrace: Mock<(on: boolean) => void>;
  levelListeners: Set<(e: LevelEvent) => void>;
  transitionListeners: Set<TransitionListener>;
  /** Routes an engine event like `Session.onEngineEvent`: level-listener kinds to those, the rest dispatched. */
  emit(e: EngineEvent): void;
  /** A transition listener call for event `e` with `effects`. */
  transition(e: SessionEvent, effects: Effect[]): void;
  /** Stops the context clock at `seconds` (null: running with the fake clock again). */
  freeze(seconds: number | null): void;
}

/** A fake engine (trace switch, a context on the fake clock) and session (state, listener sets). */
function rig(clock: FakeClock): Rig {
  const levelListeners = new Set<(e: LevelEvent) => void>();
  const transitionListeners = new Set<TransitionListener>();
  const setTrace = vi.fn<(on: boolean) => void>();
  const state: SessionState = { ...initialSessionState('granted'), name: 'Listening', epoch: 3 };
  let frozen: number | null = null;
  const ctx = {
    sampleRate: RATE,
    outputLatency: 0.0125,
    get currentTime(): number {
      return frozen ?? clock.now() / 1000;
    },
  };
  const deps: DebugVadDeps = {
    engine: { setTrace, context: () => ctx },
    session: {
      state: () => state,
      subscribeLevel(cb) {
        levelListeners.add(cb);
        return () => levelListeners.delete(cb);
      },
      addTransitionListener(cb) {
        transitionListeners.add(cb);
        return () => transitionListeners.delete(cb);
      },
    },
  };
  const transition = (e: SessionEvent, effects: Effect[]): void => {
    for (const cb of transitionListeners) cb(state.name, state.name, e, effects);
  };
  return {
    deps,
    setTrace,
    levelListeners,
    transitionListeners,
    emit(e) {
      if (
        e.t === 'level' ||
        e.t === 'vadError' ||
        e.t === 'vadReady' ||
        e.t === 'vadStats' ||
        e.t === 'traceBatch'
      ) {
        for (const cb of levelListeners) cb(e);
      } else {
        transition(e, []);
      }
    },
    transition,
    freeze(seconds) {
      frozen = seconds;
    },
  };
}

/** The text of the VAD line `name` (`data-line`) under `root`. */
function line(name: string): string | null | undefined {
  return root.querySelector(`[data-line="${name}"]`)?.textContent;
}

describe('the VAD section', () => {
  test('after 1 s of synthetic trace it shows the backend and the inference p95, sets no style attribute, and unmount turns the trace off', () => {
    const clock = new FakeClock();
    const r = rig(clock);
    const overlay = mountDebugOverlay(root, {
      frameStats: (out) => Object.assign(out, { p95Ms: 2, fps: 60, frames: 120 }),
      clock,
      storage: {
        persisted: () => Promise.resolve(true),
        estimate: () => Promise.resolve({ usage: 1024, quota: 2048 }),
      },
      vad: r.deps,
    });
    expect(r.setTrace.mock.calls).toEqual([[true]]);
    expect(line('vad')).toBe('vad – · ready no');
    expect(line('infer')).toBe('infer p95 – ms · max – ms');

    r.emit({ t: 'vadReady', backend: 'silero' });
    for (let k = 0; k < 4; k++) {
      const hop0 = k * 25 * HOP;
      for (let i = 0; i < 25; i += 3) {
        r.emit({ t: 'level', epoch: 3, frame: hop0 + i * HOP, db: -50, floorDb: -60 });
      }
      // Varying inference times: the line shows the batch's largest.
      r.emit(batch(3, hop0, () => -50, 25, 0.8, [0.4, 1.1, 0.7]));
      if (k === 2) {
        // The text refreshes every DEBUG_REFRESH_MS, not on the plot's faster ticks.
        r.emit({ t: 'vadStats', p95Ms: 1.25 });
        clock.advance(DEBUG_PLOT_MS);
        expect(line('infer')).toBe('infer p95 – ms · max 1.10 ms');
        clock.advance(DEBUG_REFRESH_MS - DEBUG_PLOT_MS - 1);
        expect(line('infer')).toBe('infer p95 – ms · max 1.10 ms');
        clock.advance(1);
        expect(line('infer')).toBe('infer p95 1.25 ms · max 1.10 ms');
      } else {
        clock.advance(DEBUG_REFRESH_MS);
      }
    }
    expect(clock.now()).toBe(1000);

    // The inference p95 is read from its own line: the frame line, a different element, also says "p95".
    const infer = root.querySelector('[data-line="infer"]');
    const frameLine = root.querySelector('.debug-line');
    expect(infer?.textContent).toBe('infer p95 1.25 ms · max 1.10 ms');
    expect(frameLine).not.toBe(infer);
    expect(frameLine?.textContent).toBe('frame p95 2.0 ms · 60 fps');
    expect(line('vad')).toBe('vad silero · ready yes');
    expect(line('state')).toBe('state Listening · epoch 3');
    expect(line('ctx')).toBe('ctx 48000 Hz · out 12.5 ms');
    const canvas = root.querySelector<HTMLCanvasElement>('canvas.debug-plot');
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    expect(canvas?.width).toBe(Math.round(DEBUG_PLOT_WIDTH * dpr));
    expect(canvas?.height).toBe(Math.round(DEBUG_PLOT_HEIGHT * dpr));
    expect(root.querySelectorAll('[style]').length).toBe(0);

    overlay.dispose();
    expect(r.setTrace.mock.calls).toEqual([[true], [false]]);
    expect(clock.pending()).toBe(0);
    expect(r.levelListeners.size).toBe(0);
    expect(r.transitionListeners.size).toBe(0);
    expect(root.querySelector('.debug-overlay')).toBeNull();
    expect(root.querySelector('.debug-plot')).toBeNull();
  });

  test('formatters', () => {
    expect(formatVadState('Recording', 12)).toBe('state Recording · epoch 12');
    expect(formatVadBackend(null, false)).toBe('vad – · ready no');
    expect(formatVadBackend('energy', true)).toBe('vad energy · ready yes');
    expect(formatVadStats(Number.NaN, Number.NaN)).toBe('infer p95 – ms · max – ms');
    expect(formatVadStats(0.944, 1.3)).toBe('infer p95 0.94 ms · max 1.30 ms');
    expect(formatAudioContext(null)).toBe('ctx – Hz · out – ms');
    expect(formatAudioContext({ sampleRate: 44_100, outputLatency: 0.02134, currentTime: 0 })).toBe(
      'ctx 44100 Hz · out 21.3 ms',
    );
    expect(formatAudioContext({ sampleRate: 48_000, outputLatency: Number.NaN, currentTime: 0 })).toBe(
      'ctx 48000 Hz · out – ms',
    );
  });

  test('batchBackend: a p means Silero; a whole VAD frame of hops without one means energy', () => {
    expect(batchBackend(batch(1, 0, () => -50, 25, 0.5))).toBe('silero');
    expect(batchBackend(batch(1, 0, () => -50, 4, 0.5))).toBe('silero');
    expect(batchBackend(batch(1, 0, () => -50, 25))).toBe('energy');
    expect(batchBackend(batch(1, 0, () => -50, 4))).toBe('energy');
    expect(batchBackend(batch(1, 0, () => -50, 3))).toBeNull();
    expect(batchBackend(batch(1, 0, () => -50, 0))).toBeNull();
  });

  test('the backend follows the trace; vadReady drops on workerFailed and on a restartWorker effect', () => {
    const clock = new FakeClock();
    const r = rig(clock);
    const overlay = mountDebugOverlay(root, { frameStats: (out) => out, clock, vad: r.deps });
    r.emit({ t: 'vadReady', backend: 'silero' });
    r.emit(batch(3, 0, () => -50, 25)); // energy (the model was still loading, say)
    overlay.refresh();
    expect(line('vad')).toBe('vad energy · ready yes');
    expect(line('infer')).toBe('infer p95 – ms · max – ms');
    r.emit(batch(3, 25 * HOP, () => -50, 3)); // a short flush: no evidence either way
    overlay.refresh();
    expect(line('vad')).toBe('vad energy · ready yes');
    r.emit(batch(4, 28 * HOP, () => -50, 25, 0.9, 0.7));
    overlay.refresh();
    expect(line('vad')).toBe('vad silero · ready yes');
    expect(line('infer')).toBe('infer p95 – ms · max 0.70 ms');
    r.emit({ t: 'workerFailed' });
    overlay.refresh();
    expect(line('vad')).toBe('vad silero · ready no');
    r.emit({ t: 'vadReady', backend: 'silero' });
    overlay.refresh();
    expect(line('vad')).toBe('vad silero · ready yes');
    // The recording watchdog restarts the worker without a workerFailed.
    r.transition({ t: 'timer', name: 'recording' }, [{ k: 'restartWorker' }]);
    overlay.refresh();
    expect(line('vad')).toBe('vad silero · ready no');
    overlay.dispose();
  });
});

// ---- the plot ---------------------------------------------------------------------------------------------

/** "#rrggbb" → [r, g, b, 255]. */
function rgba(hex: string): number[] {
  const m = /^#(..)(..)(..)$/.exec(hex);
  if (m === null) throw new Error(`not #rrggbb: ${hex}`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16), 255];
}

function pixel(c: CanvasRenderingContext2D, x: number, y: number): number[] {
  return Array.from(c.getImageData(x, y, 1, 1).data);
}

/** The plot's data area above the energy-gate bar, in CSS px (dpr 1: canvas px). */
const PLOT_H = DEBUG_PLOT_HEIGHT - DEBUG_GATE_BAR_PX;
/** The y of a Silero p and of a level in dBFS, as debug-overlay.ts maps them. */
const yOfP = (p: number): number => (1 - p) * PLOT_H;
const yOfDb = (db: number): number =>
  ((DEBUG_PLOT_DB_MAX - db) / (DEBUG_PLOT_DB_MAX - DEBUG_PLOT_DB_MIN)) * PLOT_H;

describe('the plot', () => {
  test('what it draws: p, band, floor, the thresholds, the energy-gate bar and the segment markers', () => {
    const canvas = document.createElement('canvas');
    const plot = createVadPlot(canvas, 1);
    for (let i = 0; i < 100; i += 3) plot.level(1, i * HOP, -60);
    // Floor −60: closed at −70, opens above −50 (−40), closes below −55 (−58). Silero p 0.9 throughout.
    plot.trace(
      batch(1, 0, (i) => (i < 40 ? -70 : i < 70 ? -40 : -58), 100, 0.9),
      RATE,
    );
    plot.seg({ kind: 'start', frame: 45 * HOP });
    plot.seg({ kind: 'end', frame: 75 * HOP, lastSpeechFrame: 70 * HOP, reason: 'silence' });
    plot.seg({ kind: 'misfire', frame: 90 * HOP });
    const end = 100 * HOP;
    plot.draw(end, RATE);
    expect(plot.gateOpen(99 - 39)).toBe(false);
    expect(plot.gateOpen(99 - 40)).toBe(true);
    expect(plot.gateOpen(99 - 69)).toBe(true);
    expect(plot.gateOpen(99 - 70)).toBe(false);

    const g = canvas.getContext('2d');
    if (g === null) throw new Error('no 2d context');
    const t0 = end - DEBUG_PLOT_SECONDS * RATE;
    const xOf = (frame: number): number => ((frame - t0) / (DEBUG_PLOT_SECONDS * RATE)) * DEBUG_PLOT_WIDTH;
    const barY = DEBUG_PLOT_HEIGHT - DEBUG_GATE_BAR_PX / 2;
    expect(pixel(g, Math.floor(xOf(55.5 * HOP)), barY)).toEqual(rgba(DEBUG_PLOT_COLORS.egate));
    expect(pixel(g, Math.floor(xOf(20.5 * HOP)), barY)[3]).toBe(0);
    expect(pixel(g, Math.floor(xOf(85.5 * HOP)), barY)[3]).toBe(0);
    const marks: [number, string][] = [
      [45, DEBUG_PLOT_COLORS.start],
      [75, DEBUG_PLOT_COLORS.end],
      [90, DEBUG_PLOT_COLORS.misfire],
    ];
    for (const [hop, color] of marks) {
      const col = Math.round(xOf(hop * HOP));
      expect(pixel(g, col - 1, 30), `marker at hop ${hop}`).toEqual(rgba(color));
      expect(pixel(g, col, 30), `marker at hop ${hop}`).toEqual(rgba(color));
    }

    // The series, on rows their 1.5 px lines cover completely and in columns where nothing else is drawn on
    // that row: p 0.9 near hop 20, band −40 near hop 55, floor −60 near hop 20.
    expect(yOfP(0.9)).toBeCloseTo(15.4);
    expect(pixel(g, Math.floor(xOf(20.5 * HOP)), Math.floor(yOfP(0.9))), 'p').toEqual(
      rgba(DEBUG_PLOT_COLORS.p),
    );
    expect(pixel(g, Math.floor(xOf(55.5 * HOP)), Math.floor(yOfDb(-40))), 'band').toEqual(
      rgba(DEBUG_PLOT_COLORS.band),
    );
    expect(pixel(g, Math.floor(xOf(20.5 * HOP)), Math.floor(yOfDb(-60))), 'floor').toEqual(
      rgba(DEBUG_PLOT_COLORS.floor),
    );
    // The dashed threshold lines (half-transparent, 1 px, so their rows are blended): ink on the rows of
    // 0.5 and 0.35 in a column left of the data, inside a dash, and none on a row between them.
    const col = 100; // 100 mod (4 + 3) = 2: inside a 4 px dash
    expect(xOf(0)).toBeGreaterThan(col + 10);
    const [tr, tg, tb] = [26, 115, 232]; // DEBUG_PLOT_COLORS.threshold
    for (const p of [SILERO_SEG_PARAMS.posThreshold, SILERO_SEG_PARAMS.negThreshold]) {
      const [r, gr, b, a] = pixel(g, col, Math.round(yOfP(p)));
      expect(a, `threshold ${p}`).toBeGreaterThan(0);
      expect(
        Math.abs(r! - tr) + Math.abs(gr! - tg) + Math.abs(b! - tb),
        `threshold ${p}`,
      ).toBeLessThanOrEqual(9);
    }
    expect(pixel(g, col, Math.round(yOfP(0.425)))[3], 'between the thresholds').toBe(0);
  });

  test('the bar replays the worker’s energy gate hop by hop (sequential reference, falling floors)', () => {
    // 1000 hops (40 batches of 25) whose level jumps every 30 ms between −75 and −20 dBFS: the floor falls fast
    // and rises slowly, so a floor even one hop stale would show. The reference is one energyGateStep per hop,
    // the worker's own sequence; like the worker, every 3rd hop posts its floor before the batch holding it.
    const N = 1000;
    const db = new Float32Array(N);
    let seed = 12345;
    let level = -40;
    for (let i = 0; i < N; i++) {
      if (i % 3 === 0) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        level = -75 + (seed / 2 ** 32) * 55;
      }
      db[i] = level;
    }
    const plot = createVadPlot(document.createElement('canvas'), 1);
    const ref = initialEnergyGateState();
    const refActive: boolean[] = [];
    let opens = 0;
    for (let k = 0; k < N / 25; k++) {
      for (let i = k * 25; i < (k + 1) * 25; i++) {
        const was = ref.active;
        energyGateStep(ref, { frame: i * HOP, db: db[i]!, floorDb: 0 }, DEFAULT_ENERGY_PARAMS);
        if (ref.active && !was) opens++;
        refActive.push(ref.active);
        if (i % 3 === 0) plot.level(1, i * HOP, ref.initialized ? ref.floorDb : Number.NaN);
      }
      plot.trace(
        batch(1, k * 25 * HOP, (i) => db[k * 25 + i]!, 25),
        RATE,
      );
    }
    expect(opens).toBeGreaterThanOrEqual(20);
    const replay = refActive.map((_, i) => plot.gateOpen(N - 1 - i));
    expect(replay).toEqual(refActive);
  });

  test('the bar replays the worker’s energy gate hop by hop (levels hovering at the hysteresis thresholds)', () => {
    // 1000 hops whose level sits within ±3 dB of the threshold the gate tests next (floor + 10 dB to open,
    // floor + 5 dB to close), against the reference's own floor before the hop: decisions hang on hundredths of a
    // dB, so a floor taken one hop early (the current hop's own posted floor) or one or two hops stale (re-pinning
    // to the newest level on every hop) shows.
    const N = 1000;
    const db = new Float32Array(N);
    const plot = createVadPlot(document.createElement('canvas'), 1);
    const ref = initialEnergyGateState();
    const refActive: boolean[] = [];
    let seed = 2024;
    let opens = 0;
    for (let k = 0; k < N / 25; k++) {
      for (let i = k * 25; i < (k + 1) * 25; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const jitter = (seed / 2 ** 32) * 6 - 3;
        const margin = ref.active
          ? DEFAULT_ENERGY_PARAMS.offsetMarginDb
          : DEFAULT_ENERGY_PARAMS.onsetMarginDb;
        db[i] = Math.fround(ref.initialized ? ref.floorDb + margin + jitter : -60);
        const was = ref.active;
        energyGateStep(ref, { frame: i * HOP, db: db[i]!, floorDb: 0 }, DEFAULT_ENERGY_PARAMS);
        if (ref.active && !was) opens++;
        refActive.push(ref.active);
        if (i % 3 === 0) plot.level(1, i * HOP, ref.initialized ? ref.floorDb : Number.NaN);
      }
      plot.trace(
        batch(1, k * 25 * HOP, (i) => db[k * 25 + i]!, 25),
        RATE,
      );
    }
    expect(opens).toBeGreaterThanOrEqual(50);
    const replay = refActive.map((_, i) => plot.gateOpen(N - 1 - i));
    expect(replay).toEqual(refActive);
  });

  test('a new epoch starts the replay uninitialised: no floor of an older epoch reaches its first hop', () => {
    const plot = createVadPlot(document.createElement('canvas'), 1);
    for (let i = 0; i < 30; i += 3) plot.level(1, i * HOP, -60);
    plot.trace(
      batch(1, 0, () => -60, 30),
      RATE,
    );
    // −40 would open against epoch 1's floor of −60 (> −50); as epoch 2's initialising hop it can't.
    plot.trace(
      batch(2, 40 * HOP, () => -40, 1),
      RATE,
    );
    expect(plot.gateOpen(0)).toBe(false);
  });

  test('it redraws at most 15 times a second, and not while nothing changes', () => {
    expect(DEBUG_PLOT_MS).toBeGreaterThanOrEqual(1000 / 15);
    const clearRect = vi.spyOn(CanvasRenderingContext2D.prototype, 'clearRect');
    const clock = new FakeClock();
    const r = rig(clock);
    const overlay = mountDebugOverlay(root, { frameStats: (out) => out, clock, vad: r.deps });
    expect(clearRect).toHaveBeenCalledTimes(1); // the initial draw
    clock.advance(1000);
    const perSecond = clearRect.mock.calls.length - 1;
    expect(perSecond).toBeGreaterThanOrEqual(14);
    expect(perSecond).toBeLessThanOrEqual(15);
    // A suspended context (its clock stands still) and no new data: after catching up, no redraws.
    r.freeze(clock.now() / 1000);
    clock.advance(DEBUG_PLOT_MS);
    const settled = clearRect.mock.calls.length;
    clock.advance(1000);
    expect(clearRect.mock.calls.length).toBe(settled);
    // New data draws once, at the next tick.
    r.emit({ t: 'level', epoch: 3, frame: 0, db: -50, floorDb: -60 });
    clock.advance(DEBUG_PLOT_MS);
    expect(clearRect.mock.calls.length).toBe(settled + 1);
    overlay.dispose();
  });
});

// ---- allocation probes ------------------------------------------------------------------------------------

/** `performance.memory.usedJSHeapSize` (Chromium; precise with --enable-precise-memory-info). */
function usedJSHeapSize(): number {
  const memory: unknown = Reflect.get(performance, 'memory');
  const bytes: unknown =
    typeof memory === 'object' && memory !== null ? Reflect.get(memory, 'usedJSHeapSize') : undefined;
  if (typeof bytes !== 'number') throw new Error('no performance.memory.usedJSHeapSize');
  return bytes;
}

/** Escapes the positive controls' arrays, so V8 can't drop them. */
let sink: unknown = null;

describe('allocation probes', () => {
  test('drawing and ingesting allocate nothing: transient heap growth over 600 calls after warm-up', () => {
    const gc: unknown = Reflect.get(globalThis, 'gc');
    if (typeof gc !== 'function') {
      throw new Error('needs Chromium with --js-flags=--expose-gc (vitest.config.ts)');
    }
    const ROUND = 600;
    const BOUND = 4096;
    /**
     * The heap growth of each of `rounds` rounds of ROUND calls, each round after a forced GC and with none after
     * it, so whatever the calls allocate shows. A probe takes the smallest (an optimising compile that lands in a
     * round adds a few KB once, and a real allocation shows in every round); a positive control takes the largest
     * (a GC that runs inside a round can only lower that round's growth).
     */
    const growths = (call: (k: number) => void, rounds: number): number[] => {
      const out: number[] = [];
      for (let round = 0; round < rounds; round++) {
        gc();
        const before = usedJSHeapSize();
        for (let k = 0; k < ROUND; k++) call(k);
        out.push(usedJSHeapSize() - before);
      }
      return out;
    };
    // Until V8 has optimised a function, its lower tiers box fractional numbers, so each path is warmed up first,
    // with every batch shape and rate the other tests use as well, so the probe doesn't depend on them running
    // first (or not).
    const shapes = createVadPlot(document.createElement('canvas'), 1);
    let at = 0;
    for (let k = 0; k < 400; k++) {
      const rate = k % 2 === 0 ? 48_000 : 44_100;
      const hop = rate / 100;
      const epoch = 1 + (k % 3);
      const hop0 = at;
      at += 160 * hop;
      for (let i = 0; i < 154; i += 3) shapes.level(epoch, hop0 + i * hop, i % 2 === 0 ? -60 : Number.NaN);
      shapes.trace(
        batch(epoch, hop0, (i) => -70 + (i % 7) * 5, 25, 0.8, [0.4, 1.1, 0.7]),
        rate,
      );
      shapes.trace(
        batch(epoch, hop0 + 25 * hop, () => -50, 25),
        rate,
      );
      shapes.trace(
        batch(epoch, hop0 + 50 * hop, () => -50, 3),
        rate,
      );
      shapes.trace(
        batch(epoch, hop0 + 53 * hop, () => -40, 1),
        rate,
      );
      shapes.trace(
        batch(epoch, hop0 + 54 * hop, (i) => -60 + (i % 3), 100, 0.3),
        rate,
      );
      shapes.seg(
        k % 3 === 0
          ? { kind: 'start', frame: hop0 }
          : k % 3 === 1
            ? { kind: 'end', frame: hop0, lastSpeechFrame: hop0, reason: 'silence' }
            : { kind: 'misfire', frame: hop0 },
      );
      shapes.draw(hop0 + 154 * hop + 0.5, rate);
    }

    // 44.1 kHz: the Silero frames' ctx frames (1411.2 apart) are fractional.
    const rate = 44_100;
    const hop = rate / 100;
    const plot = createVadPlot(document.createElement('canvas'), 2);
    // 10 s of trace, levels and markers: full rings.
    for (let k = 0; k < 40; k++) {
      const hop0 = k * 25 * hop;
      for (let i = 0; i < 25; i += 3) plot.level(1, hop0 + i * hop, -60);
      plot.trace(
        batch(1, hop0, (i) => (i % 10 < 5 ? -40 : -65), 25, 0.7),
        rate,
      );
      if (k % 5 === 0) plot.seg({ kind: 'start', frame: hop0 });
    }

    // Draw at fractional end frames, as on a device (ctx.currentTime · sampleRate), about one 67 ms tick apart.
    // They are boxed before measuring (an array that also holds a string keeps its numbers as heap objects), so
    // handing one to draw() allocates nothing, as handing it an event's property wouldn't; anything draw()
    // allocates itself still shows.
    const ends: unknown[] = [];
    for (let k = 0; k < ROUND; k++) ends.push(40 * 25 * hop + 0.37 + k * 3200.41);
    ends.push('not a number');
    const drawAt = (k: number): void => {
      const end = ends[k];
      if (typeof end === 'number') plot.draw(end, rate);
    };
    for (let k = 0; k < 5000; k++) drawAt(k % ROUND);
    const draw = growths(drawAt, 5);
    const drawControl = growths((k) => {
      drawAt(k);
      sink = [k];
    }, 3);

    // Ingest one reused batch object and one level per call, their frames advancing like the worker's (whole ctx
    // frames, as the worker rounds them).
    const b = batch(1, 0, (i) => (i % 10 < 5 ? -40 : -65), 25, 0.7);
    const next = { hop0: 1_000_000 };
    const ingest = (): void => {
      next.hop0 += 25 * hop;
      b.hop0Frame = next.hop0;
      b.sil0Frame = next.hop0;
      plot.level(1, next.hop0, -60.5);
      plot.trace(b, rate);
    };
    for (let k = 0; k < 10_000; k++) ingest();
    const ingested = growths(ingest, 5);
    const ingestControl = growths((k) => {
      ingest();
      sink = [k];
    }, 3);

    const report = `draw ${draw.join('/')}, control ${drawControl.join('/')}; ingest ${ingested.join('/')}, control ${ingestControl.join('/')} (B per ${ROUND} calls)`;
    expect(Math.min(...draw), report).toBeLessThan(BOUND);
    expect(Math.max(...drawControl), report).toBeGreaterThanOrEqual(BOUND);
    expect(Math.min(...ingested), report).toBeLessThan(BOUND);
    expect(Math.max(...ingestControl), report).toBeGreaterThanOrEqual(BOUND);
    expect(sink).not.toBeNull();
  });
});

// ---- the device lines (#93) ---------------------------------------------------------------------------------

/** An event target whose listener count is visible: a fake AudioContext or MediaDevices. */
function counted<T extends object>(
  extra: T,
): T & {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  fire(type: string): void;
  listeners(): number;
} {
  const target = new EventTarget();
  let n = 0;
  return Object.assign(extra, {
    addEventListener(type: string, cb: () => void): void {
      n++;
      target.addEventListener(type, cb);
    },
    removeEventListener(type: string, cb: () => void): void {
      n--;
      target.removeEventListener(type, cb);
    },
    fire(type: string): void {
      target.dispatchEvent(new Event(type));
    },
    listeners: () => n,
  });
}

function device(kind: MediaDeviceKind, label: string): MediaDeviceInfo {
  return { deviceId: label, groupId: '', kind, label, toJSON: () => ({}) };
}

/** Lets the pending promise callbacks (an enumeration) run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface DeviceRig {
  deps: DebugDeviceDeps;
  /** The haptics log's latest line. */
  vibrate: { line: string | null };
  /** The engine's context (null: none yet). */
  engine: { ctx: ReturnType<typeof fakeContext> | null };
  media: ReturnType<typeof fakeMedia>;
  transitionListeners: Set<TransitionListener>;
  transition(e: SessionEvent): void;
}

function fakeContext(state: AudioContextState) {
  return counted({ state });
}

function fakeMedia(list: () => MediaDeviceInfo[] | Error) {
  const enumerateDevices = vi.fn((): Promise<MediaDeviceInfo[]> => {
    const l = list();
    return l instanceof Error ? Promise.reject(l) : Promise.resolve(l);
  });
  return counted({ enumerateDevices });
}

function deviceRig(clock: FakeClock, list: () => MediaDeviceInfo[] | Error = () => []): DeviceRig {
  const vibrate = { line: null as string | null };
  const engine: DeviceRig['engine'] = { ctx: null };
  const media = fakeMedia(list);
  const transitionListeners = new Set<TransitionListener>();
  const state = initialSessionState('granted');
  return {
    deps: {
      lastVibrate: () => vibrate.line,
      engine: { context: () => engine.ctx },
      session: {
        addTransitionListener(cb) {
          transitionListeners.add(cb);
          return () => {
            transitionListeners.delete(cb);
          };
        },
      },
      mediaDevices: media,
      now: () => clock.now(),
    },
    vibrate,
    engine,
    media,
    transitionListeners,
    transition(e) {
      for (const cb of transitionListeners) cb(state.name, state.name, e, []);
    },
  };
}

describe('the device lines (#93)', () => {
  test('formatters', () => {
    expect(formatVibrate(null)).toBe('vibrate –');
    const logged = 'vibrate([12]) = true; immediate; last activation: down; userActivation: n/a';
    expect(formatVibrate(logged)).toBe(logged);
    expect(formatCtxState(null)).toBe('ctx state –');
    expect(formatCtxState('running')).toBe('ctx state running');
    expect(formatTrackEvents([])).toBe('track –');
    expect(
      formatTrackEvents([
        { kind: 'mute', t: 12_340 },
        { kind: 'unmute', t: 15_000 },
        { kind: 'ended', t: 61_960 },
      ]),
    ).toBe('track mute 12.3 s · unmute 15.0 s · ended 62.0 s');
    expect(formatInputs(null)).toBe('inputs –');
    expect(formatInputs([])).toBe('inputs (none)');
    expect(formatInputs(['Speakerphone', '', 'Headset earpiece'])).toBe(
      'inputs Speakerphone · (no label) · Headset earpiece',
    );
  });

  test('the vibrate line shows the haptics log’s latest line at the next 250 ms tick', () => {
    const clock = new FakeClock();
    const r = deviceRig(clock);
    const overlay = mountDebugOverlay(root, { frameStats: (out) => out, clock, device: r.deps });
    expect(line('vibrate')).toBe('vibrate –');
    r.vibrate.line = 'vibrate([12]) = true; deferred to up; last activation: up; userActivation: n/a';
    clock.advance(DEBUG_REFRESH_MS - 1);
    expect(line('vibrate')).toBe('vibrate –');
    clock.advance(1);
    expect(line('vibrate')).toBe(r.vibrate.line);
    overlay.dispose();
  });

  test('ctx state: found at the next tick once it exists, then rewritten on every statechange', () => {
    const clock = new FakeClock();
    const r = deviceRig(clock);
    const overlay = mountDebugOverlay(root, { frameStats: (out) => out, clock, device: r.deps });
    expect(line('ctxState')).toBe('ctx state –');
    const first = fakeContext('suspended');
    r.engine.ctx = first;
    expect(line('ctxState')).toBe('ctx state –');
    clock.advance(DEBUG_REFRESH_MS);
    expect(line('ctxState')).toBe('ctx state suspended');
    expect(first.listeners()).toBe(1);
    // A statechange rewrites it at once: no tick.
    first.state = 'running';
    first.fire('statechange');
    expect(line('ctxState')).toBe('ctx state running');
    // A new context takes over at the next tick; the old one no longer writes.
    const second = fakeContext('suspended');
    r.engine.ctx = second;
    clock.advance(DEBUG_REFRESH_MS);
    expect(line('ctxState')).toBe('ctx state suspended');
    expect([first.listeners(), second.listeners()]).toEqual([0, 1]);
    first.state = 'closed';
    first.fire('statechange');
    expect(line('ctxState')).toBe('ctx state suspended');
    second.state = 'running';
    second.fire('statechange');
    expect(line('ctxState')).toBe('ctx state running');
    overlay.dispose();
    expect(second.listeners()).toBe(0);
  });

  test('track: the mic track’s mute, unmute and ended events with their page times, the newest four', () => {
    const clock = new FakeClock(10_000);
    const r = deviceRig(clock);
    const overlay = mountDebugOverlay(root, { frameStats: (out) => out, clock, device: r.deps });
    expect(line('track')).toBe('track –');
    r.transition({ t: 'trackMuted' });
    expect(line('track')).toBe('track mute 10.0 s');
    const events: SessionEvent[] = [
      { t: 'trackUnmuted' },
      { t: 'trackMuted' },
      { t: 'tapBear' }, // not a track event
      { t: 'trackUnmuted' },
      { t: 'trackEnded' },
    ];
    for (const e of events) {
      clock.advance(1_250);
      r.transition(e);
    }
    expect(DEBUG_TRACK_EVENTS).toBe(4);
    // 10.0 s mute, then 11.25 unmute, 12.5 mute, (13.75 tapBear), 15.0 unmute, 16.25 ended: the newest four.
    expect(line('track')).toBe('track unmute 11.3 s · mute 12.5 s · unmute 15.0 s · ended 16.3 s');
    overlay.dispose();
  });

  test('inputs: the audioinput labels at mount, again on devicechange and on micGranted; a rejection or no mediaDevices → –', async () => {
    const clock = new FakeClock();
    let list: MediaDeviceInfo[] | Error = [
      device('audioinput', 'Speakerphone'),
      device('audiooutput', 'Speaker'),
      device('audioinput', ''),
      device('videoinput', 'Camera'),
    ];
    const r = deviceRig(clock, () => list);
    const overlay = mountDebugOverlay(root, { frameStats: (out) => out, clock, device: r.deps });
    expect(line('inputs')).toBe('inputs –');
    await settle();
    expect(line('inputs')).toBe('inputs Speakerphone · (no label)');
    expect(r.media.enumerateDevices).toHaveBeenCalledTimes(1);
    list = [device('audioinput', 'Speakerphone'), device('audioinput', 'Headset earpiece')];
    r.media.fire('devicechange');
    await settle();
    expect(line('inputs')).toBe('inputs Speakerphone · Headset earpiece');
    list = [device('audioinput', 'Bluetooth headset')];
    r.transition({ t: 'micGranted', req: 1 });
    await settle();
    expect(line('inputs')).toBe('inputs Bluetooth headset');
    expect(r.media.enumerateDevices).toHaveBeenCalledTimes(3);
    list = new Error('enumerateDevices failed');
    r.media.fire('devicechange');
    await settle();
    expect(line('inputs')).toBe('inputs –');
    overlay.dispose();

    root.replaceChildren();
    const none = deviceRig(clock);
    const noMedia = mountDebugOverlay(root, {
      frameStats: (out) => out,
      clock,
      device: { ...none.deps, mediaDevices: null },
    });
    await settle();
    expect(line('inputs')).toBe('inputs –');
    noMedia.dispose();
  });

  test('inputs: an older enumeration that settles after a newer one never overwrites it', async () => {
    const clock = new FakeClock();
    const pending: ((list: MediaDeviceInfo[]) => void)[] = [];
    const media = counted({
      enumerateDevices: vi.fn(
        (): Promise<MediaDeviceInfo[]> =>
          new Promise((resolve) => {
            pending.push(resolve);
          }),
      ),
    });
    const r = deviceRig(clock);
    const overlay = mountDebugOverlay(root, {
      frameStats: (out) => out,
      clock,
      device: { ...r.deps, mediaDevices: media },
    });
    // The mount's enumeration, then two devicechanges: three pending, settled newest first.
    media.fire('devicechange');
    media.fire('devicechange');
    expect(pending).toHaveLength(3);
    pending[2]!([device('audioinput', 'Newest')]);
    await settle();
    expect(line('inputs')).toBe('inputs Newest');
    pending[1]!([device('audioinput', 'Older')]);
    pending[0]!([device('audioinput', 'Oldest')]);
    await settle();
    expect(line('inputs')).toBe('inputs Newest');
    overlay.dispose();
  });

  test('sets no style attribute; dispose removes every listener and timer', async () => {
    const clock = new FakeClock();
    const r = deviceRig(clock, () => [device('audioinput', 'Speakerphone')]);
    const overlay = mountDebugOverlay(root, { frameStats: (out) => out, clock, device: r.deps });
    const ctx = fakeContext('running');
    r.engine.ctx = ctx;
    clock.advance(DEBUG_REFRESH_MS);
    await settle();
    expect(line('ctxState')).toBe('ctx state running');
    expect(line('inputs')).toBe('inputs Speakerphone');
    expect(root.querySelectorAll('[style]').length).toBe(0);
    expect([ctx.listeners(), r.media.listeners(), r.transitionListeners.size]).toEqual([1, 1, 1]);
    overlay.dispose();
    expect(root.querySelector('.debug-overlay')).toBeNull();
    expect([ctx.listeners(), r.media.listeners(), r.transitionListeners.size]).toEqual([0, 0, 0]);
    expect(clock.pending()).toBe(0);
  });
});
