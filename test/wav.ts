// WAV (RIFF/WAVE) reader and writer for tests, scripts and Browser Mode tests.
// Bytes in, bytes out: this module uses no Node APIs and depends on no other module.
//
// readWav accepts PCM 16-bit, PCM 32-bit and IEEE float 32-bit and throws on every other format
// (8/24-bit PCM, float64, WAVE_FORMAT_EXTENSIBLE, compressed formats, ...). Unknown chunks are skipped.
// writeWav emits the canonical 44-byte header followed by interleaved little-endian samples.

export type WavWriteFormat = 'pcm16' | 'float32';

export interface WavData {
  sampleRate: number;
  /** One array per channel, deinterleaved; every channel has the same length. */
  channels: Float32Array[];
}

const FORMAT_PCM = 1;
const FORMAT_IEEE_FLOAT = 3;
const MAX_U32 = 0xffffffff;

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function writeFourCC(view: DataView, offset: number, id: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, id.charCodeAt(i));
}

interface FmtChunk {
  formatTag: number;
  channelCount: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

/** Parses a RIFF/WAVE file. Throws on malformed input and on any format other than PCM16, PCM32 or float32. */
export function readWav(bytes: Uint8Array): WavData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.byteLength;
  if (length < 12) throw new Error(`not a WAV file: ${length} bytes is shorter than the RIFF header`);
  if (fourCC(view, 0) !== 'RIFF') throw new Error('not a WAV file: missing RIFF id');
  if (fourCC(view, 8) !== 'WAVE') throw new Error('not a WAV file: missing WAVE id');
  // The RIFF size covers everything after its own field: 'WAVE' plus the chunks. Chunks are read only
  // up to that declared end; bytes after it are ignored.
  const riffSize = view.getUint32(4, true);
  if (riffSize < 4) throw new Error(`invalid WAV: RIFF size ${riffSize} is smaller than the WAVE id`);
  if (8 + riffSize > length) {
    throw new Error(
      `invalid WAV: RIFF size ${riffSize} exceeds the ${length - 8} bytes after the RIFF header`,
    );
  }
  const end = 8 + riffSize;

  let fmt: FmtChunk | undefined;
  let dataOffset = -1;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= end) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > end) {
      throw new Error(`chunk '${id}' at byte ${offset} runs past the end of the RIFF container`);
    }
    if (id === 'fmt ') {
      if (fmt !== undefined) throw new Error("duplicate 'fmt ' chunk");
      if (size < 16) throw new Error(`'fmt ' chunk is ${size} bytes, expected at least 16`);
      fmt = {
        formatTag: view.getUint16(body, true),
        channelCount: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (dataOffset >= 0) throw new Error("duplicate 'data' chunk");
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size & 1);
  }
  if (fmt === undefined) throw new Error("missing 'fmt ' chunk");
  if (dataOffset < 0) throw new Error("missing 'data' chunk");

  const { formatTag, channelCount, sampleRate, blockAlign, bitsPerSample } = fmt;
  const pcm16 = formatTag === FORMAT_PCM && bitsPerSample === 16;
  const pcm32 = formatTag === FORMAT_PCM && bitsPerSample === 32;
  const float32 = formatTag === FORMAT_IEEE_FLOAT && bitsPerSample === 32;
  if (!pcm16 && !pcm32 && !float32) {
    throw new Error(
      `unsupported WAV format: tag ${formatTag}, ${bitsPerSample} bits (supported: PCM 16/32-bit, IEEE float 32-bit)`,
    );
  }
  if (channelCount === 0) throw new Error('invalid WAV: 0 channels');
  if (sampleRate === 0) throw new Error('invalid WAV: sample rate 0');
  const bytesPerSample = bitsPerSample / 8;
  if (blockAlign !== channelCount * bytesPerSample) {
    throw new Error(
      `invalid WAV: blockAlign ${blockAlign} != ${channelCount} channels × ${bytesPerSample} bytes`,
    );
  }
  if (dataSize % blockAlign !== 0) {
    throw new Error(`invalid WAV: data size ${dataSize} is not a multiple of blockAlign ${blockAlign}`);
  }

  const frames = dataSize / blockAlign;
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) channels.push(new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    const frameOffset = dataOffset + f * blockAlign;
    for (let c = 0; c < channelCount; c++) {
      const p = frameOffset + c * bytesPerSample;
      const channel = channels[c]!;
      if (pcm16) channel[f] = view.getInt16(p, true) / 32768;
      else if (pcm32) channel[f] = view.getInt32(p, true) / 2147483648;
      else channel[f] = view.getFloat32(p, true);
    }
  }
  return { sampleRate, channels };
}

/** Quantises one sample to PCM16: x·32768, NaN → 0, round half away from zero, clamp to [−32768, 32767]. */
function toPcm16(x: number): number {
  if (Number.isNaN(x)) return 0;
  const v = x * 32768;
  const r = v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5);
  return r < -32768 ? -32768 : r > 32767 ? 32767 : r;
}

/**
 * Encodes channels as a canonical 44-byte-header WAV file.
 * 'pcm16' rounds half away from zero and clamps to [−1, 1); 'float32' stores the values bit-exactly.
 */
export function writeWav(channels: Float32Array[], sampleRate: number, format: WavWriteFormat): Uint8Array {
  const channelCount = channels.length;
  if (channelCount === 0 || channelCount > 65535) {
    throw new RangeError(`channel count must be in [1, 65535], got ${channelCount}`);
  }
  const frames = channels[0]!.length;
  for (const channel of channels) {
    if (channel.length !== frames) throw new RangeError('all channels must have the same length');
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > MAX_U32) {
    throw new RangeError(`sample rate must be an integer in [1, 2^32 − 1], got ${sampleRate}`);
  }
  let formatTag: number;
  if (format === 'pcm16') formatTag = FORMAT_PCM;
  else if (format === 'float32') formatTag = FORMAT_IEEE_FLOAT;
  else throw new RangeError(`unknown WAV format '${String(format)}'`);

  const bytesPerSample = format === 'pcm16' ? 2 : 4;
  const blockAlign = channelCount * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frames * blockAlign;
  // Header fields are u16/u32: refuse values that would silently wrap.
  if (blockAlign > 65535) throw new RangeError(`blockAlign ${blockAlign} exceeds 65535`);
  if (byteRate > MAX_U32) throw new RangeError(`byte rate ${byteRate} exceeds 2^32 − 1`);
  if (36 + dataSize > MAX_U32) throw new RangeError(`RIFF size ${36 + dataSize} exceeds 2^32 − 1`);

  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeFourCC(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeFourCC(view, 8, 'WAVE');
  writeFourCC(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, formatTag, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeFourCC(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let p = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channelCount; c++) {
      const x = channels[c]![f]!;
      if (format === 'pcm16') {
        view.setInt16(p, toPcm16(x), true);
        p += 2;
      } else {
        view.setFloat32(p, x, true);
        p += 4;
      }
    }
  }
  return bytes;
}
