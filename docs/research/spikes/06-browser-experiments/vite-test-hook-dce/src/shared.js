export function hpf(x) { let y = new Float32Array(x.length); for (let i = 1; i < x.length; i++) y[i] = x[i] - 0.9 * x[i-1]; return y; }
