import pw from 'playwright'; const { chromium } = pw; import fs from 'node:fs';
const port = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext(); const page = await ctx.newPage();
const logs = []; page.on('console', m => logs.push(`[page.${m.type()}] ${m.text()}`));
ctx.on('serviceworker', w => { logs.push(`[sw created] ${w.url()}`); w.on('console', m => logs.push(`[sw.${m.type()}] ${m.text()}`)); });
const st = () => page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { installing: r?.installing?.state, waiting: r?.waiting?.state, active: r?.active?.state, controller: !!navigator.serviceWorker.controller }; });
fs.writeFileSync('root.txt', 'dist');
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then(r => r?.active?.state === 'activated'), null, { timeout: 15000 });
await page.waitForTimeout(2000);
await page.goto(`http://localhost:${port}/`); console.log('after 2nd goto:', JSON.stringify(await st()));
if (!(await st()).controller) { await page.reload(); await page.waitForTimeout(500); console.log('after reload:', JSON.stringify(await st())); }
if (!(await st()).controller) { await page.waitForTimeout(3000); await page.goto(`http://localhost:${port}/`); console.log('after 3s + goto:', JSON.stringify(await st())); }
await page.waitForTimeout(1000);
await page.evaluate(() => { navigator.serviceWorker.addEventListener('controllerchange', () => console.log('CONTROLLERCHANGE fired')); });
fs.writeFileSync('root.txt', 'dist-v2b');
await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then(r => r?.waiting?.state === 'installed' || r?.active?.scriptURL && false), null, { timeout: 15000 }).catch(() => console.log('waiting never observed'));
await page.waitForTimeout(1500);
console.log('after update:', JSON.stringify(await st()), '| need-refresh fired?', logs.some(l => /need refresh/.test(l)));
const navP = page.waitForNavigation({ timeout: 8000 }).then(() => 'RELOADED').catch(() => 'no reload in 8s');
await page.evaluate(() => window.updateSW());
for (let i = 1; i <= 3; i++) { await page.waitForTimeout(1000); console.log(`t+${i}s`, JSON.stringify(await st().catch(e => 'nav in progress'))); }
console.log('updateSW ->', await navP);
const s = await st().catch(() => null);
if (s && s.waiting) { console.log('still waiting -> direct postMessage'); await page.evaluate(async () => { (await navigator.serviceWorker.getRegistration()).waiting.postMessage({ type: 'SKIP_WAITING' }); }); for (let i = 1; i <= 3; i++) { await page.waitForTimeout(1000); console.log(`direct t+${i}s`, JSON.stringify(await st().catch(e => 'nav in progress'))); } }
await page.waitForTimeout(500);
console.log(logs.filter(l => /sw|CONTROLLER|refresh|lazy|V2/i.test(l)).join('\n'));
await browser.close();
