import { afterEach, describe, expect, expectTypeOf, test } from 'vitest';

import { emptyEnvelope, PRESETS } from '../dsp/types.ts';
import { transferList } from './messages.ts';
import type {
  AudioMessage,
  MainToWorker,
  MainToWorklet,
  WorkerToMain,
  WorkletToMain,
  WorkletToWorker,
} from './messages.ts';

/** One factory per message kind of `U`; each call builds a fresh message with fresh buffers and ports. */
type Samples<U extends { t: string }> = { readonly [K in U['t']]: () => Extract<U, { t: K }> };

const openPorts: MessagePort[] = [];
const peers = new Map<MessagePort, MessagePort>();

/** A fresh channel; returns the end that goes into a message. Both ends are closed after each test. */
function port(): MessagePort {
  const { port1, port2 } = new MessageChannel();
  openPorts.push(port1, port2);
  peers.set(port1, port2);
  return port1;
}

afterEach(() => {
  for (const p of openPorts.splice(0)) p.close();
  peers.clear();
});

/** `n` distinct, exactly representable samples, so equality after a round trip is exact. */
function ramp(n: number, offset = 0): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => (offset + i) / 64);
}

// Exhaustive at compile time: the issue makes these two unions a tripwire (see the type-level test below),
// so a task that adds a kind to them edits this file and adds its sample here.
const mainToWorker: Samples<MainToWorker> = {
  reset: () => ({ t: 'reset', epoch: 3, vad: 'energy', restoreFloorDb: -47, pregate: true }),
  process: () => ({ t: 'process', id: 9, pcm: ramp(480), sampleRate: 48000, preset: PRESETS.cub }),
  init: () => ({ t: 'init', ctxRate: 48000, port: port() }),
};
const workerToMain: Samples<WorkerToMain> = {
  seg: () => ({ t: 'seg', epoch: 3, ev: { kind: 'start', frame: 52_800 } }),
  level: () => ({ t: 'level', epoch: 3, frame: 52_800, db: -38.5, floorDb: Number.NaN }),
  floorSnapshot: () => ({ t: 'floorSnapshot', epoch: 3, floorDb: -52.25 }),
  vadStats: () => ({ t: 'vadStats', p95Ms: 4.5 }),
  vadReady: () => ({ t: 'vadReady', backend: 'silero' }),
  processed: () => ({
    t: 'processed',
    id: 9,
    pcm: ramp(300),
    envelope: { hopMs: 10, jaw: ramp(7, 1), width: ramp(7, 2), round: ramp(7, 3), teeth: ramp(7, 4) },
    durationSec: 0.00625,
    clipped: true,
  }),
  error: () => ({ t: 'error', where: 'fx', message: 'boom' }),
};

// Partial: a later task may extend these unions without listing this file in its Scope. Today every kind
// has a sample; `transferList`'s exhaustive switch still forces that task to decide the new kind's transfers.
const mainToWorklet: Partial<Samples<MainToWorklet>> = {
  arm: () => ({ t: 'arm', epoch: 3 }),
  disarm: () => ({ t: 'disarm', epoch: 3 }),
  take: () => ({ t: 'take', epoch: 3, id: 9, fromFrame: 38_400, toFrame: 158_400 }),
  init: () => ({ t: 'init', port: port() }),
};
const workletToWorker: Partial<Samples<WorkletToWorker>> = {
  frame: () => ({ t: 'frame', epoch: 3, firstFrame: 52_800, pcm16k: ramp(512) }),
};
const workletToMain: Partial<Samples<WorkletToMain>> = {
  armed: () => ({ t: 'armed', epoch: 3, armFrame: 48_000 }),
  clipChunk: () => ({
    t: 'clipChunk',
    epoch: 3,
    id: 9,
    seq: 0,
    last: true,
    pcm: ramp(1200),
    sampleRate: 48000,
  }),
  takeFailed: () => ({ t: 'takeFailed', epoch: 3, id: 9, reason: 'evicted' }),
};

type Factory = () => AudioMessage;

function named(direction: string, table: { readonly [t: string]: Factory | undefined }): [string, Factory][] {
  return Object.entries(table).flatMap(([t, make]): [string, Factory][] =>
    make ? [[`${direction} ${t}`, make]] : [],
  );
}

const cases: [string, Factory][] = [
  ...named('MainToWorklet', mainToWorklet),
  ...named('WorkletToWorker', workletToWorker),
  ...named('WorkletToMain', workletToMain),
  ...named('MainToWorker', mainToWorker),
  ...named('WorkerToMain', workerToMain),
  // An envelope with four zero-length tracks (emptyEnvelope()): zero-length buffers are transferred too.
  [
    'WorkerToMain processed (empty envelope)',
    () => ({
      t: 'processed',
      id: 10,
      pcm: ramp(64),
      envelope: emptyEnvelope(),
      durationSec: 0.001,
      clipped: false,
    }),
  ],
];

/** Every ArrayBuffer (behind a typed array) and MessagePort reachable from `v`: the independent oracle. */
function reachableTransferables(v: unknown, out = new Set<unknown>()): Set<unknown> {
  if (ArrayBuffer.isView(v)) out.add(v.buffer);
  else if (v instanceof MessagePort) out.add(v);
  else if (typeof v === 'object' && v !== null)
    for (const x of Object.values(v)) reachableTransferables(x, out);
  return out;
}

/** `v` with every MessagePort replaced by a marker (a transferred port is a new object by design). */
function withoutPorts(v: unknown): unknown {
  if (v instanceof MessagePort) return '[MessagePort]';
  if (ArrayBuffer.isView(v) || typeof v !== 'object' || v === null) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutPorts(x)]));
}

/** Resolves with the first message that `end` receives after `peer` posts 'ping'. */
function pingThrough(end: MessagePort, peer: MessagePort): Promise<unknown> {
  const received = new Promise<unknown>((resolve) => {
    end.addEventListener('message', (e) => resolve(e.data), { once: true });
  });
  end.start();
  peer.postMessage('ping', []);
  return received;
}

describe('transferList + structuredClone', () => {
  test('every union member has a sample', () => {
    expect(cases.map(([name]) => name)).toEqual([
      'MainToWorklet arm',
      'MainToWorklet disarm',
      'MainToWorklet take',
      'MainToWorklet init',
      'WorkletToWorker frame',
      'WorkletToMain armed',
      'WorkletToMain clipChunk',
      'WorkletToMain takeFailed',
      'MainToWorker reset',
      'MainToWorker process',
      'MainToWorker init',
      'WorkerToMain seg',
      'WorkerToMain level',
      'WorkerToMain floorSnapshot',
      'WorkerToMain vadStats',
      'WorkerToMain vadReady',
      'WorkerToMain processed',
      'WorkerToMain error',
      'WorkerToMain processed (empty envelope)',
    ]);
  });

  test.each(cases)('%s round-trips with equal values and detached buffers', async (_name, make) => {
    const expected = make();
    const msg = make();
    const transfer = transferList(msg);

    // Exactly the buffers and ports the message holds (by identity), each once.
    const reachable = reachableTransferables(msg);
    expect(new Set(transfer).size).toBe(transfer.length);
    expect(transfer.length).toBe(reachable.size);
    expect(transfer.every((x) => reachable.has(x))).toBe(true);

    const buffers = transfer.filter((x): x is ArrayBuffer => x instanceof ArrayBuffer);
    const clone = structuredClone(msg, { transfer });

    expect(withoutPorts(clone)).toStrictEqual(withoutPorts(expected));
    for (const buffer of buffers) expect(buffer.byteLength).toBe(0);

    if ('port' in msg && 'port' in clone) {
      expect(clone.port).toBeInstanceOf(MessagePort);
      expect(clone.port).not.toBe(msg.port);
      openPorts.push(clone.port);
      const peer = peers.get(msg.port);
      expect(peer).toBeDefined();
      if (peer) await expect(pingThrough(clone.port, peer)).resolves.toBe('ping');
    }
  });

  test('non-empty buffers are really detached, not just empty', () => {
    const msg = workerToMain.processed();
    const views = [msg.pcm, msg.envelope.jaw, msg.envelope.width, msg.envelope.round, msg.envelope.teeth];
    const sizes = views.map((v) => v.buffer.byteLength);
    expect(sizes.every((n) => n > 0)).toBe(true);
    structuredClone(msg, { transfer: transferList(msg) });
    expect(views.map((v) => v.length)).toEqual([0, 0, 0, 0, 0]);
  });

  test('a buffer shared by several views is listed once, so the transfer succeeds', () => {
    const backing = new ArrayBuffer(4 * 4 * 8);
    const track = (i: number): Float32Array => new Float32Array(backing, i * 32, 8).fill(i + 1);
    const msg: WorkerToMain = {
      t: 'processed',
      id: 11,
      pcm: ramp(16),
      envelope: { hopMs: 10, jaw: track(0), width: track(1), round: track(2), teeth: track(3) },
      durationSec: 0.001,
      clipped: false,
    };
    const transfer = transferList(msg);
    expect(transfer).toHaveLength(2);
    expect(transfer).toContain(backing);
    const clone = structuredClone(msg, { transfer });
    expect(clone.t === 'processed' && Array.from(clone.envelope.round)).toEqual(Array(8).fill(3));
    expect(backing.byteLength).toBe(0);
  });

  test('a SharedArrayBuffer-backed pcm is shared, not transferred', () => {
    const pcm = new Float32Array(new SharedArrayBuffer(16));
    const msg: MainToWorker = { t: 'process', id: 12, pcm, sampleRate: 48000, preset: PRESETS.chipmunk };
    expect(transferList(msg)).toEqual([]);
  });
});

describe('dsp types', () => {
  test('emptyEnvelope() has four zero-length tracks and fresh buffers on every call', () => {
    const a = emptyEnvelope();
    const b = emptyEnvelope();
    expect(a.hopMs).toBe(10);
    for (const e of [a, b]) {
      expect([e.jaw.length, e.width.length, e.round.length, e.teeth.length]).toEqual([0, 0, 0, 0]);
    }
    const buffers = [a, b].flatMap((e) => [e.jaw.buffer, e.width.buffer, e.round.buffer, e.teeth.buffer]);
    expect(new Set(buffers).size).toBe(8);
  });

  test('each preset is keyed by its own id and has a positive pitch ratio', () => {
    for (const [key, preset] of Object.entries(PRESETS)) {
      expect(preset.id).toBe(key);
      expect(preset.pitchRatio).toBeGreaterThan(0);
    }
  });
});

describe('message kinds (type-level tripwire, checked by `pnpm typecheck`)', () => {
  test('WorkerToMain and MainToWorker have exactly the listed kinds', () => {
    expectTypeOf<WorkerToMain['t']>().toEqualTypeOf<
      'seg' | 'level' | 'floorSnapshot' | 'vadStats' | 'vadReady' | 'processed' | 'error'
    >();
    expectTypeOf<MainToWorker['t']>().toEqualTypeOf<'reset' | 'process' | 'init'>();
  });
});
