import { DEV_ASSERT } from "../debug/assert";
import type { Vec3 } from "./vec3";

/**
 * End-of-tick quantizers (docs/05 §4.1). Each clamps to what the codec can carry, so a stored
 * value is exactly what goes over the wire, and each is idempotent: scaling by a power of two is
 * exact, so q(q(x)) === q(x).
 *
 * Math.round rounds halves toward +Infinity, so q(−x) !== −q(x) exactly at halves
 * (q(−1/64) = 0 but q(1/64) = 1/32). The `+ 0` turns the −0 that Math.round returns for
 * [−0.5, −0] into +0, so −0 never reaches state or a later 1/x.
 *
 * Non-finite input is a bug: DEV_ASSERT in dev; in prod NaN becomes 0 and ±Infinity clamps.
 */

/** Origin grid: 1/32 u, within ±16384 u (i32 per axis on the wire). */
export const ORIGIN_SCALE = 32;
export const ORIGIN_LIMIT = 16384;

/** Velocity grid: 1/16 u/s, within the i20 range ±(2^19 − 1)/16. */
export const VELOCITY_SCALE = 16;
export const VELOCITY_LIMIT = 524287 / VELOCITY_SCALE;

/** Stamina is stored as integer hundredths in a u16 (docs/03 §6 "fixed-point ×100"). */
export const STAMINA_MAX_HUNDREDTHS = 65535;

export function quantizeOrigin(x: number): number {
  DEV_ASSERT(Number.isFinite(x), "origin component must be finite", x);
  if (Number.isNaN(x)) return 0;
  const c = x < -ORIGIN_LIMIT ? -ORIGIN_LIMIT : x > ORIGIN_LIMIT ? ORIGIN_LIMIT : x;
  return (Math.round(c * ORIGIN_SCALE) + 0) / ORIGIN_SCALE;
}

export function quantizeVelocity(x: number): number {
  DEV_ASSERT(Number.isFinite(x), "velocity component must be finite", x);
  if (Number.isNaN(x)) return 0;
  const c = x < -VELOCITY_LIMIT ? -VELOCITY_LIMIT : x > VELOCITY_LIMIT ? VELOCITY_LIMIT : x;
  return (Math.round(c * VELOCITY_SCALE) + 0) / VELOCITY_SCALE;
}

/** In place. */
export function quantizeOriginVec3(v: Vec3): Vec3 {
  v[0] = quantizeOrigin(v[0]);
  v[1] = quantizeOrigin(v[1]);
  v[2] = quantizeOrigin(v[2]);
  return v;
}

/** In place. */
export function quantizeVelocityVec3(v: Vec3): Vec3 {
  v[0] = quantizeVelocity(v[0]);
  v[1] = quantizeVelocity(v[1]);
  v[2] = quantizeVelocity(v[2]);
  return v;
}

/** Nearest whole hundredth count in 0..65535. */
export function quantizeStaminaHundredths(hundredths: number): number {
  DEV_ASSERT(Number.isFinite(hundredths), "stamina must be finite", hundredths);
  if (!(hundredths > 0)) return 0;
  if (hundredths >= STAMINA_MAX_HUNDREDTHS) return STAMINA_MAX_HUNDREDTHS;
  return Math.round(hundredths);
}

/**
 * Angles are u16 units, 65536 per turn (docs/03 §6). `deg * 65536` is exact, so only the
 * division rounds. Setup and input conversion only; the sim works in units.
 */
export function degreesToU16(deg: number): number {
  return Math.round((deg * 65536) / 360) & 0xffff;
}

/** For display and logs; the sim never converts back to degrees. */
export function u16ToDegrees(a: number): number {
  return ((a & 0xffff) * 360) / 65536;
}

/** u16 angle as a signed value in −32768..32767 (pitch clamps, angle differences). */
export function toSigned16(a: number): number {
  return (a << 16) >> 16;
}
