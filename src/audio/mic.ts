// Microphone manager (plan §3.4 "Pending mic opens", §4.1.1). It owns the getUserMedia stream and applies
// the stale-request rule: every open carries a request id, and a stream that arrives after a close() or a
// newer open() has every track stopped at once, so hiding the page while the prompt or the stream-open is
// pending can never leave a live mic behind. Kept apart from the engine so Node tests can drive it with a
// fake getUserMedia; it references no DOM value at module scope.

/** Plan §4.1.1: all browser processing off (no communication mode on Android; our own HPF and loudness). */
export const CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const;

export type MicResult =
  | { t: 'micGranted'; req: number; stream: MediaStream }
  | { t: 'micDenied'; req: number }
  | { t: 'noDevice'; req: number };

export type MicTrackEvent = 'mute' | 'unmute' | 'endedExternally';

export interface MicManager {
  /** Opens the mic for request `req`, which becomes the current one. */
  open(req: number, extra?: MediaTrackConstraints): Promise<MicResult | { t: 'stale'; req: number }>;
  /** Invalidates every pending request and stops all live tracks (marked as stopped by us). */
  close(): void;
  /** The current request's stream, or null. */
  current(): MediaStream | null;
  /** Track events of the current stream; `ended` is reported only for tracks we did not stop. */
  onTrackEvent(cb: (e: MicTrackEvent) => void): void;
}

/** The error name of a getUserMedia rejection (a DOMException), if it has one. */
function errorName(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('name' in err)) return undefined;
  const { name } = err;
  return typeof name === 'string' ? name : undefined;
}

export function createMicManager(gum: (c: MediaStreamConstraints) => Promise<MediaStream>): MicManager {
  // Each open() gets its own token, so a request number that is ever reused can't revive a stale open.
  let nextToken = 0;
  /** The token of the current request; 0 means none is current (after close()). */
  let currentToken = 0;
  let stream: MediaStream | null = null;
  const stoppedByUs = new WeakSet<MediaStreamTrack>();
  const listeners: ((e: MicTrackEvent) => void)[] = [];

  function report(e: MicTrackEvent): void {
    for (const cb of listeners) cb(e);
  }

  function stopTracks(s: MediaStream): void {
    for (const track of s.getTracks()) {
      stoppedByUs.add(track);
      track.stop();
    }
  }

  function watch(track: MediaStreamTrack): void {
    track.addEventListener('mute', () => {
      if (!stoppedByUs.has(track)) report('mute');
    });
    track.addEventListener('unmute', () => {
      if (!stoppedByUs.has(track)) report('unmute');
    });
    track.addEventListener('ended', () => {
      if (!stoppedByUs.has(track)) report('endedExternally');
    });
  }

  async function open(
    req: number,
    extra?: MediaTrackConstraints,
  ): Promise<MicResult | { t: 'stale'; req: number }> {
    const token = ++nextToken;
    currentToken = token;
    let s: MediaStream;
    try {
      s = await gum({ audio: { ...CONSTRAINTS, ...extra } });
    } catch (err) {
      if (token !== currentToken) return { t: 'stale', req };
      const name = errorName(err);
      return name === 'NotAllowedError' || name === 'SecurityError'
        ? { t: 'micDenied', req }
        : { t: 'noDevice', req };
    }
    if (token !== currentToken) {
      stopTracks(s); // a close() or a newer open() happened meanwhile: never keep this mic live
      return { t: 'stale', req };
    }
    if (stream !== null && stream !== s) stopTracks(stream); // only one live stream, ever
    stream = s;
    for (const track of s.getTracks()) watch(track);
    return { t: 'micGranted', req, stream: s };
  }

  function close(): void {
    currentToken = 0;
    if (stream !== null) stopTracks(stream);
    stream = null;
  }

  return {
    open,
    close,
    current: () => stream,
    onTrackEvent: (cb) => {
      listeners.push(cb);
    },
  };
}
