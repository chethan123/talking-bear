import pw from 'playwright'; const { chromium } = pw;
const browser = await chromium.launch(); const ctx = await browser.newContext(); const page = await ctx.newPage();
await page.goto('http://localhost:8096/'); await page.waitForTimeout(500);
const cdp = await ctx.newCDPSession(page);
await page.evaluate(() => { window.__vis = []; document.addEventListener('visibilitychange', () => window.__vis.push(document.visibilityState)); });
await cdp.send('Page.setWebLifecycleState', { state: 'hidden' });
await page.waitForTimeout(300);
console.log('visibilityState after CDP hidden:', await page.evaluate(() => [document.visibilityState, document.hidden, window.__vis]));
const navP = page.waitForNavigation({ timeout: 8000 }).then(() => 'RELOADED while hidden').catch(() => 'NO reload while hidden (8s)');
await page.evaluate(() => { setTimeout(() => location.reload(), 10); });
console.log(await navP);
console.log('after:', await page.evaluate(() => document.visibilityState));
// frozen: can JS run at all?
await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }).then(() => console.log('frozen state set')).catch(e => console.log('frozen not supported:', e.message.slice(0, 80)));
const t = Date.now(); const r = await Promise.race([page.evaluate(() => 1 + 1).then(v => 'evaluate returned ' + v), new Promise(res => setTimeout(() => res('evaluate did not return in 3s (frozen)'), 3000))]);
console.log(r, Date.now() - t, 'ms');
await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
await browser.close();
