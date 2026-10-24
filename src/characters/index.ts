/** The characters (duck plan §4.1), by id. */
import { JUNI } from './juni.ts';
import type { CharacterId, CharacterSpec } from './types.ts';

export const CHARACTERS: Readonly<Record<CharacterId, CharacterSpec>> = { juni: JUNI };

export { JUNI } from './juni.ts';
export type {
  CharacterArt,
  CharacterId,
  CharacterNames,
  CharacterSpec,
  Drive,
  MouthSpec,
  StarsSpec,
  Term,
} from './types.ts';
