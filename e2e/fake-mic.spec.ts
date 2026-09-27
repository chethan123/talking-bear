import { expect, test } from '@playwright/test';
import { micFlags } from './helpers/flags';

// Launch flags are worker-scoped: one fixture per spec file (plan §4.9.3).
test.use({ launchOptions: { args: micFlags('e2e/fixtures/vowel_f0-140.wav') } });

test('the fake mic delivers the fixture (input is not silent)', async ({ page }) => {
  await page.goto('/');
  // A trusted click gives the page sticky activation, so the AudioContext is allowed to start.
  await page.locator('main').click();
  const maxDb = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = new AudioContext();
    try {
      const analyser = new AnalyserNode(ctx, { fftSize: 2048 });
      new MediaStreamAudioSourceNode(ctx, { mediaStream: stream }).connect(analyser);
      const block = new Float32Array(analyser.fftSize);
      let max = -Infinity;
      // The fixture starts with 1 s of zeros, so the vowel shows up after about 1 s.
      const end = performance.now() + 3000;
      while (performance.now() < end) {
        analyser.getFloatTimeDomainData(block);
        let sumSq = 0;
        for (const x of block) sumSq += x * x;
        max = Math.max(max, 10 * Math.log10(sumSq / block.length + 1e-12)); // RMS in dBFS, floor -120
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return max;
    } finally {
      for (const track of stream.getTracks()) track.stop();
      await ctx.close();
    }
  });
  expect(maxDb, 'fake mic silent: check WAV path/format').toBeGreaterThan(-50);
});
