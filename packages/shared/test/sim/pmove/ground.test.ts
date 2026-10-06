import { describe, expect, it } from "vitest";
import { vec3 } from "../../../src/math/vec3";
import { ENTITY_NONE, ENTITY_WORLD } from "../../../src/sim/entity";
import { HULL_MINS, HULL_STANDING_MAXS } from "../../../src/sim/hull";
import { PlayerState, PMF_GROUNDED } from "../../../src/sim/playerState";
import { GROUND_LEAVE_SPEED, groundTrace } from "../../../src/sim/pmove/ground";
import { PmoveParams } from "../../../src/sim/pmove/params";
import { ground } from "../../../src/sim/pmove/scratch";
import type { CollisionWorld } from "../../../src/world/collisionWorld";
import {
  CONTENTS_NODAMAGE,
  CONTENTS_SLICK,
  CONTENTS_SOLID,
  MASK_PLAYERSOLID,
  SURF_NODAMAGE,
  SURF_SLICK,
} from "../../../src/world/contents";
import { boxPlanes, wedgePlanes } from "../../../src/world/shapes";
import { snapOrigin, TraceResult, traceBox } from "../../../src/world/trace";
import { floorBrush, player, restZ } from "../../helpers/pmoveWorld";
import { brush, worldOf } from "../../helpers/traceWorld";

// docs/03 §4.10 and D-023: what the ground probe calls ground.

const p = new PmoveParams();

function trace(ps: PlayerState, world: CollisionWorld): boolean {
  return groundTrace(ps, world, p, HULL_MINS, HULL_STANDING_MAXS, false, null);
}

/** A 256 u slope rising toward +y from y = 0 whose normal z is `nz`. */
function slope(nz: number, contents = CONTENTS_SOLID, surf = 0) {
  const run = 256;
  const rise = (run * Math.sqrt(1 - nz * nz)) / nz;
  return brush(wedgePlanes([-128, 0, 0], [128, run, rise], "+y"), contents, () => surf);
}

/** A player dropped onto the world at (x, y) from z = 600 and snapped like a tick's end. */
function dropped(world: CollisionWorld, x: number, y: number): PlayerState {
  const tr = new TraceResult();
  traceBox(
    world,
    vec3(x, y, 600),
    vec3(x, y, -100),
    HULL_MINS,
    HULL_STANDING_MAXS,
    MASK_PLAYERSOLID,
    tr,
  );
  const ps = new PlayerState();
  snapOrigin(
    world,
    tr.endpos,
    HULL_MINS,
    HULL_STANDING_MAXS,
    MASK_PLAYERSOLID,
    tr.endpos,
    ps.origin,
  );
  return ps;
}

describe("groundTrace (docs/03 §4.10)", () => {
  const flat = worldOf(floorBrush());

  it("grounds a player resting on a floor on the world entity", () => {
    const ps = player(0, 0);
    ps.flags = 0;
    expect(trace(ps, flat)).toBe(true);
    expect(ps.flags & PMF_GROUNDED).toBe(PMF_GROUNDED);
    expect(ps.groundEntity).toBe(ENTITY_WORLD);
    expect(ground.hit && ground.walkable).toBe(true);
    expect([...ground.normal]).toEqual([0, 0, 1]);
    // Already grounded: no landing.
    expect(trace(ps, flat)).toBe(false);
  });

  it("reaches a floor pm_groundTraceDist down and no farther", () => {
    const near = player(0, 0);
    near.origin[2] = restZ(0) + p.groundTraceDist - 2 / 32;
    expect(trace(near, flat)).toBe(false);
    expect(near.flags & PMF_GROUNDED).toBe(PMF_GROUNDED);
    const far = player(0, 0);
    far.origin[2] = restZ(0) + p.groundTraceDist;
    trace(far, flat);
    expect(far.flags & PMF_GROUNDED).toBe(0);
    expect(far.groundEntity).toBe(ENTITY_NONE);
    expect(ground.hit).toBe(false);
  });

  it("walks a 0.71 slope and slides on a 0.69 one", () => {
    for (const [nz, walkable] of [
      [0.71, true],
      [0.8, true],
      [0.69, false],
    ] as const) {
      const world = worldOf(floorBrush(), slope(nz));
      const ps = dropped(world, 0, 128);
      ps.flags = PMF_GROUNDED;
      trace(ps, world);
      expect(ground.hit, `${nz}`).toBe(true);
      expect(ground.normal[2]).toBeCloseTo(nz, 5);
      expect(ground.walkable, `${nz}`).toBe(walkable);
      expect((ps.flags & PMF_GROUNDED) !== 0, `${nz}`).toBe(walkable);
      expect(ps.groundEntity).toBe(walkable ? ENTITY_WORLD : ENTITY_NONE);
    }
  });

  it("treats a rising player as airborne once v·n exceeds 10 u/s", () => {
    for (const [vz, grounded] of [
      [GROUND_LEAVE_SPEED, true],
      [GROUND_LEAVE_SPEED + 1 / 16, false],
      [270, false],
      [-50, true],
    ] as const) {
      const ps = player(0, 0);
      ps.velocity[2] = vz;
      trace(ps, flat);
      expect((ps.flags & PMF_GROUNDED) !== 0, `vz ${vz}`).toBe(grounded);
      // Leaving the ground, the plane is no contact at all (no steep-slope clip either).
      expect(ground.hit, `vz ${vz}`).toBe(grounded);
    }
  });

  it("keeps a player walking up a slope grounded: rising, but along the plane", () => {
    const world = worldOf(floorBrush(), slope(0.8));
    const ps = dropped(world, 0, 128);
    // 300 u/s up the 3-4-5 slope: v·n = 0 although vz = 180.
    ps.velocity.set([0, 240, 180]);
    trace(ps, world);
    expect(ps.flags & PMF_GROUNDED).toBe(PMF_GROUNDED);
  });

  it("clips a landing's velocity against the ground, and only on the landing (D-023)", () => {
    // Falling fast, 0.1 u above the floor: inside the probe, so this trace lands the player. The
    // fall is clipped away here, or the walk move would lay it onto the floor as speed.
    const ps = player(0, 0);
    ps.flags = 0;
    ps.origin[2] = restZ(0) + 0.1;
    ps.velocity.set([300, 0, -500]);
    expect(trace(ps, flat)).toBe(true);
    expect(ps.velocity[0]).toBe(300);
    expect(ps.velocity[2]).toBeGreaterThanOrEqual(0);
    expect(ps.velocity[2]).toBeLessThan(1);
    // Already grounded: the walk move owns the velocity.
    ps.velocity.set([300, 0, -5]);
    expect(trace(ps, flat)).toBe(false);
    expect([...ps.velocity]).toEqual([300, 0, -5]);
  });

  it("settles a grounded player onto the ground only when asked (D-023)", () => {
    const ps = player(0, 0);
    ps.origin[2] = restZ(0) + 0.2;
    expect(trace(ps, flat)).toBe(false);
    expect(ps.origin[2]).toBe(restZ(0) + 0.2);
    groundTrace(ps, flat, p, HULL_MINS, HULL_STANDING_MAXS, true, null);
    expect(ps.origin[2]).toBeCloseTo(restZ(0), 12);
    // Airborne (nothing within the probe): no settle.
    const high = player(0, 0);
    high.origin[2] = restZ(0) + 1;
    groundTrace(high, flat, p, HULL_MINS, HULL_STANDING_MAXS, true, null);
    expect(high.origin[2]).toBe(restZ(0) + 1);
  });

  it("takes slick and nodamage from the face flag or the brush contents (D-023)", () => {
    const cases = [
      [CONTENTS_SOLID, SURF_SLICK, SURF_SLICK],
      [CONTENTS_SOLID | CONTENTS_SLICK, 0, SURF_SLICK],
      [CONTENTS_SOLID, SURF_NODAMAGE, SURF_NODAMAGE],
      [CONTENTS_SOLID | CONTENTS_NODAMAGE, 0, SURF_NODAMAGE],
      [CONTENTS_SOLID | CONTENTS_SLICK | CONTENTS_NODAMAGE, 0, SURF_SLICK | SURF_NODAMAGE],
      [CONTENTS_SOLID, 0, 0],
    ] as const;
    for (const [contents, surf, expected] of cases) {
      const world = worldOf(
        brush(boxPlanes([-512, -512, -64], [512, 512, 0]), contents, () => surf),
      );
      trace(player(0, 0), world);
      expect(ground.surfaceFlags, `contents ${contents} surf ${surf}`).toBe(expected);
      expect(ground.contents).toBe(contents);
    }
  });

  it("finds a ramp crest slick through the contents bit, though the bevel has no face flag", () => {
    const tr = new TraceResult();
    for (const [contents, surf, slick] of [
      [CONTENTS_SOLID, SURF_SLICK, false],
      [CONTENTS_SOLID | CONTENTS_SLICK, 0, true],
    ] as const) {
      // Standing on the crest edge of a slope with nothing past it: the probe hits the wedge's
      // axial top bevel, not the sloped face.
      const world = worldOf(slope(0.8, contents, surf));
      const top = (world.brushBounds[5] as number) + 0;
      const ps = player(0, 256 + 10, top);
      traceBox(
        world,
        ps.origin,
        vec3(0, 266, ps.origin[2] - 1),
        HULL_MINS,
        HULL_STANDING_MAXS,
        MASK_PLAYERSOLID,
        tr,
      );
      expect(tr.plane).toBeGreaterThanOrEqual(world.brushFaceCount[0] as number);
      expect(tr.surfaceFlags).toBe(0);
      trace(ps, world);
      expect(ps.flags & PMF_GROUNDED).toBe(PMF_GROUNDED);
      expect((ground.surfaceFlags & SURF_SLICK) !== 0).toBe(slick);
    }
  });
});
