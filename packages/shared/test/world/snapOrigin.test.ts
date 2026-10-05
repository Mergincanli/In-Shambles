import { afterEach, describe, expect, it } from "vitest";
import { DevAssertError, setDevAsserts } from "../../src/debug/assert";
import { ORIGIN_LIMIT, quantizeOriginVec3 } from "../../src/math/quant";
import { type Vec3, vec3 } from "../../src/math/vec3";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { HULL_CROUCHED_MAXS, HULL_MINS, HULL_STANDING_MAXS } from "../../src/sim/hull";
import type { CollisionWorld } from "../../src/world/collisionWorld";
import { CONTENTS_WATER, MASK_PLAYERSOLID } from "../../src/world/contents";
import { boxPlanes, rotatedBoxPlanes, wedgePlanes } from "../../src/world/shapes";
import {
  positionTest,
  SNAP_CORNER,
  SNAP_PREVIOUS,
  SNAP_ROUNDED,
  snapOrigin,
  TRACE_COORD_LIMIT,
  TraceResult,
  traceBox,
} from "../../src/world/trace";
import { brush, worldOf } from "../helpers/traceWorld";

const v = vec3;
const MINS = HULL_MINS;
const STAND = HULL_STANDING_MAXS;
const CROUCH = HULL_CROUCHED_MAXS;
const MASK = MASK_PLAYERSOLID;

interface Surface {
  readonly name: string;
  readonly world: CollisionWorld;
  /** Outward unit normal of the surface the hull rests against, and two tangents. */
  readonly normal: Vec3;
  readonly tangents: readonly [Vec3, Vec3];
  /** A clear point in front of the surface. */
  readonly approach: Vec3;
  /**
   * Whether plain rounding can drift into it. On a 45° wall it cannot: with the normal
   * (−s, s, 0), f changes by s·(round(y + δ + u) − round(x + δ − u) − 2u) for a move of δ
   * along the wall and u away from it, which is monotone in u and off by under s/32 < ε.
   */
  readonly plainDrifts: boolean;
}

/** A slope rising toward +x whose normal has the given z (docs/07 §3 movement_lab set). */
function slope(normalZ: number): Surface {
  const run = 4096;
  const rise = (run * Math.sqrt(1 - normalZ * normalZ)) / normalZ;
  const world = worldOf(brush(wedgePlanes([-2048, -2048, 0], [2048, 2048, rise], "+x")));
  const nx = world.planes[4 * 4] as number;
  const nz = world.planes[4 * 4 + 2] as number;
  return {
    name: `slope n.z ${normalZ}`,
    world,
    normal: v(nx, 0, nz),
    tangents: [v(nz, 0, -nx), v(0, 1, 0)],
    approach: v(0, 0, rise / 2 + 200),
    plainDrifts: true,
  };
}

/** A wall rotated about Z by the angle with this cosine and sine (jump_lab kick lanes). */
function rotatedWall(degrees: number, cos: number, sin: number): Surface {
  const world = worldOf(brush(rotatedBoxPlanes([0, 0, 512], [2048, 32, 512], cos, sin)));
  // The +v face, planes −u, +u, −v, +v, −z, +z.
  const nx = world.planes[4 * 3] as number;
  const ny = world.planes[4 * 3 + 1] as number;
  return {
    name: `wall ${degrees}°`,
    world,
    normal: v(nx, ny, 0),
    tangents: [v(ny, -nx, 0), v(0, 0, 1)],
    approach: v(nx * 200, ny * 200, 512),
    plainDrifts: degrees !== 45,
  };
}

const SQRT6 = Math.sqrt(6);
const SQRT3 = Math.sqrt(3);
const SURFACES: Surface[] = [
  slope(0.69),
  slope(0.71),
  slope(0.8),
  rotatedWall(15, (SQRT6 + Math.SQRT2) / 4, (SQRT6 - Math.SQRT2) / 4),
  rotatedWall(30, SQRT3 / 2, 0.5),
  rotatedWall(45, Math.SQRT1_2, Math.SQRT1_2),
  rotatedWall(60, 0.5, SQRT3 / 2),
];

interface ChainResult {
  solidStarts: number;
  rules: number[];
  /** Ticks whose move leaves the surface slightly, and how many of those completed. */
  outwardTicks: number;
  outwardFree: number;
}

/**
 * Rest against the surface, then 200 ticks of a random move along it followed by the end-of-tick
 * snap. Every third tick also pushes into the surface (gravity, walking into a wall) and every
 * third moves slightly away from it (overclip, velocity rounding), so the x/y rounding of a move
 * along a 45° wall is not symmetric. `plain` rounds instead, which is what D-017 replaces.
 */
function slideChain(s: Surface, seed: number, plain = false): ChainResult {
  const rng = new Mulberry32(seed);
  const tr = new TraceResult();
  const origin = v();
  const target = v();
  const result: ChainResult = { solidStarts: 0, rules: [0, 0, 0], outwardTicks: 0, outwardFree: 0 };
  const [t1, t2] = s.tangents;
  const n = s.normal;
  // Drop onto the surface from in front of it, then snap.
  const a = s.approach;
  traceBox(
    s.world,
    a,
    v(a[0] - n[0] * 400, a[1] - n[1] * 400, a[2] - n[2] * 400),
    MINS,
    STAND,
    MASK,
    tr,
  );
  expect(tr.fraction).toBeLessThan(1);
  snapOrigin(s.world, tr.endpos, MINS, STAND, MASK, a, origin);
  const home = v(origin[0], origin[1], origin[2]);
  for (let tick = 0; tick < 200; tick++) {
    let a1 = (rng.nextFloat() * 2 - 1) * 6;
    let a2 = (rng.nextFloat() * 2 - 1) * 6;
    // Stay near the middle of the surface.
    const off1 =
      (origin[0] - home[0]) * t1[0] + (origin[1] - home[1]) * t1[1] + (origin[2] - home[2]) * t1[2];
    const off2 =
      (origin[0] - home[0]) * t2[0] + (origin[1] - home[1]) * t2[1] + (origin[2] - home[2]) * t2[2];
    if (off1 * a1 > 0 && Math.abs(off1) > 200) a1 = -a1;
    if (off2 * a2 > 0 && Math.abs(off2) > 200) a2 = -a2;
    const phase = tick % 3;
    const normalMove =
      phase === 0 ? -rng.nextFloat() * 0.5 : phase === 1 ? (1 + rng.nextFloat() * 15) / 1024 : 0;
    for (let k = 0; k < 3; k++) {
      target[k] =
        (origin[k] as number) +
        a1 * (t1[k] as number) +
        a2 * (t2[k] as number) +
        normalMove * (n[k] as number);
    }
    traceBox(s.world, origin, target, MINS, STAND, MASK, tr);
    if (tr.startSolid) result.solidStarts++;
    if (phase === 1) {
      result.outwardTicks++;
      if (tr.fraction === 1) result.outwardFree++;
    }
    if (plain) {
      origin.set(tr.endpos);
      quantizeOriginVec3(origin);
    } else {
      const rule = snapOrigin(s.world, tr.endpos, MINS, STAND, MASK, origin, origin);
      result.rules[rule] = (result.rules[rule] ?? 0) + 1;
      expect(positionTest(s.world, origin, MINS, STAND, MASK)).toBe(true);
    }
  }
  return result;
}

describe("snapOrigin chains on slopes and rotated walls (D-017)", () => {
  it.each(SURFACES.map((s) => [s.name, s]))(
    "%s: 200 slide + snap ticks never start solid, and slides make progress",
    (_name, s) => {
      let corners = 0;
      for (const seed of [1, 2, 3]) {
        const r = slideChain(s, seed);
        expect(r.solidStarts).toBe(0);
        // A move that leaves the surface is never blocked by it.
        expect(r.outwardFree).toBe(r.outwardTicks);
        corners += r.rules[SNAP_CORNER] as number;
      }
      // Wherever plain rounding drifts, the chain needed rule 2; elsewhere rule 1 always holds.
      if (s.plainDrifts) expect(corners).toBeGreaterThan(0);
      else expect(corners).toBe(0);
    },
  );

  it.each(SURFACES.map((s) => [s.name, s]))(
    "%s: plain rounding drifts into solid, except on a 45° wall (why D-017 exists)",
    (_name, s) => {
      let solid = 0;
      for (const seed of [1, 2, 3]) solid += slideChain(s, seed, true).solidStarts;
      if (s.plainDrifts) expect(solid).toBeGreaterThan(0);
      else expect(solid).toBe(0);
    },
  );
});

describe("snapOrigin rules", () => {
  afterEach(() => setDevAsserts(true));

  const floor = worldOf(brush(boxPlanes([-512, -512, -64], [512, 512, 0])));

  it("rule 1: the rounded point when it is clear", () => {
    const out = v();
    const prev = v(1, 2, 3);
    expect(snapOrigin(floor, v(0.3, -0.3, 24.04), MINS, STAND, MASK, prev, out)).toBe(SNAP_ROUNDED);
    expect([...out]).toEqual([0.3125, -0.3125, 24.03125]);
  });

  it("rule 2: the nearest clear cell corner, ties in corner bit order", () => {
    // Floor top at 5/128: rounding the feet from 0.045 down to 1/32 would sink them.
    const world = worldOf(brush(boxPlanes([-512, -512, -64], [512, 512, 5 / 128])));
    const exact = v(1 / 64, 0.3, 24.045);
    expect(positionTest(world, exact, MINS, STAND, MASK)).toBe(true);
    const out = v();
    expect(snapOrigin(world, exact, MINS, STAND, MASK, v(), out)).toBe(SNAP_CORNER);
    // x is halfway between 0 and 1/32: rounding picks 1/32, the tie rule picks 0 (bit 0 clear).
    expect([...out]).toEqual([0, 0.3125, 24.0625]);
  });

  it("rule 3: last tick's origin when no grid point near is clear", () => {
    // A crouched hull (40 u) in a 40 + 1/64 u gap: it fits only off the grid.
    const world = worldOf(
      brush(boxPlanes([-512, -512, -64], [512, 512, 1 / 128])),
      brush(boxPlanes([-512, -512, 40 + 3 / 128], [512, 512, 100])),
    );
    const exact = v(0.3, 0.7, 24 + 1 / 64);
    expect(positionTest(world, exact, MINS, CROUCH, MASK)).toBe(true);
    const prev = v(-3, 4, 24 + 1 / 64);
    const out = v();
    expect(snapOrigin(world, exact, MINS, CROUCH, MASK, prev, out)).toBe(SNAP_PREVIOUS);
    expect(out).toEqual(prev);
  });

  it("only masked brushes count", () => {
    const pool = worldOf(brush(boxPlanes([-512, -512, -64], [512, 512, 64]), CONTENTS_WATER));
    const out = v();
    expect(snapOrigin(pool, v(0.01, 0, 0), MINS, STAND, MASK, v(), out)).toBe(SNAP_ROUNDED);
    expect([...out]).toEqual([0, 0, 0]);
  });

  it("out may alias exact", () => {
    const p = v(0.3, -0.3, 24.04);
    snapOrigin(floor, p, MINS, STAND, MASK, v(), p);
    expect([...p]).toEqual([0.3125, -0.3125, 24.03125]);
  });

  it("never returns −0", () => {
    const out = v();
    snapOrigin(floor, v(-0.001, -0.001, 100), MINS, STAND, MASK, v(), out);
    expect(Object.is(out[0], 0)).toBe(true);
    expect(Object.is(out[1], 0)).toBe(true);
  });

  it("never returns −0 from a corner either", () => {
    // Floor top at 5/128: the rounded point sinks, the nearest corner rounds −1/128 up to 0.
    const world = worldOf(brush(boxPlanes([-512, -512, -64], [512, 512, 5 / 128])));
    const out = v();
    expect(snapOrigin(world, v(-1 / 128, -1 / 128, 24.045), MINS, STAND, MASK, v(), out)).toBe(
      SNAP_CORNER,
    );
    expect(Object.is(out[0], 0)).toBe(true);
    expect(Object.is(out[1], 0)).toBe(true);
    expect(out[2]).toBe(24.0625);
  });

  it("corners stay within the codec's ±ORIGIN_LIMIT", () => {
    // Clear only past x = ORIGIN_LIMIT, so no clamped grid point fits and rule 3 applies.
    const world = worldOf(
      brush(boxPlanes([16000, -512, -512], [ORIGIN_LIMIT - 15 + 1 / 64, 512, 512])),
    );
    const exact = v(ORIGIN_LIMIT + 0.03, 0.01, 0.01);
    expect(positionTest(world, exact, MINS, STAND, MASK)).toBe(true);
    const prev = v(16380, 0, 600);
    const out = v();
    expect(snapOrigin(world, exact, MINS, STAND, MASK, prev, out)).toBe(SNAP_PREVIOUS);
    expect(out).toEqual(prev);
  });

  it("asserts on a non-finite or out-of-range position; with asserts off keeps last tick's origin", () => {
    const prev = v(5, 6, 30);
    // In clear air, so only the input check keeps them off the grid point they would round to.
    const bads = [
      v(Number.NaN, 0, 100),
      v(0, Number.POSITIVE_INFINITY, 100),
      v(2 * TRACE_COORD_LIMIT, 0, 100),
    ];
    for (const bad of bads) {
      expect(() => snapOrigin(floor, bad, MINS, STAND, MASK, prev, v())).toThrow(DevAssertError);
    }
    setDevAsserts(false);
    for (const bad of bads) {
      const out = v();
      expect(snapOrigin(floor, bad, MINS, STAND, MASK, prev, out)).toBe(SNAP_PREVIOUS);
      expect(out).toEqual(prev);
    }
  });
});
