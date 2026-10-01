// Node tests of the e2e output-tap AudioWorklet processor `test-tap` (issue #36; allowed by ORCH-ANSWER
// 5856735346 on #36) against the stub AudioWorkletGlobalScope in test/worklet-scope.ts. They pin what the e2e
// specs rely on: the tap passes its input to its output unchanged, and it posts every input block, in order, to
// its port. The module is loaded with `await import(...)` inside each test, after the setup file has defined the
// scope (plan §4.9.1).

import { describe, expect, test } from 'vitest';

import { mulberry32 } from '../../test/dsp-helpers.ts';
import { create, flushMessages, QUANTUM } from '../../test/worklet-scope.ts';
import type { ProcessorLike } from '../../test/worklet-scope.ts';

/** Frames per posted block: 8 quanta (the worklet's BLOCK; the first test pins it). */
const BLOCK = 1024;
const NODE_OPTIONS = { numberOfInputs: 1, numberOfOutputs: 1 };

function noise(n: number, seed: number): Float32Array {
  const rng = mulberry32(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 2 * rng() - 1;
  return x;
}

/** A tap and the blocks it has posted so far (read them after flushMessages()). */
async function tap(): Promise<{ proc: ProcessorLike; posted: Float32Array[] }> {
  const worklet = await import('./test-tap.worklet.ts');
  expect(worklet.BLOCK).toBe(BLOCK);
  const { proc, mainPort } = create('test-tap', NODE_OPTIONS);
  const posted: Float32Array[] = [];
  mainPort.addEventListener('message', (e: MessageEvent<unknown>) => {
    if (!(e.data instanceof Float32Array))
      throw new Error('test-tap posted something other than a Float32Array');
    posted.push(e.data);
  });
  mainPort.start(); // addEventListener, unlike the onmessage setter, doesn't start the port
  return { proc, posted };
}

/**
 * Runs one quantum: `channels` holds quantum `q` of each input channel (none = no active input). The output has
 * max(1, channels) channels, zero-filled as the render thread does. Returns the output channels.
 */
function quantum(proc: ProcessorLike, channels: readonly Float32Array[], q: number): Float32Array[] {
  const input = channels.map((ch) => ch.slice(q * QUANTUM, (q + 1) * QUANTUM));
  const output = Array.from({ length: Math.max(1, channels.length) }, () => new Float32Array(QUANTUM));
  expect(proc.process([input], [output], {})).toBe(true);
  return output;
}

function concat(blocks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

describe('test-tap worklet', () => {
  test('passes every input channel to the same output channel unchanged', async () => {
    const { proc } = await tap();
    const left = noise(16 * QUANTUM, 1);
    const right = noise(16 * QUANTUM, 2);
    for (let q = 0; q < 16; q++) {
      const [outL, outR] = quantum(proc, [left, right], q);
      expect(outL).toEqual(left.slice(q * QUANTUM, (q + 1) * QUANTUM));
      expect(outR).toEqual(right.slice(q * QUANTUM, (q + 1) * QUANTUM));
    }
    const mono = noise(4 * QUANTUM, 3);
    for (let q = 0; q < 4; q++) {
      const [out] = quantum(proc, [mono], q);
      expect(out).toEqual(mono.slice(q * QUANTUM, (q + 1) * QUANTUM));
    }
  });

  test('posts every mono input block, in order, in blocks of 1024 frames; a partial block waits', async () => {
    const { proc, posted } = await tap();
    const x = noise(5 * BLOCK + 3 * QUANTUM, 4); // 5 full blocks and 3 quanta of a sixth
    for (let q = 0; q < x.length / QUANTUM; q++) quantum(proc, [x], q);
    await flushMessages();
    expect(posted.map((b) => b.length)).toEqual([BLOCK, BLOCK, BLOCK, BLOCK, BLOCK]);
    expect(concat(posted)).toEqual(x.slice(0, 5 * BLOCK));
  });

  test('posts the mean of the input channels, and zeros for quanta without an active input', async () => {
    const { proc, posted } = await tap();
    const left = noise(BLOCK, 5);
    const right = noise(BLOCK, 6);
    for (let q = 0; q < BLOCK / QUANTUM; q++) quantum(proc, [left, right], q);
    for (let q = 0; q < BLOCK / QUANTUM; q++) {
      const [out] = quantum(proc, [], q);
      expect(out).toEqual(new Float32Array(QUANTUM)); // no input: the output stays silent
    }
    await flushMessages();
    expect(posted).toHaveLength(2);
    expect(posted[0]).toEqual(Float32Array.from(left, (l, i) => (l + right[i]!) / 2));
    expect(posted[1]).toEqual(new Float32Array(BLOCK));
  });
});
