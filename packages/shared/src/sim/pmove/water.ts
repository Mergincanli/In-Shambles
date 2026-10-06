import { type Vec3, vec3 } from "../../math/vec3";
import type { CollisionWorld } from "../../world/collisionWorld";
import { MASK_WATER } from "../../world/contents";
import { pointContents } from "../../world/trace";
import type { PmoveEvents } from "../events";
import {
  HULL_MINS,
  VIEW_HEIGHT_CROUCHED,
  VIEW_HEIGHT_STANDING,
  WATER_SAMPLE_FEET,
  WATER_SAMPLE_WAIST,
} from "../hull";
import { type PlayerState, PMF_CROUCHED, PMF_GROUNDED, PMF_IN_WATER } from "../playerState";
import { BUTTON_CROUCH, BUTTON_JUMP, MOVE_AXIS_MAX, type UserCmd } from "../usercmd";
import { ACCEL_WATER, accelerate, applyFriction, cmdScale } from "./basics";
import type { PmoveTraceLog } from "./debug";
import type { PmoveParams } from "./params";
import { ground, moveAxes, viewForward, viewRight, wishVel } from "./scratch";
import { stepSlideMove } from "./stepSlideMove";

/** Water level at which the swim move takes over from walking (docs/03 §3, §4.13). */
export const SWIM_WATER_LEVEL = 2;

/** Module scratch (D-016): the current water sample point. */
const sample: Vec3 = vec3();

/**
 * Water level (docs/03 §4.13, D-024) from pointContents samples at the feet + WATER_SAMPLE_FEET,
 * the feet + WATER_SAMPLE_WAIST and the eye (origin + VIEW_HEIGHT_* for the stance, so 50 u above
 * the feet standing and 36 u crouched), the feet being the hull bottom. Each level needs the ones
 * below it: 0 dry, 1 feet, 2 waist, 3 eyes under water. Sets ps.waterLevel and PMF_IN_WATER (any
 * level above 0). Run as a pre-check on the tick's start origin, after the crouch pre-check has
 * picked the stance, and again after the move.
 */
export function checkWaterLevel(ps: PlayerState, world: CollisionWorld): void {
  const o = ps.origin;
  const feet = o[2] + (HULL_MINS[2] as number);
  sample[0] = o[0];
  sample[1] = o[1];
  sample[2] = feet + WATER_SAMPLE_FEET;
  let level = 0;
  if ((pointContents(world, sample) & MASK_WATER) !== 0) {
    level = 1;
    sample[2] = feet + WATER_SAMPLE_WAIST;
    if ((pointContents(world, sample) & MASK_WATER) !== 0) {
      level = 2;
      const eye = (ps.flags & PMF_CROUCHED) !== 0 ? VIEW_HEIGHT_CROUCHED : VIEW_HEIGHT_STANDING;
      sample[2] = o[2] + eye;
      if ((pointContents(world, sample) & MASK_WATER) !== 0) level = 3;
    }
  }
  ps.waterLevel = level;
  if (level > 0) ps.flags |= PMF_IN_WATER;
  else ps.flags &= ~PMF_IN_WATER;
}

/**
 * Swim move (docs/03 §4.13, D-024), at water level ≥ SWIM_WATER_LEVEL. Friction is the water term
 * on the 3D speed (no ground term, even on the pool floor). The wish uses the full 3D view vectors
 * for forward and right, plus a vertical axis on world z: jump adds +127 and crouch −127 to the
 * cmd's up axis (clamped to ±127), so the player swims up and down while strafing and aiming as
 * on ground. cmdScale without the crouch factor (crouch means "down" here), times pm_swimScale;
 * the summed wish is capped at that speed, since world z and the pitched forward are not orthogonal.
 * With no move or vertical input the wish is straight down at pm_waterSinkSpeed: a slow sink.
 * pm_waterAccelerate, then a step-slide without gravity, against the floor plane when grounded:
 * the step lets a swimmer at the surface climb out over an edge up to pm_stepSize high. No sprint
 * and no water-jump (M4).
 */
export function waterMove(
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
  applyFriction(v, false, true, ps.waterLevel, p, dt);
  let up = cmd.up;
  if ((cmd.buttons & BUTTON_JUMP) !== 0) up += MOVE_AXIS_MAX;
  if ((cmd.buttons & BUTTON_CROUCH) !== 0) up -= MOVE_AXIS_MAX;
  up = Math.max(-MOVE_AXIS_MAX, Math.min(MOVE_AXIS_MAX, up));
  if (cmd.forward === 0 && cmd.right === 0 && up === 0) {
    wishVel[0] = 0;
    wishVel[1] = 0;
    wishVel[2] = 0 - p.waterSinkSpeed;
  } else {
    cmdScale(moveAxes, cmd, up, false, p);
    const f = viewForward;
    const r = viewRight;
    const fm = moveAxes[0] * p.swimScale;
    const rm = moveAxes[1] * p.swimScale;
    const um = moveAxes[2] * p.swimScale;
    const wx = f[0] * fm + r[0] * rm;
    const wy = f[1] * fm + r[1] * rm;
    const wz = f[2] * fm + r[2] * rm + um;
    // World z is not orthogonal to a pitched view forward, so the sum can outgrow the speed
    // cmdScale picked (up to √2 × at pitch ±90): cap it there, never stretch a shorter one.
    const cap = Math.sqrt(fm * fm + rm * rm + um * um);
    const len = Math.sqrt(wx * wx + wy * wy + wz * wz);
    // The floor keeps a zero swim speed (a cvar at 0) from dividing 0 by 0.
    const k = cap / Math.max(len, cap, 1e-9);
    wishVel[0] = wx * k + 0;
    wishVel[1] = wy * k + 0;
    wishVel[2] = wz * k + 0;
  }
  accelerate(v, wishVel, ACCEL_WATER, p, dt);
  const floor = (ps.flags & PMF_GROUNDED) !== 0 ? ground.normal : null;
  stepSlideMove(ps, world, mins, maxs, p, dt, false, floor, ev, dbg);
}
