import {
  BUTTON_CROUCH,
  BUTTON_WALK,
  canStand,
  PlayerState,
  PMF_CROUCHED,
  type UserCmd,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { HoldInput } from "../../src/scenarios/bots";
import { anchorYawU16, courseAnchor, loadCourse } from "../../src/scenarios/course";
import {
  horizontalSpeed,
  logMeasured,
  maxHorizontalSpeed,
  settledIndex,
} from "../../src/scenarios/metrics";
import { type CmdSource, placeAtAnchor, ScenarioRunner } from "../../src/scenarios/runner";

// docs/03 §8 MV-03, M2 design §5: the walk and crouch caps, and crouch kept under a ceiling
// (docs/03 §4.12) in the movement_lab crouch tunnel.

const WALK_CAP = 320 * 0.5; // pm_runSpeed × pm_walkScale, both FACT-Q3 (docs/03 §2.1)
const CROUCH_CAP = 320 * 0.25; // pm_runSpeed × pm_duckScale, both FACT-Q3 (docs/03 §2.1)
const TOLERANCE = 1;
const BY_TICK = 36; // 0.6 s, as MV-01
const TICKS = 120;

describe("MV-03: walk and crouch caps on the movement_lab runway and in the crouch tunnel", () => {
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

  it("holds 80 ± 1 u/s crouched, by 0.6 s and for the rest of 2 s, with PMF_CROUCHED set", () => {
    const course = loadCourse("movement_lab");
    const start = courseAnchor(course, "runway_start");
    const ps = placeAtAnchor(new PlayerState(), start);
    const bot = new HoldInput(anchorYawU16(start), { buttons: BUTTON_CROUCH });
    const record = new ScenarioRunner(course.world).run(ps, bot, TICKS);
    const settled = settledIndex(record, CROUCH_CAP, TOLERANCE);
    logMeasured(
      "MV-03",
      "crouch cap",
      `${horizontalSpeed(record, BY_TICK).toFixed(3)} u/s at 0.6 s, settled from ${(settled * record.dt).toFixed(3)} s, max ${maxHorizontalSpeed(record).toFixed(3)} u/s`,
      `${CROUCH_CAP} ± ${TOLERANCE} u/s`,
    );
    expect(settled).toBeGreaterThan(0);
    expect(settled).toBeLessThanOrEqual(BY_TICK);
    expect(maxHorizontalSpeed(record)).toBeLessThanOrEqual(CROUCH_CAP + TOLERANCE);
    for (let i = 1; i < record.count; i++) {
      expect((record.flags[i] as number) & PMF_CROUCHED).toBe(PMF_CROUCHED);
    }
  });

  it("stays crouched in the 48 u tunnel after crouch is let go, and stands once out", () => {
    const course = loadCourse("movement_lab");
    const entry = courseAnchor(course, "tunnel_entry");
    const exit = courseAnchor(course, "tunnel_exit");
    const yaw = anchorYawU16(entry);
    // The tunnel spans x from 32 u past the entry anchor to 32 u short of the exit anchor.
    const tunnelX0 = entry.origin[0] + 32;
    const tunnelX1 = exit.origin[0] - 32;
    const releaseX = (tunnelX0 + tunnelX1) / 2;
    /** Crouch-walk in, let go of crouch at the tunnel's middle, keep walking forward. */
    const bot: CmdSource & { released: boolean; releasedAt: number } = {
      released: false,
      releasedAt: Number.NaN,
      next(cmd: UserCmd, state: PlayerState) {
        if (!this.released && (state.origin[0] as number) >= releaseX) {
          this.released = true;
          this.releasedAt = state.origin[0] as number;
        }
        cmd.forward = 127;
        cmd.right = 0;
        cmd.up = 0;
        cmd.buttons = this.released ? 0 : BUTTON_CROUCH;
        cmd.yaw = yaw;
        cmd.pitch = 0;
        cmd.weaponSlot = 0;
      },
    };
    const ps = placeAtAnchor(new PlayerState(), entry);
    const record = new ScenarioRunner(course.world).run(ps, bot, 360);
    expect(bot.released).toBe(true);
    let stoodX = Number.NaN;
    for (let i = 1; i < record.count; i++) {
      const x = record.x(i);
      const crouched = ((record.flags[i] as number) & PMF_CROUCHED) !== 0;
      // A hull reaching under the roof (x ± 15 overlapping the tunnel) is crouched.
      if (x + 15 > tunnelX0 && x - 15 < tunnelX1) expect(crouched, `x ${x}`).toBe(true);
      if (!crouched && Number.isNaN(stoodX) && x > releaseX) stoodX = record.x(i - 1);
    }
    const blocked = new PlayerState();
    blocked.origin.set([bot.releasedAt, entry.origin[1], entry.origin[2]]);
    logMeasured(
      "MV-03",
      "crouch tunnel",
      `crouch released at x ${bot.releasedAt.toFixed(2)}, stood at x ${stoodX.toFixed(2)} (tunnel ends at ${tunnelX1})`,
      "crouched while under the roof, standing once clear",
    );
    expect(canStand(course.world, blocked.origin)).toBe(false);
    // The stand test runs at the tick's start origin: the first one whose hull clears the roof.
    expect(stoodX).toBeGreaterThanOrEqual(tunnelX1 + 15);
    expect(stoodX).toBeLessThan(tunnelX1 + 15 + 3);
  });
});
