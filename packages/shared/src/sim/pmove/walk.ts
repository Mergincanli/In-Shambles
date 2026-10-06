import { type Vec3, vec3 } from "../../math/vec3";
import type { CollisionWorld } from "../../world/collisionWorld";
import { MASK_PLAYERSOLID, SURF_SLICK } from "../../world/contents";
import { positionTest } from "../../world/trace";
import { ENTITY_NONE } from "../entity";
import { PMEV_JUMP, type PmoveEvents } from "../events";
import { HULL_MINS, HULL_STANDING_MAXS } from "../hull";
import {
  type PlayerState,
  PMF_CLIMBING,
  PMF_CROUCHED,
  PMF_GROUNDED,
  PMF_JUMP_HELD,
} from "../playerState";
import { BUTTON_JUMP, type UserCmd } from "../usercmd";
import {
  ACCEL_AIR,
  ACCEL_GROUND,
  accelerate,
  applyFriction,
  clipVelocity,
  cmdScale,
} from "./basics";
import type { PmoveTraceLog } from "./debug";
import type { PmoveParams } from "./params";
import { ground, moveAxes, viewForward, viewRight, wishVel } from "./scratch";
import { stepSlideMove } from "./stepSlideMove";

/** Module scratch (D-016): the movement basis of this tick's move. */
const basisForward: Vec3 = vec3();
const basisRight: Vec3 = vec3();

/** Normalizes `v` in place; a zero vector stays zero. */
function normalizeInPlace(v: Vec3): void {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len === 0) return;
  v[0] /= len;
  v[1] /= len;
  v[2] /= len;
}

/** wishVel = forward·moveAxes[0] + right·moveAxes[1] over this tick's basis vectors. */
function buildWish(): void {
  const f = basisForward;
  const r = basisRight;
  const fm = moveAxes[0];
  const rm = moveAxes[1];
  wishVel[0] = f[0] * fm + r[0] * rm + 0;
  wishVel[1] = f[1] * fm + r[1] * rm + 0;
  wishVel[2] = f[2] * fm + r[2] * rm + 0;
}

/**
 * Jump check (docs/03 §4.11), run first in a grounded tick, before friction. Needs jump held,
 * grounded, no ledge climb, and the press to be new since the last jump (PMF_JUMP_HELD, cleared
 * on release) unless pm_autoHop is 1. Crouch-blocked means crouched with the standing hull
 * blocked at the origin, so no jump under a ceiling; crouch-jumping in the open is allowed
 * (D-023). A jump sets vz to pm_jumpVelocity (not added), leaves the ground and emits PMEV_JUMP.
 */
export function checkJump(
  ps: PlayerState,
  cmd: UserCmd,
  world: CollisionWorld,
  p: Readonly<PmoveParams>,
  ev: PmoveEvents | null,
): boolean {
  const flags = ps.flags;
  if ((cmd.buttons & BUTTON_JUMP) === 0) return false;
  if ((flags & PMF_JUMP_HELD) !== 0 && p.autoHop !== 1) return false;
  if ((flags & PMF_GROUNDED) === 0 || (flags & PMF_CLIMBING) !== 0) return false;
  if (
    (flags & PMF_CROUCHED) !== 0 &&
    !positionTest(world, ps.origin, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID)
  ) {
    return false;
  }
  ps.velocity[2] = p.jumpVelocity;
  ps.flags = (flags & ~PMF_GROUNDED) | PMF_JUMP_HELD;
  ps.groundEntity = ENTITY_NONE;
  // The ground plane is no contact any more: the air move must not clip the jump against it.
  ground.hit = false;
  ground.walkable = false;
  if (ev !== null) ev.push(PMEV_JUMP, 0);
  return true;
}

/**
 * Walk move (docs/03 §4.4), grounded. The jump check comes first, so a jump on the landing tick
 * skips ground friction. Then friction (none on slick ground), a wish along the view yaw
 * flattened onto the ground plane, acceleration (pm_airAccelerate on slick ground), and the
 * velocity laid back onto the ground plane at its old magnitude, so walking up or down a slope
 * keeps its speed. A step-slide without gravity moves it; no horizontal velocity means a stop.
 */
export function walkMove(
  ps: PlayerState,
  cmd: UserCmd,
  world: CollisionWorld,
  p: Readonly<PmoveParams>,
  mins: Vec3,
  maxs: Vec3,
  dt: number,
  ev: PmoveEvents | null,
  dbg: PmoveTraceLog | null,
): void {
  if (checkJump(ps, cmd, world, p, ev)) {
    airMove(ps, cmd, world, p, mins, maxs, dt, ev, dbg);
    return;
  }
  const v = ps.velocity;
  const n = ground.normal;
  const slick = (ground.surfaceFlags & SURF_SLICK) !== 0;
  applyFriction(v, !slick, p, dt);
  cmdScale(moveAxes, cmd, 0, (ps.flags & PMF_CROUCHED) !== 0, p);

  // The basis follows the ground plane under the view yaw.
  const f = basisForward;
  const r = basisRight;
  f[0] = viewForward[0];
  f[1] = viewForward[1];
  f[2] = 0;
  clipVelocity(f, f, n, p);
  normalizeInPlace(f);
  r[0] = viewRight[0];
  r[1] = viewRight[1];
  r[2] = 0;
  clipVelocity(r, r, n, p);
  normalizeInPlace(r);
  buildWish();
  accelerate(v, wishVel, slick ? ACCEL_AIR : ACCEL_GROUND, p, dt);

  const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  clipVelocity(v, v, n, p);
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len > 0) {
    const k = speed / len;
    v[0] = v[0] * k + 0;
    v[1] = v[1] * k + 0;
    v[2] = v[2] * k + 0;
  }
  if (v[0] === 0 && v[1] === 0) {
    v[2] = 0;
    return;
  }
  stepSlideMove(ps, world, mins, maxs, p, dt, false, n, ev, dbg);
}

/**
 * Air move (docs/03 §4.5): a horizontal wish from the view yaw, pm_airAccelerate, a clip against
 * steep ground the player is sliding on (`ground.hit` without `walkable`), then a step-slide with
 * half-step gravity. Wall-jump and ledge-grab checks join before the acceleration in M4.
 */
export function airMove(
  ps: PlayerState,
  cmd: UserCmd,
  world: CollisionWorld,
  p: Readonly<PmoveParams>,
  mins: Vec3,
  maxs: Vec3,
  dt: number,
  ev: PmoveEvents | null,
  dbg: PmoveTraceLog | null,
): void {
  const v = ps.velocity;
  cmdScale(moveAxes, cmd, 0, (ps.flags & PMF_CROUCHED) !== 0, p);
  const f = basisForward;
  const r = basisRight;
  f[0] = viewForward[0];
  f[1] = viewForward[1];
  f[2] = 0;
  normalizeInPlace(f);
  r[0] = viewRight[0];
  r[1] = viewRight[1];
  r[2] = 0;
  normalizeInPlace(r);
  buildWish();
  accelerate(v, wishVel, ACCEL_AIR, p, dt);
  if (ground.hit && !ground.walkable) clipVelocity(v, v, ground.normal, p);
  stepSlideMove(ps, world, mins, maxs, p, dt, true, null, ev, dbg);
}
