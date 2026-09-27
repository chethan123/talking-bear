import { describe, expect, it } from 'vitest';
import { CONSTRAINTS, createMicManager, type MicTrackEvent } from './mic.ts';

class FakeTrack extends EventTarget {
  muted = false;
  readyState: 'live' | 'ended' = 'live';
  stopCalls = 0;
  stop(): void {
    this.stopCalls++;
    this.readyState = 'ended';
  }
}

interface FakeStream {
  tracks: FakeTrack[];
  stream: MediaStream;
}

/** The manager only calls getTracks() on a stream (and the engine getAudioTracks()); the fake has both. */
function isStreamLike(v: object): v is MediaStream {
  return 'getTracks' in v && 'getAudioTracks' in v;
}

function fakeStream(trackCount = 2): FakeStream {
  const tracks = Array.from({ length: trackCount }, () => new FakeTrack());
  const shape = { getTracks: () => [...tracks], getAudioTracks: () => [...tracks] };
  if (!isStreamLike(shape)) throw new Error('unreachable: the fake stream has getTracks and getAudioTracks');
  return { tracks, stream: shape };
}

interface Pending {
  constraints: MediaStreamConstraints;
  resolve(s: MediaStream): void;
  reject(err: unknown): void;
}

/** A getUserMedia whose calls stay pending until the test resolves or rejects them, in any order. */
function fakeGum(): { gum: (c: MediaStreamConstraints) => Promise<MediaStream>; calls: Pending[] } {
  const calls: Pending[] = [];
  const gum = (constraints: MediaStreamConstraints): Promise<MediaStream> =>
    new Promise<MediaStream>((resolve, reject) => {
      calls.push({ constraints, resolve, reject });
    });
  return { gum, calls };
}

function call(calls: Pending[], i: number): Pending {
  const c = calls[i];
  if (c === undefined) throw new Error(`gum call ${i} was not made`);
  return c;
}

function setup(): {
  mic: ReturnType<typeof createMicManager>;
  calls: Pending[];
  events: MicTrackEvent[];
} {
  const { gum, calls } = fakeGum();
  const mic = createMicManager(gum);
  const events: MicTrackEvent[] = [];
  mic.onTrackEvent((e) => events.push(e));
  return { mic, calls, events };
}

function domError(name: string): DOMException {
  return new DOMException('fake', name);
}

describe('createMicManager', () => {
  it('requests exactly the §4.1.1 constraints, merged with extra ones', async () => {
    const { mic, calls } = setup();
    const p1 = mic.open(1);
    expect(call(calls, 0).constraints).toStrictEqual({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    expect(CONSTRAINTS).toStrictEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    const p2 = mic.open(2, { deviceId: { exact: 'x' } });
    expect(call(calls, 1).constraints).toStrictEqual({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        deviceId: { exact: 'x' },
      },
    });
    call(calls, 0).reject(domError('AbortError'));
    call(calls, 1).reject(domError('AbortError'));
    await Promise.all([p1, p2]);
  });

  it('grants the current request and keeps its stream live', async () => {
    const { mic, calls } = setup();
    expect(mic.current()).toBeNull();
    const { tracks, stream } = fakeStream();
    const p = mic.open(1);
    call(calls, 0).resolve(stream);
    expect(await p).toStrictEqual({ t: 'micGranted', req: 1, stream });
    expect(mic.current()).toBe(stream);
    for (const t of tracks) expect(t.stopCalls).toBe(0);
  });

  it('stale by close: close() before gum resolves stops every track, returns stale, current() is null', async () => {
    const { mic, calls } = setup();
    const p = mic.open(1);
    mic.close();
    const { tracks, stream } = fakeStream(2);
    call(calls, 0).resolve(stream);
    expect(await p).toStrictEqual({ t: 'stale', req: 1 });
    for (const t of tracks) {
      expect(t.stopCalls).toBe(1);
      expect(t.readyState).toBe('ended');
    }
    expect(mic.current()).toBeNull();
  });

  it("stale by a newer open: resolving 1 then 2 stops 1's tracks and keeps 2's", async () => {
    const { mic, calls } = setup();
    const p1 = mic.open(1);
    const p2 = mic.open(2);
    const s1 = fakeStream();
    const s2 = fakeStream();
    call(calls, 0).resolve(s1.stream);
    expect(await p1).toStrictEqual({ t: 'stale', req: 1 });
    call(calls, 1).resolve(s2.stream);
    expect(await p2).toStrictEqual({ t: 'micGranted', req: 2, stream: s2.stream });
    for (const t of s1.tracks) expect(t.stopCalls).toBe(1);
    for (const t of s2.tracks) {
      expect(t.stopCalls).toBe(0);
      expect(t.readyState).toBe('live');
    }
    expect(mic.current()).toBe(s2.stream);
  });

  it('stale by a newer open, resolved in the other order (2 then 1)', async () => {
    const { mic, calls } = setup();
    const p1 = mic.open(1);
    const p2 = mic.open(2);
    const s1 = fakeStream();
    const s2 = fakeStream();
    call(calls, 1).resolve(s2.stream);
    expect(await p2).toStrictEqual({ t: 'micGranted', req: 2, stream: s2.stream });
    call(calls, 0).resolve(s1.stream);
    expect(await p1).toStrictEqual({ t: 'stale', req: 1 });
    for (const t of s1.tracks) expect(t.stopCalls).toBe(1);
    for (const t of s2.tracks) expect(t.stopCalls).toBe(0);
    expect(mic.current()).toBe(s2.stream);
  });

  describe('errors', () => {
    const cases: [string, unknown, 'micDenied' | 'noDevice'][] = [
      ['NotAllowedError', domError('NotAllowedError'), 'micDenied'],
      ['SecurityError', domError('SecurityError'), 'micDenied'],
      ['NotFoundError', domError('NotFoundError'), 'noDevice'],
      ['OverconstrainedError', domError('OverconstrainedError'), 'noDevice'],
      ['NotReadableError', domError('NotReadableError'), 'noDevice'],
      ['AbortError', domError('AbortError'), 'noDevice'],
      ['a plain TypeError', new TypeError('no mediaDevices'), 'noDevice'],
      ['a non-object rejection', 'nope', 'noDevice'],
    ];
    for (const [label, err, kind] of cases) {
      it(`${label} → ${kind}`, async () => {
        const { mic, calls } = setup();
        const p = mic.open(7);
        call(calls, 0).reject(err);
        expect(await p).toStrictEqual({ t: kind, req: 7 });
        expect(mic.current()).toBeNull();
      });
    }

    it('a rejection after close() is stale', async () => {
      const { mic, calls } = setup();
      const p = mic.open(1);
      mic.close();
      call(calls, 0).reject(domError('NotAllowedError'));
      expect(await p).toStrictEqual({ t: 'stale', req: 1 });
    });

    it('a rejection after a newer open() is stale', async () => {
      const { mic, calls } = setup();
      const p1 = mic.open(1);
      const p2 = mic.open(2);
      call(calls, 0).reject(domError('NotFoundError'));
      expect(await p1).toStrictEqual({ t: 'stale', req: 1 });
      call(calls, 1).reject(domError('NotAllowedError'));
      expect(await p2).toStrictEqual({ t: 'micDenied', req: 2 });
    });
  });

  describe('track events', () => {
    it('ended after close() is not reported', async () => {
      const { mic, calls, events } = setup();
      const { tracks, stream } = fakeStream();
      const p = mic.open(1);
      call(calls, 0).resolve(stream);
      await p;
      mic.close();
      for (const t of tracks) {
        expect(t.stopCalls).toBe(1);
        t.dispatchEvent(new Event('ended'));
      }
      expect(events).toStrictEqual([]);
      expect(mic.current()).toBeNull();
    });

    it('ended on a live track is reported once as endedExternally', async () => {
      const { mic, calls, events } = setup();
      const { tracks, stream } = fakeStream();
      const p = mic.open(1);
      call(calls, 0).resolve(stream);
      await p;
      tracks[0]?.dispatchEvent(new Event('ended'));
      expect(events).toStrictEqual(['endedExternally']);
    });

    it('mute / unmute on a live track are reported, and not after close()', async () => {
      const { mic, calls, events } = setup();
      const { tracks, stream } = fakeStream(1);
      const p = mic.open(1);
      call(calls, 0).resolve(stream);
      await p;
      const track = tracks[0]!;
      track.dispatchEvent(new Event('mute'));
      track.dispatchEvent(new Event('unmute'));
      expect(events).toStrictEqual(['mute', 'unmute']);
      mic.close();
      track.dispatchEvent(new Event('mute'));
      track.dispatchEvent(new Event('unmute'));
      expect(events).toStrictEqual(['mute', 'unmute']);
    });

    it('a stale stream never reports events', async () => {
      const { mic, calls, events } = setup();
      const { tracks, stream } = fakeStream();
      const p = mic.open(1);
      mic.close();
      call(calls, 0).resolve(stream);
      await p;
      for (const t of tracks) t.dispatchEvent(new Event('ended'));
      expect(events).toStrictEqual([]);
    });

    it('every listener gets each event', async () => {
      const { mic, calls, events } = setup();
      const second: MicTrackEvent[] = [];
      mic.onTrackEvent((e) => second.push(e));
      const { tracks, stream } = fakeStream(1);
      const p = mic.open(1);
      call(calls, 0).resolve(stream);
      await p;
      tracks[0]?.dispatchEvent(new Event('mute'));
      expect(events).toStrictEqual(['mute']);
      expect(second).toStrictEqual(['mute']);
    });
  });

  it('a second grant without close() stops the first stream, whose later ended is not reported', async () => {
    const { mic, calls, events } = setup();
    const s1 = fakeStream();
    const s2 = fakeStream();
    const p1 = mic.open(1);
    call(calls, 0).resolve(s1.stream);
    await p1;
    const p2 = mic.open(2);
    call(calls, 1).resolve(s2.stream);
    expect(await p2).toStrictEqual({ t: 'micGranted', req: 2, stream: s2.stream });
    for (const t of s1.tracks) {
      expect(t.stopCalls).toBe(1);
      t.dispatchEvent(new Event('ended'));
    }
    for (const t of s2.tracks) expect(t.stopCalls).toBe(0);
    expect(events).toStrictEqual([]);
    expect(mic.current()).toBe(s2.stream);
  });

  it('a pending open after close() and a new open with the same req number is still stale', async () => {
    const { mic, calls } = setup();
    const p1 = mic.open(1);
    mic.close();
    const p2 = mic.open(1);
    const s1 = fakeStream();
    const s2 = fakeStream();
    call(calls, 0).resolve(s1.stream);
    expect(await p1).toStrictEqual({ t: 'stale', req: 1 });
    for (const t of s1.tracks) expect(t.stopCalls).toBe(1);
    call(calls, 1).resolve(s2.stream);
    expect(await p2).toStrictEqual({ t: 'micGranted', req: 1, stream: s2.stream });
  });
});
