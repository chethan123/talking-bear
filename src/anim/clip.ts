/**
 * Keyframed animation clips and their sampler (plan §3.5, §4.6.5 "Animations mapped to channels").
 *
 * A clip is a set of per-channel key tracks. `sampleClip` turns it into an **additive delta pose** at a
 * time `t`: the director (#79) adds that delta to the crossfaded base pose and drops the clip at its end,
 * so a clip's tracks normally start and end at 0.
 *
 * `sampleClip` runs every frame, so it never allocates: indexed `for` loops only, and no closures, array
 * or object literals, destructuring, spreads, `for…of` or string building on its path (`sampleKeys`,
 * `ease`). `out.fill(0)` doesn't allocate. (That holds once V8 has optimised it: V8's interpreter and
 * baseline tiers box every intermediate double, in any code.)
 */
import type { Pose } from './pose.ts';

/** One key of a track. */
export interface Key {
  /** Time in seconds from the clip start. */
  t: number;
  /** Channel value at `t`, in the channel's units (see `pose.ts`). */
  v: number;
  /**
   * Ease of the segment from this key to the next (default `'linear'`): `inOut` is a smoothstep
   * 3u² − 2u³, `in` is u², `out` is 1 − (1 − u)². Ignored on the last key.
   */
  ease?: 'linear' | 'inOut' | 'out' | 'in';
}

/** The keys of one channel. */
export interface Track {
  /** The pose channel this track writes: a `Ch` value. */
  ch: number;
  /** Keys sorted by `t`. Two keys at the same time make an instantaneous step. */
  keys: readonly Key[];
}

/**
 * A keyframed clip. Later tasks may add optional fields (#89 adds `sustained?: boolean` for reactions).
 */
export interface Clip {
  name: string;
  /** Length in seconds; at least the time of the last key of every track. */
  duration: number;
  tracks: readonly Track[];
  /**
   * Spring kicks: at time `t`, add `dv` to the velocity of SpringBank spring `spring`. The consumer that
   * owns the SpringBank applies them; `sampleClip` ignores them.
   */
  impulses?: readonly { t: number; spring: number; dv: number }[];
}

/** Eased progress through a segment, for `u` in [0, 1]; every ease maps 0 to 0 and 1 to 1. */
function ease(kind: Key['ease'], u: number): number {
  switch (kind) {
    case 'inOut':
      return u * u * (3 - 2 * u);
    case 'in':
      return u * u;
    case 'out':
      return 1 - (1 - u) * (1 - u);
    default:
      return u;
  }
}

/**
 * The value of a key track at time `t`: the first key's value before it, the last key's value from it on,
 * and in between the eased interpolation of the segment `t` falls in (with the ease of its first key).
 * At a key's time the result is exactly that key's value. An empty track is 0.
 */
function sampleKeys(keys: readonly Key[], t: number): number {
  const n = keys.length;
  if (n === 0) return 0;
  const first = keys[0]!;
  if (t <= first.t) return first.v;
  for (let k = 1; k < n; k++) {
    const b = keys[k]!;
    if (t < b.t) {
      // Here keys[k − 1].t ≤ t < b.t, so the span is positive and 0 ≤ u ≤ 1.
      const a = keys[k - 1]!;
      const u = (t - a.t) / (b.t - a.t);
      return a.v + (b.v - a.v) * ease(a.ease, u);
    }
  }
  return keys[n - 1]!.v;
}

/**
 * Samples clip `c` at time `t` (s) into `out` and returns `out`: the additive delta pose of the clip.
 *
 * - `t` is clamped to [0, `c.duration`]; NaN samples as 0.
 * - `out` is zeroed first, so every channel without a track is 0. If two tracks share a channel, the
 *   later one wins.
 * - Never allocates.
 */
export function sampleClip(c: Clip, t: number, out: Pose): Pose {
  out.fill(0);
  const d = c.duration;
  const tc = t > 0 ? (t < d ? t : d) : 0;
  const tracks = c.tracks;
  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i]!;
    out[tr.ch] = sampleKeys(tr.keys, tc);
  }
  return out;
}
