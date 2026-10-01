// readOnnxInitializers on a hand-built ONNX protobuf: initializers in the main graph and in subgraphs nested
// in node attributes (g and graphs), which float raw_data tensors are returned, unaligned raw_data, and the
// malformed-input errors. Ported from the reader check in PR #164 (T32).

import { describe, expect, it } from 'vitest';

import { readOnnxInitializers } from './onnx-reader.ts';

// Protobuf builders. Every builder returns the encoded bytes as a plain number array.

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 128) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

const tag = (field: number, wire: number): number[] => varint(field * 8 + wire);
/** A length-delimited field (wire type 2). */
const len = (field: number, bytes: number[]): number[] => [
  ...tag(field, 2),
  ...varint(bytes.length),
  ...bytes,
];
/** A varint field (wire type 0). */
const vint = (field: number, v: number): number[] => [...tag(field, 0), ...varint(v)];
const str = (s: string): number[] => [...new TextEncoder().encode(s)];

function f32le(vals: number[]): number[] {
  const b = new Uint8Array(vals.length * 4);
  const dv = new DataView(b.buffer);
  vals.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  return [...b];
}

interface TensorOpts {
  /** TensorProto.data_type; 1 (FLOAT) by default. */
  dataType?: number;
  /** Write dims as one packed field instead of one varint field per dim. */
  packed?: boolean;
  /** Store the values in float_data (field 4) instead of raw_data (field 9). */
  noRaw?: boolean;
}

/** A TensorProto: dims (1), data_type (2), name (8), then raw_data (9) or float_data (4). */
function tensor(name: string, dims: number[], vals: number[], opts: TensorOpts = {}): number[] {
  const dimBytes = opts.packed ? len(1, dims.flatMap(varint)) : dims.flatMap((d) => vint(1, d));
  return [
    ...dimBytes,
    ...vint(2, opts.dataType ?? 1),
    ...len(8, str(name)),
    ...(opts.noRaw ? vals.flatMap((v) => [...tag(4, 5), ...f32le([v])]) : len(9, f32le(vals))),
  ];
}

const graph = (parts: number[][]): number[] => parts.flat();
/** GraphProto.initializer (5). */
const initializer = (t: number[]): number[] => len(5, t);
/** GraphProto.node (1): a NodeProto with op_type (4) and attributes (5). */
const node = (op: string, attrs: number[][]): number[] =>
  len(1, [...len(4, str(op)), ...attrs.flatMap((a) => len(5, a))]);
/** An AttributeProto of type GRAPH (5): name (1), type (20), g (6). */
const attrG = (name: string, g: number[]): number[] => [...len(1, str(name)), ...vint(20, 5), ...len(6, g)];
/** An AttributeProto of type GRAPHS (10): name (1), type (20), graphs (11). */
const attrGraphs = (name: string, gs: number[][]): number[] => [
  ...len(1, str(name)),
  ...vint(20, 10),
  ...gs.flatMap((g) => len(11, g)),
];
/** An AttributeProto of type INT (2): name (1), type (20), i (3). */
const attrInt = (name: string, v: number): number[] => [...len(1, str(name)), ...vint(20, 2), ...vint(3, v)];

// The probe model: an If whose then_branch holds a Loop whose body holds another subgraph, a node with a
// GRAPHS attribute, and top-level initializers, one of them float_data-only and one int64.
const deepSub = graph([initializer(tensor('deep.w', [2], [5, 6]))]);
const thenBranch = graph([
  initializer(tensor('then.w', [2, 2], [1, 2, 3, 4], { packed: true })),
  node('Loop', [attrG('body', deepSub)]),
]);
const elseBranch = graph([initializer(tensor('else.int64', [1], [0], { dataType: 7 }))]);
const multi = [
  graph([initializer(tensor('g0.w', [1], [7]))]),
  graph([initializer(tensor('g1.w', [1], [8]))]),
];
const mainGraph = graph([
  node('If', [attrInt('dummy', 3), attrG('then_branch', thenBranch), attrG('else_branch', elseBranch)]),
  node('Custom', [attrGraphs('bodies', multi)]),
  initializer(tensor('top.w', [3], [0.5, -1.25, 1e-3])),
  initializer(tensor('top.floatdata', [1], [9], { noRaw: true })),
]);
/** ModelProto: ir_version (1), producer_name (2), graph (7). */
const model = new Uint8Array([...vint(1, 8), ...len(2, str('probe')), ...len(7, mainGraph)]);

describe('readOnnxInitializers', () => {
  it('returns exactly the float raw_data initializers, from the main graph and every nested subgraph', () => {
    const m = readOnnxInitializers(model);
    // then.w and deep.w come from g attributes (deep.w two levels down), g0.w and g1.w from a graphs
    // attribute, top.w from the main graph; else.int64 (INT64) and top.floatdata (float_data) are skipped.
    expect([...m.keys()].toSorted()).toEqual(['deep.w', 'g0.w', 'g1.w', 'then.w', 'top.w']);
  });

  it('reads dims (plain and packed) and little-endian float32 data', () => {
    const m = readOnnxInitializers(model);
    expect(m.get('then.w')?.dims).toEqual([2, 2]);
    expect([...(m.get('then.w')?.data ?? [])]).toEqual([1, 2, 3, 4]);
    expect(m.get('deep.w')?.dims).toEqual([2]);
    expect([...(m.get('deep.w')?.data ?? [])]).toEqual([5, 6]);
    expect([...(m.get('top.w')?.data ?? [])]).toEqual([0.5, -1.25, Math.fround(1e-3)]);
    expect([...(m.get('g0.w')?.data ?? [])]).toEqual([7]);
    expect([...(m.get('g1.w')?.data ?? [])]).toEqual([8]);
  });

  it('raw_data at a different (unaligned) offset: the model without field 2 still yields 5 initializers', () => {
    // Dropping producer_name (7 bytes) moves every raw_data payload by 7 bytes, so in one of the two models
    // each payload starts at an offset that isn't a multiple of 4.
    const shifted = new Uint8Array([...vint(1, 8), ...len(7, mainGraph)]);
    expect(shifted.length).toBe(model.length - 7);
    const m = readOnnxInitializers(shifted);
    expect(m.size).toBe(5);
    expect([...(m.get('top.w')?.data ?? [])]).toEqual([0.5, -1.25, Math.fround(1e-3)]);
    expect([...(m.get('then.w')?.data ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it('throws on a truncated model, a duplicate name and a raw_data length that does not match the dims', () => {
    expect(() => readOnnxInitializers(model.subarray(0, model.length - 3))).toThrow(/overruns|truncated/);
    const dup = new Uint8Array(
      len(7, graph([initializer(tensor('a', [1], [1])), initializer(tensor('a', [1], [2]))])),
    );
    expect(() => readOnnxInitializers(dup)).toThrow(/duplicate/);
    const badLen = new Uint8Array(len(7, graph([initializer(tensor('b', [2], [1]))])));
    expect(() => readOnnxInitializers(badLen)).toThrow(/raw bytes/);
  });
});
