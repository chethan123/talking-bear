/**
 * The animation director (plan §3.5): a pure state machine driven only by the session's `AnimEvent`s and
 * time, plus the evaluation helpers the frame loop (#81) calls every frame. M4 covers the session-driven
 * states; the reaction rules (priorities, queue, cooldown, escalation, `Reacting`, `Sustained`) come in M5
 * (#91).
 *
 * Times are seconds on the director clock. `directorReduce` is pure: it never mutates its input, reads no
 * clock and returns the same object when nothing changes.
 *
 * **Transitions.** Every (state, event) pair is listed in `TABLE` (plan §3.3 design rule 5):
 * - `wake`, `sleep` and `idle` move to Waking, Asleep and Idle from every other state: the session emits
 *   them wherever it left the director (after Paused, Error or NeedsParent).
 * - `attentive` leaves Idle and Dozing only (#79). `thinking` leaves Attentive, `talk` leaves Thinking,
 *   `talkEnd` leaves Talking and `doze` leaves Idle, as in the §3.5 diagram: the session only emits them in
 *   that order.
 * - An event that targets the current state, and `reaction` (M5), change nothing.
 *
 * **Clips.** One slot. `wake` and `sleep` start their clip on every transition into Waking and Asleep,
 * replacing any clip. `confused`, `earTwitch` and `shrug` play additively, leaving the state and base alone,
 * and only when no clip is playing: cutting a clip mid-way would pop, while every session clip starts and
 * ends at 0 (#77). In Waking they are ignored: the wake clip owns Waking. A tick at or after a clip's end
 * clears it; in Waking that tick also moves to Idle. An `idle` during Waking moves to Idle at once and the
 * wake clip plays on. Every other transition keeps the playing clip too, except `sleep`, which ends with
 * Asleep.
 *
 * **Mouth.** Leaving Talking sets `mouthCloseStart = now` and clears `talk`; `talk` clears
 * `mouthCloseStart`, so every talk starts with the mouth fully open to the mouth layer.
 */
import type { AnimEvent } from '../app/events.ts';
import { BASE } from './base-poses.ts';
import type { BaseName } from './base-poses.ts';
import { sampleClip } from './clip.ts';
import type { Clip } from './clip.ts';
import { SESSION_CLIPS } from './clips/session.ts';
import { Ch, CH_COUNT, createPose } from './pose.ts';
import type { Pose } from './pose.ts';

export type DirState =
  'Asleep' | 'Waking' | 'Idle' | 'Attentive' | 'Thinking' | 'Talking' | 'Reacting' | 'Sustained' | 'Dozing';

export interface DirectorState {
  name: DirState;
  /** When `name` was entered (s, director clock). */
  since: number;
  base: keyof typeof BASE;
  prevBase: keyof typeof BASE;
  /** Start of the 150 ms crossfade from `prevBase` to `base`. */
  fadeStart: number;
  /** The session clip currently playing (wake/sleep/earTwitch/confused/shrug); `start` on the director clock. */
  clip: { name: string; start: number } | null;
  talk: { id: number; startCtxTime: number | null } | null;
  /** talkEnd → the mouth closes over 200 ms from here (`mouthCloseScale`). */
  mouthCloseStart: number | null;
}

export type DirInput = { k: 'anim'; ev: AnimEvent; now: number } | { k: 'tick'; now: number };

/** Base-state crossfade length (s). */
const CROSSFADE_S = 0.15;
/** Mouth close after talkEnd (s). */
const MOUTH_CLOSE_S = 0.2;

/** The states the session's events lead to. M5 (#91) adds Reacting and Sustained. */
type SessionTarget = Exclude<DirState, 'Reacting' | 'Sustained'>;

/** The base pose of each state the session's events lead to (#79 "Base mapping"). */
const BASE_OF: { readonly [S in SessionTarget]: BaseName } = {
  Asleep: 'asleep',
  Waking: 'idle',
  Idle: 'idle',
  Attentive: 'attentive',
  Thinking: 'thinking',
  Talking: 'talking',
  Dozing: 'dozing',
};

/** The clips the director plays, by name. M5 adds the reaction clips. */
const CLIPS: ReadonlyMap<string, Clip> = new Map<string, Clip>(Object.entries(SESSION_CLIPS));

/** Scratch pose for the clip sample in `evaluate`, allocated once so `evaluate` never allocates. */
const CLIP_DELTA: Pose = createPose();

/** The director at start-up: Asleep, on the `asleep` base, with nothing playing. */
export function initialDirector(now: number): DirectorState {
  return {
    name: 'Asleep',
    since: now,
    base: 'asleep',
    prevBase: 'asleep',
    fadeStart: now,
    clip: null,
    talk: null,
    mouthCloseStart: null,
  };
}

type AnimKind = AnimEvent['e'];
type EventOf<K extends AnimKind> = Extract<AnimEvent, { e: K }>;
type Handler<K extends AnimKind = AnimKind> = (
  s: DirectorState,
  ev: EventOf<K>,
  now: number,
) => DirectorState;
type Row = { readonly [K in AnimKind]: Handler<K> | 'ignore' };

/** End of `clip` on the director clock. A clip the director doesn't know has already ended. */
function clipEnd(clip: { name: string; start: number }): number {
  const c = CLIPS.get(clip.name);
  return c === undefined ? clip.start : clip.start + c.duration;
}

/**
 * The clip a transition keeps: the one playing, except `sleep`, which is shaped against the fade into
 * `asleep` (#77) and so never outlives Asleep.
 */
function keptClip(s: DirectorState): DirectorState['clip'] {
  return s.clip !== null && s.clip.name === 'sleep' ? null : s.clip;
}

/**
 * `s` moved to `to` at `now`, with `clip` (by default the kept one). A base change starts a crossfade from the
 * old base; the same base keeps the running fade. Leaving Talking closes the mouth and clears `talk`.
 */
function enter(s: DirectorState, to: SessionTarget, now: number, clip = keptClip(s)): DirectorState {
  const base = BASE_OF[to];
  const changed = base !== s.base;
  const leavingTalk = s.name === 'Talking';
  return {
    ...s,
    name: to,
    since: now,
    base,
    prevBase: changed ? s.base : s.prevBase,
    fadeStart: changed ? now : s.fadeStart,
    clip,
    talk: null,
    mouthCloseStart: leavingTalk ? now : s.mouthCloseStart,
  };
}

// ---- handlers ------------------------------------------------------------------------------------------
/** A handler that ignores the event's fields. */
type Transition = (s: DirectorState, _ev: unknown, now: number) => DirectorState;

const toWaking: Transition = (s, _ev, now) => enter(s, 'Waking', now, { name: 'wake', start: now });
const toAsleep: Transition = (s, _ev, now) => enter(s, 'Asleep', now, { name: 'sleep', start: now });
const toIdle: Transition = (s, _ev, now) => enter(s, 'Idle', now);
const toAttentive: Transition = (s, _ev, now) => enter(s, 'Attentive', now);
const toThinking: Transition = (s, _ev, now) => enter(s, 'Thinking', now);
const toDozing: Transition = (s, _ev, now) => enter(s, 'Dozing', now);
const toTalking = (s: DirectorState, ev: { id: number }, now: number): DirectorState => ({
  ...enter(s, 'Talking', now),
  talk: { id: ev.id, startCtxTime: null },
  mouthCloseStart: null,
});
/** Additive: plays the clip on top of the unchanged state, unless a clip is still playing. */
const additive = (
  s: DirectorState,
  ev: { e: 'confused' | 'earTwitch' | 'shrug' },
  now: number,
): DirectorState =>
  s.clip !== null && now < clipEnd(s.clip) ? s : { ...s, clip: { name: ev.e, start: now } };

/** Every (state, anim event) pair (plan §3.3 design rule 5). `'ignore'` returns the same state object. */
const TABLE: { readonly [S in DirState]: Row } = {
  Asleep: {
    wake: toWaking,
    sleep: 'ignore',
    doze: 'ignore',
    idle: toIdle,
    attentive: 'ignore',
    thinking: 'ignore',
    talk: 'ignore',
    talkEnd: 'ignore',
    confused: additive,
    earTwitch: additive,
    shrug: additive,
    reaction: 'ignore',
  },
  Waking: {
    wake: 'ignore',
    sleep: toAsleep,
    doze: 'ignore',
    idle: toIdle,
    attentive: 'ignore',
    thinking: 'ignore',
    talk: 'ignore',
    talkEnd: 'ignore',
    confused: 'ignore',
    earTwitch: 'ignore',
    shrug: 'ignore',
    reaction: 'ignore',
  },
  Idle: {
    wake: toWaking,
    sleep: toAsleep,
    doze: toDozing,
    idle: 'ignore',
    attentive: toAttentive,
    thinking: 'ignore',
    talk: 'ignore',
    talkEnd: 'ignore',
    confused: additive,
    earTwitch: additive,
    shrug: additive,
    reaction: 'ignore',
  },
  Attentive: {
    wake: toWaking,
    sleep: toAsleep,
    doze: 'ignore',
    idle: toIdle, // misfire
    attentive: 'ignore',
    thinking: toThinking,
    talk: 'ignore',
    talkEnd: 'ignore',
    confused: additive,
    earTwitch: additive,
    shrug: additive,
    reaction: 'ignore',
  },
  Thinking: {
    wake: toWaking,
    sleep: toAsleep,
    doze: 'ignore',
    idle: toIdle,
    attentive: 'ignore',
    thinking: 'ignore',
    talk: toTalking,
    talkEnd: 'ignore',
    confused: additive,
    earTwitch: additive,
    shrug: additive,
    reaction: 'ignore',
  },
  Talking: {
    wake: toWaking,
    sleep: toAsleep,
    doze: 'ignore',
    idle: toIdle,
    attentive: 'ignore',
    thinking: 'ignore',
    talk: 'ignore',
    talkEnd: toIdle, // enter() sets mouthCloseStart = now on leaving Talking
    confused: additive,
    earTwitch: additive,
    shrug: additive,
    reaction: 'ignore',
  },
  Reacting: {
    wake: toWaking,
    sleep: toAsleep,
    doze: 'ignore',
    idle: toIdle,
    attentive: 'ignore',
    thinking: 'ignore',
    talk: 'ignore',
    talkEnd: 'ignore',
    confused: additive,
    earTwitch: additive,
    shrug: additive,
    reaction: 'ignore',
  },
  Sustained: {
    wake: toWaking,
    sleep: toAsleep,
    doze: 'ignore',
    idle: toIdle,
    attentive: 'ignore',
    thinking: 'ignore',
    talk: 'ignore',
    talkEnd: 'ignore',
    confused: additive,
    earTwitch: additive,
    shrug: additive,
    reaction: 'ignore',
  },
  Dozing: {
    wake: toWaking,
    sleep: toAsleep,
    doze: 'ignore',
    idle: toIdle,
    attentive: toAttentive,
    thinking: 'ignore',
    talk: 'ignore',
    talkEnd: 'ignore',
    confused: additive,
    earTwitch: additive,
    shrug: additive,
    reaction: 'ignore',
  },
};

/** The event kinds `TABLE` lists; any other `e` at runtime is unknown and ignored. */
const KINDS: ReadonlySet<string> = new Set(Object.keys(TABLE.Idle));

function handlerFor<K extends AnimKind>(name: DirState, e: K): Handler<K> | 'ignore' {
  return TABLE[name][e];
}

/** A tick: a clip at or past its end is cleared; in Waking, that (or having no clip) moves to Idle. */
function tick(s: DirectorState, now: number): DirectorState {
  if (s.clip !== null && now < clipEnd(s.clip)) return s;
  if (s.name === 'Waking') return enter(s, 'Idle', now, null);
  return s.clip === null ? s : { ...s, clip: null };
}

/** The director reducer. Pure: it never mutates `s`, and returns `s` itself when nothing changes. */
export function directorReduce(s: DirectorState, i: DirInput): DirectorState {
  if (i.k === 'tick') return tick(s, i.now);
  if (!KINDS.has(i.ev.e)) return s;
  const handler = handlerFor(s.name, i.ev.e);
  return handler === 'ignore' ? s : handler(s, i.ev, i.now);
}

/**
 * Writes the director's pose at `now` into `out` and returns `out`: the crossfade
 * `prevBase + (base − prevBase)·t`, `t = clamp((now − fadeStart)/0.15, 0, 1)`, plus the active clip's sample.
 * The mouth channels (`Jaw`, `MouthW`, `MouthRound`, `Teeth`) are never written: the mouth layer owns them.
 * Never allocates.
 */
export function evaluate(s: DirectorState, now: number, out: Pose): Pose {
  const a = BASE[s.prevBase];
  const b = BASE[s.base];
  const f = (now - s.fadeStart) / CROSSFADE_S;
  const t = f < 1 ? (f > 0 ? f : 0) : 1;
  let withClip = false;
  const playing = s.clip;
  if (playing !== null) {
    const c = CLIPS.get(playing.name);
    if (c !== undefined) {
      sampleClip(c, now - playing.start, CLIP_DELTA);
      withClip = true;
    }
  }
  for (let i = 0; i < CH_COUNT; i++) {
    if (i === Ch.Jaw || i === Ch.MouthW || i === Ch.MouthRound || i === Ch.Teeth) continue;
    const ai = a[i]!;
    const v = ai + (b[i]! - ai) * t;
    out[i] = withClip ? v + CLIP_DELTA[i]! : v;
  }
  return out;
}

/**
 * The mouth layer's output scale after talkEnd: 1 while `mouthCloseStart` is null, otherwise
 * `clamp(1 − (now − mouthCloseStart)/0.2, 0, 1)` (NaN gives 0). #81 multiplies the mouth channels by it.
 */
export function mouthCloseScale(now: number, mouthCloseStart: number | null): number {
  if (mouthCloseStart === null) return 1;
  const v = 1 - (now - mouthCloseStart) / MOUTH_CLOSE_S;
  return v > 0 ? (v < 1 ? v : 1) : 0;
}
