import { describe, expect, it } from "vitest";
import { vec3 } from "../../../src/math/vec3";
import { PMEV_STEP, PmoveEvents } from "../../../src/sim/events";
import { HULL_MINS, HULL_STANDING_MAXS } from "../../../src/sim/hull";
import { PlayerState, PMF_GROUNDED } from "../../../src/sim/playerState";
import { PmoveParams } from "../../../src/sim/pmove/params";
import { stepSlideMove } from "../../../src/sim/pmove/stepSlideMove";
import { BUTTON_WALK } from "../../../src/sim/usercmd";
import { TICK_DT } from "../../../src/time";
import { rotatedBoxPlanes, wedgePlanes } from "../../../src/world/shapes";
import { TRACE_EPSILON } from "../../../src/world/trace";
import {
  box,
  cmd,
  eventList,
  floorBrush,
  horizontalSpeed,
  player,
  restZ,
  run,
} from "../../helpers/pmoveWorld";
import { brush, worldOf } from "../../helpers/traceWorld";

// docs/03 §4.9: auto-step up to pm_stepSize (18 climbs, 19 blocks; docs/07 §6).

const p = new PmoveParams();
const UP = vec3(0, 0, 1);

/** A floor and a 256 u wide block of height `h` whose near face is at x = 64. */
function stepWorld(h: number) {
  return worldOf(floorBrush(), box([64, -128, 0], [320, 128, h]));
}

/** Walks a grounded player at the origin toward +x for `ticks` ticks. */
function walkForward(h: number, ticks: number) {
  const ps = player(0, 0);
  const result = run(ps, stepWorld(h), () => cmd({ forward: 127 }), ticks);
  return { ps, ...result };
}

describe("stepSlideMove (docs/03 §4.9)", () => {
  it.each([16, 18])("climbs a %i u step with one STEP event of that height", (h) => {
    const { ps, events } = walkForward(h, 60);
    expect(ps.origin[2]).toBe(restZ(h));
    expect(ps.origin[0]).toBeGreaterThan(64 + 15);
    expect(ps.flags & PMF_GROUNDED).toBe(PMF_GROUNDED);
    const steps = events.filter(([, type]) => type === PMEV_STEP);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.[2]).toBeCloseTo(h, 9);
  });

  it("is blocked by a 19 u step: no climb, no STEP event", () => {
    const { ps, events } = walkForward(19, 60);
    expect(ps.origin[2]).toBe(restZ(0));
    expect(ps.origin[0]).toBe(64 - 15 - TRACE_EPSILON);
    expect(events.filter(([, type]) => type === PMEV_STEP)).toEqual([]);
  });

  it("does not step while sliding along a wall", () => {
    // A wall rotated 30° from the walk direction whose face runs through (100, −60), so the
    // walk meets it after about 150 u and slides along it.
    const c = Math.sqrt(3) / 2;
    const center = [100 + 8 + c * 100, -60 - c * 16 + 50, 64] as const;
    const wall = brush(rotatedBoxPlanes(center, [256, 16, 64], c, 0.5));
    const ps = player(0, 0);
    const { events } = run(ps, worldOf(floorBrush(), wall), () => cmd({ forward: 127 }), 90);
    expect(ps.origin[2]).toBe(restZ(0));
    // Deflected along the wall.
    expect(ps.origin[1]).toBeGreaterThan(40);
    expect(events.filter(([, type]) => type === PMEV_STEP)).toEqual([]);
  });

  it.each([0.71, 0.8, 0.9])("does not step while walking up a %f slope (STEP_MIN_GAIN)", (nz) => {
    // The sweeps along the slope graze it (D-017: tangency is not exact), so the stepped path is
    // tried, and it lands back on the slope a rounding error away from the plain one.
    const rise = (2048 * Math.sqrt(1 - nz * nz)) / nz;
    const world = worldOf(
      floorBrush(4096),
      brush(wedgePlanes([-512, 0, 0], [512, 2048, rise], "+y")),
    );
    const ps = player(0, -40);
    const { events } = run(ps, world, () => cmd({ forward: 127, yaw: 16384 }), 240);
    expect(ps.origin[2]).toBeGreaterThan(200);
    expect(events.filter(([, type]) => type === PMEV_STEP)).toEqual([]);
  });

  it("steps up a ledge while falling but not while rising with no ground within pm_stepSize", () => {
    // A pillar whose top is at z = 200, high above the floor; the hull's feet are 10 u below
    // the top and 2 u from the pillar's side.
    const world = worldOf(
      box([-512, -512, -400], [512, 512, -300]),
      box([64, -64, 0], [192, 64, 200]),
    );
    for (const [vz, climbs] of [
      [-50, true],
      [50, false],
    ] as const) {
      const ps = new PlayerState();
      ps.origin.set([64 - 15 - 2, 0, 200 - 10 + 24]);
      ps.velocity.set([300, 0, vz]);
      const ev = new PmoveEvents();
      stepSlideMove(ps, world, HULL_MINS, HULL_STANDING_MAXS, p, TICK_DT, true, null, ev, null);
      expect(ps.origin[0] > 64 - 15, `vz ${vz}`).toBe(climbs);
      expect(ps.origin[2] >= restZ(200) - 1e-9, `vz ${vz}`).toBe(climbs);
      expect(eventList(ev).length, `vz ${vz}`).toBe(climbs ? 1 : 0);
    }
  });

  it("does not step onto a steep ledge top", () => {
    // A 10 u box at x ≥ 64 carrying a 0.2-normal wedge: the top within pm_stepSize is not
    // walkable, so the stepped path is refused and the walk stays on the floor.
    const world = worldOf(
      floorBrush(),
      box([64, -128, 0], [320, 128, 10]),
      brush(wedgePlanes([64, -128, 10], [104, 128, 210], "+x")),
    );
    const ps = player(0, 0);
    const { events } = run(ps, world, () => cmd({ forward: 127 }), 60);
    expect(ps.origin[2]).toBe(restZ(0));
    expect(ps.origin[0]).toBe(64 - 15 - TRACE_EPSILON);
    expect(events.filter(([, type]) => type === PMEV_STEP)).toEqual([]);
  });

  it("steps while rising when walkable ground is within pm_stepSize below, not over steep ground", () => {
    // A pillar with its top at z = 20 and the hull's feet at z = 8, 2 u from its side.
    const pillar = box([64, -64, -400], [192, 64, 20]);
    // Under the hull: a floor 8 u below the feet, or a 0.5-normal slope about 7 u below.
    const steep = brush(
      wedgePlanes([-100, -64, -280], [64, -64 + 128, -280 + 164 * Math.sqrt(3)], "+x"),
    );
    for (const [name, below, climbs] of [
      ["floor", floorBrush(), true],
      ["steep", steep, false],
    ] as const) {
      const ps = new PlayerState();
      ps.origin.set([64 - 15 - 2, 0, 8 + 24]);
      ps.velocity.set([300, 0, 50]);
      const ev = new PmoveEvents();
      const world = worldOf(pillar, below);
      stepSlideMove(ps, world, HULL_MINS, HULL_STANDING_MAXS, p, TICK_DT, true, null, ev, null);
      expect(ps.origin[0] > 64 - 15, name).toBe(climbs);
      expect(ps.origin[2] > restZ(20) - 1, name).toBe(climbs);
      expect(eventList(ev).length, name).toBe(climbs ? 1 : 0);
    }
  });

  it.each([
    ["run", 0, 320, 80],
    ["walk", BUTTON_WALK, 160, 150],
  ] as const)(
    "climbs 16 u stairs at %s speed without snagging, at any phase (D-023)",
    (_, buttons, cap, ticks) => {
      // Eight 16 u stairs, 16 u deep, from y = 200. A player reaching a riser near a tick's end
      // must keep going: the stepped path ties with the plain one and keeps its velocity.
      const parts = [floorBrush()];
      for (let i = 0; i < 8; i++) {
        parts.push(box([-128, 200 + i * 16, 0], [128, 4000, 16 * (i + 1)]));
      }
      const world = worldOf(...parts);
      let worst: number = cap;
      for (let k = 0; k < 192; k++) {
        const ps = player(0, k / 32);
        let started = false;
        run(ps, world, () => cmd({ forward: 127, yaw: 16384, buttons }), ticks, {
          each: () => {
            const s = horizontalSpeed(ps.velocity);
            if (s > cap * 0.99) started = true;
            if (started && ps.origin[1] < 200 + 8 * 16) worst = Math.min(worst, s);
          },
        });
        expect(ps.origin[2], `start ${k}/32`).toBe(restZ(128));
      }
      expect(worst).toBeGreaterThan(cap * 0.9);
    },
  );

  it("clips a kept step's velocity against the ground it lands on", () => {
    // Running at the run cap onto the foot of a 0.71 upslope: the stepped path lands on the
    // slope, and the velocity follows it instead of keeping its horizontal 320 u/s.
    const nz = 0.71;
    const rise = (512 * Math.sqrt(1 - nz * nz)) / nz;
    const world = worldOf(floorBrush(), brush(wedgePlanes([64, -128, 0], [576, 128, rise], "+x")));
    const ps = player(0, 0);
    let first = -1;
    run(ps, world, () => cmd({ forward: 127 }), 60, {
      each: () => {
        if (first < 0 && ps.origin[2] > restZ(0) + 1) first = horizontalSpeed(ps.velocity);
      },
    });
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(320 * 0.75);
  });

  it("steps over a low rail back down to the floor, reporting no sub-grid STEP", () => {
    // A 4 u rail 1 u thick, 5 u ahead of the hull; one long move clears it. The stepped path
    // comes down on the floor (found by the extra pm_groundTraceDist of the down trace), 1/64 u
    // below the hovering start: kept, but too small a height change for a STEP event.
    const world = worldOf(floorBrush(), box([20, -128, 0], [21, 128, 4]));
    const ps = new PlayerState();
    ps.origin.set([0, 0, restZ(0) + 1 / 64]);
    ps.velocity.set([300, 0, 0]);
    const ev = new PmoveEvents();
    stepSlideMove(ps, world, HULL_MINS, HULL_STANDING_MAXS, p, 0.2, false, UP, ev, null);
    expect(ps.origin[0]).toBeCloseTo(60, 9);
    expect(ps.origin[2]).toBeCloseTo(restZ(0), 9);
    expect(ev.count).toBe(0);
  });

  it("returns after the plain slide when nothing is hit", () => {
    const world = stepWorld(18);
    const ps = player(0, 0);
    ps.velocity.set([120, 0, 0]);
    const ev = new PmoveEvents();
    stepSlideMove(ps, world, HULL_MINS, HULL_STANDING_MAXS, p, TICK_DT, false, UP, ev, null);
    expect(ps.origin[0]).toBeCloseTo(2, 12);
    expect(ev.count).toBe(0);
  });
});
