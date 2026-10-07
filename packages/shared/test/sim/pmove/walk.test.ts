import { describe, expect, it } from "vitest";
import { vec3 } from "../../../src/math/vec3";
import { ENTITY_NONE } from "../../../src/sim/entity";
import { PMEV_JUMP, PMEV_LAND, PmoveEvents } from "../../../src/sim/events";
import { HULL_MINS, HULL_STANDING_MAXS } from "../../../src/sim/hull";
import {
  PlayerState,
  PMF_CLIMBING,
  PMF_CROUCHED,
  PMF_GROUNDED,
  PMF_JUMP_HELD,
} from "../../../src/sim/playerState";
import { groundTrace } from "../../../src/sim/pmove/ground";
import { PmoveParams } from "../../../src/sim/pmove/params";
import { pmove } from "../../../src/sim/pmove/pmove";
import { ground } from "../../../src/sim/pmove/scratch";
import { checkJump } from "../../../src/sim/pmove/walk";
import { BUTTON_JUMP, BUTTON_WALK } from "../../../src/sim/usercmd";
import { TICK_DT } from "../../../src/time";
import type { CollisionWorld } from "../../../src/world/collisionWorld";
import {
  CONTENTS_SLICK,
  CONTENTS_SOLID,
  MASK_PLAYERSOLID,
  SURF_SLICK,
} from "../../../src/world/contents";
import { boxPlanes, rotatedBoxPlanes, wedgePlanes } from "../../../src/world/shapes";
import { snapOrigin, TraceResult, traceBox } from "../../../src/world/trace";
import {
  box,
  cmd,
  floorBrush,
  horizontalSpeed,
  player,
  restZ,
  run,
} from "../../helpers/pmoveWorld";
import { brush, worldOf } from "../../helpers/traceWorld";

// docs/03 §4.4, §4.5 and §4.11: walk, air and the jump check.

const flat = worldOf(floorBrush());

function jumpsIn(events: [number, number, number][]): number[] {
  return events.filter(([, type]) => type === PMEV_JUMP).map(([t]) => t);
}

/**
 * A long slope rising toward +y from y = 0 whose normal z is `nz`, and a player standing on it at
 * `y`. `surf` is every slope face's surface flags.
 */
function onSlope(nz: number, y = 600, surf = 0): { world: CollisionWorld; ps: PlayerState } {
  const run = 2048;
  const rise = (run * Math.sqrt(1 - nz * nz)) / nz;
  const wedge = wedgePlanes([-256, 0, 0], [256, run, rise], "+y");
  const world = worldOf(
    floorBrush(4096),
    brush(wedge, CONTENTS_SOLID, () => surf),
  );
  const tr = new TraceResult();
  traceBox(
    world,
    vec3(0, y, 3000),
    vec3(0, y, -100),
    HULL_MINS,
    HULL_STANDING_MAXS,
    MASK_PLAYERSOLID,
    tr,
  );
  const ps = new PlayerState();
  snapOrigin(
    world,
    tr.endpos,
    HULL_MINS,
    HULL_STANDING_MAXS,
    MASK_PLAYERSOLID,
    tr.endpos,
    ps.origin,
  );
  ps.flags = PMF_GROUNDED;
  return { world, ps };
}

describe("jump rules (docs/03 §4.11)", () => {
  it("jumps once per press: holding jump does not re-jump on landing", () => {
    const ps = player(0, 0);
    const { events } = run(ps, flat, () => cmd({ buttons: BUTTON_JUMP }), 180);
    expect(jumpsIn(events)).toEqual([0]);
    expect(ps.flags & PMF_JUMP_HELD).toBe(PMF_JUMP_HELD);
    expect(ps.flags & PMF_GROUNDED).toBe(PMF_GROUNDED);
  });

  it("jumps again after a release and a new press", () => {
    const ps = player(0, 0);
    // Pressed for 3 ticks, released for the rest of each second.
    const { events } = run(ps, flat, (t) => cmd({ buttons: t % 60 < 3 ? BUTTON_JUMP : 0 }), 180);
    expect(jumpsIn(events)).toEqual([0, 60, 120]);
  });

  it("re-jumps on every landing while held with pm_autoHop 1", () => {
    const params = new PmoveParams();
    params.autoHop = 1;
    const ps = player(0, 0);
    const { events } = run(ps, flat, () => cmd({ buttons: BUTTON_JUMP }), 180, { params });
    const jumps = jumpsIn(events);
    expect(jumps.length).toBeGreaterThanOrEqual(4);
    // Each jump lands and re-jumps on the very next grounded tick.
    const lands = events.filter(([, type]) => type === PMEV_LAND).map(([t]) => t);
    for (let i = 1; i < jumps.length; i++) expect(lands).toContain((jumps[i] as number) - 1);
  });

  it("sets vz, leaves the ground and marks the press held", () => {
    const ps = player(0, 0);
    groundTrace(ps, flat, new PmoveParams(), HULL_MINS, HULL_STANDING_MAXS, false, null);
    ps.velocity[2] = -3;
    const ev = new PmoveEvents();
    expect(checkJump(ps, cmd({ buttons: BUTTON_JUMP }), flat, new PmoveParams(), ev)).toBe(true);
    expect(ps.velocity[2]).toBe(270);
    expect(ps.flags & (PMF_GROUNDED | PMF_JUMP_HELD)).toBe(PMF_JUMP_HELD);
    expect(ps.groundEntity).toBe(ENTITY_NONE);
    expect(ground.hit).toBe(false);
    expect(ev.count).toBe(1);
  });

  it("does not jump airborne, mid-climb or without the button", () => {
    const p = new PmoveParams();
    const airborne = player(0, 0);
    airborne.flags = 0;
    expect(checkJump(airborne, cmd({ buttons: BUTTON_JUMP }), flat, p, null)).toBe(false);
    const climbing = player(0, 0);
    climbing.flags |= PMF_CLIMBING;
    expect(checkJump(climbing, cmd({ buttons: BUTTON_JUMP }), flat, p, null)).toBe(false);
    expect(checkJump(player(0, 0), cmd(), flat, p, null)).toBe(false);
  });

  it("refuses a crouched jump under a ceiling, allows one in the open (D-023)", () => {
    // 50 u of headroom: the crouched hull (40 u + ε) fits, the standing one (56 u) does not.
    const world = worldOf(floorBrush(), box([-64, -64, 50], [64, 64, 80]));
    const under = player(0, 0);
    under.flags |= PMF_CROUCHED;
    const blocked = run(under, world, () => cmd({ buttons: BUTTON_JUMP }), 30);
    expect(jumpsIn(blocked.events)).toEqual([]);
    expect(under.origin[2]).toBe(restZ(0));
    const open = player(200, 0);
    open.flags |= PMF_CROUCHED;
    const free = run(open, world, () => cmd({ buttons: BUTTON_JUMP }), 30);
    expect(jumpsIn(free.events)).toEqual([0]);
  });
});

describe("walk move (docs/03 §4.4)", () => {
  it("checks the jump before friction: a landing-tick jump keeps the speed", () => {
    const jumping = player(0, 0);
    jumping.velocity[0] = 320;
    run(jumping, flat, () => cmd({ buttons: BUTTON_JUMP }), 1);
    expect(jumping.velocity[0]).toBe(320);
    const walking = player(0, 0);
    walking.velocity[0] = 320;
    run(walking, flat, () => cmd(), 1);
    // Friction: 320 − 320 · 6 / 60.
    expect(walking.velocity[0]).toBe(288);
  });

  it("reaches the run cap and the walk cap on flat ground", () => {
    const running = player(0, 0);
    run(running, flat, () => cmd({ forward: 127 }), 60);
    expect(running.velocity[0]).toBeCloseTo(320, 0);
    const walking = player(0, 0);
    run(walking, flat, () => cmd({ forward: 127, buttons: BUTTON_WALK }), 60);
    expect(walking.velocity[0]).toBeCloseTo(160, 0);
  });

  it("stops completely, vz included, once friction takes the last of the speed", () => {
    const ps = player(0, 0);
    ps.velocity.set([0.5, 0, 0.375]);
    run(ps, flat, () => cmd(), 1);
    expect([...ps.velocity]).toEqual([0, 0, 0]);
  });

  it.each([0.71, 0.8])("keeps the speed along a %f slope, grounded every tick", (nz) => {
    const { world, ps } = onSlope(nz);
    let grounded = 0;
    let lastY = ps.origin[1];
    let stalls = 0;
    run(ps, world, () => cmd({ forward: 127, yaw: 16384 }), 120, {
      each: () => {
        if ((ps.flags & PMF_GROUNDED) !== 0) grounded++;
        if (ps.origin[1] - lastY < 1) stalls++;
        lastY = ps.origin[1];
      },
    });
    expect(grounded).toBe(120);
    // The first ticks accelerate from rest; after that every tick climbs.
    expect(stalls).toBeLessThanOrEqual(1);
    const v = ps.velocity;
    expect(Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])).toBeCloseTo(320, 0);
    expect(v[2]).toBeGreaterThan(0);
  });

  it("walks down a slope without leaving it", () => {
    const { world, ps } = onSlope(0.8);
    let grounded = 0;
    run(ps, world, () => cmd({ forward: 127, yaw: 49152 }), 30, {
      each: () => {
        if ((ps.flags & PMF_GROUNDED) !== 0) grounded++;
      },
    });
    expect(grounded).toBe(30);
    expect(ps.velocity[2]).toBeLessThan(0);
  });
});

describe("walk move on slopes, slick ground and landings (docs/03 §4.4, §4.10, D-023)", () => {
  it.each([0.71, 0.8, 0.9, 0.95, 0.99])(
    "stays on a %f slope for 300 ticks up and down, run and walk: no air tick, no LAND",
    (nz) => {
      for (const [yaw, y] of [
        [16384, 100],
        [49152, 1900],
      ] as const) {
        for (const buttons of [0, BUTTON_WALK]) {
          const { world, ps } = onSlope(nz, y);
          const cap = buttons === 0 ? 320 : 160;
          let airTicks = 0;
          let worst = 0;
          const { events } = run(ps, world, () => cmd({ forward: 127, yaw, buttons }), 300, {
            each: (t) => {
              if ((ps.flags & PMF_GROUNDED) === 0) airTicks++;
              const v = ps.velocity;
              if (t > 60) {
                const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
                worst = Math.max(worst, Math.abs(speed - cap));
              }
            },
          });
          const label = `nz ${nz} yaw ${yaw} buttons ${buttons}`;
          expect(
            events.filter(([, type]) => type === PMEV_LAND),
            label,
          ).toEqual([]);
          expect(airTicks, label).toBe(0);
          // An air tick inside the tick (gravity, no friction) would show up as a speed change.
          expect(worst, label).toBeLessThan(0.5);
        }
      }
    },
  );

  it("never turns fall speed into horizontal speed on landing, at any height phase", () => {
    const p = new PmoveParams();
    const ps = new PlayerState();
    const c = cmd({ forward: 127 });
    const ev = new PmoveEvents();
    let worst = 0;
    let landings = 0;
    for (let h = 8; h <= 120; h += 1 / 8) {
      ps.origin.set([0, 0, restZ(0) + h]);
      ps.velocity.set([320, 0, 0]);
      ps.flags = 0;
      let after = -1;
      for (let t = 0; t < 120 && after < 10; t++) {
        pmove(ps, c, flat, p, TICK_DT, ev, null);
        if (ev.count > 0) landings++;
        ev.clear();
        if ((ps.flags & PMF_GROUNDED) !== 0 || after >= 0) after++;
        worst = Math.max(worst, horizontalSpeed(ps.velocity));
      }
    }
    expect(landings).toBe(897);
    expect(worst).toBeLessThan(320.5);
  });

  it("keeps |v| when it lays the velocity onto a slope (slick, so nothing else changes it)", () => {
    const { world, ps } = onSlope(0.8, 600, SURF_SLICK);
    const n = vec3(0, -0.6, 0.8);
    for (const [vx, vy] of [
      [0, 320],
      [0, -320],
      [200, 200],
    ] as const) {
      const start = vec3(ps.origin[0], ps.origin[1], ps.origin[2]);
      const s = new PlayerState();
      s.origin.set(start);
      s.flags = PMF_GROUNDED;
      s.velocity.set([vx, vy, 0]);
      const speed = Math.sqrt(vx * vx + vy * vy);
      run(s, world, () => cmd(), 1);
      const v = s.velocity;
      expect(s.flags & PMF_GROUNDED).toBe(PMF_GROUNDED);
      // Within the 1/16 u/s velocity quantization (docs/05 §4.1).
      expect(Math.abs(Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) - speed)).toBeLessThan(
        0.05,
      );
      const into = v[0] * (n[0] as number) + v[1] * (n[1] as number) + v[2] * (n[2] as number);
      expect(into).toBeGreaterThanOrEqual(0);
      expect(into).toBeLessThan(1);
    }
  });

  it.each([
    ["SURF_SLICK face flag", CONTENTS_SOLID, SURF_SLICK],
    ["CONTENTS_SLICK brush", CONTENTS_SOLID | CONTENTS_SLICK, 0],
  ] as const)("has no friction and air acceleration on slick ground (%s)", (_, contents, surf) => {
    const world = worldOf(
      brush(boxPlanes([-2048, -2048, -64], [2048, 2048, 0]), contents, () => surf),
    );
    const coasting = player(0, 0);
    coasting.velocity[0] = 320;
    run(coasting, world, () => cmd(), 1);
    expect(coasting.velocity[0]).toBe(320);
    // Wishing at right angles adds pm_airAccelerate · 320 · dt, not pm_accelerate's.
    const pushing = player(0, 0);
    pushing.velocity[0] = 320;
    run(pushing, world, () => cmd({ forward: 127, yaw: 16384 }), 1);
    expect(pushing.velocity[0]).toBe(320);
    expect(Math.abs(pushing.velocity[1] - 320 / 60)).toBeLessThan(1 / 32);
  });

  it("stays on the floor walking into an acute corner (the ground plane is a contact)", () => {
    // Two walls meeting at (100, 0) at ±30° from the walk direction.
    const c30 = Math.sqrt(3) / 2;
    const wall = (sin: number, cy: number) =>
      brush(rotatedBoxPlanes([100 + 8 - c30 * 115, cy, 64], [128, 16, 128], c30, sin));
    const world = worldOf(
      floorBrush(),
      wall(-0.5, 0.5 * 115 + c30 * 16),
      wall(0.5, -0.5 * 115 - c30 * 16),
    );
    const ps = player(0, 0);
    let worstZ = 0;
    run(ps, world, () => cmd({ forward: 127 }), 90, {
      each: () => {
        worstZ = Math.max(worstZ, Math.abs(ps.origin[2] - restZ(0)));
      },
    });
    expect(worstZ).toBe(0);
    expect(ps.origin[0]).toBeGreaterThan(40);
    expect(ps.flags & PMF_GROUNDED).toBe(PMF_GROUNDED);
  });
});

describe("air move (docs/03 §4.5)", () => {
  it("slides down a steep 0.69 slope with no input, never grounded on it", () => {
    const { world, ps } = onSlope(0.69);
    const y0 = ps.origin[1];
    const z0 = ps.origin[2];
    let grounded = 0;
    run(ps, world, () => cmd(), 30, {
      each: () => {
        if ((ps.flags & PMF_GROUNDED) !== 0) grounded++;
      },
    });
    expect(grounded).toBe(0);
    expect(ps.origin[1]).toBeLessThan(y0 - 5);
    expect(ps.origin[2]).toBeLessThan(z0 - 5);
    expect(ps.velocity[1]).toBeLessThan(0);
  });

  it("accelerates by pm_airAccelerate only, and strafing gains speed", () => {
    const p = new PmoveParams();
    // In the air at 320 u/s along +x, wishing along +x adds nothing ...
    const straight = player(0, 0);
    straight.origin[2] = 1000;
    straight.flags = 0;
    straight.velocity[0] = 320;
    run(straight, flat, () => cmd({ forward: 127 }), 1, { params: p });
    expect(horizontalSpeed(straight.velocity)).toBe(320);
    // ... while a wish at right angles adds the full 320 · 1 / 60 each tick.
    const strafing = player(0, 0);
    strafing.origin[2] = 1000;
    strafing.flags = 0;
    strafing.velocity[0] = 320;
    run(strafing, flat, () => cmd({ right: 127 }), 1, { params: p });
    expect(strafing.velocity[1]).toBeCloseTo(-320 / 60, 1);
    expect(horizontalSpeed(strafing.velocity)).toBeGreaterThan(320);
  });
});
