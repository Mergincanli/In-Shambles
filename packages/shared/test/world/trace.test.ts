import { afterEach, describe, expect, it } from "vitest";
import { DevAssertError, setDevAsserts } from "../../src/debug/assert";
import { quantizeOrigin } from "../../src/math/quant";
import { type Vec3, vec3 } from "../../src/math/vec3";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { ENTITY_NONE, ENTITY_WORLD } from "../../src/sim/entity";
import { HULL_CROUCHED_MAXS, HULL_MINS, HULL_STANDING_MAXS } from "../../src/sim/hull";
import type { CollisionWorld } from "../../src/world/collisionWorld";
import {
  CONTENTS_LADDER,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  MASK_PLAYERSOLID,
  MASK_SOLID,
  MASK_WATER,
  SURF_SLICK,
} from "../../src/world/contents";
import { boxPlanes, rotatedBoxPlanes, wedgePlanes } from "../../src/world/shapes";
import {
  positionTest,
  TRACE_COORD_LIMIT,
  TRACE_EPSILON,
  TraceResult,
  traceBox,
  traceBoxBrute,
  traceRay,
} from "../../src/world/trace";
import { f64ToHex } from "../helpers/f64";
import { brush, expandedDistance, withoutBevels, worldOf } from "../helpers/traceWorld";

const EPS = TRACE_EPSILON;
const MINS = HULL_MINS;
const STAND = HULL_STANDING_MAXS;
const CROUCH = HULL_CROUCHED_MAXS;
const ZERO = vec3();
const v = vec3;

/** The resting origin height above a floor at z = 0 for HULL_MINS (feet 24 u below origin). */
const REST = 24 + EPS;

const floorBrush = brush(boxPlanes([-512, -512, -64], [512, 512, 0]), CONTENTS_SOLID, (face) =>
  face === 5 ? SURF_SLICK : 0,
);
const floorWorld = worldOf(floorBrush);

function trace(
  world: CollisionWorld,
  start: Vec3,
  end: Vec3,
  mins: Vec3 = MINS,
  maxs: Vec3 = STAND,
  mask = MASK_PLAYERSOLID,
): TraceResult {
  const out = new TraceResult();
  traceBox(world, start, end, mins, maxs, mask, out);
  return out;
}

/** Every field, with doubles as bits, for exact comparisons. */
function bits(r: TraceResult): string[] {
  return [
    f64ToHex(r.fraction),
    ...[...r.endpos, ...r.normal, r.planeDist].map(f64ToHex),
    `${r.plane} ${r.brush} ${r.contents} ${r.surfaceFlags} ${r.entity}`,
    `${r.startSolid} ${r.allSolid}`,
  ];
}

function expectFinite(r: TraceResult): void {
  for (const x of [r.fraction, ...r.endpos, ...r.normal, r.planeDist]) {
    expect(Number.isFinite(x)).toBe(true);
  }
  expect(r.fraction).toBeGreaterThanOrEqual(0);
  expect(r.fraction).toBeLessThanOrEqual(1);
}

describe("TraceResult", () => {
  it("starts and resets to 'nothing hit'", () => {
    const fresh = new TraceResult();
    const r = trace(floorWorld, v(0, 0, 100), v(0, 0, 0));
    expect(r.fraction).toBeLessThan(1);
    r.reset();
    expect(bits(r)).toEqual(bits(fresh));
    expect(fresh.entity).toBe(ENTITY_NONE);
    expect(fresh.plane).toBe(-1);
    expect(fresh.brush).toBe(-1);
  });

  it("is fully rewritten by every trace (a miss after a hit leaves no stale hit)", () => {
    const r = new TraceResult();
    traceBox(floorWorld, v(0, 0, 100), v(0, 0, 0), MINS, STAND, MASK_PLAYERSOLID, r);
    traceBox(floorWorld, v(0, 0, 100), v(10, 0, 100), MINS, STAND, MASK_PLAYERSOLID, r);
    expect(bits(r)).toEqual(bits(trace(floorWorld, v(0, 0, 100), v(10, 0, 100))));
    expect(r.entity).toBe(ENTITY_NONE);
  });
});

describe("ε behaviour (D-017)", () => {
  it("TRACE_EPSILON is 1/32 u", () => {
    expect(TRACE_EPSILON).toBe(0.03125);
  });

  it("a box falling onto a floor rests at exactly floor + 1/32", () => {
    // A 128 u drop makes t dyadic, so every step is exact.
    const r = trace(floorWorld, v(0, 0, 88), v(0, 0, -40));
    expect(r.endpos[2]).toBe(REST);
    expect(r.fraction).toBe((64 - EPS) / 128);
    expect([...r.normal]).toEqual([0, 0, 1]);
    expect(r.planeDist).toBe(0);
    expect(r.plane).toBe(5);
    expect(r.brush).toBe(0);
    expect(r.contents).toBe(CONTENTS_SOLID);
    expect(r.surfaceFlags).toBe(SURF_SLICK);
    expect(r.entity).toBe(ENTITY_WORLD);
    expect(r.startSolid).toBe(false);
    expect(r.allSolid).toBe(false);
  });

  it("any drop rests within rounding of floor + 1/32, and exactly on it after quantizing", () => {
    for (const [from, to] of [
      [100, 0],
      [24.7, -3],
      [1000.3, 23.99],
      [30, -1e4],
    ] as const) {
      const r = trace(floorWorld, v(0.3, -7.1, from), v(0.3, -7.1, to));
      expect(Math.abs(r.endpos[2] - REST)).toBeLessThan(1e-12);
      expect(r.endpos[2]).toBeGreaterThan(24);
      expect(quantizeOrigin(r.endpos[2])).toBe(REST);
      expect(positionTest(floorWorld, r.endpos, MINS, STAND, MASK_PLAYERSOLID)).toBe(true);
    }
  });

  it("touching (f = 0) is outside; any overlap is inside", () => {
    expect(positionTest(floorWorld, v(0, 0, 24), MINS, STAND, MASK_PLAYERSOLID)).toBe(true);
    expect(positionTest(floorWorld, v(0, 0, 24 - 1 / 1024), MINS, STAND, MASK_PLAYERSOLID)).toBe(
      false,
    );
    // Beside the floor's +x face, flush and then overlapping by 1/1024 u.
    expect(positionTest(floorWorld, v(527, 0, 0), MINS, STAND, MASK_PLAYERSOLID)).toBe(true);
    expect(positionTest(floorWorld, v(527 - 1 / 1024, 0, 0), MINS, STAND, MASK_PLAYERSOLID)).toBe(
      false,
    );
  });

  it("uneven hulls (−24/+32) stop ε short with the head too", () => {
    const ceiling = worldOf(brush(boxPlanes([-512, -512, 200], [512, 512, 264])));
    const r = trace(ceiling, v(0, 0, 100), v(0, 0, 228));
    expect(r.endpos[2] + 32).toBe(200 - EPS);
    expect([...r.normal]).toEqual([0, 0, -1]);
    expect(r.planeDist).toBe(-200);
  });

  it("removing ε would let the box touch: the stop is exactly one skin away", () => {
    const r = trace(floorWorld, v(0, 0, 88), v(0, 0, -40));
    expect(expandedDistance(floorWorld, r.plane, r.endpos, MINS, STAND)).toBe(EPS);
  });
});

describe("start-solid and all-solid", () => {
  const block = worldOf(brush(boxPlanes([-64, -64, -64], [64, 64, 64])));

  it("starting inside and moving out: startSolid, not allSolid, fraction 1 to a clear end", () => {
    const end = v(200, 0, 0);
    const r = trace(block, v(0, 0, 0), end);
    expect(r.startSolid).toBe(true);
    expect(r.allSolid).toBe(false);
    expect(r.fraction).toBe(1);
    expect(r.endpos).toEqual(end);
    expect(r.contents).toBe(CONTENTS_SOLID);
    expect(r.entity).toBe(ENTITY_WORLD);
    expect(r.brush).toBe(-1);
    expect([...r.normal]).toEqual([0, 0, 0]);
  });

  it("starting and ending inside: allSolid with fraction 0 and endpos = start", () => {
    const start = v(0.5, 0, 0);
    const r = trace(block, start, v(10, 3, -2));
    expect(r.startSolid).toBe(true);
    expect(r.allSolid).toBe(true);
    expect(r.fraction).toBe(0);
    expect(r.endpos).toEqual(start);
    expect(r.contents).toBe(CONTENTS_SOLID);
  });

  it("ending exactly touching from inside is not allSolid (touching = outside)", () => {
    const r = trace(block, v(0, 0, 0), v(79, 0, 0));
    expect(r.startSolid).toBe(true);
    expect(r.allSolid).toBe(false);
    expect(r.fraction).toBe(1);
  });

  it("starting inside one brush still stops at the next brush", () => {
    const world = worldOf(
      brush(boxPlanes([-64, -64, -64], [64, 64, 64])),
      brush(boxPlanes([200, -64, -64], [264, 64, 64])),
    );
    const r = trace(world, v(0, 0, 0), v(300, 0, 0));
    expect(r.startSolid).toBe(true);
    expect(r.allSolid).toBe(false);
    expect(r.brush).toBe(1);
    expect(r.endpos[0]).toBeCloseTo(200 - 15 - EPS, 12);
  });

  it("contents are the hit brush's plus every brush the trace started in (A.5)", () => {
    const world = worldOf(
      brush(boxPlanes([-64, -64, -64], [64, 64, 64]), CONTENTS_WATER),
      brush(boxPlanes([-32, -32, -32], [32, 32, 32]), CONTENTS_LADDER),
      brush(boxPlanes([200, -64, -64], [264, 64, 64])),
    );
    const r = new TraceResult();
    traceRay(world, v(0, 0, 0), v(300, 0, 0), -1, r);
    expect(r.startSolid).toBe(true);
    expect(r.brush).toBe(2);
    expect(r.contents).toBe(CONTENTS_WATER | CONTENTS_LADDER | CONTENTS_SOLID);
  });
});

describe("grazing", () => {
  it("sliding exactly on a face (sd = ed = 0) is free", () => {
    const r = trace(floorWorld, v(-100, 0, 24), v(100, 37, 24));
    expect(r.fraction).toBe(1);
    expect(r.startSolid).toBe(false);
  });

  it("sliding inside the skin (0 < sd = ed < ε) and at ε is free", () => {
    for (const z of [24 + 1 / 64, 24 + EPS - 1e-9, REST]) {
      const r = trace(floorWorld, v(-100, 0, z), v(100, -50, z));
      expect(r.fraction).toBe(1);
    }
  });

  it("starting in the skin and moving inward stops at once, without startSolid", () => {
    const start = v(0, 0, 24 + 1 / 64);
    const r = trace(floorWorld, start, v(5, 0, 14));
    expect(r.fraction).toBe(0);
    expect(r.endpos).toEqual(start);
    expect(r.startSolid).toBe(false);
    expect([...r.normal]).toEqual([0, 0, 1]);
    expect(r.entity).toBe(ENTITY_WORLD);
  });

  it("a subnormal inward move from a touching start stops at once, not startSolid", () => {
    // (sd − ε)/(sd − ed) overflows to −∞ here; the plane must still count as entering.
    const r = new TraceResult();
    traceRay(floorWorld, v(0, 0, 0), v(0, 0, -5e-324), MASK_PLAYERSOLID, r);
    expect(r.fraction).toBe(0);
    expect(r.startSolid).toBe(false);
    expect(r.allSolid).toBe(false);
    expect([...r.normal]).toEqual([0, 0, 1]);
    const wall = worldOf(brush(boxPlanes([0, -10, -10], [10, 10, 10])));
    traceRay(wall, v(-1e-320, 0, 0), v(-5e-321, 0, 0), MASK_PLAYERSOLID, r);
    expect(r.fraction).toBe(0);
    expect(r.startSolid).toBe(false);
    expect([...r.normal]).toEqual([-1, 0, 0]);
    expect(positionTest(wall, v(-1e-320, 0, 0), ZERO, ZERO, MASK_PLAYERSOLID)).toBe(true);
  });

  it("a wall slide with the hull flush against the face is free", () => {
    const wall = worldOf(brush(boxPlanes([0, -512, 0], [64, 512, 256])));
    const r = trace(wall, v(-15, -200, 100), v(-15, 200, 130));
    expect(r.fraction).toBe(1);
    const overlap = trace(wall, v(-15 + 1 / 64, -600, 100), v(-15 + 1 / 64, 200, 100));
    expect(overlap.fraction).toBeLessThan(1);
    expect([...overlap.normal]).toEqual([0, -1, 0]);
  });

  it("on a rotated wall a nominally tangential skin slide is free or stops at once (D-017)", () => {
    // The move is exactly along the stored normal, but rounding can make ed land a few ulps below
    // sd; that counts as approaching, so the trace stops in place. An outward bias always frees it.
    const wall = worldOf(
      brush(rotatedBoxPlanes([0, 0, 512], [2048, 32, 512], Math.sqrt(3) / 2, 0.5)),
    );
    const nx = wall.planes[4 * 3] as number;
    const ny = wall.planes[4 * 3 + 1] as number;
    let stops = 0;
    let slides = 0;
    for (let i = 0; i < 400; i++) {
      const s = (i - 200) / 4;
      const sd = expandedDistance(wall, 3, v(nx * 60 + ny * s, ny * 60 - nx * s, 512), MINS, STAND);
      const start = v(
        quantizeOrigin(nx * 60 + ny * s + nx * (0.015 - sd)),
        quantizeOrigin(ny * 60 - nx * s + ny * (0.015 - sd)),
        512,
      );
      const skin = expandedDistance(wall, 3, start, MINS, STAND);
      if (!(skin > 0 && skin < EPS)) continue;
      slides++;
      const m = 1 + ((i * 7919) % 1000) / 61.3;
      const r = trace(wall, start, v(start[0] + m * ny, start[1] - m * nx, 512));
      expect(r.startSolid).toBe(false);
      if (r.fraction === 0) {
        stops++;
        expect(r.plane).toBe(3);
      } else {
        expect(r.fraction).toBe(1);
      }
      const bias = 1 / 1024;
      const out = v(start[0] + m * ny + bias * nx, start[1] - m * nx + bias * ny, 512);
      expect(trace(wall, start, out).fraction).toBe(1);
    }
    expect(slides).toBeGreaterThan(20);
    expect(stops).toBeGreaterThan(0);
  });

  it("parallel motion never divides by zero or makes NaN", () => {
    for (const z of [24, 24 + 1 / 64, REST, 24 - 1 / 64, 0, -100]) {
      const r = trace(floorWorld, v(-1000, 0, z), v(1000, 0, z));
      expectFinite(r);
    }
  });
});

describe("corners and edges", () => {
  // The Minkowski sum of this block and the hull is the box [-15, 79]² in xy.
  const block = worldOf(brush(boxPlanes([0, 0, -64], [64, 64, 64])));

  it("passing a vertical edge diagonally hits only when the expanded boxes overlap", () => {
    // Path y = x + c: misses [-15, 79]² for c > 94.
    const miss = trace(block, v(-150, -150 + 94.5, 0), v(150, 150 + 94.5, 0));
    expect(miss.fraction).toBe(1);
    const hit = trace(block, v(-150, -150 + 93.5, 0), v(150, 150 + 93.5, 0));
    expect(hit.fraction).toBeLessThan(1);
    expect([...hit.normal]).toEqual([-1, 0, 0]);
  });

  it("brushing a corner by 1/64 u hits; missing it by 1/64 u does not", () => {
    // Moving up +y with the hull's +x face just short of / just past the block's −x face.
    expect(trace(block, v(-15 - 1 / 64, -100, 0), v(-15 - 1 / 64, 0, 0)).fraction).toBe(1);
    const r = trace(block, v(-15 + 1 / 64, -100, 0), v(-15 + 1 / 64, 0, 0));
    expect([...r.normal]).toEqual([0, -1, 0]);
    expect(r.endpos[1]).toBeCloseTo(-15 - EPS, 12);
  });

  it("cutting a corner by less than ε still hits: leaving times are exact (A.7)", () => {
    // Enters the −x face quickly and leaves through +y slowly, 1/64 u deep at the corner.
    const ray = new TraceResult();
    const start = v(-10, 64 - 1 / 64 - 10 / 64, 0);
    traceRay(block, start, v(10, 64 - 1 / 64 + 10 / 64, 0), MASK_PLAYERSOLID, ray);
    expect(ray.fraction).toBeLessThan(1);
    expect([...ray.normal]).toEqual([-1, 0, 0]);
    // The hull version along the block's vertical edge (expanded box [-15, 79]²).
    const hullStart = v(-25, 79 - 1 / 64 - 10 / 64, 0);
    const hull = trace(block, hullStart, v(-5, 79 - 1 / 64 + 10 / 64, 0));
    expect(hull.fraction).toBeLessThan(1);
    for (const [r, s, mins, maxs] of [
      [ray, start, ZERO, ZERO],
      [hull, hullStart, MINS, STAND],
    ] as const) {
      for (let i = 0; i <= 64; i++) {
        const k = i / 64;
        const p = v(
          s[0] + k * (r.endpos[0] - s[0]),
          s[1] + k * (r.endpos[1] - s[1]),
          s[2] + k * (r.endpos[2] - s[2]),
        );
        expect(positionTest(block, p, mins, maxs, MASK_PLAYERSOLID)).toBe(true);
      }
    }
  });

  it("an exact edge tie keeps the earlier plane (strict >, A.3)", () => {
    const cube = worldOf(brush(boxPlanes([0, 0, 0], [64, 64, 64])));
    // Reaches x = −ε and z = 64 + ε at the same dyadic t; −x is plane 0, +z plane 5.
    const r = new TraceResult();
    traceRay(cube, v(-10, 32, 74), v(10, 32, 54), MASK_PLAYERSOLID, r);
    expect(r.fraction).toBe((10 - EPS) / 20);
    expect(r.plane).toBe(0);
    expect([...r.normal]).toEqual([-1, 0, 0]);
  });

  it("the top edge: sliding over at ε clears it, skimming below it hits", () => {
    expect(trace(block, v(-100, 32, 64 + 24 + EPS), v(200, 32, 64 + 24 + EPS)).fraction).toBe(1);
    const r = trace(block, v(-100, 32, 64 + 24 - 1 / 64), v(200, 32, 64 + 24 - 1 / 64));
    expect([...r.normal]).toEqual([-1, 0, 0]);
  });
});

describe("rotated boxes and wedges (axial bevels)", () => {
  const s = Math.SQRT1_2;
  const diamondBrush = brush(rotatedBoxPlanes([0, 0, 0], [64, 64, 64], s, s));
  const diamond = worldOf(diamondBrush);
  const tip = 64 * Math.SQRT2;

  it("no phantom hit beside a 45° box's corner (needs the x bevel)", () => {
    const start = v(tip + 15 + 1, -200, 0);
    const end = v(tip + 15 + 1, 200, 0);
    expect(trace(diamond, start, end).fraction).toBe(1);
    // Without the bevel the expanded faces overlap the hull there.
    expect(trace(worldOf(withoutBevels(diamondBrush)), start, end).fraction).toBeLessThan(1);
    // And it still hits when the hull really reaches the corner.
    const hit = trace(diamond, v(tip + 15 - 1, -200, 0), v(tip + 15 - 1, 200, 0));
    expect(hit.fraction).toBeLessThan(1);
  });

  it("a 30° box face stops the hull one skin away, reporting the stored face normal", () => {
    const c = Math.sqrt(3) / 2;
    const lane = worldOf(brush(rotatedBoxPlanes([0, 0, 0], [256, 8, 128], c, 0.5)));
    // +v face normal (−sin, cos, 0) = (−0.5, 0.866…).
    const n = v(-0.5, c, 0);
    const start = v(n[0] * 200, n[1] * 200, 0);
    const r = trace(lane, start, v(0, 0, 0));
    expect(r.normal[0]).toBe(Math.fround(-0.5));
    expect(r.normal[1]).toBe(Math.fround(c));
    expect(r.normal[2]).toBe(0);
    expect(r.plane).toBe(3);
    expect(Math.abs(expandedDistance(lane, r.plane, r.endpos, MINS, STAND) - EPS)).toBeLessThan(
      1e-9,
    );
  });

  const wedgeBrush = brush(wedgePlanes([0, -64, 0], [128, 64, 64], "+x"));
  const wedge = worldOf(wedgeBrush);

  it("the +z bevel turns a ramp crest into flat ground", () => {
    // Over the crest: the hull spans x 123…153 across the top edge at x = 128.
    const r = trace(wedge, v(138, 0, 124), v(138, 0, 64));
    expect([...r.normal]).toEqual([0, 0, 1]);
    expect(r.plane).toBeGreaterThanOrEqual(wedgeBrush.faceCount);
    expect(r.surfaceFlags).toBe(0);
    expect(Math.abs(r.endpos[2] - 24 - (64 + EPS))).toBeLessThan(1e-12);
    // Without bevels the extended slope plane stops it in mid-air.
    const phantom = trace(worldOf(withoutBevels(wedgeBrush)), v(138, 0, 124), v(138, 0, 64));
    expect(phantom.endpos[2]).toBeGreaterThan(24 + 70);
    expect(phantom.normal[2]).toBeLessThan(1);
  });

  it("no phantom hit just past the wedge's low edge (needs the −x bevel)", () => {
    const start = v(-16, -200, 14);
    const end = v(-16, 200, 14);
    expect(trace(wedge, start, end).fraction).toBe(1);
    expect(trace(worldOf(withoutBevels(wedgeBrush)), start, end).fraction).toBeLessThan(1);
  });

  it("landing on the slope reports the slope normal", () => {
    const r = trace(wedge, v(64, 0, 200), v(64, 0, 0));
    expect(r.plane).toBe(wedgeBrush.faceCount - 1);
    expect(r.normal[2]).toBe(Math.fround(128 / Math.sqrt(128 * 128 + 64 * 64)));
    expect(Math.abs(expandedDistance(wedge, r.plane, r.endpos, MINS, STAND) - EPS)).toBeLessThan(
      1e-9,
    );
  });
});

describe("several brushes", () => {
  const near = brush(boxPlanes([100, -64, -64], [164, 64, 64]));
  const far = brush(boxPlanes([200, -64, -64], [264, 64, 64]));

  it("the nearest hit wins, whatever the brush order", () => {
    const a = trace(worldOf(near, far), v(0, 0, 0), v(300, 0, 0));
    const b = trace(worldOf(far, near), v(0, 0, 0), v(300, 0, 0));
    expect(a.brush).toBe(0);
    expect(b.brush).toBe(1);
    expect(a.endpos).toEqual(b.endpos);
    expect(a.endpos[0]).toBeCloseTo(100 - 15 - EPS, 12);
  });

  it("equal fractions go to the lower brush index", () => {
    // Same −x face, different extents.
    const left = brush(boxPlanes([100, -64, -64], [132, 8, 64]));
    const right = brush(boxPlanes([100, -8, -64], [180, 64, 64]));
    for (const world of [worldOf(left, right), worldOf(right, left)]) {
      const r = trace(world, v(0, 0, 0), v(300, 0, 0));
      expect(r.brush).toBe(0);
      expect(r.plane).toBeLessThan(world.brushPlaneCount[0] as number);
    }
  });

  it("abutting coplanar floor tiles don't snag a slide across the seam", () => {
    const tiles = worldOf(
      brush(boxPlanes([-256, -64, -16], [0, 64, 0])),
      brush(boxPlanes([0, -64, -16], [256, 64, 0])),
    );
    const rest = trace(tiles, v(-100, 0, 100.3), v(-100, 0, 0));
    for (const z of [24, REST, rest.endpos[2]]) {
      const r = trace(tiles, v(-100, 0, z), v(100, 10, z));
      expect(r.fraction).toBe(1);
      expect(r.startSolid).toBe(false);
    }
  });
});

describe("contents masks", () => {
  const world = worldOf(
    brush(boxPlanes([-512, -512, -64], [512, 512, 0])),
    brush(boxPlanes([-64, -64, 0], [64, 64, 128]), CONTENTS_WATER),
    brush(boxPlanes([200, -64, 0], [264, 64, 128]), CONTENTS_PLAYERCLIP),
  );

  it("MASK_PLAYERSOLID ignores water and stops at player clip", () => {
    const r = trace(world, v(-200, 0, 60), v(400, 0, 60));
    expect(r.brush).toBe(2);
    expect(r.contents).toBe(CONTENTS_PLAYERCLIP);
    expect(r.startSolid).toBe(false);
  });

  it("MASK_SOLID passes through player clip", () => {
    expect(trace(world, v(-200, 0, 60), v(400, 0, 60), MINS, STAND, MASK_SOLID).fraction).toBe(1);
  });

  it("MASK_WATER sees only the water, and starting in it is startSolid with its contents", () => {
    const r = trace(world, v(0, 0, 60), v(0, 0, 400), MINS, STAND, MASK_WATER);
    expect(r.startSolid).toBe(true);
    expect(r.allSolid).toBe(false);
    expect(r.contents).toBe(CONTENTS_WATER);
    expect(r.fraction).toBe(1);
  });

  it("a mask of 0 sees nothing", () => {
    const r = trace(world, v(0, 0, 60), v(0, 0, -400), MINS, STAND, 0);
    expect(r.fraction).toBe(1);
    expect(r.startSolid).toBe(false);
  });
});

describe("rays", () => {
  it("stop ε short of the surface", () => {
    const r = new TraceResult();
    traceRay(floorWorld, v(3, 4, 64), v(3, 4, -64), MASK_PLAYERSOLID, r);
    expect(r.endpos[2]).toBe(EPS);
    expect([...r.normal]).toEqual([0, 0, 1]);
  });

  it("are traceBox with a zero box, bit for bit", () => {
    const rng = new Mulberry32(0x4a7);
    const world = worldOf(
      floorBrush,
      brush(rotatedBoxPlanes([40, 10, 50], [30, 20, 50], Math.sqrt(3) / 2, 0.5)),
      brush(wedgePlanes([-200, -64, 0], [-72, 64, 64], "-x")),
    );
    const ray = new TraceResult();
    for (let i = 0; i < 300; i++) {
      const r = () => (rng.nextFloat() * 2 - 1) * 300;
      const start = v(r(), r(), r() * 0.3 + 40);
      const end = v(r(), r(), r() * 0.3 + 40);
      traceRay(world, start, end, MASK_PLAYERSOLID, ray);
      expect(bits(ray)).toEqual(bits(trace(world, start, end, ZERO, ZERO)));
    }
  });

  it("starting exactly on a surface and moving in stops at once; inside is startSolid", () => {
    const r = new TraceResult();
    traceRay(floorWorld, v(0, 0, 0), v(0, 0, -10), MASK_PLAYERSOLID, r);
    expect(r.fraction).toBe(0);
    expect(r.startSolid).toBe(false);
    traceRay(floorWorld, v(0, 0, -1), v(0, 0, 10), MASK_PLAYERSOLID, r);
    expect(r.startSolid).toBe(true);
    expect(r.allSolid).toBe(false);
    expect(r.fraction).toBe(1);
  });
});

describe("zero-length traces", () => {
  const world = worldOf(
    floorBrush,
    brush(rotatedBoxPlanes([0, 100, 64], [40, 20, 64], Math.sqrt(3) / 2, 0.5)),
    brush(wedgePlanes([-200, -64, 0], [-72, 64, 64], "+x")),
  );

  it("are position tests: fraction 1, or startSolid + allSolid", () => {
    const rng = new Mulberry32(0x2e40);
    const steps = [0, 1 / 64, EPS, -1 / 64, -EPS, 1e-9, -1e-9];
    for (let i = 0; i < 600; i++) {
      const p = v(
        Math.round((rng.nextFloat() * 2 - 1) * 300 * 32) / 32,
        Math.round((rng.nextFloat() * 2 - 1) * 300 * 32) / 32,
        24 + (steps[i % steps.length] as number) + (i % 3 === 0 ? rng.nextFloat() * 100 : 0),
      );
      const maxs = i % 2 === 0 ? STAND : CROUCH;
      const r = trace(world, p, p, MINS, maxs);
      const clear = positionTest(world, p, MINS, maxs, MASK_PLAYERSOLID);
      expect(r.startSolid).toBe(!clear);
      expect(r.allSolid).toBe(!clear);
      expect(r.fraction).toBe(clear ? 1 : 0);
      expect(r.endpos).toEqual(p);
    }
  });
});

describe("endpos exactness", () => {
  const empty = worldOf(brush(boxPlanes([1000, 1000, 1000], [1064, 1064, 1064])));

  it("fraction 1 copies end even where start + 1·(end − start) would round", () => {
    expect(0.7 + 1 * (0.1 - 0.7)).not.toBe(0.1);
    const end = v(0.1, 0.1, 0.1);
    const r = trace(empty, v(0.7, 0.7, 0.7), end);
    expect(r.fraction).toBe(1);
    expect(r.endpos).toEqual(end);
    expect(f64ToHex(r.endpos[0])).toBe(f64ToHex(0.1));
  });

  it("fraction 0 copies start", () => {
    const start = v(0.7, 0.3, 24 + 1 / 64);
    const r = trace(floorWorld, start, v(0.1, 0.9, -5));
    expect(r.fraction).toBe(0);
    expect(r.endpos).toEqual(start);
  });
});

describe("geometry consequences (A.10)", () => {
  function gapWorld(gap: number): CollisionWorld {
    return worldOf(
      brush(boxPlanes([-512, -512, -64], [512, 512, 0])),
      brush(boxPlanes([64, -512, gap], [256, 512, gap + 64])),
    );
  }

  it("a crouched hull resting at floor + 1/32 passes under 41 u and is blocked by 40 u", () => {
    for (const gap of [41, 42, 44]) {
      const world = gapWorld(gap);
      const rest = trace(world, v(0, 0, 88), v(0, 0, -40), MINS, CROUCH);
      expect(rest.endpos[2]).toBe(REST);
      expect(trace(world, rest.endpos, v(200, 0, REST), MINS, CROUCH).fraction).toBe(1);
    }
    const blocked = trace(gapWorld(40), v(0, 0, REST), v(200, 0, REST), MINS, CROUCH);
    expect(blocked.fraction).toBeLessThan(1);
    expect([...blocked.normal]).toEqual([-1, 0, 0]);
    expect(blocked.brush).toBe(1);
  });

  it("an 18 u step clears a step-up trace and a 19 u step does not", () => {
    for (const [height, clears] of [
      [16, true],
      [18, true],
      [19, false],
    ] as const) {
      const world = worldOf(
        brush(boxPlanes([-512, -512, -64], [512, 512, 0])),
        brush(boxPlanes([64, -64, 0], [192, 64, height])),
      );
      const up = trace(world, v(0, 0, REST), v(0, 0, REST + 18));
      expect(up.fraction).toBe(1);
      const forward = trace(world, up.endpos, v(100, 0, up.endpos[2]));
      expect(forward.fraction === 1).toBe(clears);
    }
  });
});

describe("robustness", () => {
  afterEach(() => setDevAsserts(true));

  it("never returns NaN over random traces near mixed brushes", () => {
    const rng = new Mulberry32(0x9a9);
    const world = worldOf(
      floorBrush,
      brush(rotatedBoxPlanes([0, 0, 64], [100, 10, 64], Math.SQRT1_2, Math.SQRT1_2)),
      brush(wedgePlanes([-300, -64, 0], [-100, 64, 96], "-y")),
      brush(boxPlanes([100, 100, 0], [140, 140, 40]), CONTENTS_PLAYERCLIP),
    );
    const out = new TraceResult();
    for (let i = 0; i < 2000; i++) {
      const r = (range: number) => (rng.nextFloat() * 2 - 1) * range;
      const start = v(r(400), r(400), 24 + r(100));
      const end = i % 5 === 0 ? v(start[0], start[1] + r(50), start[2]) : v(r(400), r(400), r(150));
      traceBox(world, start, end, MINS, i % 2 === 0 ? STAND : CROUCH, MASK_PLAYERSOLID, out);
      expectFinite(out);
      if (!out.startSolid && out.fraction < 1) expect(out.plane).toBeGreaterThanOrEqual(0);
    }
  });

  it("asserts on non-finite input; with asserts off reports a stuck start", () => {
    const out = new TraceResult();
    const bad = v(0, Number.NaN, 0);
    expect(() => traceBox(floorWorld, bad, v(0, 0, 0), MINS, STAND, MASK_SOLID, out)).toThrow(
      DevAssertError,
    );
    expect(() =>
      traceBox(floorWorld, v(0, 0, 0), v(0, 0, 0), STAND, MINS, MASK_SOLID, out),
    ).toThrow(DevAssertError);
    expect(() => positionTest(floorWorld, bad, MINS, STAND, MASK_SOLID)).toThrow(DevAssertError);
    setDevAsserts(false);
    traceBox(
      floorWorld,
      v(5, 6, 7),
      v(Number.POSITIVE_INFINITY, 0, 0),
      MINS,
      STAND,
      MASK_SOLID,
      out,
    );
    expect(out.allSolid).toBe(true);
    expect(out.startSolid).toBe(true);
    expect(out.fraction).toBe(0);
    expect([...out.endpos]).toEqual([5, 6, 7]);
    expect(positionTest(floorWorld, bad, MINS, STAND, MASK_SOLID)).toBe(false);
  });

  it("rejects coordinates beyond TRACE_COORD_LIMIT, where rounding would eat the floor", () => {
    const out = new TraceResult();
    const far = v(0, 0, 1e18);
    expect(() => traceBox(floorWorld, far, v(0, 0, -1e18), MINS, STAND, MASK_SOLID, out)).toThrow(
      DevAssertError,
    );
    setDevAsserts(false);
    traceRay(floorWorld, far, v(0, 0, -1e18), MASK_SOLID, out);
    expect(out.allSolid).toBe(true);
    expect(out.fraction).toBe(0);
    // At the limit the skin still holds.
    traceRay(floorWorld, v(0, 0, TRACE_COORD_LIMIT), v(0, 0, -TRACE_COORD_LIMIT), MASK_SOLID, out);
    expect(out.startSolid).toBe(false);
    expect(out.endpos[2]).toBeGreaterThan(0);
    expect(Math.abs(out.endpos[2] - EPS)).toBeLessThan(1e-6);
  });

  it("traceBox and traceBoxBrute agree bit for bit", () => {
    const rng = new Mulberry32(0xb0b);
    const a = new TraceResult();
    const b = new TraceResult();
    for (let i = 0; i < 200; i++) {
      const r = (range: number) => (rng.nextFloat() * 2 - 1) * range;
      const start = v(r(500), r(500), 24 + r(60));
      const end = v(r(500), r(500), r(60));
      traceBox(floorWorld, start, end, MINS, STAND, MASK_PLAYERSOLID, a);
      traceBoxBrute(floorWorld, start, end, MINS, STAND, MASK_PLAYERSOLID, b);
      expect(bits(a)).toEqual(bits(b));
    }
  });
});
