/**
 * A bank of independent damped springs, stepped together with semi-implicit (symplectic) Euler
 * (plan §4.6.6). Each spring `i` pulls `pos[i]` towards `target[i]` with stiffness `k = (2πf)²` and
 * damping `c = 2ζ·2πf`:
 *
 *     v += (−k·(x − target) − c·v)·dt;   x += v·dt   (the new v)
 *
 * The scheme is stable only while (ω·dt)² + 4ζ·ω·dt < 4, with ω = 2πf: ω·dt < 2 undamped, tighter with
 * damping. The app steps at `SUBSTEP` = 1/120 s, where every spring with f ≤ 10 Hz has ω·dt ≤ 0.52 and
 * is stable up to ζ ≈ 1.78. At dt = 1/30 a 10 Hz spring (ω·dt ≈ 2.09) grows without bound.
 *
 * All state is preallocated in the constructor: `set`, `impulse` and `step` never allocate.
 */
export class SpringBank {
  /** Rest position of each spring. Callers write it directly. */
  readonly target: Float32Array;
  /** Current position of each spring. */
  readonly pos: Float32Array;
  /** Current velocity of each spring, in units per second. */
  readonly vel: Float32Array;

  /** Stiffness k = ω² per spring; 0 until `set`. */
  readonly #k: Float64Array;
  /** Damping c = 2ζω per spring; 0 until `set`. */
  readonly #c: Float64Array;

  /** @throws RangeError unless `count` is an integer ≥ 0. */
  constructor(count: number) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('count must be an integer >= 0');
    }
    this.target = new Float32Array(count);
    this.pos = new Float32Array(count);
    this.vel = new Float32Array(count);
    this.#k = new Float64Array(count);
    this.#c = new Float64Array(count);
  }

  /**
   * Configures spring `i`: `k = (2π·freqHz)²`, `c = 2·zeta·2π·freqHz`. Position, velocity and target are
   * left as they are. A spring that was never `set` has k = c = 0: it holds its position, and an impulse
   * makes it drift.
   * @throws RangeError unless `i` is an integer in [0, count), and `freqHz` and `zeta` are finite and ≥ 0.
   */
  set(i: number, freqHz: number, zeta: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.pos.length) {
      throw new RangeError('spring index out of range');
    }
    if (!Number.isFinite(freqHz) || freqHz < 0) throw new RangeError('freqHz must be finite and >= 0');
    if (!Number.isFinite(zeta) || zeta < 0) throw new RangeError('zeta must be finite and >= 0');
    const w = 2 * Math.PI * freqHz;
    this.#k[i] = w * w;
    this.#c[i] = 2 * zeta * w;
  }

  /** Adds `dv` to the velocity of spring `i` (a kick). */
  impulse(i: number, dv: number): void {
    this.vel[i] = this.vel[i]! + dv;
  }

  /** Advances every spring by `dt` seconds with one semi-implicit Euler step. */
  step(dt: number): void {
    const { target, pos, vel } = this;
    const k = this.#k;
    const c = this.#c;
    for (let i = 0; i < pos.length; i++) {
      const x = pos[i]!;
      const v0 = vel[i]!;
      const v = v0 + (-k[i]! * (x - target[i]!) - c[i]! * v0) * dt;
      vel[i] = v;
      pos[i] = x + v * dt;
    }
  }
}
