import { BUTTON_JUMP, MOVE_AXIS_MAX, PlayerState, PMF_GROUNDED, UserCmd } from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  RandomWalk,
  ROUTE_ESCAPE_TICKS,
  ROUTE_STUCK_WINDOW_TICKS,
  RouteInput,
  WALK_TURN_MAX_TICKS,
  WALK_TURN_MIN_TICKS,
} from "../../src/net/scriptedInput";

// The bots' cmd sources (M3 design §2.15) on hand-made states: which waypoint a route heads for,
// when it counts one reached, when its stuck detector fires and what it does then; the random
// walk's heading changes and hops. The route tests on arena_greybox with real pmove are in
// packages/tools/test/bots/routes.test.ts.

/** A grounded player standing at (x, y), facing yaw 0. */
function standing(x: number, y: number): PlayerState {
  const ps = new PlayerState();
  ps.origin[0] = x;
  ps.origin[1] = y;
  ps.origin[2] = 24;
  ps.flags = PMF_GROUNDED;
  return ps;
}

/** The yaw (u16) pointing from (x, y) toward (tx, ty). */
function yawToward(x: number, y: number, tx: number, ty: number): number {
  return Math.round(Math.atan2(ty - y, tx - x) * (65536 / (2 * Math.PI))) & 0xffff;
}

const SQUARE = [1000, 0, 0, 1000, -1000, 0, 0, -1000];

describe("RouteInput", () => {
  it("stands still while idle, then heads for the waypoint nearest to where it stands", () => {
    const route = new RouteInput(SQUARE, 1, { idleTicks: 3 });
    const cmd = new UserCmd();
    const ps = standing(-700, 100);
    for (let i = 0; i < 3; i++) {
      route.sample(cmd, ps);
      expect(cmd.forward).toBe(0);
      expect(cmd.buttons).toBe(0);
    }
    route.sample(cmd, ps);
    expect(cmd.forward).toBe(MOVE_AXIS_MAX);
    expect(cmd.yaw).toBe(yawToward(-700, 100, -1000, 0));
    expect(cmd.buttons).toBe(BUTTON_JUMP);
    expect(route.movingTicks).toBe(1);
  });

  it("counts a waypoint reached within its reach and moves on to the next, wrapping into laps", () => {
    const route = new RouteInput(SQUARE, 1, { idleTicks: 0, reach: 100 });
    const cmd = new UserCmd();
    route.sample(cmd, standing(900, 50));
    expect(route.reached).toBe(0);
    expect(cmd.yaw).toBe(yawToward(900, 50, 1000, 0));
    route.sample(cmd, standing(960, 10));
    expect(route.reached).toBe(1);
    expect(cmd.yaw).toBe(yawToward(960, 10, 0, 1000));
    for (const [x, y] of [
      [0, 960],
      [-960, 0],
      [0, -960],
      [960, 0],
    ] as const) {
      route.sample(cmd, standing(x, y));
    }
    expect(route.reached).toBe(5);
    expect(route.laps).toBe(1);
    expect(route.stuckEvents).toBe(0);
  });

  it("random-walks for a second when it makes no progress for two, then heads for the next waypoint", () => {
    const route = new RouteInput(SQUARE, 7, { idleTicks: 0 });
    const cmd = new UserCmd();
    const ps = standing(0, 0);
    for (let i = 0; i < ROUTE_STUCK_WINDOW_TICKS; i++) route.sample(cmd, ps);
    expect(route.stuckEvents).toBe(0);
    route.sample(cmd, ps);
    expect(route.stuckEvents).toBe(1);
    for (let i = 1; i < ROUTE_ESCAPE_TICKS; i++) route.sample(cmd, ps);
    // Stuck time: the window without progress and the walk out of it.
    expect(route.stuckTicks).toBe(ROUTE_STUCK_WINDOW_TICKS + ROUTE_ESCAPE_TICKS);
    // Then the next waypoint after the first (index 0 → 1).
    route.sample(cmd, ps);
    expect(route.stuckTicks).toBe(ROUTE_STUCK_WINDOW_TICKS + ROUTE_ESCAPE_TICKS);
    expect(cmd.yaw).toBe(yawToward(0, 0, 0, 1000));
    expect(route.reached).toBe(0);
  });

  it("keeps its window while it makes progress", () => {
    const route = new RouteInput(SQUARE, 1, { idleTicks: 0, reach: 10 });
    const cmd = new UserCmd();
    // 0.5 u per tick toward (1000, 0): 60 u per window, over the 32 u needed.
    for (let i = 0; i < 4 * ROUTE_STUCK_WINDOW_TICKS; i++) route.sample(cmd, standing(i * 0.5, 0));
    expect(route.stuckEvents).toBe(0);
  });

  it("is a pure function of its seed, samples and states", () => {
    const run = (seed: number) => {
      const route = new RouteInput(SQUARE, seed, { idleTicks: 0 });
      const cmd = new UserCmd();
      const out: number[] = [];
      for (let i = 0; i < 600; i++) {
        route.sample(cmd, standing(0, 0));
        out.push(cmd.yaw, cmd.buttons, cmd.forward);
      }
      return out;
    };
    expect(run(3)).toEqual(run(3));
    expect(run(3)).not.toEqual(run(4));
  });

  it("refuses a route of fewer than 2 waypoints or an odd coordinate count", () => {
    expect(() => new RouteInput([1, 2], 0)).toThrow();
    expect(() => new RouteInput([1, 2, 3], 0)).toThrow();
  });
});

describe("RandomWalk", () => {
  it("runs forward on headings that change every 1 to 3 s", () => {
    const walk = new RandomWalk(11, { idleTicks: 0 });
    const cmd = new UserCmd();
    const ps = standing(0, 0);
    const changes: number[] = [];
    let last = -1;
    for (let i = 0; i < 6000; i++) {
      walk.sample(cmd, ps);
      expect(cmd.forward).toBe(MOVE_AXIS_MAX);
      if (cmd.yaw !== last) changes.push(i);
      last = cmd.yaw;
    }
    expect(changes.length).toBeGreaterThan(6000 / WALK_TURN_MAX_TICKS);
    for (let k = 1; k < changes.length; k++) {
      const gap = (changes[k] as number) - (changes[k - 1] as number);
      expect(gap).toBeGreaterThanOrEqual(WALK_TURN_MIN_TICKS);
      expect(gap).toBeLessThanOrEqual(WALK_TURN_MAX_TICKS);
    }
  });

  it("hops on some headings, pressing jump for 8 ticks whenever it stands", () => {
    const walk = new RandomWalk(5, { idleTicks: 0 });
    const cmd = new UserCmd();
    const ps = standing(0, 0);
    let jumpTicks = 0;
    let quiet = 0;
    for (let i = 0; i < 6000; i++) {
      walk.sample(cmd, ps);
      if (cmd.buttons === BUTTON_JUMP) jumpTicks++;
      else quiet++;
    }
    expect(jumpTicks).toBeGreaterThan(1000);
    expect(quiet).toBeGreaterThan(1000);
  });

  it("stands still while idle and is a pure function of its seed", () => {
    const run = (seed: number) => {
      const walk = new RandomWalk(seed, { idleTicks: 10 });
      const cmd = new UserCmd();
      const out: number[] = [];
      for (let i = 0; i < 1000; i++) {
        walk.sample(cmd, standing(0, 0));
        if (i < 10) expect(cmd.forward).toBe(0);
        out.push(cmd.yaw, cmd.buttons);
      }
      return out;
    };
    expect(run(9)).toEqual(run(9));
    expect(run(9)).not.toEqual(run(10));
  });
});
