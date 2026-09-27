const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const dir = __dirname;
const srv = http.createServer((req, res) => {
  const f = path.join(dir, req.url === '/' ? 'index2.html' : req.url);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(f));
}).listen(8765, '127.0.0.1', async () => {
  for (const channel of ['chromium']) {
    const browser = await chromium.launch({ headless: true, channel });
    const page = await browser.newPage();
    page.on('console', m => console.log('[console]', m.text()));
    page.on('pageerror', e => console.log('[pageerror]', e.message));
    await page.goto('http://127.0.0.1:8765/');
    await page.waitForFunction(() => window.__result, null, { timeout: 60000 });
    console.log('channel=' + (channel || 'headless-shell'), 'version=' + browser.version(), JSON.stringify(await page.evaluate(() => window.__result), null, 1));
    await browser.close();
  }
  srv.close();
});
