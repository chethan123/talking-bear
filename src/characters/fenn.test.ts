/**
 * Fenn's spec (duck plan §4.4, §4.5; T123 acceptance 2–5): the drives and regions name bones of `art/duck.svg`, the
 * neutral pose is the rest pose, every region's centre hits that region at the app's view scales, and the pet regions
 * are at least Juni's size.
 */
import { describe, expect, it } from 'vitest';
import { Ch, CH_COUNT, createPose } from '../anim/pose.ts';
import { boneIndex, boneMatrices, createRig, MAT } from '../anim/rig.ts';
import { BONE, BONES } from '../art/duck-parts.gen.ts';
import { REGION_IDS } from '../input/region-ids.ts';
import { compileRegions, hitTest } from '../input/regions.ts';
import { FENN } from './fenn.ts';
import { CHARACTERS } from './index.ts';
import { JUNI } from './juni.ts';

const rig = createRig(FENN, { paths: false });
const table = compileRegions(rig);
const neutral = boneMatrices(rig, createPose(), new Float32Array(rig.boneCount * MAT));

describe('FENN', () => {
  it('is listed in CHARACTERS under its id, with its names, colours and constants', () => {
    expect(CHARACTERS.fenn).toBe(FENN);
    expect(CHARACTERS.juni).toBe(JUNI);
    expect(FENN.id).toBe('fenn');
    expect(FENN.names).toEqual({
      name: 'Fenn',
      stage: 'Fenn the duckling',
      switchTo: 'Switch to Fenn the duckling',
    });
    expect(FENN.background).toEqual({ top: '#E9F5F0', bottom: '#C9E6DC' });
    expect(FENN.eyesCenter).toEqual({ x: 500, y: 380 });
    expect(FENN.mouth).toEqual({ kind: 'parts' });
    expect(FENN.stars).toEqual({
      bone: 'head',
      cx: 500,
      cy: 400,
      radius: 330,
      count: 3,
      outer: 26,
      inner: 11,
      fill: '#E2B33C',
    });
    expect(FENN.art.BONES).toBe(BONES);
  });

  it('has a parts mouth: no mouth slot and no mouth bone in the rig', () => {
    expect(rig.mouthSlot).toBe(-1);
    expect(rig.jaw).toBe(-1);
    expect(rig.head).toBe(BONE['head']);
  });

  it("drives the bones of duck plan §4.4's table; MouthRound and Teeth drive nothing", () => {
    expect(FENN.drives).toEqual({
      head: {
        rot: [Ch.HeadRot, 1],
        tx: [Ch.HeadX, 1],
        ty: [Ch.HeadY, 1],
        sx: [Ch.HeadSquishX, 1],
        sy: [Ch.HeadSquishY, 1],
      },
      neck: { rot: [Ch.HeadTilt, 1] },
      fluffL: { rot: [Ch.EarRotL, 1], sy: [Ch.EarFoldL, -0.5] },
      fluffR: { rot: [Ch.EarRotR, 1], sy: [Ch.EarFoldR, -0.5] },
      tuft: { rot: [Ch.TuftRot, 1] },
      body: { rot: [Ch.BodyLean, 1], sx: [Ch.BodySquash, -0.5], sy: [Ch.BodySquash, 1] },
      belly: { sx: [Ch.BellyJiggle, 1], sy: [Ch.BellyJiggle, 1] },
      wingL: { rot: [Ch.ArmRotL, 1] },
      wingR: { rot: [Ch.ArmRotR, 1] },
      footL: { tx: [Ch.FootL, -30] },
      footR: { tx: [Ch.FootR, 30] },
      tailA: { rot: [Ch.KerchiefA, 1] },
      tailB: { rot: [Ch.KerchiefB, 1] },
      bill: { ty: [Ch.NoseY, 1], sy: [Ch.NoseWrinkle, -0.1] },
      jaw: { ty: [Ch.Jaw, 60], sx: [Ch.MouthW, 0.12] },
      cheekBlushL: { sx: [Ch.CheekPuff, 1], sy: [Ch.CheekPuff, 1] },
      cheekBlushR: { sx: [Ch.CheekPuff, 1], sy: [Ch.CheekPuff, 1] },
      browL: { ty: [Ch.BrowL, -1] },
      browR: { ty: [Ch.BrowR, -1] },
    });
    for (const ch of [Ch.MouthRound, Ch.Teeth]) {
      expect(Array.from(rig.driveCh).includes(ch), `channel ${ch}`).toBe(false);
    }
  });

  // Acceptance 2.
  it('names only bones of its art in its drives and its regions, and only parts of its art', () => {
    const bones = new Set(BONES.map((b) => b.id));
    for (const id of Object.keys(FENN.drives)) expect(bones.has(id), `drive bone ${id}`).toBe(true);
    for (const r of FENN.regions) expect(bones.has(r.bone), `region bone ${r.bone} (${r.id})`).toBe(true);
    for (const id of [...FENN.gazeParts, FENN.lidParts.L, FENN.lidParts.R, ...FENN.blushParts]) {
      expect(FENN.art.PART[id], `part ${id}`).toBeDefined();
    }
    expect(bones.has(FENN.stars.bone)).toBe(true);
  });

  // Acceptance 3.
  it('gives the identity for every bone at the neutral pose (the rest pose is the design)', () => {
    expect(rig.boneCount).toBe(BONES.length);
    for (let i = 0; i < rig.boneCount; i++) {
      expect(
        Array.from(neutral.subarray(i * MAT, i * MAT + MAT), (v) => v + 0),
        BONES[i]!.id,
      ).toEqual([1, 0, 0, 1, 0, 0]);
    }
    expect(createPose()).toHaveLength(CH_COUNT);
  });

  it("holds duck plan §4.5's 15 regions in priority order, frozen", () => {
    expect(FENN.regions.map((r) => [r.id, r.bone, r.cx, r.cy, r.rx, r.ry])).toEqual([
      ['eyeL', 'head', 400, 380, 50, 56],
      ['eyeR', 'head', 600, 380, 50, 56],
      ['beak', 'bill', 500, 528, 120, 65],
      ['cheekL', 'head', 330, 470, 65, 50],
      ['cheekR', 'head', 670, 470, 65, 50],
      ['wingL', 'wingL', 255, 860, 70, 140],
      ['wingR', 'wingR', 745, 860, 70, 140],
      ['footL', 'footL', 370, 1275, 120, 70],
      ['footR', 'footR', 630, 1275, 120, 70],
      ['tail', 'tailA', 815, 1015, 55, 55],
      ['belly', 'belly', 500, 960, 200, 220],
      ['headTop', 'head', 500, 400, 290, 250],
      ['headTop', 'tuft', 520, 115, 70, 60],
      ['flankL', 'body', 275, 1115, 80, 135],
      ['flankR', 'body', 725, 1115, 80, 135],
    ]);
    expect(Object.isFrozen(FENN.regions)).toBe(true);
    for (const r of FENN.regions) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(REGION_IDS).toContain(r.id);
      expect(() => boneIndex(rig, r.bone)).not.toThrow();
    }
  });

  // Acceptance 4.
  for (const scale of [0.5, 0.38]) {
    it.each(FENN.regions.map((r, i) => [`${r.id}@${r.bone}`, i] as const))(
      `neutral pose, view scale ${scale}, padCssPx 12: the centre of %s hits that region`,
      (_name, i) => {
        const r = FENN.regions[i]!;
        const view = { scale, ox: 0, oy: 0 };
        expect(hitTest(scale * r.cx, scale * r.cy, neutral, view, table, 12)).toBe(r.id);
      },
    );
  }

  // Acceptance 5.
  it("makes headTop and belly at least Juni's size, so a pet stroke covers at least Juni's path lengths", () => {
    for (const id of ['headTop', 'belly'] as const) {
      const fenn = FENN.regions.find((r) => r.id === id)!;
      const juni = JUNI.regions.find((r) => r.id === id)!;
      expect(fenn.rx, `${id} rx`).toBeGreaterThanOrEqual(juni.rx);
      expect(fenn.ry, `${id} ry`).toBeGreaterThanOrEqual(juni.ry);
    }
  });

  it('is a placeholder cast until T125: no gesture reacts', () => {
    expect(FENN.reactionFor({ g: 'cancel' })).toBeNull();
    expect(FENN.reactionFor({ g: 'hug' })).toBeNull();
    expect(FENN.cast.clips.size).toBeGreaterThan(0);
  });
});
