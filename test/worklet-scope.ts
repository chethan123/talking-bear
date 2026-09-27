// Vitest setup file of the `worklet` project: a stub AudioWorkletGlobalScope, so worklet modules run in Node
// (plan §4.9.1). `class X extends AudioWorkletProcessor` runs when the module is evaluated, so the globals must
// exist before any test imports it: this file is a `setupFiles` entry, and tests load the worklet module with
// `await import(...)` inside the test.
//
// Globals: `sampleRate` (default 48000, see setSampleRate), a writable `currentFrame`, `AudioWorkletProcessor`
// (a base class with a MessageChannel port) and a capturing `registerProcessor`. Every port the stub opens is
// closed after each test, and `sampleRate` / `currentFrame` are reset.
//
// Test-only code: never imported by the app, the worklet or the worker.

import { afterEach } from 'vitest';

/** Render quantum size of the stub scope (the Web Audio default). */
export const QUANTUM = 128;
export const DEFAULT_SAMPLE_RATE = 48000;

/** What the stub needs from a processor instance. */
export interface ProcessorLike {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

export type ProcessorCtor = new (options?: unknown) => ProcessorLike;

/** The options the main thread passes to `new AudioWorkletNode(ctx, 'capture', …)` (plan §3.3, issue #32). */
export const DEFAULT_NODE_OPTIONS = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] };

/** Every class passed to registerProcessor, by name. */
export const processors = new Map<string, ProcessorCtor>();

/** Registry: processor instance → the main-thread end (port2) of its port's channel. */
const mainPorts = new WeakMap<object, MessagePort>();
const openPorts: MessagePort[] = [];

class AudioWorkletProcessorStub {
  readonly port: MessagePort;

  constructor() {
    const ch = new MessageChannel();
    this.port = ch.port1;
    mainPorts.set(this, ch.port2);
    openPorts.push(ch.port1, ch.port2);
  }
}

/** Defines or overwrites a writable global (the scope's globals are plain data properties here). */
function setGlobal(name: string, value: unknown): void {
  Reflect.set(globalThis, name, value);
}

setGlobal('sampleRate', DEFAULT_SAMPLE_RATE);
setGlobal('currentFrame', 0);
setGlobal('AudioWorkletProcessor', AudioWorkletProcessorStub);
setGlobal('registerProcessor', (name: string, cls: ProcessorCtor): void => {
  processors.set(name, cls);
});

afterEach(() => {
  for (const p of openPorts.splice(0)) p.close();
  setGlobal('sampleRate', DEFAULT_SAMPLE_RATE);
  setGlobal('currentFrame', 0);
});

/** Sets the global `sampleRate`. Processors read it when constructed, so call this before `create`. */
export function setSampleRate(n: number): void {
  setGlobal('sampleRate', n);
}

/** Constructs the processor registered as `name`; `mainPort` is the node-side end of `proc.port`. */
export function create(
  name: string,
  options: unknown = DEFAULT_NODE_OPTIONS,
): { proc: ProcessorLike; mainPort: MessagePort } {
  const cls = processors.get(name);
  if (cls === undefined) throw new Error(`no processor registered as '${name}'`);
  const proc = new cls(options);
  const mainPort = mainPorts.get(proc);
  if (mainPort === undefined) throw new Error(`'${name}' does not extend AudioWorkletProcessor`);
  return { proc, mainPort };
}

/**
 * Feeds `input` to `proc` in 128-frame quanta, setting the global `currentFrame` to `startFrame + k·128` before
 * the k-th `process()` call. `input` is one channel, or several channels of equal length; the length must be a
 * multiple of 128. Returns each quantum's output buffer (outputs[0][0]), pre-filled with NaN before the call
 * so a processor that leaves its output unwritten is visible.
 */
export function runQuanta(
  proc: ProcessorLike,
  input: Float32Array | readonly Float32Array[],
  startFrame: number,
): Float32Array[] {
  const channels: readonly Float32Array[] = input instanceof Float32Array ? [input] : input;
  const first = channels[0];
  if (first === undefined) throw new RangeError('runQuanta needs at least one input channel');
  const length = first.length;
  if (length % QUANTUM !== 0 || channels.some((ch) => ch.length !== length)) {
    throw new RangeError(`channels must share one length that is a multiple of ${QUANTUM} (got ${length})`);
  }
  const outputs: Float32Array[] = [];
  for (let at = 0; at < length; at += QUANTUM) {
    const inputs = [channels.map((ch) => ch.slice(at, at + QUANTUM))];
    const out = new Float32Array(QUANTUM).fill(Number.NaN);
    setGlobal('currentFrame', startFrame + at);
    proc.process(inputs, [[out]], {});
    outputs.push(out);
  }
  return outputs;
}

/** Awaits two macrotasks, so messages already posted on MessagePorts are delivered. */
export async function flushMessages(): Promise<void> {
  for (let i = 0; i < 2; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
