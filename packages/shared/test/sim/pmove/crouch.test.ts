import { describe, expect, it } from "vitest";
import { HULL_CROUCHED_MAXS, HULL_STANDING_MAXS } from "../../../src/sim/hull";
import { PMF_CROUCHED, PMF_GROUNDED } from "../../../src/sim/playerState";
import { canStand, checkCrouch } from "../../../src/sim/pmove/crouch";
import { PmoveParams } from "../../../src/sim/pmove/params";
import { pmove } from "../../../src/sim/pmove/pmove";
import { hull } from "../../../src/sim/pmove/scratch";
import { BUTTON_CROUCH, BUTTON_JUMP } from "../../../src/sim/usercmd";
import { TICK_DT } from "../../../src/time";
import {
  box,
  cmd,
  floorBrush,
  horizontalSpeed,
  player,
  restZ,
  run,
} from "../../helpers/pmoveWorld";
import { worldOf } from "../../helpers/traceWorld";

// Crouch (docs/03 §4.12, D-023 "crouch-blocked", M2 design §0: the hull changes only here).

const flat = worldOf(floorBrush());
/** A 48 u high, 64 u wide tunnel along +x from x = 0 to 256: crouched (40 + ε) fits, 56 does not. */
const tunnel = worldOf(
  floorBrush(),
  box([0, -48, 0], [256, -32, 48]),
  box([0, 32, 0], [256, 48, 48]),
  box([0, -48, 48], [256, 48, 64]),
);

describe("checkCrouch", () => {
  it("crouches at once while crouch is held, shrinking the hull from the top", () => {
    const ps = player(0, 0);
    checkCrouch(ps, cmd({ buttons: BUTTON_CROUCH }), flat);
    expect(ps.flags & PMF_CROUCHED).toBe(PMF_CROUCHED);
    expect(hull.maxs).toBe(HULL_CROUCHED_MAXS);
    expect(hull.mins[2]).toBe(-24);
    // The feet stay put: crouching never moves the origin.
    pmove(ps, cmd({ buttons: BUTTON_CROUCH }), flat, new PmoveParams(), TICK_DT, null, null);
    expect(ps.origin[2]).toBe(restZ(0));
    expect(ps.flags & PMF_GROUNDED).toBe(PMF_GROUNDED);
  });

  it("stands up on release when the standing hull fits", () => {
    const ps = player(0, 0);
    ps.flags |= PMF_CROUCHED;
    checkCrouch(ps, cmd(), flat);
    expect(ps.flags & PMF_CROUCHED).toBe(0);
    expect(hull.maxs).toBe(HULL_STANDING_MAXS);
  });

  it("stays crouched on release while the standing hull is blocked, and stands once clear", () => {
    const ps = player(128, 0);
    ps.flags |= PMF_CROUCHED;
    expect(canStand(tunnel, ps.origin)).toBe(false);
    checkCrouch(ps, cmd(), tunnel);
    expect(ps.flags & PMF_CROUCHED).toBe(PMF_CROUCHED);
    expect(hull.maxs).toBe(HULL_CROUCHED_MAXS);
    // Walking out east with crouch released: crouched in the tunnel, standing the first tick the
    // standing hull clears the roof (x > 256 + 15).
    const flags: number[] = [];
    const xs: number[] = [];
    run(ps, tunnel, () => cmd({ forward: 127 }), 180, {
      each: () => {
        flags.push(ps.flags);
        xs.push(ps.origin[0] as number);
      },
    });
    const stood = flags.findIndex((f) => (f & PMF_CROUCHED) === 0);
    expect(stood).toBeGreaterThan(0);
    // The stand test runs at the tick's start origin: the previous tick's end.
    expect(xs[stood - 1]).toBeGreaterThanOrEqual(256 + 15);
    expect(xs[stood - 2]).toBeLessThan(256 + 15);
    expect(canStand(tunnel, ps.origin)).toBe(true);
  });

  it("caps crouched speed at pm_runSpeed × pm_duckScale (80 u/s)", () => {
    const ps = player(0, 0);
    run(ps, flat, () => cmd({ forward: 127, buttons: BUTTON_CROUCH }), 120);
    expect(horizontalSpeed(ps.velocity)).toBeCloseTo(80, 6);
    expect(ps.flags & PMF_CROUCHED).toBe(PMF_CROUCHED);
  });

  it("refuses the jump in the tunnel while crouched (crouch-blocked), allows it in the open", () => {
    const under = player(128, 0);
    under.flags |= PMF_CROUCHED;
    pmove(under, cmd({ buttons: BUTTON_JUMP }), tunnel, new PmoveParams(), TICK_DT, null, null);
    expect(under.velocity[2]).toBe(0);
    expect(under.flags & PMF_GROUNDED).toBe(PMF_GROUNDED);
    const open = player(-512, 0);
    pmove(
      open,
      cmd({ buttons: BUTTON_JUMP | BUTTON_CROUCH }),
      tunnel,
      new PmoveParams(),
      TICK_DT,
      null,
      null,
    );
    expect(open.velocity[2]).toBeGreaterThan(0);
    expect(open.flags & PMF_CROUCHED).toBe(PMF_CROUCHED);
  });
});
