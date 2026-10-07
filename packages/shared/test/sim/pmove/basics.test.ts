import { describe, expect, it } from "vitest";
import { type Vec3, vec3, vec3Dot, vec3Length, vec3Normalize } from "../../../src/math/vec3";
import { Mulberry32 } from "../../../src/rng/mulberry32";
import {
  ACCEL_AIR,
  ACCEL_GROUND,
  ACCEL_WATER,
  accelerate,
  applyFriction,
  clipVelocity,
  cmdScale,
} from "../../../src/sim/pmove/basics";
import { PmoveParams } from "../../../src/sim/pmove/params";
import { BUTTON_WALK, UserCmd } from "../../../src/sim/usercmd";
import { TICK_DT } from "../../../src/time";

const p = new PmoveParams();

function cmd(forward: number, right: number, buttons = 0): UserCmd {
  const c = new UserCmd();
  c.forward = forward;
  c.right = right;
  c.buttons = buttons;
  return c;
}

/** Wish speed from the scaled axes along an orthonormal basis: their length. */
function wishSpeed(forward: number, right: number, up: number, buttons = 0, crouched = false) {
  return vec3Length(cmdScale(vec3(), cmd(forward, right, buttons), up, crouched, p));
}

describe("cmdScale (docs/03 §4.1)", () => {
  it("writes zero for zero input", () => {
    const out = cmdScale(vec3(9, 9, 9), cmd(0, 0), 0, false, p);
    expect([...out]).toEqual([0, 0, 0]);
    expect(Object.is(out[0], 0)).toBe(true);
  });

  it("caps full deflection at pm_runSpeed in every direction", () => {
    expect(wishSpeed(127, 0, 0)).toBe(320);
    expect(wishSpeed(-127, 0, 0)).toBe(320);
    expect(wishSpeed(0, 127, 0)).toBe(320);
    expect(wishSpeed(0, 0, -127)).toBe(320);
  });

  it("never makes diagonals faster than straight input", () => {
    for (const [f, r, u] of [
      [127, 127, 0],
      [127, -127, 0],
      [-127, 127, 127],
      [127, 127, 127],
      [127, 64, 0],
      [-30, 127, -90],
    ] as const) {
      expect(wishSpeed(f, r, u)).toBeCloseTo(320, 10);
    }
  });

  it("keeps the input direction", () => {
    const out = cmdScale(vec3(), cmd(127, -64), 32, false, p);
    expect(out[0] / out[1]).toBeCloseTo(127 / -64, 12);
    expect(out[2] / out[0]).toBeCloseTo(32 / 127, 12);
  });

  it("scales partial deflection by the largest axis", () => {
    expect(wishSpeed(64, 0, 0)).toBeCloseTo((320 * 64) / 127, 10);
    expect(wishSpeed(64, 64, 0)).toBeCloseTo((320 * 64) / 127, 10);
  });

  it("applies walk (× pm_walkScale) and crouch (× pm_duckScale)", () => {
    expect(wishSpeed(127, 0, 0, BUTTON_WALK)).toBe(160);
    expect(wishSpeed(127, 0, 0, 0, true)).toBe(80);
    expect(wishSpeed(127, 0, 0, BUTTON_WALK, true)).toBe(40);
    expect(wishSpeed(127, 127, 0, BUTTON_WALK)).toBeCloseTo(160, 10);
  });

  it("keeps the crouch-walk wish planar at 80 when the walk move passes up = 0 (MV-03)", () => {
    const c = cmd(127, 0);
    c.up = -127; // crouch held: the walk move must not feed it into the scale
    const out = cmdScale(vec3(), c, 0, true, p);
    expect([...out]).toEqual([80, 0, 0]);
    // What passing the crouch axis would do: the planar part shrinks by 1/√2.
    expect(cmdScale(vec3(), c, c.up, true, p)[0]).toBeCloseTo(80 / Math.SQRT2, 10);
  });

  it("reads the speed cap from the params", () => {
    const q = new PmoveParams();
    q.runSpeed = 200;
    q.duckScale = 0.5;
    expect(vec3Length(cmdScale(vec3(), cmd(127, 0), 0, true, q))).toBe(100);
  });

  it("never writes −0, even with a zero speed cap", () => {
    const q = new PmoveParams();
    q.runSpeed = 0;
    const out = cmdScale(vec3(), cmd(-127, -127), -127, false, q);
    for (const x of out) expect(Object.is(x, 0)).toBe(true);
  });
});

describe("accelerate (docs/03 §4.3)", () => {
  /** wishVel = unit(x, y, z) · speed. */
  const wish = (speed: number, x: number, y: number, z = 0) => {
    const d = vec3(x, y, z);
    vec3Normalize(d, d);
    return vec3(d[0] * speed, d[1] * speed, d[2] * speed);
  };

  it("adds coefficient × dt × wishSpeed along wishDir", () => {
    const v = vec3();
    accelerate(v, wish(320, 1, 0), ACCEL_GROUND, p, TICK_DT);
    expect(v[0]).toBeCloseTo((10 * 320) / 60, 12);
    expect(v[1]).toBe(0);
    expect(v[2]).toBe(0);
  });

  it("picks pm_accelerate, pm_airAccelerate or pm_waterAccelerate by kind", () => {
    const q = new PmoveParams();
    q.accelerate = 7;
    q.airAccelerate = 0.5;
    q.waterAccelerate = 3;
    for (const [kind, coefficient] of [
      [ACCEL_GROUND, 7],
      [ACCEL_AIR, 0.5],
      [ACCEL_WATER, 3],
    ] as const) {
      const v = vec3();
      accelerate(v, wish(120, 0, 1), kind, q, TICK_DT);
      expect(v[1]).toBeCloseTo((coefficient * 120) / 60, 12);
    }
  });

  it("caps the component along wishDir at wishSpeed", () => {
    const v = vec3(310, 0, 0);
    accelerate(v, wish(320, 1, 0), ACCEL_GROUND, p, TICK_DT);
    expect(v[0]).toBe(320);
    for (let i = 0; i < 100; i++) accelerate(v, wish(320, 1, 0), ACCEL_GROUND, p, TICK_DT);
    expect(v[0]).toBe(320);
  });

  it("does nothing when add ≤ 0", () => {
    const v = vec3(400, 30, -5);
    accelerate(v, wish(320, 1, 0), ACCEL_GROUND, p, TICK_DT);
    expect([...v]).toEqual([400, 30, -5]);
    const w = vec3(320, 0, 0);
    accelerate(w, wish(320, 1, 0), ACCEL_GROUND, p, TICK_DT);
    expect([...w]).toEqual([320, 0, 0]);
    const z = vec3(1, 2, 3);
    accelerate(z, vec3(), ACCEL_GROUND, p, TICK_DT);
    expect([...z]).toEqual([1, 2, 3]);
  });

  it("gains total speed past wishSpeed when wishDir is perpendicular to the velocity", () => {
    // Air strafe: already at 320 along +x, wishing along +y with air acceleration 1.
    const v = vec3(320, 0, 0);
    accelerate(v, wish(320, 0, 1), ACCEL_AIR, p, TICK_DT);
    expect(v[0]).toBe(320);
    expect(v[1]).toBeCloseTo(320 / 60, 12);
    expect(vec3Length(v)).toBeGreaterThan(320);
  });

  it("gains nothing when hopping straight ahead at the cap", () => {
    const v = vec3(320, 0, 0);
    accelerate(v, wish(320, 1, 0), ACCEL_AIR, p, TICK_DT);
    expect(vec3Length(v)).toBe(320);
  });

  it("works in 3D (swimming)", () => {
    const v = vec3();
    const w = wish(60, 0, 0, -1);
    for (let i = 0; i < 600; i++) accelerate(v, w, ACCEL_WATER, p, TICK_DT);
    expect(v[2]).toBeCloseTo(-60, 9);
    expect(v[0]).toBe(0);
  });
});

describe("applyFriction (docs/03 §4.2, ground)", () => {
  it("removes max(s, pm_stopSpeed) · pm_friction · dt of horizontal speed", () => {
    const v = vec3(300, 0, 0);
    applyFriction(v, true, false, 0, p, TICK_DT);
    expect(v[0]).toBeCloseTo(300 - (300 * 6) / 60, 10);
  });

  it("uses the pm_stopSpeed floor at low speed", () => {
    const v = vec3(50, 0, 0);
    applyFriction(v, true, false, 0, p, TICK_DT);
    expect(v[0]).toBeCloseTo(50 - (100 * 6) / 60, 10);
  });

  it("scales the whole velocity by the horizontal factor", () => {
    const v = vec3(300, 400, 60);
    applyFriction(v, true, false, 0, p, TICK_DT);
    const k = (500 - (500 * 6) / 60) / 500;
    expect(v[0]).toBeCloseTo(300 * k, 10);
    expect(v[1]).toBeCloseTo(400 * k, 10);
    expect(v[2]).toBeCloseTo(60 * k, 10);
  });

  it("zeroes the horizontal velocity below 1 u/s and keeps vertical", () => {
    const v = vec3(0.6, -0.7, -12);
    applyFriction(v, true, false, 0, p, TICK_DT);
    expect([...v]).toEqual([0, 0, -12]);
  });

  it("applies the full term from exactly 1 u/s, which scales vertical too", () => {
    const v = vec3(1, 0, -12);
    applyFriction(v, true, false, 0, p, TICK_DT); // drop 10 > s = 1: k = 0
    for (const x of v) expect(Object.is(x, 0)).toBe(true);
    const w = vec3(0.999, 0, -12);
    applyFriction(w, true, false, 0, p, TICK_DT);
    expect([...w]).toEqual([0, 0, -12]);
  });

  it("stops without reversing, leaving +0 on every axis", () => {
    const big = new PmoveParams();
    big.friction = 100;
    const cases: [Vec3, PmoveParams][] = [
      [vec3(5, -3, 0), p],
      [vec3(-5, -3, -0), p],
      [vec3(-5, 3, -7), p],
      [vec3(320, 120, 0), big],
      [vec3(-320, 120, -7), big],
    ];
    for (const [v, params] of cases) {
      applyFriction(v, true, false, 0, params, TICK_DT);
      for (const x of v) expect(Object.is(x, 0), String([...v])).toBe(true);
    }
  });

  it("never reverses or grows the speed over random velocities", () => {
    const rng = new Mulberry32(0xf00d);
    for (let i = 0; i < 2000; i++) {
      const v = vec3(rng.nextFloat() * 800 - 400, rng.nextFloat() * 800 - 400, 0);
      const before = vec3(v[0], v[1], v[2]);
      applyFriction(v, true, false, 0, p, TICK_DT);
      expect(vec3Dot(v, before)).toBeGreaterThanOrEqual(0);
      expect(vec3Length(v)).toBeLessThanOrEqual(vec3Length(before));
    }
  });

  it("brings 320 u/s to a stop in under a second", () => {
    const v = vec3(320, 0, 0);
    let ticks = 0;
    while (v[0] > 0 && ticks < 600) {
      applyFriction(v, true, false, 0, p, TICK_DT);
      ticks++;
    }
    expect(ticks).toBeLessThan(60);
    expect(v[0]).toBe(0);
  });

  it("does nothing off the ground and out of the water, not even to a slow velocity", () => {
    const v = vec3(300, 0.5, -20);
    applyFriction(v, false, false, 0, p, TICK_DT);
    expect([...v]).toEqual([300, 0.5, -20]);
    const slow = vec3(0.5, 0, 0);
    applyFriction(slow, false, true, 0, p, TICK_DT);
    expect([...slow]).toEqual([0.5, 0, 0]);
  });
});

describe("applyFriction (docs/03 §4.2, water and 3D speed)", () => {
  it("adds s · pm_waterFriction · waterLevel · dt to the ground term", () => {
    for (const level of [1, 2, 3]) {
      const v = vec3(300, 0, 0);
      applyFriction(v, true, false, level, p, TICK_DT);
      expect(v[0]).toBeCloseTo(300 - (300 * 6) / 60 - (300 * 1 * level) / 60, 10);
    }
  });

  it("swims on the water term alone, measured on the 3D speed", () => {
    const v = vec3(0, 0, -60);
    applyFriction(v, false, true, 3, p, TICK_DT);
    expect(v[2]).toBeCloseTo(-60 * (1 - 3 / 60), 10);
    // Horizontal-only measure would see s = 0 and zero nothing but the horizontal part.
    const w = vec3(30, 0, 40);
    applyFriction(w, false, true, 2, p, TICK_DT);
    const k = (50 - (50 * 2) / 60) / 50;
    expect(w[0]).toBeCloseTo(30 * k, 10);
    expect(w[2]).toBeCloseTo(40 * k, 10);
  });

  it("uses the 3D speed for the ladder's ground term, so a vertical climb has friction", () => {
    const v = vec3(0, 0, 160);
    applyFriction(v, true, true, 0, p, TICK_DT);
    expect(v[2]).toBeCloseTo(160 - (160 * 6) / 60, 10);
  });

  it("zeroes the whole velocity below 1 u/s in 3D", () => {
    const v = vec3(0.5, -0.5, 0.5);
    applyFriction(v, false, true, 1, p, TICK_DT);
    expect([...v]).toEqual([0, 0, 0]);
  });

  it("keeps the walk caps in wading water: the water term stays below one tick's acceleration", () => {
    // At the run, walk and crouch caps, ground plus level-1 water friction removes less than
    // pm_accelerate · dt · cap, so the walk still reaches exactly the cap (MV-01/03 hold in water).
    for (const cap of [320, 160, 80]) {
      const v = vec3(cap, 0, 0);
      applyFriction(v, true, false, 1, p, TICK_DT);
      expect(cap - (v[0] as number)).toBeLessThan((10 * cap) / 60);
    }
  });
});

describe("clipVelocity (docs/03 §4.7)", () => {
  const up = vec3(0, 0, 1);
  const OVERCLIP = { overclip: 1.001 };

  it("pushes a velocity into the plane out by the overclip", () => {
    const out = clipVelocity(vec3(), vec3(100, 0, -200), up, OVERCLIP);
    expect(out[0]).toBe(100);
    expect(out[2]).toBeCloseTo(200 * 0.001, 12);
    expect(out[2]).toBeGreaterThan(0);
  });

  it("keeps a little of a velocity already leaving the plane", () => {
    const out = clipVelocity(vec3(), vec3(100, 0, 200), up, OVERCLIP);
    expect(out[0]).toBe(100);
    expect(out[2]).toBeCloseTo(200 - 200 / 1.001, 12);
    expect(out[2]).toBeGreaterThan(0);
  });

  it("leaves a velocity along the plane unchanged", () => {
    const out = clipVelocity(vec3(), vec3(100, -50, 0), up, OVERCLIP);
    expect([...out]).toEqual([100, -50, 0]);
  });

  it("removes the normal component exactly with overclip 1", () => {
    const out = clipVelocity(vec3(), vec3(3, 4, -5), up, { overclip: 1 });
    expect([...out]).toEqual([3, 4, 0]);
  });

  it("never writes −0", () => {
    const out = clipVelocity(vec3(), vec3(-0, 5, -0), vec3(1, 0, 0), OVERCLIP);
    for (const x of out) expect(Object.is(x, -0)).toBe(false);
    clipVelocity(out, vec3(-0, -0, -0), vec3(1, 0, 0), OVERCLIP);
    for (const x of out) expect(Object.is(x, 0)).toBe(true);
    clipVelocity(out, vec3(3, -0, -0), vec3(0, 0, 1), OVERCLIP);
    expect(Object.is(out[1], 0)).toBe(true);
  });

  it("may write in place", () => {
    const v = vec3(100, 0, -200);
    expect(clipVelocity(v, v, up, OVERCLIP)).toBe(v);
    expect(v[2]).toBeGreaterThan(0);
  });

  it("never leaves the result moving into the plane, on either sign", () => {
    const rng = new Mulberry32(0xc11b);
    const n = vec3();
    const v = vec3();
    const out = vec3();
    let into = 0;
    let away = 0;
    for (let i = 0; i < 5000; i++) {
      n[0] = rng.nextFloat() * 2 - 1;
      n[1] = rng.nextFloat() * 2 - 1;
      n[2] = rng.nextFloat() * 2 - 1;
      if (vec3Normalize(n, n) < 0.1) continue;
      v[0] = rng.nextFloat() * 1200 - 600;
      v[1] = rng.nextFloat() * 1200 - 600;
      v[2] = rng.nextFloat() * 1200 - 600;
      const before = vec3Dot(v, n);
      if (before < 0) into++;
      else away++;
      clipVelocity(out, v, n, OVERCLIP);
      // Into the plane: exactly 0.1% of the approach speed comes back out (to rounding).
      const after = vec3Dot(out, n);
      expect(after).toBeGreaterThanOrEqual(-1e-12 * vec3Length(v));
      if (before < 0) expect(after).toBeCloseTo(-before * 0.001, 9);
      else expect(after).toBeCloseTo(before - before / 1.001, 9);
    }
    expect(into).toBeGreaterThan(1000);
    expect(away).toBeGreaterThan(1000);
  });
});
