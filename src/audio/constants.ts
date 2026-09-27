// Shared audio constants (plan §3.1, §4.2.3). No imports and only erasable syntax, so Node scripts can
// import this file with type stripping (CLAUDE.md rule 11).

export const VAD_RATE = 16000; // Hz
export const VAD_FRAME = 512; // samples at VAD_RATE (32 ms)
export const ENERGY_HOP = 160; // samples at VAD_RATE (10 ms)
export const RING_SECONDS = 12;
export const CHUNK_MAX = 48000; // max samples per clipChunk message
export const PREROLL_MS = 300;
export const TAIL_MS = 150;
export const ONSET_BLOCK_MS = 100; // worker ignores onsets this long after arm
export const MAX_UTTERANCE_MS = 10000;
export const HPF_CLIP_HZ = 80;
