import { minEndWaitMs, outputContextTimeNow } from './output-clock.ts';

export interface PlayHandle {
  /** Context time at which the clip starts. */
  startCtxTime: number;
  /** Seconds the clip plays for at its playback rate. */
  durationSec: number;
  /** `'ended'` once the clip's last sample has left the speaker; `'stopped'` after `stop()`. */
  done: Promise<'ended' | 'stopped'>;
}

interface Current {
  src: AudioBufferSourceNode;
  settle: (r: 'ended' | 'stopped') => void;
}

const START_DELAY_SEC = 0.05;
const POLL_MS = 10;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * The voice player. `done` resolves `'ended'` only when the clip has physically left the speaker
 * (plan §3.4 "When 'playback ended' fires", §4.4 point 2), not at `onended`, which fires when
 * rendering stops: after `ended` it polls every 10 ms until the output clock has passed the clip's end
 * and at least `max(outputLatency, 50 ms)` has passed since `ended`, because Chrome reports zero delay
 * when AAudio's timestamp call fails.
 */
export function createPlayer(
  ctx: AudioContext,
  out: AudioNode,
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms)),
): {
  /** Plays `buffer` at `playbackRate`, stopping any current clip first. */
  play(buffer: AudioBuffer, playbackRate: number): PlayHandle;
  /** Stops the current clip and resolves its handle with `'stopped'`. */
  stop(): void;
} {
  let current: Current | null = null;

  const stop = (): void => {
    const c = current;
    if (c === null) return;
    current = null; // from here on this clip can never resolve 'ended'
    c.src.stop();
    c.src.disconnect();
    c.settle('stopped');
  };

  const waitAtSpeaker = async (c: Current, endCtxTime: number, tEnded: number): Promise<void> => {
    for (;;) {
      if (current !== c) return; // stopped, or replaced by a newer clip
      if (outputContextTimeNow(ctx) >= endCtxTime && performance.now() - tEnded >= minEndWaitMs(ctx)) {
        current = null;
        c.src.disconnect();
        c.settle('ended');
        return;
      }
      await sleep(POLL_MS);
    }
  };

  const play = (buffer: AudioBuffer, playbackRate: number): PlayHandle => {
    stop();
    const src = new AudioBufferSourceNode(ctx, { buffer, playbackRate });
    src.connect(out);
    const startCtxTime = ctx.currentTime + START_DELAY_SEC;
    const durationSec = buffer.duration / playbackRate;
    const { promise: done, resolve: settle } = deferred<'ended' | 'stopped'>();
    const c: Current = { src, settle };
    src.addEventListener(
      'ended',
      () => {
        waitAtSpeaker(c, startCtxTime + durationSec, performance.now()).catch((err: unknown) => {
          console.error('player: at-speaker wait failed', err);
        });
      },
      { once: true },
    );
    src.start(startCtxTime);
    current = c;
    return { startCtxTime, durationSec, done };
  };

  return { play, stop };
}
