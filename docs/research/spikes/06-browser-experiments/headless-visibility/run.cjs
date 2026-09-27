const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: undefined });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<html><body>x</body></html>');
  await page.evaluate(() => { window.__vis = []; document.addEventListener('visibilitychange', () => window.__vis.push(document.visibilityState)); document.addEventListener('freeze', () => window.__vis.push('freeze')); document.addEventListener('resume', () => window.__vis.push('resume')); });
  const cdp = await ctx.newCDPSession(page);
  const state = async (label) => console.log(label, await page.evaluate(() => ({ vis: document.visibilityState, log: window.__vis })));
  await state('initial');
  // A: second page in same context
  const p2 = await ctx.newPage(); await p2.setContent('<html><body>y</body></html>');
  await page.waitForTimeout(300); await state('after newPage');
  await page.bringToFront(); await page.waitForTimeout(300); await state('after bringToFront');
  // B: setWebLifecycleState frozen -> active
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }).catch(e => console.log('frozen err', e.message));
  await page.waitForTimeout(300);
  // page is frozen: evaluate may hang, so unfreeze first then read log
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(e => console.log('active err', e.message));
  await page.waitForTimeout(300); await state('after frozen->active');
  await page.bringToFront(); await page.waitForTimeout(300); await state('after active + bringToFront');
  // C: Emulation.setFocusEmulationEnabled
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(e => console.log('focus err', e.message));
  await page.waitForTimeout(300); await state('after focus emulation');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
