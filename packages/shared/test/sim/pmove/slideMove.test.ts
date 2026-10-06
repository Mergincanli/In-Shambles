import { afterEach, describe, expect, it } from "vitest";
import { DevAssertError, setDevAsserts } from "../../../src/debug/assert";
import { type Vec3, vec3 } from "../../../src/math/vec3";
import { HULL_MINS, HULL_STANDING_MAXS } from "../../../src/sim/hull";
import { PlayerState } from "../../../src/sim/playerState";
import { PmoveTraceLog } from "../../../src/sim/pmove/debug";
import { PmoveParams } from "../../../src/sim/pmove/params";
import { slideMove } from "../../../src/sim/pmove/slideMove";
import { TICK_DT } from "../../../src/time";
import { rotatedBoxPlanes } from "../../../src/world/shapes";
import { TRACE_EPSILON } from "../../../src/world/trace";
import { box, floorBrush, restZ } from "../../helpers/pmoveWorld";
import { brush, worldOf } from "../../helpers/traceWorld";

// docs/03 §4.6 and §4.8, D-023: the multi-plane slide with half-step gravity.

const p = new PmoveParams();
const UP = vec3(0, 0, 1);
const C30 = Math.sqrt(3) / 2;

function at(x: number, y: number, z: number, vx: number, vy: number, vz: number): PlayerState {
  const ps = new PlayerState();
  ps.origin.set([x, y, z]);
  ps.velocity.set([vx, vy, vz]);
  return ps;
}

function slide(
  ps: PlayerState,
  world: ReturnType<typeof worldOf>,
  dt: number,
  gravity: boolean,
  groundNormal: Vec3 | null,
  log: PmoveTraceLog | null = null,
): boolean {
  return slideMove(ps, world, HULL_MINS, HULL_STANDING_MAXS, p, dt, gravity, groundNormal, log);
}

/**
 * Two 256 u walls meeting at the apex (100, 0) at ±30° from the x axis, an acute V opening toward
 * −x: the upper wall's face normal is (−1/2, −√3/2, 0), the lower one's (−1/2, √3/2, 0).
 */
function vWalls() {
  const hx = 128;
  const hy = 16;
  const hz = 128;
  const apex = [100, 0] as const;
  // Upper: rotated −30°, u = (√3/2, −1/2), v = (1/2, √3/2); its −v face runs through the apex.
  const upper = rotatedBoxPlanes(
    [apex[0] + 0.5 * hy - C30 * hx * 0.9, apex[1] + C30 * hy + 0.5 * hx * 0.9, 64],
    [hx, hy, hz],
    C30,
    -0.5,
  );
  // Lower: rotated +30°, u = (√3/2, 1/2), v = (−1/2, √3/2); its +v face runs through the apex.
  const lower = rotatedBoxPlanes(
    [apex[0] + 0.5 * hy - C30 * hx * 0.9, apex[1] - C30 * hy - 0.5 * hx * 0.9, 64],
    [hx, hy, hz],
    C30,
    0.5,
  );
  return [brush(upper), brush(lower)];
}

afterEach(() => setDevAsserts(true));

describe("slideMove (docs/03 §4.8)", () => {
  it("moves the whole way and reports no hit in the open", () => {
    const world = worldOf(floorBrush());
    const ps = at(0, 0, restZ(0), 300, -120, 0);
    expect(slide(ps, world, TICK_DT, false, UP)).toBe(false);
    expect(ps.origin[0]).toBeCloseTo(5, 12);
    expect(ps.origin[1]).toBeCloseTo(-2, 12);
    expect(ps.origin[2]).toBe(restZ(0));
    expect([...ps.velocity]).toEqual([300, -120, 0]);
  });

  it("stops ε short of one wall and slides along it with the rest of the time", () => {
    const world = worldOf(floorBrush(), box([64, -512, 0], [128, 512, 128]));
    // The hull's +x side is 2 u from the wall; the move wants 10 u.
    const ps = at(47, 0, restZ(0), 600, 300, 0);
    expect(slide(ps, world, TICK_DT, false, UP)).toBe(true);
    const f = (2 - TRACE_EPSILON) / 10;
    // The overclip leaves the velocity pointing 0.1% back out of the wall.
    expect(ps.velocity[0]).toBeCloseTo(600 - 600 * p.overclip, 9);
    expect(ps.origin[0]).toBeCloseTo(
      64 - 15 - TRACE_EPSILON + ps.velocity[0] * (1 - f) * TICK_DT,
      9,
    );
    expect(ps.velocity[1]).toBe(300);
    expect(ps.origin[1]).toBeCloseTo(5, 9);
    expect(ps.velocity[2]).toBe(0);
    expect(ps.origin[2]).toBe(restZ(0));
  });

  it("slides along the crease of two walls it moves into", () => {
    const world = worldOf(...vWalls());
    const ps = at(0, 0, 0, 600, 50, 100);
    expect(slide(ps, world, 0.2, false, null)).toBe(true);
    // The crease of two vertical walls is vertical: only the upward speed survives.
    expect(Math.abs(ps.velocity[0])).toBeLessThan(1e-9);
    expect(Math.abs(ps.velocity[1])).toBeLessThan(1e-9);
    expect(ps.velocity[2]).toBeCloseTo(100, 9);
    expect(ps.origin[2]).toBeGreaterThan(5);
    // Wedged into the V: the hull's corner sits near the apex, short of it.
    expect(ps.origin[0]).toBeGreaterThan(40);
    expect(ps.origin[0]).toBeLessThan(100);
  });

  it("stops dead against three planes: the floor and an acute corner", () => {
    const world = worldOf(floorBrush(), ...vWalls());
    const ps = at(0, 0, restZ(0), 600, 50, 0);
    expect(slide(ps, world, 0.2, false, UP)).toBe(true);
    expect([...ps.velocity]).toEqual([0, 0, 0]);
    expect(ps.origin[2]).toBe(restZ(0));
  });

  it("stops when a clip turns the move against the entering velocity", () => {
    // Straight down onto a floor: the clipped velocity points (barely) up, against the fall.
    const world = worldOf(floorBrush());
    const ps = at(0, 0, restZ(0) + 1, 0, 0, -600);
    expect(slide(ps, world, TICK_DT, false, null)).toBe(true);
    expect([...ps.velocity]).toEqual([0, 0, 0]);
    expect(ps.origin[2]).toBeCloseTo(restZ(0), 9);
  });

  it("nudges off a stored plane it hits again instead of clipping against it twice", () => {
    // Resting in the floor's ε skin and moving 1 u/s into it: the sweep hits the floor at once.
    // With the floor stored as the ground plane that is the same plane (step 3): the velocity is
    // nudged out by the normal and the move goes on. As a new plane it would be clipped.
    const world = worldOf(floorBrush());
    const grounded = at(0, 0, restZ(0), 300, 0, -1);
    expect(slide(grounded, world, TICK_DT, false, UP)).toBe(true);
    expect([...grounded.velocity]).toEqual([300, 0, 0]);
    expect(grounded.origin[0]).toBeCloseTo(5, 9);
    const airborne = at(0, 0, restZ(0), 300, 0, -1);
    slide(airborne, world, TICK_DT, false, null);
    expect(airborne.velocity[2]).toBeCloseTo(p.overclip - 1, 12);
  });

  it("clips against a stored plane the velocity leaves at under 0.1 u/s", () => {
    // Into a wall while barely rising off the ground plane: after the wall clip the ground still
    // counts as "moved into" (SLIDE_LEAVE_SPEED) and is clipped too, taking out the 0.05 u/s.
    const world = worldOf(floorBrush(), box([64, -512, 0], [128, 512, 128]));
    const ps = at(47, 0, restZ(0), 600, 300, 0.05);
    expect(slide(ps, world, TICK_DT, false, UP)).toBe(true);
    expect(ps.velocity[2]).toBeGreaterThanOrEqual(0);
    expect(ps.velocity[2]).toBeLessThan(0.001);
    expect(ps.velocity[1]).toBe(300);
  });

  it("is stuck only when allSolid: vz zeroed, blocked, and a dev assert", () => {
    const world = worldOf(box([-64, -64, -64], [64, 64, 64]));
    const ps = at(0, 0, 0, 100, 0, 50);
    expect(() => slide(ps, world, TICK_DT, false, null)).toThrow(DevAssertError);
    setDevAsserts(false);
    const again = at(0, 0, 0, 100, 0, 50);
    expect(slide(again, world, TICK_DT, false, null)).toBe(true);
    expect([...again.velocity]).toEqual([100, 0, 0]);
    expect([...again.origin]).toEqual([0, 0, 0]);
  });

  it("accepts a sweep that starts solid but moves out (D-023)", () => {
    // The hull overlaps the box's −x side by 5 u and moves 10 u away from it.
    const world = worldOf(box([0, -64, -64], [100, 64, 64]));
    const ps = at(-10, 0, 0, -600, 0, 0);
    expect(slide(ps, world, TICK_DT, false, null)).toBe(false);
    expect(ps.origin[0]).toBeCloseTo(-20, 12);
    expect(ps.velocity[0]).toBe(-600);
  });

  it("records every sweep in the trace log", () => {
    const world = worldOf(floorBrush(), box([64, -512, 0], [128, 512, 128]));
    const log = new PmoveTraceLog();
    slide(at(47, 0, restZ(0), 600, 300, 0), world, TICK_DT, false, UP, log);
    expect(log.count).toBe(2);
  });
});

describe("half-step gravity (docs/03 §4.6)", () => {
  it.each([TICK_DT, 1 / 120])("integrates a free fall exactly over one tick of %f s", (dt) => {
    const world = worldOf(floorBrush());
    const ps = at(0, 0, 500, 40, 0, 270);
    expect(slide(ps, world, dt, true, null)).toBe(false);
    expect(ps.velocity[2]).toBeCloseTo(270 - p.gravity * dt, 12);
    expect(ps.origin[2]).toBeCloseTo(500 + 270 * dt - 0.5 * p.gravity * dt * dt, 12);
    expect(ps.velocity[0]).toBe(40);
  });

  it("clips the end-of-tick velocity against the floor it lands on", () => {
    const world = worldOf(floorBrush());
    const ps = at(0, 0, restZ(0) + 2, 300, 0, -400);
    expect(slide(ps, world, TICK_DT, true, null)).toBe(true);
    // ε above the floor, plus what the overclip's push lifts it in the rest of the tick.
    expect(ps.origin[2]).toBeGreaterThanOrEqual(restZ(0));
    expect(ps.origin[2]).toBeLessThan(restZ(0) + 0.01);
    // Landed: the fall is clipped away, leaving the overclip's slight upward push.
    expect(ps.velocity[2]).toBeGreaterThanOrEqual(0);
    expect(ps.velocity[2]).toBeLessThan(1);
    expect(ps.velocity[0]).toBe(300);
  });
});
