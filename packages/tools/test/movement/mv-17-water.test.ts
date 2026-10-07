import {
  BUTTON_CROUCH,
  BUTTON_JUMP,
  degreesToU16,
  HULL_MINS,
  PlayerState,
  PMF_IN_WATER,
  type Vec3,
  WATER_SAMPLE_WAIST,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { HoldInput, idle } from "../../src/scenarios/bots";
import { courseAnchor, type LoadedCourse, loadCourse } from "../../src/scenarios/course";
import { horizontalSpeed, logMeasured, snapFallbacks } from "../../src/scenarios/metrics";
import {
  type CmdSource,
  placeAtAnchor,
  placePlayer,
  type ScenarioRecord,
  ScenarioRunner,
} from "../../src/scenarios/runner";

// docs/03 §8 MV-17 (basic: no breath or drowning until M4), §4.13, D-024, M2 design §5: water
// levels 1/2/3 standing in the wading, waist-deep and deep pool sections of movement_lab; in
// deep water no input sinks at pm_waterSinkSpeed, jump swims up to the surface, crouch dives and
// forward swims at pm_runSpeed × pm_swimScale. Leaving the pool west over the waist and wading
// sections is logged, not asserted (water-jump is M4).

const SINK = 60; // pm_waterSinkSpeed, ESTIMATE (docs/03 §2.3)
const SWIM = 320 * 0.5; // pm_runSpeed × pm_swimScale, both FACT-Q3 (docs/03 §2.1)
const TOLERANCE = 1;
/** The pool's water surface: the zone floor's top (docs/07 §3). */
const SURFACE = 0;
/** West edge of the pool (wading section), from movement_lab.ts. */
const POOL_X0 = 1792;

function vz(r: ScenarioRecord, i: number): number {
  return r.velocity[3 * i + 2] as number;
}

/** A swimmer at rest in the deep section, `feet` u above its floor (airborne). */
function inDeepWater(course: LoadedCourse, feet: number, yaw = 0): PlayerState {
  const deep = courseAnchor(course, "water_deep");
  const o = deep.origin;
  return placePlayer(new PlayerState(), [o[0], o[1], o[2] + feet], yaw, false);
}

function run(course: LoadedCourse, ps: PlayerState, bot: CmdSource, ticks: number) {
  return new ScenarioRunner(course.world).run(ps, bot, ticks);
}

/** Height of the waist sample above the surface (≥ 0: the player is at the surface). */
function waistAboveSurface(origin: Vec3 | readonly number[]): number {
  return (origin[2] as number) + (HULL_MINS[2] as number) + WATER_SAMPLE_WAIST - SURFACE;
}

describe("MV-17: water on the movement_lab pool (basic)", () => {
  const course = loadCourse("movement_lab");

  it.each([
    ["water_wade", 1],
    ["water_waist", 2],
    ["water_deep", 3],
  ] as const)("standing in %s reads water level %i", (name, level) => {
    const ps = placeAtAnchor(new PlayerState(), courseAnchor(course, name));
    run(course, ps, idle(), 1);
    logMeasured("MV-17", `${name} level`, String(ps.waterLevel), String(level));
    expect(ps.waterLevel).toBe(level);
    expect(ps.flags & PMF_IN_WATER).toBe(PMF_IN_WATER);
  });

  it("with no input, deep water sinks at pm_waterSinkSpeed (−60 ± 1 u/s)", () => {
    const ps = inDeepWater(course, 64);
    const record = run(course, ps, idle(), 60);
    const last = vz(record, record.ticksRun);
    logMeasured("MV-17", "sink", `${last.toFixed(3)} u/s after 1 s`, `${-SINK} ± ${TOLERANCE} u/s`);
    expect(Math.abs(last + SINK)).toBeLessThanOrEqual(TOLERANCE);
    for (let i = 1; i < record.count; i++) {
      expect(vz(record, i)).toBeLessThanOrEqual(0);
      expect(vz(record, i)).toBeGreaterThanOrEqual(-SINK - TOLERANCE);
    }
    expect(ps.waterLevel).toBe(3);
  });

  it("jump swims up from the deep floor to the surface, and no further out than a bob", () => {
    const ps = placeAtAnchor(new PlayerState(), courseAnchor(course, "water_deep"));
    const record = run(course, ps, new HoldInput(0, { forward: 0, buttons: BUTTON_JUMP }), 180);
    let surfaced = -1;
    let maxFeet = Number.NEGATIVE_INFINITY;
    let maxRise = 0;
    for (let i = 1; i < record.count; i++) {
      const o = [record.x(i), record.y(i), record.z(i)];
      if (surfaced < 0 && waistAboveSurface(o) >= 0) surfaced = i;
      maxFeet = Math.max(maxFeet, record.z(i) + (HULL_MINS[2] as number));
      maxRise = Math.max(maxRise, vz(record, i));
    }
    logMeasured(
      "MV-17",
      "swim up",
      `surfaced after ${(surfaced * record.dt).toFixed(3)} s, top speed ${maxRise.toFixed(3)} u/s, feet at most ${maxFeet.toFixed(2)} u`,
      `surface within 1.5 s at ${SWIM} u/s`,
    );
    expect(surfaced).toBeGreaterThan(0);
    expect(surfaced * record.dt).toBeLessThanOrEqual(1.5);
    expect(Math.abs(maxRise - SWIM)).toBeLessThanOrEqual(TOLERANCE);
    // It stays in the pool: the feet never clear the surface.
    expect(maxFeet).toBeLessThan(SURFACE);
    expect(snapFallbacks(record)).toBe(0);
  });

  it("crouch dives faster than 100 u/s", () => {
    const ps = inDeepWater(course, 64);
    const record = run(course, ps, new HoldInput(0, { forward: 0, buttons: BUTTON_CROUCH }), 30);
    let min = 0;
    for (let i = 1; i < record.count; i++) min = Math.min(min, vz(record, i));
    logMeasured("MV-17", "dive", `${min.toFixed(3)} u/s`, "< −100 u/s");
    expect(min).toBeLessThan(-100);
  });

  it("forward swims at pm_runSpeed × pm_swimScale (160 ± 1 u/s) and holds its depth", () => {
    const ps = inDeepWater(course, 64, degreesToU16(90));
    const z0 = ps.origin[2];
    const record = run(course, ps, new HoldInput(degreesToU16(90)), 75);
    const speed = horizontalSpeed(record, record.ticksRun);
    logMeasured(
      "MV-17",
      "swim forward",
      `${speed.toFixed(3)} u/s after 1.25 s`,
      `${SWIM} ± ${TOLERANCE} u/s`,
    );
    expect(Math.abs(speed - SWIM)).toBeLessThanOrEqual(TOLERANCE);
    expect(ps.origin[2]).toBe(z0);
    expect(ps.waterLevel).toBe(3);
  });

  it("logs leaving the pool west over the waist and wading sections (report only)", () => {
    const ps = placeAtAnchor(new PlayerState(), courseAnchor(course, "water_deep"));
    const west = degreesToU16(180);
    const record = run(course, ps, new HoldInput(west, { buttons: BUTTON_JUMP }), 600);
    let out = -1;
    for (let i = 1; i < record.count && out < 0; i++) {
      if (record.x(i) + 15 < POOL_X0 && record.grounded(i)) out = i;
    }
    logMeasured(
      "MV-17",
      "exit west (report only)",
      out < 0
        ? `not out after ${(record.ticksRun * record.dt).toFixed(1)} s, ended at x ${record.x(record.ticksRun).toFixed(1)} z ${record.z(record.ticksRun).toFixed(1)}`
        : `on dry floor after ${(out * record.dt).toFixed(3)} s`,
      "out via the waist and wading sections",
    );
    expect(snapFallbacks(record)).toBe(0);
  });
});
