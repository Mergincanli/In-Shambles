import { describe, expect, it } from "vitest";
import { PLANE_STRIDE, planeBoxExtent, planeDistance, planeSet } from "../../src/math/plane";
import { vec3 } from "../../src/math/vec3";

describe("plane", () => {
  it("stores [nx, ny, nz, d] at an offset", () => {
    const planes = new Float64Array(PLANE_STRIDE * 2);
    planeSet(planes, PLANE_STRIDE, 0, 0, 1, 64);
    expect(Array.from(planes)).toEqual([0, 0, 0, 0, 0, 0, 1, 64]);
  });

  it("gives the signed distance n·p − d", () => {
    const planes = new Float64Array(8);
    planeSet(planes, 0, 0, 0, 1, 64);
    planeSet(planes, 4, 0.6, -0.8, 0, 10);
    expect(planeDistance(planes, 0, vec3(5, 5, 100))).toBe(36);
    expect(planeDistance(planes, 0, vec3(0, 0, 64))).toBe(0);
    expect(planeDistance(planes, 0, vec3(0, 0, 0))).toBe(-64);
    expect(planeDistance(planes, 4, vec3(10, -5, 7))).toBeCloseTo(0, 12);
  });

  it("measures how far a box reaches along the normal", () => {
    const planes = new Float64Array(8);
    planeSet(planes, 0, 0, 0, -1, 0);
    planeSet(planes, 4, 0.6, -0.8, 0, 10);
    expect(planeBoxExtent(planes, 0, 15, 15, 28)).toBe(28);
    expect(planeBoxExtent(planes, 4, 15, 15, 28)).toBeCloseTo(21, 12);
    expect(planeBoxExtent(planes, 4, 0, 0, 0)).toBe(0);
  });
});
