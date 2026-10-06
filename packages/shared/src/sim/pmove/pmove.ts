import { angleVectors } from "../../math/angles";
import type { CollisionWorld } from "../../world/collisionWorld";
import { MASK_PLAYERSOLID } from "../../world/contents";
import { SNAP_ROUNDED, snapOrigin } from "../../world/trace";
import { PMEV_LAND, type PmoveEvents } from "../events";
import { HULL_CROUCHED_MAXS, HULL_MINS, HULL_STANDING_MAXS } from "../hull";
import {
  type PlayerState,
  PMF_CROUCHED,
  PMF_GROUNDED,
  PMF_JUMP_HELD,
  quantizePlayerState,
} from "../playerState";
import { BUTTON_JUMP, type UserCmd } from "../usercmd";
import type { PmoveTraceLog } from "./debug";
import { groundTrace } from "./ground";
import type { PmoveParams } from "./params";
import { hull, prevOrigin, viewForward, viewRight, viewUp } from "./scratch";
import { airMove, walkMove } from "./walk";

/** [0]: vertical velocity at the tick's start; [1]: the LAND event's impact speed from it. */
const landing = new Float64Array(2);

let lastSnap = SNAP_ROUNDED;

/**
 * The snapOrigin outcome (SNAP_ROUNDED / CORNER / PREVIOUS) of the last pmove call, for tests,
 * benches and debug counters. Observer only, like the trace log.
 */
export function lastPmoveSnap(): number {
  return lastSnap;
}

/**
 * Crouch pre-check (docs/03 §4.12). For now it only picks the hull for the stance in
 * PMF_CROUCHED; the crouch and stand transitions with their stand test land in M2 increment 5.
 * This is the one place the hull changes, at the tick's start origin (M2 design §0).
 */
function checkCrouch(ps: PlayerState): void {
  hull.mins = HULL_MINS;
  hull.maxs = (ps.flags & PMF_CROUCHED) !== 0 ? HULL_CROUCHED_MAXS : HULL_STANDING_MAXS;
}

/**
 * Water-level pre-check (docs/03 §4.13): M2 increment 5. Until then ps.waterLevel and
 * PMF_IN_WATER pass through unchanged.
 */
function checkWaterLevel(_ps: PlayerState, _world: CollisionWorld): void {}

/** Ladder-contact pre-check (docs/03 §4.14): M2 increment 5; PMF_ON_LADDER passes through. */
function checkLadder(_ps: PlayerState, _world: CollisionWorld, _p: Readonly<PmoveParams>): void {}

/**
 * One tick of player movement (docs/03 §3, M2 design §2, D-023), in place on `ps`.
 * - `cmd` is already sanitized (sanitizeUserCmd); pmove trusts its ranges.
 * - `dt` is TICK_DT in play; tests pass other tick lengths (MV-04 runs 1/120).
 * - `ev` receives PMEV_STEP / JUMP / LAND; `dbg` records every trace. Both are output only: the
 *   tick simulates the same with or without them, and nothing from them feeds the next tick.
 * - `p` is read, never written; refresh it with refreshPmoveParams outside the tick.
 *
 * Pipeline: save the start origin; take the cmd's view angles and basis; release PMF_JUMP_HELD
 * once jump is up; pre-checks (crouch hull, water level, ladder); ground trace; walk when
 * grounded, else air (ladder and water moves join in increment 5); ground trace again, settling a
 * grounded player onto the ground, and water level again; snap the origin to the nearest clear
 * grid point with the tick's hull (D-017), falling back to the start origin; quantize the whole
 * state (docs/05 §4.1). A LAND event fires on whichever ground trace turns the player grounded,
 * with the downward speed at the tick's start.
 */
export function pmove(
  ps: PlayerState,
  cmd: UserCmd,
  world: CollisionWorld,
  p: Readonly<PmoveParams>,
  dt: number,
  ev: PmoveEvents | null,
  dbg: PmoveTraceLog | null,
): void {
  const o = ps.origin;
  prevOrigin[0] = o[0];
  prevOrigin[1] = o[1];
  prevOrigin[2] = o[2];
  landing[0] = ps.velocity[2];
  ps.viewYaw = cmd.yaw;
  ps.viewPitch = cmd.pitch;
  angleVectors(cmd.yaw, cmd.pitch, viewForward, viewRight, viewUp);
  if ((cmd.buttons & BUTTON_JUMP) === 0) ps.flags &= ~PMF_JUMP_HELD;

  checkCrouch(ps);
  checkWaterLevel(ps, world);
  checkLadder(ps, world, p);
  const mins = hull.mins;
  const maxs = hull.maxs;

  // LAND is emitted here rather than in a helper: a rarely called function runs unoptimized,
  // and there its double arithmetic boxes on every event.
  if (groundTrace(ps, world, p, mins, maxs, false, dbg) && ev !== null) {
    landing[1] = Math.max(0, 0 - (landing[0] as number));
    ev.pushFrom(PMEV_LAND, landing, 1);
  }
  if ((ps.flags & PMF_GROUNDED) !== 0) walkMove(ps, cmd, world, p, mins, maxs, dt, ev, dbg);
  else airMove(ps, cmd, world, p, mins, maxs, dt, ev, dbg);
  if (groundTrace(ps, world, p, mins, maxs, true, dbg) && ev !== null) {
    landing[1] = Math.max(0, 0 - (landing[0] as number));
    ev.pushFrom(PMEV_LAND, landing, 1);
  }
  checkWaterLevel(ps, world);

  lastSnap = snapOrigin(world, o, mins, maxs, MASK_PLAYERSOLID, prevOrigin, o);
  quantizePlayerState(ps);
}
