const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const blocks = JSON.parse(fs.readFileSync('blocks.json', 'utf8'));
  const b = await chromium.launch(); const p = await b.newPage();
  await p.setContent('<html><body></body></html>');
  await p.addScriptTag({ path: require.resolve('mermaid/dist/mermaid.min.js') });
  const res = await p.evaluate(async (blocks) => {
    mermaid.initialize({ startOnLoad: false });
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      try { const { svg } = await mermaid.render('d' + i, blocks[i]); out.push(`block ${i}: OK (${svg.length} bytes svg)`); }
      catch (e) { out.push(`block ${i}: ERROR ${e.message || e}`); }
    }
    return out;
  }, blocks);
  console.log(res.join('\n')); await b.close();
})();
