import { PlayerState } from "@game/shared";
import { describe, expect, it } from "vitest";
import { StrafeHop } from "../../src/scenarios/bots";
import { anchorYawU16, courseAnchor, loadCourse } from "../../src/scenarios/course";
import {
  horizontalSpeed,
  jumps,
  landingSpeeds,
  lands,
  logMeasured,
  snapFallbacks,
} from "../../src/scenarios/metrics";
import { placeAtAnchor, ScenarioRunner } from "../../src/scenarios/runner";

// docs/03 §8 MV-08, M2 design §5: the scripted ideal strafe-jumper gains speed on every hop. After
// a 1 s run-up to the run cap at open_sw, it hops 10 times holding forward plus a strafe key, the
// side alternating each hop, and picks the best u16 yaw every airborne tick by exact search
// (bots.ts StrafeHop, D-016). The landing-speed curve is logged.

const HOPS = 10;
const RUN_UP_TICKS = 60;
const RUN_CAP = 320; // pm_runSpeed, FACT-Q3 (docs/03 §2.1)
const TICKS = RUN_UP_TICKS + HOPS * 45; // a hop is 41–42 ticks

describe("MV-08: strafe gain on the movement_lab open floor", () => {
  it("the ideal strafe bot from open_sw lands faster on each of 10 hops", () => {
    const course = loadCourse("movement_lab");
    const start = courseAnchor(course, "open_sw");
    const ps = placeAtAnchor(new PlayerState(), start);
    const runner = new ScenarioRunner(course.world);
    const bot = new StrafeHop(anchorYawU16(start), runner.params, runner.dt, {
      runUpTicks: RUN_UP_TICKS,
      hops: HOPS,
    });
    const record = runner.run(ps, bot, TICKS);
    const curve = landingSpeeds(record);
    const takeoff = horizontalSpeed(record, jumps(record)[0]?.tick ?? 0);
    logMeasured(
      "MV-08",
      "strafe gain",
      `take-off ${takeoff.toFixed(1)} u/s, landing speeds ${curve.map((s) => s.toFixed(1)).join(" ")} u/s`,
      "every landing faster than the one before",
    );
    expect(jumps(record)).toHaveLength(HOPS);
    expect(lands(record)).toHaveLength(HOPS);
    expect(takeoff).toBeGreaterThanOrEqual(RUN_CAP - 0.5);
    expect(curve[0] as number).toBeGreaterThan(takeoff);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i] as number, `hop ${i + 1}`).toBeGreaterThan(curve[i - 1] as number);
    }
    expect(snapFallbacks(record)).toBe(0);
  });
});
