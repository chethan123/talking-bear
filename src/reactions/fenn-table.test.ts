import { describe, expect, it } from 'vitest';

import { FENN_CLIPS } from '../anim/clips/fenn.ts';
import { SYNTHS } from '../audio/sfx-synths.ts';
import { FENN } from '../characters/fenn.ts';
import { initialRecState, recognize } from '../input/recognizer.ts';
import type { Gesture, PointerSample } from '../input/recognizer.ts';
import { REGION_IDS } from '../input/region-ids.ts';
import type { RegionId } from '../input/region-ids.ts';
import { FENN_REACTIONS, fennReactionFor } from './fenn-table.ts';
import { REACTIONS } from './table.ts';
import type { Reaction } from './table.ts';

// Expectations use literal values from duck plan §4.6's table (and table.ts's haptics and mood, plan §4.6.3), never
// the module's constants. T125 acceptance 1.

// ---- the expected table ---------------------------------------------------------------------------------------

const TAP_HAPTIC = [12];
const PURR_HAPTIC = [15, 35, 15, 35, 15, 35];

/** A reaction playing `clip`. */
const x = (
  name: string,
  clip: string,
  priority: Reaction['priority'],
  sfx: Reaction['sfx'],
  sustained: boolean,
  extra: Partial<Reaction> = {},
): Reaction => ({ name, priority, sfx, clip, sustained, ...extra });

/** Fenn's new reactions, field by field (duck plan §4.6). */
const EXPECTED: Record<string, Reaction> = {
  quack: x('quack', 'quack', 2, 'quack', false, { haptic: TAP_HAPTIC }),
  bigQuack: x('bigQuack', 'bigQuack', 4, 'bigQuack', false, {
    gentleClip: 'bigQuackGentle',
    haptic: TAP_HAPTIC,
  }),
  beakNibble: x('beakNibble', 'beakNibble', 3, 'nibble', true, { sfxLoopMs: 600 }),
  petTrill: x('petTrill', 'pet', 3, 'trill', true, {
    haptic: PURR_HAPTIC,
    mood: { joy: 0.2 },
    sfxLoopMs: 1200,
  }),
  fluffRuffle: x('fluffRuffle', 'fluffRuffle', 3, 'hmph', true, { mood: { annoy: 0.2 } }),
  blinkPeepL: x('blinkPeepL', 'hardBlinkL', 2, 'peep', false, { haptic: TAP_HAPTIC, mood: { annoy: 0.2 } }),
  blinkPeepR: x('blinkPeepR', 'hardBlinkR', 2, 'peep', false, { haptic: TAP_HAPTIC, mood: { annoy: 0.2 } }),
  wingFlapL: x('wingFlapL', 'wingFlapL', 2, 'flap', false, { haptic: TAP_HAPTIC }),
  wingFlapR: x('wingFlapR', 'wingFlapR', 2, 'flap', false, { haptic: TAP_HAPTIC }),
  wingHighFiveL: x('wingHighFiveL', 'highFiveL', 3, null, true, { sfxOnRelease: 'peep' }),
  wingHighFiveR: x('wingHighFiveR', 'highFiveR', 3, null, true, { sfxOnRelease: 'peep' }),
  bellyRubTrill: x('bellyRubTrill', 'bellyRub', 3, 'trill', true),
  footPatL: x('footPatL', 'footPullL', 2, 'pat', false, { haptic: TAP_HAPTIC }),
  footPatR: x('footPatR', 'footPullR', 2, 'pat', false, { haptic: TAP_HAPTIC }),
  tailWiggle: x('tailWiggle', 'tailWiggle', 2, 'rustle', false, { haptic: TAP_HAPTIC }),
};

/** A cell: Fenn's new reaction `name`, or Juni's frozen entry `name` reused as is. */
interface Cell {
  name: string;
  juni?: true;
}
const fenn = (name: string): Cell => ({ name });
const juni = (name: string): Cell => ({ name, juni: true });

/** Duck plan §4.6's table by column: region → reaction. Unlisted cells are `null`. */
type Column = 'tap' | 'longPress' | 'stroke' | 'tickle' | 'flick';
const CELLS: Record<Column, Partial<Record<RegionId, Cell>>> = {
  tap: {
    beak: fenn('quack'),
    headTop: juni('tuftBoing'),
    eyeL: fenn('blinkPeepL'),
    eyeR: fenn('blinkPeepR'),
    cheekL: juni('cheekPuffL'),
    cheekR: juni('cheekPuffR'),
    wingL: fenn('wingFlapL'),
    wingR: fenn('wingFlapR'),
    belly: juni('bellyBoing'),
    footL: fenn('footPatL'),
    footR: fenn('footPatR'),
    tail: fenn('tailWiggle'),
  },
  longPress: {
    beak: fenn('beakNibble'),
    headTop: juni('headPress'),
    wingL: fenn('wingHighFiveL'),
    wingR: fenn('wingHighFiveR'),
    belly: fenn('bellyRubTrill'),
  },
  stroke: {
    headTop: fenn('petTrill'),
    cheekL: juni('blush'),
    cheekR: juni('blush'),
    belly: fenn('petTrill'),
  },
  tickle: { belly: juni('giggle'), footL: juni('kickGiggle'), footR: juni('kickGiggle') },
  flick: { headTop: juni('wobble') },
};

/** The frozen entry a cell names. */
function entryOf(c: Cell): Reaction | undefined {
  return c.juni ? REACTIONS[c.name] : (FENN_REACTIONS as Record<string, Reaction>)[c.name];
}

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

/** Every gesture the probes cover: each column on each region, every pinch pair, hug, allOver and cancel. */
const ALL_GESTURES: readonly Gesture[] = [
  ...COLUMNS.flatMap((col) => REGION_IDS.flatMap((r) => probes[col](r))),
  ...REGION_IDS.flatMap((a) => REGION_IDS.map((b) => pinch(a, b))),
  { g: 'hug' },
  { g: 'allOver' },
  { g: 'cancel' },
];

const nameOf = (g: Gesture): string | null => fennReactionFor(g)?.name ?? null;

/** A pointer sample at one point (a poke on the beak in the recogniser trace). */
const poke = (id: number, t: number, type: PointerSample['type']): PointerSample => ({
  id,
  t,
  x: 500,
  y: 500,
  type,
});

// ---- FENN_REACTIONS ---------------------------------------------------------------------------------------------

describe('FENN_REACTIONS', () => {
  it('holds exactly the new reactions of duck plan §4.6, field by field', () => {
    expect(FENN_REACTIONS).toStrictEqual(EXPECTED);
  });

  it('keys every reaction by its name, and no name collides with one of Juni’s', () => {
    for (const [key, r] of Object.entries(FENN_REACTIONS)) {
      expect(r.name).toBe(key);
      expect(Object.keys(REACTIONS), key).not.toContain(key);
    }
  });

  it('is frozen through and through (fennReactionFor hands out shared entries)', () => {
    expect(Object.isFrozen(FENN_REACTIONS)).toBe(true);
    for (const r of Object.values(FENN_REACTIONS)) {
      expect(Object.isFrozen(r), r.name).toBe(true);
      for (const part of [r.escalation, r.haptic, r.mood]) {
        if (part !== undefined) expect(Object.isFrozen(part), r.name).toBe(true);
      }
    }
  });

  it('Fenn’s cast holds Juni’s reactions plus Fenn’s, the very same entries', () => {
    expect(FENN.cast.reactions).toStrictEqual({ ...REACTIONS, ...FENN_REACTIONS });
    for (const [name, r] of Object.entries({ ...REACTIONS, ...FENN_REACTIONS }))
      expect(FENN.cast.reactions[name], name).toBe(r);
  });

  it('every reaction Fenn can play names a clip in FENN.cast.clips, and only sfx that exist in SYNTHS', () => {
    const reachable = new Set<Reaction>();
    for (const g of ALL_GESTURES) {
      const r = fennReactionFor(g);
      if (r !== null) reachable.add(r);
    }
    for (const r of reachable) {
      const to = r.escalation === undefined ? undefined : FENN.cast.reactions[r.escalation.to];
      if (to !== undefined) reachable.add(to);
    }
    for (const r of Object.values(FENN_REACTIONS)) expect(reachable, r.name).toContain(r);
    const synths = Object.keys(SYNTHS);
    for (const r of reachable) {
      expect(FENN.cast.clips.has(r.clip), `${r.name}: clip ${r.clip}`).toBe(true);
      if (r.gentleClip !== undefined)
        expect(FENN.cast.clips.has(r.gentleClip), `${r.name}: ${r.gentleClip}`).toBe(true);
      if (r.sfx !== null) expect(synths, r.name).toContain(r.sfx);
      if (r.sfxOnRelease !== undefined) expect(synths, r.name).toContain(r.sfxOnRelease);
    }
    expect([...reachable].map((r) => r.name)).toEqual(expect.arrayContaining(['dizzy', 'laughFit']));
  });

  it('plays every Fenn clip: each base clip from a reaction, bigQuackGentle as bigQuack’s gentle clip', () => {
    const played = new Set(Object.values(FENN_REACTIONS).flatMap((r) => [r.clip, r.gentleClip ?? r.clip]));
    for (const name of Object.keys(FENN_CLIPS)) expect(played, name).toContain(name);
  });

  it('marks every reaction whose clip holds its pose, or that has release or loop sound, as sustained', () => {
    for (const r of Object.values(FENN_REACTIONS)) {
      if (FENN.cast.clips.get(r.clip)?.sustained === true) expect(r.sustained, r.name).toBe(true);
      if (r.sfxOnRelease !== undefined || r.sfxLoopMs !== undefined) expect(r.sustained, r.name).toBe(true);
    }
  });

  it('content guard (plan Q3): no name, clip or gentle clip contains cry, hurt, pain, scared or fear', () => {
    for (const [key, r] of Object.entries(FENN_REACTIONS)) {
      for (const name of [key, r.name, r.clip, r.gentleClip ?? '', r.sfx ?? '', r.sfxOnRelease ?? ''])
        expect(name.toLowerCase(), name).not.toMatch(/cry|hurt|pain|scared|fear/);
    }
  });
});

// ---- fennReactionFor ----------------------------------------------------------------------------------------------

describe('fennReactionFor', () => {
  describe('every cell of the table maps as specified', () => {
    const cells = COLUMNS.flatMap((col) =>
      REGION_IDS.flatMap((region) => {
        const cell = CELLS[col][region];
        return cell === undefined
          ? []
          : [{ col, region, cell, label: `${cell.juni ? 'Juni’s ' : ''}${cell.name}` }];
      }),
    );
    it.each(cells)('$col on $region → $label', ({ col, region, cell }) => {
      const r = fennReactionFor(trigger[col](region));
      expect(r).not.toBeNull();
      expect(r).toBe(entryOf(cell));
      if (cell.juni) expect(r).toBe(REACTIONS[cell.name]);
      else expect(r).toStrictEqual(EXPECTED[cell.name]);
    });

    it('beak tap: count 1–2 → quack (P2); count ≥ 3 → bigQuack (P4), a count rule like bigSneeze', () => {
      expect(nameOf(tap('beak', 1))).toBe('quack');
      expect(nameOf(tap('beak', 2))).toBe('quack');
      for (const n of [3, 4, 9]) {
        expect(fennReactionFor(tap('beak', n))).toBe(FENN_REACTIONS.bigQuack);
        expect(fennReactionFor(tap('beak', n))).toStrictEqual(EXPECTED['bigQuack']);
      }
      expect(FENN_REACTIONS.quack.escalation).toBeUndefined();
    });

    it('a multi-poke count changes no other region’s tap', () => {
      for (const region of REGION_IDS) {
        const cell = CELLS.tap[region];
        if (cell !== undefined && region !== 'beak') expect(nameOf(tap(region, 3))).toBe(cell.name);
      }
    });

    it('headTop: a stroke against the down → fluffRuffle, gated on an update at ≥ 120 px', () => {
      expect(fennReactionFor(stroke('headTop', 'update', 120, true))).toStrictEqual(EXPECTED['fluffRuffle']);
      expect(nameOf(stroke('headTop', 'update', 500, true))).toBe('fluffRuffle');
      expect(nameOf(stroke('headTop', 'update', 119, true))).toBeNull();
      expect(nameOf(stroke('headTop', 'start', 300, true))).toBeNull();
      expect(nameOf(stroke('headTop', 'end', 300, true))).toBeNull();
    });

    it('petTrill (headTop and belly) only on an update at pathPx ≥ 120, never on start or end', () => {
      for (const region of ['headTop', 'belly'] as const) {
        expect(nameOf(stroke(region, 'update', 119))).toBeNull();
        expect(nameOf(stroke(region, 'update', 120))).toBe('petTrill');
        expect(nameOf(stroke(region, 'update', 1000))).toBe('petTrill');
        expect(nameOf(stroke(region, 'start', 20))).toBeNull();
        expect(nameOf(stroke(region, 'start', 300))).toBeNull();
        expect(nameOf(stroke(region, 'end', 300))).toBeNull();
      }
      expect(nameOf(stroke('belly', 'update', 120, true))).toBe('petTrill');
    });

    it('cheek strokes → Juni’s blush from their start and on every update, at any length', () => {
      for (const region of ['cheekL', 'cheekR'] as const) {
        for (const pathPx of [11, 60, 119, 120, 400]) {
          expect(fennReactionFor(stroke(region, 'start', pathPx))).toBe(REACTIONS['blush']);
          expect(fennReactionFor(stroke(region, 'update', pathPx))).toBe(REACTIONS['blush']);
        }
        expect(nameOf(stroke(region, 'end', 400))).toBeNull();
      }
    });

    it('pinch on the cheeks (either order) → Juni’s squish; hug → hug; any 3 pointers → giggle', () => {
      expect(fennReactionFor(pinch('cheekL', 'cheekR'))).toBe(REACTIONS['squish']);
      expect(fennReactionFor(pinch('cheekR', 'cheekL'))).toBe(REACTIONS['squish']);
      expect(fennReactionFor({ g: 'hug' })).toBe(REACTIONS['hug']);
      expect(fennReactionFor({ g: 'allOver' })).toBe(REACTIONS['giggle']);
    });

    it('Juni’s escalations come along: the head flick escalates to dizzy, the belly tickle to laughFit', () => {
      expect(fennReactionFor(flick('headTop'))?.escalation?.to).toBe('dizzy');
      expect(fennReactionFor(tickle('belly'))?.escalation?.to).toBe('laughFit');
    });
  });

  it('cancel → null', () => {
    expect(fennReactionFor({ g: 'cancel' })).toBeNull();
  });

  it('tap up, longPress end and stroke end → null on every region', () => {
    for (const region of REGION_IDS) {
      for (const n of [1, 2, 3, 4]) expect(fennReactionFor(tap(region, n, 'up')), region).toBeNull();
      expect(fennReactionFor(longPress(region, 'end')), region).toBeNull();
      expect(fennReactionFor(stroke(region, 'end', 300)), region).toBeNull();
      expect(fennReactionFor(stroke(region, 'end', 300, true)), region).toBeNull();
    }
  });

  it('every other (region × gesture kind) pair → null over the full product (Juni-only regions included)', () => {
    let checked = 0;
    for (const col of COLUMNS) {
      for (const region of REGION_IDS) {
        if (CELLS[col][region] !== undefined) continue;
        for (const g of probes[col](region)) {
          expect(fennReactionFor(g), `${col} on ${region}`).toBeNull();
          checked++;
        }
      }
    }
    for (const a of REGION_IDS) {
      for (const b of REGION_IDS) {
        const cheeks = (a === 'cheekL' && b === 'cheekR') || (a === 'cheekR' && b === 'cheekL');
        if (!cheeks) expect(fennReactionFor(pinch(a, b)), `pinch ${a}+${b}`).toBeNull();
      }
    }
    // Juni's regions that Fenn doesn't have never react, whatever the gesture.
    for (const region of [
      'nose',
      'earL',
      'earR',
      'neckerchief',
      'pawL',
      'pawR',
      'background',
      'flankL',
      'flankR',
    ] as const)
      for (const col of COLUMNS)
        for (const g of probes[col](region)) expect(fennReactionFor(g), region).toBeNull();
    expect(checked).toBeGreaterThan(0);
  });

  it('only the listed cells react: the reacting (column, region) pairs are exactly the table’s', () => {
    const reacting = COLUMNS.flatMap((col) =>
      REGION_IDS.filter((r) => probes[col](r).some((g) => fennReactionFor(g) !== null)).map(
        (r) => `${col}:${r}`,
      ),
    );
    const listed = COLUMNS.flatMap((col) => Object.keys(CELLS[col]).map((r) => `${col}:${r}`));
    expect(reacting.toSorted()).toEqual(listed.toSorted());
  });

  it('is pure: the same gesture gives the same shared entry, and the gesture is not touched', () => {
    const g = Object.freeze(tap('beak', 3));
    const a = fennReactionFor(g);
    expect(fennReactionFor(g)).toBe(a);
    expect(a).toBe(FENN_REACTIONS.bigQuack);
    expect(FENN.reactionFor).toBe(fennReactionFor);
  });

  it('on a recogniser trace: three quick pokes on the beak quack, quack, then big-quack', () => {
    let s = initialRecState();
    const gestures: Gesture[] = [];
    for (const smp of [0, 150, 300].flatMap((t, i) => [poke(i + 1, t, 'down'), poke(i + 1, t + 60, 'up')])) {
      const [next, out] = recognize(s, smp, () => 'beak');
      s = next;
      gestures.push(...out);
    }
    const names = gestures.map(fennReactionFor).flatMap((r) => (r === null ? [] : [r.name]));
    expect(names).toEqual(['quack', 'quack', 'bigQuack']);
  });
});
