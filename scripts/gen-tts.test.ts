import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
  DOCKERFILE_PATH,
  HOP,
  SAMPLE_RATE,
  TEXTS_PATH,
  combo,
  labelSpans,
  parseDockerfile,
  parseManifest,
  parseTexts,
  planRenders,
} from './gen-tts.ts';

/** `x` filled with `amp` (a square wave of amplitude amp, so every 10 ms hop has energy amp²) over [from, to). */
function block(x: Float32Array, from: number, to: number, amp: number): void {
  for (let i = from; i < to; i++) x[i] = i % 2 === 0 ? amp : -amp;
}

const ms = (n: number): number => n * (SAMPLE_RATE / 1000);

describe('labelSpans', () => {
  test('speech is every hop strictly above max hop dB − 35 dB', () => {
    const x = new Float32Array(ms(300));
    block(x, 0, ms(100), 0.5);
    block(x, ms(100), ms(200), 0.5 * 10 ** (-34.9 / 20)); // −34.9 dB: speech
    block(x, ms(200), ms(300), 0.5 * 10 ** (-35.1 / 20)); // −35.1 dB: not speech
    expect(labelSpans(x, 0)).toEqual([[0, ms(200)]]);
  });

  test('merges gaps shorter than the merge gap, then drops runs shorter than 50 ms', () => {
    const x = new Float32Array(ms(1000));
    block(x, 0, ms(100), 0.5);
    block(x, ms(240), ms(340), 0.5); // 140 ms gap: merged at 150 ms
    block(x, ms(490), ms(590), 0.5); // 150 ms gap: kept apart at 150 ms, merged at 300 ms
    block(x, ms(800), ms(840), 0.5); // 40 ms run after a 210 ms gap: dropped at 150 ms
    expect(labelSpans(x, 150)).toEqual([
      [0, ms(340)],
      [ms(490), ms(590)],
    ]);
    expect(labelSpans(x, 300)).toEqual([[0, ms(840)]]);
    expect(labelSpans(x, 0)).toEqual([
      [0, ms(100)],
      [ms(240), ms(340)],
      [ms(490), ms(590)],
    ]);
    expect(labelSpans(x, 0, 35, 0)).toHaveLength(4);
  });

  test('a 50 ms run is kept; the last partial hop ends the span at the signal end', () => {
    const x = new Float32Array(ms(50) + 37);
    block(x, 0, x.length, 0.5);
    expect(labelSpans(x, 150)).toEqual([[0, x.length]]);
    expect(labelSpans(x.subarray(0, ms(50) - 1), 150)).toEqual([]);
    expect(x.length % HOP).toBe(37);
  });

  test('silence has no spans', () => {
    expect(labelSpans(new Float32Array(1000), 150)).toEqual([]);
    expect(labelSpans(new Float32Array(0), 150)).toEqual([]);
  });
});

describe('render grid', () => {
  test('render r of text t uses voices[g % 6], pitches[(g >> 1) % 4], speeds[(g >> 2) % 3] with g = 2t + r', () => {
    expect(combo(0)).toEqual({ voice: 'en-us', pitch: 30, speed: 130 });
    expect(combo(1)).toEqual({ voice: 'en-gb', pitch: 30, speed: 130 });
    expect(combo(5)).toEqual({ voice: 'en-us+whisper', pitch: 80, speed: 175 });
    expect(combo(16)).toEqual({ voice: 'en-gb+m3', pitch: 30, speed: 175 });
    expect(combo(107)).toEqual({ voice: 'en-us+whisper', pitch: 50, speed: 220 });
  });

  test('texts.json has 30 words, 20 sentences and 4 passages, giving 108 renders', () => {
    const renders = planRenders(parseTexts(JSON.parse(readFileSync(TEXTS_PATH, 'utf8'))));
    expect(renders).toHaveLength(108);
    expect(renders.filter((r) => r.kind === 'word')).toHaveLength(60);
    expect(renders.filter((r) => r.kind === 'sentence')).toHaveLength(40);
    expect(renders.filter((r) => r.kind === 'passage')).toHaveLength(8);
    expect(renders[60]).toMatchObject({ id: 'sentence-00-r0', ...combo(60) });
    expect(new Set(renders.map((r) => r.id)).size).toBe(108);
  });

  test('parseManifest rejects a malformed entry', () => {
    const entry = {
      id: 'word-00-r0',
      file: 'word-00-r0.wav',
      kind: 'word',
      text: 'hello',
      voice: 'en-us',
      pitch: 30,
      speed: 130,
      samples: 10,
      spans: [[0, 10]],
    };
    expect(parseManifest([entry])).toEqual([entry]);
    expect(() => parseManifest([{ ...entry, spans: [[0, 10.5]] }])).toThrow(/entry 0 is malformed/);
    expect(() => parseManifest([{ ...entry, voice: 'en-xx' }])).toThrow(/entry 0 is malformed/);
    expect(() => parseManifest({})).toThrow(/expected an array/);
  });

  test('parseDockerfile reads the base image and the espeak-ng pins, ignoring comments', () => {
    const text = [
      '# espeak-ng=0.0 in a comment',
      'FROM debian:trixie-slim@sha256:00',
      'RUN apt-get install -y espeak-ng=1.2-3 \\',
      '    libespeak-ng1=1.2-3 espeak-ng-data=1.2-3',
    ].join('\n');
    expect(parseDockerfile(text)).toEqual({
      from: 'debian:trixie-slim@sha256:00',
      pins: ['espeak-ng=1.2-3', 'libespeak-ng1=1.2-3', 'espeak-ng-data=1.2-3'],
      espeakVersion: '1.2-3',
    });
    expect(() => parseDockerfile('RUN apt-get install espeak-ng=1')).toThrow(/FROM/);
    expect(() => parseDockerfile('FROM x\n# espeak-ng=1')).toThrow(/espeak-ng=/);
    const committed = parseDockerfile(readFileSync(DOCKERFILE_PATH, 'utf8'));
    expect(committed.from).toMatch(/^debian:trixie-slim@sha256:[0-9a-f]{64}$/);
    expect(committed.pins.map((pin) => pin.split('=')[0])).toEqual([
      'espeak-ng',
      'libespeak-ng1',
      'espeak-ng-data',
    ]);
  });
});
