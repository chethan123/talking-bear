import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AnimEvent } from '../app/events.ts';
import type { BaseName } from './base-poses.ts';
import { SESSION_CLIPS } from './clips/session.ts';
import { directorReduce, evaluate, initialDirector } from './director.ts';
import type { DirectorState, DirInput, DirState } from './director.ts';
import { Ch, CH_COUNT, createPose } from './pose.ts';

type AnimKind = AnimEvent['e'];
/** A target state, `=` (the same state object back) or `clip` (the additive-clip rule). */
type Outcome = DirState | '=' | 'clip';

// ---- test-side transcription of issue #79 and the approved plan (not imported from the module) -----------
/** Every director state, keyed by itself; a missing or misspelt one is a compile error. */
const STATE_SET = {
  Asleep: 'Asleep',
  Waking: 'Waking',
  Idle: 'Idle',
  Attentive: 'Attentive',
  Thinking: 'Thinking',
  Talking: 'Talking',
  Reacting: 'Reacting',
  Sustained: 'Sustained',
  Dozing: 'Dozing',
} as const satisfies { readonly [S in DirState]: S };
const STATES: readonly DirState[] = Object.values(STATE_SET);

/** One representative event per `AnimEvent` kind; a missing kind is a compile error. */
const SAMPLES: { readonly [K in AnimKind]: Extract<AnimEvent, { e: K }> } = {
  wake: { e: 'wake' },
  sleep: { e: 'sleep' },
  doze: { e: 'doze' },
  idle: { e: 'idle' },
  attentive: { e: 'attentive' },
  thinking: { e: 'thinking' },
  talk: { e: 'talk', id: 7 },
  talkEnd: { e: 'talkEnd' },
  confused: { e: 'confused' },
  earTwitch: { e: 'earTwitch' },
  shrug: { e: 'shrug' },
  reaction: { e: 'reaction', name: 'giggle', priority: 2 },
};
const KINDS: readonly AnimKind[] = Object.values(SAMPLES).map((ev) => ev.e);

/** The session clips by name, as the tests start them; checked against `SESSION_CLIPS` below. */
const CLIP_NAMES = ['wake', 'sleep', 'earTwitch', 'confused', 'shrug'] as const;
type ClipName = (typeof CLIP_NAMES)[number];

/** Issue #79 "Base mapping". Reacting and Sustained: a test-only representative (M4 never enters them). */
const BASE_OF_STATE: Record<DirState, BaseName> = {
  Asleep: 'asleep',
  Waking: 'idle',
  Idle: 'idle',
  Attentive: 'attentive',
  Thinking: 'thinking',
  Talking: 'talking',
  Reacting: 'idle',
  Sustained: 'idle',
  Dozing: 'dozing',
};

/** The mouth channels, which only the mouth layer writes. */
const MOUTH: readonly number[] = [Ch.Jaw, Ch.MouthW, Ch.MouthRound, Ch.Teeth];

/** Plan decision D1: the outcome of every (state, event) pair. */
const D1 = `
state      wake    sleep   doze    idle  attentive  thinking  talk     talkEnd  confused earTwitch shrug reaction
Asleep     Waking  =       =       Idle  =          =         =        =        clip     clip      clip  =
Waking     =       Asleep  =       Idle  =          =         =        =        =        =         =     =
Idle       Waking  Asleep  Dozing  =     Attentive  =         =        =        clip     clip      clip  =
Attentive  Waking  Asleep  =       Idle  =          Thinking  =        =        clip     clip      clip  =
Thinking   Waking  Asleep  =       Idle  =          =         Talking  =        clip     clip      clip  =
Talking    Waking  Asleep  =       Idle  =          =         =        Idle     clip     clip      clip  =
Reacting   Waking  Asleep  =       Idle  =          =         =        =        clip     clip      clip  =
Sustained  Waking  Asleep  =       Idle  =          =         =        =        clip     clip      clip  =
Dozing     Waking  Asleep  =       Idle  Attentive  =         =        =        clip     clip      clip  =
`;

function isOutcome(x: string): x is Outcome {
  return x === '=' || x === 'clip' || Object.hasOwn(STATE_SET, x);
}

/** `D1` parsed: rows by state, cells by event kind. Throws on any malformed cell. */
function parseTable(text: string): { head: string[]; rows: Map<string, Map<string, Outcome>> } {
  const lines = text
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/));
  const head = lines[0]!.slice(1);
  const rows = new Map<string, Map<string, Outcome>>();
  for (const [name, ...cells] of lines.slice(1)) {
    const row = new Map<string, Outcome>();
    cells.forEach((c, j) => {
      if (!isOutcome(c)) throw new Error(`bad cell ${c} in row ${name}`);
      row.set(head[j]!, c);
    });
    rows.set(name!, row);
  }
  return { head, rows };
}
const EXPECTED = parseTable(D1);

function expected(state: DirState, kind: AnimKind): Outcome {
  const o = EXPECTED.rows.get(state)?.get(kind);
  if (o === undefined) throw new Error(`no D1 cell for ${state} × ${kind}`);
  return o;
}

// ---- helpers ------------------------------------------------------------------------------------------------
const anim = (ev: AnimEvent, now: number): DirInput => ({ k: 'anim', ev, now });
const tick = (now: number): DirInput => ({ k: 'tick', now });

/** Folds `directorReduce` over `inputs`. */
function run(s: DirectorState, ...inputs: DirInput[]): DirectorState {
  let r = s;
  for (const i of inputs) r = directorReduce(r, i);
  return r;
}

/**
 * A consistent state in `name` entered at `t0`: `prevBase` differs from `base` and its fade finished at
 * `t0 − 1`, so a transition that forgets to move `prevBase` or `fadeStart` shows. Waking plays its wake clip,
 * Talking has a talk, and every other state keeps a stale `mouthCloseStart` from an earlier talkEnd.
 */
function stateIn(name: DirState, t0 = 10): DirectorState {
  const base = BASE_OF_STATE[name];
  return {
    name,
    since: t0,
    base,
    prevBase: base === 'dozing' ? 'attentive' : 'dozing',
    fadeStart: t0 - 1,
    clip: name === 'Waking' ? { name: 'wake', start: t0 } : null,
    talk: name === 'Talking' ? { id: 3, startCtxTime: null } : null,
    mouthCloseStart: name === 'Talking' ? null : t0 - 1,
  };
}

/** `stateIn(name)` plus, except for Waking, the same state with a clip still playing at 10.5. */
function variants(name: DirState): DirectorState[] {
  const plain = stateIn(name);
  if (name === 'Waking') return [plain];
  return [plain, { ...plain, clip: { name: name === 'Asleep' ? 'sleep' : 'shrug', start: 10.2 } }];
}

/** Freezes `s` and its nested objects, so any write by the reducer throws (ES modules are strict). */
function deepFreeze(s: DirectorState): DirectorState {
  if (s.clip !== null) Object.freeze(s.clip);
  if (s.talk !== null) Object.freeze(s.talk);
  return Object.freeze(s);
}

/** The plan's transition rules, spelled out: `s` moved to `target` at `now` by the sample event. */
function expectedEnter(s: DirectorState, target: DirState, now: number): DirectorState {
  const base = BASE_OF_STATE[target];
  const moved = base !== s.base;
  let clip: DirectorState['clip'];
  if (target === 'Waking') clip = { name: 'wake', start: now };
  else if (target === 'Asleep') clip = { name: 'sleep', start: now };
  else clip = s.clip?.name === 'sleep' ? null : s.clip;
  return {
    name: target,
    since: now,
    base,
    prevBase: moved ? s.base : s.prevBase,
    fadeStart: moved ? now : s.fadeStart,
    clip,
    talk: target === 'Talking' ? { id: 7, startCtxTime: null } : null,
    mouthCloseStart: target === 'Talking' ? null : s.name === 'Talking' ? now : s.mouthCloseStart,
  };
}

/** `start + duration` of a session clip, computed as the director computes it. */
function endOf(name: ClipName, start: number): number {
  return start + SESSION_CLIPS[name].duration;
}

// ---- Validation 1: every edge of the plan §3.5 diagram that M4 covers ------------------------------------------
// Not covered in M4 (reaction rules, M5 / #91): Idle → Reacting, Idle → Sustained, Reacting → Idle,
// Sustained → Idle. Sources come from `stateIn`, where prevBase ≠ base, so each base change must move prevBase.
describe('Validation 1: §3.5 diagram edges', () => {
  it('[*] → Asleep: initialDirector', () => {
    expect(initialDirector(2)).toStrictEqual({
      name: 'Asleep',
      since: 2,
      base: 'asleep',
      prevBase: 'asleep',
      fadeStart: 2,
      clip: null,
      talk: null,
      mouthCloseStart: null,
    });
  });

  it('Asleep → Waking: wake plays the wake clip and starts the asleep → idle crossfade', () => {
    expect(run(stateIn('Asleep'), anim({ e: 'wake' }, 10.5))).toStrictEqual({
      name: 'Waking',
      since: 10.5,
      base: 'idle',
      prevBase: 'asleep',
      fadeStart: 10.5,
      clip: { name: 'wake', start: 10.5 },
      talk: null,
      mouthCloseStart: 9,
    });
  });

  it('Waking → Idle: a tick at the wake clip end (not before) moves to Idle and clears the clip', () => {
    const waking = run(stateIn('Asleep'), anim({ e: 'wake' }, 10.5));
    const end = endOf('wake', 10.5);
    expect(directorReduce(waking, tick(end - 1e-9))).toBe(waking);
    expect(directorReduce(waking, tick(end))).toStrictEqual({
      name: 'Idle',
      since: end,
      base: 'idle',
      prevBase: 'asleep', // the base stays idle, so the running fade is kept
      fadeStart: 10.5,
      clip: null,
      talk: null,
      mouthCloseStart: 9,
    });
  });

  it('Idle → Attentive: attentive (speech onset)', () => {
    expect(run(stateIn('Idle'), anim({ e: 'attentive' }, 10.5))).toStrictEqual({
      name: 'Attentive',
      since: 10.5,
      base: 'attentive',
      prevBase: 'idle',
      fadeStart: 10.5,
      clip: null,
      talk: null,
      mouthCloseStart: 9,
    });
  });

  it('Attentive → Thinking: thinking (speech end)', () => {
    expect(run(stateIn('Attentive'), anim({ e: 'thinking' }, 10.5))).toStrictEqual({
      name: 'Thinking',
      since: 10.5,
      base: 'thinking',
      prevBase: 'attentive',
      fadeStart: 10.5,
      clip: null,
      talk: null,
      mouthCloseStart: 9,
    });
  });

  it('Attentive → Idle: misfire (session row 21 sends earTwitch, then idle); the ear twitch plays on', () => {
    expect(
      run(stateIn('Attentive'), anim({ e: 'earTwitch' }, 10.5), anim({ e: 'idle' }, 10.5)),
    ).toStrictEqual({
      name: 'Idle',
      since: 10.5,
      base: 'idle',
      prevBase: 'attentive',
      fadeStart: 10.5,
      clip: { name: 'earTwitch', start: 10.5 },
      talk: null,
      mouthCloseStart: 9,
    });
  });

  it('Thinking → Talking: talk{id} sets talk and clears a stale mouthCloseStart', () => {
    expect(run(stateIn('Thinking'), anim({ e: 'talk', id: 7 }, 10.5))).toStrictEqual({
      name: 'Talking',
      since: 10.5,
      base: 'talking',
      prevBase: 'thinking',
      fadeStart: 10.5,
      clip: null,
      talk: { id: 7, startCtxTime: null },
      mouthCloseStart: null,
    });
  });

  it('Talking → Idle: talkEnd sets mouthCloseStart = now and clears talk', () => {
    expect(run(stateIn('Talking'), anim({ e: 'talkEnd' }, 10.5))).toStrictEqual({
      name: 'Idle',
      since: 10.5,
      base: 'idle',
      prevBase: 'talking',
      fadeStart: 10.5,
      clip: null,
      talk: null,
      mouthCloseStart: 10.5,
    });
  });

  it('Idle → Dozing: doze', () => {
    expect(run(stateIn('Idle'), anim({ e: 'doze' }, 10.5))).toStrictEqual({
      name: 'Dozing',
      since: 10.5,
      base: 'dozing',
      prevBase: 'idle',
      fadeStart: 10.5,
      clip: null,
      talk: null,
      mouthCloseStart: 9,
    });
  });

  it('Dozing → Idle: idle', () => {
    expect(run(stateIn('Dozing'), anim({ e: 'idle' }, 10.5))).toStrictEqual({
      name: 'Idle',
      since: 10.5,
      base: 'idle',
      prevBase: 'dozing',
      fadeStart: 10.5,
      clip: null,
      talk: null,
      mouthCloseStart: 9,
    });
  });

  it('Dozing → Attentive: attentive', () => {
    expect(run(stateIn('Dozing'), anim({ e: 'attentive' }, 10.5))).toStrictEqual({
      name: 'Attentive',
      since: 10.5,
      base: 'attentive',
      prevBase: 'dozing',
      fadeStart: 10.5,
      clip: null,
      talk: null,
      mouthCloseStart: 9,
    });
  });

  it('Dozing → Waking: wake (issue: wake leaves Dozing) plays the wake clip', () => {
    expect(run(stateIn('Dozing'), anim({ e: 'wake' }, 10.5))).toStrictEqual({
      name: 'Waking',
      since: 10.5,
      base: 'idle',
      prevBase: 'dozing',
      fadeStart: 10.5,
      clip: { name: 'wake', start: 10.5 },
      talk: null,
      mouthCloseStart: 9,
    });
  });

  it('Dozing → Asleep: sleep plays the sleep clip', () => {
    expect(run(stateIn('Dozing'), anim({ e: 'sleep' }, 10.5))).toStrictEqual({
      name: 'Asleep',
      since: 10.5,
      base: 'asleep',
      prevBase: 'dozing',
      fadeStart: 10.5,
      clip: { name: 'sleep', start: 10.5 },
      talk: null,
      mouthCloseStart: 9,
    });
  });

  it('Idle → Asleep: sleep plays the sleep clip', () => {
    expect(run(stateIn('Idle'), anim({ e: 'sleep' }, 10.5))).toStrictEqual({
      name: 'Asleep',
      since: 10.5,
      base: 'asleep',
      prevBase: 'idle',
      fadeStart: 10.5,
      clip: { name: 'sleep', start: 10.5 },
      talk: null,
      mouthCloseStart: 9,
    });
  });
});

// ---- Validation 2: the full (state × event) cross product ------------------------------------------------------
describe('Validation 2: cross product (state × event)', () => {
  it('the D1 table lists exactly every state and every event kind', () => {
    expect(EXPECTED.head.toSorted()).toStrictEqual(KINDS.toSorted());
    expect([...EXPECTED.rows.keys()].toSorted()).toStrictEqual(STATES.toSorted());
    for (const row of EXPECTED.rows.values())
      expect([...row.keys()].toSorted()).toStrictEqual(KINDS.toSorted());
  });

  it('every pair: the D1 outcome; ignored → same object; frozen input never written', () => {
    const now = 10.5;
    let pairs = 0;
    for (const name of STATES) {
      for (const v of variants(name)) {
        for (const kind of KINDS) {
          const before = structuredClone(v);
          const s = deepFreeze(structuredClone(v));
          const r = directorReduce(s, anim(SAMPLES[kind], now));
          pairs++;
          expect(s, `${name} × ${kind}: input unchanged`).toStrictEqual(before);
          const o = expected(name, kind);
          if (o === '=') {
            expect(r, `${name} × ${kind}`).toBe(s);
          } else if (o === 'clip') {
            if (s.clip === null)
              expect(r, `${name} × ${kind}`).toStrictEqual({ ...s, clip: { name: kind, start: now } });
            else expect(r, `${name} × ${kind} while ${s.clip.name} plays`).toBe(s);
          } else {
            expect(r, `${name} × ${kind} → ${o}`).toStrictEqual(expectedEnter(s, o, now));
          }
        }
      }
    }
    expect(pairs).toBe(9 * 12 + 8 * 12);
  });

  it('an unknown event kind returns the same state object in every state', () => {
    const bogus: AnimEvent = { e: 'wake' };
    Reflect.set(bogus, 'e', 'bogus'); // an event kind the types don't know, as a newer sender might send
    for (const name of STATES)
      for (const s of variants(name)) expect(directorReduce(s, anim(bogus, 10.5))).toBe(s);
  });
});

// ---- session sequences (src/app/machine.ts rows) -------------------------------------------------------------
describe('session sequences', () => {
  it('happy path: wake, Listening idle mid-clip, attentive, thinking, talk, talkEnd, doze, sleep', () => {
    let s = run(initialDirector(0), anim({ e: 'wake' }, 1));
    // Row 6: Listening's entry sends idle while the wake clip still plays; Idle at once, the clip and fade go on.
    s = directorReduce(s, anim({ e: 'idle' }, 1.25));
    expect(s).toStrictEqual({
      name: 'Idle',
      since: 1.25,
      base: 'idle',
      prevBase: 'asleep',
      fadeStart: 1,
      clip: { name: 'wake', start: 1 },
      talk: null,
      mouthCloseStart: null,
    });
    const wakeEnd = endOf('wake', 1);
    expect(directorReduce(s, tick(wakeEnd - 1e-9))).toBe(s);
    s = directorReduce(s, tick(wakeEnd));
    expect(s.name).toBe('Idle');
    expect(s.since).toBe(1.25);
    expect(s.clip).toBeNull();
    s = run(s, anim({ e: 'attentive' }, 3), anim({ e: 'thinking' }, 4), anim({ e: 'talk', id: 1 }, 4.5));
    expect(s.name).toBe('Talking');
    expect(s.talk).toStrictEqual({ id: 1, startCtxTime: null });
    s = directorReduce(s, anim({ e: 'talkEnd' }, 6));
    expect(s.name).toBe('Idle');
    expect(s.mouthCloseStart).toBe(6);
    expect(directorReduce(s, anim({ e: 'idle' }, 6.25))).toBe(s); // row 35: Cooldown → Listening
    s = directorReduce(s, anim({ e: 'doze' }, 51));
    expect(s.name).toBe('Dozing');
    expect(directorReduce(s, anim({ e: 'doze' }, 96))).toBe(s); // row 16 re-arms doze every 45 s
    s = directorReduce(s, anim({ e: 'sleep' }, 141));
    expect(s).toMatchObject({ name: 'Asleep', base: 'asleep', prevBase: 'dozing', fadeStart: 141 });
    expect(s.clip).toStrictEqual({ name: 'sleep', start: 141 });
    s = directorReduce(s, tick(endOf('sleep', 141)));
    expect(s.name).toBe('Asleep');
    expect(s.clip).toBeNull();
  });

  it('NeedsParent flow (rows 4, 6): idle while Asleep, with no wake before it, moves to Idle', () => {
    expect(run(initialDirector(0), anim({ e: 'idle' }, 5))).toStrictEqual({
      name: 'Idle',
      since: 5,
      base: 'idle',
      prevBase: 'asleep',
      fadeStart: 5,
      clip: null,
      talk: null,
      mouthCloseStart: null,
    });
  });

  it('failed processing (rows 26, 35): confused then idle in Thinking → Idle, confused plays on', () => {
    const s = run(stateIn('Thinking'), anim({ e: 'confused' }, 10.5), anim({ e: 'idle' }, 10.6));
    expect(s).toMatchObject({ name: 'Idle', base: 'idle', prevBase: 'thinking', fadeStart: 10.6 });
    expect(s.clip).toStrictEqual({ name: 'confused', start: 10.5 });
  });

  it('Error → Asleep (row 43): sleep from Attentive and from Thinking plays the sleep clip', () => {
    for (const from of ['Attentive', 'Thinking'] as const) {
      const s = run(stateIn(from), anim({ e: 'sleep' }, 10.5));
      expect(s).toMatchObject({ name: 'Asleep', base: 'asleep', prevBase: BASE_OF_STATE[from] });
      expect(s.clip).toStrictEqual({ name: 'sleep', start: 10.5 });
    }
  });

  it('resume from Paused (rows 38, 39): wake in Thinking → Waking with the wake clip, then idle → Idle', () => {
    let s = run(stateIn('Thinking'), anim({ e: 'wake' }, 10.5));
    expect(s).toMatchObject({ name: 'Waking', base: 'idle', prevBase: 'thinking' });
    expect(s.clip).toStrictEqual({ name: 'wake', start: 10.5 });
    s = directorReduce(s, anim({ e: 'idle' }, 10.8));
    expect(s.name).toBe('Idle');
    expect(s.clip).toStrictEqual({ name: 'wake', start: 10.5 });
  });

  it('Waking → MicDenied (row 8): shrug while Waking changes nothing', () => {
    const s = run(stateIn('Asleep'), anim({ e: 'wake' }, 10.5));
    expect(directorReduce(s, anim({ e: 'shrug' }, 10.6))).toBe(s);
  });

  it('sleep while already Asleep is not replayed (ORCH-NOTE)', () => {
    const s = run(stateIn('Idle'), anim({ e: 'sleep' }, 10.5));
    expect(directorReduce(s, anim({ e: 'sleep' }, 10.6))).toBe(s);
    expect(directorReduce(s, anim({ e: 'sleep' }, 20))).toBe(s);
  });

  it('the sleep clip never outlives Asleep: idle mid-clip → Idle with no clip', () => {
    const s = run(stateIn('Idle'), anim({ e: 'sleep' }, 10.5), anim({ e: 'idle' }, 10.8));
    expect(s.name).toBe('Idle');
    expect(s.clip).toBeNull();
  });

  it('wake 0.05 s into the sleep clip replaces it with the wake clip (the known early-clip pop)', () => {
    const s = run(stateIn('Idle'), anim({ e: 'sleep' }, 10.5), anim({ e: 'wake' }, 10.55));
    expect(s).toMatchObject({ name: 'Waking', base: 'idle', prevBase: 'asleep', fadeStart: 10.55 });
    expect(s.clip).toStrictEqual({ name: 'wake', start: 10.55 });
  });

  it('talk.startCtxTime stays null: AnimEvent talk carries only the id', () => {
    const s = run(stateIn('Thinking'), anim({ e: 'talk', id: 42 }, 10.5));
    expect(s.talk).toStrictEqual({ id: 42, startCtxTime: null });
  });
});

/** A state whose clip `name` started at 10.5, reached the way the session reaches it. */
function playing(name: ClipName): DirectorState {
  if (name === 'wake') return run(stateIn('Asleep'), anim({ e: 'wake' }, 10.5));
  if (name === 'sleep') return run(stateIn('Idle'), anim({ e: 'sleep' }, 10.5));
  return run(stateIn('Idle'), anim(SAMPLES[name], 10.5));
}

// ---- clips and ticks -----------------------------------------------------------------------------------------
describe('clips and ticks', () => {
  it('each session clip: a tick before its end keeps it, a tick at its end clears it', () => {
    expect([...CLIP_NAMES].toSorted()).toStrictEqual(Object.keys(SESSION_CLIPS).toSorted());
    for (const name of CLIP_NAMES) {
      const s = playing(name);
      expect(s.clip, name).toStrictEqual({ name, start: 10.5 });
      const end = endOf(name, 10.5);
      expect(directorReduce(s, tick(end - 1e-9)), name).toBe(s);
      const r = directorReduce(s, tick(end));
      expect(r.clip, name).toBeNull();
      expect(r.name, name).toBe(name === 'wake' ? 'Idle' : s.name);
    }
  });

  it('an additive clip while another plays is dropped; after its end (before any tick) it starts', () => {
    for (const first of ['confused', 'earTwitch', 'shrug'] as const) {
      const s = playing(first);
      for (const next of ['confused', 'earTwitch', 'shrug'] as const) {
        expect(directorReduce(s, anim(SAMPLES[next], 10.51)), `${first} then ${next}`).toBe(s);
        const end = endOf(first, 10.5);
        expect(directorReduce(s, anim(SAMPLES[next], end)).clip).toStrictEqual({ name: next, start: end });
      }
    }
  });

  it('an additive clip is dropped while the wake clip plays on after Waking → Idle', () => {
    const s = run(stateIn('Asleep'), anim({ e: 'wake' }, 10.5), anim({ e: 'idle' }, 10.7));
    expect(directorReduce(s, anim({ e: 'earTwitch' }, 11))).toBe(s);
  });

  it('wake and sleep replace a playing additive clip', () => {
    const s = playing('confused');
    expect(directorReduce(s, anim({ e: 'wake' }, 10.6)).clip).toStrictEqual({ name: 'wake', start: 10.6 });
    expect(directorReduce(s, anim({ e: 'sleep' }, 10.6)).clip).toStrictEqual({ name: 'sleep', start: 10.6 });
  });

  it('an additive clip leaves name, since, base, prevBase and fadeStart alone', () => {
    const s = stateIn('Attentive');
    const r = directorReduce(s, anim({ e: 'confused' }, 10.5));
    expect(r).toStrictEqual({ ...s, clip: { name: 'confused', start: 10.5 } });
  });

  it('10 000 ticks with nothing to do all return the same object', () => {
    const s = stateIn('Idle');
    let same = 0;
    for (let i = 0; i < 10_000; i++) if (directorReduce(s, tick(10 + i * 0.01)) === s) same++;
    expect(same).toBe(10_000);
  });

  it('a Waking state without a clip moves to Idle on the next tick', () => {
    const s: DirectorState = { ...stateIn('Waking'), clip: null };
    expect(directorReduce(s, tick(10.5))).toStrictEqual({
      ...s,
      name: 'Idle',
      since: 10.5,
    });
  });

  it('an unknown clip counts as ended: the next tick clears it and an additive may start over it', () => {
    const s: DirectorState = { ...stateIn('Idle'), clip: { name: 'mystery', start: 10.4 } };
    expect(directorReduce(s, tick(10.5))).toStrictEqual({ ...s, clip: null });
    expect(directorReduce(s, anim({ e: 'earTwitch' }, 10.5)).clip).toStrictEqual({
      name: 'earTwitch',
      start: 10.5,
    });
  });
});

// ---- purity and invariants over random input sequences ------------------------------------------------------
describe('property: random session input sequences', () => {
  const STEP = fc.record({
    kind: fc.constantFrom<AnimKind | 'tick'>(...KINDS, 'tick'),
    dt: fc.integer({ min: 0, max: 200 }), // 10 ms grid, 0–2 s
  });

  it('keeps the invariants, is pure, and never writes the mouth channels (300 runs)', () => {
    fc.assert(
      fc.property(fc.array(STEP, { minLength: 1, maxLength: 60 }), (steps) => {
        let s = initialDirector(0);
        let now = 0;
        const out = createPose().fill(Number.NaN);
        for (const [j, m] of MOUTH.entries()) out[m] = 100 + j;
        for (const { kind, dt } of steps) {
          now += dt / 100;
          const prev = deepFreeze(s);
          const snapshot = structuredClone(prev);
          const r = directorReduce(prev, kind === 'tick' ? tick(now) : anim(SAMPLES[kind], now));
          expect(prev).toStrictEqual(snapshot); // I7: frozen input, never written
          expect(r.name === 'Reacting' || r.name === 'Sustained').toBe(false); // I1
          expect(r.base).toBe(BASE_OF_STATE[r.name]); // I2
          expect(r.talk !== null).toBe(r.name === 'Talking'); // I3
          if (r.talk !== null) expect(r.talk.startCtxTime).toBeNull();
          if (r.name === 'Waking') expect(r.clip?.name).toBe('wake'); // I4
          if (r.clip !== null) {
            expect(Object.hasOwn(SESSION_CLIPS, r.clip.name)).toBe(true); // I5
            expect(r.clip.start).toBeLessThanOrEqual(now);
          }
          expect(r === prev || !isDeepStrictEqual(r, prev)).toBe(true); // I6
          if (r.base !== prev.base) {
            // I8: a base change starts a crossfade from the previous base
            expect(r.prevBase).toBe(prev.base);
            expect(r.fadeStart).toBe(now);
          } else {
            expect(r.prevBase).toBe(prev.prevBase);
            expect(r.fadeStart).toBe(prev.fadeStart);
          }
          evaluate(r, now, out);
          for (const [j, m] of MOUTH.entries()) expect(out[m]).toBe(100 + j);
          for (let i = 0; i < CH_COUNT; i++)
            if (!MOUTH.includes(i)) expect(Number.isFinite(out[i])).toBe(true);
          s = r;
        }
      }),
      { numRuns: 300 },
    );
  });
});
