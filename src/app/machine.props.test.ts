// Property tests for the session reducer: the invariants of plan §4.9.1 ("Session reducer" row) on random event
// sequences, driven through the discrete-event environment simulator in test/session-sim.ts (issue #29).
// fast-check seeds every run. On a failure it prints the seed, the shrunk counterexample and, inside the error,
// the shrunk event trace (default `verbose`, so a failing CI log is actionable: property 9).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SessionSim, type MicMode, type SimRng, type Transition } from '../../test/session-sim.ts';
import { PRESETS, type VoicePreset } from '../dsp/types.ts';
import {
  DEFAULT_CONFIG,
  type Effect,
  type Permission,
  type SessionEvent,
  type SessionState,
  type StateName,
} from './events.ts';
import { GATED, MIC_OPEN, TABLE, reduce } from './machine.ts';

/** At least 300 runs per property, each a sequence of up to 400 steps (issue #29). */
const RUNS = 300;
const MAX_STEPS = 400;
/** The random draws one step may use: a step needs at most 10 (any further draw reads as 0). */
const DRAWS_PER_STEP = 12;

/**
 * Property 4's bound (issue #29): the sleep timer, plus a full utterance with its watchdog, processing, the
 * longest replay (7 s), a cooldown, a Waking re-select and 1 s of slack. The timings are the reducer's own.
 */
const cfg = DEFAULT_CONFIG;
const LIVENESS_BOUND_MS =
  cfg.tSleepMs + (cfg.maxUtteranceMs + 2000) + cfg.processingMs + 7000 + cfg.cooldownMs + cfg.wakingMs + 1000;
/** A safety net against a livelock that never advances time. */
const MAX_LIVENESS_STEPS = 10_000;
const TERMINAL: ReadonlySet<StateName> = new Set<StateName>(['Asleep', 'Paused']);

/** One step's draws: integers that read as uniform numbers in [0, 1) and shrink towards 0 (deliver). */
const stepArb = fc.array(fc.integer({ min: 0, max: 0xffff }), {
  minLength: DRAWS_PER_STEP,
  maxLength: DRAWS_PER_STEP,
});
const walkFields = {
  permission: fc.oneof(
    { weight: 3, arbitrary: fc.constant<Permission>('granted') },
    { weight: 1, arbitrary: fc.constantFrom<Permission>('prompt', 'denied') },
  ),
  mic: fc.oneof(
    { weight: 3, arbitrary: fc.constant<MicMode>('granted') },
    { weight: 2, arbitrary: fc.constant<MicMode>('mixed') },
    { weight: 1, arbitrary: fc.constantFrom<MicMode>('denied', 'noDevice') },
  ),
  steps: fc.array(stepArb, { minLength: 1, maxLength: MAX_STEPS, size: 'max' }),
};
const walkArb = fc.record(walkFields);
type Walk = (typeof walkArb extends fc.Arbitrary<infer W> ? W : never) & { lossRate?: number };
/** Property 4 also loses some environment answers, so the waking and processing timeouts fire. */
const lossyWalkArb = fc.record({ ...walkFields, lossRate: fc.constantFrom(0, 0.1) });

function tapeRng(tape: readonly number[]): SimRng {
  let i = 0;
  return () => (tape[i++] ?? 0) / 0x10000;
}

/** Throws with the sim's event trace, so fast-check reports the shrunk sequence. */
function fail(sim: SessionSim, msg: string): never {
  throw new Error(`${msg}\n${sim.formatTrace()}`);
}

const fmt = (e: SessionEvent): string => JSON.stringify(e);

/** Property 6: where a `workerFailed` may lead from `prev` (`restarts`: restarts already made this wake). */
const workerFailureOk = (prev: StateName, next: StateName, restarts: number): boolean =>
  prev === 'Waking'
    ? next === 'Error' || (next === 'Waking' && restarts === 0)
    : next === 'Cooldown' || next === 'Error';

/** The own keys whose values differ (by `Object.is`) between `a` and `b`, or that only one of them has. */
function changedKeys(a: object, b: object): string[] {
  const out = Object.keys(a).filter(
    (k) => !Object.hasOwn(b, k) || !Object.is(Reflect.get(a, k), Reflect.get(b, k)),
  );
  for (const k of Object.keys(b)) if (!Object.hasOwn(a, k)) out.push(k);
  return out;
}

/** Value equality of presets, field by field, as the reducer decides whether a preset changed. */
const samePreset = (a: VoicePreset, b: VoicePreset): boolean => changedKeys(a, b).length === 0;

/** Property 10's probe preset that differs from `p`: Chipmunk, or Big bear when `p` is Chipmunk. */
const otherPreset = (p: VoicePreset): VoicePreset =>
  samePreset(p, PRESETS.chipmunk) ? PRESETS.bigbear : PRESETS.chipmunk;

/**
 * Property 10 (issue #210): what is wrong when `settingsChanged{preset}` takes `prev` to `next` with
 * `effects`, or null. No effects; an equal preset keeps the very same state object; another changes only
 * `preset`.
 */
function settingsChangedViolation(
  prev: SessionState,
  preset: VoicePreset,
  next: SessionState,
  effects: readonly Effect[],
): string | null {
  if (effects.length > 0) return `emitted [${effects.map((fx) => fx.k).join(', ')}]`;
  if (samePreset(preset, prev.preset)) {
    return next === prev ? null : 'returned a new state object for an equal preset';
  }
  const changed = changedKeys(prev, next);
  if (changed.length !== 1 || changed[0] !== 'preset') return `changed [${changed.join(', ')}], not [preset]`;
  return samePreset(next.preset, preset) ? null : `stored ${JSON.stringify(next.preset)}`;
}

/**
 * Runs a walk with user events allowed. `onTransition` sees every transition after its effects were applied;
 * `onState` sees the initial state and the state after every step.
 */
function runWalk(
  w: Walk,
  onTransition: (t: Transition, sim: SessionSim) => void,
  onState: (sim: SessionSim) => void = () => {},
): SessionSim {
  const sim = new SessionSim({ permission: w.permission, mic: w.mic, lossRate: w.lossRate });
  onState(sim);
  for (const tape of w.steps) {
    const t = sim.step(tapeRng(tape), true);
    if (t !== null) onTransition(t, sim);
    onState(sim);
  }
  return sim;
}

const property = (check: (w: Walk) => void): void => {
  fc.assert(
    fc.property(walkArb, (w) => {
      check(w);
    }),
    { numRuns: RUNS },
  );
};

describe('session reducer properties (plan §4.9.1)', () => {
  it('1: no arm while anything is audible or the state is gated', () => {
    let arms = 0;
    let armsAfterAudio = 0;
    property((w) => {
      runWalk(w, (t, sim) => {
        for (const a of t.arms) {
          arms++;
          if (a.voiceUntil > 0 || a.sfxUntil > 0) armsAfterAudio++;
          if (a.at < a.voiceUntil) {
            fail(sim, `P1: arm at ${a.at} ms, replay audible until ${a.voiceUntil} ms`);
          }
          if (a.at < a.sfxUntil) {
            fail(sim, `P1: arm at ${a.at} ms, sfx audible until ${a.sfxUntil} ms`);
          }
          if (t.next.name !== 'Listening') fail(sim, `P1: arm on a transition into ${t.next.name}`);
        }
      });
    });
    expect(arms).toBeGreaterThan(0);
    expect(armsAfterAudio).toBeGreaterThan(0);
  });

  it('2: sfx only on a transition into SfxGated or within MicDenied', () => {
    let gated = 0;
    let micDenied = 0;
    property((w) => {
      runWalk(w, (t, sim) => {
        for (const fx of t.effects) {
          if (fx.k !== 'sfx') continue;
          if (t.next.name === 'SfxGated') gated++;
          else if (t.prev.name === 'MicDenied' && t.next.name === 'MicDenied') micDenied++;
          else fail(sim, `P2: sfx on ${t.prev.name} -> ${t.next.name}`);
        }
      });
    });
    expect(gated).toBeGreaterThan(0);
    expect(micDenied).toBeGreaterThan(0);
  });

  it('3: every transition that ends in Listening leaves the sleep and doze timers pending', () => {
    let listening = 0;
    let dozes = 0;
    property((w) => {
      runWalk(w, (t, sim) => {
        if (t.next.name !== 'Listening') return;
        listening++;
        if (t.event.t === 'timer' && t.event.name === 'doze') dozes++;
        if (!sim.timers.has('sleep') || !sim.timers.has('doze')) {
          fail(sim, `P3: Listening with timers [${[...sim.timers.keys()].join(', ')}]`);
        }
      });
    });
    expect(listening).toBeGreaterThan(0);
    expect(dozes).toBeGreaterThan(0);
  });

  it('4: liveness: with no current events injected, Asleep or Paused within the bound', () => {
    let livePhases = 0;
    const timeouts = { waking: 0, processing: 0 }; // rows 9 and 26 fire only when the loss mode drops an answer
    const countTimeout = (t: Transition): void => {
      if (t.event.t !== 'timer') return;
      if (t.prev.name === 'Waking' && t.event.name === 'waking') timeouts.waking++;
      if (t.prev.name === 'Processing' && t.event.name === 'processing') timeouts.processing++;
    };
    fc.assert(
      fc.property(lossyWalkArb, fc.array(stepArb, { maxLength: 64, size: 'max' }), (w, tail) => {
        const sim = runWalk(w, countTimeout, (x) => {
          if (!TERMINAL.has(x.state.name) && !x.hasPending()) {
            fail(x, `P4: stalled in ${x.state.name}: nothing pending`);
          }
        });
        const t0 = sim.now;
        const from = sim.state.name;
        if (!TERMINAL.has(from)) livePhases++;
        for (let i = 0; !TERMINAL.has(sim.state.name); i++) {
          if (sim.now - t0 > LIVENESS_BOUND_MS) {
            fail(
              sim,
              `P4: still ${sim.state.name} ${sim.now - t0} ms after the liveness phase began in ${from}`,
            );
          }
          if (i >= MAX_LIVENESS_STEPS) fail(sim, `P4: no progress after ${i} liveness steps`);
          const t = sim.step(tapeRng(tail[i] ?? []), false);
          if (t === null) fail(sim, `P4: stalled in ${sim.state.name}: nothing pending`);
          if (t.source === 'inject' && !t.stale) fail(sim, `P4: current ${fmt(t.event)} injected`);
          countTimeout(t);
        }
        if (sim.now - t0 > LIVENESS_BOUND_MS) {
          fail(sim, `P4: reached ${sim.state.name} after ${sim.now - t0} ms (bound ${LIVENESS_BOUND_MS} ms)`);
        }
        // Nothing current is injected, so nothing can hide the page: a phase that didn't start Paused must end
        // Asleep (stricter than the issue's "Asleep or Paused", which it implies; D20).
        if (from !== 'Paused' && sim.state.name !== 'Asleep') {
          fail(sim, `P4: the liveness phase began in ${from} but ended in ${sim.state.name}, not Asleep`);
        }
      }),
      { numRuns: RUNS },
    );
    expect(livePhases).toBeGreaterThan(0);
    expect(timeouts.waking).toBeGreaterThan(0);
    expect(timeouts.processing).toBeGreaterThan(0);
  });

  it('5: stale events are inert in every reachable state', () => {
    let dispatched = 0;
    let staleMic = 0;
    let probes = 0;
    property((w) => {
      runWalk(
        w,
        (t, sim) => {
          if (!t.stale) return;
          dispatched++;
          if (t.event.t === 'micGranted' || t.event.t === 'micDenied' || t.event.t === 'noDevice') staleMic++;
          if (t.next !== t.prev || t.effects.length > 0) {
            fail(sim, `P5: stale ${fmt(t.event)} changed ${t.prev.name}`);
          }
        },
        (sim) => {
          for (const e of sim.staleVariants()) {
            probes++;
            const out = reduce(sim.state, e);
            if (out.state !== sim.state || out.effects.length > 0) {
              fail(sim, `P5: stale ${fmt(e)} changed ${sim.state.name} (probe)`);
            }
          }
        },
      );
    });
    expect(dispatched).toBeGreaterThan(0);
    expect(staleMic).toBeGreaterThan(0);
    expect(probes).toBeGreaterThan(0);
  });

  it('6: a worker failure leads to Cooldown or Error (Waking: stays once, then Error)', () => {
    const seen = new Map<StateName, number>();
    property((w) => {
      runWalk(
        w,
        (t, sim) => {
          if (t.event.t !== 'workerFailed' || !MIC_OPEN.has(t.prev.name)) return;
          if (!workerFailureOk(t.prev.name, t.next.name, t.prev.workerRestarts)) {
            fail(sim, `P6: workerFailed: ${t.prev.name} -> ${t.next.name}`);
          }
        },
        (sim) => {
          const s = sim.state;
          if (!MIC_OPEN.has(s.name)) return;
          seen.set(s.name, (seen.get(s.name) ?? 0) + 1);
          const next = reduce(s, { t: 'workerFailed' }).state;
          if (!workerFailureOk(s.name, next.name, s.workerRestarts)) {
            fail(sim, `P6: workerFailed (probe): ${s.name} -> ${next.name}`);
          }
        },
      );
    });
    expect([...seen.keys()].toSorted()).toEqual([...MIC_OPEN].toSorted());
  });

  it('7: no arm while a reselectPending input change is outstanding', () => {
    let arms = 0;
    let reselects = 0;
    property((w) => {
      let outstanding = false; // an input change seen in a gated state (row 40b), not yet re-selected
      runWalk(w, (t, sim) => {
        if (t.event.t === 'inputsChanged' && GATED.has(t.prev.name)) outstanding = true;
        for (const fx of t.effects) {
          if (fx.k === 'reselectInput' && t.prev.reselectPending) reselects++;
          if (fx.k === 'closeMic' || fx.k === 'reselectInput') outstanding = false;
          if (fx.k !== 'arm') continue;
          arms++;
          if (t.prev.reselectPending || t.next.reselectPending || outstanding) {
            fail(sim, `P7: arm on ${t.prev.name} -> ${t.next.name} with a re-selection pending`);
          }
        }
      });
    });
    expect(arms).toBeGreaterThan(0);
    expect(reselects).toBeGreaterThan(0);
  });

  it('8: the mic stream is open iff the state is mic-open', () => {
    let open = 0;
    let staleGrants = 0;
    property((w) => {
      runWalk(w, (t, sim) => {
        const s = sim.state;
        if (sim.micOpen) open++;
        if (t.event.t === 'micGranted' && t.stale) {
          // The runner stops a stale grant at once: the stream stays closed (issue #29, "Mic results").
          staleGrants++;
          if (sim.micOpen) fail(sim, `P8: the stream is open after a stale micGranted`);
        }
        if (sim.micOpen && !MIC_OPEN.has(s.name)) fail(sim, `P8: mic open in ${s.name}`);
        if (sim.openWhileOpen > 0) fail(sim, `P8: openMic while the stream was still open`);
        // Stronger than the issue's `MIC_OPEN∖{Waking} ∧ micGranted ⇒ micOpen`: past Waking the stream must be
        // open whatever the reducer's own `micGranted` says (review thread on #199, D19).
        if (MIC_OPEN.has(s.name) && s.name !== 'Waking' && !sim.micOpen) {
          fail(sim, `P8: ${s.name} (micGranted ${s.micGranted}) but the mic is closed`);
        }
      });
    });
    expect(open).toBeGreaterThan(0);
    expect(staleGrants).toBeGreaterThan(0);
  });

  it('9: a failing property reports its shrunk event trace', () => {
    // A deliberately false claim ("the bear never listens"), run like the properties above, with the default
    // `verbose`. fc.assert throws the report (seed, shrunk counterexample) with the property's error, which
    // carries the event trace, as its cause; Vitest prints both.
    let thrown: unknown = null;
    try {
      fc.assert(
        fc.property(walkArb, (w) => {
          runWalk(w, (t, sim) => {
            if (t.next.name === 'Listening') fail(sim, 'reached Listening');
          });
        }),
        { numRuns: RUNS },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const report = thrown instanceof Error ? thrown : new Error();
    expect(report.message).toMatch(/Counterexample: /);
    expect(report.message).toMatch(/Shrunk \d+ time/);
    expect(report.cause).toBeInstanceOf(Error);
    const trace = report.cause instanceof Error ? report.cause.message : '';
    expect(trace).toMatch(/^reached Listening\ntrace \(\d+ events\):\n/);
    // Only tapBear and settingsRetry (#266) leave Asleep, identically, so the shrinker keeps the tap.
    expect(trace).toMatch(/ inject tapBear: Asleep -> /);
    expect(trace).toMatch(/: \w+ -> Listening \[/);
  });

  it('10: settingsChanged changes only the preset and emits nothing (equal preset: same state)', () => {
    const injectedIn = new Set<StateName>();
    const probedIn = new Set<StateName>();
    let keptByWalk = 0; // injected with a preset equal to the current one
    let changedByWalk = 0;
    let customByWalk = 0; // injected with a Custom preset from the slider's grid
    property((w) => {
      runWalk(
        w,
        (t, sim) => {
          if (t.event.t !== 'settingsChanged') return;
          injectedIn.add(t.prev.name);
          if (t.next === t.prev) keptByWalk++;
          else changedByWalk++;
          if (t.event.preset.id === 'custom') customByWalk++;
          const why = settingsChangedViolation(t.prev, t.event.preset, t.next, t.effects);
          if (why !== null) fail(sim, `P10: ${fmt(t.event)} in ${t.prev.name} ${why}`);
        },
        (sim) => {
          // Probes: another preset, and an equal one as a new object (as presetFor builds every Custom one).
          const s = sim.state;
          probedIn.add(s.name);
          for (const preset of [otherPreset(s.preset), { ...s.preset }]) {
            const e: SessionEvent = { t: 'settingsChanged', preset };
            const out = reduce(s, e);
            const why = settingsChangedViolation(s, preset, out.state, out.effects);
            if (why !== null) fail(sim, `P10: ${fmt(e)} in ${s.name} ${why} (probe)`);
          }
        },
      );
    });
    expect(injectedIn.size).toBeGreaterThanOrEqual(10);
    expect(keptByWalk).toBeGreaterThan(0);
    expect(changedByWalk).toBeGreaterThan(0);
    expect(customByWalk).toBeGreaterThan(0);
    expect([...probedIn].toSorted()).toEqual(Object.keys(TABLE).toSorted());
  });

  it('11: updateReady{activated} makes an Asleep tap or retry reload, and changes nothing else (#277)', () => {
    const PROBES: SessionEvent[] = [
      { t: 'tapBear' },
      { t: 'settingsRetry' },
      { t: 'visible' },
      { t: 'hidden' },
      { t: 'parentContinue' },
    ];
    const probedIn = new Set<StateName>();
    let asleepReloads = 0;
    property((w) => {
      runWalk(
        w,
        () => {},
        (sim) => {
          const s = sim.state;
          probedIn.add(s.name);
          const a = reduce(s, { t: 'updateReady', activated: true });
          if (a.effects.length > 0 || !a.state.updateActivated || !a.state.updateReady) {
            fail(
              sim,
              `P11: updateReady{activated} in ${s.name} emitted ${a.effects.length} effects or set no flag`,
            );
          }
          const b = reduce(s, { t: 'updateReady' });
          for (const e of PROBES) {
            const x = reduce(a.state, e);
            const y = reduce(b.state, e);
            if (s.name === 'Asleep' && (e.t === 'tapBear' || e.t === 'settingsRetry')) {
              asleepReloads++;
              if (x.state !== a.state || x.effects.length !== 1 || x.effects[0]?.k !== 'applyUpdate') {
                fail(
                  sim,
                  `P11: ${fmt(e)} in flagged Asleep emitted [${x.effects.map((f) => f.k).join(', ')}]`,
                );
              }
              continue;
            }
            // Cheap comparisons (this runs for every reachable state): effects by value, states key by key.
            if (JSON.stringify(x.effects) !== JSON.stringify(y.effects)) {
              fail(sim, `P11: the flag changed the effects of ${fmt(e)} in ${s.name}`);
            }
            const changed = changedKeys(
              { ...x.state, updateActivated: false },
              { ...y.state, updateActivated: false },
            );
            if (changed.length > 0)
              fail(sim, `P11: the flag changed [${changed.join(', ')}] on ${fmt(e)} in ${s.name}`);
          }
        },
      );
    });
    expect([...probedIn].toSorted()).toEqual(Object.keys(TABLE).toSorted());
    expect(asleepReloads).toBeGreaterThan(0);
  });
});
