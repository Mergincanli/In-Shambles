import { type Vec3, vec3 } from "../../math/vec3";
import type { CollisionWorld } from "../../world/collisionWorld";
import { MASK_PLAYERSOLID } from "../../world/contents";
import { traceBox } from "../../world/trace";
import { PMEV_STEP, type PmoveEvents } from "../events";
import type { PlayerState } from "../playerState";
import { clipVelocity } from "./basics";
import type { PmoveTraceLog } from "./debug";
import type { PmoveParams } from "./params";
import { traceB } from "./scratch";
import { slideMove } from "./slideMove";

/**
 * How much farther (u, horizontally) the stepped path must get than the plain one to be kept.
 * A design constant: on a wall, a slope or a rotated plane both paths cover the same ground up to
 * the same-plane nudge (about 1/60 u a tick), and preferring the plain one there keeps a slide
 * along a wall from turning into a stream of zero-height steps.
 */
export const STEP_MIN_GAIN = 1 / 16;

/** Smallest |Δz| (u) a kept step reports as PMEV_STEP: one origin grid step. */
export const STEP_EVENT_MIN = 1 / 32;

/** Module scratch (D-016). */
const startOrigin: Vec3 = vec3();
const startVelocity: Vec3 = vec3();
const plainOrigin: Vec3 = vec3();
const plainVelocity: Vec3 = vec3();
const probe: Vec3 = vec3();
/** The PMEV_STEP value, handed over in an array so it never crosses a call as a double. */
const stepDelta = new Float64Array(1);

/**
 * Step-slide move (docs/03 §4.9): a slide move, and when it hit something, the same move tried
 * again from pm_stepSize higher and traced back down by the height actually gained plus
 * pm_groundTraceDist. The stepped path is kept only when that trace lands on walkable ground and
 * the path got STEP_MIN_GAIN farther horizontally; its velocity is then clipped against the
 * landing plane and a PMEV_STEP reports the height change. Within STEP_MIN_GAIN either way it is
 * a tie: the plain origin, with the velocity of whichever path kept more horizontal speed. While rising (vz > 0) with no walkable ground within pm_stepSize
 * below the start, there is no step: a jump against a wall must not climb it.
 */
export function stepSlideMove(
  ps: PlayerState,
  world: CollisionWorld,
  mins: Vec3,
  maxs: Vec3,
  p: Readonly<PmoveParams>,
  dt: number,
  gravity: boolean,
  groundNormal: Vec3 | null,
  ev: PmoveEvents | null,
  dbg: PmoveTraceLog | null,
): void {
  const o = ps.origin;
  const v = ps.velocity;
  const tr = traceB;
  startOrigin[0] = o[0];
  startOrigin[1] = o[1];
  startOrigin[2] = o[2];
  startVelocity[0] = v[0];
  startVelocity[1] = v[1];
  startVelocity[2] = v[2];
  if (!slideMove(ps, world, mins, maxs, p, dt, gravity, groundNormal, dbg)) return;
  if (startVelocity[2] > 0) {
    probe[0] = startOrigin[0];
    probe[1] = startOrigin[1];
    probe[2] = startOrigin[2] - p.stepSize;
    traceBox(world, startOrigin, probe, mins, maxs, MASK_PLAYERSOLID, tr);
    if (dbg !== null) dbg.record(startOrigin, probe, mins, maxs, tr);
    if (tr.fraction === 1 || tr.normal[2] < p.minWalkNormal) return;
  }
  plainOrigin[0] = o[0];
  plainOrigin[1] = o[1];
  plainOrigin[2] = o[2];
  plainVelocity[0] = v[0];
  plainVelocity[1] = v[1];
  plainVelocity[2] = v[2];

  // Up by pm_stepSize, or as far as a ceiling allows.
  probe[0] = startOrigin[0];
  probe[1] = startOrigin[1];
  probe[2] = startOrigin[2] + p.stepSize;
  traceBox(world, startOrigin, probe, mins, maxs, MASK_PLAYERSOLID, tr);
  if (dbg !== null) dbg.record(startOrigin, probe, mins, maxs, tr);
  if (tr.allSolid) return;
  const raised = tr.endpos[2] - startOrigin[2];
  o[0] = tr.endpos[0];
  o[1] = tr.endpos[1];
  o[2] = tr.endpos[2];
  v[0] = startVelocity[0];
  v[1] = startVelocity[1];
  v[2] = startVelocity[2];
  slideMove(ps, world, mins, maxs, p, dt, gravity, groundNormal, dbg);

  // Back down by what was gained, plus the ground probe distance: a player rests ε above the
  // floor (D-017), so a trace of exactly `raised` ends at the start height without reaching it.
  probe[0] = o[0];
  probe[1] = o[1];
  probe[2] = o[2] - raised - p.groundTraceDist;
  traceBox(world, o, probe, mins, maxs, MASK_PLAYERSOLID, tr);
  if (dbg !== null) dbg.record(o, probe, mins, maxs, tr);
  if (tr.allSolid || tr.fraction === 1 || tr.normal[2] < p.minWalkNormal) {
    restorePlain(o, v);
    return;
  }
  const sx = tr.endpos[0] - startOrigin[0];
  const sy = tr.endpos[1] - startOrigin[1];
  const fx = plainOrigin[0] - startOrigin[0];
  const fy = plainOrigin[1] - startOrigin[1];
  const stepped = Math.sqrt(sx * sx + sy * sy);
  const plain = Math.sqrt(fx * fx + fy * fy);
  if (stepped <= plain + STEP_MIN_GAIN) {
    // Within the margin either way it is a tie: the plain origin, with whichever path's velocity
    // keeps more horizontal speed. A plain path that touched a riser at the tick's end must not
    // stop dead there when the stepped one went on (D-023).
    const svh = v[0] * v[0] + v[1] * v[1];
    const pvh = plainVelocity[0] * plainVelocity[0] + plainVelocity[1] * plainVelocity[1];
    if (stepped >= plain - STEP_MIN_GAIN && svh > pvh) {
      o[0] = plainOrigin[0];
      o[1] = plainOrigin[1];
      o[2] = plainOrigin[2];
    } else {
      restorePlain(o, v);
    }
    return;
  }
  o[0] = tr.endpos[0];
  o[1] = tr.endpos[1];
  o[2] = tr.endpos[2];
  clipVelocity(v, v, tr.normal, p);
  const dz = o[2] - startOrigin[2];
  if (ev !== null && Math.abs(dz) >= STEP_EVENT_MIN) {
    stepDelta[0] = dz;
    ev.pushFrom(PMEV_STEP, stepDelta, 0);
  }
}

/** Puts the plain (unstepped) path's origin and velocity back. */
function restorePlain(o: Vec3, v: Vec3): void {
  o[0] = plainOrigin[0];
  o[1] = plainOrigin[1];
  o[2] = plainOrigin[2];
  v[0] = plainVelocity[0];
  v[1] = plainVelocity[1];
  v[2] = plainVelocity[2];
}
