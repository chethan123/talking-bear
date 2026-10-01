// Extracts the Silero VAD v6 16 kHz weights from the pinned upstream ONNX file (plan §4.2.3, §7 M2) into
// src/dsp/silero/weights.bin (little-endian fp16, conv biases fp32, WEIGHTS_LAYOUT order, no header) and
// src/dsp/silero/weights.provenance.json. Asserts every ONNX initializer name and dims, and that the
// STFT basis is the periodic-Hann DFT that the TS port regenerates in code. Reruns are byte-identical.
//
// Usage: pnpm silero:extract (node scripts/extract-silero-weights.ts). Downloads and verifies the ONNX
// file first if .cache/silero/ doesn't hold it (see scripts/fetch-silero-onnx.ts). Exits 1 if the written
// weights.bin doesn't match WEIGHTS_SHA256 in src/dsp/silero/weights.ts.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  WEIGHTS_BYTES,
  WEIGHTS_LAYOUT,
  WEIGHTS_SHA256,
  type WeightsFormat,
} from '../src/dsp/silero/weights.ts';
import { encodeFp16LE } from './fp16.ts';
import { REPO_ROOT, SILERO_ONNX, ensureSileroOnnx, errorMessage, sha256Hex } from './fetch-silero-onnx.ts';
import { readOnnxInitializers, type OnnxTensor } from './onnx-reader.ts';

export const OUT_DIR = join(REPO_ROOT, 'src', 'dsp', 'silero');
export const STFT_BASIS_NAME = 'model.stft.forward_basis_buffer';
export const STFT_BASIS_DIMS = [258, 1, 256] as const;
/** Maximum |ONNX − regenerated| over the STFT basis. */
export const STFT_BASIS_TOLERANCE = 1e-6;

export interface ProvenanceEntry {
  key: string;
  onnxName: string;
  dims: number[];
  format: WeightsFormat;
  offsetBytes: number;
}

export interface Provenance {
  repo: string;
  commit: string;
  tag: string;
  path: string;
  onnxSha256: string;
  onnxBytes: number;
  weightsSha256: string;
  weightsBytes: number;
  format: 'fp16-le, conv biases fp32-le';
  order: ProvenanceEntry[];
  stftBasis: string;
  extractedWith: string;
  licence: string;
  copyright: string;
}

function sameDims(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((d, i) => d === b[i]);
}

function getTensor(inits: Map<string, OnnxTensor>, name: string, dims: readonly number[]): OnnxTensor {
  const t = inits.get(name);
  if (t === undefined) throw new Error(`ONNX initializer ${name} not found`);
  if (!sameDims(t.dims, dims))
    throw new Error(`ONNX initializer ${name}: dims [${t.dims.join(', ')}], expected [${dims.join(', ')}]`);
  return t;
}

/**
 * Largest |basis − regenerated| where the regenerated basis [258, 1, 256] is the periodic-Hann-windowed
 * DFT: row f (0 … 128) is cos(2πfk/256)·w[k], row 129 + f is −sin(2πfk/256)·w[k], and
 * w[k] = 0.5 − 0.5·cos(2πk/256).
 */
export function stftBasisMaxError(basis: Float32Array): number {
  let max = 0;
  for (let f = 0; f <= 128; f++) {
    for (let k = 0; k < 256; k++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / 256);
      const phase = (2 * Math.PI * f * k) / 256;
      max = Math.max(
        max,
        Math.abs(basis[f * 256 + k]! - Math.cos(phase) * w),
        Math.abs(basis[(129 + f) * 256 + k]! + Math.sin(phase) * w),
      );
    }
  }
  return max;
}

/**
 * Encodes every value as little-endian IEEE binary32, back to back (4 bytes per value). The values are float32
 * already, so this is exact.
 * @throws {RangeError} on NaN or ±Infinity: the Silero weights must stay finite.
 */
export function encodeFp32LE(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) throw new RangeError(`fp32: cannot encode non-finite value ${v}`);
    view.setFloat32(i * 4, v, true);
  }
  return out;
}

/** Matches a JSON array of numbers as JSON.stringify(value, null, 2) prints it, one element per line. */
const NUMBER_ARRAY = /\[\s*(-?\d[\d\s,.eE+-]*?)\s*\]/g;

/**
 * Serialises like JSON.stringify(value, null, 2) plus a final newline, but with number arrays on one line,
 * which is how Prettier prints them, so the committed file passes `prettier --check` unchanged.
 */
export function formatProvenance(p: Provenance): string {
  const json = JSON.stringify(p, null, 2);
  return `${json.replace(NUMBER_ARRAY, (_match, inner: string) => `[${inner.split(/\s*,\s*/).join(', ')}]`)}\n`;
}

export interface Extracted {
  weights: Uint8Array;
  provenance: Provenance;
}

export function extract(onnx: Uint8Array): Extracted {
  const inits = readOnnxInitializers(onnx);
  const basis = getTensor(inits, STFT_BASIS_NAME, STFT_BASIS_DIMS);
  const basisError = stftBasisMaxError(basis.data);
  if (!(basisError <= STFT_BASIS_TOLERANCE)) {
    throw new Error(
      `${STFT_BASIS_NAME} differs from the periodic-Hann DFT by ${basisError} (> ${STFT_BASIS_TOLERANCE})`,
    );
  }
  const weights = new Uint8Array(WEIGHTS_BYTES);
  const order: ProvenanceEntry[] = [];
  let offsetBytes = 0;
  for (const { key, onnxName, dims, format } of WEIGHTS_LAYOUT) {
    const t = getTensor(inits, onnxName, dims);
    let encoded: Uint8Array;
    try {
      encoded = format === 'fp32' ? encodeFp32LE(t.data) : encodeFp16LE(t.data);
    } catch (err) {
      throw new Error(`${onnxName}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (offsetBytes + encoded.byteLength > WEIGHTS_BYTES)
      throw new Error(`weights exceed ${WEIGHTS_BYTES} bytes`);
    weights.set(encoded, offsetBytes);
    order.push({ key, onnxName, dims: [...dims], format, offsetBytes });
    offsetBytes += encoded.byteLength;
  }
  if (offsetBytes !== WEIGHTS_BYTES)
    throw new Error(`weights are ${offsetBytes} bytes, expected ${WEIGHTS_BYTES}`);
  const provenance: Provenance = {
    repo: SILERO_ONNX.repo,
    commit: SILERO_ONNX.commit,
    tag: SILERO_ONNX.tag,
    path: SILERO_ONNX.path,
    onnxSha256: sha256Hex(onnx),
    onnxBytes: onnx.byteLength,
    weightsSha256: sha256Hex(weights),
    weightsBytes: WEIGHTS_BYTES,
    format: 'fp16-le, conv biases fp32-le',
    order,
    stftBasis: 'periodic-hann DFT, regenerated in code',
    extractedWith: 'scripts/extract-silero-weights.ts',
    licence: 'MIT',
    copyright: 'Copyright (c) 2020-present Silero Team',
  };
  return { weights, provenance };
}

async function main(): Promise<number> {
  let result: Extracted;
  try {
    result = extract(await ensureSileroOnnx());
  } catch (err) {
    console.error(`silero:extract: ${errorMessage(err)}`);
    return 1;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'weights.bin'), result.weights);
  writeFileSync(join(OUT_DIR, 'weights.provenance.json'), formatProvenance(result.provenance));
  console.log(
    `wrote src/dsp/silero/weights.bin (${result.weights.byteLength} bytes, sha256 ${result.provenance.weightsSha256})`,
  );
  console.log('wrote src/dsp/silero/weights.provenance.json');
  if (result.provenance.weightsSha256 !== WEIGHTS_SHA256) {
    // The pinned source is verified, so this only happens when the extractor or the layout changed.
    console.error(
      `silero:extract: weights.bin changed (SHA-256 ${result.provenance.weightsSha256}), but WEIGHTS_SHA256 in ` +
        `src/dsp/silero/weights.ts is ${WEIGHTS_SHA256}. Review why, then update WEIGHTS_SHA256.`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
