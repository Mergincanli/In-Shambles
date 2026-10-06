import { PlayerState } from "@game/shared";
import { describe, expect, it } from "vitest";
import { HopForward } from "../../src/scenarios/bots";
import { anchorYawU16, courseAnchor, loadCourse } from "../../src/scenarios/course";
import {
  horizontalSpeed,
  jumps,
  landingSpeeds,
  lands,
  logMeasured,
  maxHorizontalSpeed,
  snapFallbacks,
} from "../../src/scenarios/metrics";
import { placeAtAnchor, ScenarioRunner } from "../../src/scenarios/runner";

// docs/03 §8 MV-07, M2 design §5: forward-only hopping gains nothing. After a 1 s run-up to the
// run cap, the bot holds forward at a fixed yaw and re-presses jump on every landing; the jump
// comes before friction (docs/03 §3), so hops keep their speed but never add to it.

const HOPS = 20;
const RUN_UP_TICKS = 60;
const CAP = 320 * 1.02; // pm_runSpeed (FACT-Q3) + 2%
const TICKS = RUN_UP_TICKS + HOPS * 45; // a hop is 41–42 ticks

describe("MV-07: no straight-hop gain on the movement_lab open floor", () => {
  it("20 forward-only hops from open_sw never exceed the run cap + 2%", () => {
    const course = loadCourse("movement_lab");
    const start = courseAnchor(course, "open_sw");
    const ps = placeAtAnchor(new PlayerState(), start);
    const bot = new HopForward(anchorYawU16(start), { runUpTicks: RUN_UP_TICKS, hops: HOPS });
    const record = new ScenarioRunner(course.world).run(ps, bot, TICKS);
    const max = maxHorizontalSpeed(record);
    const curve = landingSpeeds(record);
    logMeasured(
      "MV-07",
      "straight hops",
      `${jumps(record).length} hops, max ${max.toFixed(3)} u/s, landing speeds ${curve.map((s) => s.toFixed(1)).join(" ")}`,
      `≤ ${CAP.toFixed(1)} u/s`,
    );
    expect(jumps(record)).toHaveLength(HOPS);
    expect(lands(record)).toHaveLength(HOPS);
    expect(max).toBeLessThanOrEqual(CAP);
    // It really hopped at speed: every landing kept close to the cap.
    for (const s of curve) expect(s).toBeGreaterThan(300);
    // And every take-off kept the cap: the jump comes before friction, so the landing tick's
    // re-press loses nothing (friction first would take about 32 u/s, regained in the air).
    for (const j of jumps(record))
      expect(horizontalSpeed(record, j.tick)).toBeGreaterThanOrEqual(319.5);
    expect(snapFallbacks(record)).toBe(0);
  });
});
