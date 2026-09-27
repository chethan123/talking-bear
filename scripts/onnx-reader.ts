// Minimal protobuf reader for ONNX models: returns the float TensorProto initializers that carry
// raw_data, from the main graph and from every subgraph nested in node attributes (If / Loop / Scan
// bodies). Nothing else of the model is decoded. Used by scripts/extract-silero-weights.ts.
//
// Field numbers (onnx/onnx.proto3):
//   ModelProto.graph = 7
//   GraphProto.node = 1, GraphProto.initializer = 5
//   NodeProto.attribute = 5
//   AttributeProto.g = 6 (GRAPH), AttributeProto.graphs = 11 (GRAPHS)
//   TensorProto.dims = 1, data_type = 2, name = 8, raw_data = 9; data_type FLOAT = 1

export interface OnnxTensor {
  dims: number[];
  data: Float32Array;
}

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

const MODEL_GRAPH = 7;
const GRAPH_NODE = 1;
const GRAPH_INITIALIZER = 5;
const NODE_ATTRIBUTE = 5;
const ATTR_G = 6;
const ATTR_GRAPHS = 11;
const TENSOR_DIMS = 1;
const TENSOR_DATA_TYPE = 2;
const TENSOR_NAME = 8;
const TENSOR_RAW_DATA = 9;
const DATA_TYPE_FLOAT = 1;

interface Field {
  field: number;
  wire: number;
  /** Varint payload (wire type 0). Exact up to 2^53; larger values are only ever skipped. */
  value: number;
  /** Payload byte range [start, end) for wire types 1, 2 and 5. */
  start: number;
  end: number;
}

function readVarint(buf: Uint8Array, pos: number, end: number): [value: number, next: number] {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= end) throw new Error(`onnx: truncated varint at byte ${pos}`);
    const byte = buf[pos++]!;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return [value, pos];
    scale *= 128;
  }
  throw new Error(`onnx: varint longer than 10 bytes before byte ${pos}`);
}

function* fields(buf: Uint8Array, start: number, end: number): Generator<Field> {
  let pos = start;
  while (pos < end) {
    const [tag, afterTag] = readVarint(buf, pos, end);
    pos = afterTag;
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === WIRE_VARINT) {
      const [value, next] = readVarint(buf, pos, end);
      pos = next;
      yield { field, wire, value, start: pos, end: pos };
      continue;
    }
    let length: number;
    if (wire === WIRE_LEN) {
      const [len, next] = readVarint(buf, pos, end);
      pos = next;
      length = len;
    } else if (wire === WIRE_I64) {
      length = 8;
    } else if (wire === WIRE_I32) {
      length = 4;
    } else {
      throw new Error(`onnx: unsupported wire type ${wire} (field ${field}) at byte ${pos}`);
    }
    if (pos + length > end) throw new Error(`onnx: field ${field} overruns its message at byte ${pos}`);
    yield { field, wire, value: 0, start: pos, end: pos + length };
    pos += length;
  }
}

function readTensor(buf: Uint8Array, start: number, end: number, out: Map<string, OnnxTensor>): void {
  let name = '';
  let dataType = 0;
  const dims: number[] = [];
  let raw: Field | null = null;
  for (const f of fields(buf, start, end)) {
    if (f.field === TENSOR_NAME && f.wire === WIRE_LEN) {
      name = new TextDecoder().decode(buf.subarray(f.start, f.end));
    } else if (f.field === TENSOR_DATA_TYPE && f.wire === WIRE_VARINT) {
      dataType = f.value;
    } else if (f.field === TENSOR_DIMS && f.wire === WIRE_VARINT) {
      dims.push(f.value);
    } else if (f.field === TENSOR_DIMS && f.wire === WIRE_LEN) {
      // packed repeated int64
      let pos = f.start;
      while (pos < f.end) {
        const [dim, next] = readVarint(buf, pos, f.end);
        dims.push(dim);
        pos = next;
      }
    } else if (f.field === TENSOR_RAW_DATA && f.wire === WIRE_LEN) {
      raw = f;
    }
  }
  if (dataType !== DATA_TYPE_FLOAT || raw === null) return;
  const count = dims.reduce((a, b) => a * b, 1);
  const bytes = raw.end - raw.start;
  if (bytes !== count * 4) {
    throw new Error(
      `onnx: initializer ${name} has ${bytes} raw bytes, expected ${count * 4} for dims [${dims.join(', ')}]`,
    );
  }
  if (out.has(name)) throw new Error(`onnx: duplicate initializer name ${name}`);
  // raw_data is little-endian float32 at an arbitrary (unaligned) offset: read it through a DataView.
  const view = new DataView(buf.buffer, buf.byteOffset + raw.start, bytes);
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) data[i] = view.getFloat32(i * 4, true);
  out.set(name, { dims, data });
}

function readGraph(buf: Uint8Array, start: number, end: number, out: Map<string, OnnxTensor>): void {
  for (const f of fields(buf, start, end)) {
    if (f.wire !== WIRE_LEN) continue;
    if (f.field === GRAPH_INITIALIZER) {
      readTensor(buf, f.start, f.end, out);
    } else if (f.field === GRAPH_NODE) {
      for (const attr of fields(buf, f.start, f.end)) {
        if (attr.field !== NODE_ATTRIBUTE || attr.wire !== WIRE_LEN) continue;
        for (const a of fields(buf, attr.start, attr.end)) {
          if ((a.field === ATTR_G || a.field === ATTR_GRAPHS) && a.wire === WIRE_LEN) {
            readGraph(buf, a.start, a.end, out);
          }
        }
      }
    }
  }
}

/**
 * Returns every float (data_type 1) TensorProto initializer that has raw_data, keyed by name, from the
 * model's main graph and all nested subgraphs. Throws on malformed protobuf, on a raw_data length that
 * doesn't match the dims, and on a duplicate initializer name.
 */
export function readOnnxInitializers(model: Uint8Array): Map<string, OnnxTensor> {
  const out = new Map<string, OnnxTensor>();
  for (const f of fields(model, 0, model.length)) {
    if (f.field === MODEL_GRAPH && f.wire === WIRE_LEN) readGraph(model, f.start, f.end, out);
  }
  return out;
}
