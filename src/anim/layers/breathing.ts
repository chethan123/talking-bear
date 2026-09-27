/**
 * Breathing layer (plan §4.6.5): body scale 1 ± 0.012 at 0.25 Hz, with the belly 0.2 cycles ahead.
 *
 *     BodySquash  += 0.012·sin(2π·0.25·t)
 *     BellyJiggle += 0.012·sin(2π·0.25·t + 0.2·2π)
 *
 * `t` is the time since the layer's creation, advanced by each update's `dt`.
 */
import { Ch } from '../pose.ts';
import type { Pose } from '../pose.ts';
import type { AnimContext, Layer } from './index.ts';

/** Breathing rate, in Hz. */
export const BREATH_HZ = 0.25;
/** Amplitude of `BodySquash` and `BellyJiggle` (multiplicative deltas). */
export const BREATH_AMP = 0.012;
/** Phase lead of the belly over the body, in cycles. */
export const BELLY_PHASE = 0.2;

const TAU = 2 * Math.PI;

class Breathing implements Layer {
  /** Breathing phase in cycles, kept in [0, 1) so long runs lose no precision. */
  #phase = 0;

  update(dt: number, pose: Pose, ctx: AnimContext): void {
    const phase = this.#phase + dt * BREATH_HZ;
    this.#phase = phase - Math.floor(phase);
    const a = TAU * this.#phase;
    const amp = ctx.weights.breathing * BREATH_AMP;
    pose[Ch.BodySquash] = pose[Ch.BodySquash]! + amp * Math.sin(a);
    pose[Ch.BellyJiggle] = pose[Ch.BellyJiggle]! + amp * Math.sin(a + TAU * BELLY_PHASE);
  }
}

/** A new breathing layer, at phase 0. */
export function createBreathing(): Layer {
  return new Breathing();
}
