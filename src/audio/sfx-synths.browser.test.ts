import { describe, expect, test } from 'vitest';
import type { SfxId } from './sfx-ids.ts';
import type { SfxSynth } from './sfx.ts';
import { type Chirps, chirps, envelope, type EnvPoint, MIN_ATTACK_SEC, run, SYNTHS } from './sfx-synths.ts';

/**
 * #88 check 1: the sample peak is ≤ −9 dBFS. 10^(−9/20) ≈ 0.35481, a hair under the issue's rounded 0.355.
 */
const PEAK_MAX = 10 ** (-9 / 20);
/** #88 check 3: `max|x|` over the first 1 ms is ≤ 0.2 × the overall peak. */
const ATTACK_WINDOW_SEC = 0.001;
const ATTACK_RATIO_MAX = 0.2;
/**
 * #88 check 4: after `dur + 10 ms` the render is silent, `max|x|` ≤ −60 dBFS, until the end of the buffer.
 */
const TAIL_GRACE_SEC = 0.01;
const SILENCE = 0.001;
/** #88: render into `OfflineAudioContext(1, 48000·3, 48000)`. */
const SAMPLE_RATE = 48000;
const RENDER_SEC = 3;

// Extra checks (not in #88) that keep the four above meaningful.
/** Every sfx is audible: its peak is ≥ −30 dBFS. */
const AUDIBLE_MIN = 10 ** (-30 / 20);
/** The duration fits the render with ≥ 0.99 s of tail to check: 0 < dur ≤ 2 s. */
const DUR_MAX_SEC = 2;
/** The returned duration is tight: the sound is still above −60 dBFS within 30 ms before it. */
const TIGHT_SEC = 0.03;
/** The common Android rate besides 48 kHz: the checks must hold there too. */
const OTHER_SAMPLE_RATE = 44100;

/** The ids #88 lists, then Fenn's (duck plan §4.6), spelled out, so that a missing or misspelled one fails. */
const ISSUE_IDS = [
  'sneeze',
  'bigSneeze',
  'boing',
  'purr',
  'hm',
  'hmph',
  'pop',
  'boingHehe',
  'giggle',
  'sigh',
  'squeal',
  'hi',
  'hey',
  'whoa',
  'rustle',
  'quack',
  'bigQuack',
  'nibble',
  'trill',
  'peep',
  'flap',
  'pat',
] as const satisfies readonly SfxId[];

/** Fenn's ids (duck plan §4.6), whose level rule is a sample peak of −10 ± 1 dBFS rendered alone at 48 kHz. */
const FENN_IDS = [
  'quack',
  'bigQuack',
  'nibble',
  'trill',
  'peep',
  'flap',
  'pat',
] as const satisfies readonly SfxId[];
const FENN_PEAK_DB = -10;
const FENN_PEAK_TOL_DB = 1;

/** Every id to check: #88's and Fenn's, plus whatever `SYNTHS` holds (`testBeep`). */
const IDS: readonly string[] = [...new Set<string>([...ISSUE_IDS, ...Object.keys(SYNTHS)])];

interface Render {
  data: Float32Array;
  sampleRate: number;
  /** The `when` the synth was given (s). */
  start: number;
  /** The duration the synth returned (s). */
  dur: number;
}

async function render(
  synth: SfxSynth,
  sampleRate = SAMPLE_RATE,
  when = 0,
  route: (ctx: OfflineAudioContext) => AudioNode = (ctx) => ctx.destination,
): Promise<Render> {
  const ctx = new OfflineAudioContext(1, RENDER_SEC * sampleRate, sampleRate);
  const dur = synth(ctx, route(ctx), when);
  const data = (await ctx.startRendering()).getChannelData(0);
  return { data, sampleRate, start: when, dur };
}

interface Measures {
  /** max|x| over the whole render (NaNs skipped). */
  peak: number;
  nans: number;
  /** max|x| over the first 1 ms after `start`. */
  attackPeak: number;
  /** max|x| from `start + dur + 10 ms` to the end of the buffer. */
  tailPeak: number;
  /** max|x| before `start`. */
  beforePeak: number;
  /** The time (s) of the last sample above −60 dBFS, or −1 if there is none. */
  lastLoudSec: number;
}

function measure(r: Render): Measures {
  const startIdx = Math.round(r.start * r.sampleRate);
  const attackEnd = startIdx + Math.round(ATTACK_WINDOW_SEC * r.sampleRate);
  const tailStart = Math.ceil((r.start + r.dur + TAIL_GRACE_SEC) * r.sampleRate);
  const m: Measures = { peak: 0, nans: 0, attackPeak: 0, tailPeak: 0, beforePeak: 0, lastLoudSec: -1 };
  let i = 0;
  for (const x of r.data) {
    if (Number.isNaN(x)) {
      m.nans++;
    } else {
      const a = Math.abs(x);
      m.peak = Math.max(m.peak, a);
      if (i < startIdx) m.beforePeak = Math.max(m.beforePeak, a);
      else if (i < attackEnd) m.attackPeak = Math.max(m.attackPeak, a);
      if (i >= tailStart) m.tailPeak = Math.max(m.tailPeak, a);
      if (a > SILENCE) m.lastLoudSec = i / r.sampleRate;
    }
    i++;
  }
  return m;
}

/** The names of the checks `r` fails: #88's four (`peak`, `nan`, `attack`, `tail`), then the extra ones. */
function failures(r: Render): string[] {
  const m = measure(r);
  const failed: string[] = [];
  if (!(m.peak <= PEAK_MAX)) failed.push('peak');
  if (m.nans > 0) failed.push('nan');
  if (!(m.attackPeak <= ATTACK_RATIO_MAX * m.peak)) failed.push('attack');
  if (!(m.tailPeak <= SILENCE)) failed.push('tail');
  if (!(m.peak >= AUDIBLE_MIN)) failed.push('audible');
  if (!(r.dur > 0 && r.dur <= DUR_MAX_SEC)) failed.push('duration');
  if (!(m.lastLoudSec >= r.start + r.dur - TIGHT_SEC)) failed.push('tight');
  if (!(m.beforePeak <= SILENCE)) failed.push('early');
  return failed;
}

function db(x: number): string {
  return `${(20 * Math.log10(x)).toFixed(2)} dBFS`;
}

function describeRender(r: Render): string {
  const m = measure(r);
  return (
    `dur ${r.dur} s, peak ${db(m.peak)}, NaNs ${m.nans}, first-ms ratio ${(m.attackPeak / m.peak).toFixed(3)}, ` +
    `tail ${m.tailPeak}, last > −60 dBFS at ${m.lastLoudSec.toFixed(4)} s, before start ${m.beforePeak}`
  );
}

// The `when` and `out` check: the synth rendered at `when` = 0.512 s into a 0.5 gain must match its render at
// 0 into `destination`, shifted and halved. 0.512 s is 24576 samples, a whole number of 128-sample render
// quanta.
const SHIFT_SEC = 0.512;
const OUT_GAIN = 0.5;
const WINDOW_SEC = 0.01;
const ENVELOPE_TOLERANCE = 0.005;

/** An `out` for `render`: a gain of `OUT_GAIN` into `destination`. */
function scaledOut(ctx: OfflineAudioContext): AudioNode {
  const out = new GainNode(ctx, { gain: OUT_GAIN });
  out.connect(ctx.destination);
  return out;
}

/** RMS per 10 ms window from `start`. */
function windowRms(r: Render): number[] {
  const n = Math.round(WINDOW_SEC * r.sampleRate);
  const from = Math.round(r.start * r.sampleRate);
  const rms: number[] = [];
  for (let w = from; w + n <= r.data.length; w += n) {
    let e = 0;
    for (const x of r.data.subarray(w, w + n)) e += x * x;
    rms.push(Math.sqrt(e / n));
  }
  return rms;
}

/**
 * The largest difference between `a`'s 10 ms RMS envelope scaled by `gain` and `b`'s, both from their
 * `start`. Comparing envelopes, not samples, ignores sub-sample start offsets.
 */
function envelopeMismatch(a: Render, b: Render, gain: number): number {
  const ea = windowRms(a);
  const eb = windowRms(b);
  let worst = 0;
  for (const [k, x] of eb.entries()) worst = Math.max(worst, Math.abs(x - gain * (ea[k] ?? 0)));
  return worst;
}

function synthFor(id: string): SfxSynth | undefined {
  return (SYNTHS as Partial<Record<string, SfxSynth>>)[id];
}

describe('SYNTHS', () => {
  test('holds exactly testBeep, the 15 ids of #88 and the 7 of duck plan §4.6 (23 ids)', () => {
    expect(Object.keys(SYNTHS).toSorted()).toEqual([...ISSUE_IDS, 'testBeep'].toSorted());
    expect(Object.keys(SYNTHS)).toHaveLength(23);
  });

  describe.each([SAMPLE_RATE, OTHER_SAMPLE_RATE])('rendered alone at %i Hz', (sampleRate) => {
    test.each(IDS)('%s: peak ≤ −9 dBFS, no NaN, ≥ 5 ms attack, silent after dur + 10 ms', async (id) => {
      const synth = synthFor(id);
      expect(synth, `SYNTHS.${id}`).toBeTypeOf('function');
      if (synth === undefined) return;
      const r = await render(synth, sampleRate);
      expect(failures(r), describeRender(r)).toEqual([]);
    });
  });

  test.each(IDS)('%s: scheduled at `when` and routed only through `out`', async (id) => {
    const synth = synthFor(id);
    expect(synth, `SYNTHS.${id}`).toBeTypeOf('function');
    if (synth === undefined) return;
    const atZero = await render(synth);
    const shifted = await render(synth, SAMPLE_RATE, SHIFT_SEC, scaledOut);
    expect(shifted.dur).toBe(atZero.dur);
    expect(failures(shifted), describeRender(shifted)).toEqual([]);
    expect(envelopeMismatch(atZero, shifted, OUT_GAIN)).toBeLessThanOrEqual(ENVELOPE_TOLERANCE);
  });

  test('the lengths #88 gives', () => {
    const ctx = new OfflineAudioContext(1, 128, SAMPLE_RATE);
    const dur = (id: SfxId): number => SYNTHS[id](ctx, ctx.destination, 0);
    expect(dur('sneeze')).toBeGreaterThanOrEqual(0.4); // ~0.5 s
    expect(dur('sneeze')).toBeLessThanOrEqual(0.6);
    expect(dur('purr')).toBe(1.2); // played in 1.2 s segments
    expect(dur('hm')).toBe(0.25);
    expect(dur('hmph')).toBe(0.3);
    expect(dur('pop')).toBe(0.06);
    expect(dur('sigh')).toBe(0.6);
    expect(dur('squeal')).toBe(0.35);
  });

  test.each(FENN_IDS)(
    '%s: sample peak −10 ± 1 dBFS rendered alone at 48 kHz (duck plan §4.6 level rule)',
    async (id) => {
      const r = await render(SYNTHS[id]);
      const peakDb = 20 * Math.log10(measure(r).peak);
      expect(Math.abs(peakDb - FENN_PEAK_DB), describeRender(r)).toBeLessThanOrEqual(FENN_PEAK_TOL_DB);
    },
  );

  test('the lengths duck plan §4.6 gives', () => {
    const ctx = new OfflineAudioContext(1, 128, SAMPLE_RATE);
    const dur = (id: SfxId): number => SYNTHS[id](ctx, ctx.destination, 0);
    expect(FENN_IDS.map(dur)).toEqual([0.22, 0.85, 0.29, 0.5, 0.12, 0.28, 0.12]);
  });

  test('bigSneeze is longer and louder than sneeze', async () => {
    const sneeze = await render(SYNTHS.sneeze);
    const big = await render(SYNTHS.bigSneeze);
    expect(big.dur).toBeGreaterThan(sneeze.dur);
    expect(measure(big).peak).toBeGreaterThan(measure(sneeze).peak);
  });
});

// Negative controls: synths that break one rule each.

/**
 * A 440 Hz sine under a raw (unchecked) envelope: `attack` s to `peak`, held, 50 ms release; ends at `dur`.
 */
function tone(peak: number, attack: number, dur: number, reported = dur): SfxSynth {
  return (ctx, out, when) => {
    const osc = new OscillatorNode(ctx, { type: 'sine', frequency: 440 });
    const env = new GainNode(ctx, { gain: 0 });
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(peak, when + attack);
    env.gain.setValueAtTime(peak, when + dur - 0.05);
    env.gain.linearRampToValueAtTime(0, when + dur);
    osc.connect(env).connect(out);
    osc.start(when);
    osc.stop(when + dur);
    return reported;
  };
}

/** Ramps to 0.25 over 20 ms, with 10 NaN samples at 50 ms. */
const nanBurst: SfxSynth = (ctx, out, when) => {
  const buffer = new AudioBuffer({ numberOfChannels: 1, length: 4800, sampleRate: ctx.sampleRate });
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (0.25 * Math.min(i, 960)) / 960; // a 20 ms ramp to 0.25
  data.fill(Number.NaN, 2400, 2410);
  const src = new AudioBufferSourceNode(ctx, { buffer });
  src.connect(out);
  src.start(when);
  return 0.1;
};

/** A band-pass with Q 30 after the envelope: it rings ~70 ms past the returned duration. */
const ringing: SfxSynth = (ctx, out, when) => {
  const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: 250 });
  const env = new GainNode(ctx, { gain: 0 });
  envelope(env.gain, when, [
    [0.01, 0.5],
    [0.15, 0.5],
    [0.2, 0],
  ]);
  const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1000, Q: 30 });
  osc.connect(env).connect(band).connect(out);
  osc.start(when);
  osc.stop(when + 0.2);
  return 0.2;
};

/** Makes no sound. */
const silent: SfxSynth = () => 0.2;

/** Ignores `when`: schedules at context time 0. */
const absolute: SfxSynth = (ctx, out) => tone(0.25, 0.01, 0.2)(ctx, out, 0);

/** Connects to `destination` instead of `out`. */
const bypass: SfxSynth = (ctx, _out, when) => tone(0.25, 0.01, 0.2)(ctx, ctx.destination, when);

describe('the checks catch broken synths (negative controls)', () => {
  test('a well-behaved control passes', async () => {
    const atZero = await render(tone(0.25, 0.01, 0.2));
    const shifted = await render(tone(0.25, 0.01, 0.2), SAMPLE_RATE, SHIFT_SEC, scaledOut);
    expect(failures(atZero)).toEqual([]);
    expect(failures(shifted)).toEqual([]);
    expect(envelopeMismatch(atZero, shifted, OUT_GAIN)).toBeLessThanOrEqual(ENVELOPE_TOLERANCE);
  });

  test('a peak of −8 dBFS fails `peak`', async () => {
    expect(failures(await render(tone(10 ** (-8 / 20), 0.01, 0.2)))).toEqual(['peak']);
  });

  test('a 1 ms attack fails `attack`', async () => {
    expect(failures(await render(tone(0.25, 0.001, 0.2)))).toEqual(['attack']);
  });

  test('a NaN in the output fails `nan`', async () => {
    expect(failures(await render(nanBurst))).toEqual(['nan']);
  });

  test('a band-pass after the envelope that rings past dur + 10 ms fails `tail`', async () => {
    expect(failures(await render(ringing))).toEqual(['tail']);
  });

  test('a duration reported 100 ms short fails `tail`', async () => {
    expect(failures(await render(tone(0.25, 0.01, 0.3, 0.2)))).toEqual(['tail']);
  });

  test('a duration reported 100 ms long fails `tight`', async () => {
    expect(failures(await render(tone(0.25, 0.01, 0.2, 0.3)))).toEqual(['tight']);
  });

  test('a synth that makes no sound fails `audible`', async () => {
    expect(failures(await render(silent))).toEqual(['audible', 'tight']);
  });

  test('a synth that schedules at absolute times fails the `when` check', async () => {
    const atZero = await render(absolute);
    const shifted = await render(absolute, SAMPLE_RATE, SHIFT_SEC, scaledOut);
    expect(failures(shifted)).toContain('early');
    expect(envelopeMismatch(atZero, shifted, OUT_GAIN)).toBeGreaterThan(ENVELOPE_TOLERANCE);
  });

  test('a synth that connects to `destination` instead of `out` fails the `out` check', async () => {
    const atZero = await render(bypass);
    const shifted = await render(bypass, SAMPLE_RATE, SHIFT_SEC, scaledOut);
    expect(failures(shifted)).toEqual([]);
    expect(envelopeMismatch(atZero, shifted, OUT_GAIN)).toBeGreaterThan(ENVELOPE_TOLERANCE);
  });

  test('envelope() rejects an attack faster than 5 ms, a steep rise later, a non-zero end and bad points', () => {
    const ctx = new OfflineAudioContext(1, 128, SAMPLE_RATE);
    const bad: readonly (readonly EnvPoint[])[] = [
      [
        [0.001, 0.3],
        [0.1, 0],
      ],
      [
        [MIN_ATTACK_SEC * 0.9, 0.3],
        [0.1, 0],
      ],
      [
        [0.02, 0.05],
        [0.022, 0.3],
        [0.1, 0],
      ],
      [
        [0.01, 0.3],
        [0.1, 0.1],
      ],
      [
        [0.01, 0.3],
        [0.01, 0],
      ],
      [
        [0.01, Number.NaN],
        [0.1, 0],
      ],
      [],
    ];
    for (const points of bad) {
      expect(() => envelope(new GainNode(ctx).gain, 0, points), JSON.stringify(points)).toThrow(RangeError);
    }
    expect(() =>
      envelope(new GainNode(ctx).gain, 0, [
        [MIN_ATTACK_SEC, 0.3],
        [0.1, 0],
      ]),
    ).not.toThrow();
  });

  test('envelope() returns the context time at which it is back at 0', () => {
    const ctx = new OfflineAudioContext(1, 128, SAMPLE_RATE);
    const end = envelope(new GainNode(ctx).gain, 0.5, [
      [0.01, 0.3],
      [0.1, 0],
    ]);
    expect(end).toBeCloseTo(0.6, 12);
  });

  test('run() rejects an envelope that ends after the duration, before it starts any source', () => {
    const ctx = new OfflineAudioContext(1, 128, SAMPLE_RATE);
    const env = new GainNode(ctx, { gain: 0 });
    const late = new OscillatorNode(ctx);
    expect(() => run([late], [env], [0.2 + 0.43], 0.2, 0.4)).toThrow(RangeError);
    expect(() => late.start(), 'run() did not start it').not.toThrow();
    const onTime = new OscillatorNode(ctx);
    expect(run([onTime], [env], [0.2 + 0.4, 0.2 + 0.1], 0.2, 0.4)).toBe(0.4);
    expect(() => onTime.start(), 'run() started it').toThrow();
  });

  test('chirps() rejects an envelope longer than the chirp, and overlapping chirps', () => {
    const ctx = new OfflineAudioContext(1, 128, SAMPLE_RATE);
    const c: Chirps = {
      notes: [
        [0, 1000],
        [0.09, 900],
      ],
      len: 0.06,
      glide: 0.9,
      vibratoHz: 30,
      vibratoCents: 50,
      env: [
        [0.008, 0.2],
        [0.07, 0],
      ],
    };
    expect(() => chirps(ctx, ctx.destination, 0, c)).toThrow(RangeError);
    const overlapping: Chirps = {
      ...c,
      notes: [
        [0, 1000],
        [0.05, 900],
      ],
      env: [
        [0.008, 0.2],
        [0.06, 0],
      ],
    };
    expect(() => chirps(ctx, ctx.destination, 0, overlapping)).toThrow(RangeError);
    const fits = chirps(ctx, ctx.destination, 0, {
      ...c,
      env: [
        [0.008, 0.2],
        [0.06, 0],
      ],
    });
    expect(fits.end).toBeCloseTo(0.15, 12);
  });
});
