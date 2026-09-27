// float32 → IEEE 754 binary16 (fp16) encoder for scripts/extract-silero-weights.ts.
// Round-to-nearest-even, with correct subnormals. A value that would round to ±Inf, and a NaN or
// ±Infinity input, is an error: the Silero weights must stay finite.
// The runtime decoder is fp16ToFp32 in src/dsp/silero/weights.ts.

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/**
 * Encodes `value`, first rounded to float32 (every input the extractor passes is already a float32),
 * as fp16 bits (0 … 0xffff), rounding to nearest, ties to even.
 * @throws {RangeError} if `value` is NaN or ±Infinity, or its magnitude rounds to fp16 infinity (≥ 65520).
 */
export function fp32ToFp16Bits(value: number): number {
  F32[0] = value;
  const x = U32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp32 = (x >>> 23) & 0xff;
  const mant32 = x & 0x7f_ffff;
  if (exp32 === 0xff) throw new RangeError(`fp16: cannot encode non-finite value ${value}`);
  // fp16 biased exponent for a normal result.
  const exp16 = exp32 - 127 + 15;
  if (exp16 >= 31) throw new RangeError(`fp16: ${value} overflows to infinity`);
  if (exp16 <= 0) {
    // fp16 subnormal (or zero): the result is round(M · 2^(exp16 − 14)) units of 2^-24, where M is the
    // 24-bit significand with its implicit bit. f32 subnormals (exp32 = 0) are far below 2^-25 and
    // take the shift > 24 branch.
    const shift = 14 - exp16;
    if (shift > 24) return sign;
    const m = mant32 | 0x80_0000;
    let q = m >>> shift;
    const rem = m & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && (q & 1) === 1)) q += 1;
    // q may reach 0x400: the smallest normal, which is exactly its own bit pattern.
    return sign | q;
  }
  let h = sign | (exp16 << 10) | (mant32 >>> 13);
  const rem = mant32 & 0x1fff;
  // A carry out of the mantissa correctly increments the exponent.
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1) === 1)) h += 1;
  if ((h & 0x7fff) >= 0x7c00) throw new RangeError(`fp16: ${value} overflows to infinity`);
  return h;
}

/** Encodes every value with fp32ToFp16Bits, as little-endian fp16, back to back (2 bytes per value). */
export function encodeFp16LE(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) view.setUint16(i * 2, fp32ToFp16Bits(values[i]!), true);
  return out;
}
