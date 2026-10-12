import {
  degreesToU16,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  PlayerState,
  SNAP_PREVIOUS,
  snapOrigin,
  TRACE_EPSILON,
  TraceResult,
  traceBox,
  vec3,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { idle } from "../../src/scenarios/bots";
import { courseAnchor } from "../../src/scenarios/course";
import { logMeasured, snapFallbacks } from "../../src/scenarios/metrics";
import { placePlayer } from "../../src/scenarios/runner";
import { course, runner, SAMPLED_PHASES, slopeApproaches, toeY } from "./slopes";

// docs/03 §8 MV-06, §4.10, M2 design §5: the movement_lab slope set either side of
// pm_minWalkNormal 0.7 (FACT-Q3, docs/03 §2.1). Each approach holds forward (run, and walk) from
// the base anchor for 4 s and lets go at the top anchor, so it stops on the crest platform. Two
// starts, as in MV-05: on the anchor (feet on the floor) and landed (feet one ε above it, D-017;
// the match's spawn, D-027). The outcome at the toe and the crest depends on where a tick ends
// there, so every approach is swept over 64 u of start positions in 1/8 u steps instead of
// trusting the anchor's one phase.
// Tiers (D-032): `pnpm test` sweeps a sample of those start phases (every 7/8 u, so each 1/8 u
// sub-phase several times, and every 5/2 u on the 0.69 slope); `pnpm test:long` sweeps all of them
// (`packages/tools/long/mv-06-slopes.long.ts`), and `pnpm test:movement` runs both. The approaches
// and checks are shared (`slopes.ts`).

describe("MV-06: slopes on movement_lab", () => {
  slopeApproaches(SAMPLED_PHASES);

  it("slides down the 0.69 slope from a standing start, never grounded on it", () => {
    const base = courseAnchor(course, "slope_069_base");
    const top = courseAnchor(course, "slope_069_top");
    const toe = toeY("069");
    // Halfway up: the hull traced down onto the slope, then onto the clear 1/32 u grid.
    const y = (toe + top.origin[1]) / 2;
    const tr = new TraceResult();
    traceBox(
      course.world,
      vec3(base.origin[0], y, top.origin[2] + 64),
      vec3(base.origin[0], y, base.origin[2] - 64),
      HULL_MINS,
      HULL_STANDING_MAXS,
      MASK_PLAYERSOLID,
      tr,
    );
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.normal[2]).toBeLessThan(0.7);
    const at = vec3();
    const snap = snapOrigin(
      course.world,
      tr.endpos,
      HULL_MINS,
      HULL_STANDING_MAXS,
      MASK_PLAYERSOLID,
      tr.endpos,
      at,
    );
    expect(snap).not.toBe(SNAP_PREVIOUS);
    const ps = placePlayer(new PlayerState(), at, degreesToU16(90), false);
    const record = runner.run(ps, idle(degreesToU16(90)), 180);
    let firstGrounded = -1;
    for (let i = 0; i < record.count && firstGrounded < 0; i++) {
      if (record.grounded(i)) firstGrounded = i;
    }
    const end = record.count - 1;
    logMeasured(
      "MV-06",
      "0.69 slide",
      `from z ${at[2].toFixed(3)}, first grounded at z ${record.z(firstGrounded)} after ${(firstGrounded * record.dt).toFixed(3)} s, end y ${record.y(end)}`,
      `not grounded until the floor (z ${base.origin[2]} + ε), ends past the toe (y < ${toe})`,
    );
    expect(firstGrounded).toBeGreaterThan(0);
    // Grounded only once off the slope, on the floor in front of it.
    expect(record.z(firstGrounded)).toBeLessThanOrEqual(base.origin[2] + TRACE_EPSILON);
    expect(record.grounded(end)).toBe(true);
    expect(record.z(end)).toBeLessThanOrEqual(base.origin[2] + TRACE_EPSILON);
    expect(record.y(end) + HULL_STANDING_MAXS[1]).toBeLessThan(toe);
    expect(snapFallbacks(record)).toBe(0);
  });
});
