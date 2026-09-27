/**
 * The hit-region ids (plan §4.6.4). The recogniser (#86) reports gestures by region, and the bone-attached
 * geometry in `regions.ts` (#85) hit-tests to one of these; anything outside every region is `background`.
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
  'background',
] as const;
export type RegionId = (typeof REGION_IDS)[number];
