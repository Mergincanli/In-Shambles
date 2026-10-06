import type { Vec3 } from "../../math/vec3";
import { BUTTON_WALK, MOVE_AXIS_MAX, type UserCmd } from "../usercmd";
import type { PmoveParams } from "./params";

/**
 * The docs/03 §4 building blocks every move mode shares. Pure leaf functions: they write
 * through out-parameters, return no doubles and take none either, apart from the tick length
 * passed through from pmove (native-ESM boxing, .claude/rules: pmove's move functions are too big
 * for V8 to inline every call, and a double crossing a call that isn't inlined is boxed). They use
 * only exact operations plus `Math.sqrt` (D-016).
 */

/**
 * Command scale (docs/03 §4.1): writes (forward, right, up) × scale to `out`, where
 * scale = speed · max(|f|,|r|,|u|) / (127 · √(f² + r² + u²)). Combined with an orthonormal
 * basis that gives a wish speed of exactly `speed` along any input direction at full deflection,
 * so diagonals are never faster. `up` is passed separately because only the swim move has a
 * vertical axis (jump/crouch, docs/03 §4.13, D-024): walk and air moves pass up = 0, since any
 * u ≠ 0 shrinks the planar wish (crouch walk would drop from 80 to 80/√2, failing MV-03). The
 * speed cap is pm_runSpeed, × pm_walkScale while walk is held and × pm_duckScale while crouched;
 * sprint and limp join in M4. All-zero input writes zero.
 */
export function cmdScale(
  out: Vec3,
  cmd: UserCmd,
  up: number,
  crouched: boolean,
  p: Readonly<PmoveParams>,
): Vec3 {
  const f = cmd.forward;
  const r = cmd.right;
  const max = Math.max(Math.abs(f), Math.abs(r), Math.abs(up));
  if (max === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  let speed = p.runSpeed;
  if ((cmd.buttons & BUTTON_WALK) !== 0) speed *= p.walkScale;
  if (crouched) speed *= p.duckScale;
  const scale = (speed * max) / (MOVE_AXIS_MAX * Math.sqrt(f * f + r * r + up * up));
  // + 0 turns −0 (a negative axis times a zero speed) into 0.
  out[0] = f * scale + 0;
  out[1] = r * scale + 0;
  out[2] = up * scale + 0;
  return out;
}

/** `accelerate` coefficients: pm_accelerate, pm_airAccelerate, pm_waterAccelerate. */
export const ACCEL_GROUND = 0;
export const ACCEL_AIR = 1;
export const ACCEL_WATER = 2;

/**
 * Accelerate (docs/03 §4.3), the same for ground, air and water; only the coefficient, picked by
 * `kind`, differs. `wishVel` is wishDir · wishSpeed (zero for no input). Caps only the velocity
 * component along wishDir at wishSpeed, which is why strafing with wishDir nearly perpendicular
 * to the velocity keeps adding speed.
 */
export function accelerate(
  v: Vec3,
  wishVel: Vec3,
  kind: number,
  p: Readonly<PmoveParams>,
  dt: number,
): void {
  const wx = wishVel[0];
  const wy = wishVel[1];
  const wz = wishVel[2];
  const wishSpeed = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (wishSpeed === 0) return;
  const current = (v[0] * wx + v[1] * wy + v[2] * wz) / wishSpeed;
  const add = wishSpeed - current;
  if (add <= 0) return;
  const accel =
    kind === ACCEL_GROUND ? p.accelerate : kind === ACCEL_AIR ? p.airAccelerate : p.waterAccelerate;
  // The speed to add, as a fraction of wishVel.
  const k = Math.min(accel * dt * wishSpeed, add) / wishSpeed;
  v[0] += wx * k;
  v[1] += wy * k;
  v[2] += wz * k;
}

/**
 * Friction (docs/03 §4.2), in place. Two terms, each skipped when its switch is off:
 * - ground (`groundTerm`: walking on ground that isn't slick, or on a ladder):
 *   drop = max(s, pm_stopSpeed) · pm_friction · dt;
 * - water (`waterLevel` 1–3): drop += s · pm_waterFriction · waterLevel · dt.
 *
 * The walk move measures s as the horizontal speed (`full3D` false; below 1 u/s the horizontal
 * velocity is zeroed); the swim and ladder moves use the full 3D speed (below 1 u/s the whole
 * velocity is zeroed). Otherwise the velocity is scaled by max(s − drop, 0) / s, so friction
 * never reverses it. With neither term nothing changes, not even a slow velocity.
 */
export function applyFriction(
  v: Vec3,
  groundTerm: boolean,
  full3D: boolean,
  waterLevel: number,
  p: Readonly<PmoveParams>,
  dt: number,
): void {
  if (!groundTerm && waterLevel <= 0) return;
  const vz = full3D ? v[2] : 0;
  const s = Math.sqrt(v[0] * v[0] + v[1] * v[1] + vz * vz);
  if (s < 1) {
    v[0] = 0;
    v[1] = 0;
    if (full3D) v[2] = 0;
    return;
  }
  let drop = groundTerm ? Math.max(s, p.stopSpeed) * p.friction * dt : 0;
  if (waterLevel > 0) drop += s * p.waterFriction * waterLevel * dt;
  const k = Math.max(s - drop, 0) / s;
  // + 0: a stop (k = 0) must not leave −0 behind.
  v[0] = v[0] * k + 0;
  v[1] = v[1] * k + 0;
  v[2] = v[2] * k + 0;
}

/**
 * Clip velocity (docs/03 §4.7): removes the component along the unit normal `n`, scaled by
 * pm_overclip (≥ 1) so the result points slightly away from the plane on both signs: a velocity
 * into the plane is pushed out a little more, one already leaving it keeps a little of that.
 * `out` may alias `v`.
 */
export function clipVelocity(
  out: Vec3,
  v: Vec3,
  n: Vec3,
  p: Readonly<Pick<PmoveParams, "overclip">>,
): Vec3 {
  const overclip = p.overclip;
  let backoff = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  if (backoff < 0) backoff *= overclip;
  else backoff /= overclip;
  // + 0 keeps a −0 input component from surviving as −0.
  out[0] = v[0] - n[0] * backoff + 0;
  out[1] = v[1] - n[1] * backoff + 0;
  out[2] = v[2] - n[2] * backoff + 0;
  return out;
}
