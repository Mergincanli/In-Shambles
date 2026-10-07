import { describe, expect, it } from "vitest";
import { degreesToU16 } from "../../../src/math/quant";
import { PMEV_JUMP } from "../../../src/sim/events";
import { WATER_SAMPLE_FEET, WATER_SAMPLE_WAIST } from "../../../src/sim/hull";
import { PMF_CROUCHED, PMF_GROUNDED, PMF_IN_WATER } from "../../../src/sim/playerState";
import { PmoveParams } from "../../../src/sim/pmove/params";
import { pmove } from "../../../src/sim/pmove/pmove";
import { checkWaterLevel } from "../../../src/sim/pmove/water";
import { BUTTON_CROUCH, BUTTON_JUMP } from "../../../src/sim/usercmd";
import { TICK_DT } from "../../../src/time";
import { CONTENTS_WATER } from "../../../src/world/contents";
import { boxPlanes, wedgePlanes } from "../../../src/world/shapes";
import { box, cmd, floorBrush, horizontalSpeed, player, run } from "../../helpers/pmoveWorld";
import { brush, worldOf } from "../../helpers/traceWorld";

// Water level and the swim move (docs/03 §4.13, D-024).

/** The floor with water from z = 0 up to `depth` over it. */
function pool(depth: number) {
  return worldOf(
    floorBrush(),
    brush(boxPlanes([-1024, -1024, 0], [1024, 1024, depth]), CONTENTS_WATER),
  );
}

/** A player at rest with feet `feet` u above the floor, airborne unless on it. */
function swimmer(feet: number) {
  const ps = player(0, 0);
  ps.origin[2] = feet + 24;
  if (feet > 0) ps.flags &= ~PMF_GROUNDED;
  return ps;
}

describe("checkWaterLevel", () => {
  it.each([
    [0, 0],
    [WATER_SAMPLE_FEET, 0],
    [WATER_SAMPLE_FEET + 0.5, 1],
    [12, 1],
    [WATER_SAMPLE_WAIST, 1],
    [WATER_SAMPLE_WAIST + 0.5, 2],
    [36, 2],
    [50, 2],
    [50.5, 3],
    [128, 3],
  ])("standing on the floor in %f u of water: level %i", (depth, level) => {
    // Feet exactly on the floor (z = 0); a sample on the water's top face is outside it.
    const ps = swimmer(0);
    if (depth > 0) checkWaterLevel(ps, pool(depth));
    else checkWaterLevel(ps, worldOf(floorBrush()));
    expect(ps.waterLevel).toBe(level);
    expect(ps.flags & PMF_IN_WATER).toBe(level > 0 ? PMF_IN_WATER : 0);
  });

  it("samples the eye at 36 u above the feet when crouched", () => {
    const world = pool(40);
    const ps = swimmer(0);
    checkWaterLevel(ps, world);
    expect(ps.waterLevel).toBe(2);
    ps.flags |= PMF_CROUCHED;
    checkWaterLevel(ps, world);
    expect(ps.waterLevel).toBe(3);
  });

  it("needs the lower samples for the upper ones: an air pocket under the feet reads dry", () => {
    const world = worldOf(
      floorBrush(),
      brush(boxPlanes([-64, -64, 20], [64, 64, 200]), CONTENTS_WATER),
    );
    const ps = swimmer(0);
    checkWaterLevel(ps, world);
    expect(ps.waterLevel).toBe(0);
  });

  it("is sampled again after the move: entering or leaving the water shows on that tick", () => {
    const p = new PmoveParams();
    // Feet 1 u above a 36 u pool, falling at 300 u/s: dry at the start, wet after the move.
    const falling = swimmer(37);
    falling.velocity[2] = -300;
    pmove(falling, cmd(), pool(36), p, TICK_DT, null, null);
    expect(falling.waterLevel).toBeGreaterThan(0);
    expect(falling.flags & PMF_IN_WATER).toBe(PMF_IN_WATER);
    // Feet 1 u under the surface, rising at 300 u/s: wet at the start, dry after the move.
    const rising = swimmer(35 - WATER_SAMPLE_FEET);
    rising.velocity[2] = 300;
    pmove(rising, cmd(), pool(36), p, TICK_DT, null, null);
    expect(rising.waterLevel).toBe(0);
    expect(rising.flags & PMF_IN_WATER).toBe(0);
  });

  it("is updated by pmove and clears PMF_IN_WATER on leaving the water", () => {
    const ps = swimmer(0);
    pmove(ps, cmd(), pool(36), new PmoveParams(), TICK_DT, null, null);
    expect(ps.waterLevel).toBe(2);
    pmove(ps, cmd(), worldOf(floorBrush()), new PmoveParams(), TICK_DT, null, null);
    expect(ps.waterLevel).toBe(0);
    expect(ps.flags & PMF_IN_WATER).toBe(0);
  });
});

describe("waterMove", () => {
  const deep = pool(1024);

  it("sinks at exactly pm_waterSinkSpeed with no input, without gravity", () => {
    const ps = swimmer(512);
    const vz: number[] = [];
    run(ps, deep, () => cmd(), 120, { each: () => vz.push(ps.velocity[2] as number) });
    expect(vz[119]).toBe(-60);
    // A smooth approach: never faster than the sink speed, never rising.
    for (const v of vz) {
      expect(v).toBeLessThanOrEqual(0);
      expect(v).toBeGreaterThanOrEqual(-60);
    }
    expect(ps.waterLevel).toBe(3);
  });

  it("swims up with jump and down with crouch at pm_runSpeed × pm_swimScale", () => {
    const p = new PmoveParams();
    const up = swimmer(512);
    run(up, deep, () => cmd({ buttons: BUTTON_JUMP }), 120, { params: p });
    expect(up.velocity[2]).toBeCloseTo(160, 6);
    // Crouch is "down" in water: no pm_duckScale on the swim speed.
    const down = swimmer(512);
    run(down, deep, () => cmd({ buttons: BUTTON_CROUCH }), 120, { params: p });
    expect(down.velocity[2]).toBeCloseTo(-160, 6);
    expect(down.flags & PMF_CROUCHED).toBe(PMF_CROUCHED);
    // Both at once cancel: no vertical input, but not "no input" either while moving forward.
    const both = swimmer(512);
    run(both, deep, () => cmd({ forward: 127, buttons: BUTTON_JUMP | BUTTON_CROUCH }), 120);
    expect(both.velocity[2]).toBe(0);
    expect(horizontalSpeed(both.velocity)).toBeCloseTo(160, 6);
    // Without forward they cancel to no input at all: the slow sink.
    const still = swimmer(512);
    run(still, deep, () => cmd({ buttons: BUTTON_JUMP | BUTTON_CROUCH }), 120);
    expect(still.velocity[2]).toBe(-60);
  });

  it("swims along the full 3D view direction, without the walk's ground friction", () => {
    const ps = swimmer(512);
    // Pitch −30°: looking up, so forward climbs at 30°.
    const pitch = degreesToU16(-30);
    run(ps, deep, () => cmd({ forward: 127, pitch }), 120);
    const v = ps.velocity;
    const h = horizontalSpeed(v);
    const speed = Math.sqrt(h * h + (v[2] as number) * (v[2] as number));
    // Each axis is quantized to 1/16 u/s, so the 3D speed lands within that of the cap.
    expect(Math.abs(speed - 160)).toBeLessThan(1 / 16);
    expect((v[2] as number) / speed).toBeCloseTo(0.5, 3);
  });

  it("caps the wish at the swim speed when a pitched forward and the vertical axis add up", () => {
    // World z is not orthogonal to a pitched forward: uncapped, forward + jump looking straight up
    // would swim at √2 × 160.
    for (const [deg, buttons] of [
      [-89, BUTTON_JUMP],
      [-45, BUTTON_JUMP],
      [89, BUTTON_CROUCH],
      [45, BUTTON_CROUCH],
    ] as const) {
      const ps = swimmer(512);
      const pitch = degreesToU16(deg);
      run(ps, deep, () => cmd({ forward: 127, right: deg === 45 ? 127 : 0, buttons, pitch }), 120);
      const v = ps.velocity;
      const h = horizontalSpeed(v);
      const speed = Math.sqrt(h * h + (v[2] as number) * (v[2] as number));
      expect(Math.abs(speed - 160), String(deg)).toBeLessThan(1 / 16);
    }
  });

  it("takes the cmd's up axis as the base vertical axis, with jump and crouch added to it", () => {
    const up = swimmer(512);
    run(up, deep, () => cmd({ up: 127 }), 120);
    expect(up.velocity[2]).toBeCloseTo(160, 6);
    // Half deflection: half the swim speed.
    const half = swimmer(512);
    run(half, deep, () => cmd({ up: 64 }), 120);
    expect(half.velocity[2]).toBeCloseTo((160 * 64) / 127, 1);
    // up + crouch cancel to no vertical input: the sink.
    const cancel = swimmer(512);
    run(cancel, deep, () => cmd({ up: 127, buttons: BUTTON_CROUCH }), 120);
    expect(cancel.velocity[2]).toBe(-60);
  });

  it("applies the water friction term on the 3D speed: a vertical dive slows", () => {
    const p = new PmoveParams();
    const ps = swimmer(512);
    ps.velocity[2] = -400;
    pmove(ps, cmd(), deep, p, TICK_DT, null, null);
    // drop = s · pm_waterFriction · level 3 · dt; the sink wish (60 u/s) adds nothing at 380.
    expect(ps.velocity[2]).toBe(-400 + 400 * p.waterFriction * 3 * TICK_DT);
    expect(ps.velocity[2]).toBe(-380);
  });

  it("adds the water term to the walk's ground friction while wading (level 1)", () => {
    const p = new PmoveParams();
    const wet = swimmer(0);
    const dry = swimmer(0);
    wet.velocity[0] = 320;
    dry.velocity[0] = 320;
    pmove(wet, cmd(), pool(12), p, TICK_DT, null, null);
    pmove(dry, cmd(), worldOf(floorBrush()), p, TICK_DT, null, null);
    expect(wet.waterLevel).toBe(1);
    // Ground: 320 · pm_friction · dt = 32; water: 320 · pm_waterFriction · 1 · dt = 5.33.
    expect(dry.velocity[0]).toBe(288);
    expect(wet.velocity[0]).toBeCloseTo(320 - 32 - 320 * p.waterFriction * TICK_DT, 1);
  });

  it("does not jump off the pool floor at level 2 or more: jump swims up instead", () => {
    const ps = swimmer(0);
    const { events } = run(ps, pool(64), () => cmd({ buttons: BUTTON_JUMP }), 2);
    expect(events.filter(([, type]) => type === PMEV_JUMP)).toHaveLength(0);
    expect(ps.velocity[2]).toBeGreaterThan(0);
    expect(ps.velocity[2]).toBeLessThan(270);
  });

  it("step-slides against the floor plane when grounded", () => {
    // Under 512 u of water, a 0.8 slope rising toward +y, and a swimmer resting on it, sinking at
    // 60 u/s. The floor is a slide plane while grounded (docs/03 §4.13), so the sweep that starts
    // in its ε skin and hits it again is nudged off the same plane (§4.8 step 3): the swimmer
    // holds its place that tick. Clipped against the slope as a new plane, it would slide down.
    const nz = 0.8;
    const rise = (256 * Math.sqrt(1 - nz * nz)) / nz;
    const world = worldOf(
      floorBrush(),
      brush(wedgePlanes([-128, 0, 0], [128, 256, rise], "+y")),
      brush(boxPlanes([-1024, -1024, 0], [1024, 1024, 512]), CONTENTS_WATER),
    );
    const ps = player(0, 128);
    // Just above the slope under the hull's uphill (+y) edge, the first part to touch it.
    ps.origin[2] = 24 + ((128 + 15) * rise) / 256 + 0.1;
    ps.flags = 0;
    run(ps, world, () => cmd(), 3);
    expect(ps.flags & PMF_GROUNDED).toBe(PMF_GROUNDED);
    expect(ps.waterLevel).toBe(3);
    const start = [...ps.origin];
    ps.velocity.set([0, 0, -60]);
    pmove(ps, cmd(), world, new PmoveParams(), TICK_DT, null, null);
    expect([...ps.origin]).toEqual(start);
    expect(ps.velocity[2]).toBeLessThan(-50);
    expect(ps.flags & PMF_GROUNDED).toBe(PMF_GROUNDED);
  });

  it("climbs out onto an edge pm_stepSize above the feet at the top of the bob, not a flush rim", () => {
    // Deep water up to z = 0 and a solid edge east of x = 64 whose top is `h`. Forward + jump,
    // level: the step is refused while rising with no ground below (§4.9 step 3), so a bobbing
    // swimmer steps only at the top of the bob, feet about 24.5 u under the surface; one coming
    // up from depth at full speed overshoots and reaches a little higher (docs/03 §4.13, D-024).
    function exitTick(startZ: number, h: number): number {
      const world = worldOf(
        box([-1024, -1024, -1024], [1024, 1024, -512]),
        brush(boxPlanes([-1024, -1024, -512], [64, 1024, 0]), CONTENTS_WATER),
        box([64, -1024, -512], [1024, 1024, h]),
      );
      const ps = player(0, 0);
      ps.origin[2] = startZ;
      ps.flags = 0;
      let out = -1;
      run(ps, world, () => cmd({ forward: 127, buttons: BUTTON_JUMP }), 600, {
        each: (t) => {
          if (out < 0 && (ps.origin[0] as number) > 64 && (ps.flags & PMF_GROUNDED) !== 0) out = t;
        },
      });
      return out;
    }
    // Bobbing at the surface (feet 44 u down at the start).
    expect(exitTick(-20, -8)).toBeGreaterThan(0);
    expect(exitTick(-20, -6)).toBeGreaterThan(0);
    expect(exitTick(-20, -5)).toBe(-1);
    // A rim flush with the surface needs the water-jump (M4).
    expect(exitTick(-20, 0)).toBe(-1);
    // Up from 174 u down at full speed: about 7 u above the surface.
    expect(exitTick(-150, 0)).toBeGreaterThan(0);
    expect(exitTick(-150, 7)).toBeGreaterThan(0);
    expect(exitTick(-150, 8)).toBe(-1);
  });

  it("walks (with gravity and a normal jump) at level 1", () => {
    const ps = swimmer(0);
    const { events } = run(ps, pool(12), () => cmd({ buttons: BUTTON_JUMP }), 1);
    expect(ps.waterLevel).toBe(1);
    expect(events.filter(([, type]) => type === PMEV_JUMP)).toHaveLength(1);
  });
});
