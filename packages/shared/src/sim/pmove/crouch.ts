import type { Vec3 } from "../../math/vec3";
import type { CollisionWorld } from "../../world/collisionWorld";
import { MASK_PLAYERSOLID } from "../../world/contents";
import { positionTest } from "../../world/trace";
import { HULL_CROUCHED_MAXS, HULL_MINS, HULL_STANDING_MAXS } from "../hull";
import { type PlayerState, PMF_CROUCHED } from "../playerState";
import { BUTTON_CROUCH, type UserCmd } from "../usercmd";
import { hull } from "./scratch";

/** Whether the standing hull fits at `origin`: the stand test, and the crouch-blocked test (D-023). */
export function canStand(world: CollisionWorld, origin: Vec3): boolean {
  return positionTest(world, origin, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID);
}

/**
 * Crouch pre-check (docs/03 §4.12), at the tick's start origin and the only place the hull
 * changes (M2 design §0). Holding crouch switches to the crouched hull at once: it shrinks from the
 * top, so it always fits. Released, the player stands only if the standing hull fits at the
 * origin, and otherwise stays crouched (under a ceiling, in the tunnel) until it does. Either way
 * the tick's start origin is clear for the hull the tick ends with, which snapOrigin's fallback
 * relies on. Crouching costs no stamina until the stamina rules land (M4).
 */
export function checkCrouch(ps: PlayerState, cmd: UserCmd, world: CollisionWorld): void {
  if ((cmd.buttons & BUTTON_CROUCH) !== 0) ps.flags |= PMF_CROUCHED;
  else if ((ps.flags & PMF_CROUCHED) !== 0 && canStand(world, ps.origin)) {
    ps.flags &= ~PMF_CROUCHED;
  }
  hull.mins = HULL_MINS;
  hull.maxs = (ps.flags & PMF_CROUCHED) !== 0 ? HULL_CROUCHED_MAXS : HULL_STANDING_MAXS;
}
