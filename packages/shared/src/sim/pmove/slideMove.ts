import { DEV_ASSERT } from "../../debug/assert";
import { type Vec3, vec3 } from "../../math/vec3";
import type { CollisionWorld } from "../../world/collisionWorld";
import { MASK_PLAYERSOLID } from "../../world/contents";
import { traceBox } from "../../world/trace";
import type { PlayerState } from "../playerState";
import { clipVelocity } from "./basics";
import type { PmoveTraceLog } from "./debug";
import type { PmoveParams } from "./params";
import { clipPlanes, SLIDE_MAX_PLANES, traceA } from "./scratch";

/** Sweeps per slide move (docs/03 §4.8). */
export const SLIDE_MAX_BUMPS = 4;

/**
 * After the clip against the plane just hit, another stored plane counts as cleared only when the
 * velocity leaves it at least this fast (u/s); a slower one is clipped too, and its overclip makes
 * the velocity leave it. A design constant, not a feel knob: it keeps the slide decisive where
 * rounding leaves a velocity almost exactly along a plane (D-017), and it makes the flat ground
 * plane, which a level walk only grazes, take part in crease and corner checks.
 */
export const SLIDE_LEAVE_SPEED = 0.1;

/**
 * Normals closer than this (cosine) are "the same plane" (docs/03 §4.8 step 3): the sweep came
 * back to a plane already clipped against, typically by a few ulps on a slope or rotated wall
 * (D-017), so the velocity is nudged off it instead of clipped again.
 */
export const SLIDE_SAME_PLANE = 0.99;

/** Module scratch (D-016). */
const entryVel: Vec3 = vec3();
const endVel: Vec3 = vec3();
const clipped: Vec3 = vec3();
const endClipped: Vec3 = vec3();
const crease: Vec3 = vec3();
const target: Vec3 = vec3();
/**
 * The move time still to go. A typed-array slot rather than a local: a local loop variable that
 * starts as the `dt` argument is boxed on every update under native ESM.
 */
const timeLeft = new Float64Array(1);

/**
 * Multi-plane collide-and-slide (docs/03 §4.8) of `ps.origin` by `ps.velocity` over `dt`, in
 * place. Returns whether any sweep hit something (step-slide uses it).
 *
 * Contact planes, up to SLIDE_MAX_PLANES: the ground normal when `groundNormal` is given (a
 * grounded move), the direction of the velocity as it enters (a pseudo-plane, so a clip never
 * turns the move backwards), then each plane a sweep hits. Up to SLIDE_MAX_BUMPS sweeps; after a
 * hit the remaining time continues along the velocity clipped against every plane it still moves
 * into, along the crease when that is two planes, and the move stops at three, when the clipped
 * velocity opposes the entering one, or when the plane list is full.
 *
 * With `gravity`, half-step integration (docs/03 §4.6): the sweeps use vz averaged with the
 * end-of-tick vz, the end-of-tick velocity is clipped against the same planes, and it is the
 * velocity the move leaves behind, so jump arcs do not depend on the tick length.
 *
 * Stuck rule (D-023): only an allSolid sweep, a box inside one brush for the whole move, is
 * stuck: vz is zeroed and the move reports blocked. snapOrigin keeps every tick's start clear, so
 * that is a bug and asserts in dev. A sweep that merely starts solid moves out and is accepted.
 */
export function slideMove(
  ps: PlayerState,
  world: CollisionWorld,
  mins: Vec3,
  maxs: Vec3,
  p: Readonly<PmoveParams>,
  dt: number,
  gravity: boolean,
  groundNormal: Vec3 | null,
  dbg: PmoveTraceLog | null,
): boolean {
  const o = ps.origin;
  const v = ps.velocity;
  const tr = traceA;
  const planes = clipPlanes;
  if (gravity) {
    endVel[0] = v[0];
    endVel[1] = v[1];
    endVel[2] = v[2] - p.gravity * dt;
    v[2] = (v[2] + endVel[2]) * 0.5;
  }
  entryVel[0] = v[0];
  entryVel[1] = v[1];
  entryVel[2] = v[2];
  let numPlanes = 0;
  if (groundNormal !== null) {
    const g = planes[0] as Vec3;
    g[0] = groundNormal[0];
    g[1] = groundNormal[1];
    g[2] = groundNormal[2];
    numPlanes = 1;
  }
  const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (speed > 0) {
    const d = planes[numPlanes] as Vec3;
    d[0] = v[0] / speed;
    d[1] = v[1] / speed;
    d[2] = v[2] / speed;
    numPlanes++;
  }
  timeLeft[0] = dt;
  let hit = false;
  for (let bump = 0; bump < SLIDE_MAX_BUMPS; bump++) {
    const t = timeLeft[0] as number;
    target[0] = o[0] + v[0] * t;
    target[1] = o[1] + v[1] * t;
    target[2] = o[2] + v[2] * t;
    traceBox(world, o, target, mins, maxs, MASK_PLAYERSOLID, tr);
    if (dbg !== null) dbg.record(o, target, mins, maxs, tr);
    if (tr.allSolid) {
      v[2] = 0;
      DEV_ASSERT(false, "slide move inside a brush: the tick started solid");
      return true;
    }
    if (tr.fraction > 0) {
      o[0] = tr.endpos[0];
      o[1] = tr.endpos[1];
      o[2] = tr.endpos[2];
    }
    if (tr.fraction === 1) break;
    hit = true;
    timeLeft[0] = t - t * tr.fraction;
    if (numPlanes >= SLIDE_MAX_PLANES) {
      v[0] = 0;
      v[1] = 0;
      v[2] = 0;
      return true;
    }
    const n = tr.normal;
    if (nudgeOffSamePlane(v, n, numPlanes, gravity)) continue;
    const added = planes[numPlanes] as Vec3;
    added[0] = n[0];
    added[1] = n[1];
    added[2] = n[2];
    numPlanes++;
    if (clipAgainstPlanes(v, numPlanes, numPlanes - 1, gravity, p)) {
      v[0] = 0;
      v[1] = 0;
      v[2] = 0;
      return true;
    }
    // docs/03 §4.8 step 5: turned against the entering velocity, as in a sloping corner.
    if (v[0] * entryVel[0] + v[1] * entryVel[1] + v[2] * entryVel[2] < 0) {
      v[0] = 0;
      v[1] = 0;
      v[2] = 0;
      return true;
    }
  }
  if (gravity) {
    v[0] = endVel[0];
    v[1] = endVel[1];
    v[2] = endVel[2];
  }
  return hit;
}

/**
 * docs/03 §4.8 step 3: when the hit normal `n` is (nearly) a stored plane's, nudges `v` (and with
 * `gravity` the end velocity) out along it and returns true, so the sweep goes on instead of
 * clipping against that plane again. A separate function on purpose: written inline in the
 * slide loop, this rarely taken branch made V8 box a double on every hit under native ESM (seen
 * in the pmove bench and allocation workload).
 */
function nudgeOffSamePlane(v: Vec3, n: Vec3, numPlanes: number, gravity: boolean): boolean {
  const planes = clipPlanes;
  for (let i = 0; i < numPlanes; i++) {
    const q = planes[i] as Vec3;
    if (n[0] * q[0] + n[1] * q[1] + n[2] * q[2] > SLIDE_SAME_PLANE) {
      v[0] += n[0];
      v[1] += n[1];
      v[2] += n[2];
      if (gravity) {
        endVel[0] += n[0];
        endVel[1] += n[1];
        endVel[2] += n[2];
      }
      return true;
    }
  }
  return false;
}

/**
 * docs/03 §4.8 step 4: clips `v` (and with `gravity` the end velocity) against the plane just
 * hit, `planes[hitPlane]`, then against every other stored plane the result still moves into.
 * When a second clip turns the velocity back into the hit plane it moves into both, and only the
 * part of the entering velocity along their crease is kept. Returns true when that crease still
 * moves into a third plane: the move stops.
 */
function clipAgainstPlanes(
  v: Vec3,
  numPlanes: number,
  hitPlane: number,
  gravity: boolean,
  p: Readonly<PmoveParams>,
): boolean {
  const planes = clipPlanes;
  const a = planes[hitPlane] as Vec3;
  clipVelocity(clipped, v, a, p);
  if (gravity) clipVelocity(endClipped, endVel, a, p);
  for (let j = 0; j < numPlanes; j++) {
    if (j === hitPlane) continue;
    const b = planes[j] as Vec3;
    if (clipped[0] * b[0] + clipped[1] * b[1] + clipped[2] * b[2] >= SLIDE_LEAVE_SPEED) continue;
    clipVelocity(clipped, clipped, b, p);
    if (gravity) clipVelocity(endClipped, endClipped, b, p);
    // Clear of the hit plane after the second clip: no crease needed.
    if (clipped[0] * a[0] + clipped[1] * a[1] + clipped[2] * a[2] >= 0) continue;
    const cx = a[1] * b[2] - a[2] * b[1];
    const cy = a[2] * b[0] - a[0] * b[2];
    const cz = a[0] * b[1] - a[1] * b[0];
    const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (len > 0) {
      crease[0] = cx / len;
      crease[1] = cy / len;
      crease[2] = cz / len;
    } else {
      crease[0] = 0;
      crease[1] = 0;
      crease[2] = 0;
    }
    let s = crease[0] * v[0] + crease[1] * v[1] + crease[2] * v[2];
    clipped[0] = crease[0] * s + 0;
    clipped[1] = crease[1] * s + 0;
    clipped[2] = crease[2] * s + 0;
    if (gravity) {
      s = crease[0] * endVel[0] + crease[1] * endVel[1] + crease[2] * endVel[2];
      endClipped[0] = crease[0] * s + 0;
      endClipped[1] = crease[1] * s + 0;
      endClipped[2] = crease[2] * s + 0;
    }
    for (let k = 0; k < numPlanes; k++) {
      if (k === hitPlane || k === j) continue;
      const c = planes[k] as Vec3;
      if (clipped[0] * c[0] + clipped[1] * c[1] + clipped[2] * c[2] < SLIDE_LEAVE_SPEED) {
        return true;
      }
    }
    break;
  }
  v[0] = clipped[0];
  v[1] = clipped[1];
  v[2] = clipped[2];
  if (gravity) {
    endVel[0] = endClipped[0];
    endVel[1] = endClipped[1];
    endVel[2] = endClipped[2];
  }
  return false;
}
