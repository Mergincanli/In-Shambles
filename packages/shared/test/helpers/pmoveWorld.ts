import type { Vec3 } from "../../src/math/vec3";
import { PmoveEvent, PmoveEvents } from "../../src/sim/events";
import { HULL_MINS } from "../../src/sim/hull";
import { PlayerState, PMF_GROUNDED } from "../../src/sim/playerState";
import type { PmoveTraceLog } from "../../src/sim/pmove/debug";
import { PmoveParams } from "../../src/sim/pmove/params";
import { pmove } from "../../src/sim/pmove/pmove";
import { UserCmd } from "../../src/sim/usercmd";
import { TICK_DT } from "../../src/time";
import type { CollisionWorld } from "../../src/world/collisionWorld";
import { boxPlanes, type Triple } from "../../src/world/shapes";
import { TRACE_EPSILON } from "../../src/world/trace";
import { brush } from "./traceWorld";

/** Synthetic worlds and drivers for the pmove unit tests (shapes → brushes, as in traceWorld). */

/** Origin z of a player resting on a floor at height `floor`: feet one ε above it (D-017). */
export function restZ(floor: number): number {
  return floor - (HULL_MINS[2] as number) + TRACE_EPSILON;
}

/** The floor every pmove world stands on: its top is z = 0. */
export function floorBrush(half = 2048) {
  return brush(boxPlanes([-half, -half, -64], [half, half, 0]));
}

export function box(min: Triple, max: Triple) {
  return brush(boxPlanes(min, max));
}

/** A grounded player at (x, y, restZ(floor)) with zero velocity. */
export function player(x: number, y: number, floor = 0): PlayerState {
  const ps = new PlayerState();
  ps.origin[0] = x;
  ps.origin[1] = y;
  ps.origin[2] = restZ(floor);
  ps.flags = PMF_GROUNDED;
  return ps;
}

export interface CmdInit {
  forward?: number;
  right?: number;
  buttons?: number;
  yaw?: number;
  pitch?: number;
}

export function cmd(init: CmdInit = {}): UserCmd {
  const c = new UserCmd();
  c.forward = init.forward ?? 0;
  c.right = init.right ?? 0;
  c.buttons = init.buttons ?? 0;
  c.yaw = init.yaw ?? 0;
  c.pitch = init.pitch ?? 0;
  return c;
}

export interface RunResult {
  /** Origin z after every tick. */
  readonly z: number[];
  /** Every event as [tick, type, value], in order. */
  readonly events: [number, number, number][];
}

/** Runs `ticks` pmove ticks with the cmd for tick t from `input(t)`, collecting z and events. */
export function run(
  ps: PlayerState,
  world: CollisionWorld,
  input: (t: number) => UserCmd,
  ticks: number,
  options: {
    params?: PmoveParams;
    dt?: number;
    log?: PmoveTraceLog | null;
    each?: (t: number) => void;
  } = {},
): RunResult {
  const p = options.params ?? new PmoveParams();
  const ev = new PmoveEvents();
  const z: number[] = [];
  const events: [number, number, number][] = [];
  for (let t = 0; t < ticks; t++) {
    pmove(ps, input(t), world, p, options.dt ?? TICK_DT, ev, options.log ?? null);
    z.push(ps.origin[2]);
    for (const [type, value] of eventList(ev)) events.push([t, type, value]);
    ev.clear();
    options.each?.(t);
  }
  return { z, events };
}

/** The events in the ring as [type, value] pairs, oldest first. */
export function eventList(ev: PmoveEvents): [number, number][] {
  const out: [number, number][] = [];
  const e = new PmoveEvent();
  for (let i = 0; i < ev.count; i++) {
    ev.read(i, e);
    out.push([e.type, e.value]);
  }
  return out;
}

export function horizontalSpeed(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
}
