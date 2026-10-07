import { PlayerState } from "@game/shared";
import { describe, expect, it } from "vitest";
import { HoldInput } from "../../src/scenarios/bots";
import { anchorYawU16, courseAnchor, loadCourse } from "../../src/scenarios/course";
import {
  horizontalSpeed,
  logMeasured,
  maxHorizontalSpeed,
  settledIndex,
  snapFallbacks,
} from "../../src/scenarios/metrics";
import { placeAtAnchor, ScenarioRunner } from "../../src/scenarios/runner";

// docs/03 §8 MV-01, M2 design §5: holding forward on flat ground converges to the run cap.

const RUN_CAP = 320; // pm_runSpeed, FACT-Q3 (docs/03 §2.1)
const TOLERANCE = 0.5;
const BY_TICK = 36; // 0.6 s
const TICKS = 120; // 2 s

describe("MV-01: run cap on the movement_lab runway", () => {
  const course = loadCourse("movement_lab");
  const start = courseAnchor(course, "runway_start");
  const ps = placeAtAnchor(new PlayerState(), start);
  const record = new ScenarioRunner(course.world).run(
    ps,
    new HoldInput(anchorYawU16(start)),
    TICKS,
  );
  const settled = settledIndex(record, RUN_CAP, TOLERANCE);

  it("is within 320 ± 0.5 u/s by 0.6 s and stays there for the rest of 2 s", () => {
    logMeasured(
      "MV-01",
      "run cap",
      `${horizontalSpeed(record, BY_TICK).toFixed(3)} u/s at 0.6 s, settled from ${(settled * record.dt).toFixed(3)} s, max ${maxHorizontalSpeed(record).toFixed(3)} u/s`,
      `${RUN_CAP} ± ${TOLERANCE} u/s by 0.6 s`,
    );
    expect(settled).toBeGreaterThan(0);
    expect(settled).toBeLessThanOrEqual(BY_TICK);
    expect(record.count).toBe(TICKS + 1);
  });

  it("runs straight down the runway, grounded, without a snap fallback", () => {
    for (let i = 0; i < record.count; i++) {
      expect(record.grounded(i), `tick ${i}`).toBe(true);
      expect(record.y(i)).toBe(start.origin[1]);
      expect(record.z(i)).toBe(start.origin[2]);
    }
    expect(record.x(TICKS)).toBeGreaterThan(start.origin[0] + 500);
    expect(snapFallbacks(record)).toBe(0);
  });
});
