import pw from 'playwright'; const { chromium } = pw;
const browser = await chromium.launch(); const page = await browser.newPage(); const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0, 110)}`));
await page.addInitScript(() => { window.__v = []; document.addEventListener('securitypolicyviolation', e => window.__v.push(e.violatedDirective + ':' + e.blockedURI)); });
await page.goto('http://localhost:8095/'); await page.waitForTimeout(500);
console.log(logs.join('\n')); console.log('violations:', JSON.stringify(await page.evaluate(() => window.__v)));
await browser.close();
