import { describe, expect, it } from "vitest";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { type BuiltBrush, buildBrush, f32RoundUp } from "../../src/world/brushBuild";
import { boxPlanes, rotatedBoxPlanes, type Triple, wedgePlanes } from "../../src/world/shapes";

const f32 = new Float32Array(1);
const f32Bits = new Uint32Array(f32.buffer);

/** The next f32 below a positive or negative f32 x. */
function f32Below(x: number): number {
  f32[0] = x;
  if (x > 0) f32Bits[0] = (f32Bits[0] ?? 0) - 1;
  else if (x < 0) f32Bits[0] = (f32Bits[0] ?? 0) + 1;
  else f32Bits[0] = 0x80000001;
  return f32[0] ?? 0;
}

function rows(planes: Float64Array): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < planes.length; i += 4) out.push([...planes.subarray(i, i + 4)]);
  return out;
}

/** max over vertices of n·v for an axis normal. */
function extent(brush: BuiltBrush, axis: number, sign: number): number {
  let m = Number.NEGATIVE_INFINITY;
  for (let i = axis; i < brush.vertices.length; i += 3)
    m = Math.max(m, sign * (brush.vertices[i] ?? 0));
  return m;
}

function expectBevelsOutward(brush: BuiltBrush): void {
  const bevels = rows(brush.planes).slice(brush.faceCount);
  for (const [nx = 0, ny = 0, nz = 0, d = 0] of bevels) {
    const axis = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
    const sign = nx + ny + nz;
    expect(Math.abs(sign)).toBe(1);
    const e = extent(brush, axis, sign);
    // Contains every vertex, and is the tightest f32 that does.
    expect(d).toBeGreaterThanOrEqual(e);
    expect(f32Below(d)).toBeLessThan(e);
  }
}

function expectAllF32(values: ArrayLike<number>): void {
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    expect(Math.fround(v)).toBe(v);
  }
}

const SQRT3 = Math.sqrt(3);

describe("f32RoundUp", () => {
  it.each([
    [64, 64],
    [-64, -64],
    [0, 0],
    [-0, 0],
    [0.1, Math.fround(0.1)],
    [1 + 2 ** -30, 1 + 2 ** -23],
    [-1 - 2 ** -30, -1],
    [-1 + 2 ** -30, -(1 - 2 ** -24)],
    [1e-50, 2 ** -149],
    [-1e-50, 0],
  ])("%d → %d", (x, expected) => {
    const r = f32RoundUp(x);
    expect(r).toBe(expected);
    expect(Object.is(r, -0)).toBe(false);
    expect(r).toBeGreaterThanOrEqual(x);
  });
});

describe("buildBrush: axial bevels and bounds", () => {
  it("adds no bevels to an axis-aligned box; bounds are the box", () => {
    const brush = buildBrush(boxPlanes([-16, -8, 0], [16, 8, 72]));
    expect(brush.faceCount).toBe(6);
    expect(brush.planes.length).toBe(24);
    expect([...brush.bounds]).toEqual([-16, -8, 0, 16, 8, 72]);
  });

  it.each([
    [15, (Math.sqrt(6) + Math.SQRT2) / 4, (Math.sqrt(6) - Math.SQRT2) / 4],
    [30, SQRT3 / 2, 0.5],
    [45, Math.SQRT1_2, Math.SQRT1_2],
    [60, 0.5, SQRT3 / 2],
  ])("adds ±x and ±y bevels to a box rotated %d°", (_deg, c, s) => {
    const brush = buildBrush(rotatedBoxPlanes([100.3, -20.7, 50], [64, 8, 32], c, s));
    expect(brush.faceCount).toBe(6);
    const bevels = rows(brush.planes).slice(6);
    expect(bevels.map((r) => r.slice(0, 3))).toEqual([
      [-1, 0, 0],
      [1, 0, 0],
      [0, -1, 0],
      [0, 1, 0],
    ]);
    expectBevelsOutward(brush);
    expectAllF32(brush.planes);
    expectAllF32(brush.bounds);
    const [minx, miny, minz, maxx, maxy, maxz] = brush.bounds;
    expect([minx, maxx, miny, maxy]).toEqual([
      -(bevels[0]?.[3] ?? 0),
      bevels[1]?.[3],
      -(bevels[2]?.[3] ?? 0),
      bevels[3]?.[3],
    ]);
    // z comes from the exact ±z faces.
    expect([minz, maxz]).toEqual([18, 82]);
  });

  it("adds the low-side and top bevels to a wedge", () => {
    const brush = buildBrush(wedgePlanes([-37.3, 10, -5], [200.1, 74, 140.7], "+x"));
    expect(brush.faceCount).toBe(5);
    expect(
      rows(brush.planes)
        .slice(5)
        .map((r) => r.slice(0, 3)),
    ).toEqual([
      [-1, 0, 0],
      [0, 0, 1],
    ]);
    expectBevelsOutward(brush);
    expectAllF32(brush.planes);
    // f32 plane rounding moves the low edge by about 1e-6 u.
    expect(brush.bounds[0]).toBeCloseTo(-37.3, 4);
    expect(brush.bounds[5]).toBeCloseTo(140.7, 4);
  });

  function expectInsideBounds(b: BuiltBrush): void {
    for (let i = 0; i < b.vertices.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = b.vertices[i + k] ?? 0;
        expect(v).toBeGreaterThanOrEqual(b.bounds[k] ?? 0);
        expect(v).toBeLessThanOrEqual(b.bounds[k + 3] ?? 0);
      }
    }
  }

  it("keeps every vertex inside its bounds", () => {
    expectInsideBounds(
      buildBrush(rotatedBoxPlanes([-1000.7, 333.3, -12.1], [100, 3, 40], 0.5, SQRT3 / 2)),
    );
    expectInsideBounds(buildBrush(wedgePlanes([-901.9, -77.7, 0.3], [-500.1, 3.3, 77.7], "-y")));
    // Oblique planes listed before the axial faces they meet.
    expectInsideBounds(
      buildBrush(
        Float64Array.from([
          ...[0.31198814229646626, 0.6178903274347511, 0.721716663469104, 62.68893257341069],
          ...[-0.6441172046610497, -0.5699348142280499, 0.5101836279130028, 84.24634353944566],
          ...boxPlanes([-100.1, -99.7, -101.1], [100.3, 100.9, 98.3]),
        ]),
      ),
    );
  });

  it("keeps every vertex inside its bounds for seeded off-grid shapes", () => {
    const rng = new Mulberry32(0xb0b);
    const coord = (): number => (rng.nextFloat() - 0.5) * 20000;
    const size = (): number => 1 + rng.nextFloat() * 500;
    const rises = ["+x", "-x", "+y", "-y"] as const;
    for (let i = 0; i < 300; i++) {
      const p: Triple = [coord(), coord(), coord()];
      let planes: Float64Array;
      if (i % 2 === 0) {
        const rx = rng.nextFloat() - 0.5;
        const ry = rng.nextFloat() - 0.5;
        const len = Math.sqrt(rx * rx + ry * ry);
        planes = rotatedBoxPlanes(p, [size(), size(), size()], rx / len, ry / len);
      } else {
        const q: Triple = [p[0] + size(), p[1] + size(), p[2] + size()];
        planes = wedgePlanes(p, q, rises[(i >> 1) % 4] ?? "+x");
      }
      expectInsideBounds(buildBrush(planes));
    }
  });

  it("keeps faces before bevels and passes the face sources through", () => {
    const planes = Float64Array.from([
      ...rotatedBoxPlanes([0, 0, 0], [32, 32, 32], 0.5, SQRT3 / 2),
      1,
      0,
      0,
      1000,
    ]);
    const brush = buildBrush(planes);
    expect([...brush.faceSource]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(brush.polygons.length).toBe(brush.faceCount);
    expect(brush.planes.length).toBe(4 * (6 + 4));
  });
});
