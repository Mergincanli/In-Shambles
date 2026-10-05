import {
  boxPlanes,
  buildBrush,
  CONTENTS_SOLID,
  createCollisionWorld,
  rotatedBoxPlanes,
  vec3,
  wedgePlanes,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { type OracleBrush, oracleBrushes, separation, vertexSetMismatch } from "./oracle";
import { COURSE_NAMES, loadFuzzWorld, syntheticWorldNames } from "./worlds";

// The fuzz oracle (M1 design G) on hand cases with known answers, and its vertex source checked
// against the triple-plane intersection for every brush the fuzz test uses.

function oracleOf(planes: Float64Array): OracleBrush {
  const b = buildBrush(planes);
  const world = createCollisionWorld([
    { planes: b.planes, faceCount: b.faceCount, bounds: b.bounds, contents: CONTENTS_SOLID },
  ]);
  return oracleBrushes(world)[0] as OracleBrush;
}

const cube = oracleOf(boxPlanes([0, 0, 0], [64, 64, 64]));
const MINS = vec3(-8, -8, -8);
const MAXS = vec3(8, 8, 8);
const POINT = vec3();

function boxSep(x: number, y: number, z: number): number {
  const p = vec3(x, y, z);
  return separation(cube, p, p, MINS, MAXS);
}

describe("SAT oracle", () => {
  it("a box touching a face is at 0, apart is positive, overlapping is minus the depth", () => {
    expect(boxSep(72, 32, 32)).toBe(0);
    expect(boxSep(80, 32, 32)).toBe(8);
    expect(boxSep(70, 32, 32)).toBe(-2);
    expect(boxSep(32, 32, 32)).toBe(-40);
    // Off a corner along the diagonal: the axis gaps are the bound, 4 on each.
    expect(boxSep(76, 76, 76)).toBe(4);
  });

  it("a lopsided box is measured from its own extents", () => {
    const p = vec3(32, 32, 100);
    expect(separation(cube, p, p, vec3(-1, -1, -36), vec3(1, 1, 2))).toBe(0);
    expect(separation(cube, p, p, vec3(-1, -1, -30), vec3(1, 1, 2))).toBe(6);
  });

  it("a sweep that passes through the brush penetrates even though both ends are clear", () => {
    const s = vec3(-100, 32, 32);
    const e = vec3(200, 32, 32);
    expect(separation(cube, s, s, MINS, MAXS)).toBeGreaterThan(0);
    expect(separation(cube, e, e, MINS, MAXS)).toBeGreaterThan(0);
    // The swept hull [−108, 208] × [24, 40]² leaves the cube 40 u sideways.
    expect(separation(cube, s, e, MINS, MAXS)).toBe(-40);
  });

  it("a diagonal sweep past a corner is separated along d × z, which no box axis sees", () => {
    // x + y = 140 passes the corner (64, 64), where x + y = 128, at 12/√2.
    const s = vec3(150, -10, 32);
    const e = vec3(-10, 150, 32);
    expect(separation(cube, s, e, POINT, POINT)).toBeCloseTo(12 / Math.SQRT2, 12);
    // Closer than the corner: it cuts through.
    expect(separation(cube, vec3(130, -10, 32), vec3(-10, 130, 32), POINT, POINT)).toBeLessThan(0);
  });

  it("a ray skew to a sloped edge is separated along e × d", () => {
    // Slope z = x over [0, 64]²; its side edge (s, 0, s) and the ray (32, t − 24, t + 12) are skew
    // lines 4/√3 apart along (−1, −1, 1)/√3, which only the e × d axis measures.
    const wedge = oracleOf(wedgePlanes([0, 0, 0], [64, 64, 64], "+x"));
    const sep = separation(wedge, vec3(32, -24, 12), vec3(32, 16, 52), POINT, POINT);
    expect(sep).toBeCloseTo(4 / Math.sqrt(3), 5);
    // Shifted 4 u along the separating axis it touches the edge.
    const k = 4 / 3;
    const touch = separation(
      wedge,
      vec3(32 + k, -24 + k, 12 - k),
      vec3(32 + k, 16 + k, 52 - k),
      POINT,
      POINT,
    );
    expect(Math.abs(touch)).toBeLessThan(1e-5);
  });

  it("a zero-length sweep is the static box", () => {
    const p = vec3(90, 10, 10);
    expect(separation(cube, p, p, MINS, MAXS)).toBe(18);
  });

  it("slop is 0 for boxes and under one f32 ulp for bevelled shapes", () => {
    expect(cube.slop).toBe(0);
    const rotated = oracleOf(rotatedBoxPlanes([1000, 500, 64], [96, 8, 64], 0.8, 0.6));
    expect(rotated.slop).toBeGreaterThanOrEqual(0);
    expect(rotated.slop).toBeLessThan(2 ** -13);
  });
});

describe("oracle vertices match the triple-plane intersection (M1 design F.7), bevels within an f32 step", () => {
  // The default run's synthetic worlds (trace-fuzz.test.ts uses 48 with seed 0x5eed0009).
  const names = [...COURSE_NAMES, ...syntheticWorldNames(0x5eed0009, 48)];
  it.each(names)("%s", (name) => {
    const brushes = loadFuzzWorld(name).brushes;
    const mismatches = brushes.map((b) => vertexSetMismatch(b)).filter((m) => m !== null);
    expect(mismatches).toEqual([]);
    // The bevel sliver stays within one f32 step, so capping slop there hides nothing.
    const wide = brushes.filter((b) => !(b.reach <= b.reachBound)).map((b) => b.index);
    expect(wide).toEqual([]);
  });
});
