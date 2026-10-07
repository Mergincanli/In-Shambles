import { PlayerState, PmoveParams, TICK_DT } from "@game/shared";
import { describe, expect, it } from "vitest";
import { HopForward } from "../../src/scenarios/bots";
import { anchorYawU16, courseAnchor, loadCourse } from "../../src/scenarios/course";
import { airtime, apex, jumps, lands, logMeasured } from "../../src/scenarios/metrics";
import { placeAtAnchor, ScenarioRunner } from "../../src/scenarios/runner";

// docs/03 §8 MV-04, §4.6, M2 design §5: a standing jump on flat ground. The half-step gravity
// keeps the integration exact at any tick rate (D-023: dt is a parameter); what separates 60 and
// 120 Hz is the end-of-tick velocity rounding to 1/16 u/s, which biases gravity (docs/03 §6).

const APEX = (270 * 270) / (2 * 800); // 45.5625 u from pm_jumpVelocity and pm_gravity (FACT-Q3)
const APEX_TOLERANCE = 0.5;
const AIRTIME = (2 * 270) / 800; // 0.675 s

function standingJump(dt: number) {
  const course = loadCourse("movement_lab");
  const start = courseAnchor(course, "runway_start");
  const ps = placeAtAnchor(new PlayerState(), start);
  const bot = new HopForward(anchorYawU16(start), { runUpTicks: 0, hops: 1, forward: 0 });
  const record = new ScenarioRunner(course.world, new PmoveParams(), dt).run(
    ps,
    bot,
    Math.round(1.5 / dt),
  );
  return { start, record, apex: apex(record), jumps: jumps(record), lands: lands(record) };
}

describe("MV-04: jump apex at 60 and 120 Hz", () => {
  const runs = [TICK_DT, 1 / 120].map((dt) => ({ dt, ...standingJump(dt) }));

  it.each(runs.map((r) => [1 / r.dt, r] as const))(
    "%d Hz: apex 45.56 ± 0.5 u, airtime 0.675 s ± 1 tick, one jump and one landing",
    (_, run) => {
      expect(run.jumps).toHaveLength(1);
      expect(run.lands).toHaveLength(1);
      const jump = run.jumps[0] as (typeof run.jumps)[number];
      const land = run.lands[0] as (typeof run.lands)[number];
      const t = airtime(run.record, jump, land);
      logMeasured(
        "MV-04",
        `jump at ${1 / run.dt} Hz`,
        `apex ${run.apex.height.toFixed(4)} u, airtime ${t.toFixed(4)} s, landing at ${land.value} u/s`,
        `apex ${APEX} ± ${APEX_TOLERANCE} u, airtime ${AIRTIME} s ± ${run.dt.toFixed(4)} s`,
      );
      expect(Math.abs(run.apex.height - APEX)).toBeLessThanOrEqual(APEX_TOLERANCE);
      expect(Math.abs(t - AIRTIME)).toBeLessThanOrEqual(run.dt + 1e-9);
      // A standing jump: straight up and back onto the floor, one ε above it (D-017).
      const end = run.record.count - 1;
      expect(run.record.grounded(end)).toBe(true);
      expect(run.record.x(end)).toBe(run.start.origin[0]);
      expect(run.record.z(end) - run.start.origin[2]).toBeLessThanOrEqual(1 / 32);
    },
  );

  // docs/03 §6: airborne, vz loses 800·dt rounded to 1/16 every tick (798.75 u/s² at 60 Hz,
  // 802.5 at 120 Hz), the documented bias M4 calibrates fall damage against.
  it.each(runs.map((r) => [1 / r.dt, r] as const))(
    "%d Hz: airborne vz drops by 800·dt rounded to 1/16 u/s every tick",
    (_, run) => {
      const step = Math.round(800 * run.dt * 16) / 16;
      const r = run.record;
      let airborne = 0;
      for (let i = 1; i + 1 < r.count; i++) {
        if (r.grounded(i) || r.grounded(i + 1)) continue;
        expect((r.velocity[3 * i + 2] as number) - (r.velocity[3 * (i + 1) + 2] as number)).toBe(
          step,
        );
        airborne++;
      }
      expect(airborne).toBeGreaterThan(30);
    },
  );

  it("60 and 120 Hz apexes differ by at most 0.5 u", () => {
    const [a, b] = runs.map((r) => r.apex.height) as [number, number];
    logMeasured("MV-04", "60 vs 120 Hz apex", `${Math.abs(a - b).toFixed(4)} u`, "≤ 0.5 u");
    expect(Math.abs(a - b)).toBeLessThanOrEqual(0.5);
  });
});
