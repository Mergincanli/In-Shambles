import { describe, expect, it } from "vitest";
import { BrushError } from "../../src/world/polygonize";
import { boxPlanes, rotatedBoxPlanes, wedgePlanes } from "../../src/world/shapes";

function planeRows(planes: Float64Array): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < planes.length; i += 4) rows.push([...planes.subarray(i, i + 4)]);
  return rows;
}

function expectUnitNormals(planes: Float64Array): void {
  for (const [nx = 0, ny = 0, nz = 0] of planeRows(planes)) {
    expect(Math.abs(nx * nx + ny * ny + nz * nz - 1)).toBeLessThan(1e-15);
  }
}

const SQRT2 = Math.sqrt(2);
const SQRT3 = Math.sqrt(3);

describe("brush shape constructors", () => {
  it("builds an axis-aligned box in −x, +x, −y, +y, −z, +z order without −0", () => {
    const planes = boxPlanes([-16, 0, -8], [16, 32, 24]);
    expect(planeRows(planes)).toEqual([
      [-1, 0, 0, 16],
      [1, 0, 0, 16],
      [0, -1, 0, 0],
      [0, 1, 0, 32],
      [0, 0, -1, 8],
      [0, 0, 1, 24],
    ]);
    for (const v of planes) expect(Object.is(v, -0)).toBe(false);
    for (const v of boxPlanes([-8, -8, -8], [-0, -0, -0])) expect(Object.is(v, -0)).toBe(false);
    for (const v of wedgePlanes([-8, -8, -8], [-0, -0, -0], "+x")) {
      expect(Object.is(v, -0)).toBe(false);
    }
  });

  it("matches an axis box when rotated by 0°", () => {
    expect(planeRows(rotatedBoxPlanes([4, -2, 10], [8, 6, 10], 1, 0))).toEqual(
      planeRows(boxPlanes([-4, -8, 0], [12, 4, 20])),
    );
  });

  it("rotates about +Z by the given (cos, sin)", () => {
    const c = SQRT3 / 2;
    const s = 0.5;
    const planes = rotatedBoxPlanes([10, 20, 0], [8, 4, 2], c, s);
    expectUnitNormals(planes);
    const rows = planeRows(planes);
    // +u face: normal (cos, sin, 0) at u·center + hx.
    expect(rows[1]?.[0]).toBeCloseTo(c, 15);
    expect(rows[1]?.[1]).toBeCloseTo(s, 15);
    expect(rows[1]?.[3]).toBeCloseTo(c * 10 + s * 20 + 8, 12);
    // +v face: normal (−sin, cos, 0) at v·center + hy.
    expect(rows[3]?.[0]).toBeCloseTo(-s, 15);
    expect(rows[3]?.[3]).toBeCloseTo(-s * 10 + c * 20 + 4, 12);
    expect(rows[4]).toEqual([0, 0, -1, 2]);
    expect(rows[5]).toEqual([0, 0, 1, 2]);
  });

  it("renormalises closed-form (cos, sin) and rejects a non-unit pair", () => {
    expectUnitNormals(rotatedBoxPlanes([0, 0, 0], [8, 8, 8], SQRT2 / 2, SQRT2 / 2));
    // 5e-7 off unit length is accepted and scaled back onto the unit circle.
    const k = 1 + 5e-7;
    const planes = rotatedBoxPlanes([0, 0, 0], [8, 8, 8], 0.6 * k, 0.8 * k);
    expectUnitNormals(planes);
    expect(Math.abs((planes[4] ?? 0) - 0.6)).toBeLessThan(1e-15);
    expect(Math.abs((planes[5] ?? 0) - 0.8)).toBeLessThan(1e-15);
    expect(() => rotatedBoxPlanes([0, 0, 0], [8, 8, 8], 0.8, 0.8)).toThrow(BrushError);
    expect(() => rotatedBoxPlanes([0, 0, 0], [0, 8, 8], 1, 0)).toThrow(BrushError);
    expect(() => rotatedBoxPlanes([0, 0, 0], [8, 8, 0], 1, 0)).toThrow(BrushError);
    expect(() => rotatedBoxPlanes([0, 0, 0], [8, 8, -1], 1, 0)).toThrow(BrushError);
    expect(() => rotatedBoxPlanes([Number.NaN, 0, 0], [8, 8, 8], 1, 0)).toThrow(BrushError);
  });

  it.each([
    ["+x", [-0.6, 0, 0.8]],
    ["-x", [0.6, 0, 0.8]],
    ["+y", [0, -0.6, 0.8]],
    ["-y", [0, 0.6, 0.8]],
  ] as const)("builds a 3-4-5 wedge rising toward %s", (rise, normal) => {
    const planes = wedgePlanes([0, 0, 0], [8, 8, 6], rise);
    expect(planes.length).toBe(20);
    expectUnitNormals(planes);
    const rows = planeRows(planes);
    const slope = rows[4] ?? [];
    for (let k = 0; k < 3; k++) expect(slope[k]).toBeCloseTo(normal[k] ?? 0, 15);
    // The slope passes through the low edge on the floor and the high edge at the top.
    const low = rise === "+x" || rise === "+y" ? 0 : 8;
    const high = 8 - low;
    const axis = rise.endsWith("x") ? 0 : 1;
    const dot = (p: number[]): number =>
      (slope[0] ?? 0) * (p[0] ?? 0) + (slope[1] ?? 0) * (p[1] ?? 0) + (slope[2] ?? 0) * (p[2] ?? 0);
    const at = (a: number, z: number): number[] => (axis === 0 ? [a, 4, z] : [4, a, z]);
    expect(dot(at(low, 0)) - (slope[3] ?? 0)).toBeCloseTo(0, 12);
    expect(dot(at(high, 6)) - (slope[3] ?? 0)).toBeCloseTo(0, 12);
    // No +z plane and no plane on the low side.
    expect(rows.some((r) => r[2] === 1)).toBe(false);
    expect(rows.some((r) => r[axis] === (low === 0 ? -1 : 1))).toBe(false);
  });

  it("rejects empty or non-finite boxes", () => {
    expect(() => boxPlanes([0, 0, 0], [0, 1, 1])).toThrow(BrushError);
    expect(() => boxPlanes([0, 0, 2], [1, 1, 1])).toThrow(BrushError);
    expect(() => wedgePlanes([0, 0, 0], [1, Number.POSITIVE_INFINITY, 1], "+x")).toThrow(
      BrushError,
    );
  });
});
