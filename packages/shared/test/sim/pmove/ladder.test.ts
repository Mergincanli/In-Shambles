import { describe, expect, it } from "vitest";
import { angleVectors } from "../../../src/math/angles";
import { degreesToU16 } from "../../../src/math/quant";
import { PMEV_JUMP } from "../../../src/sim/events";
import { HULL_MINS, HULL_STANDING_MAXS } from "../../../src/sim/hull";
import {
  type PlayerState,
  PMF_GROUNDED,
  PMF_JUMP_HELD,
  PMF_ON_LADDER,
} from "../../../src/sim/playerState";
import { checkLadder, LADDER_DETACH_SPEED } from "../../../src/sim/pmove/ladder";
import { PmoveParams } from "../../../src/sim/pmove/params";
import { pmove } from "../../../src/sim/pmove/pmove";
import { ladderNormal, viewForward, viewRight, viewUp } from "../../../src/sim/pmove/scratch";
import { BUTTON_CROUCH, BUTTON_JUMP } from "../../../src/sim/usercmd";
import { TICK_DT } from "../../../src/time";
import type { CollisionWorld } from "../../../src/world/collisionWorld";
import { CONTENTS_WATER, SURF_LADDER } from "../../../src/world/contents";
import { boxPlanes } from "../../../src/world/shapes";
import { TRACE_EPSILON } from "../../../src/world/trace";
import { box, cmd, floorBrush, horizontalSpeed, player, run } from "../../helpers/pmoveWorld";
import { brush, worldOf } from "../../helpers/traceWorld";

// Ladders (docs/03 §4.14, D-024): contact by a forward probe onto a SURF_LADDER face.

/** A 256 u wall north of the origin whose south face (y = 64, normal −y) is a ladder. */
const ladderWall = brush(boxPlanes([-128, 64, 0], [128, 128, 256]), undefined, (face) =>
  face === 2 ? SURF_LADDER : 0,
);
const ladder = worldOf(floorBrush(), ladderWall);
/** The same wall without the flag. */
const plain = worldOf(floorBrush(), box([-128, 64, 0], [128, 128, 256]));

const YAW_NORTH = degreesToU16(90);
/** The hull's north face 1 u from the wall, as at movement_lab's ladder_base. */
const BASE_Y = 64 - 15 - 1;

function atBase(): PlayerState {
  return player(0, BASE_Y);
}

/** Mid-ladder, airborne, at rest. */
function onWall(): PlayerState {
  const ps = player(0, BASE_Y);
  ps.origin[2] = 128;
  ps.flags = 0;
  return ps;
}

/** checkLadder alone, with the basis pmove would build for `yaw` and `pitch`. */
function contact(
  ps: PlayerState,
  world: CollisionWorld,
  yaw: number,
  forward: number,
  pitch = 0,
  p = new PmoveParams(),
): boolean {
  angleVectors(yaw, pitch, viewForward, viewRight, viewUp);
  checkLadder(ps, cmd({ forward, yaw, pitch }), world, p, HULL_MINS, HULL_STANDING_MAXS, null);
  return (ps.flags & PMF_ON_LADDER) !== 0;
}

describe("checkLadder", () => {
  it("attaches facing a SURF_LADDER face within pm_ladderReach, and records its normal", () => {
    expect(contact(onWall(), ladder, YAW_NORTH, 0)).toBe(true);
    expect([...ladderNormal]).toEqual([0, -1, 0]);
    expect(contact(onWall(), plain, YAW_NORTH, 0)).toBe(false);
    // Out of reach: 3 u from the face.
    const far = onWall();
    far.origin[1] = 64 - 15 - 3;
    expect(contact(far, ladder, YAW_NORTH, 0)).toBe(false);
    // Pressed against the face, inside the trace skin.
    const pressed = onWall();
    pressed.origin[1] = 64 - 15 - TRACE_EPSILON;
    expect(contact(pressed, ladder, YAW_NORTH, 0)).toBe(true);
  });

  it("ignores pitch: the probe follows the yaw only", () => {
    for (const deg of [-89, -45, 0, 45, 89]) {
      expect(contact(onWall(), ladder, YAW_NORTH, 0, degreesToU16(deg)), String(deg)).toBe(true);
    }
  });

  it("needs dot(forward, −n) > pm_ladderFacing (0.5: within 60° of the face normal)", () => {
    for (const [deg, attached] of [
      [50, true],
      [59, true],
      [61, false],
      [70, false],
    ] as const) {
      expect(contact(onWall(), ladder, degreesToU16(90 + deg), 0), `+${deg}`).toBe(attached);
      expect(contact(onWall(), ladder, degreesToU16(90 - deg), 0), `-${deg}`).toBe(attached);
    }
    const strict = new PmoveParams();
    strict.ladderFacing = 0.9;
    expect(contact(onWall(), ladder, degreesToU16(120), 0, 0, strict)).toBe(false);
  });

  it("does not attach while moving away faster than LADDER_DETACH_SPEED", () => {
    const ps = onWall();
    ps.velocity[1] = 0 - LADDER_DETACH_SPEED;
    expect(contact(ps, ladder, YAW_NORTH, 0)).toBe(true);
    ps.velocity[1] = 0 - LADDER_DETACH_SPEED - 1 / 16;
    expect(contact(ps, ladder, YAW_NORTH, 0)).toBe(false);
  });

  it("probes with the tick's hull: a crouched player misses a face above its head", () => {
    // A ladder face from 48 u above the floor up: inside the standing hull's 56 u, above the
    // crouched hull's 40 u.
    const high = worldOf(
      floorBrush(),
      brush(boxPlanes([-128, 64, 48], [128, 128, 256]), undefined, (face) =>
        face === 2 ? SURF_LADDER : 0,
      ),
    );
    const standing = atBase();
    pmove(
      standing,
      cmd({ forward: 127, yaw: YAW_NORTH }),
      high,
      new PmoveParams(),
      TICK_DT,
      null,
      null,
    );
    expect(standing.flags & PMF_ON_LADDER).toBe(PMF_ON_LADDER);
    const crouched = atBase();
    const c = cmd({ forward: 127, yaw: YAW_NORTH, buttons: BUTTON_CROUCH });
    pmove(crouched, c, high, new PmoveParams(), TICK_DT, null, null);
    expect(crouched.flags & PMF_ON_LADDER).toBe(0);
  });

  it("on the ground, engages only while forward is held", () => {
    expect(contact(atBase(), ladder, YAW_NORTH, 0)).toBe(false);
    expect(contact(atBase(), ladder, YAW_NORTH, -127)).toBe(false);
    expect(contact(atBase(), ladder, YAW_NORTH, 1)).toBe(true);
  });
});

describe("ladderMove", () => {
  const upNorth = () => cmd({ forward: 127, yaw: YAW_NORTH });

  it("climbs at pm_runSpeed × pm_ladderScale (160 u/s) from the ground, whatever the pitch", () => {
    for (const deg of [-89, 0, 89]) {
      const ps = atBase();
      const pitch = degreesToU16(deg);
      run(ps, ladder, () => cmd({ forward: 127, yaw: YAW_NORTH, pitch }), 40);
      expect(ps.flags & PMF_ON_LADDER, String(deg)).toBe(PMF_ON_LADDER);
      expect(ps.flags & PMF_GROUNDED).toBe(0);
      expect(ps.velocity[2], String(deg)).toBe(160);
      expect(horizontalSpeed(ps.velocity)).toBe(0);
    }
  });

  it("descends with back, slides along the face with strafe, and holds still with no input", () => {
    const down = onWall();
    run(down, ladder, () => cmd({ forward: -127, yaw: YAW_NORTH }), 30);
    expect(down.velocity[2]).toBe(-160);
    const side = onWall();
    run(side, ladder, () => cmd({ right: 127, yaw: YAW_NORTH }), 30);
    // Facing +y, right is +x: along the face, not into or off it.
    expect(side.velocity[0]).toBe(160);
    expect(side.velocity[1]).toBe(0);
    expect(side.velocity[2]).toBe(0);
    expect(side.flags & PMF_ON_LADDER).toBe(PMF_ON_LADDER);
    const still = onWall();
    const z = still.origin[2];
    run(still, ladder, () => cmd({ yaw: YAW_NORTH }), 60);
    expect(still.origin[2]).toBe(z);
    expect(still.flags & PMF_ON_LADDER).toBe(PMF_ON_LADDER);
  });

  it("strafes along the face even when turned away from it within the facing limit", () => {
    const ps = onWall();
    run(ps, ladder, () => cmd({ right: 127, yaw: degreesToU16(90 + 45) }), 30);
    expect(ps.flags & PMF_ON_LADDER).toBe(PMF_ON_LADDER);
    expect(ps.velocity[1]).toBe(0);
    expect(Math.abs(ps.velocity[0] as number)).toBe(160);
  });

  it("jumps off along the normal by pm_ladderJumpPush on a fresh press and does not re-attach", () => {
    const ps = onWall();
    run(ps, ladder, upNorth, 30);
    expect(ps.velocity[2]).toBe(160);
    const { events } = run(ps, ladder, () => cmd({ buttons: BUTTON_JUMP, yaw: YAW_NORTH }), 1);
    expect(events.map(([, type]) => type)).toEqual([PMEV_JUMP]);
    expect(0 - (ps.velocity[1] as number)).toBe(150);
    expect(ps.flags & PMF_ON_LADDER).toBe(0);
    expect(ps.flags & PMF_JUMP_HELD).toBe(PMF_JUMP_HELD);
    run(ps, ladder, () => cmd({ yaw: YAW_NORTH }), 60, {
      each: () => expect(ps.flags & PMF_ON_LADDER).toBe(0),
    });
  });

  it("does not re-attach after a jump-off that is still within reach on the next tick", () => {
    // A 150 u/s push moves the hull 2.5 u per tick, past the default 2 u reach; with 8 u of reach
    // only LADDER_DETACH_SPEED keeps the probe from catching the face again.
    const p = new PmoveParams();
    p.ladderReach = 8;
    const ps = onWall();
    run(ps, ladder, upNorth, 30, { params: p });
    run(ps, ladder, () => cmd({ buttons: BUTTON_JUMP, yaw: YAW_NORTH }), 1, { params: p });
    expect(ps.flags & PMF_ON_LADDER).toBe(0);
    run(ps, ladder, () => cmd({ yaw: YAW_NORTH }), 60, {
      params: p,
      each: () => expect(ps.flags & PMF_ON_LADDER).toBe(0),
    });
  });

  it("pushes off only on the press edge while jump stays held, unless pm_autoHop is on", () => {
    const ps = onWall();
    ps.flags |= PMF_JUMP_HELD;
    const { events } = run(ps, ladder, () => cmd({ buttons: BUTTON_JUMP, yaw: YAW_NORTH }), 10);
    expect(events).toHaveLength(0);
    expect(ps.flags & PMF_ON_LADDER).toBe(PMF_ON_LADDER);
    expect(ps.velocity[1]).toBe(0);
    const p = new PmoveParams();
    p.autoHop = 1;
    const auto = onWall();
    auto.flags |= PMF_JUMP_HELD;
    const held = run(auto, ladder, () => cmd({ buttons: BUTTON_JUMP, yaw: YAW_NORTH }), 1, {
      params: p,
    });
    expect(held.events.map(([, type]) => type)).toEqual([PMEV_JUMP]);
    expect(0 - (auto.velocity[1] as number)).toBe(150);
  });

  it("applies ground friction on the 3D speed: letting go mid-climb stops the climb", () => {
    const ps = onWall();
    run(ps, ladder, upNorth, 30);
    expect(ps.velocity[2]).toBe(160);
    const z = ps.origin[2];
    const vz: number[] = [];
    run(ps, ladder, () => cmd({ yaw: YAW_NORTH }), 40, {
      each: () => {
        vz.push(ps.velocity[2] as number);
        expect(ps.flags & PMF_ON_LADDER).toBe(PMF_ON_LADDER);
      },
    });
    // 160 − max(160, pm_stopSpeed) · pm_friction · dt = 144 on the first tick.
    expect(vz[0]).toBe(144);
    expect(vz.indexOf(0)).toBeGreaterThan(0);
    expect(vz.indexOf(0)).toBeLessThan(30);
    expect((ps.origin[2] as number) - (z as number)).toBeLessThan(20);
  });

  it("wins the dispatch over the swim move where the ladder reaches into deep water", () => {
    const flooded = worldOf(
      floorBrush(),
      ladderWall,
      brush(boxPlanes([-1024, -1024, 0], [1024, 64, 1024]), CONTENTS_WATER),
    );
    const ps = onWall();
    run(ps, flooded, upNorth, 40);
    expect(ps.waterLevel).toBe(3);
    expect(ps.flags & PMF_ON_LADDER).toBe(PMF_ON_LADDER);
    // The ladder climb: straight up at 160, no swim along the view.
    expect(ps.velocity[2]).toBe(160);
    expect(horizontalSpeed(ps.velocity)).toBe(0);
    // Ladder friction is the ground term alone: no water term on top (docs/03 §4.14).
    run(ps, flooded, () => cmd({ yaw: YAW_NORTH }), 1);
    expect(ps.velocity[2]).toBe(144);
  });

  it("climbs over the top of the face into an air move and lands on top", () => {
    const ps = atBase();
    let landedTick = -1;
    let leftTick = -1;
    const landedAt = [0, 0, 0];
    run(ps, ladder, upNorth, 150, {
      each: (t) => {
        if (leftTick < 0 && (ps.flags & PMF_ON_LADDER) === 0 && t > 0) leftTick = t;
        if (landedTick < 0 && (ps.flags & PMF_GROUNDED) !== 0 && t > 0) {
          landedTick = t;
          landedAt.splice(0, 3, ...ps.origin);
        }
      },
    });
    // 256 u at 160 u/s, then the hull clears the face and an air move carries it over the edge.
    expect(leftTick).toBeGreaterThan(90);
    expect(landedTick).toBeGreaterThan(leftTick);
    expect(landedTick).toBeLessThan(leftTick + 40);
    expect(landedAt[2]).toBe(256 + 24 + TRACE_EPSILON);
    expect(landedAt[1]).toBeGreaterThan(64 - 15);
  });

  it("is not gravity-free without contact: turned away it falls", () => {
    const ps = onWall();
    pmove(ps, cmd({ yaw: degreesToU16(90 + 70) }), ladder, new PmoveParams(), TICK_DT, null, null);
    expect(ps.flags & PMF_ON_LADDER).toBe(0);
    expect(ps.velocity[2]).toBeLessThan(0);
  });
});
