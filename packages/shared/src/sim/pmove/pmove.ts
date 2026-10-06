import { angleVectors } from "../../math/angles";
import type { CollisionWorld } from "../../world/collisionWorld";
import { MASK_PLAYERSOLID } from "../../world/contents";
import { SNAP_ROUNDED, snapOrigin } from "../../world/trace";
import { PMEV_LAND, type PmoveEvents } from "../events";
import {
  type PlayerState,
  PMF_GROUNDED,
  PMF_JUMP_HELD,
  PMF_ON_LADDER,
  quantizePlayerState,
} from "../playerState";
import { BUTTON_JUMP, type UserCmd } from "../usercmd";
import { checkCrouch } from "./crouch";
import type { PmoveTraceLog } from "./debug";
import { groundTrace } from "./ground";
import { checkLadder, ladderMove } from "./ladder";
import type { PmoveParams } from "./params";
import { hull, prevOrigin, viewForward, viewRight, viewUp } from "./scratch";
import { airMove, walkMove } from "./walk";
import { checkWaterLevel, SWIM_WATER_LEVEL, waterMove } from "./water";

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
 * One tick of player movement (docs/03 §3, M2 design §2, D-023), in place on `ps`.
 * - `cmd` is already sanitized (sanitizeUserCmd); pmove trusts its ranges.
 * - `dt` is TICK_DT in play; tests pass other tick lengths (MV-04 runs 1/120).
 * - `ev` receives PMEV_STEP / JUMP / LAND; `dbg` records every trace. Both are output only: the
 *   tick simulates the same with or without them, and nothing from them feeds the next tick.
 * - `p` is read, never written; refresh it with refreshPmoveParams outside the tick.
 *
 * Pipeline: save the start origin; take the cmd's view angles and basis; release PMF_JUMP_HELD
 * once jump is up; pre-checks at the start origin (crouch and the tick's hull, then water level
 * for that stance, then ladder contact with that hull); ground trace; the move, first match wins:
 * ladder, swim (water level ≥ 2), walk when grounded, else air; ground trace again, settling a
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

  checkCrouch(ps, cmd, world);
  const mins = hull.mins;
  const maxs = hull.maxs;
  checkWaterLevel(ps, world);
  checkLadder(ps, cmd, world, p, mins, maxs, dbg);

  // LAND is emitted here rather than in a helper: a rarely called function runs unoptimized,
  // and there its double arithmetic boxes on every event.
  if (groundTrace(ps, world, p, mins, maxs, false, dbg) && ev !== null) {
    landing[1] = Math.max(0, 0 - (landing[0] as number));
    ev.pushFrom(PMEV_LAND, landing, 1);
  }
  if ((ps.flags & PMF_ON_LADDER) !== 0) ladderMove(ps, cmd, world, p, mins, maxs, dt, ev, dbg);
  else if (ps.waterLevel >= SWIM_WATER_LEVEL) waterMove(ps, cmd, world, p, mins, maxs, dt, ev, dbg);
  else if ((ps.flags & PMF_GROUNDED) !== 0) walkMove(ps, cmd, world, p, mins, maxs, dt, ev, dbg);
  else airMove(ps, cmd, world, p, mins, maxs, dt, ev, dbg);
  if (groundTrace(ps, world, p, mins, maxs, true, dbg) && ev !== null) {
    landing[1] = Math.max(0, 0 - (landing[0] as number));
    ev.pushFrom(PMEV_LAND, landing, 1);
  }
  checkWaterLevel(ps, world);

  lastSnap = snapOrigin(world, o, mins, maxs, MASK_PLAYERSOLID, prevOrigin, o);
  quantizePlayerState(ps);
}
