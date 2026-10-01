import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../test/dsp-helpers.ts';
import { ENERGY_HOP, HPF_CLIP_HZ, VAD_FRAME, VAD_RATE } from '../audio/constants.ts';
import { CONSTRAINTS } from '../audio/mic.ts';
import { butterworthHighpass, butterworthLowpass, cascade } from '../dsp/biquad.ts';
import { GATE_HPF_HZ, GATE_LPF_HZ, createGateFilter } from '../dsp/energy-gate.ts';
import { CUTOFF_FACTOR, DEFAULT_BETA, DEFAULT_ZERO_CROSSINGS, createResampler } from '../dsp/resample.ts';
import { WEIGHTS_SHA256 } from '../dsp/silero/weights.ts';
import { VOICING_FMAX_HZ, VOICING_FMIN_HZ } from '../dsp/voicing.ts';
import { FRONT_END_CONFIG } from './config.ts';
import {
  canonicalJson,
  decodeTrace,
  encodeTrace,
  frontEndHash,
  hopStartFrame,
  sileroStartFrame,
  staleness,
  type TraceMeta,
  type TraceStreams,
} from './format.ts';

/** binary32 bit patterns that a value copy could alter or that are easy to mishandle. */
const SPECIAL_BITS = [
  0x7fc00000, // quiet NaN
  0xffc00000, // negative quiet NaN
  0x7fc00001, // quiet NaN with payload 1
  0x7f800001, // signalling NaN
  0xffbfffff, // negative signalling NaN, full payload
  0x7f800000, // +Infinity
  0xff800000, // −Infinity
  0x00000000, // +0
  0x80000000, // −0
  0x00000001, // smallest subnormal
  0x807fffff, // largest negative subnormal
  0x7f7fffff, // largest finite
  0x3f800000, // 1
];

/** The bit patterns of x (a view over the same bytes). */
function bitsOf(x: Float32Array): Uint32Array {
  return new Uint32Array(x.buffer, x.byteOffset, x.length);
}

/** A Float32Array holding exactly these bit patterns (written as integers, never as floats). */
function fromBits(bits: ArrayLike<number>): Float32Array {
  const x = new Float32Array(bits.length);
  bitsOf(x).set(Array.from(bits));
  return x;
}

/** n uniformly random bit patterns; when n >= SPECIAL_BITS.length, each special appears at its own index. */
function randomBits(rng: () => number, n: number): Uint32Array {
  const bits = new Uint32Array(n);
  for (let i = 0; i < n; i++) bits[i] = Math.floor(rng() * 2 ** 32);
  if (n >= SPECIAL_BITS.length) {
    SPECIAL_BITS.forEach((b, k) => {
      bits[Math.floor((k * n) / SPECIAL_BITS.length)] = b;
    });
  }
  return bits;
}

/** n samples of seeded uniform noise in [−1, 1). */
function noise(seed: number, n: number): Float32Array {
  const rng = mulberry32(seed);
  return Float32Array.from({ length: n }, () => rng() * 2 - 1);
}

function makeMeta(over: Partial<TraceMeta> = {}): TraceMeta {
  return {
    version: 1,
    device: 'Pixel 7a',
    chrome: '141.0.7390.54',
    ctxRate: 48000,
    constraints: { ...CONSTRAINTS },
    sileroWeightsSha256: WEIGHTS_SHA256,
    frontEndHash: '0'.repeat(64),
    session: 'A',
    condition: 'fan',
    placement: 'arm',
    speaker: 'adult',
    scriptId: 'S2',
    startedAt: '2026-09-27T12:00:00.000Z',
    firstFrame: 1536,
    n10: 0,
    n32: 0,
    labels: [
      { press: 48000, release: 120000 },
      { press: 240000, release: 300001 },
    ],
    notes: 'fan on low, 1 m away',
    ...over,
  };
}

/** Streams holding exactly these bit patterns. */
function streamsOf(
  raw: ArrayLike<number>,
  band: ArrayLike<number>,
  voi: ArrayLike<number>,
  sil: ArrayLike<number>,
): TraceStreams {
  return { rawDb: fromBits(raw), bandDb: fromBits(band), voicing: fromBits(voi), sileroP: fromBits(sil) };
}

function expectSameBits(got: TraceStreams, want: TraceStreams): void {
  for (const k of ['rawDb', 'bandDb', 'voicing', 'sileroP'] as const) {
    expect(got[k]).toBeInstanceOf(Float32Array);
    expect(bitsOf(got[k])).toEqual(bitsOf(want[k]));
  }
}

describe('encodeTrace / decodeTrace round trip', () => {
  it('round-trips random streams bit-exactly (NaN payloads, −0, ±Infinity) and the meta deep-equal', () => {
    const rng = mulberry32(0x7437);
    const n10 = 1000;
    const n32 = 313;
    const s = streamsOf(
      randomBits(rng, n10),
      randomBits(rng, n10),
      randomBits(rng, n10),
      randomBits(rng, n32),
    );
    for (const x of [s.rawDb, s.bandDb, s.voicing, s.sileroP]) {
      expect(x.some((v) => Number.isNaN(v))).toBe(true);
      expect(x.includes(Number.NEGATIVE_INFINITY)).toBe(true);
    }
    const meta = makeMeta({ n10, n32 });
    const { json, bin } = encodeTrace(meta, s);
    const out = decodeTrace(json, bin);
    expectSameBits(out.streams, s);
    expect(out.meta).toStrictEqual(meta);
  });

  it('round-trips arbitrary bit patterns, lengths and metas (property)', () => {
    const traceArb = fc.record({ n10: fc.nat({ max: 48 }), n32: fc.nat({ max: 16 }) }).chain(({ n10, n32 }) =>
      fc.record({
        raw: fc.uint32Array({ minLength: n10, maxLength: n10 }),
        band: fc.uint32Array({ minLength: n10, maxLength: n10 }),
        voi: fc.uint32Array({ minLength: n10, maxLength: n10 }),
        sil: fc.uint32Array({ minLength: n32, maxLength: n32 }),
        labels: fc.array(fc.record({ press: fc.nat(), release: fc.nat() }), { maxLength: 4 }),
        notes: fc.option(fc.string(), { nil: undefined }),
        firstFrame: fc.nat(),
        ctxRate: fc.constantFrom(44100, 48000),
      }),
    );
    fc.assert(
      fc.property(traceArb, ({ raw, band, voi, sil, labels, notes, firstFrame, ctxRate }) => {
        const s = streamsOf(raw, band, voi, sil);
        const plainLabels = labels.map(({ press, release }) => ({ press, release }));
        const meta = makeMeta({ n10: raw.length, n32: sil.length, labels: plainLabels, firstFrame, ctxRate });
        if (notes === undefined) delete meta.notes;
        else meta.notes = notes;
        const { json, bin } = encodeTrace(meta, s);
        const out = decodeTrace(json, bin);
        expectSameBits(out.streams, s);
        expect(out.meta).toStrictEqual(meta);
      }),
    );
  });

  it('writes the four streams little-endian, in order, with no header', () => {
    const s = streamsOf(
      [0x3f800000, 0x3f800000, 0x3f800000], // 1
      [0xc0000000, 0xc0000000, 0xc0000000], // −2
      [0x3f000000, 0x3f000000, 0x3f000000], // 0.5
      [0x3e800000, 0x7fc00001], // 0.25, NaN with payload 1
    );
    const { bin } = encodeTrace(makeMeta({ n10: 3, n32: 2 }), s);
    expect(bin.byteLength).toBe(4 * (3 * 3 + 2));
    const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const values = Array.from({ length: 10 }, (_, i) => view.getFloat32(4 * i, true));
    expect(values).toEqual([1, 1, 1, -2, -2, -2, 0.5, 0.5, 0.5, 0.25]);
    expect(Array.from(bin.subarray(0, 4))).toEqual([0x00, 0x00, 0x80, 0x3f]);
    expect(Array.from(bin.subarray(40, 44))).toEqual([0x01, 0x00, 0xc0, 0x7f]);
  });

  it('writes trace.json as the meta pretty-printed with 2 spaces and a final newline', () => {
    const meta = makeMeta();
    const { json } = encodeTrace(meta, streamsOf([], [], [], []));
    expect(json).toBe(`${JSON.stringify(meta, null, 2)}\n`);
    expect(json.startsWith('{\n  "version": 1,\n')).toBe(true);
  });

  it('encodes stream views at any offset and decodes bin at any byte offset without aliasing it', () => {
    const rng = mulberry32(99);
    const backing = fromBits(randomBits(rng, 64));
    const s: TraceStreams = {
      rawDb: backing.subarray(1, 6),
      bandDb: backing.subarray(10, 15),
      voicing: backing.subarray(20, 25),
      sileroP: backing.subarray(30, 32),
    };
    const { json, bin } = encodeTrace(makeMeta({ n10: 5, n32: 2 }), s);
    // Unaligned: bin at byte offset 3 of a larger buffer.
    const shifted = new Uint8Array(bin.byteLength + 7);
    shifted.set(bin, 3);
    const view = shifted.subarray(3, 3 + bin.byteLength);
    const out = decodeTrace(json, view);
    expectSameBits(out.streams, s);
    view.fill(0);
    expectSameBits(out.streams, s);
    // Aligned: bin itself, where a Float32Array view into it would be possible.
    const aligned = decodeTrace(json, bin);
    expectSameBits(aligned.streams, s);
    bin.fill(0);
    expectSameBits(aligned.streams, s);
  });

  it('round-trips an empty trace', () => {
    const meta = makeMeta({ labels: [] });
    const { json, bin } = encodeTrace(meta, streamsOf([], [], [], []));
    expect(bin.byteLength).toBe(0);
    const out = decodeTrace(json, bin);
    expect(out.meta).toStrictEqual(meta);
    expectSameBits(out.streams, streamsOf([], [], [], []));
  });
});

describe('length and schema validation', () => {
  const rng = mulberry32(7);
  const n10 = 5;
  const n32 = 2;
  const s = streamsOf(randomBits(rng, n10), randomBits(rng, n10), randomBits(rng, n10), randomBits(rng, n32));
  const meta = makeMeta({ n10, n32 });
  const { json, bin } = encodeTrace(meta, s);

  it('decodeTrace throws when trace.bin does not hold exactly 4 · (3 · n10 + n32) bytes', () => {
    expect(bin.byteLength).toBe(68);
    for (const len of [0, 1, 64, 67, 69, 72]) {
      const other = new Uint8Array(len);
      other.set(bin.subarray(0, Math.min(len, bin.byteLength)));
      expect(() => decodeTrace(json, other)).toThrow(RangeError);
    }
    for (const over of [{ n10: 6 }, { n10: 4 }, { n32: 3 }, { n32: 1 }, { n10: 6, n32: 0 }]) {
      expect(() => decodeTrace(JSON.stringify({ ...meta, ...over }), bin)).toThrow(RangeError);
    }
  });

  it('encodeTrace throws when a stream length disagrees with n10 / n32', () => {
    for (const k of ['rawDb', 'bandDb', 'voicing', 'sileroP'] as const) {
      for (const delta of [-1, 1]) {
        const bad: TraceStreams = { ...s, [k]: new Float32Array(s[k].length + delta) };
        expect(() => encodeTrace(meta, bad)).toThrow(RangeError);
      }
    }
  });

  it('rejects an invalid or unsupported meta', () => {
    const bad: Array<Record<string, unknown>> = [
      { version: 2 },
      { version: undefined },
      { device: 7 },
      { startedAt: undefined },
      { ctxRate: 0 },
      { ctxRate: '48000' },
      { constraints: null },
      { session: 'C' },
      { condition: 'rain' },
      { placement: 'pocket' },
      { speaker: 'robot' },
      { firstFrame: -1 },
      { n10: 1.5 },
      { n32: '2' },
      { labels: {} },
      { labels: [{ press: 1 }] },
      { labels: [{ press: -1, release: 4 }] },
      { notes: 3 },
    ];
    for (const over of bad) {
      expect(() => decodeTrace(JSON.stringify({ ...meta, ...over }), bin), JSON.stringify(over)).toThrow(
        TypeError,
      );
    }
    expect(() => decodeTrace('[]', bin)).toThrow(TypeError);
    expect(() => decodeTrace('{"version": 1,', bin)).toThrow(SyntaxError);
    expect(() => encodeTrace({ ...meta, ctxRate: Number.NaN }, s)).toThrow(TypeError);
  });
});

describe('hopStartFrame / sileroStartFrame', () => {
  it('place hop i and Silero frame j on the ctx-frame clock as the format defines', () => {
    const m48 = { firstFrame: 1000, ctxRate: 48000 };
    expect([0, 1, 2, 100].map((i) => hopStartFrame(m48, i))).toEqual([1000, 1480, 1960, 49000]);
    expect([0, 1, 2, 100].map((j) => sileroStartFrame(m48, j))).toEqual([1000, 2536, 4072, 154600]);
    const m44 = { firstFrame: 0, ctxRate: 44100 };
    expect([1, 2, 3].map((i) => hopStartFrame(m44, i))).toEqual([441, 882, 1323]);
    expect([1, 2, 3, 5].map((j) => sileroStartFrame(m44, j))).toEqual([1411, 2822, 4234, 7056]);
    const mismatches: string[] = [];
    for (const ctxRate of [44100, 48000]) {
      for (let i = 0; i < 20000; i++) {
        const want = 5 + Math.round(i * ctxRate * 0.01);
        if (hopStartFrame({ firstFrame: 5, ctxRate }, i) !== want) mismatches.push(`${ctxRate}:${i}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

/** An object or array of the config tree; array elements are keyed "0", "1", … like any object. */
function isNode(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Paths ("a.b.0") of every leaf (non-object value), in key order. */
function leafPaths(v: unknown, prefix = ''): string[] {
  if (!isNode(v)) return [prefix];
  return Object.keys(v).flatMap((k) => leafPaths(v[k], prefix === '' ? k : `${prefix}.${k}`));
}

/** Changes the leaf at path in place: numbers + 1, booleans negated, strings extended. */
function mutateAt(root: unknown, path: string): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  let node = root;
  for (const k of keys) node = isNode(node) ? node[k] : undefined;
  if (!isNode(node)) throw new Error(`no object at ${path}`);
  const old = node[last];
  if (typeof old === 'number') node[last] = old + 1;
  else if (typeof old === 'boolean') node[last] = !old;
  else if (typeof old === 'string') node[last] = `${old}x`;
  else throw new Error(`no mutation for ${path}`);
}

/** Reverses the key insertion order of every object in the tree, in place (array order is kept). */
function reverseKeysInPlace(v: unknown): void {
  if (!isNode(v)) return;
  if (!Array.isArray(v)) {
    for (const k of Object.keys(v).toReversed()) {
      const x = v[k];
      delete v[k];
      v[k] = x;
    }
  }
  for (const k of Object.keys(v)) reverseKeysInPlace(v[k]);
}

describe('frontEndHash', () => {
  it('is a stable lower-case hex SHA-256 of the canonical JSON of FRONT_END_CONFIG', async () => {
    const a = await frontEndHash();
    const b = await frontEndHash();
    const c = await frontEndHash(FRONT_END_CONFIG);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a).toBe(createHash('sha256').update(canonicalJson(FRONT_END_CONFIG), 'utf8').digest('hex'));
  });

  it('canonicalJson sorts keys at every depth, keeps array order and adds no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [3, { z: true, y: null }, 'x'], c: { e: 0.3, d: -2 } })).toBe(
      '{"a":[3,{"y":null,"z":true},"x"],"b":1,"c":{"d":-2,"e":0.3}}',
    );
    expect(canonicalJson([[2, 1], { B: 0, a: 0, _: 0 }])).toBe('[[2,1],{"B":0,"_":0,"a":0}]');
  });

  it('does not depend on key order', async () => {
    const reversed = structuredClone(FRONT_END_CONFIG);
    reverseKeysInPlace(reversed);
    expect(Object.keys(reversed)).toEqual(Object.keys(FRONT_END_CONFIG).toReversed());
    expect(Object.keys(reversed.decimator)).toEqual(['cutoff', 'beta', 'zeroCrossings']);
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(FRONT_END_CONFIG));
    expect(await frontEndHash(reversed)).toBe(await frontEndHash());
  });

  it('changes when any config value changes', async () => {
    const paths = leafPaths(FRONT_END_CONFIG);
    expect(paths).toEqual([
      'decimator.zeroCrossings',
      'decimator.beta',
      'decimator.cutoff',
      'gateFilter.hpfHz.0',
      'gateFilter.hpfHz.1',
      'gateFilter.lpfHz',
      'constraints.echoCancellation',
      'constraints.noiseSuppression',
      'constraints.autoGainControl',
      'hopMs',
      'voicing.fminHz',
      'voicing.fmaxHz',
      'voicing.window',
      'pregateWarmupFrames',
      'hpfClipHz',
    ]);
    const base = await frontEndHash();
    const seen = new Set([base]);
    for (const path of paths) {
      const cfg = structuredClone(FRONT_END_CONFIG);
      mutateAt(cfg, path);
      const h = await frontEndHash(cfg);
      expect(h, path).not.toBe(base);
      seen.add(h);
    }
    expect(seen.size).toBe(paths.length + 1);
  });

  it('rejects values canonical JSON cannot represent exactly', async () => {
    const sparse: unknown[] = [];
    sparse[2] = 1;
    const bad: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined,
      () => 0,
      1n,
      Symbol('x'),
      new Float32Array(1),
      new Date(0),
      new Map(),
      { a: undefined },
      sparse,
    ];
    for (const v of bad) expect(() => canonicalJson(v), typeof v).toThrow(TypeError);
    const cfg = structuredClone(FRONT_END_CONFIG);
    const withNaN = { ...cfg, hopMs: Number.NaN };
    await expect(frontEndHash(withNaN)).rejects.toThrow(TypeError);
  });
});

describe('drift guard: FRONT_END_CONFIG equals the constants the pipeline uses', () => {
  it('decimator: the resampler defaults (the capture worklet passes no options)', () => {
    // The worklet builds the clip HPF and the decimator exactly once each, with no decimator options. It
    // needs the AudioWorklet scope to import, so its source text is pinned instead.
    const worklet = readFileSync(new URL('../audio/capture.worklet.ts', import.meta.url), 'utf8');
    const count = (needle: string): number => worklet.split(needle).length - 1;
    expect(count('createResampler(')).toBe(1);
    expect(count('createResampler(sampleRate, VAD_RATE)')).toBe(1);
    expect(count('butterworthHighpass(')).toBe(1);
    expect(count('butterworthHighpass(sampleRate, HPF_CLIP_HZ)')).toBe(1);
    const d = FRONT_END_CONFIG.decimator;
    expect(d.zeroCrossings).toBe(DEFAULT_ZERO_CROSSINGS);
    expect(d.beta).toBe(DEFAULT_BETA);
    // The default cutoff is CUTOFF_FACTOR · min(1, ratio); the config states it at the 48 kHz reference rate.
    expect(d.cutoff).toBe(CUTOFF_FACTOR * Math.min(1, VAD_RATE / 48000));
    const x = noise(1, 4800);
    const byDefaults = createResampler(48000, VAD_RATE).process(x);
    const byConfig = createResampler(48000, VAD_RATE, d).process(x);
    expect(byDefaults.length).toBeGreaterThan(1500);
    expect(bitsOf(byConfig)).toEqual(bitsOf(byDefaults));
  });

  it('gate filter: createGateFilter is the configured HPF cascade then LPF', () => {
    const g = FRONT_END_CONFIG.gateFilter;
    expect(g.hpfHz).toEqual([GATE_HPF_HZ, GATE_HPF_HZ]);
    expect(g.lpfHz).toBe(GATE_LPF_HZ);
    const x = noise(2, 4096);
    const real = createGateFilter(VAD_RATE).process(x);
    const configured = cascade(
      ...g.hpfHz.map((f) => butterworthHighpass(VAD_RATE, f)),
      butterworthLowpass(VAD_RATE, g.lpfHz),
    ).process(x);
    expect(bitsOf(configured)).toEqual(bitsOf(real));
  });

  it('constraints, clip high-pass, hop and voicing', () => {
    expect(FRONT_END_CONFIG.constraints).toEqual(CONSTRAINTS);
    expect(FRONT_END_CONFIG.hpfClipHz).toBe(HPF_CLIP_HZ);
    expect(FRONT_END_CONFIG.hopMs).toBe((ENERGY_HOP * 1000) / VAD_RATE);
    expect(FRONT_END_CONFIG.voicing.fminHz).toBe(VOICING_FMIN_HZ);
    expect(FRONT_END_CONFIG.voicing.fmaxHz).toBe(VOICING_FMAX_HZ);
    // Placeholder pin: no voicing-window constant exists yet (the worker starts computing voicing with #46),
    // and VAD_FRAME is the Silero frame length, not the voicing window. #46 (T35) exports VOICING_WINDOW
    // (512) from src/audio/constants.ts and replaces this line with a pin to it.
    expect(FRONT_END_CONFIG.voicing.window).toBe(VAD_FRAME);
    // pregateWarmupFrames has no code constant yet either: #46 (T35) exports PREGATE_WARMUP_FRAMES (10) from
    // src/audio/constants.ts and adds its pin here.
  });
});

describe('staleness', () => {
  const h = 'a'.repeat(64);
  const w = 'b'.repeat(64);
  const meta = makeMeta({ frontEndHash: h, sileroWeightsSha256: w });

  it('returns null when both hashes match, else the first reason that applies', () => {
    expect(staleness(meta, h, w)).toBeNull();
    expect(staleness(meta, 'c'.repeat(64), w)).toEqual({ reason: 'frontEnd' });
    expect(staleness(meta, h, 'c'.repeat(64))).toEqual({ reason: 'weights' });
    expect(staleness(meta, 'c'.repeat(64), 'c'.repeat(64))).toEqual({ reason: 'frontEnd' });
  });

  it('flags a trace recorded under another front-end config', async () => {
    const current = makeMeta({ frontEndHash: await frontEndHash() });
    expect(staleness(current, await frontEndHash(), WEIGHTS_SHA256)).toBeNull();
    const changed = { ...structuredClone(FRONT_END_CONFIG), pregateWarmupFrames: 12 };
    expect(staleness(current, await frontEndHash(changed), WEIGHTS_SHA256)).toEqual({ reason: 'frontEnd' });
  });
});
