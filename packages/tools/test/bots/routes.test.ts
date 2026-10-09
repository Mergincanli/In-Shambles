import { RandomWalk, RouteInput } from "@game/client/net";
import { SpawnRotation } from "@game/server";
import { PlayerState, vec3 } from "@game/shared";
import { describe, expect, it } from "vitest";
import { ARENA_RING, createBotInput, routeFor, runsRoute } from "../../src/bots/routes";
import { loadCourse } from "../../src/scenarios/course";
import { placePlayer, ScenarioRunner } from "../../src/scenarios/runner";

// The bots' routes (M3 design §5 "Bots", §6 increment 6: "route tests (laps, < 5% stuck)") with
// real pmove on the committed arena_greybox: a route bot starting at each of the 16 spawn points
// (bot i joins as client i and spawns at point i % 16) laps the yard ring for 60 s, spending under
// 5% of its moving time stuck; a random walk from each point covers the yard without leaving it.

const SECONDS = 60;
const TICKS = SECONDS * 60;

const course = loadCourse("arena_greybox");
const spawns = new SpawnRotation(course.cmap, course.world, () => {});

describe("bot routes on arena_greybox", () => {
  it("has 16 spawn points, the route's start points", () => {
    expect(spawns.count).toBe(16);
  });

  it.each(Array.from({ length: 16 }, (_, i) => [i]))(
    "laps the yard ring from spawn point %i, stuck under 5% of the time",
    (i) => {
      const runner = new ScenarioRunner(course.world);
      const ps = placePlayer(new PlayerState(), spawns.origin(i, vec3()), spawns.yaw(i));
      const route = new RouteInput(ARENA_RING, 100 + i);
      let top = 0;
      runner.run(
        ps,
        {
          next: (cmd, p) => {
            route.sample(cmd, p);
            top = Math.max(top, Math.hypot(p.velocity[0] as number, p.velocity[1] as number));
          },
        },
        TICKS,
      );
      const stuck = route.stuckTicks / route.movingTicks;
      const detail = `laps ${route.laps}, stuck ${route.stuckEvents}× (${(stuck * 100).toFixed(1)}%), top ${top.toFixed(0)} u/s`;
      expect(route.laps, detail).toBeGreaterThanOrEqual(3);
      expect(stuck, detail).toBeLessThan(0.05);
      // Strafe-jumping, not running: past the 320 u/s run speed.
      expect(top, detail).toBeGreaterThan(450);
    },
  );

  it("random walks from every spawn point range over the yard and stay inside it", () => {
    for (let i = 0; i < 16; i++) {
      const runner = new ScenarioRunner(course.world);
      const ps = placePlayer(new PlayerState(), spawns.origin(i, vec3()), spawns.yaw(i));
      const walk = new RandomWalk(7 + i);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      runner.run(
        ps,
        {
          next: (cmd, p) => {
            walk.sample(cmd, p);
            minX = Math.min(minX, p.origin[0] as number);
            maxX = Math.max(maxX, p.origin[0] as number);
            minY = Math.min(minY, p.origin[1] as number);
            maxY = Math.max(maxY, p.origin[1] as number);
          },
        },
        TICKS,
      );
      expect(Math.max(maxX - minX, maxY - minY), `spawn ${i}`).toBeGreaterThan(600);
      expect(Math.max(-minX, maxX), `spawn ${i}`).toBeLessThan(1536);
      expect(Math.max(-minY, maxY), `spawn ${i}`).toBeLessThan(1024);
    }
  });
});

describe("bot behaviours", () => {
  it("run the route on 3 of every 5 bots and walk on the rest, where the map has a route", () => {
    const kinds = Array.from({ length: 10 }, (_, i) => runsRoute(i));
    expect(kinds).toEqual([true, true, true, false, false, true, true, true, false, false]);
    expect(createBotInput("arena_greybox", 0, 1)).toBeInstanceOf(RouteInput);
    expect(createBotInput("arena_greybox", 3, 1)).toBeInstanceOf(RandomWalk);
    expect(routeFor("movement_lab")).toBeNull();
    expect(createBotInput("movement_lab", 0, 1)).toBeInstanceOf(RandomWalk);
  });
});
