/**
 * The debug overlay's VAD section (#56) in Vitest Browser Mode: its lines with a fake engine and session that emit
 * synthetic trace batches, CSP hygiene and unmount (issue #56 Validation 1); the formatters; the backend and
 * vadReady readings; the plot's energy-gate bar and segment markers (pixels); the gate replay against a sequential
 * energy gate; the ≤ 15 fps redraw; and the allocation probes. styles.css is not imported. T70's frame-line test
 * stays in src/anim/bear-view.browser.test.ts (#81).
 */
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { FakeClock } from '../../test/fake-clock.ts';
import { MAX_DPR } from '../anim/renderer.ts';
import type { Effect, SessionEvent, SessionState } from '../app/events.ts';
import { initialSessionState } from '../app/machine.ts';
import type { LevelEvent, TransitionListener } from '../app/session.ts';
import type { EngineEvent } from '../audio/engine.ts';
import { DEFAULT_ENERGY_PARAMS, energyGateStep, initialEnergyGateState } from '../dsp/energy-gate.ts';
import {
  batchBackend,
  createVadPlot,
  DEBUG_GATE_BAR_PX,
  DEBUG_PLOT_COLORS,
  DEBUG_PLOT_HEIGHT,
  DEBUG_PLOT_MS,
  DEBUG_PLOT_SECONDS,
  DEBUG_PLOT_WIDTH,
  formatAudioContext,
  formatVadBackend,
  formatVadStats,
  formatVadState,
  mountDebugOverlay,
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
 * 512-sample frame the hops span (160 samples each) gets that Silero p and inference time `ms`; without, there
 * are none (an energy epoch).
 */
function batch(
  epoch: number,
  hop0Frame: number,
  db: (i: number) => number,
  hops: number,
  p?: number,
  ms = 1,
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
    inferMs: new Float32Array(n32).fill(ms),
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
      r.emit(batch(3, hop0, () => -50, 25, 0.8, 1.1));
      if (k === 2) r.emit({ t: 'vadStats', p95Ms: 1.25 });
      clock.advance(250);
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

describe('the plot', () => {
  test('the energy-gate bar and the segment markers', () => {
    const canvas = document.createElement('canvas');
    const plot = createVadPlot(canvas, 1);
    for (let i = 0; i < 100; i += 3) plot.level(1, i * HOP, -60);
    // Floor −60: closed at −70, opens above −50 (−40), closes below −55 (−58).
    plot.trace(
      batch(1, 0, (i) => (i < 40 ? -70 : i < 70 ? -40 : -58), 100),
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
    // Until V8 has optimised a function, its lower tiers box fractional numbers. Measured on Chromium 1243:
    // drawing is allocation-free after 2000 warm-up calls, ingesting only after about 5000.
    const WARM_UP = 5000;
    /** The smallest heap growth over 3 rounds of ROUND calls, each after a forced GC and with none after it, so
     *  whatever the calls allocate shows. */
    const minGrowth = (call: (k: number) => void): number => {
      let min = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 3; round++) {
        gc();
        const before = usedJSHeapSize();
        for (let k = 0; k < ROUND; k++) call(k);
        min = Math.min(min, usedJSHeapSize() - before);
      }
      return min;
    };
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
    for (let k = 0; k < WARM_UP; k++) drawAt(k % ROUND);
    const drawGrowth = minGrowth(drawAt);
    const drawControl = minGrowth((k) => {
      drawAt(k);
      sink = [k];
    });

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
    for (let k = 0; k < WARM_UP; k++) ingest();
    const ingestGrowth = minGrowth(ingest);
    const ingestControl = minGrowth((k) => {
      ingest();
      sink = [k];
    });

    expect(drawGrowth, `draw: ${drawGrowth} B per ${ROUND} draws`).toBeLessThan(BOUND);
    expect(drawControl, `draw control: ${drawControl} B`).toBeGreaterThanOrEqual(BOUND);
    expect(ingestGrowth, `ingest: ${ingestGrowth} B per ${ROUND} batches`).toBeLessThan(BOUND);
    expect(ingestControl, `ingest control: ${ingestControl} B`).toBeGreaterThanOrEqual(BOUND);
    expect(sink).not.toBeNull();
  });
});
