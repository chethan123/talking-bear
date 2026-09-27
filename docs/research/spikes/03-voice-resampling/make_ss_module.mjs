// Regenerates ss_module.cjs (not committed): the Emscripten module factory embedded at the top of
// signalsmith-stretch's SignalsmithStretch.js (MIT), exported for Node so pitch.mjs / t4.mjs / t5.mjs can
// call the WASM core offline without an AudioContext.
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./node_modules/signalsmith-stretch/SignalsmithStretch.js', import.meta.url), 'utf8');
const start = src.indexOf('var SignalsmithStretch = (() => {');
const endMarker = '\n);\n})();';
const end = src.indexOf(endMarker, start);
if (start < 0 || start > 1 || end < 0) throw new Error('unexpected SignalsmithStretch.js layout; update make_ss_module.mjs');
fs.writeFileSync('ss_module.cjs', src.slice(start, end + endMarker.length) + '\nmodule.exports = SignalsmithStretch;\n');
console.log('wrote ss_module.cjs');
