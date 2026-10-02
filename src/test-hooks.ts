// E2E test hooks, `window.__bearTest` (plan §4.9.3, issue #36). Only the e2e build reaches this module: main.ts
// imports it dynamically behind `if (import.meta.env.VITE_BEAR_TEST_HOOKS === '1')`, which production builds
// dead-code-eliminate (`pnpm check:no-hooks` proves `__bearTest` is absent from dist/).
//
// - `log` / `events`: one entry per event the session reduced, including those that keep the state
//   (from === to), so specs can also check effects such as "no `arm` while Playing".
// - `setVisibility` drives the app's single visibility source (platform/visibility.ts).
// - `maxLevelDb` / `levels`: the input level probe, from the engine's `level` events (frames and dB only, never
//   audio). `levels` lets the loop specs tell a capture gap of the fake mic (digital silence) from a VAD result.
// - The output tap: after the first `ctxRunning`, a `test-tap` AudioWorkletNode goes between the master bus
//   and `destination`; the last 15 s of what it saw are kept in a preallocated ring. Test-only: the samples
//   are never stored or downloaded (plan Q2), only handed to the spec that asks for them.
// - The bear (#81): `showPose` renders one key pose for the full-app screenshots, and `frameLog` returns the
//   bear's X-A2 frame log (rAF time, mouth clip time, envelope index per drawn frame).
// - The VAD backend (#51): `setVadBackend` pins the backend of every later arm (specs whose synthetic fixtures
//   Silero doesn't treat as speech pin 'energy'), and `workerEvents` records the worker's VAD status events.

import type { BearView, FrameLogEntry } from './anim/bear-view.ts';
import { POSES, type PoseName } from './anim/poses.ts';
import type { Effect, SessionEvent, StateName } from './app/events.ts';
import type { LevelEvent, Session } from './app/session.ts';
import tapUrl from './audio/test-tap.worklet.ts?worker&url';
import { DEFAULT_VAD_BACKEND } from './audio/constants.ts';
import type { Engine, OutputTapHost, VadBackend, VadBackendHost } from './audio/engine.ts';
import type { Visibility } from './platform/visibility.ts';

export interface TransitionLogEntry {
  /** performance.now() when the session reported the step, in ms. */
  t: number;
  /** Math.round(ctx.currentTime · ctx.sampleRate) at that moment, or −1 before there is a context. */
  frame: number;
  from: StateName;
  to: StateName;
  event: SessionEvent['t'];
  effects: Effect['k'][];
}

export interface EventLogEntry {
  /** performance.now() when the session reported the step, in ms. */
  t: number;
  /** The event as dispatched, payload included (the same object, not a copy). */
  e: SessionEvent;
}

/** The worker's VAD status events, which reach the session's level listeners (not the reducer). */
export type WorkerEvent = Extract<LevelEvent, { t: 'vadReady' | 'vadStats' | 'vadError' }>;

export interface WorkerEventLogEntry {
  /** performance.now() when the level listener got the event, in ms (the clock of `log` and `events`). */
  t: number;
  /** The event as the engine emitted it (the same object, not a copy). */
  e: WorkerEvent;
}

export interface BearTestApi {
  log: TransitionLogEntry[];
  events: EventLogEntry[];
  state(): StateName;
  setVisibility(v: 'visible' | 'hidden'): void;
  /** The max `level.db` among the level events of the last `sinceMs` ms, or −Infinity if there are none. */
  maxLevelDb(sinceMs: number): number;
  /**
   * The level events of the last `sinceMs` ms, oldest first: each one's ctx frame (the first frame of its 10 ms
   * hop) and dB. Aggregate numbers only, never audio. All-zero input (a capture gap) reads −120 dB.
   */
  levels(sinceMs: number): { frame: number; db: number }[];
  /**
   * The output tap's ring (the last 15 s) from its first to its last sample with |x| > 1e-4, both included, as
   * a plain array; [] before the tap exists or when nothing louder has played.
   */
  outputSamples(): number[];
  /** The sample rate of outputSamples(): the AudioContext's rate, or NaN before there is a context. */
  outputSampleRate(): number;
  /**
   * Stops the bear's frame loop and renders key pose `POSES[name]` once, on a canvas of `cssWidth × cssHeight`
   * CSS px (default 500 × 700) at DPR 1, with the design box fitted and centred. Throws for an unknown name or
   * before the bear is mounted.
   */
  showPose(name: string, opts?: { cssWidth?: number; cssHeight?: number }): void;
  /** The bear's last 600 drawn frames, oldest first; [] before the bear is mounted. */
  frameLog(): FrameLogEntry[];
  /** Pins the VAD backend that every later arm asks the worker for (engine.setVadBackend). */
  setVadBackend(b: VadBackend): void;
  /** The backend every arm asks the worker for: the last setVadBackend's, else DEFAULT_VAD_BACKEND. */
  vadBackend(): VadBackend;
  /** Every `vadReady`, `vadStats` and `vadError` the session's level listeners got, oldest first. */
  workerEvents: WorkerEventLogEntry[];
}

declare global {
  interface Window {
    __bearTest?: BearTestApi;
  }
}

export interface TestHookDeps {
  session: Session;
  engine: Pick<Engine, 'context'> & OutputTapHost & VadBackendHost;
  visibility: Visibility;
  /** The bear, once main.ts has mounted it (after the hooks are installed). */
  bear: () => Pick<BearView, 'showPose' | 'frameLog'> | null;
}

/** Default canvas size of `showPose`: the renderer screenshots' 500 × 700 CSS px (#75). */
const POSE_CSS_WIDTH = 500;
const POSE_CSS_HEIGHT = 700;

function isPoseName(name: string): name is PoseName {
  return Object.hasOwn(POSES, name);
}

/** Seconds of tap output kept. */
const OUTPUT_RING_SEC = 15;
/** outputSamples() trims everything before the first and after the last sample above this magnitude. */
const SILENCE = 1e-4;
/**
 * Level events kept for maxLevelDb and levels (≈ 4 min: the worker posts one every third 10 ms hop, ≈ 33 per
 * second).
 */
const LEVEL_CAPACITY = 8192;

/** A preallocated ring of the latest `capacity` samples. */
interface SampleRing {
  push(block: Float32Array): void;
  trimmed(): number[];
}

function createSampleRing(capacity: number): SampleRing {
  const buf = new Float32Array(capacity);
  let write = 0;
  let filled = 0;
  return {
    push(block) {
      // Only the newest `capacity` samples of an oversized block can survive.
      const skip = Math.max(0, block.length - capacity);
      for (let i = skip; i < block.length; i++) {
        buf[write] = block[i]!;
        write = write + 1 === capacity ? 0 : write + 1;
      }
      filled = Math.min(capacity, filled + block.length - skip);
    },
    trimmed() {
      const oldest = (write - filled + capacity) % capacity;
      const at = (k: number): number => buf[(oldest + k) % capacity]!;
      let first = 0;
      while (first < filled && Math.abs(at(first)) <= SILENCE) first++;
      let last = filled - 1;
      while (last >= first && Math.abs(at(last)) <= SILENCE) last--;
      const out: number[] = [];
      for (let k = first; k <= last; k++) out.push(at(k));
      return out;
    },
  };
}

/** Installs `window.__bearTest` for this session and returns it. Call once, right after the session exists. */
export function installTestHooks(deps: TestHookDeps): BearTestApi {
  const { session, engine, visibility } = deps;
  const log: TransitionLogEntry[] = [];
  const events: EventLogEntry[] = [];
  const workerEvents: WorkerEventLogEntry[] = [];
  /** What setVadBackend last pinned (the engine's own value is private), so specs can see what arms ask for. */
  let backend: VadBackend = DEFAULT_VAD_BACKEND;

  const frameNow = (): number => {
    const ctx = engine.context();
    return ctx === null ? -1 : Math.round(ctx.currentTime * ctx.sampleRate);
  };

  // ---- level probe: a preallocated ring of (performance.now(), db, ctx frame) -----------------------------
  const levelT = new Float64Array(LEVEL_CAPACITY);
  const levelDb = new Float64Array(LEVEL_CAPACITY);
  const levelFrame = new Float64Array(LEVEL_CAPACITY);
  let levelCount = 0;
  session.subscribeLevel((e) => {
    if (e.t !== 'level') return;
    const i = levelCount % LEVEL_CAPACITY;
    levelT[i] = performance.now();
    levelDb[i] = e.db;
    levelFrame[i] = e.frame;
    levelCount++;
  });

  // ---- the worker's VAD status: model loaded, inference timing, fallback errors ----------------------------
  session.subscribeLevel((e) => {
    if (e.t === 'vadReady' || e.t === 'vadStats' || e.t === 'vadError') {
      workerEvents.push({ t: performance.now(), e });
    }
  });

  // ---- output tap --------------------------------------------------------------------------------------------
  let ring: SampleRing | null = null;
  /** Set on the first ctxRunning, so the tap is inserted once however often the context resumes. */
  let tapStarted = false;

  async function startTap(): Promise<void> {
    const ctx = engine.context();
    if (ctx === null) throw new Error('no AudioContext after ctxRunning');
    await ctx.audioWorklet.addModule(tapUrl);
    const node = new AudioWorkletNode(ctx, 'test-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
    const r = createSampleRing(Math.ceil(OUTPUT_RING_SEC * ctx.sampleRate));
    node.port.addEventListener('message', (m: MessageEvent<unknown>) => {
      if (m.data instanceof Float32Array) r.push(m.data);
    });
    node.port.start(); // addEventListener, unlike the onmessage setter, doesn't start the port
    engine.insertOutputTap(node);
    ring = r;
  }

  session.addTransitionListener((from, to, e, effects) => {
    const t = performance.now();
    log.push({ t, frame: frameNow(), from, to, event: e.t, effects: effects.map((fx) => fx.k) });
    events.push({ t, e });
    if (e.t === 'ctxRunning' && !tapStarted) {
      tapStarted = true;
      startTap().catch((err: unknown) => {
        console.error('test hooks: output tap failed', err);
      });
    }
  });

  const api: BearTestApi = {
    log,
    events,
    state: () => session.state().name,
    setVisibility: (v) => visibility.simulate(v),
    maxLevelDb(sinceMs) {
      const since = performance.now() - sinceMs;
      let max = Number.NEGATIVE_INFINITY;
      for (let k = 1; k <= Math.min(levelCount, LEVEL_CAPACITY); k++) {
        const i = (levelCount - k) % LEVEL_CAPACITY;
        if (levelT[i]! < since) break; // entries are in time order: everything older is out of range too
        if (levelDb[i]! > max) max = levelDb[i]!;
      }
      return max;
    },
    levels(sinceMs) {
      const since = performance.now() - sinceMs;
      // The newest n entries are in range: entries are in time order, so the first older one ends the count.
      const kept = Math.min(levelCount, LEVEL_CAPACITY);
      let n = 0;
      while (n < kept && levelT[(levelCount - 1 - n) % LEVEL_CAPACITY]! >= since) n++;
      const out: { frame: number; db: number }[] = [];
      for (let k = levelCount - n; k < levelCount; k++) {
        const i = k % LEVEL_CAPACITY;
        out.push({ frame: levelFrame[i]!, db: levelDb[i]! });
      }
      return out;
    },
    outputSamples: () => (ring === null ? [] : ring.trimmed()),
    outputSampleRate: () => engine.context()?.sampleRate ?? Number.NaN,
    showPose(name, opts) {
      if (!isPoseName(name)) throw new Error(`showPose: unknown pose ${name}`);
      const bear = deps.bear();
      if (bear === null) throw new Error('showPose: the bear is not mounted yet');
      bear.showPose(POSES[name], opts?.cssWidth ?? POSE_CSS_WIDTH, opts?.cssHeight ?? POSE_CSS_HEIGHT);
    },
    frameLog: () => deps.bear()?.frameLog() ?? [],
    setVadBackend(b) {
      // The engine has the method in every build that has these hooks (both need VITE_BEAR_TEST_HOOKS=1).
      if (engine.setVadBackend === undefined) throw new Error('setVadBackend: the engine has no such method');
      engine.setVadBackend(b);
      backend = b;
    },
    vadBackend: () => backend,
    workerEvents,
  };
  window.__bearTest = api;
  return api;
}
