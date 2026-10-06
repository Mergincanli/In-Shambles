import { BUTTON_WALK, PlayerState } from "@game/shared";
import { describe, expect, it } from "vitest";
import { HoldInput } from "../../src/scenarios/bots";
import { anchorYawU16, courseAnchor, loadCourse } from "../../src/scenarios/course";
import {
  horizontalSpeed,
  logMeasured,
  maxHorizontalSpeed,
  settledIndex,
} from "../../src/scenarios/metrics";
import { placeAtAnchor, ScenarioRunner } from "../../src/scenarios/runner";

// docs/03 §8 MV-03, M2 design §5: the walk cap. The crouch half (80 ± 1) joins with crouch
// movement in M2 increment 5.

const WALK_CAP = 320 * 0.5; // pm_runSpeed × pm_walkScale, both FACT-Q3 (docs/03 §2.1)
const TOLERANCE = 1;
const BY_TICK = 36; // 0.6 s, as MV-01
const TICKS = 120;

describe("MV-03: walk cap on the movement_lab runway", () => {
  it("holds 160 ± 1 u/s with walk held, by 0.6 s and for the rest of 2 s", () => {
    const course = loadCourse("movement_lab");
    const start = courseAnchor(course, "runway_start");
    const ps = placeAtAnchor(new PlayerState(), start);
    const bot = new HoldInput(anchorYawU16(start), { buttons: BUTTON_WALK });
    const record = new ScenarioRunner(course.world).run(ps, bot, TICKS);
    const settled = settledIndex(record, WALK_CAP, TOLERANCE);
    logMeasured(
      "MV-03",
      "walk cap",
      `${horizontalSpeed(record, BY_TICK).toFixed(3)} u/s at 0.6 s, settled from ${(settled * record.dt).toFixed(3)} s, max ${maxHorizontalSpeed(record).toFixed(3)} u/s`,
      `${WALK_CAP} ± ${TOLERANCE} u/s`,
    );
    expect(settled).toBeGreaterThan(0);
    expect(settled).toBeLessThanOrEqual(BY_TICK);
    expect(maxHorizontalSpeed(record)).toBeLessThanOrEqual(WALK_CAP + TOLERANCE);
  });
});
