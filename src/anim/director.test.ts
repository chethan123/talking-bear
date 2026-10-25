import { isDeepStrictEqual } from 'node:util';
import { GCProfiler, setFlagsFromString } from 'node:v8';
import { runInNewContext, runInThisContext } from 'node:vm';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AnimEvent } from '../app/events.ts';
import { FENN } from '../characters/fenn.ts';
import type { Gesture } from '../input/recognizer.ts';
import type { RegionId } from '../input/region-ids.ts';
import { FENN_REACTIONS } from '../reactions/fenn-table.ts';
import { REACTIONS } from '../reactions/table.ts';
import type { Reaction } from '../reactions/table.ts';
import { BASE } from './base-poses.ts';
import type { BaseName } from './base-poses.ts';
import { sampleClip } from './clip.ts';
import { FENN_CLIPS } from './clips/fenn.ts';
import { MIME_CLIPS, REACTION_CLIPS } from './clips/reactions.ts';
import { SESSION_CLIPS } from './clips/session.ts';
import {
  CLIP_TEMPLATE,
  clipByName,
  createDirectorCast,
  CUT_CLIP_TEMPLATE,
  directorReduce,
  directorStep,
  evaluate,
  evaluateFrom,
  initialDirector,
  mouthCloseScale,
  REACTION_TEMPLATE,
} from './director.ts';
import type { DirectorState, DirInput, DirOut, DirState, GestureKind } from './director.ts';
import { Ch, CH_COUNT, addPose, createPose, lerpPose } from './pose.ts';
import type { Pose } from './pose.ts';
import { JUNI } from '../characters/juni.ts';

/** Juni's cast: every director call takes it (duck plan §4.1, T122). */
const CAST = JUNI.cast;

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

/** Issue #79 "Base mapping"; Reacting and Sustained are Idle's (#91). */
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

/** Plan decision D1: the outcome of every (state, event) pair; #91 changed Reacting's and Sustained's idle and attentive. */
const D1 = `
state      wake    sleep   doze    idle  attentive  thinking  talk     talkEnd  confused earTwitch shrug reaction
Asleep     Waking  =       =       Idle  =          =         =        =        clip     clip      clip  =
Waking     =       Asleep  =       Idle  =          =         =        =        =        =         =     =
Idle       Waking  Asleep  Dozing  =     Attentive  =         =        =        clip     clip      clip  =
Attentive  Waking  Asleep  =       Idle  =          Thinking  =        =        clip     clip      clip  =
Thinking   Waking  Asleep  =       Idle  =          =         Talking  =        clip     clip      clip  =
Talking    Waking  Asleep  =       Idle  =          =         =        Idle     clip     clip      clip  =
Reacting   Waking  Asleep  =       =     Attentive  =         =        =        clip     clip      clip  =
Sustained  Waking  Asleep  =       =     Attentive  =         =        =        clip     clip      clip  =
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
  for (const i of inputs) r = directorReduce(r, i, CAST);
  return r;
}

/** The reaction fields of a director with no reaction history, and no cut clip (`initialDirector`'s). */
const NO_REACTION = {
  prevClip: null,
  reaction: null,
  queued: null,
  cooldowns: [],
  repeats: [],
  gentle: false,
} as const satisfies Partial<DirectorState>;

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
    ...NO_REACTION,
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
  if (s.prevClip !== null) Object.freeze(s.prevClip);
  if (s.talk !== null) Object.freeze(s.talk);
  if (s.reaction !== null) Object.freeze(s.reaction);
  if (s.queued !== null) Object.freeze(s.queued);
  for (const c of s.cooldowns) Object.freeze(c);
  for (const e of s.repeats) Object.freeze(e);
  Object.freeze(s.cooldowns);
  Object.freeze(s.repeats);
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
  // #240: a new clip over one still playing cuts it (these states hold no reaction, so no release).
  const old = s.clip;
  const oldName = CLIP_NAMES.find((n) => n === old?.name);
  const cut =
    clip !== null && clip !== old && old !== null && oldName !== undefined && now < endOf(oldName, old.start);
  return {
    name: target,
    since: now,
    base,
    prevBase: moved ? s.base : s.prevBase,
    fadeStart: moved ? now : s.fadeStart,
    clip,
    prevClip: cut ? { name: old.name, start: old.start, cutAt: now, release: null } : s.prevClip,
    talk: target === 'Talking' ? { id: 7, startCtxTime: null } : null,
    mouthCloseStart: target === 'Talking' ? null : s.name === 'Talking' ? now : s.mouthCloseStart,
    reaction: s.reaction,
    queued: s.queued,
    cooldowns: s.cooldowns,
    repeats: s.repeats,
    gentle: s.gentle,
  };
}

/** `start + duration` of a session clip, computed as the director computes it. */
function endOf(name: ClipName, start: number): number {
  return start + SESSION_CLIPS[name].duration;
}

// ---- Validation 1: every edge of the plan §3.5 diagram that M4 covers ------------------------------------------
// The reaction edges (Idle → Reacting, Idle → Sustained, Reacting → Idle, Sustained → Idle, Dozing → Idle on a
// gesture) are tested under "#91" below. Sources come from `stateIn`, where prevBase ≠ base, so each base change
// must move prevBase.
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
      ...NO_REACTION,
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
      ...NO_REACTION,
    });
  });

  it('Waking → Idle: a tick at the wake clip end (not before) moves to Idle and clears the clip', () => {
    const waking = run(stateIn('Asleep'), anim({ e: 'wake' }, 10.5));
    const end = endOf('wake', 10.5);
    expect(directorReduce(waking, tick(end - 1e-9), CAST)).toBe(waking);
    expect(directorReduce(waking, tick(end), CAST)).toStrictEqual({
      name: 'Idle',
      since: end,
      base: 'idle',
      prevBase: 'asleep', // the base stays idle, so the running fade is kept
      fadeStart: 10.5,
      clip: null,
      talk: null,
      mouthCloseStart: 9,
      ...NO_REACTION,
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
      ...NO_REACTION,
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
      ...NO_REACTION,
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
      ...NO_REACTION,
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
      ...NO_REACTION,
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
      ...NO_REACTION,
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
      ...NO_REACTION,
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
      ...NO_REACTION,
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
      ...NO_REACTION,
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
      ...NO_REACTION,
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
      ...NO_REACTION,
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
      ...NO_REACTION,
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
          const r = directorReduce(s, anim(SAMPLES[kind], now), CAST);
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
      for (const s of variants(name)) expect(directorReduce(s, anim(bogus, 10.5), CAST)).toBe(s);
  });
});

// ---- session sequences (src/app/machine.ts rows) -------------------------------------------------------------
describe('session sequences', () => {
  it('happy path: wake, Listening idle mid-clip, attentive, thinking, talk, talkEnd, doze, sleep', () => {
    let s = run(initialDirector(0), anim({ e: 'wake' }, 1));
    // Row 6: Listening's entry sends idle while the wake clip still plays; Idle at once, the clip and fade go on.
    s = directorReduce(s, anim({ e: 'idle' }, 1.25), CAST);
    expect(s).toStrictEqual({
      name: 'Idle',
      since: 1.25,
      base: 'idle',
      prevBase: 'asleep',
      fadeStart: 1,
      clip: { name: 'wake', start: 1 },
      talk: null,
      mouthCloseStart: null,
      ...NO_REACTION,
    });
    const wakeEnd = endOf('wake', 1);
    expect(directorReduce(s, tick(wakeEnd - 1e-9), CAST)).toBe(s);
    s = directorReduce(s, tick(wakeEnd), CAST);
    expect(s.name).toBe('Idle');
    expect(s.since).toBe(1.25);
    expect(s.clip).toBeNull();
    s = run(s, anim({ e: 'attentive' }, 3), anim({ e: 'thinking' }, 4), anim({ e: 'talk', id: 1 }, 4.5));
    expect(s.name).toBe('Talking');
    expect(s.talk).toStrictEqual({ id: 1, startCtxTime: null });
    s = directorReduce(s, anim({ e: 'talkEnd' }, 6), CAST);
    expect(s.name).toBe('Idle');
    expect(s.mouthCloseStart).toBe(6);
    expect(directorReduce(s, anim({ e: 'idle' }, 6.25), CAST)).toBe(s); // row 35: Cooldown → Listening
    s = directorReduce(s, anim({ e: 'doze' }, 51), CAST);
    expect(s.name).toBe('Dozing');
    expect(directorReduce(s, anim({ e: 'doze' }, 96), CAST)).toBe(s); // row 16 re-arms doze every 45 s
    s = directorReduce(s, anim({ e: 'sleep' }, 141), CAST);
    expect(s).toMatchObject({ name: 'Asleep', base: 'asleep', prevBase: 'dozing', fadeStart: 141 });
    expect(s.clip).toStrictEqual({ name: 'sleep', start: 141 });
    s = directorReduce(s, tick(endOf('sleep', 141)), CAST);
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
      ...NO_REACTION,
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
    s = directorReduce(s, anim({ e: 'idle' }, 10.8), CAST);
    expect(s.name).toBe('Idle');
    expect(s.clip).toStrictEqual({ name: 'wake', start: 10.5 });
  });

  it('Waking → MicDenied (row 8): shrug while Waking changes nothing', () => {
    const s = run(stateIn('Asleep'), anim({ e: 'wake' }, 10.5));
    expect(directorReduce(s, anim({ e: 'shrug' }, 10.6), CAST)).toBe(s);
  });

  it('sleep while already Asleep is not replayed (ORCH-NOTE)', () => {
    const s = run(stateIn('Idle'), anim({ e: 'sleep' }, 10.5));
    expect(directorReduce(s, anim({ e: 'sleep' }, 10.6), CAST)).toBe(s);
    expect(directorReduce(s, anim({ e: 'sleep' }, 20), CAST)).toBe(s);
  });

  it('the sleep clip never outlives Asleep: idle mid-clip → Idle with no clip', () => {
    const s = run(stateIn('Idle'), anim({ e: 'sleep' }, 10.5), anim({ e: 'idle' }, 10.8));
    expect(s.name).toBe('Idle');
    expect(s.clip).toBeNull();
  });

  it('wake 0.05 s into the sleep clip replaces it with the wake clip; the sleep clip fades out under it (#240), the base fade restarts as before', () => {
    const s = run(stateIn('Idle'), anim({ e: 'sleep' }, 10.5), anim({ e: 'wake' }, 10.55));
    expect(s).toMatchObject({ name: 'Waking', base: 'idle', prevBase: 'asleep', fadeStart: 10.55 });
    expect(s.clip).toStrictEqual({ name: 'wake', start: 10.55 });
    expect(s.prevClip).toStrictEqual({ name: 'sleep', start: 10.5, cutAt: 10.55, release: null });
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
      expect(directorReduce(s, tick(end - 1e-9), CAST), name).toBe(s);
      const r = directorReduce(s, tick(end), CAST);
      expect(r.clip, name).toBeNull();
      expect(r.name, name).toBe(name === 'wake' ? 'Idle' : s.name);
    }
  });

  it('an additive clip while another plays is dropped; after its end (before any tick) it starts', () => {
    for (const first of ['confused', 'earTwitch', 'shrug'] as const) {
      const s = playing(first);
      for (const next of ['confused', 'earTwitch', 'shrug'] as const) {
        expect(directorReduce(s, anim(SAMPLES[next], 10.51), CAST), `${first} then ${next}`).toBe(s);
        const end = endOf(first, 10.5);
        expect(directorReduce(s, anim(SAMPLES[next], end), CAST).clip).toStrictEqual({
          name: next,
          start: end,
        });
      }
    }
  });

  it('an additive clip is dropped while the wake clip plays on after Waking → Idle', () => {
    const s = run(stateIn('Asleep'), anim({ e: 'wake' }, 10.5), anim({ e: 'idle' }, 10.7));
    expect(directorReduce(s, anim({ e: 'earTwitch' }, 11), CAST)).toBe(s);
  });

  it('wake and sleep replace a playing additive clip, which fades out under theirs (#240)', () => {
    const s = playing('confused');
    const cut = { name: 'confused', start: 10.5, cutAt: 10.6, release: null };
    for (const e of ['wake', 'sleep'] as const) {
      const r = directorReduce(s, anim({ e }, 10.6), CAST);
      expect(r.clip).toStrictEqual({ name: e, start: 10.6 });
      expect(r.prevClip).toStrictEqual(cut);
    }
  });

  it('an additive clip leaves name, since, base, prevBase and fadeStart alone', () => {
    const s = stateIn('Attentive');
    const r = directorReduce(s, anim({ e: 'confused' }, 10.5), CAST);
    expect(r).toStrictEqual({ ...s, clip: { name: 'confused', start: 10.5 } });
  });

  it('10 000 ticks with nothing to do all return the same object', () => {
    const s = stateIn('Idle');
    let same = 0;
    for (let i = 0; i < 10_000; i++) if (directorReduce(s, tick(10 + i * 0.01), CAST) === s) same++;
    expect(same).toBe(10_000);
  });

  it('a Waking state without a clip moves to Idle on the next tick', () => {
    const s: DirectorState = { ...stateIn('Waking'), clip: null };
    expect(directorReduce(s, tick(10.5), CAST)).toStrictEqual({
      ...s,
      name: 'Idle',
      since: 10.5,
    });
  });

  it('an unknown clip counts as ended: the next tick clears it and an additive may start over it', () => {
    const s: DirectorState = { ...stateIn('Idle'), clip: { name: 'mystery', start: 10.4 } };
    expect(directorReduce(s, tick(10.5), CAST)).toStrictEqual({ ...s, clip: null });
    expect(directorReduce(s, anim({ e: 'earTwitch' }, 10.5), CAST).clip).toStrictEqual({
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
          const r = directorReduce(prev, kind === 'tick' ? tick(now) : anim(SAMPLES[kind], now), CAST);
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
          if (r.prevClip !== null) {
            expect(Object.hasOwn(SESSION_CLIPS, r.prevClip.name)).toBe(true); // I9 (#240)
            expectCutClip(r.prevClip, kind === 'tick', now);
            if (r.prevClip !== prev.prevClip) expectSeamlessCut(prev, r, now);
          }
          expectNoWorseSecondCut(prev, r, now);
          expect(r === prev || !isDeepStrictEqual(r, prev)).toBe(true); // I6
          if (r.base !== prev.base) {
            // I8: a base change starts a crossfade from the previous base
            expect(r.prevBase).toBe(prev.base);
            expect(r.fadeStart).toBe(now);
          } else {
            expect(r.prevBase).toBe(prev.prevBase);
            expect(r.fadeStart).toBe(prev.fadeStart);
          }
          evaluate(r, now, out, false, CAST);
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

// ---- evaluation helpers ------------------------------------------------------------------------------------------
const DEG = Math.PI / 180;
const BASE_NAMES: readonly BaseName[] = ['asleep', 'idle', 'attentive', 'thinking', 'talking', 'dozing'];

/** The largest |a − b| over the non-mouth channels (NaN if either side is NaN there). */
function bodyDiff(a: Pose, b: Pose): number {
  let m = 0;
  for (let i = 0; i < CH_COUNT; i++) {
    if (MOUTH.includes(i)) continue;
    const d = Math.abs(a[i]! - b[i]!);
    m = d > m || Number.isNaN(d) ? d : m;
  }
  return m;
}

/** An independent crossfade + clip composite: `lerpPose(prev, base, clamp(dt/0.15)) + sampleClip(clip, …)`. */
function composite(s: DirectorState, now: number): Pose {
  const t = Math.min(1, Math.max(0, (now - s.fadeStart) / 0.15));
  const p = lerpPose(BASE[s.prevBase], BASE[s.base], t, createPose());
  if (s.clip === null) return p;
  const c = s.clip;
  const clip = CLIP_NAMES.find((n) => n === c.name);
  if (clip === undefined) return p;
  return addPose(p, sampleClip(SESSION_CLIPS[clip], now - c.start, createPose()), 1, p);
}

/**
 * #240 invariants of a `prevClip`: it started no later than its cut, which is no later than `now`, and a tick
 * (`ticked`) leaves none whose 100 ms are up.
 */
function expectCutClip(p: NonNullable<DirectorState['prevClip']>, ticked: boolean, now: number): void {
  expect(p.start).toBeLessThanOrEqual(p.cutAt);
  expect(p.cutAt).toBeLessThanOrEqual(now);
  if (ticked) expect(now).toBeLessThan(p.cutAt + 0.1);
}

/**
 * #240: the step from `prev` to `r` cut `prev`'s clip at `now`, so the pose at the cut is unchanged (±1e-6), unless
 * the step restarted a base crossfade that was still running (a pop of its own) or an earlier cut was still
 * blending (a second cut, plan Decision 5: `expectNoWorseSecondCut` covers it).
 */
function expectSeamlessCut(prev: DirectorState, r: DirectorState, now: number): void {
  expect(r.prevClip).toMatchObject({ name: prev.clip?.name, start: prev.clip?.start, cutAt: now });
  const sameFade = r.base === prev.base && r.prevBase === prev.prevBase && r.fadeStart === prev.fadeStart;
  const freshFade = r.fadeStart === now && r.prevBase === prev.base && now >= prev.fadeStart + 0.15;
  const blending = prev.prevClip !== null && now < prev.prevClip.cutAt + 0.1;
  if (!(sameFade || freshFade) || blending) return;
  const was = evaluate(prev, now, createPose(), false, CAST);
  expect(bodyDiff(evaluate(r, now, createPose(), false, CAST), was)).toBeLessThanOrEqual(1e-6);
}

/**
 * #240: a step that put another clip into the slot while `prev` was still fading an earlier cut out (a second
 * cut, plan Decision 5) never moves the pose more than main, with no crossfade at all, would (±1e-6), unless the
 * step restarted a base crossfade that was still running.
 */
function expectNoWorseSecondCut(prev: DirectorState, r: DirectorState, now: number): void {
  const p = prev.prevClip;
  const a = prev.clip;
  const b = r.clip;
  if (p === null || !(now < p.cutAt + 0.1) || a === null || b === null) return;
  if (a.name === b.name && a.start === b.start) return;
  const sameFade = r.base === prev.base && r.prevBase === prev.prevBase && r.fadeStart === prev.fadeStart;
  const freshFade = r.fadeStart === now && r.prevBase === prev.base && now >= prev.fadeStart + 0.15;
  if (!(sameFade || freshFade)) return;
  const jump = bodyDiff(
    evaluate(r, now, createPose(), false, CAST),
    evaluate(prev, now, createPose(), false, CAST),
  );
  const plain = bodyDiff(
    evaluate({ ...r, prevClip: null }, now, createPose(), false, CAST),
    evaluate({ ...prev, prevClip: null }, now, createPose(), false, CAST),
  );
  expect(jump).toBeLessThanOrEqual(plain + 1e-6);
}

// ---- Validation 3: the 150 ms crossfade --------------------------------------------------------------------------
describe('Validation 3: crossfade', () => {
  it('at +75 ms evaluate is the midpoint of the two base poses (±1e-6) for all 30 ordered pairs', () => {
    const out = createPose();
    const mid = createPose();
    let pairs = 0;
    for (const a of BASE_NAMES) {
      for (const b of BASE_NAMES) {
        if (a === b) continue;
        const s: DirectorState = { ...stateIn('Idle'), prevBase: a, base: b, fadeStart: 4, clip: null };
        evaluate(s, 4.075, out, false, CAST);
        lerpPose(BASE[a], BASE[b], 0.5, mid);
        expect(bodyDiff(out, mid), `${a} → ${b}`).toBeLessThanOrEqual(1e-6);
        pairs++;
      }
    }
    expect(pairs).toBe(30);
  });

  it('starts exactly at prevBase, ends exactly at base from +150 ms, and never extrapolates before fadeStart', () => {
    const out = createPose();
    for (const a of BASE_NAMES) {
      for (const b of BASE_NAMES) {
        const s: DirectorState = { ...stateIn('Idle'), prevBase: a, base: b, fadeStart: 4, clip: null };
        expect(bodyDiff(evaluate(s, 4, out, false, CAST), BASE[a]), `${a} → ${b} at 0`).toBe(0);
        expect(bodyDiff(evaluate(s, 3.9, out, false, CAST), BASE[a]), `${a} → ${b} at −100 ms`).toBe(0);
        expect(bodyDiff(evaluate(s, 4.15, out, false, CAST), BASE[b]), `${a} → ${b} at +150 ms`).toBe(0);
        expect(bodyDiff(evaluate(s, 5, out, false, CAST), BASE[b]), `${a} → ${b} at +1 s`).toBe(0);
      }
    }
  });

  it('through the reducer: Idle → attentive at 4, evaluated at 4.075, is the idle/attentive midpoint', () => {
    const s = run(stateIn('Idle', 3), anim({ e: 'attentive' }, 4));
    const out = evaluate(s, 4.075, createPose(), false, CAST);
    expect(bodyDiff(out, lerpPose(BASE.idle, BASE.attentive, 0.5, createPose()))).toBeLessThanOrEqual(1e-6);
  });

  it('chained: start → wake@1 → tick at the clip end → attentive@4 fades from idle, not from asleep', () => {
    const s = run(
      initialDirector(0),
      anim({ e: 'wake' }, 1),
      tick(endOf('wake', 1)),
      anim({ e: 'attentive' }, 4),
    );
    const out = evaluate(s, 4.075, createPose(), false, CAST);
    expect(bodyDiff(out, lerpPose(BASE.idle, BASE.attentive, 0.5, createPose()))).toBeLessThanOrEqual(1e-6);
    expect(out[Ch.LidL]).toBe(0);
  });
});

// ---- the active clip on top of the crossfade ---------------------------------------------------------------------
describe('evaluate: the clip sample is added', () => {
  it('Asleep → wake: the crossfade plus the wake clip sample (±1e-6) through the clip and after it', () => {
    const s = run(stateIn('Asleep', 3), anim({ e: 'wake' }, 4));
    const out = createPose();
    for (const dt of [0, 0.05, 0.1, 0.15, 0.2, 0.7, 1.2, 2]) {
      const exp = addPose(
        lerpPose(BASE.asleep, BASE.idle, Math.min(1, dt / 0.15), createPose()),
        sampleClip(SESSION_CLIPS.wake, dt, createPose()),
        1,
        createPose(),
      );
      expect(bodyDiff(evaluate(s, 4 + dt, out, false, CAST), exp), `dt ${dt}`).toBeLessThanOrEqual(1e-6);
    }
  });

  it('confused on a settled Attentive: HeadTilt is attentive + 10° at +0.25 s, the rest the composite', () => {
    const s = run(stateIn('Attentive', 3), anim({ e: 'confused' }, 4));
    const out = evaluate(s, 4.25, createPose(), false, CAST);
    expect(Math.abs(out[Ch.HeadTilt]! - (BASE.attentive[Ch.HeadTilt]! + 10 * DEG))).toBeLessThanOrEqual(1e-6);
    expect(bodyDiff(out, composite(s, 4.25))).toBeLessThanOrEqual(1e-6);
  });

  it('every reachable clip in every state matches the independent composite (±1e-6)', () => {
    const out = createPose();
    for (const name of STATES) {
      for (const clip of CLIP_NAMES) {
        const s: DirectorState = { ...stateIn(name, 4), fadeStart: 4, clip: { name: clip, start: 4 } };
        for (const dt of [0, 0.03, 0.075, 0.15, 0.33, 0.6, 1, 3]) {
          expect(
            bodyDiff(evaluate(s, 4 + dt, out, false, CAST), composite(s, 4 + dt)),
            `${name} ${clip} ${dt}`,
          ).toBeLessThanOrEqual(1e-6);
        }
      }
    }
  });

  it('an unknown clip adds nothing, and evaluate returns out', () => {
    const s: DirectorState = { ...stateIn('Idle', 3), clip: { name: 'mystery', start: 3.5 } };
    const out = createPose();
    expect(evaluate(s, 4, out, false, CAST)).toBe(out);
    expect(bodyDiff(out, BASE.idle)).toBe(0);
  });
});

// ---- Validation 4: talkEnd and the mouth -------------------------------------------------------------------------
describe('Validation 4: talkEnd, mouthCloseScale and the mouth channels', () => {
  it('talkEnd sets mouthCloseStart = now', () => {
    expect(run(stateIn('Talking', 5), anim({ e: 'talkEnd' }, 6)).mouthCloseStart).toBe(6);
  });

  it('mouthCloseScale returns 1, 0.5 and 0 at +0, +100 and ≥ +200 ms, and 1 for null', () => {
    expect(mouthCloseScale(6, 6)).toBe(1);
    expect(Math.abs(mouthCloseScale(6.1, 6) - 0.5)).toBeLessThanOrEqual(1e-9);
    expect(mouthCloseScale(6.2, 6)).toBe(0);
    expect(mouthCloseScale(6.25, 6)).toBe(0);
    expect(mouthCloseScale(9, 6)).toBe(0);
    expect(mouthCloseScale(1, null)).toBe(1);
    expect(mouthCloseScale(Number.NaN, null)).toBe(1);
  });

  it('mouthCloseScale is clamped to 1 before the start and gives 0 for NaN', () => {
    expect(mouthCloseScale(5.9, 6)).toBe(1);
    expect(mouthCloseScale(Number.NaN, 6)).toBe(0);
    expect(mouthCloseScale(6, Number.NaN)).toBe(0);
  });

  it('the scale over a talkEnd, then a new talk resets it to 1', () => {
    let s = run(stateIn('Talking', 5), anim({ e: 'talkEnd' }, 6));
    expect(mouthCloseScale(6.05, s.mouthCloseStart)).toBeCloseTo(0.75, 9);
    s = run(s, anim({ e: 'attentive' }, 7), anim({ e: 'thinking' }, 8), anim({ e: 'talk', id: 2 }, 9));
    expect(s.mouthCloseStart).toBeNull();
    expect(mouthCloseScale(20, s.mouthCloseStart)).toBe(1);
  });

  it('evaluate never writes the mouth channels: every state × clip × time keeps the sentinels', () => {
    const SENTINELS = [7.25, -3.5, 0.125, 42];
    const clips: (string | null)[] = [null, ...CLIP_NAMES, 'mystery'];
    let checks = 0;
    for (const name of STATES) {
      for (const clip of clips) {
        const s: DirectorState = {
          ...stateIn(name, 10),
          fadeStart: 10,
          clip: clip === null ? null : { name: clip, start: 10 },
        };
        for (const dt of [0, 0.075, 0.15, 0.4, 3]) {
          const out = createPose().fill(Number.NaN);
          for (const [j, m] of MOUTH.entries()) out[m] = SENTINELS[j]!;
          evaluate(s, 10 + dt, out, false, CAST);
          for (const [j, m] of MOUTH.entries())
            expect(Object.is(out[m], SENTINELS[j]), `${name} ${clip}`).toBe(true);
          for (let i = 0; i < CH_COUNT; i++) {
            if (!MOUTH.includes(i)) expect(Number.isFinite(out[i]), `${name} ${clip} ch ${i}`).toBe(true);
          }
          checks++;
        }
      }
    }
    expect(checks).toBe(9 * 7 * 5);
  });
});

// ---- evaluate does not allocate (the src/anim/clip.test.ts meters) -------------------------------------------------
type Constructor = new (...args: never[]) => object;

/** Wraps `original` so that every `new` of it, including those inside its static `from` and `of`, calls `onNew`. */
function countingConstructor<C extends Constructor>(original: C, onNew: () => void): C {
  return new Proxy(original, {
    construct(target, args: never[], newTarget: Constructor): object {
      onNew();
      return Reflect.construct(target, args, newTarget);
    },
  });
}

/** `%TypedArray%.prototype`, which every typed array class inherits its methods from. */
const TYPED_ARRAY_PROTOTYPE = Reflect.getPrototypeOf(Float32Array.prototype) ?? Float32Array.prototype;
/** Its methods that return a new typed array. */
const TYPED_ARRAY_METHODS = ['slice', 'map', 'filter', 'subarray', 'toReversed', 'toSorted', 'with'] as const;

/**
 * Runs `fn` and counts the allocations it makes through the array globals (the pattern of
 * src/anim/pose.test.ts): every `new` of `Array`, `ArrayBuffer`, `Float32Array` or `Float64Array` (static
 * `from` and `of` included, and `new` through a typed array's `constructor`), and every call of an allocating
 * `%TypedArray%.prototype` method. Everything is restored afterwards.
 */
function countAllocations(fn: () => void): number {
  let count = 0;
  const onNew = (): void => {
    count++;
  };
  const saved: { obj: object; key: string; desc: PropertyDescriptor }[] = [];
  const patch = (obj: object, key: string, value: unknown): void => {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc === undefined) throw new Error(`nothing to patch at ${key}`);
    saved.push({ obj, key, desc });
    Object.defineProperty(obj, key, { ...desc, value });
  };
  const float32 = countingConstructor(Float32Array, onNew);
  const float64 = countingConstructor(Float64Array, onNew);
  patch(Float32Array.prototype, 'constructor', float32);
  patch(Float64Array.prototype, 'constructor', float64);
  patch(globalThis, 'Array', countingConstructor(Array, onNew));
  patch(globalThis, 'ArrayBuffer', countingConstructor(ArrayBuffer, onNew));
  patch(globalThis, 'Float32Array', float32);
  patch(globalThis, 'Float64Array', float64);
  for (const name of TYPED_ARRAY_METHODS) {
    const original: unknown = Reflect.get(TYPED_ARRAY_PROTOTYPE, name);
    if (typeof original !== 'function') throw new Error(`no %TypedArray%.prototype.${name}`);
    patch(TYPED_ARRAY_PROTOTYPE, name, function (this: unknown, ...args: unknown[]): unknown {
      count++;
      return Reflect.apply(original, this, args);
    });
  }
  try {
    fn();
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) {
      const { obj, key, desc } = saved[i]!;
      Object.defineProperty(obj, key, desc);
    }
  }
  return count;
}

/** The `gc` function, exposed once at runtime with Node built-ins only (no `--expose-gc` flag needed). */
let exposedGc: (() => void) | undefined;

/** Runs a full garbage collection. */
function forceGc(): void {
  if (exposedGc === undefined) {
    setFlagsFromString('--expose-gc');
    const gc: unknown = runInNewContext('gc');
    if (typeof gc !== 'function') throw new Error('gc() is not available');
    exposedGc = (): void => {
      gc();
    };
  }
  exposedGc();
}

/**
 * `heapUsed` growth in bytes over `fn`, measured from a freshly collected heap. If any GC ran during `fn`,
 * the reading is meaningless (a scavenge frees the garbage it should count), so it returns +Infinity.
 */
function heapGrowth(fn: () => void): number {
  forceGc();
  const profiler = new GCProfiler();
  profiler.start();
  const before = process.memoryUsage().heapUsed;
  fn();
  const growth = process.memoryUsage().heapUsed - before;
  return profiler.stop().statistics.length > 0 ? Number.POSITIVE_INFINITY : growth;
}

describe('evaluate: no allocation (10 000 evaluations, heap growth < 1 MB)', () => {
  /** Mid-fade with the wake clip, Idle + confused, Talking, Asleep + the sleep clip, wake cutting confused (#240). */
  const STATES_FOR_ALLOC: readonly DirectorState[] = [
    run(initialDirector(0), anim({ e: 'wake' }, 1)),
    run(stateIn('Idle', 0), anim({ e: 'confused' }, 1)),
    stateIn('Talking', 0),
    run(stateIn('Idle', 0), anim({ e: 'sleep' }, 1)),
    run(stateIn('Idle', 0), anim({ e: 'confused' }, 1), anim({ e: 'wake' }, 1.2)),
  ];
  const N = 10_000;
  /** Times sweeping [0.9, 2.3]: before the fades, through them and the clips, and past the clip ends. */
  const tAt = (i: number): number => 0.9 + (1.4 * i) / (N - 1);

  it('makes no array or typed-array allocation over 10 000 evaluations, and always returns out', () => {
    const out = createPose();
    const buffer = out.buffer;
    let allOut = true;
    const allocations = countAllocations(() => {
      for (let i = 0; i < N; i++) {
        if (evaluate(STATES_FOR_ALLOC[i % STATES_FOR_ALLOC.length]!, tAt(i), out, false, CAST) !== out)
          allOut = false;
      }
    });
    expect(allocations).toBe(0);
    expect(allOut).toBe(true);
    expect(out.buffer).toBe(buffer);
  });

  it('grows the heap by < 1 MB over 10 000 evaluations, once V8 has optimised it', () => {
    const out = createPose();
    const runAll = (): void => {
      for (let i = 0; i < N; i++)
        evaluate(STATES_FOR_ALLOC[i % STATES_FOR_ALLOC.length]!, tAt(i), out, false, CAST);
    };
    // As in clip.test.ts: warm up after a collection, then take the best of up to 20 runs, each from a freshly
    // collected heap (a run during which any GC ran counts as +Infinity). An evaluate that allocates a pose per
    // call grows the heap by megabytes in every run.
    forceGc();
    for (let w = 0; w < 10; w++) runAll();
    const LIMIT = 1_048_576;
    let best = heapGrowth(runAll);
    for (let trial = 1; trial < 20 && best >= LIMIT; trial++) best = Math.min(best, heapGrowth(runAll));
    expect(best).toBeLessThan(LIMIT);
  });

  it('both meters have teeth (positive controls)', () => {
    expect(countAllocations(() => void new Float32Array(CH_COUNT))).toBe(1);
    expect(countAllocations(() => void Array.from({ length: 3 }))).toBeGreaterThan(0);
    const kept: number[][] = [];
    const growth = heapGrowth(() => {
      for (let i = 0; i < N; i++) kept.push(Array.from({ length: 64 }, (_, j) => j + 0.5));
    });
    expect(kept).toHaveLength(N);
    expect(growth).toBeGreaterThanOrEqual(1_048_576);
  });
});

// ==== #91: the reaction rules ===================================================================================
/** The table's reaction `name`. */
function R(name: string): Reaction {
  const r = REACTIONS[name];
  if (r === undefined) throw new Error(`no reaction ${name}`);
  return r;
}

/** The director input for reaction `r` (a table name or a made-up reaction) on (region, gesture) at `now`. */
function gest(
  r: Reaction | string,
  region: RegionId,
  gesture: GestureKind,
  now: number,
  dirX?: -1 | 1,
): DirInput {
  const reaction = typeof r === 'string' ? R(r) : r;
  return dirX === undefined
    ? { k: 'gesture', r: reaction, region, gesture, now }
    : { k: 'gesture', r: reaction, region, gesture, now, dirX };
}
const release = (now: number): DirInput => ({ k: 'release', now });
/** The end of one contact's sustained gesture: `stroke end` or `longPress end` (Decision 16). */
const releaseOf = (region: RegionId, gesture: GestureKind, now: number): DirInput => ({
  k: 'release',
  now,
  region,
  gesture,
});
const gentle = (on: boolean): DirInput => ({ k: 'setGentle', on });
/** A nose tap down; the recogniser's multi-poke `count` ≥ 3 makes it a big sneeze (#90). */
const noseTap = (now: number, count = 1): DirInput =>
  gest(count >= 3 ? 'bigSneeze' : 'sneeze', 'nose', 'tap', now);
const flick = (now: number): DirInput => gest('wobble', 'headTop', 'flick', now);
const tickle = (now: number): DirInput => gest('giggle', 'belly', 'tickle', now);
const petStroke = (now: number, dirX?: -1 | 1): DirInput => gest('pet', 'headTop', 'stroke', now, dirX);
/** `n` belly tickles from `t0`, `stepMs` apart (the recogniser's tickle rate is one per 600 ms). */
const tickles = (t0: number, n: number, stepMs = 600): DirInput[] =>
  Array.from({ length: n }, (_, k) => tickle(t0 + (k * stepMs) / 1000));

/** The session event the table's reaction `name` outputs with `sfx`. */
function toSess(name: string, sfx: Reaction['sfx']): DirOut {
  return { k: 'toSession', ev: { t: 'reaction', name, priority: R(name).priority, sfx } };
}
const TAP_HAPTIC: DirOut = { k: 'haptic', pattern: [12] };

/** The reaction names of the `toSession` outputs. */
function sessionNames(out: readonly DirOut[]): string[] {
  return out.flatMap((o) => (o.k === 'toSession' ? [o.ev.name] : []));
}

/** Folds `directorStep` over `inputs` (checking `directorReduce` agrees), with every output. */
function stepAll(s0: DirectorState, ...inputs: DirInput[]): { s: DirectorState; out: DirOut[] } {
  let s = s0;
  const out: DirOut[] = [];
  for (const i of inputs) {
    const r = directorStep(s, i, CAST);
    expect(r.state, `directorReduce agrees on ${i.k}`).toStrictEqual(directorReduce(s, i, CAST));
    s = r.state;
    out.push(...r.out);
  }
  return { s, out };
}

/**
 * Steps `s0` through `inputs` (each with a `now`, in order) with 120 Hz ticks at k/120 s between them, from the
 * first input on to `until`; a tick at an input's time comes after it. Records every output and state with its time.
 */
function drive(
  s0: DirectorState,
  inputs: readonly DirInput[],
  until: number,
): { s: DirectorState; out: { at: number; o: DirOut }[]; states: { at: number; s: DirectorState }[] } {
  let s = s0;
  const out: { at: number; o: DirOut }[] = [];
  const states: { at: number; s: DirectorState }[] = [];
  const apply = (i: DirInput, at: number): void => {
    const r = directorStep(s, i, CAST);
    s = r.state;
    for (const o of r.out) out.push({ at, o });
    states.push({ at, s });
  };
  const times = inputs.map((i) => (i.k === 'setGentle' ? Number.NaN : i.now));
  let k = Math.ceil(times[0]! * 120);
  inputs.forEach((i, j) => {
    while (k / 120 < times[j]!) apply(tick(k / 120), k++ / 120);
    apply(i, times[j]!);
  });
  while (k / 120 <= until) apply(tick(k / 120), k++ / 120);
  return { s, out, states };
}

/** `t` through `1 − smoothstep`: the ease-out weight of a released clip (#91). */
const easeOut = (u: number): number => 1 - u * u * (3 - 2 * u);

describe('#91 Validation 1: priority interruption and the queue', () => {
  it('a P2 while a P3 is held is queued (no output) and starts when the P3 ends within 500 ms', () => {
    const held = stepAll(stateIn('Idle'), gest('noseWrinkle', 'nose', 'longPress', 11));
    expect(held.s).toMatchObject({ name: 'Sustained', since: 11, clip: { name: 'noseWrinkle', start: 11 } });
    expect(held.out).toStrictEqual([toSess('noseWrinkle', null)]);
    const queued = stepAll(held.s, gest('hardBlinkL', 'eyeL', 'tap', 12));
    expect(queued.out).toStrictEqual([]);
    expect(queued.s).toMatchObject({ name: 'Sustained', clip: { name: 'noseWrinkle', start: 11 } });
    expect(queued.s.queued).toStrictEqual({
      r: R('hardBlinkL'),
      region: 'eyeL',
      gesture: 'tap',
      dirX: null,
      at: 12,
      announced: false,
    });
    const released = stepAll(queued.s, release(12.0625));
    expect(released.out).toStrictEqual([]);
    const end = 12.0625 + 0.4; // the P3 ends 400 ms after its release: 462.5 ms after the P2 was queued
    expect(directorReduce(released.s, tick(end - 1e-9), CAST)).toBe(released.s);
    const played = stepAll(released.s, tick(end));
    expect(played.s).toMatchObject({
      name: 'Reacting',
      since: end,
      clip: { name: 'hardBlinkL', start: end },
      queued: null,
    });
    expect(played.s.reaction?.r).toBe(R('hardBlinkL'));
    expect(played.out).toStrictEqual([toSess('hardBlinkL', 'hmph'), TAP_HAPTIC, { k: 'mood', annoy: 0.2 }]);
  });

  it('… and is dropped when the P3 ends more than 500 ms after it was queued', () => {
    const s = stepAll(
      stateIn('Idle'),
      gest('noseWrinkle', 'nose', 'longPress', 11),
      gest('hardBlinkL', 'eyeL', 'tap', 12),
      release(12.25),
    ).s;
    expect(directorReduce(s, tick(12.5), CAST)).toBe(s); // 500 ms after queuing: still queued
    const dropped = stepAll(s, tick(12.5 + 1e-9));
    expect(dropped.s).toMatchObject({ name: 'Sustained', queued: null });
    expect(dropped.out).toStrictEqual([]);
    const ended = stepAll(dropped.s, tick(12.25 + 0.4));
    expect(ended.s).toMatchObject({ name: 'Idle', reaction: null, clip: null, queued: null });
    expect(ended.out).toStrictEqual([]);
  });

  it('a one-shot ends at its clip end: a P2 queued under a P4 starts then; one queued too early is dropped', () => {
    const big = stepAll(stateIn('Idle'), noseTap(11, 3)).s;
    expect(big.reaction?.r).toBe(R('bigSneeze'));
    const end = 11 + REACTION_CLIPS.bigSneeze.duration;
    const queued = stepAll(big, gest('cheekPuffL', 'cheekL', 'tap', end - 0.3)).s;
    expect(queued.queued?.r).toBe(R('cheekPuffL'));
    expect(directorReduce(queued, tick(end - 1e-9), CAST)).toBe(queued);
    const played = stepAll(queued, tick(end));
    expect(played.s).toMatchObject({
      name: 'Reacting',
      clip: { name: 'cheekPuffL', start: end },
      queued: null,
    });
    expect(played.out).toStrictEqual([toSess('cheekPuffL', 'pop'), TAP_HAPTIC]);
    const stale = stepAll(big, gest('cheekPuffL', 'cheekL', 'tap', end - 0.6), tick(end));
    expect(stale.s).toMatchObject({ name: 'Idle', since: end, clip: null, reaction: null, queued: null });
    expect(stale.out).toStrictEqual([]);
  });

  it('a P3 over a P2 interrupts it, and an equal priority interrupts too', () => {
    const tap = stepAll(stateIn('Idle'), noseTap(11)).s;
    expect(tap).toMatchObject({ name: 'Reacting', since: 11, clip: { name: 'sneeze', start: 11 } });
    const p3 = stepAll(tap, gest('earDroopL', 'earL', 'longPress', 11.2));
    expect(p3.s).toMatchObject({ name: 'Sustained', since: 11.2, clip: { name: 'earDroopL', start: 11.2 } });
    expect(p3.s.reaction?.r).toBe(R('earDroopL'));
    expect(p3.out).toStrictEqual([toSess('earDroopL', 'purr')]);
    const p2 = stepAll(tap, gest('bellyBoing', 'belly', 'tap', 11.1));
    expect(p2.s).toMatchObject({ name: 'Reacting', since: 11.1, clip: { name: 'bellyBoing', start: 11.1 } });
    expect(p2.out).toStrictEqual([toSess('bellyBoing', 'boingHehe'), TAP_HAPTIC]);
  });

  it('a newer queued reaction replaces the queued one (queue length 1)', () => {
    const s = stepAll(
      stateIn('Idle'),
      gest('bellyRub', 'belly', 'longPress', 11),
      noseTap(11.2),
      gest('cheekPuffR', 'cheekR', 'tap', 11.3),
    ).s;
    expect(s.queued).toMatchObject({ r: R('cheekPuffR'), at: 11.3 });
    expect(s.reaction?.r).toBe(R('bellyRub'));
  });

  it('hug (P4) interrupts a running dizzy or laugh fit; an all-over giggle (P3) is queued behind a hug', () => {
    const dizzy = stepAll(stateIn('Idle'), flick(11), flick(12), flick(13)).s;
    expect(dizzy.reaction?.r).toBe(R('dizzy'));
    const hug = stepAll(dizzy, gest('hug', 'belly', 'hug', 13.5));
    expect(hug.s).toMatchObject({ name: 'Sustained', since: 13.5, clip: { name: 'hug', start: 13.5 } });
    expect(hug.out).toStrictEqual([toSess('hug', 'squeal'), { k: 'mood', joy: 0.2 }]);
    const laugh = stepAll(stateIn('Idle'), ...tickles(11, 7)).s;
    expect(laugh.reaction?.r).toBe(R('laughFit'));
    expect(stepAll(laugh, gest('hug', 'belly', 'hug', 15)).s.reaction?.r).toBe(R('hug'));
    const allOver = stepAll(hug.s, gest('giggle', 'belly', 'allOver', 14));
    expect(allOver.out).toStrictEqual([]);
    expect(allOver.s.reaction?.r).toBe(R('hug'));
    expect(allOver.s.queued?.r).toBe(R('giggle'));
  });
});

describe('#91 Validation 2: cooldown (800 ms per region and gesture kind)', () => {
  it('a second tap on the nose within 800 ms produces no output and changes nothing', () => {
    const first = stepAll(stateIn('Idle'), noseTap(11));
    expect(first.out).toStrictEqual([toSess('sneeze', 'sneeze'), TAP_HAPTIC]);
    for (const t of [11.1, 11.5, 11 + 0.8 - 1e-9]) {
      const r = directorStep(first.s, noseTap(t, 2), CAST);
      expect(r.out, `${t}`).toStrictEqual([]);
      expect(r.state, `${t}`).toBe(first.s);
    }
    const later = directorStep(first.s, noseTap(11 + 0.8, 2), CAST);
    expect(later.out).toStrictEqual([toSess('sneeze', 'sneeze'), TAP_HAPTIC]);
    expect(later.state.clip).toStrictEqual({ name: 'sneeze', start: 11 + 0.8 });
  });

  it('is per (region, gesture kind): another gesture on the same region, or another region, plays', () => {
    const s = stepAll(stateIn('Idle'), gest('tuftBoing', 'headTop', 'tap', 11)).s;
    expect(stepAll(s, flick(11.2)).out[0]).toStrictEqual(toSess('wobble', 'whoa'));
    expect(stepAll(s, noseTap(11.2)).out[0]).toStrictEqual(toSess('sneeze', 'sneeze'));
  });

  it('a queued reaction starts no cooldown; a reaction that starts does, and prunes expired ones', () => {
    const s = stepAll(stateIn('Idle'), gest('bellyRub', 'belly', 'longPress', 11), noseTap(11.2)).s;
    expect(s.cooldowns).toStrictEqual([{ region: 'belly', gesture: 'longPress', at: 11, priority: 3 }]);
    const later = stepAll(s, release(11.3), tick(11.75), noseTap(12)).s;
    expect(later.cooldowns).toStrictEqual([{ region: 'nose', gesture: 'tap', at: 12, priority: 2 }]);
  });
});

describe('#91 Validation 3: escalation', () => {
  it('3 head flicks within 3 s → dizzy (P4)', () => {
    for (const ts of [
      [11, 12, 13],
      [11, 12.5, 14],
    ]) {
      const r = stepAll(stateIn('Idle'), ...ts.map(flick));
      expect(sessionNames(r.out), ts.join(' ')).toStrictEqual(['wobble', 'wobble', 'dizzy']);
      expect(r.out.at(-1)).toStrictEqual(toSess('dizzy', 'whoa'));
      expect(r.s).toMatchObject({ name: 'Reacting', clip: { name: 'dizzy', start: ts[2] } });
      expect(r.s.reaction?.r).toBe(R('dizzy'));
    }
  });

  it('3 flicks spread over 3.5 s do not escalate', () => {
    const r = stepAll(stateIn('Idle'), flick(11), flick(12.75), flick(14.5));
    expect(sessionNames(r.out)).toStrictEqual(['wobble', 'wobble', 'wobble']);
    expect(r.s.clip).toStrictEqual({ name: 'wobble', start: 14.5 });
  });

  it('after an escalation the count starts over', () => {
    const r = stepAll(
      stateIn('Idle'),
      flick(11),
      flick(12),
      flick(13),
      flick(16.6),
      flick(17.5),
      flick(18.4),
    );
    expect(sessionNames(r.out)).toStrictEqual(['wobble', 'wobble', 'dizzy', 'wobble', 'wobble', 'dizzy']);
  });

  it('belly tickles every 600 ms reach laughFit once the run exceeds 3 s, with the input at 3600 ms', () => {
    const six = stepAll(stateIn('Idle'), ...tickles(11, 6));
    expect(sessionNames(six.out)).toStrictEqual(['giggle']); // the input at 3000 ms: not longer than 3 s yet
    expect(six.s).toMatchObject({ name: 'Sustained' });
    expect(six.s.reaction?.r).toBe(R('giggle'));
    const seven = stepAll(six.s, tickle(11 + 3.6));
    expect(seven.out).toStrictEqual([
      toSess('laughFit', 'giggle'),
      { k: 'haptic', pattern: [8, 40, 8, 40, 8] },
    ]);
    expect(seven.s).toMatchObject({ name: 'Reacting', since: 14.6, clip: { name: 'laughFit', start: 14.6 } });
    expect(seven.s.reaction?.r).toBe(R('laughFit'));
  });

  it('with a 900 ms gap in between, the run starts over: no laughFit until 3 s after the gap', () => {
    const ts = [0, 600, 1200, 2100, 2700, 3300, 3900, 4500, 5100].map((ms) => 11 + ms / 1000);
    const r = stepAll(stateIn('Idle'), ...ts.map(tickle));
    expect(sessionNames(r.out)).toStrictEqual(['giggle']);
    expect(r.s.reaction?.runStart).toBe(11 + 2100 / 1000);
    expect(stepAll(r.s, tickle(11 + 5.7)).out[0]).toStrictEqual(toSess('laughFit', 'giggle'));
  });

  it('Gentle: neither escalates to its full clip; dizzyGentle and laughFitGentle play instead', () => {
    const g = stepAll(stateIn('Idle'), gentle(true)).s;
    expect(g.gentle).toBe(true);
    const d = stepAll(g, flick(11), flick(12), flick(13));
    expect(d.s.clip).toStrictEqual({ name: 'dizzyGentle', start: 13 });
    expect(d.s.reaction?.clip).toBe('dizzyGentle');
    const l = stepAll(g, ...tickles(11, 7));
    expect(l.s.clip).toStrictEqual({ name: 'laughFitGentle', start: 14.6 });
    expect(stepAll(g, gentle(true)).s).toBe(g);
    expect(stepAll(g, gentle(false)).s).toStrictEqual({ ...g, gentle: false });
  });

  it('Gentle: gentle clips; bigSneeze plays bigSneezeGentle, hug its own clip; a target without one is skipped', () => {
    const g = stepAll(stateIn('Idle'), gentle(true)).s;
    expect(stepAll(g, noseTap(11)).s.clip?.name).toBe('sneezeGentle');
    expect(stepAll(g, noseTap(11, 3)).s.clip?.name).toBe('bigSneezeGentle');
    expect(stepAll(g, flick(11)).s.clip?.name).toBe('wobbleGentle');
    expect(stepAll(g, gest('hug', 'belly', 'hug', 11)).s.clip?.name).toBe('hug');
    expect(stepAll(g, petStroke(11)).s.clip?.name).toBe('pet');
    // A made-up repeat escalation to hug, which has no gentle clip: skipped in Gentle mode (the base plays).
    const toHug: Reaction = { ...R('wobble'), escalation: { to: 'hug', count: 3, withinMs: 3000 } };
    const three = (s: DirectorState): DirOut[] =>
      stepAll(s, ...[11, 12, 13].map((t) => gest(toHug, 'headTop', 'flick', t))).out;
    expect(sessionNames(three(g))).toStrictEqual(['wobble', 'wobble', 'wobble']);
    expect(sessionNames(three(stateIn('Idle')))).toStrictEqual(['wobble', 'wobble', 'hug']);
  });

  it('repeat-based defaults are ×3 within 4 s; an unknown target never escalates', () => {
    const dflt: Reaction = { ...R('wobble'), escalation: { to: 'dizzy' } };
    const at = (...ts: number[]): string[] =>
      sessionNames(stepAll(stateIn('Idle'), ...ts.map((t) => gest(dflt, 'headTop', 'flick', t))).out);
    expect(at(11, 12.5, 15)).toStrictEqual(['wobble', 'wobble', 'dizzy']);
    expect(at(11, 13, 15.1)).toStrictEqual(['wobble', 'wobble', 'wobble']);
    const unknown: Reaction = { ...R('wobble'), escalation: { to: 'nope', count: 2 } };
    const u = stepAll(
      stateIn('Idle'),
      gest(unknown, 'headTop', 'flick', 11),
      gest(unknown, 'headTop', 'flick', 12),
    );
    expect(sessionNames(u.out)).toStrictEqual(['wobble', 'wobble']);
    const unknownRun: Reaction = { ...R('giggle'), escalation: { to: 'nope', continuousMs: 1000 } };
    const ur = stepAll(
      stateIn('Idle'),
      ...[11, 11.6, 12.2].map((t) => gest(unknownRun, 'belly', 'tickle', t)),
    );
    expect(sessionNames(ur.out)).toStrictEqual(['giggle']);
    // Without maxGapMs a run never restarts.
    const noGap: Reaction = { ...R('giggle'), escalation: { to: 'laughFit', continuousMs: 1000 } };
    const ng = stepAll(
      stateIn('Idle'),
      gest(noGap, 'belly', 'tickle', 11),
      gest(noGap, 'belly', 'tickle', 12.5),
    );
    expect(sessionNames(ng.out)).toStrictEqual(['giggle', 'laughFit']);
  });

  it('a nose tap with count 3 inside the cooldown still produces bigSneeze (P4)', () => {
    const r = stepAll(stateIn('Idle'), noseTap(11), noseTap(11.2, 2), noseTap(11.4, 3));
    expect(r.out).toStrictEqual([
      toSess('sneeze', 'sneeze'),
      TAP_HAPTIC,
      toSess('bigSneeze', 'bigSneeze'),
      TAP_HAPTIC,
    ]);
    expect(r.s).toMatchObject({ name: 'Reacting', clip: { name: 'bigSneeze', start: 11.4 } });
    // The cooldown is now the big sneeze's: a fourth quick tap (count 4) is ignored.
    expect(directorStep(r.s, noseTap(11.6, 4), CAST).out).toStrictEqual([]);
  });
});

// ==== T125: Fenn's cast (duck plan §4.6, T125 acceptance 3) ===================================================
/**
 * The director input for Fenn's reaction to `g` (one with a region) at `now`, with a stroke's `dirX`; fails if there
 * is none.
 */
function fennGest(g: Gesture & { region: RegionId }, now: number, dirX?: -1 | 1): DirInput {
  const r = FENN.reactionFor(g);
  if (r === null) throw new Error(`Fenn has no reaction to ${g.g} on ${g.region}`);
  const i: DirInput = { k: 'gesture', r, region: g.region, gesture: g.g, now };
  return dirX === undefined ? i : { ...i, dirX };
}
const beakTap = (now: number, count: number): DirInput =>
  fennGest({ g: 'tap', phase: 'down', region: 'beak', x: 500, y: 528, count }, now);
const bellyTickle = (now: number): DirInput => fennGest({ g: 'tickle', region: 'belly' }, now);
const headFlick = (now: number): DirInput =>
  fennGest({ g: 'flick', region: 'headTop', vx: 0, vy: -1500 }, now);
/** The session event of Fenn's reaction `name`. */
const fennSess = (name: string, priority: Reaction['priority'], sfx: Reaction['sfx']): DirOut => ({
  k: 'toSession',
  ev: { t: 'reaction', name, priority, sfx },
});

describe("T125: the director with Fenn's cast", () => {
  const FCAST = FENN.cast;

  /** Folds `directorStep` over `inputs` with Fenn's cast (checking `directorReduce` agrees), with every output. */
  function stepFenn(s0: DirectorState, ...inputs: DirInput[]): { s: DirectorState; out: DirOut[] } {
    let s = s0;
    const out: DirOut[] = [];
    for (const i of inputs) {
      const r = directorStep(s, i, FCAST);
      expect(r.state, `directorReduce agrees on ${i.k}`).toStrictEqual(directorReduce(s, i, FCAST));
      s = r.state;
      out.push(...r.out);
    }
    return { s, out };
  }

  it('a beak tap with count 3 is bigQuack by a count rule (no escalation), and plays bigQuack', () => {
    const r = FENN.reactionFor({ g: 'tap', phase: 'down', region: 'beak', x: 500, y: 528, count: 3 });
    expect(r).toBe(FENN_REACTIONS.bigQuack);
    expect(r?.priority).toBe(4);
    expect(
      FENN.reactionFor({ g: 'tap', phase: 'down', region: 'beak', x: 500, y: 528, count: 1 })?.escalation,
    ).toBe(undefined);
    const step = stepFenn(stateIn('Idle'), beakTap(11, 3));
    expect(step.out).toStrictEqual([fennSess('bigQuack', 4, 'bigQuack'), TAP_HAPTIC]);
    expect(step.s).toMatchObject({ name: 'Reacting', clip: { name: 'bigQuack', start: 11 } });
    expect(step.s.reaction?.r).toBe(FENN_REACTIONS.bigQuack);
    expect(clipByName('bigQuack', FCAST)).toBe(FENN_CLIPS.bigQuack);
    // The clip plays: the jaw is open at the first quack's peak, and the reaction ends at the clip's end.
    const pose = evaluate(step.s, 11.06, createPose(), true, FCAST);
    expect(pose[Ch.Jaw]).toBeGreaterThan(0.5);
    const end = 11 + FENN_CLIPS.bigQuack.duration;
    expect(stepFenn(step.s, tick(end)).s).toMatchObject({ name: 'Idle', clip: null, reaction: null });
  });

  it('three quick beak pokes (count 1, 2, 3) inside the cooldown: quack, then bigQuack (P4)', () => {
    const r = stepFenn(stateIn('Idle'), beakTap(11, 1), beakTap(11.2, 2), beakTap(11.4, 3));
    expect(r.out).toStrictEqual([
      fennSess('quack', 2, 'quack'),
      TAP_HAPTIC,
      fennSess('bigQuack', 4, 'bigQuack'),
      TAP_HAPTIC,
    ]);
    expect(r.s).toMatchObject({ name: 'Reacting', clip: { name: 'bigQuack', start: 11.4 } });
  });

  it('Gentle: the beak tap with count 3 plays bigQuackGentle, a single quack its own clip', () => {
    const g = stepFenn(stateIn('Idle'), gentle(true)).s;
    const big = stepFenn(g, beakTap(11, 3));
    expect(big.s.clip).toStrictEqual({ name: 'bigQuackGentle', start: 11 });
    expect(big.s.reaction?.clip).toBe('bigQuackGentle');
    expect(big.out[0]).toStrictEqual(fennSess('bigQuack', 4, 'bigQuack'));
    expect(clipByName('bigQuackGentle', FCAST)).toBe(FENN_CLIPS.bigQuackGentle);
    expect(stepFenn(g, beakTap(11, 1)).s.clip?.name).toBe('quack');
  });

  it('a 3 s belly tickle escalates to laughFit (Juni’s giggle and its target)', () => {
    const six = stepFenn(stateIn('Idle'), ...[0, 1, 2, 3, 4, 5].map((k) => bellyTickle(11 + k * 0.6)));
    expect(sessionNames(six.out)).toStrictEqual(['giggle']);
    expect(six.s).toMatchObject({ name: 'Sustained' });
    const seven = stepFenn(six.s, bellyTickle(11 + 3.6));
    expect(seven.out).toStrictEqual([
      fennSess('laughFit', 4, 'giggle'),
      { k: 'haptic', pattern: [8, 40, 8, 40, 8] },
    ]);
    expect(seven.s).toMatchObject({ name: 'Reacting', clip: { name: 'laughFit', start: 14.6 } });
    expect(seven.s.reaction?.r).toBe(REACTIONS['laughFit']);
  });

  it('three head flicks within 3 s → dizzy (P4)', () => {
    const r = stepFenn(stateIn('Idle'), headFlick(11), headFlick(12), headFlick(13));
    expect(sessionNames(r.out)).toStrictEqual(['wobble', 'wobble', 'dizzy']);
    expect(r.out.at(-1)).toStrictEqual(fennSess('dizzy', 4, 'whoa'));
    expect(r.s).toMatchObject({ name: 'Reacting', clip: { name: 'dizzy', start: 13 } });
    expect(r.s.reaction?.r).toBe(REACTIONS['dizzy']);
  });

  it("Fenn's cast is Juni's session, reaction and mime clips plus FENN_CLIPS, the flinch and the mirrored pet", () => {
    expect([...FCAST.clips.keys()]).toStrictEqual([
      ...Object.keys(SESSION_CLIPS),
      ...Object.keys(REACTION_CLIPS),
      ...Object.keys(MIME_CLIPS),
      ...Object.keys(FENN_CLIPS),
      'flinch',
      'petMirrored',
    ]);
    // petTrill plays the pet, so a leftward stroke plays the mirrored pet on Fenn too.
    const pet = fennGest(
      { g: 'stroke', region: 'headTop', phase: 'update', pathPx: 200, dir: Math.PI, against: false },
      11,
      -1,
    );
    const left = stepFenn(stateIn('Idle'), pet);
    expect(left.s.clip?.name).toBe('petMirrored');
    for (const name of Object.keys(FENN_CLIPS)) expect(clipByName(name, CAST), name).toBeUndefined();
  });
});

describe('#91 Validation 4: Sustained', () => {
  it('release → Idle after exactly 400 ms (tick-driven); a held sustained clip never ends', () => {
    const held = stepAll(stateIn('Idle'), gest('bellyRub', 'belly', 'longPress', 11));
    expect(held.s).toMatchObject({ name: 'Sustained', since: 11, clip: { name: 'bellyRub', start: 11 } });
    expect(held.out).toStrictEqual([toSess('bellyRub', 'sigh')]);
    expect(directorReduce(held.s, tick(100), CAST)).toBe(held.s);
    const rel = stepAll(held.s, release(12));
    expect(rel.out).toStrictEqual([]);
    expect(rel.s).toMatchObject({ name: 'Sustained', clip: { name: 'bellyRub', start: 11 } });
    expect(rel.s.reaction?.release).toBe(12);
    const end = 12 + 0.4;
    expect(directorReduce(rel.s, tick(end - 1e-9), CAST)).toBe(rel.s);
    expect(directorReduce(rel.s, tick(end), CAST)).toStrictEqual({
      ...rel.s,
      name: 'Idle',
      since: end,
      clip: null,
      reaction: null,
    });
    const d = drive(held.s, [release(12)], 13);
    const firstIdle = d.states.find((x) => x.s.name === 'Idle');
    expect(firstIdle?.at).toBe(1488 / 120);
    expect(firstIdle!.at).toBeGreaterThanOrEqual(end);
    expect(d.states.every((x) => (x.at < end ? x.s.name === 'Sustained' : x.s.name === 'Idle'))).toBe(true);
  });

  it('evaluate eases a released clip out: × 1 at the release, × 0.5 at +200 ms, × 0 from +400 ms', () => {
    const rel = stepAll(stateIn('Idle', 0), gest('bellyRub', 'belly', 'longPress', 11), release(12)).s;
    for (const [dt, w] of [
      [-0.5, 1],
      [0, 1],
      [0.1, easeOut(0.25)],
      [0.2, 0.5],
      [0.4, 0],
      [0.45, 0],
    ] as const) {
      const now = 12 + dt;
      const base = evaluate({ ...rel, clip: null }, now, createPose(), false, CAST);
      const want = addPose(
        base,
        sampleClip(REACTION_CLIPS.bellyRub, now - 11, createPose()),
        w,
        createPose(),
      );
      expect(bodyDiff(evaluate(rel, now, createPose(), false, CAST), want), `+${dt}`).toBeLessThan(1e-9);
    }
  });

  it('pet inputs every 50 ms for 3 s: one pet clip, purr at most every 1200 ms, haptic and mood once', () => {
    const times = Array.from({ length: 61 }, (_, k) => 11 + (k * 50) / 1000);
    const d = drive(
      stateIn('Idle'),
      times.map((t) => petStroke(t)),
      14.5,
    );
    const purrs = d.out.filter((x) => x.o.k === 'toSession');
    expect(purrs.map((x) => x.o)).toStrictEqual([
      toSess('pet', 'purr'),
      toSess('pet', 'purr'),
      toSess('pet', 'purr'),
    ]);
    expect(purrs.map((x) => x.at)).toStrictEqual([times[0], times[24], times[48]]);
    for (let j = 1; j < purrs.length; j++)
      expect(purrs[j]!.at - purrs[j - 1]!.at).toBeGreaterThanOrEqual(1.2 - 1e-9);
    expect(d.out.filter((x) => x.o.k !== 'toSession')).toStrictEqual([
      { at: 11, o: { k: 'haptic', pattern: [15, 35, 15, 35, 15, 35] } },
      { at: 11, o: { k: 'mood', joy: 0.2 } },
    ]);
    expect(new Set(d.states.map((x) => x.s.clip?.start))).toStrictEqual(new Set([11]));
    expect(d.s).toMatchObject({ name: 'Sustained', clip: { name: 'pet', start: 11 } });
  });

  it('releasing squish outputs sfx pop, releasing highFiveL sfx hi; a release with nothing held changes nothing', () => {
    const squish = stepAll(stateIn('Idle'), gest('squish', 'cheekL', 'pinch', 11), release(11.5));
    expect(squish.out).toStrictEqual([toSess('squish', null), toSess('squish', 'pop')]);
    const high = stepAll(stateIn('Idle'), gest('highFiveL', 'pawL', 'longPress', 11), release(11.5));
    expect(high.out).toStrictEqual([toSess('highFiveL', null), toSess('highFiveL', 'hi')]);
    for (const s of [stateIn('Idle'), stepAll(stateIn('Idle'), noseTap(11)).s, squish.s]) {
      const r = directorStep(s, release(11.6), CAST);
      expect(r.state).toBe(s);
      expect(r.out).toStrictEqual([]);
    }
  });

  it('a finite clip under a held gesture restarts once ended: tickles every 600 ms for 2.4 s restart giggle twice', () => {
    const ts = [0, 600, 1200, 1800, 2400].map((ms) => 11 + ms / 1000);
    const d = drive(stateIn('Idle'), ts.map(tickle), 13.5);
    const starts = [
      ...new Set(d.states.flatMap((x) => (x.s.clip?.name === 'giggle' ? [x.s.clip.start] : []))),
    ];
    expect(starts).toStrictEqual([ts[0], ts[2], ts[4]]);
    expect(starts.length - 1).toBeGreaterThanOrEqual(2);
    // Between its end and the next refresh the slot is empty while the reaction stays held.
    expect(d.states.some((x) => x.s.clip === null)).toBe(true);
    expect(d.states.every((x) => x.s.name === 'Sustained')).toBe(true);
    // A refresh while the clip still plays (600 ms < 800 ms) doesn't restart it.
    expect(d.states.find((x) => x.at === ts[1])?.s.clip).toStrictEqual({ name: 'giggle', start: ts[0] });
    expect(sessionNames(d.out.map((x) => x.o))).toStrictEqual(['giggle']);
  });

  it('the ear long-press plays its purr once per press', () => {
    const r = stepAll(
      stateIn('Idle'),
      gest('earDroopL', 'earL', 'longPress', 11),
      release(13),
      tick(13.4),
      gest('earDroopL', 'earL', 'longPress', 14),
    );
    expect(r.out).toStrictEqual([toSess('earDroopL', 'purr'), toSess('earDroopL', 'purr')]);
  });
});

describe('#91 Validation 5: Attentive and Thinking (session rows 23, 27)', () => {
  it('a tap reaction plays its clip additively: the base state stays, and toSession is still output', () => {
    for (const name of ['Attentive', 'Thinking'] as const) {
      const s = stateIn(name);
      const r = stepAll(s, noseTap(10.5));
      expect(r.s).toStrictEqual({
        ...s,
        clip: { name: 'sneeze', start: 10.5 },
        reaction: r.s.reaction,
        cooldowns: [{ region: 'nose', gesture: 'tap', at: 10.5, priority: 2 }],
      });
      expect(r.s.reaction?.r).toBe(R('sneeze'));
      expect(r.out).toStrictEqual([toSess('sneeze', 'sneeze'), TAP_HAPTIC]);
      const done = directorReduce(r.s, tick(10.5 + REACTION_CLIPS.sneeze.duration), CAST);
      expect(done).toStrictEqual({ ...r.s, clip: null, reaction: null });
    }
  });

  it('a held reaction in Attentive eases out after its release and ends 400 ms later, still Attentive', () => {
    const s = stepAll(stateIn('Attentive'), petStroke(10.5), release(11)).s;
    expect(s).toMatchObject({ name: 'Attentive', since: 10, clip: { name: 'pet', start: 10.5 } });
    expect(directorReduce(s, tick(11 + 0.4), CAST)).toMatchObject({
      name: 'Attentive',
      since: 10,
      clip: null,
      reaction: null,
    });
  });

  it('session moves keep an additive reaction: thinking keeps it; a misfire idle → Sustained or Reacting', () => {
    const pet = stepAll(stateIn('Attentive'), petStroke(10.5)).s;
    const thinking = directorReduce(pet, anim({ e: 'thinking' }, 10.6), CAST);
    expect(thinking).toMatchObject({ name: 'Thinking', clip: { name: 'pet', start: 10.5 } });
    expect(thinking.reaction).toBe(pet.reaction);
    expect(directorReduce(pet, anim({ e: 'idle' }, 10.6), CAST)).toMatchObject({
      name: 'Sustained',
      since: 10.6,
      base: 'idle',
      prevBase: 'attentive',
      fadeStart: 10.6,
      clip: { name: 'pet', start: 10.5 },
    });
    const sneeze = stepAll(stateIn('Thinking'), noseTap(10.5)).s;
    expect(directorReduce(sneeze, anim({ e: 'idle' }, 10.6), CAST)).toMatchObject({
      name: 'Reacting',
      since: 10.6,
    });
  });

  it('Reacting and Sustained: attentive → Attentive with the reaction playing on; idle and doze change nothing', () => {
    for (const s of [stepAll(stateIn('Idle'), noseTap(11)).s, stepAll(stateIn('Idle'), petStroke(11)).s]) {
      const r = directorReduce(s, anim({ e: 'attentive' }, 11.1), CAST);
      expect(r).toMatchObject({
        name: 'Attentive',
        since: 11.1,
        base: 'attentive',
        prevBase: 'idle',
        clip: s.clip,
      });
      expect(r.reaction).toBe(s.reaction);
      expect(directorReduce(s, anim({ e: 'idle' }, 11.1), CAST)).toBe(s);
      expect(directorReduce(s, anim({ e: 'doze' }, 11.1), CAST)).toBe(s);
    }
  });
});

describe('#91 Validation 6: Talking (session rows 29–31)', () => {
  it('P2 → a 150 ms flinch clip, the base stays Talking, and the reaction is output with sfx null', () => {
    const s = stateIn('Talking');
    const r = stepAll(s, noseTap(10.5));
    expect(r.s).toStrictEqual({
      ...s,
      clip: { name: 'flinch', start: 10.5 },
      cooldowns: [{ region: 'nose', gesture: 'tap', at: 10.5, priority: 2 }],
    });
    expect(r.out).toStrictEqual([toSess('sneeze', null), TAP_HAPTIC]);
    const squash = (t: number): number =>
      evaluate(r.s, t, createPose(), false, CAST)[Ch.BodySquash]! -
      evaluate(s, t, createPose(), false, CAST)[Ch.BodySquash]!;
    expect(squash(10.5)).toBe(0);
    expect(squash(10.55)).toBeCloseTo(-0.03, 6);
    expect(squash(10.65)).toBe(0);
    expect(directorReduce(r.s, tick(10.65), CAST).clip).toBeNull();
  });

  it('P3 → output with its sfx; the session then stops playback and its talkEnd moves the director to it', () => {
    const r = stepAll(stateIn('Talking'), gest('earDroopL', 'earL', 'longPress', 10.5));
    expect(r.out).toStrictEqual([toSess('earDroopL', 'purr')]);
    expect(r.s).toMatchObject({ name: 'Talking', clip: null, reaction: null });
    expect(r.s.queued).toMatchObject({ r: R('earDroopL'), at: 10.5, announced: true });
    const end = stepAll(r.s, anim({ e: 'talkEnd' }, 10.52));
    expect(end.out).toStrictEqual([]);
    expect(end.s).toMatchObject({
      name: 'Sustained',
      since: 10.52,
      base: 'idle',
      prevBase: 'talking',
      fadeStart: 10.52,
      talk: null,
      mouthCloseStart: 10.52,
      clip: { name: 'earDroopL', start: 10.52 },
      queued: null,
    });
    expect(end.s.cooldowns).toBe(r.s.cooldowns); // started once, at the gesture
  });

  it('P4 → output with its sfx and a Reacting at talkEnd; without a talkEnd within 500 ms it is dropped', () => {
    const r = stepAll(stateIn('Talking'), noseTap(10.5, 3));
    expect(r.out).toStrictEqual([toSess('bigSneeze', 'bigSneeze'), TAP_HAPTIC]);
    expect(stepAll(r.s, anim({ e: 'talkEnd' }, 10.6)).s).toMatchObject({
      name: 'Reacting',
      clip: { name: 'bigSneeze', start: 10.6 },
    });
    expect(directorReduce(r.s, tick(11), CAST)).toBe(r.s);
    const dropped = directorReduce(r.s, tick(11 + 1e-9), CAST);
    expect(dropped).toMatchObject({ name: 'Talking', queued: null });
    expect(directorReduce(r.s, anim({ e: 'talkEnd' }, 11.1), CAST)).toMatchObject({
      name: 'Idle',
      clip: null,
    });
  });

  it('a flinch plays only on a free clip slot', () => {
    const busy: DirectorState = { ...stateIn('Talking'), clip: { name: 'confused', start: 10.4 } };
    const r = stepAll(busy, noseTap(10.5));
    expect(r.s.clip).toBe(busy.clip);
    expect(r.out[0]).toStrictEqual(toSess('sneeze', null));
  });

  it("a flinch over a released reaction whose clip had ended outlives that reaction's end", () => {
    const giggling = stepAll(
      stateIn('Thinking'),
      tickle(10.5),
      tick(10.5 + REACTION_CLIPS.giggle.duration),
      release(11.4),
    ).s;
    expect(giggling).toMatchObject({ name: 'Thinking', clip: null });
    const talking = stepAll(giggling, anim({ e: 'talk', id: 9 }, 11.5), noseTap(11.7)).s;
    expect(talking.clip).toStrictEqual({ name: 'flinch', start: 11.7 });
    expect(directorReduce(talking, tick(11.4 + 0.4), CAST)).toMatchObject({
      name: 'Talking',
      reaction: null,
      clip: { name: 'flinch', start: 11.7 },
    });
  });

  it('talk keeps a sustained reaction (held or easing out) additive, forgets a one-shot, and drops the queue', () => {
    const pet = stepAll(stateIn('Thinking'), petStroke(10.5)).s;
    const talking = stepAll(pet, anim({ e: 'talk', id: 9 }, 11));
    expect(talking.out).toStrictEqual([]);
    expect(talking.s).toMatchObject({ name: 'Talking', clip: { name: 'pet', start: 10.5 }, queued: null });
    expect(talking.s.reaction).toBe(pet.reaction);
    expect(directorReduce(talking.s, tick(100), CAST)).toBe(talking.s); // held: it never ends by itself
    // A P2 meanwhile: no flinch over the held pet, only the output.
    const p2 = stepAll(talking.s, noseTap(11.1));
    expect(p2.s.clip).toStrictEqual({ name: 'pet', start: 10.5 });
    expect(p2.out).toStrictEqual([toSess('sneeze', null), TAP_HAPTIC]);
    const squishing = stepAll(stateIn('Thinking'), gest('squish', 'cheekL', 'pinch', 10.5)).s;
    const released = stepAll(squishing, release(10.6), anim({ e: 'talk', id: 9 }, 10.7)).s;
    expect(released.reaction?.release).toBe(10.6);
    expect(directorReduce(released, tick(10.6 + 0.4), CAST)).toMatchObject({
      name: 'Talking',
      clip: null,
      reaction: null,
    });
    const sneeze = stepAll(stateIn('Thinking'), noseTap(10.5), anim({ e: 'talk', id: 9 }, 10.6)).s;
    expect(sneeze).toMatchObject({ name: 'Talking', clip: { name: 'sneeze', start: 10.5 }, reaction: null });
    expect(directorReduce(sneeze, tick(10.5 + REACTION_CLIPS.sneeze.duration), CAST).clip).toBeNull();
  });

  it('a pet held through the utterance never barges in on the replay (plan review finding 1)', () => {
    /** Pet stroke updates every 50 ms over [fromMs, toMs]. */
    const pets = (fromMs: number, toMs: number): DirInput[] =>
      Array.from({ length: (toMs - fromMs) / 50 + 1 }, (_, k) => petStroke((fromMs + k * 50) / 1000));
    const before = stepAll(
      stateIn('Attentive'),
      ...pets(10_000, 11_150),
      anim({ e: 'thinking' }, 11.2),
      ...pets(11_250, 13_000),
      anim({ e: 'talk', id: 4 }, 13.01),
    );
    expect(sessionNames(before.out)).toStrictEqual(['pet', 'pet', 'pet']); // the purr loop before Talking
    const during = stepAll(before.s, ...pets(13_050, 14_500));
    expect(during.out).toStrictEqual([]);
    expect(during.s).toMatchObject({ name: 'Talking', clip: { name: 'pet', start: 10 } });
    expect(during.s.reaction).toMatchObject({ release: null, last: 14.5 });
    const released = stepAll(during.s, release(14.55));
    expect(released.out).toStrictEqual([]);
    expect(released.s.reaction?.release).toBe(14.55);
    const press = stepAll(released.s, gest('earDroopL', 'earL', 'longPress', 14.6));
    expect(press.out).toStrictEqual([toSess('earDroopL', 'purr')]);
    expect(press.s.queued).toMatchObject({ r: R('earDroopL'), announced: true });
    // Still held at talkEnd: Sustained again, and the purr loop resumes.
    const ended = stepAll(during.s, anim({ e: 'talkEnd' }, 14.6), petStroke(14.65));
    expect(ended.s).toMatchObject({ name: 'Sustained', since: 14.6, clip: { name: 'pet', start: 10 } });
    expect(ended.out).toStrictEqual([toSess('pet', 'purr')]);
    // Released at talkEnd: Sustained until its ease-out ends.
    const after = stepAll(released.s, anim({ e: 'talkEnd' }, 14.7));
    expect(after.s).toMatchObject({ name: 'Sustained', since: 14.7 });
    expect(directorReduce(after.s, tick(14.55 + 0.4), CAST)).toMatchObject({
      name: 'Idle',
      reaction: null,
      clip: null,
    });
  });

  it('a held squish released while Talking outputs no pop; a tickle run held through Talking does not escalate there', () => {
    const squish = stepAll(
      stateIn('Thinking'),
      gest('squish', 'cheekL', 'pinch', 10.5),
      anim({ e: 'talk', id: 9 }, 10.7),
      release(10.9),
    );
    expect(squish.out).toStrictEqual([toSess('squish', null)]);
    const tickling = stepAll(stateIn('Thinking'), ...tickles(10, 2), anim({ e: 'talk', id: 9 }, 10.7));
    const talking = stepAll(tickling.s, ...tickles(11.2, 8));
    expect(talking.out).toStrictEqual([]);
    expect(talking.s.reaction?.r).toBe(R('giggle'));
    expect(talking.s.reaction?.runStart).toBe(10);
    const ended = stepAll(talking.s, anim({ e: 'talkEnd' }, 15.5), tickle(15.6));
    expect(sessionNames(ended.out)).toStrictEqual(['laughFit']);
  });

  it('M36: talk drops a queued reaction', () => {
    const s = stepAll(stateIn('Thinking'), gest('noseWrinkle', 'nose', 'longPress', 10.5), noseTap(10.6)).s;
    expect(s.queued?.r).toBe(R('sneeze'));
    expect(directorReduce(s, anim({ e: 'talk', id: 9 }, 10.7), CAST).queued).toBeNull();
  });

  it('M39: a queued (announced) reaction never starts while Talking, only at talkEnd', () => {
    const s = stepAll(
      stateIn('Thinking'),
      gest('squish', 'cheekL', 'pinch', 10.5),
      release(10.9),
      anim({ e: 'talk', id: 9 }, 11),
      gest('earDroopL', 'earL', 'longPress', 11.1),
      tick(10.9 + 0.4),
    ).s;
    expect(s).toMatchObject({ name: 'Talking', reaction: null });
    expect(s.queued).toMatchObject({ r: R('earDroopL'), announced: true });
    expect(directorReduce(s, anim({ e: 'talkEnd' }, 11.35), CAST)).toMatchObject({
      name: 'Sustained',
      clip: { name: 'earDroopL', start: 11.35 },
    });
  });

  it('M61: repeats count while Talking: the third flick hands dizzy to the session', () => {
    const r = stepAll(stateIn('Talking'), flick(10.5), flick(11.4), flick(12.3));
    expect(r.out.at(-1)).toStrictEqual(toSess('dizzy', 'whoa'));
    expect(r.s.queued).toMatchObject({ r: R('dizzy'), announced: true });
  });
});

describe('#91 Validation 7: anim reaction events are ignored', () => {
  it('in every state, with and without an active or queued reaction: the same state and no output', () => {
    const states: DirectorState[] = [
      ...STATES.map((n) => stateIn(n)),
      stepAll(stateIn('Idle'), noseTap(11)).s,
      stepAll(stateIn('Idle'), petStroke(11)).s,
      stepAll(stateIn('Attentive'), petStroke(11)).s,
      stepAll(stateIn('Talking'), gest('earDroopL', 'earL', 'longPress', 11)).s,
      stepAll(stateIn('Idle'), gest('bellyRub', 'belly', 'longPress', 11), noseTap(11.2)).s,
    ];
    for (const s of states) {
      for (const priority of [1, 2, 3, 4] as const) {
        const r = directorStep(s, anim({ e: 'reaction', name: 'sneeze', priority }, 11.3), CAST);
        expect(r.state).toBe(s);
        expect(r.out).toStrictEqual([]);
      }
    }
  });
});

describe('#91 gates, session events and the mirrored pet', () => {
  it('Asleep and Waking ignore gestures (the app sends tapBear there)', () => {
    for (const s of [stateIn('Asleep'), stateIn('Waking')]) {
      for (const i of [noseTap(10.5), petStroke(10.5), noseTap(10.5, 3), release(10.6)]) {
        const r = directorStep(s, i, CAST);
        expect(r.state).toBe(s);
        expect(r.out).toStrictEqual([]);
      }
    }
  });

  it('Dozing: a gesture moves to Idle first, then is handled as in Idle', () => {
    const r = stepAll(stateIn('Dozing'), noseTap(10.5));
    expect(r.s).toMatchObject({
      name: 'Reacting',
      since: 10.5,
      base: 'idle',
      prevBase: 'dozing',
      fadeStart: 10.5,
      clip: { name: 'sneeze', start: 10.5 },
    });
    const cooled: DirectorState = {
      ...stateIn('Dozing'),
      cooldowns: [{ region: 'nose', gesture: 'tap', at: 10.2, priority: 2 }],
    };
    const ignored = stepAll(cooled, noseTap(10.5));
    expect(ignored.out).toStrictEqual([]);
    expect(ignored.s).toMatchObject({ name: 'Idle', since: 10.5, prevBase: 'dozing', reaction: null });
  });

  it('wake and sleep end the reaction and drop the queue', () => {
    const s = stepAll(stateIn('Idle'), gest('bellyRub', 'belly', 'longPress', 11), noseTap(11.2)).s;
    expect(directorReduce(s, anim({ e: 'wake' }, 11.3), CAST)).toMatchObject({
      name: 'Waking',
      clip: { name: 'wake', start: 11.3 },
      reaction: null,
      queued: null,
    });
    expect(directorReduce(s, anim({ e: 'sleep' }, 11.3), CAST)).toMatchObject({
      name: 'Asleep',
      clip: { name: 'sleep', start: 11.3 },
      reaction: null,
      queued: null,
    });
  });

  it('session additive clips wait while a reaction is active, even after its clip ended', () => {
    const held = stepAll(stateIn('Idle'), tickle(11), tick(11 + REACTION_CLIPS.giggle.duration)).s;
    expect(held).toMatchObject({ name: 'Sustained', clip: null });
    expect(directorReduce(held, anim({ e: 'earTwitch' }, 12), CAST)).toBe(held);
  });

  it('a leftward pet stroke plays the mirrored pet (HeadRot negated); dirX means nothing to other clips', () => {
    const right = stepAll(stateIn('Idle', 0), petStroke(11, 1)).s;
    const left = stepAll(stateIn('Idle', 0), petStroke(11, -1)).s;
    expect(right.clip?.name).toBe('pet');
    expect(left.clip?.name).toBe('petMirrored');
    expect(left.reaction?.clip).toBe('petMirrored');
    const DEG6 = 6 * DEG;
    for (const t of [11.2, 11.4, 12]) {
      const base = evaluate(stateIn('Idle', 0), t, createPose(), false, CAST);
      const r = evaluate(right, t, createPose(), false, CAST);
      const l = evaluate(left, t, createPose(), false, CAST);
      expect(l[Ch.HeadRot]! - base[Ch.HeadRot]!).toBeCloseTo(-(r[Ch.HeadRot]! - base[Ch.HeadRot]!), 12);
      for (let i = 0; i < CH_COUNT; i++) if (i !== Ch.HeadRot) expect(l[i], `${i}`).toBe(r[i]);
    }
    expect(evaluate(left, 11.4, createPose(), false, CAST)[Ch.HeadRot]! - BASE.idle[Ch.HeadRot]!).toBeCloseTo(
      -DEG6,
      6,
    );
    expect(stepAll(stateIn('Idle'), gest('pet', 'belly', 'stroke', 11, -1)).s.clip?.name).toBe('petMirrored');
    expect(stepAll(stateIn('Idle'), gest('blush', 'cheekL', 'stroke', 11, -1)).s.clip?.name).toBe('blush');
  });

  it('every reaction clip of the table is known to evaluate, and an unknown input kind changes nothing', () => {
    for (const r of Object.values(REACTIONS)) {
      for (const clip of [r.clip, r.gentleClip].filter((c) => c !== undefined))
        expect(Object.hasOwn(REACTION_CLIPS, clip), clip).toBe(true);
    }
    const bogus: DirInput = { k: 'tick', now: 11 };
    Reflect.set(bogus, 'k', 'bogus');
    for (const s of [stateIn('Idle'), stepAll(stateIn('Idle'), petStroke(11)).s]) {
      expect(directorReduce(s, bogus, CAST)).toBe(s);
      expect(directorStep(s, bogus, CAST).out).toStrictEqual([]);
    }
  });
});

describe('#91 plan review: edge rules (M16, M19, M21) and a non-finite time', () => {
  it('M16: the repeat count starts over after an escalation, even when another reaction ends it', () => {
    const r = stepAll(
      stateIn('Idle'),
      flick(11),
      flick(11.9),
      flick(12.8),
      gest('hug', 'belly', 'hug', 13),
      release(13.2),
      tick(13.2 + 0.4),
      flick(13.7),
    );
    expect(sessionNames(r.out)).toStrictEqual(['wobble', 'wobble', 'dizzy', 'hug', 'wobble']);
    expect(r.s.clip).toStrictEqual({ name: 'wobble', start: 13.7 });
  });

  it('M19: a gap of exactly maxGapMs continues the run', () => {
    const exact: Reaction = {
      ...R('giggle'),
      escalation: { to: 'laughFit', continuousMs: 3000, maxGapMs: 750 },
    };
    const r = stepAll(
      stateIn('Idle'),
      ...[10, 10.75, 11.5, 12.25, 13, 13.25].map((t) => gest(exact, 'belly', 'tickle', t)),
    );
    expect(sessionNames(r.out)).toStrictEqual(['giggle', 'laughFit']);
    expect(r.s.clip).toStrictEqual({ name: 'laughFit', start: 13.25 });
  });

  it('M21: a refresh restarts an ended finite clip even before any tick has cleared it', () => {
    expect(stepAll(stateIn('Idle'), tickle(11), tickle(11.8125)).s.clip).toStrictEqual({
      name: 'giggle',
      start: 11.8125,
    });
  });

  it('a tick, gesture or release at a non-finite time changes nothing and outputs nothing', () => {
    const held = stepAll(stateIn('Idle'), petStroke(11)).s;
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const i of [release(now), tick(now), petStroke(now), noseTap(now)]) {
        const r = directorStep(held, i, CAST);
        expect(r.state, `${i.k} at ${now}`).toBe(held);
        expect(r.out).toStrictEqual([]);
      }
    }
    // The reaction is still held, and a real release still ends it.
    const ended = stepAll(held, release(Number.NaN), tick(1e9), release(12), tick(12 + 0.4)).s;
    expect(ended).toMatchObject({ name: 'Idle', reaction: null });
  });
});

describe('#91 code review: release identity, a queued sustained reaction, Talking priority', () => {
  it('P14: a release drops a queued sustained reaction behind a one-shot, so it never starts held', () => {
    const r = stepAll(
      stateIn('Idle', 0),
      flick(6),
      flick(7),
      flick(8),
      gest('pet', 'belly', 'stroke', 11.2),
      gest('pet', 'belly', 'stroke', 11.25),
    );
    expect(r.s.queued).toMatchObject({ r: R('pet'), region: 'belly', gesture: 'stroke' });
    const after = stepAll(r.s, release(11.3), tick(11.5));
    expect(after.s).toMatchObject({ name: 'Idle', reaction: null, queued: null });
    expect(after.out).toStrictEqual([]);
  });

  it('P15: a release drops a queued sustained reaction behind a released one', () => {
    const r = stepAll(
      stateIn('Idle', 0),
      gest('hug', 'belly', 'hug', 6),
      release(7),
      petStroke(7.1),
      release(7.2),
      tick(7 + 0.4),
    );
    expect(r.s).toMatchObject({ name: 'Idle', reaction: null, queued: null });
    expect(r.out).toStrictEqual([toSess('hug', 'squeal'), { k: 'mood', joy: 0.2 }]);
  });

  it('A2: in Talking a P3 below the carried-over hug is queued unannounced; a P4 still hands off', () => {
    const talking = stepAll(
      stateIn('Thinking'),
      gest('hug', 'belly', 'hug', 10),
      anim({ e: 'talk', id: 9 }, 11),
    ).s;
    const allOver = stepAll(talking, gest('giggle', 'belly', 'allOver', 12));
    expect(allOver.out).toStrictEqual([]);
    expect(allOver.s).toMatchObject({ name: 'Talking', clip: { name: 'hug', start: 10 } });
    expect(allOver.s.queued).toMatchObject({ r: R('giggle'), announced: false });
    const ended = directorReduce(allOver.s, anim({ e: 'talkEnd' }, 12.01), CAST);
    expect(ended).toMatchObject({ name: 'Sustained', clip: { name: 'hug', start: 10 } });
    expect(ended.reaction?.r).toBe(R('hug'));
    const dizzy = stepAll(talking, flick(11.1), flick(12), flick(12.9));
    expect(dizzy.out.at(-1)).toStrictEqual(toSess('dizzy', 'whoa'));
    expect(dizzy.s.queued).toMatchObject({ r: R('dizzy'), announced: true });
  });

  it('in Talking, an unannounced queued reaction is dropped when the reaction it waited on ends', () => {
    const s = stepAll(
      stateIn('Thinking'),
      gest('hug', 'belly', 'hug', 10),
      anim({ e: 'talk', id: 9 }, 11),
      gest('giggle', 'belly', 'allOver', 12),
      releaseOf('belly', 'hug', 12.1),
    ).s;
    expect(s.queued).toMatchObject({ r: R('giggle'), announced: false }); // another gesture's: kept
    expect(directorReduce(s, tick(12.1 + 0.4), CAST)).toMatchObject({
      name: 'Talking',
      reaction: null,
      queued: null,
    });
  });

  it("B2: one contact's release ends only the reaction its gesture started", () => {
    const s = stepAll(
      stateIn('Idle'),
      gest('headPress', 'headTop', 'longPress', 10),
      gest('bellyRub', 'belly', 'longPress', 10.5),
    ).s;
    expect(s.reaction).toMatchObject({ r: R('bellyRub'), region: 'belly', gesture: 'longPress' });
    const head = directorStep(s, releaseOf('headTop', 'longPress', 11), CAST);
    expect(head.state).toBe(s); // the belly is still held
    expect(head.out).toStrictEqual([]);
    const belly = stepAll(s, releaseOf('belly', 'longPress', 12), tick(12 + 0.4));
    expect(belly.s).toMatchObject({ name: 'Idle', reaction: null });
  });

  it("B3: a stroke's release drops its queued pet and keeps the hug; an identity-less release then ends the hug", () => {
    const s = stepAll(stateIn('Idle'), gest('hug', 'belly', 'hug', 10), petStroke(10.5)).s;
    expect(s.queued).toMatchObject({ r: R('pet'), region: 'headTop', gesture: 'stroke' });
    const stroke = stepAll(s, releaseOf('headTop', 'stroke', 11));
    expect(stroke.out).toStrictEqual([]);
    expect(stroke.s).toMatchObject({ name: 'Sustained', queued: null });
    expect(stroke.s.reaction).toMatchObject({ r: R('hug'), release: null });
    const all = stepAll(stroke.s, release(12), tick(12 + 0.4));
    expect(all.s).toMatchObject({ name: 'Idle', reaction: null, queued: null });
  });

  it('an identity-less release releases the held reaction and drops a queued sustained one, not a one-shot', () => {
    const sustained = stepAll(
      stateIn('Idle'),
      gest('hug', 'belly', 'hug', 10),
      petStroke(10.5),
      release(11),
    ).s;
    expect(sustained.reaction?.release).toBe(11);
    expect(sustained.queued).toBeNull();
    const oneShot = stepAll(
      stateIn('Idle'),
      gest('bellyRub', 'belly', 'longPress', 10),
      noseTap(10.9),
      release(11),
    );
    expect(oneShot.s.reaction?.release).toBe(11);
    expect(oneShot.s.queued?.r).toBe(R('sneeze'));
    expect(stepAll(oneShot.s, tick(11 + 0.4)).s).toMatchObject({
      name: 'Reacting',
      clip: { name: 'sneeze' },
    });
  });

  it('M30: a released reaction still blocks a lower priority until its ease-out ends', () => {
    const r = stepAll(stateIn('Idle'), gest('squish', 'cheekL', 'pinch', 10), release(11), noseTap(11.2));
    expect(r.out).toStrictEqual([toSess('squish', null), toSess('squish', 'pop')]);
    expect(r.s.queued?.r).toBe(R('sneeze'));
    expect(directorReduce(r.s, tick(11 + 0.4), CAST).reaction?.r).toBe(R('sneeze'));
  });

  it('N21: the same reaction after its release is a new run, not a refresh', () => {
    const r = stepAll(stateIn('Idle'), petStroke(10), release(11), petStroke(11.1));
    expect(r.s.reaction).toMatchObject({ start: 11.1, release: null });
    expect(r.out.slice(-3)).toStrictEqual([
      toSess('pet', 'purr'),
      { k: 'haptic', pattern: [15, 35, 15, 35, 15, 35] },
      { k: 'mood', joy: 0.2 },
    ]);
  });

  it("N27: the release ease-out scales only the released reaction's own clip, not a flinch", () => {
    const s = stepAll(
      stateIn('Thinking'),
      tickle(10),
      anim({ e: 'talk', id: 9 }, 10.2),
      tick(10.9),
      release(11),
      noseTap(11.1),
    ).s;
    expect(s.clip).toStrictEqual({ name: 'flinch', start: 11.1 });
    const squash = evaluate(s, 11.15, createPose(), false, CAST)[Ch.BodySquash]!;
    expect(Math.abs(squash - Math.fround(BASE.talking[Ch.BodySquash]! + Math.fround(-0.03)))).toBeLessThan(
      1e-9,
    );
  });
});

// ---- #91 property: random gesture, release, gentle and session sequences ------------------------------------
describe('#91 property: random gesture and session sequences', () => {
  /** A spread of gesture inputs: taps, the big sneeze, long-presses, strokes, tickles, flicks, pinch, hug, all-over. */
  const GESTURES: readonly ((now: number, dirX: -1 | 1) => DirInput)[] = [
    (now) => noseTap(now),
    (now) => noseTap(now, 3),
    (now) => gest('hardBlinkL', 'eyeL', 'tap', now),
    (now) => gest('noseWrinkle', 'nose', 'longPress', now),
    (now) => gest('highFiveR', 'pawR', 'longPress', now),
    (now, dirX) => petStroke(now, dirX),
    (now) => gest('againstFur', 'headTop', 'stroke', now),
    (now) => tickle(now),
    (now) => flick(now),
    (now) => gest('squish', 'cheekL', 'pinch', now),
    (now) => gest('hug', 'belly', 'hug', now),
    (now) => gest('giggle', 'belly', 'allOver', now),
  ];
  type Kind = AnimKind | 'tick' | 'gesture' | 'release' | 'releaseOf' | 'gentleOn' | 'gentleOff' | 'clip';
  const STEP = fc.record({
    kind: fc.constantFrom<Kind>(
      ...KINDS,
      'tick',
      'tick',
      'tick',
      'gesture',
      'gesture',
      'gesture',
      'release',
      'releaseOf',
      'releaseOf',
      'gentleOn',
      'gentleOff',
      'clip', // #115
    ),
    g: fc.integer({ min: 0, max: GESTURES.length - 1 }),
    dirX: fc.constantFrom<-1 | 1>(-1, 1),
    dt: fc.integer({ min: 0, max: 120 }), // 10 ms grid, 0–1.2 s
  });
  const KNOWN_CLIPS = new Set([
    ...Object.keys(SESSION_CLIPS),
    ...Object.keys(REACTION_CLIPS),
    ...Object.keys(MIME_CLIPS),
    'flinch',
    'petMirrored',
  ]);

  function input(kind: Kind, g: number, dirX: -1 | 1, now: number): DirInput {
    switch (kind) {
      case 'tick':
        return tick(now);
      case 'gesture':
        return GESTURES[g]!(now, dirX);
      case 'release':
        return release(now);
      case 'releaseOf': {
        // The end of one contact: the release of gesture `g`'s region and kind (Decision 16).
        const gi = GESTURES[g]!(now, dirX);
        return gi.k === 'gesture' ? releaseOf(gi.region, gi.gesture, now) : release(now);
      }
      case 'gentleOn':
        return gentle(true);
      case 'gentleOff':
        return gentle(false);
      case 'clip': // #115: the mime, or a clip with a gentle variant
        return { k: 'clip', name: g % 2 === 0 ? 'cuppedEar' : 'sneeze', now };
      default:
        return anim(SAMPLES[kind], now);
    }
  }

  it('keeps the invariants, agrees with directorReduce, is pure, and outputs only table reactions (300 runs)', () => {
    fc.assert(
      fc.property(fc.array(STEP, { minLength: 1, maxLength: 80 }), (seq) => {
        let s = initialDirector(0);
        let now = 0;
        const pose = createPose().fill(Number.NaN);
        for (const [j, m] of MOUTH.entries()) pose[m] = 100 + j;
        for (const { kind, g, dirX, dt } of seq) {
          now += dt / 100;
          const prev = deepFreeze(s);
          const snapshot = structuredClone(prev);
          const i = input(kind, g, dirX, now);
          const { state: r, out } = directorStep(prev, i, CAST);
          expect(prev).toStrictEqual(snapshot); // frozen input, never written
          expect(directorReduce(prev, i, CAST)).toStrictEqual(r);
          expect(r === prev || !isDeepStrictEqual(r, prev)).toBe(true);
          expect(r.base).toBe(BASE_OF_STATE[r.name]);
          expect(r.talk !== null).toBe(r.name === 'Talking');
          if (r.name === 'Reacting' || r.name === 'Sustained') {
            expect(r.reaction).not.toBeNull();
            expect(r.reaction!.r.sustained).toBe(r.name === 'Sustained');
          }
          if (r.name === 'Asleep' || r.name === 'Waking') {
            expect(r.reaction).toBeNull();
            expect(r.queued).toBeNull();
          }
          if (r.name === 'Idle' || r.name === 'Dozing') expect(r.reaction).toBeNull();
          if (r.name === 'Talking') {
            expect(r.reaction === null || r.reaction.r.sustained).toBe(true); // a sustained one carried over
            // Announced, or queued behind a higher-priority carried-over reaction (code review finding 2).
            expect(
              r.queued === null ||
                r.queued.announced ||
                (r.reaction !== null && r.queued.r.priority < r.reaction.r.priority),
            ).toBe(true);
          }
          // Every contact up: nothing sustained stays held or queued (code review findings 1 and 3).
          if (i.k === 'release' && i.region === undefined) {
            expect(r.reaction === null || !r.reaction.r.sustained || r.reaction.release !== null).toBe(true);
            expect(r.queued === null || !r.queued.r.sustained).toBe(true);
          }
          // While Talking, the carried-over reaction's refreshes and release output nothing (finding 1).
          const carried = prev.name === 'Talking' ? prev.reaction : null;
          if (
            carried !== null &&
            carried.release === null &&
            (i.k === 'release' || (i.k === 'gesture' && i.r.name === carried.r.name))
          )
            expect(out).toStrictEqual([]);
          if (r.reaction !== null && !r.reaction.r.sustained) expect(r.reaction.release).toBeNull();
          if (r.clip !== null) {
            expect(KNOWN_CLIPS.has(r.clip.name), r.clip.name).toBe(true);
            expect(r.clip.start).toBeLessThanOrEqual(now);
          }
          if (r.prevClip !== null) {
            expect(KNOWN_CLIPS.has(r.prevClip.name), r.prevClip.name).toBe(true);
            expectCutClip(r.prevClip, i.k === 'tick', now);
            if (r.prevClip !== prev.prevClip) expectSeamlessCut(prev, r, now);
          }
          expectNoWorseSecondCut(prev, r, now);
          if (prev.name === 'Asleep' || prev.name === 'Waking') {
            if (i.k === 'gesture' || i.k === 'release' || i.k === 'clip') expect(r).toBe(prev);
          }
          if (i.k === 'clip') expect(out).toStrictEqual([]); // #115: a clip input outputs nothing
          for (const o of out) {
            if (o.k === 'toSession') {
              const t = REACTIONS[o.ev.name];
              expect(t, o.ev.name).toBeDefined();
              expect(o.ev.priority).toBe(t!.priority);
              expect([t!.sfx, t!.sfxOnRelease ?? null, null]).toContain(o.ev.sfx);
            }
          }
          evaluate(r, now, pose, false, CAST);
          for (const [j, m] of MOUTH.entries()) expect(pose[m]).toBe(100 + j);
          for (let c = 0; c < CH_COUNT; c++)
            if (!MOUTH.includes(c)) expect(Number.isFinite(pose[c])).toBe(true);
          s = r;
        }
      }),
      { numRuns: 300 },
    );
  });
});

/** A held pet (its clip is `sustained`): nothing is due on any tick. */
const heldPet = (): DirectorState => stepAll(stateIn('Idle'), petStroke(11)).s;

// ==== #115: the clip input =========================================================================================
/** A `{k:'clip'}` input for clip `name` at `now`. */
const clipIn = (name: string, now: number): DirInput => ({ k: 'clip', name, now });
/** The cupped ear's length (s). */
const CUP_S = MIME_CLIPS.cuppedEar.duration;

describe('#115: the clip input', () => {
  it('Validation 4: in Idle, {k:"clip", name:"cuppedEar"} plays cuppedEar and outputs nothing, then ends in Idle', () => {
    const r = directorStep(stateIn('Idle'), clipIn('cuppedEar', 11), CAST);
    expect(r.out).toStrictEqual([]);
    expect(r.state.name).toBe('Reacting');
    expect(r.state.clip).toStrictEqual({ name: 'cuppedEar', start: 11 });
    expect(r.state.reaction?.r).toStrictEqual({
      name: 'cuppedEar',
      priority: 2,
      sfx: null,
      clip: 'cuppedEar',
      sustained: false,
    });
    expect([r.state.reaction?.region, r.state.reaction?.gesture]).toStrictEqual([null, null]);
    const d = drive(stateIn('Idle'), [clipIn('cuppedEar', 11)], 11 + CUP_S + 0.1);
    expect(d.out).toStrictEqual([]);
    const last = d.states.filter((x) => x.s.clip?.name === 'cuppedEar').at(-1);
    expect(last?.at).toBeLessThan(11 + CUP_S);
    expect(d.s.name).toBe('Idle');
    expect(d.s.clip).toBeNull();
    expect(d.s.reaction).toBeNull();
  });

  it('has no cooldown and is not counted: a second clip 100 ms later restarts it, cooldowns and repeats untouched', () => {
    const idle = stateIn('Idle');
    const one = directorStep(idle, clipIn('cuppedEar', 11), CAST).state;
    const two = directorStep(one, clipIn('cuppedEar', 11.1), CAST);
    expect(two.out).toStrictEqual([]);
    expect(two.state.clip).toStrictEqual({ name: 'cuppedEar', start: 11.1 });
    expect(two.state.cooldowns).toBe(idle.cooldowns);
    expect(two.state.repeats).toBe(idle.repeats);
    // A gesture's cooldown on (nose, tap) doesn't stop a clip either.
    const sneezed = stepAll(idle, noseTap(11)).s;
    const after = directorStep(sneezed, clipIn('sneeze', 11.2), CAST);
    expect(after.state.clip).toStrictEqual({ name: 'sneeze', start: 11.2 });
    expect(after.state.cooldowns).toBe(sneezed.cooldowns);
    expect(after.out).toStrictEqual([]);
  });

  it('Gentle: a clip with a <name>Gentle variant plays it; cuppedEar has none and plays itself', () => {
    const g = run(stateIn('Idle'), gentle(true));
    expect(directorReduce(g, clipIn('sneeze', 11), CAST).clip?.name).toBe('sneezeGentle');
    expect(directorReduce(g, clipIn('cuppedEar', 11), CAST).clip?.name).toBe('cuppedEar');
    expect(directorReduce(stateIn('Idle'), clipIn('sneeze', 11), CAST).clip?.name).toBe('sneeze');
  });

  it('is queued behind a held P3 (no output) and starts at its end within 500 ms; dropped when later', () => {
    const held = stepAll(stateIn('Idle'), gest('noseWrinkle', 'nose', 'longPress', 11)).s;
    const q = directorStep(held, clipIn('cuppedEar', 11.2), CAST);
    expect(q.out).toStrictEqual([]);
    expect(q.state.clip?.name).toBe('noseWrinkle');
    expect(q.state.queued).toMatchObject({
      r: { name: 'cuppedEar', priority: 2 },
      region: null,
      gesture: null,
    });
    // Released at 11.25: it ends at 11.65, inside the 500 ms (queued at 11.2 → until 11.7).
    const soon = drive(q.state, [releaseOf('nose', 'longPress', 11.25)], 11.7);
    expect(soon.out).toStrictEqual([]);
    const started = soon.states.find((x) => x.s.clip?.name === 'cuppedEar');
    expect(started?.at).toBeCloseTo(11.65, 2);
    expect(started?.s.reaction?.r.name).toBe('cuppedEar');
    // Released at 11.4: it ends at 11.8, after the queued clip's 500 ms: dropped, never played.
    const late = drive(q.state, [releaseOf('nose', 'longPress', 11.4)], 12.5);
    expect(late.states.some((x) => x.s.clip?.name === 'cuppedEar')).toBe(false);
    expect(late.s.queued).toBeNull();
  });

  it('interrupts a P2 or a P1, and a P3 gesture interrupts it with only its own outputs', () => {
    const waving = stepAll(stateIn('Idle'), gest('pawWaveL', 'pawL', 'tap', 11)).s;
    const over = directorStep(waving, clipIn('cuppedEar', 11.3), CAST);
    expect(over.out).toStrictEqual([]);
    expect(over.state.clip?.name).toBe('cuppedEar');
    expect(over.state.reaction?.r.name).toBe('cuppedEar');
    const p1: Reaction = { name: 'nudge', priority: 1, sfx: null, clip: 'earTwitch', sustained: false };
    const nudged = stepAll(stateIn('Idle'), gest(p1, 'earL', 'tap', 11)).s;
    expect(directorReduce(nudged, clipIn('cuppedEar', 11.1), CAST).clip?.name).toBe('cuppedEar');
    const cupped = directorReduce(stateIn('Idle'), clipIn('cuppedEar', 11), CAST);
    const squished = stepAll(cupped, gest('squish', 'cheekL', 'pinch', 11.5));
    expect(squished.s.clip?.name).toBe('squish');
    expect(squished.out).toStrictEqual([
      { k: 'toSession', ev: { t: 'reaction', name: 'squish', priority: 3, sfx: null } },
    ]);
  });

  it('gates: Asleep and Waking ignore it, Dozing moves to Idle first, an unknown name or a non-finite time changes nothing', () => {
    for (const name of ['Asleep', 'Waking'] as const) {
      const s = stateIn(name);
      expect(directorReduce(s, clipIn('cuppedEar', 10.5), CAST), name).toBe(s);
      expect(directorStep(s, clipIn('cuppedEar', 10.5), CAST).out, name).toStrictEqual([]);
    }
    const dozing = stateIn('Dozing');
    const woke = directorReduce(dozing, clipIn('cuppedEar', 11), CAST);
    expect(woke.name).toBe('Reacting');
    expect(woke.base).toBe('idle');
    expect(woke.prevBase).toBe('dozing');
    expect(woke.clip?.name).toBe('cuppedEar');
    const idle = stateIn('Idle');
    expect(directorReduce(idle, clipIn('mystery', 11), CAST)).toBe(idle);
    for (const t of [Number.NaN, Number.POSITIVE_INFINITY])
      expect(directorReduce(idle, clipIn('cuppedEar', t), CAST)).toBe(idle);
  });

  it('Talking: a flinch on a free clip slot, nothing on a busy one, no output, still Talking', () => {
    const talking = stateIn('Talking');
    const r = directorStep(talking, clipIn('cuppedEar', 11), CAST);
    expect(r.out).toStrictEqual([]);
    expect(r.state.name).toBe('Talking');
    expect(r.state.clip).toStrictEqual({ name: 'flinch', start: 11 });
    expect(r.state.reaction).toBeNull();
    expect(directorReduce(r.state, clipIn('cuppedEar', 11.05), CAST)).toBe(r.state);
  });

  it('Attentive: it plays additively and the state stays Attentive', () => {
    const s = directorReduce(stateIn('Attentive'), clipIn('cuppedEar', 11), CAST);
    expect(s.name).toBe('Attentive');
    expect(s.base).toBe('attentive');
    expect(s.clip?.name).toBe('cuppedEar');
    expect(s.reaction?.r.name).toBe('cuppedEar');
  });

  it('a release, with or without an identity, never ends a clip reaction', () => {
    const s = directorReduce(stateIn('Idle'), clipIn('cuppedEar', 11), CAST);
    expect(directorReduce(s, release(11.2), CAST)).toBe(s);
    expect(directorReduce(s, releaseOf('earL', 'longPress', 11.2), CAST)).toBe(s);
  });

  it('clipByName knows the mime', () => {
    expect(clipByName('cuppedEar', CAST)).toBe(MIME_CLIPS.cuppedEar);
  });
});

// ==== #317: a repeated input at the same instant returns the same state ===========================================
/** One `directorStep` from `s`, checking the #91 identity invariant (the same object back, or a state that differs). */
function stepKeepingIdentity(s: DirectorState, i: DirInput, what: string): DirectorState {
  const r = directorStep(s, i, CAST).state;
  expect(r === s || !isDeepStrictEqual(r, s), what).toBe(true);
  const reduced = directorReduce(s, i, CAST);
  if (r === s) expect(reduced, what).toBe(s);
  else expect(reduced, what).toStrictEqual(r);
  return r;
}

/** `directorStep(s, i)` returns `s` itself, with no output. */
function expectSameState(s: DirectorState, i: DirInput): void {
  const r = directorStep(s, i, CAST);
  expect(r.state).toBe(s);
  expect(r.out).toStrictEqual([]);
}

describe('#317: a repeated input at the same instant returns the same state (the #91 identity invariant)', () => {
  it('the #91 property counterexample [idle, clip(cuppedEar), clip(cuppedEar), wake], all at 0', () => {
    // fast-check 4.10.2 { seed: 1700979257, path: "63:1:0:2:2:2:2:5:5:5:7:7:7:7:7:7:7" }: the second clip input
    // returned a new state deep-equal to its input.
    const seq: readonly DirInput[] = [
      anim(SAMPLES.idle, 0),
      clipIn('cuppedEar', 0),
      clipIn('cuppedEar', 0),
      anim(SAMPLES.wake, 0),
    ];
    let s = initialDirector(0);
    for (const [j, i] of seq.entries()) s = stepKeepingIdentity(s, i, `step ${j + 1}`);
    expect(s).toMatchObject({ name: 'Waking', clip: { name: 'wake', start: 0 }, reaction: null });
  });

  it('a clip input again at its instant returns the state itself (playing, additive, queued); later, another clip or Gentle restarts it', () => {
    const cupped = directorReduce(stateIn('Idle'), clipIn('cuppedEar', 11), CAST);
    expect(directorStep(cupped, clipIn('cuppedEar', 11), CAST).state).toBe(cupped);
    expect(directorReduce(cupped, clipIn('cuppedEar', 11.01), CAST).clip).toStrictEqual({
      name: 'cuppedEar',
      start: 11.01,
    });
    const sneezed = directorReduce(stateIn('Idle'), clipIn('sneeze', 11), CAST);
    expect(directorReduce(sneezed, clipIn('sneeze', 11), CAST)).toBe(sneezed);
    expect(run(sneezed, gentle(true), clipIn('sneeze', 11)).clip).toStrictEqual({
      name: 'sneezeGentle',
      start: 11,
    });
    expect(directorReduce(sneezed, clipIn('cuppedEar', 11), CAST).clip).toStrictEqual({
      name: 'cuppedEar',
      start: 11,
    });
    const additive = directorReduce(stateIn('Attentive'), clipIn('cuppedEar', 11), CAST);
    expect(additive.name).toBe('Attentive');
    expect(directorStep(additive, clipIn('cuppedEar', 11), CAST).state).toBe(additive);
    const held = stepAll(stateIn('Idle'), gest('noseWrinkle', 'nose', 'longPress', 11)).s;
    const queued = directorReduce(held, clipIn('cuppedEar', 11.2), CAST);
    expect(queued.queued).toMatchObject({ r: { name: 'cuppedEar' }, at: 11.2 });
    expect(directorStep(queued, clipIn('cuppedEar', 11.2), CAST).state).toBe(queued);
    expect(directorReduce(queued, clipIn('cuppedEar', 11.3), CAST).queued).toMatchObject({
      r: { name: 'cuppedEar' },
      at: 11.3,
    });
  });

  it('a gesture: a refresh at the instant of the last one, or the same reaction queued again at its instant, returns the state itself', () => {
    const petted = stepAll(stateIn('Idle'), petStroke(11)).s;
    expectSameState(petted, petStroke(11));
    expect(directorReduce(petted, petStroke(11.1), CAST).reaction).toMatchObject({ start: 11, last: 11.1 });
    const pressed = stepAll(stateIn('Idle'), gest('noseWrinkle', 'nose', 'longPress', 11)).s;
    expect(directorReduce(pressed, gest('noseWrinkle', 'nose', 'longPress', 11), CAST)).toBe(pressed);
    const hugged = stepAll(stateIn('Idle'), gest('hug', 'belly', 'hug', 11), noseTap(11.1)).s;
    expect(hugged.queued).toMatchObject({ r: R('sneeze'), at: 11.1, announced: false });
    expectSameState(hugged, noseTap(11.1));
    expect(directorReduce(hugged, noseTap(11.2), CAST).queued).toMatchObject({ r: R('sneeze'), at: 11.2 });
    // While Talking: a P3 queued unannounced behind the carried-over hug (A2), again at its instant.
    const talking = stepAll(
      stateIn('Thinking'),
      gest('hug', 'belly', 'hug', 10),
      anim({ e: 'talk', id: 9 }, 11),
      gest('giggle', 'belly', 'allOver', 12),
    ).s;
    expect(talking.queued).toMatchObject({ r: R('giggle'), at: 12, announced: false });
    expectSameState(talking, gest('giggle', 'belly', 'allOver', 12));
  });

  it('a different input at the same instant still changes the state: every guard keeps the fields that differ', () => {
    const tapped = stepAll(stateIn('Idle'), noseTap(11)).s;
    expect(directorReduce(tapped, clipIn('sneeze', 11), CAST).reaction).toMatchObject({
      region: null,
      gesture: null,
    });
    const gentleClip = run(stateIn('Idle'), gentle(true), clipIn('sneezeGentle', 11));
    expect(directorReduce(gentleClip, clipIn('sneeze', 11), CAST).reaction?.r.name).toBe('sneeze');
    const held = stepAll(stateIn('Idle'), gest('noseWrinkle', 'nose', 'longPress', 11)).s;
    const queued = directorReduce(held, clipIn('cuppedEar', 11.2), CAST);
    expect(directorReduce(queued, clipIn('sneeze', 11.2), CAST).queued).toMatchObject({
      r: { name: 'sneeze' },
      at: 11.2,
    });
    const hugged = stepAll(stateIn('Idle'), gest('hug', 'belly', 'hug', 11), tickle(11.1)).s;
    expect(directorReduce(hugged, gest('giggle', 'belly', 'allOver', 11.1), CAST).queued).toMatchObject({
      gesture: 'allOver',
    });
    const petQ = stepAll(stateIn('Idle'), gest('hug', 'belly', 'hug', 11), petStroke(11.1, 1)).s;
    expect(directorReduce(petQ, petStroke(11.1, -1), CAST).queued).toMatchObject({ dirX: -1 });
    expect(directorReduce(petQ, gest('pet', 'belly', 'stroke', 11.1, 1), CAST).queued).toMatchObject({
      region: 'belly',
    });
    const back = stepAll(
      stateIn('Thinking'),
      petStroke(10),
      anim({ e: 'talk', id: 9 }, 10.5),
      petStroke(12),
      anim({ e: 'talkEnd' }, 12),
    ).s;
    const r = directorStep(back, petStroke(12), CAST);
    expect(r.out).toStrictEqual([toSess('pet', 'purr')]);
    expect(r.state.reaction).toMatchObject({ last: 12, sfxAt: 12 });
  });
});

// ==== #117: the session's tooLoud reaction through the clip input =================================================
/** tooLoud's length (s). */
const LOUD_S = MIME_CLIPS.tooLoud.duration;

describe('#117: tooLoud through the clip input', () => {
  it('Validation 1: in Idle, {k:"clip", name:"tooLoud"} plays tooLoud as a quiet P2, then Idle', () => {
    const r = directorStep(stateIn('Idle'), clipIn('tooLoud', 11), CAST);
    expect(r.out).toStrictEqual([]);
    expect(r.state.name).toBe('Reacting');
    expect(r.state.clip).toStrictEqual({ name: 'tooLoud', start: 11 });
    expect(r.state.reaction?.r).toStrictEqual({
      name: 'tooLoud',
      priority: 2,
      sfx: null,
      clip: 'tooLoud',
      sustained: false,
      gentleClip: 'tooLoudGentle',
    });
    const d = drive(stateIn('Idle'), [clipIn('tooLoud', 11)], 11 + LOUD_S + 0.1);
    expect(d.out).toStrictEqual([]);
    const last = d.states.filter((x) => x.s.clip?.name === 'tooLoud').at(-1);
    expect(last?.at).toBeLessThan(11 + LOUD_S);
    expect(d.s.name).toBe('Idle');
    expect(d.s.clip).toBeNull();
    expect(d.s.reaction).toBeNull();
  });

  it('Validation 1: with gentle on it plays tooLoudGentle; off, tooLoud', () => {
    const on = directorReduce(run(stateIn('Idle'), gentle(true)), clipIn('tooLoud', 11), CAST);
    expect(on.clip).toStrictEqual({ name: 'tooLoudGentle', start: 11 });
    expect(on.reaction?.r.name).toBe('tooLoud');
    expect(directorReduce(stateIn('Idle'), clipIn('tooLoud', 11), CAST).clip?.name).toBe('tooLoud');
  });

  it("row 28's order: talkEnd, then the clip, plays the whole clip (in Talking it would be the flinch)", () => {
    const s = run(stateIn('Talking'), anim({ e: 'talkEnd' }, 11), clipIn('tooLoud', 11));
    expect(s.name).toBe('Reacting');
    expect(s.clip).toStrictEqual({ name: 'tooLoud', start: 11 });
    expect(directorReduce(stateIn('Talking'), clipIn('tooLoud', 11), CAST).clip?.name).toBe('flinch');
  });

  it("the session's anim reaction tooLoud itself stays ignored by the director's table (#91)", () => {
    const idle = stateIn('Idle');
    expect(directorReduce(idle, anim({ e: 'reaction', name: 'tooLoud', priority: 2 }, 11), CAST)).toBe(idle);
  });

  it('it interrupts a P2 tap reaction with the #240 crossfade, and waits behind a held P3', () => {
    const sneezing = stepAll(stateIn('Idle'), noseTap(11)).s;
    expect(sneezing.clip?.name).toBe('sneeze');
    const cut = directorStep(sneezing, clipIn('tooLoud', 11.2), CAST);
    expect(cut.out).toStrictEqual([]);
    expect(cut.state.clip).toStrictEqual({ name: 'tooLoud', start: 11.2 });
    expect(cut.state.prevClip).toStrictEqual({ name: 'sneeze', start: 11, cutAt: 11.2, release: null });

    const held = stepAll(stateIn('Idle'), gest('noseWrinkle', 'nose', 'longPress', 11)).s;
    const q = directorStep(held, clipIn('tooLoud', 11.2), CAST);
    expect(q.out).toStrictEqual([]);
    expect(q.state.clip?.name).toBe('noseWrinkle');
    expect(q.state.queued?.r.name).toBe('tooLoud');
  });

  it('clipByName knows both clips', () => {
    expect(clipByName('tooLoud', CAST)).toBe(MIME_CLIPS.tooLoud);
    expect(clipByName('tooLoudGentle', CAST)).toBe(MIME_CLIPS.tooLoudGentle);
  });
});

describe('#91 allocation: quiet ticks and the release ease-out', () => {
  it('10 000 ticks while a reaction is held: the same state, and directorStep the same frozen result', () => {
    const s = heldPet();
    const tickIn = { k: 'tick' as const, now: 11 };
    let first = directorStep(s, tickIn, CAST);
    let sameState = 0;
    let sameStep = 0;
    for (let i = 0; i < 10_000; i++) {
      tickIn.now = 11.01 + i * 0.01;
      const r = directorStep(s, tickIn, CAST);
      if (r.state === s) sameState++;
      if (r === first) sameStep++;
      first = r;
    }
    expect(sameState).toBe(10_000);
    expect(sameStep).toBe(10_000);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.out).toHaveLength(0);
    expect(countAllocations(() => void directorStep(s, tickIn, CAST))).toBe(0);
  });

  it('grows the heap by < 1 MB over 100 000 quiet directorStep ticks, once V8 has optimised it', () => {
    const s = heldPet();
    const tickIn = { k: 'tick' as const, now: 11 };
    const runAll = (): void => {
      for (let i = 0; i < 100_000; i++) {
        tickIn.now = 11 + i * 1e-4;
        directorStep(s, tickIn, CAST);
      }
    };
    forceGc();
    for (let w = 0; w < 3; w++) runAll();
    const LIMIT = 1_048_576;
    let best = heapGrowth(runAll);
    for (let trial = 1; trial < 20 && best >= LIMIT; trial++) best = Math.min(best, heapGrowth(runAll));
    expect(best).toBeLessThan(LIMIT);
  });

  it('evaluate of a released reaction easing out makes no array allocation', () => {
    const s = stepAll(stateIn('Idle'), petStroke(11), release(12)).s;
    const out = createPose();
    expect(
      countAllocations(() => {
        for (let i = 0; i < 1000; i++) evaluate(s, 12 + i * 0.0005, out, false, CAST);
      }),
    ).toBe(0);
  });
});

// ==== #240: a clip cut while playing crossfades out over 100 ms ===================================================
/** One cut: `input` at `at` replaces the clip `before` is playing. */
interface Cut {
  label: string;
  before: DirectorState;
  input: DirInput;
  at: number;
}

/** The cuts #240 names: interruptions, an additive reaction, the flinch, a release ease-out, wake and sleep. */
function cuts(): Cut[] {
  const idle = stateIn('Idle');
  return [
    {
      label: 'hug (P4) over a running dizzy',
      before: stepAll(idle, flick(11), flick(12), flick(13)).s,
      input: gest('hug', 'belly', 'hug', 13.5),
      at: 13.5,
    },
    {
      label: 'a P3 long-press over a playing P2 sneeze',
      before: stepAll(idle, noseTap(11)).s,
      input: gest('earDroopL', 'earL', 'longPress', 11.2),
      at: 11.2,
    },
    {
      label: 'Attentive: an additive sneeze over an additive cheek puff',
      before: stepAll(stateIn('Attentive'), gest('cheekPuffR', 'cheekR', 'tap', 11)).s,
      input: noseTap(11.2),
      at: 11.2,
    },
    {
      label: 'talkEnd: the announced reaction starts over the flinch',
      before: stepAll(
        stateIn('Talking'),
        gest('cheekPuffR', 'cheekR', 'tap', 11),
        gest('earDroopL', 'earL', 'longPress', 11.05),
      ).s,
      input: anim({ e: 'talkEnd' }, 11.1),
      at: 11.1,
    },
    {
      label: 'hug over a released pet easing out',
      before: stepAll(idle, petStroke(11), release(12)).s,
      input: gest('hug', 'belly', 'hug', 12.2),
      at: 12.2,
    },
    {
      label: 'wake over a playing shrug',
      before: playing('shrug'),
      input: anim({ e: 'wake' }, 10.6),
      at: 10.6,
    },
    {
      label: 'sleep over a held hug',
      before: stepAll(idle, gest('hug', 'belly', 'hug', 11)).s,
      input: anim({ e: 'sleep' }, 11.5),
      at: 11.5,
    },
  ];
}

/** `s` without its cut clip: the incoming clip alone. */
const incoming = (s: DirectorState): DirectorState => ({ ...s, prevClip: null });

/** The outgoing clip alone on `after`'s base: its clip back in the slot, under the reaction it played for. */
const outgoing = (before: DirectorState, after: DirectorState): DirectorState => ({
  ...after,
  clip: before.clip,
  reaction: before.reaction,
  prevClip: null,
});

/** `evaluate(s, now)` into a fresh pose. */
const poseAt = (s: DirectorState, now: number): Pose => evaluate(s, now, createPose(), false, CAST);

/** V8's `%HaveSameMap`, through natives syntax (enabled at run time, as `--expose-gc` is for the heap tests). */
function sameMapFn(): (a: unknown, b: unknown) => boolean {
  setFlagsFromString('--allow-natives-syntax');
  const f: unknown = runInThisContext('(function (a, b) { return %HaveSameMap(a, b); })');
  if (typeof f !== 'function') throw new Error('%HaveSameMap is not available');
  return (a, b) => f(a, b) === true;
}

describe('#281: clips, reactions and cut clips share the hidden classes their templates keep alive', () => {
  it("every clip slot object (wake, an additive clip, a start, a refresh restart, both flinches) has CLIP_TEMPLATE's class", () => {
    const sameMap = sameMapFn();
    const idle = stateIn('Idle');
    const refreshed = stepAll(idle, ...tickles(11, 5)).s;
    // The last tickle's refresh restarted giggle: its clip is newer than its reaction.
    expect(refreshed.clip!.start).toBeGreaterThan(refreshed.reaction!.start);
    const fixtures: [string, DirectorState][] = [
      ['wake', playing('wake')],
      ['additive confused', playing('confused')],
      ['a started sneeze', stepAll(idle, noseTap(11)).s],
      ['a refresh restart', refreshed],
      ['the flinch of a tap', stepAll(stateIn('Talking'), gest('cheekPuffR', 'cheekR', 'tap', 11)).s],
      ['the flinch of a clip input', stepAll(stateIn('Talking'), clipIn('cuppedEar', 11)).s],
    ];
    for (const [label, s] of fixtures) {
      expect(s.clip, label).not.toBeNull();
      expect(sameMap(s.clip, CLIP_TEMPLATE), label).toBe(true);
    }
  });

  it("every reaction (started with and without a gesture, refreshed, released) has REACTION_TEMPLATE's class", () => {
    const sameMap = sameMapFn();
    const idle = stateIn('Idle');
    const refreshed = stepAll(idle, ...tickles(11, 5)).s.reaction;
    const released = stepAll(idle, petStroke(11), release(12)).s.reaction;
    expect(refreshed!.last).toBeGreaterThan(refreshed!.start);
    expect(released!.release).toBe(12);
    const fixtures: [string, DirectorState['reaction']][] = [
      ['a started sneeze', stepAll(idle, noseTap(11)).s.reaction],
      ['a clip input (no gesture)', stepAll(idle, clipIn('cuppedEar', 11)).s.reaction],
      ['a refreshed giggle', refreshed],
      ['a released pet', released],
    ];
    for (const [label, a] of fixtures) {
      expect(a, label).not.toBeNull();
      expect(sameMap(a, REACTION_TEMPLATE), label).toBe(true);
    }
  });

  it("every prevClip, with and without a release, has CUT_CLIP_TEMPLATE's class", () => {
    const sameMap = sameMapFn();
    let released = 0;
    for (const { label, before, input } of cuts()) {
      const p = stepAll(before, input).s.prevClip;
      expect(p, label).not.toBeNull();
      if (p?.release !== null) released++;
      expect(sameMap(p, CUT_CLIP_TEMPLATE), label).toBe(true);
    }
    expect(released, 'a cut with a release').toBeGreaterThan(0);
  });
});

describe('#240: a clip cut while playing crossfades out over 100 ms', () => {
  it("evaluate at the cut equals the outgoing clip's pose (±1e-6), where the incoming clip alone would jump", () => {
    for (const { label, before, input, at } of cuts()) {
      const after = stepAll(before, input).s;
      const c = before.clip!;
      const a = before.reaction;
      expect(after.clip, label).not.toBeNull();
      expect(after.prevClip, label).toStrictEqual({
        name: c.name,
        start: c.start,
        cutAt: at,
        release: a !== null && a.clip === c.name ? a.release : null,
      });
      const was = poseAt(before, at);
      expect(bodyDiff(poseAt(after, at), was), label).toBeLessThanOrEqual(1e-6);
      expect(bodyDiff(poseAt(outgoing(before, after), at), was), label).toBeLessThanOrEqual(1e-6);
      expect(bodyDiff(poseAt(incoming(after), at), was), `${label}: the pop`).toBeGreaterThan(1e-3);
    }
  });

  it("from +100 ms it equals the incoming clip's pose (±1e-6); the first tick from there clears prevClip", () => {
    for (const { label, before, input, at } of cuts()) {
      const after = stepAll(before, input).s;
      for (const dt of [0.1, 0.125, 0.3, 1]) {
        expect(
          bodyDiff(poseAt(after, at + dt), poseAt(incoming(after), at + dt)),
          `${label} +${dt}`,
        ).toBeLessThanOrEqual(1e-6);
      }
      expect(directorReduce(after, tick(at + 0.05), CAST), label).toBe(after);
      expect(directorReduce(after, tick(at + 0.1 - 1e-9), CAST), label).toBe(after);
      expect(stepAll(after, tick(at + 0.1)).s, label).toStrictEqual(incoming(after));
    }
  });

  it('midway (+50 ms) it is the even blend of the two, strictly between them on at least one channel', () => {
    for (const { label, before, input, at } of cuts()) {
      const after = stepAll(before, input).s;
      const t = at + 0.05;
      const mid = poseAt(after, t);
      const inc = poseAt(incoming(after), t);
      const out = poseAt(outgoing(before, after), t);
      expect(bodyDiff(mid, lerpPose(inc, out, 0.5, createPose())), label).toBeLessThanOrEqual(1e-6);
      let between = 0;
      for (let i = 0; i < CH_COUNT; i++) {
        if (Math.min(inc[i]!, out[i]!) < mid[i]! && mid[i]! < Math.max(inc[i]!, out[i]!)) between++;
      }
      expect(between, label).toBeGreaterThan(0);
    }
  });

  it('no blend after a natural end or a release ease-out', () => {
    // A one-shot at its natural end: a reaction at that instant, or after the tick that ends it, cuts nothing.
    const sneeze = stepAll(stateIn('Idle'), noseTap(11)).s;
    const end = 11 + REACTION_CLIPS.sneeze.duration;
    expect(stepAll(sneeze, gest('cheekPuffR', 'cheekR', 'tap', end)).s.prevClip).toBeNull();
    const ended = stepAll(sneeze, tick(end)).s;
    expect(ended).toMatchObject({ name: 'Idle', clip: null, prevClip: null });
    expect(stepAll(ended, gest('cheekPuffR', 'cheekR', 'tap', end + 0.1)).s.prevClip).toBeNull();
    // A release ease-out: the release cuts nothing, nor does the queued reaction starting at its end.
    const released = stepAll(stateIn('Idle'), petStroke(11), release(12), noseTap(12.3)).s;
    expect(released.prevClip).toBeNull();
    expect(released.queued?.r).toBe(R('sneeze'));
    expect(stepAll(released, tick(12.4)).s).toMatchObject({
      name: 'Reacting',
      clip: { name: 'sneeze', start: 12.4 },
      prevClip: null,
    });
    // A finite clip a refresh restarts once ended (#91 M21) cuts nothing either.
    expect(stepAll(stateIn('Idle'), tickle(11), tickle(11.8125)).s.prevClip).toBeNull();
  });

  it('a released clip cut mid-ease-out eases out on under the fade, from the release instant to past its end', () => {
    const held = stepAll(stateIn('Idle'), petStroke(11)).s;
    const atRelease = stepAll(held, release(12), gest('hug', 'belly', 'hug', 12)).s;
    expect(atRelease.prevClip).toStrictEqual({ name: 'pet', start: 11, cutAt: 12, release: 12 });
    expect(bodyDiff(poseAt(atRelease, 12), poseAt(stepAll(held, release(12)).s, 12))).toBeLessThanOrEqual(
      1e-6,
    );
    // Cut 350 ms into the ease-out: at +70 ms the pet's ease-out is over, so only the hug's (1 − k) share is left.
    const late = stepAll(held, release(12), gest('hug', 'belly', 'hug', 12.35)).s;
    const t = 12.42;
    const k = easeOut((t - 12.35) / 0.1);
    const hug = sampleClip(REACTION_CLIPS.hug, t - 12.35, createPose());
    expect(bodyDiff(poseAt(late, t), addPose(BASE.idle, hug, 1 - k, createPose()))).toBeLessThanOrEqual(1e-6);
  });

  it('a clip dropped with no successor is no cut, and it clears a prevClip still fading', () => {
    const dropped = run(stateIn('Idle'), anim({ e: 'sleep' }, 10.5), anim({ e: 'idle' }, 10.8));
    expect(dropped).toMatchObject({ name: 'Idle', clip: null, prevClip: null });
    // sleep cuts the wake clip, then idle drops the sleep clip inside that cut's 100 ms: the wake clip must not
    // come back at its weight when the next clip starts (code review finding 1: 0.113 and 0.360 against main's 0).
    for (const [sleepAt, idleAt, tapAt] of [
      [1.5, 1.55, 1.57],
      [1.5, 1.5, 1.52],
    ] as const) {
      const cut = run(initialDirector(0), anim({ e: 'wake' }, 1), anim({ e: 'sleep' }, sleepAt));
      expect(cut.prevClip).toMatchObject({ name: 'wake', cutAt: sleepAt });
      const emptied = stepAll(cut, anim({ e: 'idle' }, idleAt)).s;
      expect(emptied).toMatchObject({ name: 'Idle', clip: null, prevClip: null });
      const tapped = stepAll(emptied, gest('cheekPuffL', 'cheekL', 'tap', tapAt)).s;
      expect(tapped.clip).toStrictEqual({ name: 'cheekPuffL', start: tapAt });
      expect(tapped.prevClip).toBeNull();
      expect(bodyDiff(poseAt(tapped, tapAt), poseAt(emptied, tapAt))).toBeLessThanOrEqual(1e-6);
    }
  });

  it('a second cut 30 ms into a fade keeps the older prevClip; one 80 ms into it replaces it', () => {
    const before = stepAll(stateIn('Idle'), noseTap(11), gest('cheekPuffL', 'cheekL', 'tap', 11.5)).s;
    expect(before.prevClip).toStrictEqual({ name: 'sneeze', start: 11, cutAt: 11.5, release: null });
    const early = stepAll(before, gest('cheekPuffR', 'cheekR', 'tap', 11.53)).s;
    expect(early.clip).toStrictEqual({ name: 'cheekPuffR', start: 11.53 });
    expect(early.prevClip).toBe(before.prevClip);
    // At +50 ms both choices move the pose by exactly the same amount (0.2777…): a tie keeps the older one.
    expect(stepAll(before, gest('cheekPuffR', 'cheekR', 'tap', 11.55)).s.prevClip).toBe(before.prevClip);
    const late = stepAll(before, gest('cheekPuffR', 'cheekR', 'tap', 11.58)).s;
    expect(late.clip).toStrictEqual({ name: 'cheekPuffR', start: 11.58 });
    expect(late.prevClip).toStrictEqual({ name: 'cheekPuffL', start: 11.5, cutAt: 11.58, release: null });
  });

  it('a second cut keeps whichever outgoing clip moves the pose less, never more than a plain cut would', () => {
    // A late second cut can keep the older clip too: at +80 ms the sneeze still outweighs the barely started
    // long-press by far, so dropping the sneeze would jump about 4× as far as a plain cut.
    const before = stepAll(stateIn('Idle'), noseTap(11), gest('earDroopL', 'earL', 'longPress', 11.2)).s;
    expect(stepAll(before, gest('hug', 'belly', 'hug', 11.28)).s.prevClip).toBe(before.prevClip);
    // The pop probe's rows (#240 plan review, finding 1): the jump at the second cut is never above main's.
    const cheeks = stepAll(stateIn('Idle'), noseTap(11), gest('cheekPuffL', 'cheekL', 'tap', 11.5)).s;
    const rows: [DirectorState, DirInput & { now: number }][] = [
      ...[0.01, 0.03, 0.05, 0.08, 0.095].map((dt): [DirectorState, DirInput & { now: number }] => [
        cheeks,
        { k: 'gesture', r: R('cheekPuffR'), region: 'cheekR', gesture: 'tap', now: 11.5 + dt },
      ]),
      ...[11.21, 11.23, 11.25, 11.26, 11.28, 11.295].map((t): [DirectorState, DirInput & { now: number }] => [
        before,
        { k: 'gesture', r: R('hug'), region: 'belly', gesture: 'hug', now: t },
      ]),
    ];
    for (const [s, i] of rows) {
      const r = stepAll(s, i).s;
      const jump = bodyDiff(poseAt(r, i.now), poseAt(s, i.now));
      const plain = bodyDiff(poseAt(incoming(r), i.now), poseAt(incoming(s), i.now));
      expect(jump, `${s.clip?.name} → ${r.clip?.name} at ${i.now}`).toBeLessThanOrEqual(plain + 1e-6);
    }
  });

  it("a cut carries a reaction's release only when the cut clip is that reaction's own clip", () => {
    // Talking with a held tickle whose giggle has ended: a P2 flinch takes the free slot, the tickle is released,
    // and the announced long-press starts over the flinch at talkEnd. The flinch is cut, the tickle's release isn't.
    const s = stepAll(
      stateIn('Thinking'),
      tickle(10.1),
      anim({ e: 'talk', id: 3 }, 10.2),
      gest('cheekPuffR', 'cheekR', 'tap', 11),
      release(11.02),
      gest('earDroopL', 'earL', 'longPress', 11.05),
    ).s;
    expect(s).toMatchObject({ name: 'Talking', clip: { name: 'flinch', start: 11 }, prevClip: null });
    expect(s.reaction).toMatchObject({ clip: 'giggle', release: 11.02 });
    expect(s.queued).toMatchObject({ r: R('earDroopL'), announced: true });
    const r = stepAll(s, anim({ e: 'talkEnd' }, 11.1)).s;
    expect(r.clip).toStrictEqual({ name: 'earDroopL', start: 11.1 });
    expect(r.prevClip).toStrictEqual({ name: 'flinch', start: 11, cutAt: 11.1, release: null });
  });

  it('other inputs keep prevClip; evaluate ignores it once 100 ms are up, with no clip in the slot, or unknown', () => {
    const [first] = cuts();
    const after = stepAll(first!.before, first!.input).s; // dizzy cut at 13.5
    expect(stepAll(after, gentle(true)).s.prevClip).toBe(after.prevClip);
    expect(directorReduce(after, anim(SAMPLES.reaction, 13.55), CAST)).toBe(after);
    // Stale (no tick since its 100 ms ended): nothing is blended.
    expect(bodyDiff(poseAt(after, 13.7), poseAt(incoming(after), 13.7))).toBe(0);
    // No clip in the slot (bear-view's reduced motion evaluates the state without its clip): nothing is blended.
    const noClip: DirectorState = { ...after, clip: null };
    expect(bodyDiff(poseAt(noClip, 13.55), poseAt(incoming(noClip), 13.55))).toBe(0);
    // A cut clip the director doesn't know: nothing is blended.
    const mystery: DirectorState = { ...after, prevClip: { ...after.prevClip!, name: 'mystery' } };
    expect(bodyDiff(poseAt(mystery, 13.55), poseAt(incoming(after), 13.55))).toBe(0);
  });

  it('evaluate through a cut crossfade makes no array allocation', () => {
    const s = stepAll(stateIn('Idle'), petStroke(11), release(12), gest('hug', 'belly', 'hug', 12.2)).s;
    const out = createPose();
    expect(
      countAllocations(() => {
        for (let i = 0; i < 1000; i++) evaluate(s, 12.2 + i * 0.0002, out, false, CAST);
      }),
    ).toBe(0);
  });
});

// ==== #221: the clip lookup and the mouth channels through evaluate ===============================================
/** The four mouth channels of `p`, in `MOUTH` order. */
const mouthOf = (p: Pose): number[] => MOUTH.map((m) => p[m]!);
/** `evaluate(s, now)` with the mouth channels (bear-view's call), into a fresh pose. */
const withMouth = (s: DirectorState, now: number): Pose => evaluate(s, now, createPose(), true, CAST);
/** The largest |a − b| over every channel, the mouth's included. */
function fullDiff(a: Pose, b: Pose): number {
  let m = 0;
  for (let i = 0; i < CH_COUNT; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}
/** A pinch of both cheeks (squish, P3, held) and an all-over touch (giggle, P3), at `now`. */
const pinch = (now: number): DirInput => gest('squish', 'cheekL', 'pinch', now);
const allOver = (now: number): DirInput => gest('giggle', 'belly', 'allOver', now);

describe('#221: clipByName and the mouth channels through evaluate', () => {
  it('clipByName returns the clips the director plays: session, reaction, the flinch and the mirrored pet', () => {
    for (const [name, c] of Object.entries(SESSION_CLIPS)) expect(clipByName(name, CAST), name).toBe(c);
    for (const [name, c] of Object.entries(REACTION_CLIPS)) expect(clipByName(name, CAST), name).toBe(c);
    expect(clipByName('flinch', CAST)?.tracks.map((tr) => tr.ch)).toStrictEqual([Ch.BodySquash]);
    const pet = REACTION_CLIPS.pet;
    const mirrored = clipByName('petMirrored', CAST);
    expect(mirrored?.duration).toBe(pet.duration);
    expect(mirrored?.tracks).toStrictEqual(
      pet.tracks.map((tr) =>
        tr.ch === Ch.HeadRot ? { ch: tr.ch, keys: tr.keys.map((key) => ({ ...key, v: -key.v })) } : tr,
      ),
    );
    expect(clipByName('mystery', CAST)).toBeUndefined();
  });

  it("createDirectorCast: Juni's cast is the session, reaction and mime clips, the flinch and the mirrored pet", () => {
    expect([...CAST.clips.keys()]).toStrictEqual([
      ...Object.keys(SESSION_CLIPS),
      ...Object.keys(REACTION_CLIPS),
      ...Object.keys(MIME_CLIPS),
      'flinch',
      'petMirrored',
    ]);
    expect([...CAST.mirrored]).toStrictEqual([['pet', 'petMirrored']]);
    expect(CAST.reactions).toBe(REACTIONS);
    // A later set overrides an earlier name; without a pet there is no mirrored clip.
    const other = { ...SESSION_CLIPS.wake, name: 'wake' };
    const cast = createDirectorCast([SESSION_CLIPS, { wake: other }], {});
    expect(clipByName('wake', cast)).toBe(other);
    expect(clipByName('flinch', cast)).toBe(clipByName('flinch', CAST));
    expect(cast.mirrored.size).toBe(0);
    expect(clipByName('petMirrored', cast)).toBeUndefined();
  });

  it('every clip it knows has its impulses in time order (bear-view applies them with a cursor)', () => {
    const names = [
      ...Object.keys(SESSION_CLIPS),
      ...Object.keys(REACTION_CLIPS),
      ...Object.keys(MIME_CLIPS),
      'flinch',
      'petMirrored',
    ];
    let kicked = 0;
    for (const name of names) {
      const c = clipByName(name, CAST);
      expect(c, name).toBeDefined();
      const imps = c?.impulses ?? [];
      if (imps.length > 0) kicked++;
      for (let i = 1; i < imps.length; i++)
        expect(imps[i]!.t, `${name} kick ${i}`).toBeGreaterThanOrEqual(imps[i - 1]!.t);
    }
    expect(kicked, 'the clips with spring kicks').toBe(11);
  });

  it("with `mouth`, evaluate writes a clip's mouth tracks (giggle's jaw); every other channel is as without it", () => {
    const s = stepAll(stateIn('Idle'), tickle(11)).s;
    expect(s.clip).toStrictEqual({ name: 'giggle', start: 11 });
    const sample = sampleClip(REACTION_CLIPS.giggle, 0.3, createPose());
    expect(sample[Ch.Jaw]).toBeGreaterThan(0.3);
    const out = createPose().fill(Number.NaN);
    evaluate(s, 11.3, out, true, CAST);
    expect(Math.abs(out[Ch.Jaw]! - sample[Ch.Jaw]!)).toBeLessThanOrEqual(1e-6);
    for (const m of [Ch.MouthW, Ch.MouthRound, Ch.Teeth]) expect(out[m], `channel ${m}`).toBe(0);
    // Without the flag the mouth channels are never written, and every other channel is the same.
    const plain = createPose().fill(Number.NaN);
    for (const [j, m] of MOUTH.entries()) plain[m] = 100 + j;
    evaluate(s, 11.3, plain, false, CAST);
    for (const [j, m] of MOUTH.entries()) expect(plain[m]).toBe(100 + j);
    for (let i = 0; i < CH_COUNT; i++) if (!MOUTH.includes(i)) expect(out[i], `channel ${i}`).toBe(plain[i]);
    // No clip: no base pose has a mouth, so the mouth channels are 0.
    expect(mouthOf(withMouth(stateIn('Idle'), 11.3))).toStrictEqual([0, 0, 0, 0]);
  });

  it("a released squish's pucker eases out over 400 ms like its other tracks", () => {
    const held = stepAll(stateIn('Idle'), pinch(11)).s;
    expect(held.clip).toStrictEqual({ name: 'squish', start: 11 });
    expect(withMouth(held, 11.2)[Ch.MouthRound]).toBe(1);
    const released = stepAll(held, release(11.5)).s;
    expect(withMouth(released, 11.5)[Ch.MouthRound]).toBe(1);
    expect(Math.abs(withMouth(released, 11.7)[Ch.MouthRound]! - easeOut(0.5))).toBeLessThanOrEqual(1e-6);
    expect(withMouth(released, 11.9)[Ch.MouthRound]).toBe(0);
  });

  it('a mouth-bearing clip cut by another crossfades its mouth over 100 ms (#240), both ways', () => {
    const cases = [
      {
        label: 'giggle cuts a held squish',
        before: stepAll(stateIn('Idle'), pinch(11)).s,
        input: allOver(11.5),
        at: 11.5,
      },
      {
        label: 'squish cuts a giggle',
        before: stepAll(stateIn('Idle'), tickle(11)).s,
        input: pinch(11.3),
        at: 11.3,
      },
    ];
    for (const { label, before, input, at } of cases) {
      const after = stepAll(before, input).s;
      expect(after.prevClip, label).toMatchObject({ name: before.clip?.name, cutAt: at });
      // At the cut: exactly the outgoing pose, the mouth included.
      expect(fullDiff(withMouth(after, at), withMouth(before, at)), label).toBeLessThanOrEqual(1e-6);
      // Midway: the even blend of the incoming and the outgoing clip, on the mouth channels too.
      const t = at + 0.05;
      const mid = mouthOf(withMouth(after, t));
      const inc = mouthOf(withMouth(incoming(after), t));
      const out = mouthOf(withMouth(outgoing(before, after), t));
      for (let j = 0; j < MOUTH.length; j++)
        expect(Math.abs(mid[j]! - (inc[j]! + out[j]!) / 2), `${label}: mouth ${j}`).toBeLessThanOrEqual(1e-6);
      expect(
        mid.some((v, j) => Math.abs(v - inc[j]!) > 1e-3),
        `${label}: the outgoing mouth still shows`,
      ).toBe(true);
      // From +100 ms: the incoming clip alone.
      for (const dt of [0.1, 0.15, 0.3]) {
        expect(
          fullDiff(withMouth(after, at + dt), withMouth(incoming(after), at + dt)),
          `${label} +${dt}`,
        ).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it('evaluate with the mouth makes no array allocation, through a cut crossfade too', () => {
    const s = stepAll(stateIn('Idle'), pinch(11), allOver(11.5)).s;
    expect(s.prevClip?.name).toBe('squish');
    const out = createPose();
    expect(
      countAllocations(() => {
        for (let i = 0; i < 1000; i++) evaluate(s, 11.5 + i * 0.0002, out, true, CAST);
      }),
    ).toBe(0);
  });
});

// ---- #229: evaluate's time through a slot ------------------------------------------------------------------------

/** director.ts's private constants, copied with the reference below. */
const CROSSFADE_S_REF = 0.15;
const RELEASE_S_REF = 0.4;
const CUT_S_REF = 0.1;
const CLIP_DELTA_REF: Pose = createPose();
const PREV_DELTA_REF: Pose = createPose();

/** main's `evaluate` (0b2a413) verbatim, before #229, with `CLIPS.get` spelled `clipByName` and `playing` renamed. */
function referenceEvaluate(s: DirectorState, now: number, out: Pose, mouth = false): Pose {
  const a = BASE[s.prevBase];
  const b = BASE[s.base];
  const f = (now - s.fadeStart) / CROSSFADE_S_REF;
  const t = f < 1 ? (f > 0 ? f : 0) : 1;
  let withClip = false;
  let w = 1;
  let k = 0;
  let wp = 1;
  const current = s.clip;
  if (current !== null) {
    const c = clipByName(current.name, CAST);
    if (c !== undefined) {
      sampleClip(c, now - current.start, CLIP_DELTA_REF);
      withClip = true;
      const r = s.reaction;
      if (r !== null && r.release !== null && current.name === r.clip) {
        const u = (now - r.release) / RELEASE_S_REF;
        w = u > 0 ? (u < 1 ? 1 - u * u * (3 - 2 * u) : 0) : 1;
      }
      const p = s.prevClip;
      if (p !== null) {
        const u = (now - p.cutAt) / CUT_S_REF;
        const pc = u < 1 ? clipByName(p.name, CAST) : undefined;
        if (pc !== undefined) {
          sampleClip(pc, now - p.start, PREV_DELTA_REF);
          k = u > 0 ? 1 - u * u * (3 - 2 * u) : 1;
          if (p.release !== null) {
            const v = (now - p.release) / RELEASE_S_REF;
            wp = v > 0 ? (v < 1 ? 1 - v * v * (3 - 2 * v) : 0) : 1;
          }
        }
      }
    }
  }
  for (let i = 0; i < CH_COUNT; i++) {
    if (!mouth && (i === Ch.Jaw || i === Ch.MouthW || i === Ch.MouthRound || i === Ch.Teeth)) continue;
    const ai = a[i]!;
    const v = ai + (b[i]! - ai) * t;
    if (!withClip) out[i] = v;
    else if (k > 0) out[i] = v + CLIP_DELTA_REF[i]! * w * (1 - k) + PREV_DELTA_REF[i]! * wp * k;
    else out[i] = v + CLIP_DELTA_REF[i]! * w;
  }
  return out;
}

/** Whether a property key is an array index. */
function isIndex(key: string | symbol): key is string {
  return typeof key === 'string' && /^\d+$/.test(key);
}

/**
 * A pose whose channel writes and reads go to a `Float64Array` (`values`), so evaluations that differ below float32
 * precision differ here too. `evaluate` only writes `out[i]`, which the proxy's `set` sends to `values`.
 */
function f64Pose(): { pose: Pose; values: Float64Array } {
  const values = new Float64Array(CH_COUNT);
  const pose = new Proxy(createPose(), {
    get(target, key): unknown {
      if (isIndex(key)) return values[Number(key)];
      const v: unknown = Reflect.get(target, key);
      return v;
    },
    set(_target, key, v: unknown): boolean {
      if (!isIndex(key) || typeof v !== 'number') return false;
      values[Number(key)] = v;
      return true;
    },
  });
  return { pose, values };
}

describe("evaluateFrom and evaluate against main's evaluate (#229)", () => {
  it('evaluateFrom reads its time from clock[at], and both match the reference bit for bit at double precision', () => {
    const states: DirectorState[] = [];
    for (const name of STATES) states.push(...variants(name));
    for (const c of CLIP_NAMES) states.push(playing(c));
    // Reactions held, released and easing out, one-shots, and cut fades with a prevClip, at 120 Hz.
    const driven = drive(
      stateIn('Idle', 9),
      [petStroke(10), petStroke(10.3), release(10.6), noseTap(11), flick(11.05), tickle(11.4), release(11.6)],
      12.5,
    );
    for (const { s } of driven.states) states.push(s);
    expect(states.some((s) => s.prevClip !== null)).toBe(true);
    expect(states.some((s) => s.reaction !== null && s.reaction.release !== null)).toBe(true);
    // Float64Array outputs, so a difference below float32 precision shows too.
    const clock = new Float64Array(3);
    const ref = f64Pose();
    const viaFrom = f64Pose();
    const viaEvaluate = f64Pose();
    let compared = 0;
    for (const s of states) {
      const t0 = s.clip?.start ?? s.fadeStart;
      for (const now of [s.fadeStart, t0 + 0.05, t0 + 0.0731, t0 + 0.15, t0 + 1, Number.NaN]) {
        for (const mouth of [false, true]) {
          ref.values.fill(7);
          viaFrom.values.fill(7);
          viaEvaluate.values.fill(7);
          clock.fill(-1e9);
          clock[2] = now;
          referenceEvaluate(s, now, ref.pose, mouth);
          expect(evaluateFrom(s, clock, 2, viaFrom.pose, mouth, CAST)).toBe(viaFrom.pose);
          expect(evaluate(s, now, viaEvaluate.pose, mouth, CAST)).toBe(viaEvaluate.pose);
          const r = ref.values;
          const a = viaFrom.values;
          const b = viaEvaluate.values;
          for (let ch = 0; ch < CH_COUNT; ch++) {
            if (!Object.is(a[ch], r[ch]) || !Object.is(b[ch], r[ch]))
              expect.fail(`channel ${ch} at ${now} (mouth ${mouth}): ${a[ch]}, ${b[ch]} vs ${r[ch]}`);
          }
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });
});
