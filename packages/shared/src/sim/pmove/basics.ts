import type { Vec3 } from "../../math/vec3";
import { BUTTON_WALK, MOVE_AXIS_MAX, type UserCmd } from "../usercmd";
import type { PmoveParams } from "./params";

/**
 * The docs/03 §4 building blocks every move mode shares. Pure leaf functions: they write
 * through out-parameters and return no doubles (native-ESM boxing, .claude/rules), and use only
 * exact operations plus `Math.sqrt` (D-016).
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

/**
 * Accelerate (docs/03 §4.3), the same for ground, air and water; only `accel` differs. Caps only
 * the velocity component along `wishDir` (unit length) at `wishSpeed`, which is why strafing
 * with wishDir nearly perpendicular to the velocity keeps adding speed.
 */
export function accelerate(
  v: Vec3,
  wishDir: Vec3,
  wishSpeed: number,
  accel: number,
  dt: number,
): void {
  const current = v[0] * wishDir[0] + v[1] * wishDir[1] + v[2] * wishDir[2];
  const add = wishSpeed - current;
  if (add <= 0) return;
  const speed = Math.min(accel * dt * wishSpeed, add);
  v[0] += wishDir[0] * speed;
  v[1] += wishDir[1] * speed;
  v[2] += wishDir[2] * speed;
}

/**
 * Friction (docs/03 §4.2). `onGround` selects the ground term: the caller passes true when
 * walking on ground that isn't slick. It uses the horizontal speed s: below 1 u/s the horizontal
 * velocity is zeroed; otherwise the whole velocity is scaled by max(s − drop, 0) / s with
 * drop = max(s, pm_stopSpeed) · pm_friction · dt, so friction never reverses the velocity.
 */
export function applyFriction(
  v: Vec3,
  onGround: boolean,
  p: Readonly<PmoveParams>,
  dt: number,
): void {
  if (!onGround) return;
  const s = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  if (s < 1) {
    v[0] = 0;
    v[1] = 0;
    return;
  }
  const drop = Math.max(s, p.stopSpeed) * p.friction * dt;
  const k = Math.max(s - drop, 0) / s;
  // + 0: a stop (k = 0) must not leave −0 behind.
  v[0] = v[0] * k + 0;
  v[1] = v[1] * k + 0;
  v[2] = v[2] * k + 0;
}

/**
 * Clip velocity (docs/03 §4.7): removes the component along the unit normal `n`, scaled by
 * `overclip` (≥ 1) so the result points slightly away from the plane on both signs: a velocity
 * into the plane is pushed out a little more, one already leaving it keeps a little of that.
 * `out` may alias `v`.
 */
export function clipVelocity(out: Vec3, v: Vec3, n: Vec3, overclip: number): Vec3 {
  let backoff = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  if (backoff < 0) backoff *= overclip;
  else backoff /= overclip;
  // + 0 keeps a −0 input component from surviving as −0.
  out[0] = v[0] - n[0] * backoff + 0;
  out[1] = v[1] - n[1] * backoff + 0;
  out[2] = v[2] - n[2] * backoff + 0;
  return out;
}
