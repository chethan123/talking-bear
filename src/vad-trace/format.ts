// Real-voice feature traces, schema version 1 (plan §7 M2 "Real-voice feature traces", Q2). `lab/vad-trace`
// records them on D1, they are committed under test/traces/<session>/, and scripts/vad-eval.ts replays them
// offline. A trace holds per-frame scalars only, never audio:
//
//   trace.json  TraceMeta, pretty-printed with 2 spaces (plus a final newline);
//   trace.bin   little-endian IEEE-754 binary32, no header, four consecutive streams:
//               rawDb[n10] (dBFS of the unfiltered 16 kHz hop), bandDb[n10] (dBFS after createGateFilter),
//               voicing[n10], sileroP[n32].
//
// Hop i starts at ctx frame firstFrame + round(i · ctxRate · 0.01), and Silero frame j at
// firstFrame + round(j · 512 · ctxRate / 16000) (hopStartFrame, sileroStartFrame).
//
// The streams are copied bit for bit through Uint32 views and DataView's little-endian integer accessors, so
// every value, NaN payloads and −0 included, survives a round trip on any host byte order.
//
// DOM-free at runtime (crypto.subtle and TextEncoder are globals in Node, workers and pages), so Node
// scripts, the worker and the page can all import it. Relative imports end in `.ts` and the syntax is
// erasable (CLAUDE.md rule 11).

import { FRONT_END_CONFIG, type FrontEndConfig } from './config.ts';

export interface TraceMeta {
  version: 1;
  device: string;
  chrome: string;
  ctxRate: number;
  constraints: MediaTrackConstraints;
  sileroWeightsSha256: string;
  frontEndHash: string;
  session: 'A' | 'B' | 'other';
  condition: 'quiet' | 'fan' | 'tv' | 'music';
  placement: 'arm' | 'table' | 'none';
  speaker: 'adult' | 'child';
  scriptId: string;
  /** ISO 8601. */
  startedAt: string;
  /** Ctx frame of hop 0 and of Silero frame 0. */
  firstFrame: number;
  /** Count of 10 ms hops. */
  n10: number;
  /** Count of 32 ms Silero frames. */
  n32: number;
  /** Hold-to-talk marks, in ctx frames. */
  labels: Array<{ press: number; release: number }>;
  notes?: string;
}

export interface TraceStreams {
  rawDb: Float32Array;
  bandDb: Float32Array;
  voicing: Float32Array;
  sileroP: Float32Array;
}

/** The schema version encodeTrace writes and the only one decodeTrace accepts. */
export const TRACE_VERSION = 1;

/** Bytes per stored value (binary32). */
const BYTES = 4;
/** Silero frame length in 16 kHz samples (the format's fixed 32 ms frame). */
const SILERO_FRAME = 512;
const SILERO_RATE = 16000;

// Allowed values of the TraceMeta unions. Typed as records over the unions, so they can't drift from them.
const SESSIONS: Readonly<Record<TraceMeta['session'], true>> = { A: true, B: true, other: true };
const CONDITIONS: Readonly<Record<TraceMeta['condition'], true>> = {
  quiet: true,
  fan: true,
  tv: true,
  music: true,
};
const PLACEMENTS: Readonly<Record<TraceMeta['placement'], true>> = { arm: true, table: true, none: true };
const SPEAKERS: Readonly<Record<TraceMeta['speaker'], true>> = { adult: true, child: true };
const STRING_FIELDS = [
  'device',
  'chrome',
  'sileroWeightsSha256',
  'frontEndHash',
  'scriptId',
  'startedAt',
] as const;
const COUNT_FIELDS = ['firstFrame', 'n10', 'n32'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A ctx frame or a count: a non-negative safe integer. */
function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isOneOf(v: unknown, allowed: Readonly<Record<string, true>>): boolean {
  return typeof v === 'string' && Object.hasOwn(allowed, v);
}

function invalid(what: string): never {
  throw new TypeError(`invalid trace meta: ${what}`);
}

/** Checks the shape of a TraceMeta (unknown extra fields are allowed); throws TypeError naming the bad field. */
function assertMeta(v: unknown): asserts v is TraceMeta {
  if (!isRecord(v)) invalid('not an object');
  if (v.version !== TRACE_VERSION) invalid(`unsupported version ${JSON.stringify(v.version)}`);
  for (const k of STRING_FIELDS) if (typeof v[k] !== 'string') invalid(`${k} must be a string`);
  if (!(typeof v.ctxRate === 'number' && Number.isFinite(v.ctxRate) && v.ctxRate > 0)) {
    invalid('ctxRate must be a finite number > 0');
  }
  if (!isRecord(v.constraints)) invalid('constraints must be an object');
  if (!isOneOf(v.session, SESSIONS)) invalid(`session ${JSON.stringify(v.session)}`);
  if (!isOneOf(v.condition, CONDITIONS)) invalid(`condition ${JSON.stringify(v.condition)}`);
  if (!isOneOf(v.placement, PLACEMENTS)) invalid(`placement ${JSON.stringify(v.placement)}`);
  if (!isOneOf(v.speaker, SPEAKERS)) invalid(`speaker ${JSON.stringify(v.speaker)}`);
  for (const k of COUNT_FIELDS) if (!isIndex(v[k])) invalid(`${k} must be a non-negative safe integer`);
  const labels = v.labels;
  if (!Array.isArray(labels)) invalid('labels must be an array');
  for (let i = 0; i < labels.length; i++) {
    const l: unknown = labels[i];
    if (!(isRecord(l) && isIndex(l.press) && isIndex(l.release))) {
      invalid(`labels[${i}] must be {press, release} with non-negative safe integer frames`);
    }
  }
  if (v.notes !== undefined && typeof v.notes !== 'string') invalid('notes must be a string when present');
}

/** Byte length of trace.bin for these counts. */
function binBytes(n10: number, n32: number): number {
  return BYTES * (3 * n10 + n32);
}

/** Writes x's bit patterns little-endian at byte offset off; returns the offset after them. */
function writeLE(view: DataView, off: number, x: Float32Array): number {
  const bits = new Uint32Array(x.buffer, x.byteOffset, x.length);
  for (let i = 0; i < bits.length; i++) view.setUint32(off + BYTES * i, bits[i]!, true);
  return off + BYTES * bits.length;
}

/** Reads n little-endian binary32 bit patterns from byte offset off into a new Float32Array. */
function readLE(view: DataView, off: number, n: number): Float32Array {
  const out = new Float32Array(n);
  const bits = new Uint32Array(out.buffer);
  for (let i = 0; i < n; i++) bits[i] = view.getUint32(off + BYTES * i, true);
  return out;
}

/**
 * Serialises a trace. Throws TypeError when meta is not a valid TraceMeta, and RangeError unless rawDb,
 * bandDb and voicing hold meta.n10 values and sileroP holds meta.n32, so its output always decodes.
 */
export function encodeTrace(
  meta: TraceMeta,
  s: TraceStreams,
): { json: string; bin: Uint8Array<ArrayBuffer> } {
  assertMeta(meta);
  const { n10, n32 } = meta;
  const lengths: Array<[string, number, number]> = [
    ['rawDb', s.rawDb.length, n10],
    ['bandDb', s.bandDb.length, n10],
    ['voicing', s.voicing.length, n10],
    ['sileroP', s.sileroP.length, n32],
  ];
  for (const [name, got, want] of lengths) {
    if (got !== want) throw new RangeError(`${name} holds ${got} values; the meta says ${want}`);
  }
  const bin = new Uint8Array(binBytes(n10, n32));
  const view = new DataView(bin.buffer);
  let off = 0;
  off = writeLE(view, off, s.rawDb);
  off = writeLE(view, off, s.bandDb);
  off = writeLE(view, off, s.voicing);
  writeLE(view, off, s.sileroP);
  return { json: `${JSON.stringify(meta, null, 2)}\n`, bin };
}

/**
 * Parses a trace. Throws SyntaxError on malformed JSON, TypeError on an invalid or unsupported meta, and
 * RangeError when bin is not exactly 4 · (3 · n10 + n32) bytes. The streams are new arrays (bin is not
 * aliased); bin may start at any byte offset.
 */
export function decodeTrace(json: string, bin: Uint8Array): { meta: TraceMeta; streams: TraceStreams } {
  const meta: unknown = JSON.parse(json);
  assertMeta(meta);
  const { n10, n32 } = meta;
  const want = binBytes(n10, n32);
  if (bin.byteLength !== want) {
    throw new RangeError(
      `trace.bin holds ${bin.byteLength} bytes; n10 = ${n10} and n32 = ${n32} need ${want}`,
    );
  }
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const rawDb = readLE(view, 0, n10);
  const bandDb = readLE(view, BYTES * n10, n10);
  const voicing = readLE(view, BYTES * 2 * n10, n10);
  const sileroP = readLE(view, BYTES * 3 * n10, n32);
  return { meta, streams: { rawDb, bandDb, voicing, sileroP } };
}

/**
 * Ctx frame at which hop i starts: firstFrame + round(i · ctxRate · 0.01). Computed as i · ctxRate / 100, so
 * an integer rate never picks up the rounding error of 0.01.
 */
export function hopStartFrame(meta: Pick<TraceMeta, 'firstFrame' | 'ctxRate'>, i: number): number {
  return meta.firstFrame + Math.round((i * meta.ctxRate) / 100);
}

/** Ctx frame at which Silero frame j starts: firstFrame + round(j · 512 · ctxRate / 16000). */
export function sileroStartFrame(meta: Pick<TraceMeta, 'firstFrame' | 'ctxRate'>, j: number): number {
  return meta.firstFrame + Math.round((j * SILERO_FRAME * meta.ctxRate) / SILERO_RATE);
}

/**
 * Canonical JSON: no whitespace, object keys sorted (by UTF-16 code units) at every depth, array order kept.
 * Accepts only null, booleans, finite numbers, strings, arrays and plain objects; anything else (undefined,
 * NaN, ±Infinity, functions, bigints, symbols, class instances, array holes) throws TypeError, so no two
 * different values can serialise alike. (−0 serialises as 0, like JSON.stringify.)
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: non-finite number ${v}`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    const items: readonly unknown[] = v;
    return `[${Array.from(items, (x) => canonicalJson(x)).join(',')}]`;
  }
  if (isRecord(v)) {
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('canonicalJson: only plain objects and arrays are allowed');
    }
    const keys = Object.keys(v).toSorted();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof v}`);
}

/** Lower-case hex SHA-256 (crypto.subtle) of the UTF-8 canonical JSON of cfg. */
export async function frontEndHash(cfg: FrontEndConfig = FRONT_END_CONFIG): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(cfg)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Why a trace no longer matches the build: 'frontEnd' when its front-end hash differs from currentHash
 * (checked first), else 'weights' when its Silero weights hash differs from currentWeightsSha, else null.
 */
export function staleness(
  meta: TraceMeta,
  currentHash: string,
  currentWeightsSha: string,
): null | { reason: 'frontEnd' | 'weights' } {
  if (meta.frontEndHash !== currentHash) return { reason: 'frontEnd' };
  if (meta.sileroWeightsSha256 !== currentWeightsSha) return { reason: 'weights' };
  return null;
}
