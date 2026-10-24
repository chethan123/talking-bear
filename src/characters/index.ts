/** The characters (duck plan §4.1), by id. */
import { FENN } from './fenn.ts';
import { JUNI } from './juni.ts';
import type { CharacterId, CharacterSpec } from './types.ts';

export const CHARACTERS: Readonly<Record<CharacterId, CharacterSpec>> = { juni: JUNI, fenn: FENN };

export { FENN } from './fenn.ts';
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
