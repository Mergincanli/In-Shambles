import { PlayerState, TRACE_EPSILON } from "@game/shared";
import { describe, expect, it } from "vitest";
import { HoldInput } from "../../src/scenarios/bots";
import {
  anchorYawU16,
  type CourseAnchor,
  courseAnchor,
  loadCourse,
} from "../../src/scenarios/course";
import {
  airborneTicks,
  lands,
  logMeasured,
  snapFallbacks,
  steps,
} from "../../src/scenarios/metrics";
import { placeAtAnchor, ScenarioRunner } from "../../src/scenarios/runner";

// docs/03 §8 MV-05, §4.9, M2 design §5: auto-step on movement_lab. pm_stepSize is 18 (FACT-Q3,
// docs/03 §2.1): 16 and 18 u climb with one STEP event, 19 u blocks, and the 8 × 16 u stairs give
// eight. Each run holds forward from the base anchor for 1.5 s and lets go once the origin
// reaches the top anchor, so the player stops on the step instead of running off its far side.
// Two starts: on the anchor (feet exactly on the floor) and landed (feet one ε above it, D-017,
// as after any fall and as the match spawns a player, D-027).

const TICKS = 90; // 1.5 s
const STEP_TOLERANCE = 1 / 16;
const course = loadCourse("movement_lab");
const runner = new ScenarioRunner(course.world);

const STARTS = [
  ["anchor", 0],
  ["landed", TRACE_EPSILON],
] as const;

function climb(base: CourseAnchor, top: CourseAnchor, lift: number) {
  const ps = placeAtAnchor(new PlayerState(), base);
  ps.origin[2] += lift;
  const bot = new HoldInput(anchorYawU16(base), { release: { axis: 1, at: top.origin[1] } });
  const record = runner.run(ps, bot, TICKS);
  return { record, steps: steps(record), released: bot.released };
}

describe("MV-05: step-up on movement_lab", () => {
  describe.each(STARTS)("%s", (start, lift) => {
    it.each([16, 18])("climbs the %i u step with one STEP event of that height", (h) => {
      const base = courseAnchor(course, `step_${h}_base`);
      const top = courseAnchor(course, `step_${h}_top`);
      const { record, steps: events, released } = climb(base, top, lift);
      const end = record.count - 1;
      logMeasured(
        "MV-05",
        `${h} u step (${start})`,
        `end z ${record.z(end)}, STEP ${events.map((e) => e.value).join(", ")}`,
        `z ${top.origin[2]} (+ε), one STEP of ${h} ± ${STEP_TOLERANCE}`,
      );
      expect(released).toBe(true);
      expect(record.z(end)).toBeGreaterThanOrEqual(top.origin[2]);
      expect(record.z(end)).toBeLessThanOrEqual(top.origin[2] + TRACE_EPSILON);
      expect(events).toHaveLength(1);
      expect(Math.abs((events[0]?.value as number) - h)).toBeLessThanOrEqual(STEP_TOLERANCE);
      expect(airborneTicks(record)).toBe(0);
      expect(lands(record)).toEqual([]);
      expect(snapFallbacks(record)).toBe(0);
    });

    it("is blocked by the 19 u step: stays on the floor, no STEP event", () => {
      const base = courseAnchor(course, "step_19_base");
      const top = courseAnchor(course, "step_19_top");
      const { record, steps: events } = climb(base, top, lift);
      let highest = record.z(0);
      for (let i = 0; i < record.count; i++) highest = Math.max(highest, record.z(i));
      const end = record.count - 1;
      logMeasured(
        "MV-05",
        `19 u step (${start})`,
        `highest z ${highest}, end y ${record.y(end)}, ${events.length} STEP`,
        `z ≤ ${base.origin[2]} + ε, blocked, no STEP`,
      );
      expect(highest).toBeLessThanOrEqual(base.origin[2] + TRACE_EPSILON);
      expect(events).toEqual([]);
      // Pressed against the riser: the hull's face ε short of it, short of the top anchor.
      expect(record.y(end)).toBeLessThan(top.origin[1] - 128);
      expect(record.y(end)).toBe(record.y(end - 30));
      expect(airborneTicks(record)).toBe(0);
    });

    it("climbs the stairs with eight STEP events of 16 u and ends at stairs_top", () => {
      const base = courseAnchor(course, "stairs_base");
      const top = courseAnchor(course, "stairs_top");
      const { record, steps: events, released } = climb(base, top, lift);
      const end = record.count - 1;
      logMeasured(
        "MV-05",
        `stairs (${start})`,
        `${events.length} STEP (${events.map((e) => e.value).join(", ")}), end z ${record.z(end)}`,
        `8 STEP of 16 ± ${STEP_TOLERANCE}, z ${top.origin[2]} (+ε)`,
      );
      expect(released).toBe(true);
      expect(events).toHaveLength(8);
      for (const e of events) expect(Math.abs(e.value - 16)).toBeLessThanOrEqual(STEP_TOLERANCE);
      expect(record.z(end)).toBeGreaterThanOrEqual(top.origin[2]);
      expect(record.z(end)).toBeLessThanOrEqual(top.origin[2] + TRACE_EPSILON);
      expect(airborneTicks(record)).toBe(0);
      expect(snapFallbacks(record)).toBe(0);
    });
  });
});
