/**
 * The animation director (plan §3.5): a pure state machine driven by the session's `AnimEvent`s, the
 * recognised gestures (as reactions, #90), their release, and time, plus the evaluation helpers the frame
 * loop (#81) calls every frame.
 *
 * Times are seconds on the director clock. `directorStep` and `directorReduce` are pure: they never mutate
 * their input, read no clock and return the same state object when nothing changes.
 *
 * **Session transitions.** Every (state, event) pair is listed in `TABLE` (plan §3.3 design rule 5):
 * - `wake`, `sleep` and `idle` move to Waking, Asleep and Idle from every other state: the session emits
 *   them wherever it left the director (after Paused, Error or NeedsParent). In Reacting and Sustained,
 *   `idle` changes nothing: those states are Idle's, and they end by themselves (#91).
 * - `attentive` leaves Idle, Dozing, Reacting and Sustained (#79, #91). `thinking` leaves Attentive, `talk`
 *   leaves Thinking, `talkEnd` leaves Talking and `doze` leaves Idle, as in the §3.5 diagram: the session only
 *   emits them in that order.
 * - An event that targets the current state, and `reaction`, change nothing: the director handled the
 *   reaction at gesture time (#91).
 *
 * **Clips.** One slot. `wake` and `sleep` start their clip on every transition into Waking and Asleep,
 * replacing any clip. `confused`, `earTwitch` and `shrug` play additively, leaving the state and base alone,
 * and only when no clip is playing and no reaction is active: cutting a clip mid-way would pop, while every
 * session clip starts and ends at 0 (#77). In Waking they are ignored: the wake clip owns Waking. A tick at
 * or after a clip's end clears it; in Waking that tick also moves to Idle. An `idle` during Waking moves to
 * Idle at once and the wake clip plays on. Every other transition keeps the playing clip too, except
 * `sleep`, which ends with Asleep.
 *
 * **Mouth.** Leaving Talking sets `mouthCloseStart = now` and clears `talk`; `talk` clears
 * `mouthCloseStart`, so every talk starts with the mouth fully open to the mouth layer.
 *
 * **Reactions** (plan §3.5, issue #91). A `gesture` input carries the reaction `reactionFor` (#90) found:
 * - **Gates:** ignored in Asleep and Waking; in Dozing it moves to Idle first.
 * - **Refresh:** the same reaction name as the held Sustained reaction refreshes it, bypassing the cooldown:
 *   its clip keeps playing (a finite clip that has ended restarts), its escalation run goes on, and its sfx
 *   is output again only every `sfxLoopMs` (never, without it). Haptic and mood are output once per run.
 * - **Cooldown:** 800 ms per (region, gesture kind) from the reaction that started it; inputs in it are
 *   ignored unless their priority is higher than that reaction's.
 * - **Escalation:** repeat-based (the `count`-th acceptance within `withinMs`; defaults 3 and 4 s) or
 *   duration-based (a held run, gaps ≤ `maxGapMs`, longer than `continuousMs`): `escalation.to` plays instead.
 * - **Interruption:** a reaction interrupts the active one only if its priority is ≥ the active one's;
 *   otherwise it is queued (one slot, replaced by a newer one) and dropped if it hasn't started 500 ms later.
 *   A one-shot ends at its clip end, a sustained reaction 400 ms after its release; a fresh queued reaction
 *   then starts.
 * - **Where it plays:** from Idle (Reacting/Sustained) a reaction is the base; in Attentive and Thinking it
 *   plays additively and the state stays. In Talking a P1/P2 plays a 150 ms flinch (sfx `null`); a P3+ is
 *   output with its sfx (the session stops playback) and starts when the session's `talkEnd` arrives. A
 *   sustained reaction held when Talking starts plays on additively, and its refreshes (no sfx loop, no
 *   escalation) and its release (no `sfxOnRelease`) output nothing there, so a continuing stroke doesn't stop
 *   the replay; `talkEnd` makes it Sustained again.
 * - **Release:** outputs `sfxOnRelease`, then the held reaction's clip eases out over 400 ms.
 * - **Gentle:** gentle clips play, and an escalation target without a gentle clip is skipped.
 * Accepted reactions output `toSession` (for `session.dispatch`), `haptic` and `mood`.
 */
import type { AnimEvent, Priority, SessionEvent, SfxId } from '../app/events.ts';
import type { Gesture } from '../input/recognizer.ts';
import type { RegionId } from '../input/region-ids.ts';
import { REACTIONS } from '../reactions/table.ts';
import type { Escalation, Reaction } from '../reactions/table.ts';
import { BASE } from './base-poses.ts';
import type { BaseName } from './base-poses.ts';
import { sampleClip } from './clip.ts';
import type { Clip } from './clip.ts';
import { REACTION_CLIPS } from './clips/reactions.ts';
import { SESSION_CLIPS } from './clips/session.ts';
import { Ch, CH_COUNT, createPose } from './pose.ts';
import type { Pose } from './pose.ts';

export type DirState =
  'Asleep' | 'Waking' | 'Idle' | 'Attentive' | 'Thinking' | 'Talking' | 'Reacting' | 'Sustained' | 'Dozing';

/** A recognised gesture's kind (`Gesture['g']`): with the region, the cooldown key. */
export type GestureKind = Gesture['g'];

/** The reaction the director plays: the base of Reacting/Sustained, or additive in Attentive/Thinking/Talking. */
export interface ActiveReaction {
  /** The reaction playing: the escalation target when one escalated. */
  r: Reaction;
  /** The clip it plays: `r.clip`, its gentle clip, or the mirrored pet. */
  clip: string;
  /** When it started (s). */
  start: number;
  /** Its latest input (s): the start or the latest refresh. */
  last: number;
  /** Start of its duration-escalation run (s): a gap longer than `maxGapMs` restarts the run. */
  runStart: number;
  /** When its sfx was last output (s). */
  sfxAt: number;
  /** When it was released (s); null while held, and always for a one-shot. */
  release: number | null;
}

/** The queued reaction (queue length 1). */
export interface QueuedReaction {
  r: Reaction;
  region: RegionId;
  gesture: GestureKind;
  dirX: -1 | 1 | null;
  /** When it was queued (s); it is dropped if it hasn't started by `at` + 500 ms. */
  at: number;
  /** Already output to the session (a P3+ while Talking): it starts at `talkEnd` without outputs. */
  announced: boolean;
}

/** The cooldown of one (region, gesture kind): the reaction that started it, at `at`. */
export interface Cooldown {
  region: RegionId;
  gesture: GestureKind;
  at: number;
  priority: Priority;
}

/** One acceptance of a reaction with a repeat-based escalation, counted for `within` s from `at`. */
export interface Repeat {
  name: string;
  at: number;
  within: number;
}

export interface DirectorState {
  name: DirState;
  /** When `name` was entered (s, director clock). */
  since: number;
  base: keyof typeof BASE;
  prevBase: keyof typeof BASE;
  /** Start of the 150 ms crossfade from `prevBase` to `base`. */
  fadeStart: number;
  /** The clip currently playing (a session clip, a reaction clip or the flinch); `start` on the director clock. */
  clip: { name: string; start: number } | null;
  talk: { id: number; startCtxTime: number | null } | null;
  /** talkEnd → the mouth closes over 200 ms from here (`mouthCloseScale`). */
  mouthCloseStart: number | null;
  /** The active reaction, or null. */
  reaction: ActiveReaction | null;
  /** The queued reaction, or null. */
  queued: QueuedReaction | null;
  /** The cooldowns started in the last 800 ms (older ones are pruned when a new one starts). */
  cooldowns: readonly Cooldown[];
  /** Recent acceptances of reactions with a repeat-based escalation. */
  repeats: readonly Repeat[];
  /** Gentle mode or reduced motion: gentle clips, and no escalation target without one. */
  gentle: boolean;
}

/** A recognised gesture's reaction, as the app hands it to the director. */
export interface GestureInput {
  k: 'gesture';
  r: Reaction;
  region: RegionId;
  gesture: GestureKind;
  phase?: string;
  /** A stroke's horizontal sign (`Math.cos(dir)` ≥ 0 → 1): −1 plays the mirrored pet. */
  dirX?: -1 | 1;
  now: number;
}

export type DirInput =
  | { k: 'anim'; ev: AnimEvent; now: number }
  | { k: 'tick'; now: number }
  | GestureInput
  | { k: 'release'; now: number }
  | { k: 'setGentle'; on: boolean };

/** What a step outputs: a reaction for `session.dispatch`, a haptic pattern, a mood bump. */
export type DirOut =
  | { k: 'toSession'; ev: Extract<SessionEvent, { t: 'reaction' }> }
  | { k: 'haptic'; pattern: number[] }
  | { k: 'mood'; joy?: number; annoy?: number };

/** A step's new state and outputs. */
export interface DirStep {
  state: DirectorState;
  out: readonly DirOut[];
}

/** Base-state crossfade length (s). */
const CROSSFADE_S = 0.15;
/** Mouth close after talkEnd (s). */
const MOUTH_CLOSE_S = 0.2;
/** A queued reaction is dropped if it hasn't started this long after it was queued (s). */
const QUEUE_S = 0.5;
/** Cooldown per (region, gesture kind) (s). */
const COOLDOWN_S = 0.8;
/** A released sustained reaction eases out over this long, then ends (s). */
const RELEASE_S = 0.4;
/** Repeat-based escalation defaults (plan §3.5): the same reaction ×3 within 4 s. */
const REPEAT_COUNT = 3;
const REPEAT_WITHIN_MS = 4000;
/** Below this priority a reaction while Talking is a flinch only (session row 31). */
const STOPS_PLAYBACK = 3;

/** The base pose of each state (#79 "Base mapping"; Reacting and Sustained are Idle's, #91). */
const BASE_OF: { readonly [S in DirState]: BaseName } = {
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

/** The additive flinch a P1/P2 reaction plays while Talking (#91): a 150 ms `BodySquash` dip to −0.03. */
const FLINCH: Clip = {
  name: 'flinch',
  duration: 0.15,
  tracks: [
    {
      ch: Ch.BodySquash,
      keys: [
        { t: 0, v: 0, ease: 'out' },
        { t: 0.05, v: -0.03, ease: 'inOut' },
        { t: 0.15, v: 0 },
      ],
    },
  ],
};

/** `c` mirrored left–right: its `HeadRot` keys negated (a pet leaning into a leftward stroke, #89 hand-off). */
function mirrored(c: Clip): Clip {
  return {
    ...c,
    name: `${c.name}Mirrored`,
    tracks: c.tracks.map((tr) =>
      tr.ch === Ch.HeadRot ? { ch: tr.ch, keys: tr.keys.map((key) => ({ ...key, v: -key.v })) } : tr,
    ),
  };
}

const PET_MIRRORED: Clip = mirrored(REACTION_CLIPS.pet);
/** The clips with a mirrored variant, by name: played for a stroke with `dirX` −1. */
const MIRRORED: ReadonlyMap<string, string> = new Map([[REACTION_CLIPS.pet.name, PET_MIRRORED.name]]);

/** The clips the director plays, by name: session, reaction, the flinch and the mirrored pet. */
const CLIPS: ReadonlyMap<string, Clip> = new Map<string, Clip>([
  ...Object.entries(SESSION_CLIPS),
  ...Object.entries(REACTION_CLIPS),
  [FLINCH.name, FLINCH],
  [PET_MIRRORED.name, PET_MIRRORED],
]);

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
    reaction: null,
    queued: null,
    cooldowns: [],
    repeats: [],
    gentle: false,
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
/** Where a step's outputs go; null when the caller (`directorReduce`) drops them. */
type Out = DirOut[] | null;

/**
 * End of `clip` on the director clock. A clip the director doesn't know has already ended. The active
 * reaction's clip ends 400 ms after its release; while held, a sustained clip never ends.
 */
function clipEnd(s: DirectorState, clip: { name: string; start: number }): number {
  const c = CLIPS.get(clip.name);
  if (c === undefined) return clip.start;
  const a = s.reaction;
  if (a !== null && clip.name === a.clip) {
    if (a.release !== null) return a.release + RELEASE_S;
    if (c.sustained === true && a.r.sustained) return Number.POSITIVE_INFINITY;
  }
  return clip.start + c.duration;
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
function enter(s: DirectorState, to: DirState, now: number, clip = keptClip(s)): DirectorState {
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

/** `s` without its reaction and queue: `wake` and `sleep` end every reaction. */
const calm = (s: DirectorState): DirectorState =>
  s.reaction === null && s.queued === null ? s : { ...s, reaction: null, queued: null };

const toWaking: Transition = (s, _ev, now) => enter(calm(s), 'Waking', now, { name: 'wake', start: now });
const toAsleep: Transition = (s, _ev, now) => enter(calm(s), 'Asleep', now, { name: 'sleep', start: now });
/**
 * To Idle, or to the reaction going on there: a reaction handed to the session while Talking (queued,
 * announced) starts at `talkEnd`; an active reaction (additive until now) becomes Reacting or Sustained.
 */
const toIdle: Transition = (s, _ev, now) => {
  const idle = enter(s, 'Idle', now);
  const q = idle.queued;
  if (q !== null && q.announced && now <= q.at + QUEUE_S) return startQueued(idle, q, now, null);
  const a = idle.reaction;
  return a === null ? idle : { ...idle, name: a.r.sustained ? 'Sustained' : 'Reacting' };
};
const toAttentive: Transition = (s, _ev, now) => enter(s, 'Attentive', now);
const toThinking: Transition = (s, _ev, now) => enter(s, 'Thinking', now);
const toDozing: Transition = (s, _ev, now) => enter(s, 'Dozing', now);
/**
 * Talking starts: a sustained reaction plays on additively (held, or easing out after its release), a one-shot
 * is no longer tracked (its clip plays to its end), and the queue is dropped. New reactions while Talking follow
 * the Talking rules; the held one's refreshes and release output nothing, so a continuing stroke never stops the
 * replay (#91 plan review, finding 1).
 */
const toTalking = (s: DirectorState, ev: { id: number }, now: number): DirectorState => {
  const a = s.reaction;
  const reaction = a === null || !a.r.sustained ? null : a;
  return {
    ...enter(s, 'Talking', now),
    talk: { id: ev.id, startCtxTime: null },
    mouthCloseStart: null,
    reaction,
    queued: null,
  };
};
/** Additive: plays the clip on top of the unchanged state, unless a clip is playing or a reaction is active. */
const additive = (
  s: DirectorState,
  ev: { e: 'confused' | 'earTwitch' | 'shrug' },
  now: number,
): DirectorState =>
  s.reaction !== null || (s.clip !== null && now < clipEnd(s, s.clip))
    ? s
    : { ...s, clip: { name: ev.e, start: now } };

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
    idle: 'ignore', // Reacting is Idle's: it ends at its clip end
    attentive: toAttentive, // the reaction plays on additively
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
    idle: 'ignore', // Sustained is Idle's: it ends 400 ms after its release
    attentive: toAttentive, // the reaction plays on additively
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

// ---- reactions -----------------------------------------------------------------------------------------
/** Outputs an accepted reaction: to the session (with `sfx`), its haptic and its mood. */
function accept(out: Out, r: Reaction, sfx: SfxId | null): void {
  if (out === null) return;
  out.push({ k: 'toSession', ev: { t: 'reaction', name: r.name, priority: r.priority, sfx } });
  if (r.haptic !== undefined) out.push({ k: 'haptic', pattern: r.haptic });
  if (r.mood !== undefined) out.push({ k: 'mood', ...r.mood });
}

/** Outputs `r` to the session with `sfx` alone (a refresh's loop, a release). */
function toSession(out: Out, r: Reaction, sfx: SfxId): void {
  if (out !== null)
    out.push({ k: 'toSession', ev: { t: 'reaction', name: r.name, priority: r.priority, sfx } });
}

/** The clip `r` plays: its gentle clip in Gentle mode, the mirrored variant for a leftward stroke. */
function clipFor(r: Reaction, gentle: boolean, dirX: -1 | 1 | null): string {
  const name = gentle && r.gentleClip !== undefined ? r.gentleClip : r.clip;
  return dirX === -1 ? (MIRRORED.get(name) ?? name) : name;
}

/** The escalation target, or null: unknown, or in Gentle mode without a gentle clip (the base plays). */
function escalationTarget(esc: Escalation, gentle: boolean): Reaction | null {
  const to = REACTIONS[esc.to];
  if (to === undefined || (gentle && to.gentleClip === undefined)) return null;
  return to;
}

/** Whether the input falls in its (region, gesture) cooldown and is no higher priority than its starter. */
function cooledDown(s: DirectorState, i: GestureInput): boolean {
  for (const c of s.cooldowns) {
    if (c.region === i.region && c.gesture === i.gesture && i.now < c.at + COOLDOWN_S)
      return i.r.priority <= c.priority;
  }
  return false;
}

/** `cooldowns` with a new one for (region, gesture) at `now`; expired and replaced ones pruned. */
function withCooldown(
  cooldowns: readonly Cooldown[],
  region: RegionId,
  gesture: GestureKind,
  priority: Priority,
  now: number,
): readonly Cooldown[] {
  const kept = cooldowns.filter(
    (c) => now < c.at + COOLDOWN_S && !(c.region === region && c.gesture === gesture),
  );
  kept.push({ region, gesture, at: now, priority });
  return kept;
}

/** Whether `esc` counts repeats (it has no `continuousMs`). */
function isRepeat(esc: Escalation | undefined): esc is Escalation {
  return esc !== undefined && esc.continuousMs === undefined;
}

/** `repeats` with `r` accepted at `now` when it escalates by repeats; expired ones pruned. */
function withRepeat(repeats: readonly Repeat[], r: Reaction, now: number): readonly Repeat[] {
  const esc = r.escalation;
  if (!isRepeat(esc)) return repeats;
  const kept = repeats.filter((e) => now <= e.at + e.within);
  kept.push({ name: r.name, at: now, within: (esc.withinMs ?? REPEAT_WITHIN_MS) / 1000 });
  return kept;
}

/** Whether a reaction is over at `now`: a one-shot at its clip end, a released one 400 ms after its release. */
function isOver(s: DirectorState, a: ActiveReaction, now: number): boolean {
  if (a.release !== null) return now >= a.release + RELEASE_S;
  if (a.r.sustained) return false;
  const c = s.clip;
  return c === null || c.name !== a.clip || now >= clipEnd(s, c);
}

/**
 * Starts `r` at `now`: outputs it (unless the session already has it), starts its cooldown, counts it, and
 * plays its clip. From the Idle family it becomes the base (Reacting/Sustained); in Attentive and Thinking it
 * is additive.
 */
function start(
  s: DirectorState,
  r: Reaction,
  region: RegionId,
  gesture: GestureKind,
  dirX: -1 | 1 | null,
  now: number,
  out: Out,
  announced: boolean,
): DirectorState {
  if (!announced) accept(out, r, r.sfx);
  const clipName = clipFor(r, s.gentle, dirX);
  const clip = { name: clipName, start: now };
  const next: DirectorState = {
    ...s,
    cooldowns: announced ? s.cooldowns : withCooldown(s.cooldowns, region, gesture, r.priority, now),
    repeats: announced ? s.repeats : withRepeat(s.repeats, r, now),
    reaction: { r, clip: clipName, start: now, last: now, runStart: now, sfxAt: now, release: null },
  };
  if (s.name === 'Attentive' || s.name === 'Thinking') return { ...next, clip };
  return enter(next, r.sustained ? 'Sustained' : 'Reacting', now, clip);
}

/** Starts the queued reaction `q` (and empties the queue). */
function startQueued(s: DirectorState, q: QueuedReaction, now: number, out: Out): DirectorState {
  return start({ ...s, queued: null }, q.r, q.region, q.gesture, q.dirX, now, out, q.announced);
}

/**
 * The active reaction is over: it and its clip are cleared, then a fresh queued reaction starts; otherwise
 * Reacting and Sustained go to Idle. While Talking, a queued (announced) reaction waits for `talkEnd`.
 */
function endReaction(s: DirectorState, a: ActiveReaction, now: number, out: Out): DirectorState {
  const clip = s.clip !== null && s.clip.name === a.clip ? null : s.clip;
  const q = s.queued;
  const talking = s.name === 'Talking';
  if (q !== null && !talking && now <= q.at + QUEUE_S)
    return startQueued({ ...s, reaction: null, clip }, q, now, out);
  const cleared: DirectorState = { ...s, reaction: null, clip, queued: talking ? q : null };
  return s.name === 'Reacting' || s.name === 'Sustained' ? enter(cleared, 'Idle', now, clip) : cleared;
}

/** A refresh of the held reaction `a` by the same reaction (see the module comment). */
function refresh(s: DirectorState, a: ActiveReaction, i: GestureInput, out: Out): DirectorState {
  const now = i.now;
  const talking = s.name === 'Talking';
  const esc = a.r.escalation;
  let runStart = a.runStart;
  if (esc !== undefined && esc.continuousMs !== undefined) {
    if (esc.maxGapMs !== undefined && now > a.last + esc.maxGapMs / 1000) runStart = now;
    if (!talking && now > runStart + esc.continuousMs / 1000) {
      const to = escalationTarget(esc, s.gentle);
      if (to !== null) return start(s, to, i.region, i.gesture, i.dirX ?? null, now, out, false);
    }
  }
  let clip = s.clip;
  const def = CLIPS.get(a.clip);
  if (
    def !== undefined &&
    (clip === null || clip.name !== a.clip || (def.sustained !== true && now >= clip.start + def.duration))
  )
    clip = { name: a.clip, start: now };
  let sfxAt = a.sfxAt;
  const loop = a.r.sfxLoopMs;
  if (!talking && a.r.sfx !== null && loop !== undefined && now >= a.sfxAt + loop / 1000) {
    toSession(out, a.r, a.r.sfx);
    sfxAt = now;
  }
  return { ...s, clip, reaction: { ...a, last: now, runStart, sfxAt } };
}

/** A gesture's reaction (see the module comment for the rules, in this order). */
function onGesture(s0: DirectorState, i: GestureInput, out: Out): DirectorState {
  if (s0.name === 'Asleep' || s0.name === 'Waking') return s0;
  const now = i.now;
  const s = s0.name === 'Dozing' ? enter(s0, 'Idle', now) : s0;
  const live = s.reaction !== null && !isOver(s, s.reaction, now) ? s.reaction : null;
  if (live !== null && live.release === null && live.r.sustained && live.r.name === i.r.name)
    return refresh(s, live, i, out);
  if (cooledDown(s, i)) return s;
  const dirX = i.dirX ?? null;
  let r = i.r;
  let repeats = s.repeats;
  const esc = r.escalation;
  if (isRepeat(esc)) {
    let n = 1;
    for (const e of repeats) if (e.name === r.name && now <= e.at + e.within) n++;
    const to = n >= (esc.count ?? REPEAT_COUNT) ? escalationTarget(esc, s.gentle) : null;
    if (to !== null) {
      const from = r.name;
      repeats = repeats.filter((e) => e.name !== from);
      r = to;
    }
  }
  const st = repeats === s.repeats ? s : { ...s, repeats };
  if (st.name === 'Talking') {
    const cooldowns = withCooldown(st.cooldowns, i.region, i.gesture, r.priority, now);
    const counted = withRepeat(st.repeats, r, now);
    if (r.priority < STOPS_PLAYBACK) {
      accept(out, r, null);
      const free = st.clip === null || now >= clipEnd(st, st.clip);
      return { ...st, cooldowns, repeats: counted, clip: free ? { name: FLINCH.name, start: now } : st.clip };
    }
    accept(out, r, r.sfx);
    const queued = { r, region: i.region, gesture: i.gesture, dirX, at: now, announced: true };
    return { ...st, cooldowns, repeats: counted, queued };
  }
  if (live !== null && r.priority < live.r.priority)
    return { ...st, queued: { r, region: i.region, gesture: i.gesture, dirX, at: now, announced: false } };
  return start(st, r, i.region, i.gesture, dirX, now, out, false);
}

/**
 * The end of a sustained gesture: `sfxOnRelease` (not while Talking: it would stop the replay), then the held
 * reaction eases out over 400 ms.
 */
function release(s: DirectorState, now: number, out: Out): DirectorState {
  const a = s.reaction;
  if (a === null || !a.r.sustained || a.release !== null) return s;
  if (a.r.sfxOnRelease !== undefined && s.name !== 'Talking') toSession(out, a.r, a.r.sfxOnRelease);
  return { ...s, reaction: { ...a, release: now } };
}

/**
 * A tick: an active reaction that is over ends (and a fresh queued one starts); a stale queued reaction is
 * dropped; a clip at or past its end is cleared; in Waking, that (or having no clip) moves to Idle. Returns
 * `s` itself, allocating nothing, when nothing is due.
 *
 * It runs once per 120 Hz substep, so it takes the input itself rather than its time, and its quiet paths (no
 * reaction, or a held or released one) pass no double to a call: V8's mid tier boxes a double passed across a
 * call (#229, the frame-allocation smoke of #214). A non-finite time changes nothing: `t − t` is 0 for every
 * finite `t` and NaN otherwise, a check that, unlike `Number.isFinite`, needs no call.
 */
function tick(s: DirectorState, i: { readonly now: number }, out: Out): DirectorState {
  const now = i.now;
  if (now - now !== 0) return s;
  const a = s.reaction;
  if (a !== null && (a.release !== null ? now >= a.release + RELEASE_S : !a.r.sustained && isOver(s, a, now)))
    return endReaction(s, a, now, out);
  const q = s.queued;
  if (q !== null && now > q.at + QUEUE_S) return { ...s, queued: null };
  if (s.clip !== null && now < clipEnd(s, s.clip)) return s;
  if (s.name === 'Waking') return enter(s, 'Idle', now, null);
  return s.clip === null ? s : { ...s, clip: null };
}

/**
 * One step of the director. Pure: it never mutates `s`, and returns `s` itself when nothing changes. A tick,
 * gesture or release at a non-finite time changes nothing (a NaN release would otherwise never end; `tick`
 * checks its own).
 */
function step(s: DirectorState, i: DirInput, out: Out): DirectorState {
  if ((i.k === 'gesture' || i.k === 'release') && i.now - i.now !== 0) return s;
  switch (i.k) {
    case 'tick':
      return tick(s, i, out);
    case 'anim': {
      if (!KINDS.has(i.ev.e)) return s;
      const handler = handlerFor(s.name, i.ev.e);
      return handler === 'ignore' ? s : handler(s, i.ev, i.now);
    }
    case 'gesture':
      return onGesture(s, i, out);
    case 'release':
      return release(s, i.now, out);
    case 'setGentle':
      return s.gentle === i.on ? s : { ...s, gentle: i.on };
    default:
      return s; // an input kind the types don't know
  }
}

/** The outputs of the step in progress (`directorStep` is not re-entrant). */
const SCRATCH: DirOut[] = [];
const NO_OUT: readonly DirOut[] = Object.freeze([]);
/** The last step without outputs, reused while the state stays the same, so a quiet tick allocates nothing. */
let quiet: DirStep = Object.freeze({ state: initialDirector(0), out: NO_OUT });

/**
 * The director step: the new state and the outputs (`toSession` for `session.dispatch`, `haptic`, `mood`).
 * Pure: it never mutates `s` and returns `s` itself as the state when nothing changes. A step without
 * outputs returns a frozen result that is shared while its state is the same object.
 */
export function directorStep(s: DirectorState, i: DirInput): DirStep {
  SCRATCH.length = 0;
  const state = step(s, i, SCRATCH);
  if (SCRATCH.length === 0) {
    if (quiet.state !== state) quiet = Object.freeze({ state, out: NO_OUT });
    return quiet;
  }
  return { state, out: SCRATCH.splice(0) };
}

/** The director reducer: `directorStep(s, i).state`, without collecting the outputs. */
export function directorReduce(s: DirectorState, i: DirInput): DirectorState {
  return i.k === 'tick' ? tick(s, i, null) : step(s, i, null);
}

/**
 * Writes the director's pose at `now` into `out` and returns `out`: the crossfade
 * `prevBase + (base − prevBase)·t`, `t = clamp((now − fadeStart)/0.15, 0, 1)`, plus the active clip's sample;
 * a released reaction's clip × its 400 ms ease-out, `1 − smoothstep((now − release)/0.4)`.
 * The mouth channels (`Jaw`, `MouthW`, `MouthRound`, `Teeth`) are never written: the mouth layer owns them.
 * Never allocates.
 */
export function evaluate(s: DirectorState, now: number, out: Pose): Pose {
  const a = BASE[s.prevBase];
  const b = BASE[s.base];
  const f = (now - s.fadeStart) / CROSSFADE_S;
  const t = f < 1 ? (f > 0 ? f : 0) : 1;
  let withClip = false;
  let w = 1;
  const playing = s.clip;
  if (playing !== null) {
    const c = CLIPS.get(playing.name);
    if (c !== undefined) {
      sampleClip(c, now - playing.start, CLIP_DELTA);
      withClip = true;
      const r = s.reaction;
      if (r !== null && r.release !== null && playing.name === r.clip) {
        const u = (now - r.release) / RELEASE_S;
        w = u > 0 ? (u < 1 ? 1 - u * u * (3 - 2 * u) : 0) : 1;
      }
    }
  }
  for (let i = 0; i < CH_COUNT; i++) {
    if (i === Ch.Jaw || i === Ch.MouthW || i === Ch.MouthRound || i === Ch.Teeth) continue;
    const ai = a[i]!;
    const v = ai + (b[i]! - ai) * t;
    out[i] = withClip ? v + CLIP_DELTA[i]! * w : v;
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
