import { type Vec3, vec3 } from "../../math/vec3";
import type { CollisionWorld } from "../../world/collisionWorld";
import {
  CONTENTS_NODAMAGE,
  CONTENTS_SLICK,
  MASK_PLAYERSOLID,
  SURF_NODAMAGE,
  SURF_SLICK,
} from "../../world/contents";
import { traceBox } from "../../world/trace";
import { ENTITY_NONE } from "../entity";
import { type PlayerState, PMF_GROUNDED } from "../playerState";
import { clipVelocity } from "./basics";
import type { PmoveTraceLog } from "./debug";
import type { PmoveParams } from "./params";
import { ground, traceB } from "./scratch";

/**
 * Leaving speed along the ground normal, in u/s, above which a rising player is airborne even
 * with ground under the probe (docs/03 §4.10): the tick a jump or a launch starts must not
 * re-ground the player. A design constant, not a feel knob or an ESTIMATE.
 */
export const GROUND_LEAVE_SPEED = 10;

const probeEnd: Vec3 = vec3();

/**
 * Ground trace (docs/03 §4.10): sweeps the hull pm_groundTraceDist straight down from the
 * origin and fills the `ground` scratch, PMF_GROUNDED and groundEntity.
 * - No hit (or an allSolid start, which snapOrigin rules out): airborne.
 * - Rising with v·n > GROUND_LEAVE_SPEED: airborne, and the plane is not a contact.
 * - Normal z below pm_minWalkNormal: steep. Airborne, but `ground.hit` keeps the plane so the
 *   air move clips against it and the player slides down.
 * - Otherwise grounded on the hit entity. Slick and nodamage come from the hit plane's SURF_*
 *   bit or the hit brush's CONTENTS_SLICK / CONTENTS_NODAMAGE bit (D-023): bevels carry no
 *   surface flags, but `trace.contents` keeps the brush bits whichever plane is hit.
 * - Landing (airborne turned grounded): the velocity is clipped against the ground plane first.
 *   A fall can end within pm_groundTraceDist of the floor without the slide sweep touching it,
 *   and the walk move would otherwise lay the whole fall speed onto the plane (D-023).
 * - With `settle` (the post-move trace), a grounded player is moved down onto the ground. The
 *   end-of-tick snap rounds a walk along a slope by the same error every tick, and without the
 *   settle that drift adds up past the probe distance (D-023).
 * Returns true when this call turned an airborne player grounded (the LAND event, which pmove
 * emits since only it knows the impact speed).
 */
export function groundTrace(
  ps: PlayerState,
  world: CollisionWorld,
  p: Readonly<PmoveParams>,
  mins: Vec3,
  maxs: Vec3,
  settle: boolean,
  dbg: PmoveTraceLog | null,
): boolean {
  const o = ps.origin;
  const v = ps.velocity;
  const tr = traceB;
  const g = ground;
  const wasGrounded = (ps.flags & PMF_GROUNDED) !== 0;
  probeEnd[0] = o[0];
  probeEnd[1] = o[1];
  probeEnd[2] = o[2] - p.groundTraceDist;
  traceBox(world, o, probeEnd, mins, maxs, MASK_PLAYERSOLID, tr);
  if (dbg !== null) dbg.record(o, probeEnd, mins, maxs, tr);
  g.hit = false;
  g.walkable = false;
  g.surfaceFlags = 0;
  g.contents = 0;
  g.entity = ENTITY_NONE;
  const n = tr.normal;
  if (
    tr.allSolid ||
    tr.fraction === 1 ||
    (v[2] > 0 && v[0] * n[0] + v[1] * n[1] + v[2] * n[2] > GROUND_LEAVE_SPEED)
  ) {
    g.normal[0] = 0;
    g.normal[1] = 0;
    g.normal[2] = 0;
    ps.flags &= ~PMF_GROUNDED;
    ps.groundEntity = ENTITY_NONE;
    return false;
  }
  g.hit = true;
  g.normal[0] = n[0];
  g.normal[1] = n[1];
  g.normal[2] = n[2];
  if (n[2] < p.minWalkNormal) {
    ps.flags &= ~PMF_GROUNDED;
    ps.groundEntity = ENTITY_NONE;
    return false;
  }
  const c = tr.contents;
  g.walkable = true;
  g.contents = c;
  g.surfaceFlags =
    tr.surfaceFlags |
    ((c & CONTENTS_SLICK) !== 0 ? SURF_SLICK : 0) |
    ((c & CONTENTS_NODAMAGE) !== 0 ? SURF_NODAMAGE : 0);
  g.entity = tr.entity;
  ps.flags |= PMF_GROUNDED;
  ps.groundEntity = tr.entity;
  if (settle) {
    o[0] = tr.endpos[0];
    o[1] = tr.endpos[1];
    o[2] = tr.endpos[2];
  }
  if (wasGrounded) return false;
  if (v[0] * n[0] + v[1] * n[1] + v[2] * n[2] < 0) clipVelocity(v, v, n, p);
  return true;
}
