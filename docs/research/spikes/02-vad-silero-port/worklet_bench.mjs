// micro-benchmark: per-render-quantum work of an energy VAD + ring-buffer write
const Q = 128, SR = 48000, RING = SR * 10;
const ring = new Float32Array(RING); let w = 0;
const input = new Float32Array(Q); for (let i = 0; i < Q; i++) input[i] = Math.sin(i * 0.05) * 0.1 + (Math.random() - 0.5) * 0.01;
let noise = 1e-4, state = 0, hang = 0, sink = 0;
function quantum(x) {
  let e = 0;
  for (let i = 0; i < Q; i++) { const s = x[i]; e += s * s; ring[w] = s; w = (w + 1) % RING; }
  e /= Q;
  noise = e < noise ? 0.9 * noise + 0.1 * e : 0.999 * noise + 0.001 * e; // floor tracker
  const on = e > noise * 8, off = e < noise * 3;
  if (state === 0 && on) { state = 1; hang = 0; } else if (state === 1 && off) { if (++hang > 40) state = 0; } else hang = 0;
  return state;
}
for (let i = 0; i < 1e5; i++) sink += quantum(input);
const N = 2e6; const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) sink += quantum(input);
const ns = Number(process.hrtime.bigint() - t0) / N;
console.log(`per quantum: ${ns.toFixed(1)} ns; per second @375 q/s: ${(ns * 375 / 1e6).toFixed(3)} ms => ${(ns * 375 / 1e7).toFixed(4)} % of one core`, sink > 0 ? '' : '');
