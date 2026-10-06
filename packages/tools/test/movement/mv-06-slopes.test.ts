import {
  BUTTON_WALK,
  degreesToU16,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  PlayerState,
  SNAP_PREVIOUS,
  snapOrigin,
  TICK_RATE,
  TRACE_EPSILON,
  TraceResult,
  traceBox,
  traceRay,
  vec3,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { HoldInput, idle } from "../../src/scenarios/bots";
import { anchorYawU16, courseAnchor, loadCourse } from "../../src/scenarios/course";
import {
  airborneTicks,
  horizontalSpeed,
  lands,
  logMeasured,
  snapFallbacks,
} from "../../src/scenarios/metrics";
import { placeAtAnchor, placePlayer, ScenarioRunner } from "../../src/scenarios/runner";

// docs/03 §8 MV-06, §4.10, M2 design §5: the movement_lab slope set either side of
// pm_minWalkNormal 0.7 (FACT-Q3, docs/03 §2.1). Each approach holds forward (run, and walk) from
// the base anchor for 4 s and lets go at the top anchor, so it stops on the crest platform. Two
// starts, as in MV-05: spawned (feet on the floor) and landed (feet one ε above it, D-017). The
// outcome at the toe and the crest depends on where a tick ends there, so every approach is swept
// over 64 u of start positions in 1/8 u steps instead of trusting the anchor's one phase.

const TICKS = 240; // 4 s
/**
 * A stall: horizontal speed below this fraction of the cap after reaching the cap (200 u/s at the
 * run cap, M2 design §5). The toe is the one exception: stepping onto the slope clips the
 * velocity against it (about half the cap is left on 0.71), and the walk then accelerates back to
 * the incline speed, within TOE_RECOVERY_TICKS.
 */
const STALL_FRACTION = 200 / 320;
const TOE_RECOVERY_TICKS = 6;
/**
 * At the crest a walk can go airborne (the docs/03 §4.10 kick-off: it still carries the slope's
 * vz when the ground trace finds the flat platform), but only within this height below the top.
 */
const CREST_ZONE = 4;
/**
 * Slack on the ideal time to the top anchor (0.2 s): the run-up from rest and the toe and crest
 * steps cost up to 8 ticks; a stall costs more.
 */
const REACH_MARGIN_TICKS = 12;
const SWEEP = 64;
const SWEEP_STEP = 1 / 8;
/** The 0.69 approaches all end at the toe, so a coarser sweep covers them. */
const STEEP_SWEEP_STEP = 1 / 2;
const course = loadCourse("movement_lab");
const runner = new ScenarioRunner(course.world);
const gravity = runner.params.gravity;

const STARTS = [
  ["spawned", 0],
  ["landed", TRACE_EPSILON],
] as const;
const SPEEDS = [
  ["run", 0, 320], // pm_runSpeed (FACT-Q3)
  ["walk", BUTTON_WALK, 320 * 0.5], // pm_runSpeed × pm_walkScale, both FACT-Q3 (docs/03 §2.1)
] as const;

/** Holds forward (with `buttons`) from `dy` u behind the base anchor, lifted by `lift`. */
function approach(tag: string, lift: number, dy: number, buttons: number) {
  const base = courseAnchor(course, `slope_${tag}_base`);
  const top = courseAnchor(course, `slope_${tag}_top`);
  const ps = placeAtAnchor(new PlayerState(), base);
  ps.origin[1] -= dy;
  ps.origin[2] += lift;
  const bot = new HoldInput(anchorYawU16(base), {
    buttons,
    release: { axis: 1, at: top.origin[1] },
  });
  return { base, top, record: runner.run(ps, bot, TICKS) };
}

/** y of the slope's toe: a ray along the base anchor's yaw 1/32 u above the floor. */
function toeY(tag: string): number {
  const base = courseAnchor(course, `slope_${tag}_base`);
  const feet = base.origin[2] + HULL_MINS[2];
  const tr = new TraceResult();
  const from = vec3(base.origin[0], base.origin[1], feet + 1 / 32);
  traceRay(course.world, from, vec3(from[0], from[1] + 512, from[2]), MASK_PLAYERSOLID, tr);
  expect(tr.fraction).toBeLessThan(1);
  return tr.endpos[1];
}

describe("MV-06: slopes on movement_lab", () => {
  describe.each(STARTS)("%s", (start, lift) => {
    describe.each(SPEEDS)("%s", (speed, buttons, cap) => {
      it.each(["071", "080"])(
        "walks up the %s slope onto its crest platform from any phase: grounded on the incline, no stall",
        (tag) => {
          const nz = Number(tag) / 100;
          const incline = cap * nz; // the walk keeps |v| = cap along the slope
          const vzIncline = cap * Math.sqrt(1 - nz * nz);
          const toe = toeY(tag);
          const crest = toe + 256; // the slope set's 256 u runs (docs/07 §3)
          let worstReach = Number.NEGATIVE_INFINITY;
          let launches = 0;
          let maxAirborne = 0;
          let highest = Number.NEGATIVE_INFINITY;
          let steadyMin = Number.POSITIVE_INFINITY;
          let steadyMax = 0;
          for (let k = 0; k <= SWEEP / SWEEP_STEP; k++) {
            const dy = k * SWEEP_STEP;
            const { base, top, record } = approach(tag, lift, dy, buttons);
            const at = `${tag} ${start} ${speed}, ${dy} u back`;
            const y0 = record.y(0);
            const front = HULL_STANDING_MAXS[1];
            // At the cap from the toe, at incline speed on the slope, at the cap again on the top.
            const ideal =
              TICK_RATE *
              ((toe - front - y0) / cap + 256 / incline + (top.origin[1] - (crest - front)) / cap);
            let reached = -1;
            let atCap = -1;
            let onSlope = -1;
            let recovered = -1;
            const stalls: number[] = [];
            for (let i = 1; i < record.count; i++) {
              const s = horizontalSpeed(record, i);
              const z = record.z(i);
              if (reached < 0 && record.y(i) >= top.origin[1]) reached = i;
              if (atCap < 0 && s >= cap - 0.5) atCap = i;
              if (onSlope < 0 && z > base.origin[2] + TRACE_EPSILON) onSlope = i;
              if (onSlope >= 0 && recovered < 0 && Math.abs(s - incline) <= 0.5) recovered = i;
              if (atCap >= 0 && reached < 0 && s < cap * STALL_FRACTION) stalls.push(i);
              if (!record.grounded(i)) {
                // Off the ground only at the crest, never gaining on the incline's vz.
                expect(z, `${at}: airborne at tick ${i}`).toBeGreaterThan(
                  top.origin[2] - CREST_ZONE,
                );
                expect(record.velocity[3 * i + 2] as number, at).toBeLessThanOrEqual(
                  vzIncline + 0.5,
                );
              } else if (recovered >= 0 && z < top.origin[2] - 20) {
                steadyMin = Math.min(steadyMin, s);
                steadyMax = Math.max(steadyMax, s);
              }
              highest = Math.max(highest, z - top.origin[2]);
            }
            expect(onSlope, at).toBeGreaterThan(0);
            expect(recovered - onSlope, at).toBeGreaterThanOrEqual(0);
            expect(recovered - onSlope, at).toBeLessThanOrEqual(TOE_RECOVERY_TICKS);
            // The only slow ticks are the toe's, before the walk is back at incline speed.
            for (const i of stalls) {
              expect(i >= onSlope && i < recovered, `${at}: stall at tick ${i}`).toBe(true);
            }
            const airborne = airborneTicks(record);
            if (airborne > 0) launches++;
            maxAirborne = Math.max(maxAirborne, airborne);
            worstReach = Math.max(worstReach, reached - ideal);
            expect(reached, at).toBeGreaterThan(0);
            expect(reached, at).toBeLessThanOrEqual(ideal + REACH_MARGIN_TICKS);
            // A crest launch is one ballistic hop at most.
            expect(airborne, at).toBeLessThanOrEqual((2 * TICK_RATE * vzIncline) / gravity + 2);
            expect(lands(record).length, at).toBeLessThanOrEqual(1);
            const end = record.count - 1;
            expect(record.grounded(end), at).toBe(true);
            expect(record.z(end), at).toBeGreaterThanOrEqual(top.origin[2]);
            expect(record.z(end), at).toBeLessThanOrEqual(top.origin[2] + TRACE_EPSILON);
            expect(snapFallbacks(record), at).toBe(0);
          }
          logMeasured(
            "MV-06",
            `${tag} slope (${start}, ${speed}, ${SWEEP / SWEEP_STEP + 1} phases)`,
            `incline ${steadyMin.toFixed(2)}–${steadyMax.toFixed(2)} u/s, top reached ≤ ${worstReach.toFixed(1)} ticks after ideal, crest launches in ${launches} phases (≤ ${maxAirborne} ticks, peak ${highest.toFixed(2)} u above the top)`,
            `incline ${incline.toFixed(2)} ± 0.5 u/s, ≤ ${REACH_MARGIN_TICKS} ticks, grounded below the crest, under ${(cap * STALL_FRACTION).toFixed(0)} u/s only in the ≤ ${TOE_RECOVERY_TICKS} toe ticks`,
          );
          expect(steadyMin).toBeGreaterThanOrEqual(incline - 0.5);
          expect(steadyMax).toBeLessThanOrEqual(incline + 0.5);
          // No launch rises above the ballistic height of the incline's vz, from up to one tick's
          // rise above the top, plus 1 u for the tick integration and rounding.
          expect(highest).toBeLessThanOrEqual(
            (vzIncline * vzIncline) / (2 * gravity) + vzIncline / TICK_RATE + 1,
          );
        },
      );

      it("cannot walk up the 0.69 slope from any phase: never above its top − 100 u", () => {
        const toe = toeY("069");
        let highestOver = Number.NEGATIVE_INFINITY;
        let airborneMax = 0;
        let landsMax = 0;
        for (let k = 0; k <= SWEEP / STEEP_SWEEP_STEP; k++) {
          const dy = k * STEEP_SWEEP_STEP;
          const { base, top, record } = approach("069", lift, dy, buttons);
          const at = `069 ${start} ${speed}, ${dy} u back`;
          let highest = record.z(0);
          for (let i = 0; i < record.count; i++) {
            highest = Math.max(highest, record.z(i));
            // Never grounded anywhere above the floor: the slope is steep (docs/03 §4.10).
            if (record.z(i) > base.origin[2] + TRACE_EPSILON) {
              expect(record.grounded(i), `${at}: tick ${i}`).toBe(false);
            }
          }
          expect(highest, at).toBeLessThanOrEqual(top.origin[2] - 100);
          const end = record.count - 1;
          // Held at the toe: the hull's face within a unit of it.
          expect(Math.abs(record.y(end) + HULL_STANDING_MAXS[1] - toe), at).toBeLessThan(1.5);
          if (lift === 0) {
            // Accepted limit (docs/03 §4.10, D-023): feet exactly on the floor meet the wedge's
            // axial bevel at the toe as a wall, and the walk stops there without touching the
            // slope. Pinned, so a trace or spawn change that alters it is noticed.
            expect(highest, at).toBe(base.origin[2]);
            expect(airborneTicks(record), at).toBe(0);
            expect(horizontalSpeed(record, end), at).toBe(0);
          } else {
            // One ε up, the walk is clipped onto the slope, slides back down it, lands on the
            // floor and tries again: a jitter at the toe while forward is held (docs/03 §4.10).
            expect(highest, at).toBeGreaterThan(base.origin[2] + 1);
            expect(airborneTicks(record), at).toBeGreaterThan(0);
            expect(lands(record).length, at).toBeGreaterThan(0);
          }
          highestOver = Math.max(highestOver, highest - base.origin[2]);
          airborneMax = Math.max(airborneMax, airborneTicks(record));
          landsMax = Math.max(landsMax, lands(record).length);
        }
        const top = courseAnchor(course, "slope_069_top");
        const base = courseAnchor(course, "slope_069_base");
        logMeasured(
          "MV-06",
          `069 slope (${start}, ${speed}, ${SWEEP / STEEP_SWEEP_STEP + 1} phases)`,
          `highest ${highestOver.toFixed(3)} u above the floor, ≤ ${airborneMax} airborne ticks, ≤ ${landsMax} LAND events in 4 s`,
          `z ≤ ${top.origin[2] - 100} (${(top.origin[2] - 100 - base.origin[2]).toFixed(1)} u above the floor)`,
        );
      });
    });
  });

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
