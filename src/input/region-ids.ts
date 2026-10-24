/**
 * The hit-region ids (plan §4.6.4), over every character: each character's `spec.regions` uses a subset (Juni has
 * no `beak`, `wingL`, `wingR` or `tail`; Fenn has no `nose`, ears, neckerchief or paws: duck plan §4.5). The
 * recogniser (#86) reports gestures by region, and the bone-attached geometry in `regions.ts` (#85) hit-tests to
 * one of these; anything outside every region is `background`.
 */
export const REGION_IDS = [
  'eyeL',
  'eyeR',
  'nose',
  'earL',
  'earR',
  'cheekL',
  'cheekR',
  'neckerchief',
  'pawL',
  'pawR',
  'footL',
  'footR',
  'belly',
  'headTop',
  'flankL',
  'flankR',
  'beak',
  'wingL',
  'wingR',
  'tail',
  'background',
] as const;
export type RegionId = (typeof REGION_IDS)[number];
