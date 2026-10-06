import { describe, expect, it } from "vitest";
import {
  aabb,
  aabbAddPoint,
  aabbCentroid,
  aabbCopy,
  aabbExpand,
  aabbIsEmpty,
  aabbMakeEmpty,
  aabbOverlaps,
  aabbSurfaceArea,
  aabbUnion,
} from "../../src/math/aabb";
import { vec3 } from "../../src/math/vec3";

const box = (...v: [number, number, number, number, number, number]) => {
  const b = aabb();
  b.set(v);
  return b;
};

describe("aabb", () => {
  it("starts empty with ±Infinity bounds", () => {
    const b = aabb();
    expect(Array.from(b)).toEqual([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    expect(aabbIsEmpty(b)).toBe(true);
    expect(aabbSurfaceArea(b)).toBe(0);
  });

  it("grows exactly to the points added", () => {
    const b = aabb();
    aabbAddPoint(b, vec3(1, -2, 3));
    expect(Array.from(b)).toEqual([1, -2, 3, 1, -2, 3]);
    expect(aabbIsEmpty(b)).toBe(false);
    aabbAddPoint(b, vec3(-4, 5, 0));
    expect(Array.from(b)).toEqual([-4, -2, 0, 1, 5, 3]);
    aabbMakeEmpty(b);
    expect(aabbIsEmpty(b)).toBe(true);
  });

  it("is empty when any one axis is inverted", () => {
    expect(aabbIsEmpty(box(1, 0, 0, 0, 1, 1))).toBe(true);
    expect(aabbIsEmpty(box(0, 1, 0, 1, 0, 1))).toBe(true);
    expect(aabbIsEmpty(box(0, 0, 1, 1, 1, 0))).toBe(true);
    expect(aabbIsEmpty(box(0, 0, 0, 0, 0, 0))).toBe(false);
  });

  it("unions boxes, with the empty box as identity", () => {
    const a = box(0, 0, 0, 1, 1, 1);
    const b = box(-1, 0.5, 0, 0.5, 2, 3);
    expect(Array.from(aabbUnion(aabb(), a, b))).toEqual([-1, 0, 0, 1, 2, 3]);
    expect(Array.from(aabbUnion(aabb(), a, aabb()))).toEqual(Array.from(a));
    expect(Array.from(aabbUnion(aabb(), aabb(), a))).toEqual(Array.from(a));
    // Each result component taken from the second box, then from the first.
    const lo = box(0, 0, 0, 1, 1, 1);
    const hi = box(-1, -2, -3, 4, 5, 6);
    expect(Array.from(aabbUnion(aabb(), lo, hi))).toEqual([-1, -2, -3, 4, 5, 6]);
    expect(Array.from(aabbUnion(aabb(), hi, lo))).toEqual([-1, -2, -3, 4, 5, 6]);
    aabbUnion(a, a, b);
    expect(Array.from(a)).toEqual([-1, 0, 0, 1, 2, 3]);
  });

  it("overlaps on closed intervals", () => {
    const a = box(0, 0, 0, 1, 1, 1);
    expect(aabbOverlaps(a, box(0.5, 0.5, 0.5, 2, 2, 2))).toBe(true);
    expect(aabbOverlaps(a, box(1, 0, 0, 2, 1, 1))).toBe(true);
    expect(aabbOverlaps(a, box(1, 1, 1, 2, 2, 2))).toBe(true);
    // Touching each face, from both sides.
    expect(aabbOverlaps(a, box(0, 1, 0, 1, 2, 1))).toBe(true);
    expect(aabbOverlaps(a, box(0, 0, 1, 1, 1, 2))).toBe(true);
    expect(aabbOverlaps(a, box(-1, 0, 0, 0, 1, 1))).toBe(true);
    expect(aabbOverlaps(a, box(0, -1, 0, 1, 0, 1))).toBe(true);
    expect(aabbOverlaps(a, box(0, 0, -1, 1, 1, 0))).toBe(true);
    expect(aabbOverlaps(a, box(0, 1 + 1e-12, 0, 1, 2, 1))).toBe(false);
    expect(aabbOverlaps(a, box(-1, 0, 0, -1e-12, 1, 1))).toBe(false);
    expect(aabbOverlaps(a, box(0, -1, 0, 1, -1e-12, 1))).toBe(false);
    expect(aabbOverlaps(a, box(1 + 1e-12, 0, 0, 2, 1, 1))).toBe(false);
    expect(aabbOverlaps(a, box(0, 0, -2, 1, 1, -1e-12))).toBe(false);
    expect(aabbOverlaps(a, aabb())).toBe(false);
  });

  it("expands by a margin, in place too", () => {
    const a = box(0, 0, 0, 1, 2, 3);
    expect(Array.from(aabbExpand(aabb(), a, 0.0625))).toEqual([
      -0.0625, -0.0625, -0.0625, 1.0625, 2.0625, 3.0625,
    ]);
    aabbExpand(a, a, -0.5);
    expect(Array.from(a)).toEqual([0.5, 0.5, 0.5, 0.5, 1.5, 2.5]);
  });

  it("computes the SAH surface area and centroids", () => {
    const a = box(0, 0, 0, 1, 2, 3);
    expect(aabbSurfaceArea(a)).toBe(22);
    expect(aabbSurfaceArea(box(1, 1, 1, 1, 1, 1))).toBe(0);
    expect(aabbCentroid(a, 0)).toBe(0.5);
    expect(aabbCentroid(a, 1)).toBe(1);
    expect(aabbCentroid(a, 2)).toBe(1.5);
    expect(Array.from(aabbCopy(aabb(), a))).toEqual([0, 0, 0, 1, 2, 3]);
  });
});
