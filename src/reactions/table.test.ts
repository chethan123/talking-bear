import { describe, expect, it } from 'vitest';

import type { Clip } from '../anim/clip.ts';
import { GENTLE_BASES, REACTION_CLIPS } from '../anim/clips/reactions.ts';
import { SYNTHS } from '../audio/sfx-synths.ts';
import { initialRecState, recognize } from '../input/recognizer.ts';
import type { Gesture, PointerSample } from '../input/recognizer.ts';
import { REGION_IDS } from '../input/region-ids.ts';
import type { RegionId } from '../input/region-ids.ts';
import { REACTIONS, reactionFor } from './table.ts';
import type { Reaction } from './table.ts';

// Expectations use literal values from issue #90 and plan §4.6.4 / §3.5 / §4.6.3, never the module's constants.

// ---- the expected table ---------------------------------------------------------------------------------------

const TAP_HAPTIC = [12];
const TICKLE_HAPTIC = [8, 40, 8, 40, 8];
const PURR_HAPTIC = [15, 35, 15, 35, 15, 35];

/** A reaction that plays its own clip (the issue names every clip after its reaction). */
const x = (
  name: string,
  priority: Reaction['priority'],
  sfx: Reaction['sfx'],
  sustained: boolean,
  extra: Partial<Reaction> = {},
): Reaction => ({ name, priority, sfx, clip: name, sustained, ...extra });

/** Every reaction of the issue's table, field by field. */
const EXPECTED: Record<string, Reaction> = {
  // Nose
  sneeze: x('sneeze', 2, 'sneeze', false, { haptic: TAP_HAPTIC, gentleClip: 'sneezeGentle' }),
  bigSneeze: x('bigSneeze', 4, 'bigSneeze', false, { haptic: TAP_HAPTIC, gentleClip: 'bigSneezeGentle' }),
  noseWrinkle: x('noseWrinkle', 3, null, true),
  // Head top
  tuftBoing: x('tuftBoing', 2, 'boing', false, { haptic: TAP_HAPTIC }),
  headPress: x('headPress', 3, null, true),
  pet: x('pet', 3, 'purr', true, { haptic: PURR_HAPTIC, mood: { joy: 0.2 }, sfxLoopMs: 1200 }),
  againstFur: x('againstFur', 3, 'hmph', true, { mood: { annoy: 0.2 } }),
  wobble: x('wobble', 2, 'whoa', false, {
    gentleClip: 'wobbleGentle',
    escalation: { to: 'dizzy', count: 3, withinMs: 3000 },
  }),
  dizzy: x('dizzy', 4, 'whoa', false, { gentleClip: 'dizzyGentle' }),
  // Ears
  earFlickL: x('earFlickL', 2, 'hm', false, { haptic: TAP_HAPTIC }),
  earFlickR: x('earFlickR', 2, 'hm', false, { haptic: TAP_HAPTIC }),
  earDroopL: x('earDroopL', 3, 'purr', true),
  earDroopR: x('earDroopR', 3, 'purr', true),
  earFlattenL: x('earFlattenL', 3, null, true),
  earFlattenR: x('earFlattenR', 3, null, true),
  // Eyes
  hardBlinkL: x('hardBlinkL', 2, 'hmph', false, { haptic: TAP_HAPTIC, mood: { annoy: 0.2 } }),
  hardBlinkR: x('hardBlinkR', 2, 'hmph', false, { haptic: TAP_HAPTIC, mood: { annoy: 0.2 } }),
  // Cheeks
  cheekPuffL: x('cheekPuffL', 2, 'pop', false, { haptic: TAP_HAPTIC }),
  cheekPuffR: x('cheekPuffR', 2, 'pop', false, { haptic: TAP_HAPTIC }),
  blush: x('blush', 3, null, true),
  squish: x('squish', 3, null, true, { sfxOnRelease: 'pop' }),
  // Belly
  bellyBoing: x('bellyBoing', 2, 'boingHehe', false, { haptic: TAP_HAPTIC }),
  bellyRub: x('bellyRub', 3, 'sigh', true),
  giggle: x('giggle', 3, 'giggle', true, {
    haptic: TICKLE_HAPTIC,
    mood: { joy: 0.2 },
    escalation: { to: 'laughFit', continuousMs: 3000, maxGapMs: 700 },
  }),
  laughFit: x('laughFit', 4, 'giggle', false, { haptic: TICKLE_HAPTIC, gentleClip: 'laughFitGentle' }),
  hug: x('hug', 4, 'squeal', true, { mood: { joy: 0.2 } }),
  // Paws
  pawWaveL: x('pawWaveL', 2, null, false, { haptic: TAP_HAPTIC }),
  pawWaveR: x('pawWaveR', 2, null, false, { haptic: TAP_HAPTIC }),
  highFiveL: x('highFiveL', 3, null, true, { sfxOnRelease: 'hi' }),
  highFiveR: x('highFiveR', 3, null, true, { sfxOnRelease: 'hi' }),
  // Feet
  footPullL: x('footPullL', 2, 'hey', false, { haptic: TAP_HAPTIC }),
  footPullR: x('footPullR', 2, 'hey', false, { haptic: TAP_HAPTIC }),
  kickGiggle: x('kickGiggle', 3, 'giggle', true, { haptic: TICKLE_HAPTIC }),
  // Neckerchief
  kerchiefAdjust: x('kerchiefAdjust', 2, 'rustle', false, { haptic: TAP_HAPTIC }),
};

/** The issue's table by column: region → reaction name (with the side suffix). Unlisted cells are `null`. */
type Column = 'tap' | 'longPress' | 'stroke' | 'tickle' | 'flick';
const CELLS: Record<Column, Partial<Record<RegionId, string>>> = {
  tap: {
    nose: 'sneeze',
    headTop: 'tuftBoing',
    earL: 'earFlickL',
    earR: 'earFlickR',
    eyeL: 'hardBlinkL',
    eyeR: 'hardBlinkR',
    cheekL: 'cheekPuffL',
    cheekR: 'cheekPuffR',
    belly: 'bellyBoing',
    pawL: 'pawWaveL',
    pawR: 'pawWaveR',
    footL: 'footPullL',
    footR: 'footPullR',
    neckerchief: 'kerchiefAdjust',
  },
  longPress: {
    nose: 'noseWrinkle',
    headTop: 'headPress',
    earL: 'earDroopL',
    earR: 'earDroopR',
    belly: 'bellyRub',
    pawL: 'highFiveL',
    pawR: 'highFiveR',
  },
  stroke: {
    headTop: 'pet',
    earL: 'earFlattenL',
    earR: 'earFlattenR',
    cheekL: 'blush',
    cheekR: 'blush',
    belly: 'pet',
  },
  tickle: { belly: 'giggle', footL: 'kickGiggle', footR: 'kickGiggle' },
  flick: { headTop: 'wobble' },
};

// ---- gesture builders -------------------------------------------------------------------------------------------

const tap = (region: RegionId, count = 1, phase: 'down' | 'up' = 'down'): Gesture => ({
  g: 'tap',
  phase,
  region,
  x: 100,
  y: 100,
  count,
});
const longPress = (region: RegionId, phase: 'start' | 'end' = 'start'): Gesture => ({
  g: 'longPress',
  region,
  phase,
});
const stroke = (
  region: RegionId,
  phase: 'start' | 'update' | 'end',
  pathPx: number,
  against = false,
): Gesture => ({ g: 'stroke', region, phase, pathPx, dir: against ? -Math.PI / 2 : 0, against });
const tickle = (region: RegionId): Gesture => ({ g: 'tickle', region });
const flick = (region: RegionId): Gesture => ({ g: 'flick', region, vx: 0, vy: -1500 });
const pinch = (a: RegionId, b: RegionId): Gesture => ({ g: 'pinch', regions: [a, b], spanRatio: 0.8 });

/** The gesture that triggers a column's cell (a pet stroke needs an `update` at ≥ 120 px). */
const trigger: Record<Column, (region: RegionId) => Gesture> = {
  tap: (r) => tap(r),
  longPress: (r) => longPress(r),
  stroke: (r) => stroke(r, 'update', 120),
  tickle,
  flick,
};
/** Every gesture of a column on a region, triggering or not. */
const probes: Record<Column, (region: RegionId) => Gesture[]> = {
  tap: (r) => [1, 2, 3, 4].flatMap((n) => [tap(r, n), tap(r, n, 'up')]),
  longPress: (r) => [longPress(r), longPress(r, 'end')],
  stroke: (r) =>
    [false, true].flatMap((against) => [
      stroke(r, 'start', 20, against),
      stroke(r, 'start', 300, against),
      stroke(r, 'update', 60, against),
      stroke(r, 'update', 119, against),
      stroke(r, 'update', 120, against),
      stroke(r, 'update', 500, against),
      stroke(r, 'end', 300, against),
    ]),
  tickle: (r) => [tickle(r)],
  flick: (r) => [flick(r)],
};
const COLUMNS: readonly Column[] = ['tap', 'longPress', 'stroke', 'tickle', 'flick'];

const nameOf = (g: Gesture): string | null => reactionFor(g)?.name ?? null;
const CLIP_BY_NAME = new Map<string, Clip>(Object.entries(REACTION_CLIPS));

// ---- recogniser traces (#86) -------------------------------------------------------------------------------------

const dn = (t: number, px: number, py: number): PointerSample => ({ id: 1, t, x: px, y: py, type: 'down' });
const mv = (t: number, px: number, py: number): PointerSample => ({ id: 1, t, x: px, y: py, type: 'move' });
const up = (t: number, px: number, py: number): PointerSample => ({ id: 1, t, x: px, y: py, type: 'up' });

/** Runs `samples` through the real recogniser (every point hits `region`), then each gesture through the table. */
function play(samples: readonly PointerSample[], region: RegionId) {
  let s = initialRecState();
  const gestures: Gesture[] = [];
  for (const smp of samples) {
    const [next, out] = recognize(s, smp, () => region);
    s = next;
    gestures.push(...out);
  }
  const names = gestures.map(reactionFor).flatMap((r) => (r === null ? [] : [r.name]));
  return { gestures, names };
}

// ---- REACTIONS --------------------------------------------------------------------------------------------------

describe('REACTIONS', () => {
  it('holds exactly the issue’s reactions, field by field', () => {
    expect(REACTIONS).toStrictEqual(EXPECTED);
  });

  it('keys every reaction by its name', () => {
    for (const [key, r] of Object.entries(REACTIONS)) expect(r.name).toBe(key);
  });

  it('is frozen through and through (reactionFor hands out shared entries)', () => {
    expect(Object.isFrozen(REACTIONS)).toBe(true);
    for (const r of Object.values(REACTIONS)) {
      expect(Object.isFrozen(r), r.name).toBe(true);
      for (const part of [r.escalation, r.haptic, r.mood]) {
        if (part !== undefined) expect(Object.isFrozen(part), r.name).toBe(true);
      }
    }
  });

  // Validation 2.
  it('names only clips that exist in REACTION_CLIPS, and only sfx that exist in SYNTHS', () => {
    const clips = Object.keys(REACTION_CLIPS);
    const synths = Object.keys(SYNTHS);
    for (const r of Object.values(REACTIONS)) {
      expect(clips, r.name).toContain(r.clip);
      if (r.gentleClip !== undefined) expect(clips, r.name).toContain(r.gentleClip);
      if (r.sfx !== null) expect(synths, r.name).toContain(r.sfx);
      if (r.sfxOnRelease !== undefined) expect(synths, r.name).toContain(r.sfxOnRelease);
    }
  });

  it('plays every base clip of #89 from exactly one reaction', () => {
    const gentle = new Set(GENTLE_BASES.map((b) => `${b}Gentle`));
    const bases = Object.keys(REACTION_CLIPS).filter((c) => !gentle.has(c));
    expect(
      Object.values(REACTIONS)
        .map((r) => r.clip)
        .toSorted(),
    ).toEqual(bases.toSorted());
  });

  it('gives a gentle clip to exactly the reactions #89 made a gentle variant for', () => {
    const withGentle = Object.values(REACTIONS).filter((r) => r.gentleClip !== undefined);
    expect(withGentle.map((r) => r.name).toSorted()).toEqual([...GENTLE_BASES].toSorted());
    for (const r of withGentle) expect(r.gentleClip).toBe(`${r.clip}Gentle`);
  });

  it('escalates only to P4 reactions in the table', () => {
    const escalating = Object.values(REACTIONS).filter((r) => r.escalation !== undefined);
    expect(escalating.map((r) => r.name).toSorted()).toEqual(['giggle', 'wobble']);
    for (const r of escalating) expect(REACTIONS[r.escalation!.to]?.priority, r.name).toBe(4);
  });

  it('marks every reaction whose clip holds its pose, or that has release or loop sound, as sustained', () => {
    for (const r of Object.values(REACTIONS)) {
      if (CLIP_BY_NAME.get(r.clip)?.sustained === true) expect(r.sustained, r.name).toBe(true);
      if (r.sfxOnRelease !== undefined || r.sfxLoopMs !== undefined) expect(r.sustained, r.name).toBe(true);
    }
  });
});

// Validation 4.
describe('content guard (plan Q3)', () => {
  const FORBIDDEN = ['cry', 'hurt', 'pain', 'scared'];
  const forbiddenIn = (name: string) => FORBIDDEN.filter((w) => name.toLowerCase().includes(w));

  it('the guard catches each word in any case, and passes a clean name', () => {
    expect(forbiddenIn('cryL')).toEqual(['cry']);
    expect(forbiddenIn('bigHurt')).toEqual(['hurt']);
    expect(forbiddenIn('Pain')).toEqual(['pain']);
    expect(forbiddenIn('isScared')).toEqual(['scared']);
    expect(forbiddenIn('pet')).toEqual([]);
  });

  it('no reaction name (nor its clip, gentle clip or escalation target) contains cry, hurt, pain or scared', () => {
    expect(Object.keys(REACTIONS)).toHaveLength(34);
    for (const [key, r] of Object.entries(REACTIONS)) {
      for (const name of [key, r.name, r.clip, r.gentleClip ?? '', r.escalation?.to ?? '']) {
        expect(forbiddenIn(name), name).toEqual([]);
      }
    }
  });
});

// ---- reactionFor --------------------------------------------------------------------------------------------------

describe('reactionFor', () => {
  // Validation 1.
  describe('every cell of the table maps as specified', () => {
    const cells = COLUMNS.flatMap((col) =>
      REGION_IDS.flatMap((region) => {
        const name = CELLS[col][region];
        return name === undefined ? [] : [{ col, region, name }];
      }),
    );
    it.each(cells)('$col on $region → $name', ({ col, region, name }) => {
      const r = reactionFor(trigger[col](region));
      expect(r).toBe(REACTIONS[name]);
      expect(r).toStrictEqual(EXPECTED[name]);
    });

    it('nose tap: count 1–2 → sneeze (P2); count ≥ 3 → bigSneeze (P4)', () => {
      expect(nameOf(tap('nose', 1))).toBe('sneeze');
      expect(nameOf(tap('nose', 2))).toBe('sneeze');
      for (const n of [3, 4, 9]) expect(reactionFor(tap('nose', n))).toStrictEqual(EXPECTED['bigSneeze']);
    });

    it('a multi-poke count changes no other region’s tap', () => {
      for (const region of REGION_IDS) {
        const name = CELLS.tap[region];
        if (name !== undefined && region !== 'nose') expect(nameOf(tap(region, 3))).toBe(name);
      }
    });

    it('headTop: a stroke against the fur → againstFur, also gated on an update at ≥ 120 px', () => {
      expect(reactionFor(stroke('headTop', 'update', 120, true))).toStrictEqual(EXPECTED['againstFur']);
      expect(nameOf(stroke('headTop', 'update', 500, true))).toBe('againstFur');
      expect(nameOf(stroke('headTop', 'update', 119, true))).toBeNull();
      expect(nameOf(stroke('headTop', 'start', 300, true))).toBeNull();
      expect(nameOf(stroke('headTop', 'end', 300, true))).toBeNull();
    });

    it('pet (headTop and belly) only on an update at pathPx ≥ 120, never on start or end', () => {
      for (const region of ['headTop', 'belly'] as const) {
        expect(nameOf(stroke(region, 'update', 119))).toBeNull();
        expect(nameOf(stroke(region, 'update', 120))).toBe('pet');
        expect(nameOf(stroke(region, 'update', 1000))).toBe('pet');
        expect(nameOf(stroke(region, 'start', 20))).toBeNull();
        expect(nameOf(stroke(region, 'start', 300))).toBeNull();
        expect(nameOf(stroke(region, 'end', 300))).toBeNull();
      }
      // `against` is a headTop notion: a belly stroke is a pet either way.
      expect(nameOf(stroke('belly', 'update', 120, true))).toBe('pet');
    });

    it('ear and cheek strokes react from their start and on every update, at any length', () => {
      for (const [region, name] of [
        ['earL', 'earFlattenL'],
        ['earR', 'earFlattenR'],
        ['cheekL', 'blush'],
        ['cheekR', 'blush'],
      ] as const) {
        for (const pathPx of [11, 60, 119, 120, 400]) {
          expect(nameOf(stroke(region, 'start', pathPx))).toBe(name);
          expect(nameOf(stroke(region, 'update', pathPx))).toBe(name);
        }
        expect(nameOf(stroke(region, 'end', 400))).toBeNull();
      }
    });

    it('pinch on the cheeks (either order) → squish; hug → hug; allOver → giggle', () => {
      expect(reactionFor(pinch('cheekL', 'cheekR'))).toStrictEqual(EXPECTED['squish']);
      expect(nameOf(pinch('cheekR', 'cheekL'))).toBe('squish');
      expect(reactionFor({ g: 'hug' })).toStrictEqual(EXPECTED['hug']);
      expect(reactionFor({ g: 'allOver' })).toStrictEqual(EXPECTED['giggle']);
    });
  });

  // Validation 3.
  it('cancel → null', () => {
    expect(reactionFor({ g: 'cancel' })).toBeNull();
  });

  it('tap up → null on every region, at any count', () => {
    for (const region of REGION_IDS) {
      for (const n of [1, 2, 3, 4]) expect(reactionFor(tap(region, n, 'up')), region).toBeNull();
    }
  });

  it('longPress end and stroke end → null on every region', () => {
    for (const region of REGION_IDS) {
      expect(reactionFor(longPress(region, 'end')), region).toBeNull();
      expect(reactionFor(stroke(region, 'end', 300)), region).toBeNull();
      expect(reactionFor(stroke(region, 'end', 300, true)), region).toBeNull();
    }
  });

  it('every unlisted combination → null (background and the flanks included)', () => {
    for (const col of COLUMNS) {
      for (const region of REGION_IDS) {
        if (CELLS[col][region] !== undefined) continue;
        for (const g of probes[col](region)) expect(reactionFor(g), `${col} on ${region}`).toBeNull();
      }
    }
    for (const a of REGION_IDS) {
      for (const b of REGION_IDS) {
        const cheeks = (a === 'cheekL' && b === 'cheekR') || (a === 'cheekR' && b === 'cheekL');
        if (!cheeks) expect(reactionFor(pinch(a, b)), `pinch ${a}+${b}`).toBeNull();
      }
    }
  });

  it('background: no gesture reacts (the app sets the gaze instead, #93)', () => {
    for (const col of COLUMNS) {
      for (const g of probes[col]('background')) expect(reactionFor(g)).toBeNull();
    }
  });

  it('is pure: the same gesture gives the same shared entry, and the gesture is not touched', () => {
    const g = Object.freeze(tap('nose', 3));
    const a = reactionFor(g);
    expect(reactionFor(g)).toBe(a);
    expect(a).toBe(REACTIONS['bigSneeze']);
  });

  // The recogniser's real gesture streams (ORCH-NOTEs on #90).
  describe('on recogniser traces (#86)', () => {
    it('an upward head flick: its against-the-fur stroke start is no againstFur; only the wobble reacts', () => {
      // 10 px up every 10 ms (1000 px/s: stroke speed, then a flick on release at 110 ms).
      const samples = [dn(0, 500, 500)];
      for (let i = 1; i <= 10; i++) samples.push(mv(i * 10, 500, 500 - 10 * i));
      samples.push(up(110, 500, 390));
      const { gestures, names } = play(samples, 'headTop');
      expect(gestures).toContainEqual(
        expect.objectContaining({ g: 'stroke', phase: 'start', against: true }),
      );
      expect(gestures.at(-1)).toMatchObject({ g: 'flick', region: 'headTop' });
      expect(names).toEqual(['tuftBoing', 'wobble']);
    });

    it('a belly scrub that starts as a stroke (its end at ≥ 120 px) giggles and never pets', () => {
      // A 100 px drag at 1000 px/s, then a ±15 px scrub, 5 px every 5 ms, for 900 ms.
      const samples = [dn(0, 500, 500)];
      let t = 0;
      let px = 500;
      for (let i = 0; i < 10; i++) samples.push(mv((t += 10), (px += 10), 500));
      for (let leg = 0, dir = -1; leg < 60; leg++, dir = -dir) {
        for (let j = 0; j < 3; j++) samples.push(mv((t += 5), (px += 5 * dir), 500));
      }
      samples.push(up(t + 5, px, 500));
      const { gestures, names } = play(samples, 'belly');
      // The trace is the case in point: one stroke whose end, not any update, reaches 120 px; then tickles.
      const strokes = gestures.filter((g): g is Extract<Gesture, { g: 'stroke' }> => g.g === 'stroke');
      expect(strokes.map((g) => g.phase)).toEqual(['start', 'update', 'end']);
      expect(strokes[1]!.pathPx).toBeLessThan(120);
      expect(strokes[2]!.pathPx).toBeGreaterThanOrEqual(120);
      expect(gestures.filter((g) => g.g === 'tickle').length).toBeGreaterThanOrEqual(2);
      expect(names).toEqual(['bellyBoing', ...names.slice(1).map(() => 'giggle')]);
      expect(names.length).toBeGreaterThanOrEqual(3);
    });
  });
});
