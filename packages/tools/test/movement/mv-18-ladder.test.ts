import { BUTTON_JUMP, degreesToU16, PlayerState, PMF_ON_LADDER } from "@game/shared";
import { describe, expect, it } from "vitest";
import { HoldInput, PhasedInput } from "../../src/scenarios/bots";
import { courseAnchor, loadCourse } from "../../src/scenarios/course";
import { horizontalSpeed, logMeasured, snapFallbacks } from "../../src/scenarios/metrics";
import { placeAtAnchor, type ScenarioRecord, ScenarioRunner } from "../../src/scenarios/runner";

// docs/03 §8 MV-18 (basic), §4.14, D-024, M2 design §5: the movement_lab ladder, the SURF_LADDER
// south face (normal −y) of a 384 u block. From ladder_base facing it (yaw 90): forward climbs at
// pm_runSpeed × pm_ladderScale whatever the pitch and reaches ladder_top within 3.5 s; back
// descends; turned ±50° it stays attached, ±70° it detaches and falls; jump pushes off along the
// normal by pm_ladderJumpPush and does not re-attach.

const CLIMB = 320 * 0.5; // pm_runSpeed (FACT-Q3) × pm_ladderScale (ESTIMATE, docs/03 §2.3)
const PUSH = 150; // pm_ladderJumpPush, ESTIMATE (docs/03 §2.3)
const TOLERANCE = 1;
const NORTH = degreesToU16(90);
/** Ticks of climbing before a turn, a descent or a jump: 1 s, well up the 384 u face. */
const CLIMB_TICKS = 60;

const course = loadCourse("movement_lab");
const base = courseAnchor(course, "ladder_base");
const top = courseAnchor(course, "ladder_top");

function vy(r: ScenarioRecord, i: number): number {
  return r.velocity[3 * i + 1] as number;
}

function vz(r: ScenarioRecord, i: number): number {
  return r.velocity[3 * i + 2] as number;
}

function onLadder(r: ScenarioRecord, i: number): boolean {
  return ((r.flags[i] as number) & PMF_ON_LADDER) !== 0;
}

function run(bot: HoldInput | PhasedInput, ticks: number): ScenarioRecord {
  const ps = placeAtAnchor(new PlayerState(), base);
  return new ScenarioRunner(course.world).run(ps, bot, ticks);
}

describe("MV-18: the movement_lab ladder (basic)", () => {
  it.each([-89, 0, 89])("forward at pitch %i climbs at 160 ± 1 u/s", (pitch) => {
    const record = run(new HoldInput(NORTH, { pitch: degreesToU16(pitch) }), CLIMB_TICKS);
    const i = record.ticksRun;
    logMeasured(
      "MV-18",
      `climb at pitch ${pitch}`,
      `${vz(record, i).toFixed(3)} u/s after 1 s`,
      `${CLIMB} ± ${TOLERANCE} u/s`,
    );
    for (let k = 1; k <= i; k++) expect(onLadder(record, k), `tick ${k}`).toBe(true);
    expect(Math.abs(vz(record, i) - CLIMB)).toBeLessThanOrEqual(TOLERANCE);
    expect(horizontalSpeed(record, i)).toBe(0);
  });

  it("reaches ladder_top within 3.5 s", () => {
    const bot = new HoldInput(NORTH, { release: { axis: 1, at: top.origin[1] } });
    const record = run(bot, 240);
    let reached = -1;
    for (let i = 1; i < record.count && reached < 0; i++) {
      if (record.grounded(i) && record.y(i) >= top.origin[1] && record.z(i) >= top.origin[2]) {
        reached = i;
      }
    }
    logMeasured(
      "MV-18",
      "climb to ladder_top",
      reached < 0 ? "not reached in 4 s" : `${(reached * record.dt).toFixed(3)} s`,
      "≤ 3.5 s",
    );
    expect(reached).toBeGreaterThan(0);
    expect(reached * record.dt).toBeLessThanOrEqual(3.5);
    // Standing on the top, one ε above it, as a landing leaves a player (D-017).
    expect(record.z(reached) - top.origin[2]).toBeLessThan(0.1);
    expect(snapFallbacks(record)).toBe(0);
  });

  it("back descends at 160 ± 1 u/s", () => {
    const bot = new PhasedInput([
      { ticks: CLIMB_TICKS, forward: 127, yaw: NORTH },
      { ticks: 1, forward: -127 },
    ]);
    const record = run(bot, CLIMB_TICKS + 45);
    const i = record.ticksRun;
    logMeasured(
      "MV-18",
      "descend",
      `${vz(record, i).toFixed(3)} u/s`,
      `${-CLIMB} ± ${TOLERANCE} u/s`,
    );
    for (let k = CLIMB_TICKS + 1; k <= i; k++) expect(onLadder(record, k)).toBe(true);
    expect(Math.abs(vz(record, i) + CLIMB)).toBeLessThanOrEqual(TOLERANCE);
  });

  it.each([50, -50])("turned %i° off the face it stays attached and climbing", (deg) => {
    const bot = new PhasedInput([
      { ticks: CLIMB_TICKS, forward: 127, yaw: NORTH },
      { ticks: 1, forward: 127, yaw: degreesToU16(90 + deg) },
    ]);
    const record = run(bot, 2 * CLIMB_TICKS);
    for (let k = 1; k < record.count; k++) expect(onLadder(record, k), `tick ${k}`).toBe(true);
    expect(Math.abs(vz(record, record.ticksRun) - CLIMB)).toBeLessThanOrEqual(TOLERANCE);
  });

  it.each([70, -70])("turned %i° off the face it detaches and falls", (deg) => {
    const bot = new PhasedInput([
      { ticks: CLIMB_TICKS, forward: 127, yaw: NORTH },
      { ticks: 1, forward: 127, yaw: degreesToU16(90 + deg) },
    ]);
    const record = run(bot, CLIMB_TICKS + 120);
    const peak = record.z(CLIMB_TICKS);
    let minVz = 0;
    for (let k = CLIMB_TICKS + 1; k < record.count; k++) {
      expect(onLadder(record, k), `tick ${k}`).toBe(false);
      minVz = Math.min(minVz, vz(record, k));
    }
    logMeasured(
      "MV-18",
      `turn ${deg}°`,
      `fell from z ${peak.toFixed(1)} to ${record.z(record.ticksRun).toFixed(1)}`,
      "detached, falling",
    );
    expect(minVz).toBeLessThan(-100);
    // Down on the floor (or, turned east, in the pool's wading section next to the ladder).
    expect(record.grounded(record.ticksRun)).toBe(true);
    expect(record.z(record.ticksRun)).toBeLessThanOrEqual(base.origin[2] + 1 / 32);
  });

  it("jump pushes off along the normal (v·n ≥ 149) and does not re-attach", () => {
    const bot = new PhasedInput([
      { ticks: CLIMB_TICKS, forward: 127, yaw: NORTH },
      { ticks: 1, buttons: BUTTON_JUMP },
      { ticks: 1 },
    ]);
    const record = run(bot, CLIMB_TICKS + 120);
    const j = CLIMB_TICKS + 1;
    // The face's normal is −y, so v·n = −vy.
    const away = 0 - vy(record, j);
    logMeasured("MV-18", "jump off", `v·n ${away.toFixed(3)} u/s`, `≥ ${PUSH - 1} u/s`);
    expect(away).toBeGreaterThanOrEqual(PUSH - 1);
    for (let k = j; k < record.count; k++) expect(onLadder(record, k), `tick ${k}`).toBe(false);
    expect(record.grounded(record.ticksRun)).toBe(true);
    expect(record.y(record.ticksRun)).toBeLessThan(base.origin[1] - 100);
  });
});
