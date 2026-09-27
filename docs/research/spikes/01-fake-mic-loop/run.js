const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const [wav, urlPath, channel] = [process.argv[2], process.argv[3] || '/', process.argv[4]];
  const browser = await chromium.launch({
    channel: channel || undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
           `--use-file-for-fake-audio-capture=${path.resolve(wav)}%noloop`],
  });
  const ctx = await browser.newContext();
  await ctx.grantPermissions(['microphone'], { origin: 'http://localhost:8765' });
  const page = await ctx.newPage();
  page.on('console', m => console.log('console:', m.text()));
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.goto('http://localhost:8765' + urlPath);
  console.log('UA', await page.evaluate(() => navigator.userAgent));
  await page.click('#start');
  try { await page.waitForFunction(() => window.__result && window.__result.done, null, { timeout: 15000 }); }
  catch (e) { console.log('TIMEOUT'); }
  console.log(JSON.stringify(await page.evaluate(() => window.__result), null, 1));
  await browser.close();
})();
