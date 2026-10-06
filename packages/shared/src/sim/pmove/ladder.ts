import { type Vec3, vec3 } from "../../math/vec3";
import type { CollisionWorld } from "../../world/collisionWorld";
import { MASK_PLAYERSOLID, SURF_LADDER } from "../../world/contents";
import { traceBox } from "../../world/trace";
import { PMEV_JUMP, type PmoveEvents } from "../events";
import { type PlayerState, PMF_GROUNDED, PMF_JUMP_HELD, PMF_ON_LADDER } from "../playerState";
import { BUTTON_JUMP, type UserCmd } from "../usercmd";
import { ACCEL_GROUND, accelerate, applyFriction, cmdScale } from "./basics";
import type { PmoveTraceLog } from "./debug";
import type { PmoveParams } from "./params";
import { ladderNormal, moveAxes, traceB, viewRight, wishVel } from "./scratch";
import { slideMove } from "./slideMove";

/**
 * Speed (u/s) along the ladder normal above which a player moving away from the face does not
 * attach (D-024). A design constant, not a feel knob. At the defaults a jump-off's push already
 * carries the hull out of pm_ladderReach within one tick; this rule keeps it off the ladder when
 * the reach, the push or the tick length leave it in reach, while a player drifting off the face
 * slowly still catches it. It also refuses a mount from the top while walking back off the edge
 * (an open point in D-024).
 */
export const LADDER_DETACH_SPEED = 16;

/** Module scratch (D-016). */
const probeEnd: Vec3 = vec3();
const along: Vec3 = vec3();

/**
 * Ladder-contact pre-check (docs/03 §4.14, D-024), at the tick's start origin with the tick's
 * hull. Sets PMF_ON_LADDER, and ladderNormal for the ladder move, when all of these hold:
 * - a horizontal sweep of the hull pm_ladderReach along the yaw-only forward (pitch ignored) hits
 *   a SURF_LADDER face;
 * - the player faces it: dot(forward, −n) > pm_ladderFacing, so turning away detaches;
 * - the player is not moving away from it faster than LADDER_DETACH_SPEED (v·n), so a jump-off
 *   does not re-attach;
 * - on the ground, forward is held (cmd.forward > 0): standing at the foot of a ladder, or walking
 *   back from it, is walking.
 * Only the face flag counts; CONTENTS_LADDER volumes stay reserved and are ignored.
 */
export function checkLadder(
  ps: PlayerState,
  cmd: UserCmd,
  world: CollisionWorld,
  p: Readonly<PmoveParams>,
  mins: Vec3,
  maxs: Vec3,
  dbg: PmoveTraceLog | null,
): void {
  ps.flags &= ~PMF_ON_LADDER;
  if ((ps.flags & PMF_GROUNDED) !== 0 && cmd.forward <= 0) return;
  const o = ps.origin;
  // The yaw-only forward from the view basis: right = (sin yaw, −cos yaw, 0).
  const fx = 0 - viewRight[1];
  const fy = viewRight[0] as number;
  const len = Math.sqrt(fx * fx + fy * fy);
  const ux = fx / len;
  const uy = fy / len;
  probeEnd[0] = o[0] + ux * p.ladderReach;
  probeEnd[1] = o[1] + uy * p.ladderReach;
  probeEnd[2] = o[2];
  const tr = traceB;
  traceBox(world, o, probeEnd, mins, maxs, MASK_PLAYERSOLID, tr);
  if (dbg !== null) dbg.record(o, probeEnd, mins, maxs, tr);
  if (tr.fraction === 1 || (tr.surfaceFlags & SURF_LADDER) === 0) return;
  const n = tr.normal;
  if (0 - (ux * n[0] + uy * n[1]) <= p.ladderFacing) return;
  const v = ps.velocity;
  if (v[0] * n[0] + v[1] * n[1] + v[2] * n[2] > LADDER_DETACH_SPEED) return;
  ladderNormal[0] = n[0];
  ladderNormal[1] = n[1];
  ladderNormal[2] = n[2];
  ps.flags |= PMF_ON_LADDER;
}

/**
 * Ladder move (docs/03 §4.14, D-024). Friction as on ground but on the 3D speed, without the
 * water term even where the ladder reaches into water; then pm_accelerate toward a wish made of
 * the cmd's forward axis on world z (forward climbs, back
 * descends, whatever the pitch) and its right axis along the face (the view right projected onto
 * the face plane), at pm_runSpeed × pm_ladderScale. No gravity and no slide-down: with no input
 * the player stays put. A fresh jump press (the PMF_JUMP_HELD edge, or pm_autoHop) pushes off by
 * n · pm_ladderJumpPush, detaches and emits PMEV_JUMP. A slide move without gravity or ground
 * plane then moves the player; at the top the hull rises past the face and the next tick's probe
 * misses, so the climb ends in an air move over the edge.
 */
export function ladderMove(
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
  const n = ladderNormal;
  applyFriction(v, true, true, 0, p, dt);
  cmdScale(moveAxes, cmd, 0, false, p);
  const a = along;
  const rx = viewRight[0] as number;
  const ry = viewRight[1] as number;
  const rn = rx * n[0] + ry * n[1];
  a[0] = rx - n[0] * rn;
  a[1] = ry - n[1] * rn;
  a[2] = 0 - n[2] * rn;
  const len = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  const scale = p.ladderScale;
  const up = moveAxes[0] * scale;
  const side = len > 0 ? (moveAxes[1] * scale) / len : 0;
  wishVel[0] = a[0] * side + 0;
  wishVel[1] = a[1] * side + 0;
  wishVel[2] = a[2] * side + up + 0;
  accelerate(v, wishVel, ACCEL_GROUND, p, dt);
  if ((cmd.buttons & BUTTON_JUMP) !== 0 && ((ps.flags & PMF_JUMP_HELD) === 0 || p.autoHop === 1)) {
    const push = p.ladderJumpPush;
    v[0] += n[0] * push;
    v[1] += n[1] * push;
    v[2] += n[2] * push;
    ps.flags = (ps.flags & ~PMF_ON_LADDER) | PMF_JUMP_HELD;
    if (ev !== null) ev.push(PMEV_JUMP, 0);
  }
  slideMove(ps, world, mins, maxs, p, dt, false, null, dbg);
}
