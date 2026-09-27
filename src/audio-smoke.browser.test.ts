import { expect, test } from 'vitest';

test('OfflineAudioContext renders a 440 Hz sine at gain 0.5 and exposes audioWorklet', async () => {
  expect.assertions(2);

  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 4800, sampleRate: 48000 });
  const osc = new OscillatorNode(ctx, { type: 'sine', frequency: 440 });
  const gain = new GainNode(ctx, { gain: 0.5 });
  osc.connect(gain).connect(ctx.destination);
  osc.start(0);
  const buf = await ctx.startRendering();

  // 4800 samples at 48 kHz are exactly 44 cycles of 440 Hz, so the ideal RMS is exact.
  const data = buf.getChannelData(0);
  let sum = 0;
  for (const x of data) sum += x * x;
  const rms = Math.sqrt(sum / data.length);
  const expected = 0.5 / Math.SQRT2;
  expect(Math.abs(rms - expected)).toBeLessThanOrEqual(0.01 * expected);

  // audioWorklet needs a secure context; the Vitest page served from localhost is one,
  // so this test must stay on that page (no about:blank, no data: URL).
  expect('audioWorklet' in ctx).toBe(true);
});
