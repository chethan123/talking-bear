import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { readWav, writeWav } from './wav.ts';

const LSB = 1 / 32768;

interface Chunk {
  id: string;
  body: Uint8Array;
  /** Overrides the size field (for malformed files); defaults to body.length. */
  size?: number;
}

function ascii(id: string): number[] {
  return Array.from(id, (ch) => ch.charCodeAt(0));
}

function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}

function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** Builds a RIFF/WAVE file from raw chunks, padding odd-sized chunk bodies to an even length. */
function riff(chunks: Chunk[]): Uint8Array {
  const out: number[] = [];
  for (const chunk of chunks) {
    out.push(...ascii(chunk.id), ...u32(chunk.size ?? chunk.body.length), ...chunk.body);
    if (chunk.body.length % 2 === 1) out.push(0);
  }
  return Uint8Array.from([...ascii('RIFF'), ...u32(4 + out.length), ...ascii('WAVE'), ...out]);
}

function fmtChunk(
  formatTag: number,
  channels: number,
  sampleRate: number,
  bits: number,
  blockAlign = (channels * bits) / 8,
): Chunk {
  const body = Uint8Array.from([
    ...u16(formatTag),
    ...u16(channels),
    ...u32(sampleRate),
    ...u32(sampleRate * blockAlign),
    ...u16(blockAlign),
    ...u16(bits),
  ]);
  return { id: 'fmt ', body };
}

function dataChunk(bytes: number[]): Chunk {
  return { id: 'data', body: Uint8Array.from(bytes) };
}

/** The raw Int16 samples of a canonical PCM16 file written by writeWav. */
function rawPcm16(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let p = 44; p < bytes.byteLength; p += 2) out.push(view.getInt16(p, true));
  return out;
}

/**
 * An empty Float32Array that reports `length` frames, so writeWav's size limits can be tested without
 * allocating gigabytes (writeWav throws before it reads any sample).
 */
function hugeChannel(length: number): Float32Array {
  return Object.defineProperty(new Float32Array(0), 'length', { value: length });
}

function float32Bits(x: Float32Array): number[] {
  return Array.from(new Uint32Array(x.buffer, x.byteOffset, x.length));
}

const shape = fc.tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 0, max: 256 }));
const pcm16Input = shape.chain(([ch, frames]) =>
  fc.array(
    fc.float32Array({
      min: -1,
      max: 1,
      maxExcluded: true,
      noNaN: true,
      minLength: frames,
      maxLength: frames,
    }),
    { minLength: ch, maxLength: ch },
  ),
);
const float32Input = shape.chain(([ch, frames]) =>
  fc.array(fc.float32Array({ noNaN: true, minLength: frames, maxLength: frames }), {
    minLength: ch,
    maxLength: ch,
  }),
);
const sampleRateArb = fc.integer({ min: 1, max: 384000 });

describe('round trips', () => {
  test('PCM16 round trip is within 1 LSB and preserves shape and sample rate', () => {
    fc.assert(
      fc.property(pcm16Input, sampleRateArb, (channels, sampleRate) => {
        const out = readWav(writeWav(channels, sampleRate, 'pcm16'));
        expect(out.sampleRate).toBe(sampleRate);
        expect(out.channels).toHaveLength(channels.length);
        for (let c = 0; c < channels.length; c++) {
          const input = channels[c]!;
          const decoded = out.channels[c]!;
          expect(decoded).toHaveLength(input.length);
          for (let i = 0; i < input.length; i++) {
            expect(Math.abs(decoded[i]! - input[i]!)).toBeLessThanOrEqual(LSB);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  test('float32 round trip is bit-exact (including ±0, ±Infinity and subnormals)', () => {
    fc.assert(
      fc.property(float32Input, sampleRateArb, (channels, sampleRate) => {
        const out = readWav(writeWav(channels, sampleRate, 'float32'));
        expect(out.sampleRate).toBe(sampleRate);
        expect(out.channels.map(float32Bits)).toEqual(channels.map(float32Bits));
      }),
      { numRuns: 300 },
    );
    const special = Float32Array.of(0, -0, Infinity, -Infinity, 1e-45, -1e-45, 1.17549435e-38, 3.4028235e38);
    expect(float32Bits(readWav(writeWav([special], 48000, 'float32')).channels[0]!)).toEqual(
      float32Bits(special),
    );
  });
});

describe('readWav', () => {
  test('throws on a 24-bit PCM file', () => {
    const bytes = riff([fmtChunk(1, 1, 48000, 24), dataChunk([0, 0, 0, 1, 2, 3])]);
    expect(() => readWav(bytes)).toThrow(/unsupported WAV format: tag 1, 24 bits/);
  });

  test.each([
    ['8-bit PCM', 1, 8],
    ['float64', 3, 64],
    ['16-bit float', 3, 16],
    ['WAVE_FORMAT_EXTENSIBLE', 0xfffe, 16],
    ['ADPCM', 2, 4],
    ['A-law', 6, 8],
  ])('throws on %s', (_name, tag, bitsPerSample) => {
    const blockAlign = Math.max(1, bitsPerSample / 8);
    const bytes = riff([
      fmtChunk(tag, 1, 48000, bitsPerSample, blockAlign),
      dataChunk([0, 0, 0, 0, 0, 0, 0, 0]),
    ]);
    expect(() => readWav(bytes)).toThrow(/unsupported WAV format/);
  });

  test('decodes PCM32', () => {
    const bytes = riff([
      fmtChunk(1, 1, 16000, 32),
      dataChunk([...u32(0x7fffffff), ...u32(0x80000000), ...u32(0x40000000), ...u32(0)]),
    ]);
    const { sampleRate, channels } = readWav(bytes);
    expect(sampleRate).toBe(16000);
    expect(channels).toHaveLength(1);
    const x = channels[0]!;
    expect(x).toHaveLength(4);
    expect(x[0]).toBeCloseTo(1, 7);
    expect(x[1]).toBe(-1);
    expect(x[2]).toBe(0.5);
    expect(x[3]).toBe(0);
  });

  test('decodes PCM16 and float32 and deinterleaves channels', () => {
    const pcm = riff([
      fmtChunk(1, 2, 8000, 16),
      dataChunk([...u16(0x4000), ...u16(0x8000), ...u16(0xe000), ...u16(1)]),
    ]);
    expect(readWav(pcm)).toEqual({
      sampleRate: 8000,
      channels: [Float32Array.of(0.5, -0.25), Float32Array.of(-1, LSB)],
    });
    const f32 = new Uint8Array(new Float32Array([0.25, -2, 3.5]).buffer);
    const float = riff([fmtChunk(3, 3, 44100, 32), dataChunk([...f32])]);
    expect(readWav(float)).toEqual({
      sampleRate: 44100,
      channels: [Float32Array.of(0.25), Float32Array.of(-2), Float32Array.of(3.5)],
    });
  });

  test('skips unknown chunks, including an odd-sized chunk and its pad byte', () => {
    const bytes = riff([
      { id: 'JUNK', body: Uint8Array.from([1, 2, 3, 4]) },
      fmtChunk(1, 1, 48000, 16),
      { id: 'LIST', body: Uint8Array.from([9, 9, 9]) },
      dataChunk([...u16(0x4000), ...u16(0xc000)]),
      { id: 'id3 ', body: Uint8Array.from([7]) },
    ]);
    expect(readWav(bytes)).toEqual({ sampleRate: 48000, channels: [Float32Array.of(0.5, -0.5)] });
  });

  test('accepts a fmt chunk longer than 16 bytes', () => {
    const fmt = fmtChunk(1, 1, 48000, 16);
    const bytes = riff([
      { id: 'fmt ', body: Uint8Array.from([...fmt.body, 0, 0]) },
      dataChunk([...u16(0x2000)]),
    ]);
    expect(readWav(bytes)).toEqual({ sampleRate: 48000, channels: [Float32Array.of(0.25)] });
  });

  test('reads from a subarray with a non-zero byteOffset', () => {
    const wav = writeWav([Float32Array.of(0.5, -0.5, 0.25)], 22050, 'pcm16');
    const backing = new Uint8Array(wav.length + 7);
    backing.set(wav, 3);
    const sub = backing.subarray(3, 3 + wav.length);
    expect(sub.byteOffset).toBe(3);
    expect(readWav(sub)).toEqual({ sampleRate: 22050, channels: [Float32Array.of(0.5, -0.5, 0.25)] });
  });

  const fmt16 = fmtChunk(1, 1, 48000, 16);
  const data2 = dataChunk([0, 0, 0, 0]);
  test.each<[string, Uint8Array, RegExp]>([
    ['shorter than 12 bytes', Uint8Array.from(ascii('RIFF')), /shorter than the RIFF header/],
    [
      'a missing RIFF id',
      Uint8Array.from([...ascii('RIFX'), ...u32(4), ...ascii('WAVE')]),
      /missing RIFF id/,
    ],
    [
      'a missing WAVE id',
      Uint8Array.from([...ascii('RIFF'), ...u32(4), ...ascii('AVI ')]),
      /missing WAVE id/,
    ],
    [
      'a chunk running past the end',
      riff([fmt16, { id: 'data', body: Uint8Array.from([0, 0]), size: 4 }]),
      /runs past the end/,
    ],
    ['a duplicate fmt chunk', riff([fmt16, fmt16, data2]), /duplicate 'fmt ' chunk/],
    ['a duplicate data chunk', riff([fmt16, data2, data2]), /duplicate 'data' chunk/],
    [
      'a short fmt chunk',
      riff([{ id: 'fmt ', body: fmt16.body.subarray(0, 14) }, data2]),
      /expected at least 16/,
    ],
    ['a missing fmt chunk', riff([data2]), /missing 'fmt ' chunk/],
    ['a missing data chunk', riff([fmt16]), /missing 'data' chunk/],
    ['0 channels', riff([fmtChunk(1, 0, 48000, 16, 2), data2]), /0 channels/],
    ['sample rate 0', riff([fmtChunk(1, 1, 0, 16), data2]), /sample rate 0/],
    ['a blockAlign mismatch', riff([fmtChunk(1, 2, 48000, 16, 2), data2]), /blockAlign 2 != 2 channels/],
    ['a partial frame', riff([fmt16, dataChunk([0, 0, 0])]), /not a multiple of blockAlign/],
  ])('throws on %s', (_name, bytes, message) => {
    expect(() => readWav(bytes)).toThrow(message);
  });
});

describe('writeWav', () => {
  test('writes the canonical 44-byte PCM16 header (golden bytes)', () => {
    const bytes = writeWav([Float32Array.of(0.5, -0.25), Float32Array.of(-1, 0.25)], 48000, 'pcm16');
    const expected = [
      ascii('RIFF'),
      [44, 0, 0, 0], // RIFF size: 36 + 8
      ascii('WAVE'),
      ascii('fmt '),
      [16, 0, 0, 0], // fmt size
      [1, 0], // PCM
      [2, 0], // channels
      [0x80, 0xbb, 0, 0], // 48000 Hz
      [0x00, 0xee, 0x02, 0x00], // byte rate 192000
      [4, 0], // block align
      [16, 0], // bits per sample
      ascii('data'),
      [8, 0, 0, 0], // data size
      [0x00, 0x40, 0x00, 0x80], // frame 0: 16384, -32768
      [0x00, 0xe0, 0x00, 0x20], // frame 1: -8192, 8192
    ].flat();
    expect(Array.from(bytes)).toEqual(expected);
  });

  test('writes the float32 header fields', () => {
    const bytes = writeWav([Float32Array.of(0.1)], 44100, 'float32');
    const view = new DataView(bytes.buffer);
    expect(bytes).toHaveLength(48);
    expect(view.getUint32(4, true)).toBe(40);
    expect(view.getUint16(20, true)).toBe(3);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(28, true)).toBe(176400);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(32);
    expect(view.getUint32(40, true)).toBe(4);
    expect(view.getFloat32(44, true)).toBe(Math.fround(0.1));
  });

  test('PCM16 rounds half away from zero and clamps to [−1, 1)', () => {
    const cases: [number, number][] = [
      [0, 0],
      [-0, 0],
      [0.25 * LSB, 0],
      [-0.25 * LSB, 0],
      [0.5 * LSB, 1],
      [-0.5 * LSB, -1],
      [1.5 * LSB, 2],
      [-1.5 * LSB, -2],
      [32767 * LSB, 32767],
      [32767.5 * LSB, 32767],
      [1, 32767],
      [2, 32767],
      [Infinity, 32767],
      [-1, -32768],
      [-2, -32768],
      [-Infinity, -32768],
      [NaN, 0],
    ];
    const input = Float32Array.from(cases, ([x]) => x);
    expect(rawPcm16(writeWav([input], 48000, 'pcm16'))).toEqual(cases.map(([, v]) => v));
  });

  test('writes zero frames', () => {
    const bytes = writeWav([new Float32Array(0)], 48000, 'pcm16');
    expect(bytes).toHaveLength(44);
    expect(readWav(bytes)).toEqual({ sampleRate: 48000, channels: [new Float32Array(0)] });
  });

  test.each<[string, () => unknown, RegExp]>([
    ['0 channels', () => writeWav([], 48000, 'pcm16'), /channel count must be in \[1, 65535\], got 0/],
    [
      'more than 65535 channels',
      () =>
        writeWav(
          Array.from({ length: 65536 }, () => new Float32Array(0)),
          48000,
          'pcm16',
        ),
      /got 65536/,
    ],
    [
      'unequal channel lengths',
      () => writeWav([new Float32Array(2), new Float32Array(3)], 48000, 'pcm16'),
      /same length/,
    ],
    ['a non-integer sample rate', () => writeWav([new Float32Array(1)], 44100.5, 'pcm16'), /sample rate/],
    ['sample rate 0', () => writeWav([new Float32Array(1)], 0, 'pcm16'), /sample rate/],
    ['sample rate NaN', () => writeWav([new Float32Array(1)], NaN, 'pcm16'), /sample rate/],
    ['sample rate 2^32', () => writeWav([new Float32Array(1)], 2 ** 32, 'pcm16'), /sample rate/],
    [
      'an unknown format',
      () => Reflect.apply(writeWav, undefined, [[new Float32Array(1)], 48000, 'pcm24']),
      /unknown WAV format 'pcm24'/,
    ],
    [
      'a blockAlign above 65535',
      () =>
        writeWav(
          Array.from({ length: 16384 }, () => new Float32Array(0)),
          48000,
          'float32',
        ),
      /blockAlign 65536 exceeds 65535/,
    ],
    ['a byte rate above 2^32 − 1', () => writeWav([new Float32Array(1)], 2 ** 32 - 1, 'pcm16'), /byte rate/],
    [
      'a RIFF size above 2^32 − 1',
      () => writeWav([hugeChannel(2 ** 31)], 48000, 'pcm16'),
      /RIFF size 4294967332 exceeds/,
    ],
  ])('throws on %s', (_name, fn, message) => {
    expect(fn).toThrow(RangeError);
    expect(fn).toThrow(message);
  });
});

test('test/wav.ts imports no module (usable from Browser Mode tests)', () => {
  const source = readFileSync(new URL('./wav.ts', import.meta.url), 'utf8');
  expect(source.length).toBeGreaterThan(0);
  expect(source).not.toMatch(/^\s*import\s/m);
  expect(source).not.toMatch(/\bimport\s*\(/m);
  expect(source).not.toMatch(/\brequire\s*\(/m);
});
