import { PMF_CROUCHED, PMF_GROUNDED, TEAM_1, TEAM_2, WorldFrame } from "@game/shared";
import { describe, expect, it } from "vitest";
import { RemoteView } from "../../src/net/remotes";

/** A frame of tick `t` holding slot `s` at (x, y, z) u with the given fields. */
function place(
  f: WorldFrame,
  t: number,
  s: number,
  x: number,
  y: number,
  z: number,
  fields: { yaw?: number; pitch?: number; flags?: number; team?: number; seq?: number } = {},
): void {
  f.setPresent(s, t);
  f.originX[s] = x * 32;
  f.originY[s] = y * 32;
  f.originZ[s] = z * 32;
  f.yaw[s] = fields.yaw ?? 0;
  f.pitch[s] = fields.pitch ?? 0;
  f.flags[s] = fields.flags ?? PMF_GROUNDED;
  f.team[s] = fields.team ?? TEAM_1;
  f.teleportSeq[s] = fields.seq ?? 1;
}

describe("RemoteView from the newest frame (increment 5; interpolation in increment 7)", () => {
  it("shows every other present player in sim units, leaving out the receiver and pending slots", () => {
    const f = new WorldFrame();
    place(f, 100, 0, 1, 2, 3);
    place(f, 100, 2, -512.5, 64.03125, 24.03125, {
      yaw: 16384,
      pitch: -1820,
      flags: PMF_GROUNDED | PMF_CROUCHED,
      team: TEAM_2,
    });
    place(f, 100, 63, 0, 0, 0);
    f.setPresent(7, 0);
    const view = new RemoteView();
    view.fillFromFrame(f, 0);
    expect(view.count).toBe(2);
    expect([view.visible[0], view.visible[2], view.visible[7], view.visible[63]]).toEqual([
      0, 1, 0, 1,
    ]);
    expect([view.x[2], view.y[2], view.z[2]]).toEqual([-512.5, 64.03125, 24.03125]);
    expect(view.yaw[2]).toBe(90);
    expect(view.pitch[2]).toBeCloseTo(-10, 1);
    expect([view.crouched[2], view.team[2], view.crouched[63], view.team[63]]).toEqual([
      1,
      TEAM_2,
      0,
      TEAM_1,
    ]);
    expect(view.extrapolating[2]).toBe(0);
  });

  it("marks a slot teleported when it appears or its counter changes, not while it moves", () => {
    const f = new WorldFrame();
    const view = new RemoteView();
    place(f, 10, 1, 0, 0, 24, { seq: 4 });
    view.fillFromFrame(f, 0);
    expect(view.teleported[1]).toBe(1);
    place(f, 11, 1, 5, 0, 24, { seq: 4 });
    view.fillFromFrame(f, 0);
    expect(view.teleported[1]).toBe(0);
    place(f, 12, 1, 900, 0, 24, { seq: 5 });
    view.fillFromFrame(f, 0);
    expect(view.teleported[1]).toBe(1);
    // Gone, then back with the same counter: it appears again, so it jumps.
    f.setAbsent(1);
    view.fillFromFrame(f, 0);
    expect([view.visible[1], view.teleported[1], view.count]).toEqual([0, 0, 0]);
    place(f, 14, 1, 0, 0, 24, { seq: 5 });
    view.fillFromFrame(f, 0);
    expect([view.visible[1], view.teleported[1], view.count]).toEqual([1, 1, 1]);
    view.clear();
    expect([view.visible[1], view.teleported[1], view.count]).toEqual([0, 0, 0]);
  });
});
