const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ channel: 'chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.resolve(process.argv[2])}%noloop`] });
  const page = await (await browser.newContext()).newPage();
  await page.goto('http://localhost:8765/rms.html'); await page.click('#start');
  await page.waitForTimeout(4500);
  const r = await page.evaluate(() => window.__rms);
  // summarize in 250 ms buckets
  const b = {}; for (const [t, d] of r) { const k = Math.floor(t / 250) * 250; (b[k] ||= []).push(d); }
  console.log(Object.entries(b).map(([k, v]) => `${k}:${Math.max(...v)}`).join('  '));
  await browser.close();
})();
