/**
 * Fixed-capacity, single-producer, frame-indexed ring buffer of `Float32Array` samples.
 *
 * The capture worklet writes every 128-frame quantum into it, continuously, and serves `take` requests
 * by absolute frame range (plan §3.1, §3.3). Frames are indexed in one canonical timeline, the capture
 * frame index; the buffer keeps the newest `capacity` frames. For the worklet the capacity is
 * `Math.ceil(12 * sampleRate)`: 12 s at the context rate (plan §4.1.2).
 *
 * `write` and `readInto` never allocate, so both are safe on the audio render thread.
 */
export class RingBuffer {
  readonly capacity: number;

  readonly #data: Float32Array;
  /** First frame ever written, set by the first write. NaN while empty. */
  #base = Number.NaN;
  /** One past the newest stored frame. NaN while empty. */
  #end = Number.NaN;
  #gapCount = 0;
  #gapFrames = 0;

  /** @throws RangeError unless `capacityFrames` is an integer ≥ 1. */
  constructor(capacityFrames: number) {
    if (!Number.isSafeInteger(capacityFrames) || capacityFrames < 1) {
      throw new RangeError('capacity must be an integer >= 1');
    }
    this.capacity = capacityFrames;
    this.#data = new Float32Array(capacityFrames);
  }

  /** True until the first successful write sets the base. */
  get isEmpty(): boolean {
    return Number.isNaN(this.#end);
  }

  /** Oldest frame index still stored (inclusive). NaN while empty. */
  get startFrame(): number {
    return Math.max(this.#base, this.#end - this.capacity);
  }

  /** One past the newest stored frame. NaN while empty. */
  get endFrame(): number {
    return this.#end;
  }

  /** Number of write() calls that found a gap. */
  get gapCount(): number {
    return this.#gapCount;
  }

  /** Total length of the gaps found by write(); a gap counts in full even when longer than `capacity`. */
  get gapFrames(): number {
    return this.#gapFrames;
  }

  /**
   * Appends `block` as frames `[startFrame, startFrame + block.length)`. Must not allocate.
   *
   * - The first write on an empty buffer sets the base (`startFrame = endFrame = startFrame`).
   * - `startFrame < endFrame` throws `RangeError('overlap')`.
   * - `startFrame > endFrame` zero-fills the gap first and counts it in `gapCount` and `gapFrames`.
   * - Blocks and zero-fill runs longer than `capacity` keep only their last `capacity` frames.
   * - Afterwards `startFrame = max(base, endFrame − capacity)`.
   *
   * A write that throws leaves the buffer unchanged.
   *
   * @throws RangeError on a non-integer `startFrame`, or on an overlap.
   */
  write(block: Float32Array, startFrame: number): void {
    const newEnd = startFrame + block.length;
    if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(newEnd)) {
      throw new RangeError('frame index must be an integer');
    }
    if (this.isEmpty) {
      this.#base = startFrame;
      this.#end = startFrame;
    } else if (startFrame < this.#end) {
      throw new RangeError('overlap');
    }
    // Frames before keepFrom are evicted by this write, so they are never stored.
    const keepFrom = newEnd - this.capacity;
    if (startFrame > this.#end) {
      this.#gapCount += 1;
      this.#gapFrames += startFrame - this.#end;
      const zeroFrom = Math.max(this.#end, keepFrom);
      if (zeroFrom < startFrame) this.#zero(zeroFrom, startFrame - zeroFrom);
    }
    const blockFrom = Math.max(startFrame, keepFrom);
    this.#copyIn(block, blockFrom - startFrame, blockFrom, newEnd - blockFrom);
    this.#end = newEnd;
  }

  /**
   * New array of toFrame−fromFrame samples: frames `[fromFrame, toFrame)`.
   *
   * @throws RangeError when the buffer is empty, an index is not an integer, `fromFrame > toFrame`,
   *   `fromFrame < startFrame` (evicted) or `toFrame > endFrame` (not yet written).
   */
  read(fromFrame: number, toFrame: number): Float32Array {
    this.#check(fromFrame, toFrame);
    const out = new Float32Array(toFrame - fromFrame);
    this.#copyOut(fromFrame, out);
    return out;
  }

  /**
   * Fills out with frames [fromFrame, fromFrame+out.length). Must not allocate.
   *
   * @throws RangeError under the same rules as `read`, with `toFrame = fromFrame + out.length`;
   *   `out` is left untouched.
   */
  readInto(fromFrame: number, out: Float32Array): void {
    this.#check(fromFrame, fromFrame + out.length);
    this.#copyOut(fromFrame, out);
  }

  #check(fromFrame: number, toFrame: number): void {
    if (!Number.isSafeInteger(fromFrame) || !Number.isSafeInteger(toFrame)) {
      throw new RangeError('frame index must be an integer');
    }
    if (this.isEmpty) throw new RangeError('empty');
    if (fromFrame > toFrame) throw new RangeError('fromFrame > toFrame');
    if (fromFrame < this.startFrame) throw new RangeError('evicted');
    if (toFrame > this.#end) throw new RangeError('not yet written');
  }

  /** Storage slot of `frame` (a positive modulo, so negative frames work too). */
  #index(frame: number): number {
    const i = frame % this.capacity;
    return i < 0 ? i + this.capacity : i;
  }

  /** Zeroes `count ≤ capacity` frames from `frame` on. */
  #zero(frame: number, count: number): void {
    const data = this.#data;
    const at = this.#index(frame);
    const first = Math.min(count, this.capacity - at);
    data.fill(0, at, at + first);
    if (count > first) data.fill(0, 0, count - first);
  }

  /** Stores `block[offset … offset+count)` as `count ≤ capacity` frames from `frame` on. */
  #copyIn(block: Float32Array, offset: number, frame: number, count: number): void {
    const data = this.#data;
    const at = this.#index(frame);
    const first = Math.min(count, this.capacity - at);
    for (let i = 0; i < first; i++) data[at + i] = block[offset + i]!;
    for (let i = first; i < count; i++) data[i - first] = block[offset + i]!;
  }

  /** Copies frames `[frame, frame + out.length)`, already checked, into `out`. */
  #copyOut(frame: number, out: Float32Array): void {
    const data = this.#data;
    const count = out.length;
    const at = this.#index(frame);
    const first = Math.min(count, this.capacity - at);
    for (let i = 0; i < first; i++) out[i] = data[at + i]!;
    for (let i = first; i < count; i++) out[i] = data[i - first]!;
  }
}
