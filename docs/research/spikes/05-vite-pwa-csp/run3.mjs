import pw from 'playwright'; const { chromium } = pw; import fs from 'node:fs';
const port = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext(); const page = await ctx.newPage();
const logs = []; page.on('console', m => logs.push(`[page.${m.type()}] ${m.text()}`));
ctx.on('serviceworker', w => { logs.push(`[sw created] ${w.url()}`); w.on('console', m => logs.push(`[sw.${m.type()}] ${m.text()}`)); });
fs.writeFileSync('root.txt', 'dist');
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then(r => !!r?.active), null, { timeout: 15000 });
await page.reload(); await page.waitForTimeout(1000);
await page.evaluate(() => { navigator.serviceWorker.addEventListener('controllerchange', () => console.log('CONTROLLERCHANGE fired')); });
fs.writeFileSync('root.txt', 'dist-v2');
await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then(r => !!r?.waiting), null, { timeout: 15000 });
await page.waitForTimeout(1500); // let workbox-window's 200ms waiting timeout fire
console.log('need-refresh fired?', logs.some(l => /need refresh/.test(l)));
const st = async (tag) => console.log(tag, JSON.stringify(await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { waiting: r.waiting?.state, active: r.active?.state, controller: !!navigator.serviceWorker.controller }; })));
await st('before updateSW:');
const navP = page.waitForNavigation({ timeout: 8000 }).then(() => 'RELOADED').catch(() => 'no reload in 8s');
await page.evaluate(() => window.updateSW());
console.log('updateSW ->', await navP);
await st('after updateSW:');
if (!(await page.evaluate(async () => !(await navigator.serviceWorker.getRegistration()).waiting))) {
  await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); r.waiting.postMessage({ type: 'SKIP_WAITING' }); });
  await page.waitForTimeout(3000);
  await st('after direct SKIP_WAITING postMessage:');
}
await page.waitForTimeout(500);
console.log(logs.filter(l => /sw|CONTROLLER|refresh|Workbox|workbox/i.test(l)).join('\n'));
await browser.close();
