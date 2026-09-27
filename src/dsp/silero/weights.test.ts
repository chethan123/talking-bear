import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  WEIGHTS_BYTES,
  WEIGHTS_LAYOUT,
  WEIGHTS_SHA256,
  decodeWeights,
  fp16ToFp32,
  type SileroWeights,
} from './weights.ts';

const binBytes = readFileSync(new URL('./weights.bin', import.meta.url));
interface ProvenanceFile {
  weightsSha256: string;
  weightsBytes: number;
  format: string;
  order: { key: string; onnxName: string; dims: number[]; offsetBytes: number }[];
}
const provenance: ProvenanceFile = JSON.parse(
  readFileSync(new URL('./weights.provenance.json', import.meta.url), 'utf8'),
);

/** A fresh ArrayBuffer holding exactly the bytes of weights.bin. */
function binBuffer(): ArrayBuffer {
  const buf = new ArrayBuffer(binBytes.byteLength);
  new Uint8Array(buf).set(binBytes);
  return buf;
}

const EXPECTED_LENGTHS: Record<keyof SileroWeights, number> = {
  conv1W: 128 * 129 * 3,
  conv1B: 128,
  conv2W: 64 * 128 * 3,
  conv2B: 64,
  conv3W: 64 * 64 * 3,
  conv3B: 64,
  conv4W: 128 * 64 * 3,
  conv4B: 128,
  lstmWih: 512 * 128,
  lstmWhh: 512 * 128,
  lstmBih: 512,
  lstmBhh: 512,
  finalW: 128,
  finalB: 1,
};

/** The issue's layout table (T32, #43), written out independently of WEIGHTS_LAYOUT. */
const ISSUE_LAYOUT_TABLE = [
  { key: 'conv1W', onnxName: 'model.encoder.0.reparam_conv.weight', dims: [128, 129, 3] },
  { key: 'conv1B', onnxName: 'model.encoder.0.reparam_conv.bias', dims: [128] },
  { key: 'conv2W', onnxName: 'model.encoder.1.reparam_conv.weight', dims: [64, 128, 3] },
  { key: 'conv2B', onnxName: 'model.encoder.1.reparam_conv.bias', dims: [64] },
  { key: 'conv3W', onnxName: 'model.encoder.2.reparam_conv.weight', dims: [64, 64, 3] },
  { key: 'conv3B', onnxName: 'model.encoder.2.reparam_conv.bias', dims: [64] },
  { key: 'conv4W', onnxName: 'model.encoder.3.reparam_conv.weight', dims: [128, 64, 3] },
  { key: 'conv4B', onnxName: 'model.encoder.3.reparam_conv.bias', dims: [128] },
  { key: 'lstmWih', onnxName: 'model.decoder.rnn.weight_ih', dims: [512, 128] },
  { key: 'lstmWhh', onnxName: 'model.decoder.rnn.weight_hh', dims: [512, 128] },
  { key: 'lstmBih', onnxName: 'model.decoder.rnn.bias_ih', dims: [512] },
  { key: 'lstmBhh', onnxName: 'model.decoder.rnn.bias_hh', dims: [512] },
  { key: 'finalW', onnxName: 'model.decoder.decoder.2.weight', dims: [1, 128, 1] },
  { key: 'finalB', onnxName: 'model.decoder.decoder.2.bias', dims: [1] },
];

describe('layout', () => {
  it('WEIGHTS_LAYOUT is the issue table, row for row', () => {
    expect(WEIGHTS_LAYOUT.map(({ key, onnxName, dims }) => ({ key, onnxName, dims: [...dims] }))).toEqual(
      ISSUE_LAYOUT_TABLE,
    );
  });

  it('the provenance order is the issue table, row for row', () => {
    expect(provenance.order.map(({ key, onnxName, dims }) => ({ key, onnxName, dims }))).toEqual(
      ISSUE_LAYOUT_TABLE,
    );
  });
});

describe('committed weights.bin', () => {
  it('is 487,170 bytes and its SHA-256 is WEIGHTS_SHA256', () => {
    expect(binBytes.byteLength).toBe(487_170);
    expect(createHash('sha256').update(binBytes).digest('hex')).toBe(WEIGHTS_SHA256);
  });

  it('matches weights.provenance.json (hash, size, format, order and offsets)', () => {
    expect(provenance.weightsSha256).toBe(WEIGHTS_SHA256);
    expect(provenance.weightsBytes).toBe(WEIGHTS_BYTES);
    expect(provenance.format).toBe('fp16-le');
    let offsetBytes = 0;
    const expected = WEIGHTS_LAYOUT.map(({ key, onnxName, dims }) => {
      const entry = { key, onnxName, dims: [...dims], offsetBytes };
      offsetBytes += dims.reduce((a, b) => a * b, 1) * 2;
      return entry;
    });
    expect(offsetBytes).toBe(WEIGHTS_BYTES);
    expect(provenance.order).toEqual(expected);
  });

  it('decodes to the 14 tensors with the right lengths, all finite', () => {
    const w = decodeWeights(binBuffer());
    expect(Object.keys(w)).toEqual(Object.keys(EXPECTED_LENGTHS));
    for (const { key } of WEIGHTS_LAYOUT) {
      const data = w[key];
      expect(data, key).toBeInstanceOf(Float32Array);
      expect(data.length, key).toBe(EXPECTED_LENGTHS[key]);
      expect(
        data.every((v) => Number.isFinite(v)),
        key,
      ).toBe(true);
    }
  });
});

describe('decodeWeights', () => {
  it.each([0, WEIGHTS_BYTES - 1, WEIGHTS_BYTES + 1])('throws on a %i-byte buffer', (n) => {
    expect(() => decodeWeights(new ArrayBuffer(n))).toThrow(RangeError);
  });

  it('reads little-endian fp16 in layout order', () => {
    const bytes = new Uint8Array(WEIGHTS_BYTES);
    // conv1W[0..3] = 1, -2, 65504, -0 ; finalB[0] (the last two bytes) = 0.5
    bytes.set([0x00, 0x3c, 0x00, 0xc0, 0xff, 0x7b, 0x00, 0x80], 0);
    bytes.set([0x00, 0x38], WEIGHTS_BYTES - 2);
    const w = decodeWeights(bytes.buffer);
    expect([...w.conv1W.subarray(0, 4)]).toEqual([1, -2, 65504, -0]);
    expect(Object.is(w.conv1W[3], -0)).toBe(true);
    expect(w.finalB[0]).toBe(0.5);
  });
});

describe('fp16ToFp32', () => {
  it.each([
    [0x0000, 0],
    [0x3c00, 1],
    [0xc000, -2],
    [0x7bff, 65504],
    [0x0400, 2 ** -14],
    [0x03ff, 1023 * 2 ** -24],
    [0x0001, 2 ** -24],
    [0x3555, 0.333251953125],
    [0x7c00, Infinity],
    [0xfc00, -Infinity],
  ])('%i decodes to %s', (bits, value) => {
    expect(fp16ToFp32(bits)).toBe(value);
  });

  it('decodes 0x8000 as -0 and 0x7e00 as NaN', () => {
    expect(Object.is(fp16ToFp32(0x8000), -0)).toBe(true);
    expect(fp16ToFp32(0x7e00)).toBeNaN();
  });
});
