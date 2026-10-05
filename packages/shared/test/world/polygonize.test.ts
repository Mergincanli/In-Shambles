import { describe, expect, it } from "vitest";
import { Mulberry32 } from "../../src/rng/mulberry32";
import {
  BrushError,
  type BrushErrorCode,
  type PolygonizedBrush,
  polygonize,
  roundPlanesF32,
} from "../../src/world/polygonize";
import {
  boxPlanes,
  rotatedBoxPlanes,
  type Triple,
  type WedgeRise,
  wedgePlanes,
} from "../../src/world/shapes";
import { tripleIntersectionVertices, vertexList, vertexSetMismatch } from "../helpers/brushOracle";
import { f64ToHex } from "../helpers/f64";

const SQRT2 = Math.sqrt(2);
const SQRT3 = Math.sqrt(3);
const SQRT6 = Math.sqrt(6);

/** Closed forms (D-016: no Math.sin/cos), [degrees, cos, sin]. */
const ANGLES: readonly (readonly [number, number, number])[] = [
  [15, (SQRT6 + SQRT2) / 4, (SQRT6 - SQRT2) / 4],
  [30, SQRT3 / 2, 0.5],
  [45, SQRT2 / 2, SQRT2 / 2],
  [60, 0.5, SQRT3 / 2],
];

/** rise = run·√(1 − nz²)/nz gives a slope whose normal has z = nz. */
function riseFor(run: number, nz: number): number {
  return (run * Math.sqrt(1 - nz * nz)) / nz;
}

function expectSameVertices(brush: PolygonizedBrush, expected: number[][], tol: number): void {
  expect(vertexSetMismatch(vertexList(brush.vertices), expected, tol)).toBeNull();
}

function boxCorners(min: Triple, max: Triple): number[][] {
  const out: number[][] = [];
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
}

function rotatedCorners(center: Triple, half: Triple, c: number, s: number): number[][] {
  const out: number[][] = [];
  for (const a of [-1, 1])
    for (const b of [-1, 1])
      for (const z of [-1, 1]) {
        const u = a * half[0];
        const v = b * half[1];
        out.push([center[0] + u * c - v * s, center[1] + u * s + v * c, center[2] + z * half[2]]);
      }
  return out;
}

function wedgeCorners(min: Triple, max: Triple, rise: WedgeRise): number[][] {
  const axis = rise.endsWith("x") ? 0 : 1;
  const high = rise.startsWith("+") ? max[axis] : min[axis];
  return boxCorners(min, max).filter((p) => p[2] === min[2] || p[axis] === high);
}

/** Structural checks every polygonized brush must pass. */
function expectWellFormed(brush: PolygonizedBrush): void {
  const v = brush.vertices;
  expect(brush.polygons.length).toBe(brush.planes.length / 4);
  brush.polygons.forEach((poly, f) => {
    const [nx = 0, ny = 0, nz = 0, d = 0] = brush.planes.subarray(4 * f, 4 * f + 4);
    expect(poly.length).toBeGreaterThanOrEqual(3);
    let area = 0;
    for (let k = 0; k < poly.length; k++) {
      const a = 3 * (poly[k] ?? 0);
      expect(
        Math.abs(nx * (v[a] ?? 0) + ny * (v[a + 1] ?? 0) + nz * (v[a + 2] ?? 0) - d),
      ).toBeLessThan(1e-6);
      // Canonical start: no vertex is lexicographically smaller than the first.
      const first = 3 * (poly[0] ?? 0);
      const key = (i: number): number[] => [v[i] ?? 0, v[i + 1] ?? 0, v[i + 2] ?? 0];
      const [x0 = 0, y0 = 0, z0 = 0] = key(first);
      const [x = 0, y = 0, z = 0] = key(a);
      expect(x < x0 || (x === x0 && (y < y0 || (y === y0 && z < z0)))).toBe(false);
      if (k >= 1 && k + 1 < poly.length) {
        const b = 3 * (poly[k + 1] ?? 0);
        const e1 = [(v[a] ?? 0) - x0, (v[a + 1] ?? 0) - y0, (v[a + 2] ?? 0) - z0];
        const e2 = [(v[b] ?? 0) - x0, (v[b + 1] ?? 0) - y0, (v[b + 2] ?? 0) - z0];
        const [ax = 0, ay = 0, az = 0] = e1;
        const [bx = 0, by = 0, bz = 0] = e2;
        area += nx * (ay * bz - az * by) + ny * (az * bx - ax * bz) + nz * (ax * by - ay * bx);
      }
    }
    // Counter-clockwise seen from outside: positive area along the outward normal.
    expect(area).toBeGreaterThan(0);
  });
}

function expectMatchesOracle(planes: Float64Array): PolygonizedBrush {
  const brush = polygonize(planes);
  expectWellFormed(brush);
  expectSameVertices(brush, tripleIntersectionVertices(roundPlanesF32(planes)), 1e-6);
  return brush;
}

function expectBrushError(planes: Float64Array, code: BrushErrorCode, text: RegExp): void {
  let caught: unknown;
  try {
    polygonize(planes, "test_brush");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(BrushError);
  expect((caught as BrushError).code).toBe(code);
  expect((caught as BrushError).message).toMatch(/^test_brush: /);
  expect((caught as BrushError).message).toMatch(text);
}

function withPlanes(base: Float64Array, ...extra: number[][]): Float64Array {
  return Float64Array.from([...base, ...extra.flat()]);
}

describe("polygonize: constructor reference vertices", () => {
  // f32 plane rounding moves a vertex by about |p|·6e-8, so the shapes whose planes are not
  // f32-exact stay within ~16 u of the origin to keep that under the 1e-6 tolerance.
  it.each([
    [
      [-8, -4, 0],
      [8, 4, 12],
    ],
    [
      [-1024, -1024, -16],
      [1024, 1024, 0],
    ],
    [
      [100.5, -3.25, 7],
      [101, 20, 7.125],
    ],
  ] as const)("box %j–%j", (min, max) => {
    const brush = polygonize(boxPlanes(min, max));
    expectWellFormed(brush);
    expectSameVertices(brush, boxCorners(min, max), 0);
    expect(brush.polygons.every((p) => p.length === 4)).toBe(true);
  });

  it.each(ANGLES)("box rotated %d° about +Z", (_deg, c, s) => {
    const center: Triple = [0, 0, 4];
    const half: Triple = [8, 4, 6];
    const brush = polygonize(rotatedBoxPlanes(center, half, c, s));
    expectWellFormed(brush);
    expectSameVertices(brush, rotatedCorners(center, half, c, s), 1e-6);
  });

  it.each([0.69, 0.71, 0.8])("wedge with slope normal z = %d", (nz) => {
    const min: Triple = [0, 0, 0];
    const max: Triple = [8, 8, riseFor(8, nz)];
    const brush = polygonize(wedgePlanes(min, max, "+x"));
    expectWellFormed(brush);
    expectSameVertices(brush, wedgeCorners(min, max, "+x"), 1e-6);
    const slope = brush.planes.subarray(16, 20);
    expect(slope[2]).toBe(Math.fround(nz));
  });

  it.each(["+x", "-x", "+y", "-y"] as const)("3-4-5 wedge rising toward %s", (rise) => {
    const min: Triple = [-4, -4, 0];
    const max: Triple = [4, 4, 6];
    const brush = polygonize(wedgePlanes(min, max, rise));
    expectWellFormed(brush);
    expectSameVertices(brush, wedgeCorners(min, max, rise), 1e-6);
    expect(brush.polygons.map((p) => p.length).sort()).toEqual([3, 3, 4, 4, 4]);
  });
});

describe("polygonize: triple-plane-intersection oracle", () => {
  it.each([
    [
      [0, 0, 0],
      [64, 64, 64],
    ],
    [
      [-3072, -3072, -32],
      [3072, 3072, 0],
    ],
    [
      [17.25, -400, 3],
      [18, -399.5, 300],
    ],
  ] as const)("box %j–%j", (min, max) => {
    expectMatchesOracle(boxPlanes(min, max));
  });

  for (const [deg, c, s] of ANGLES) {
    it.each([
      [
        [0, 0, 128],
        [256, 8, 128],
      ],
      [
        [1234.5, -987.25, 64],
        [256, 8, 128],
      ],
      [
        [-6000, 5000, 16],
        [48, 24, 32],
      ],
    ] as const)(`box rotated ${deg}° at %j, half %j`, (center, half) => {
      expectMatchesOracle(rotatedBoxPlanes(center, half, c, s));
    });
  }

  for (const nz of [0.69, 0.71, 0.8]) {
    it.each(["+x", "-x", "+y", "-y"] as const)(`wedge nz = ${nz} rising toward %s`, (rise) => {
      const run = 256;
      const axisX = rise.endsWith("x");
      const min: Triple = [512, -1024, 32];
      const max: Triple = axisX
        ? [512 + run, -896, 32 + riseFor(run, nz)]
        : [640, -1024 + run, 32 + riseFor(run, nz)];
      expectMatchesOracle(wedgePlanes(min, max, rise));
    });
  }

  it("seeded random convex brushes", () => {
    // Random cuts of a 128 u cube; with this seed none leaves an edge under 1/8 u.
    const rng = new Mulberry32(0x5eed);
    for (let i = 0; i < 40; i++) {
      const extra: number[][] = [];
      const cuts = 1 + rng.nextInt(10);
      while (extra.length < cuts) {
        const x = rng.nextFloat() * 2 - 1;
        const y = rng.nextFloat() * 2 - 1;
        const z = rng.nextFloat() * 2 - 1;
        const len = Math.sqrt(x * x + y * y + z * z);
        if (len < 0.2 || len > 1) continue;
        extra.push([x / len, y / len, z / len, 64 * (0.6 + 0.6 * rng.nextFloat())]);
      }
      expectMatchesOracle(withPlanes(boxPlanes([-64, -64, -64], [64, 64, 64]), ...extra));
    }
  });
});

describe("polygonize: redundant planes", () => {
  const box = boxPlanes([-8, -4, 0], [8, 4, 12]);

  it.each([
    ["outside the brush", [1, 0, 0, 100]],
    ["a duplicate of +z", [0, 0, 1, 12]],
    ["touching the +x/+z edge only", [SQRT2 / 2, 0, SQRT2 / 2, 20 / SQRT2]],
    ["touching the (8, 4, 12) corner only", [1 / SQRT3, 1 / SQRT3, 1 / SQRT3, 24 / SQRT3]],
  ])("drops a plane %s", (_name, plane) => {
    const brush = polygonize(withPlanes(box, plane));
    expect([...brush.faceSource]).toEqual([0, 1, 2, 3, 4, 5]);
    expectSameVertices(brush, boxCorners([-8, -4, 0], [8, 4, 12]), 1e-6);
  });

  it("keeps the first of two identical planes and drops the later one", () => {
    const planes = withPlanes(new Float64Array(0), [0, 0, 1, 12], ...rowsOf(box));
    const brush = polygonize(planes);
    expect([...brush.faceSource]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // A cut this shallow leaves vertices within 1e-4 u of the box corners: the cleanup merges them
  // and the weld joins them across faces, so the brush is the plain box.
  it.each([
    ["shaving a corner by 3e-5 u", [0, 0, 0], [64, 64, 64], [1, 1, 1], 192 - 3e-5],
    ["shaving an edge by 5e-5 u", [-8, -4, 0], [8, 4, 12], [1, 0, 1], 20 - 5e-5],
  ] as const)("drops a plane %s", (_name, min, max, n, dot) => {
    const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    const cut = [n[0] / len, n[1] / len, n[2] / len, dot / len];
    const brush = polygonize(withPlanes(boxPlanes(min, max), cut));
    expect([...brush.faceSource]).toEqual([0, 1, 2, 3, 4, 5]);
    expectSameVertices(brush, boxCorners(min, max), 1e-4);
  });

  it("drops a plane grazing the end of an edge and its leftover vertex on the edge", () => {
    // Cuts the +x/+z edge from y = 2 (depth 0) to y = 4 (depth 2e-5 u). The crossing at y = 2 is
    // left on the edge, on only two kept faces, and must go.
    const a = 3e-5 / 2;
    const len = Math.sqrt(2 + a * a);
    const cut = [1 / len, a / len, 1 / len, (20 + 2 * a) / len];
    const brush = polygonize(withPlanes(box, cut));
    expect([...brush.faceSource]).toEqual([0, 1, 2, 3, 4, 5]);
    expectSameVertices(brush, boxCorners([-8, -4, 0], [8, 4, 12]), 1e-4);
  });

  it("rejects an edge shaved by 2e-4 u: the strip face is kept and its ends are too short", () => {
    const cut = [SQRT2 / 2, 0, SQRT2 / 2, (20 - 2e-4) / SQRT2];
    expectBrushError(withPlanes(box, cut), "edge", /under the 0\.015625 u weld distance/);
  });

  it("drops a box face that a cutting plane makes redundant", () => {
    // x + z ≤ 4 (scaled) slices the whole +x face away.
    const brush = polygonize(withPlanes(box, [SQRT2 / 2, 0, SQRT2 / 2, 2 / SQRT2]));
    expect([...brush.faceSource]).not.toContain(1);
    expect([...brush.faceSource]).toContain(6);
    expectMatchesOracle(withPlanes(box, [SQRT2 / 2, 0, SQRT2 / 2, 2 / SQRT2]));
  });
});

function rowsOf(planes: Float64Array): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < planes.length; i += 4) rows.push([...planes.subarray(i, i + 4)]);
  return rows;
}

describe("polygonize: nearly flat creases", () => {
  // The cut drops by `sag` from x = 32 to x = 64 across the top of [0, 64]³. Its crease vertices
  // look collinear on the ±y sides but are real corners of three faces, so they must stay.
  it.each([3e-5, 1e-4, 2e-4, 1e-3])("keeps the crease of a top cut sagging %d u", (sag) => {
    const len = Math.sqrt((sag / 32) * (sag / 32) + 1);
    const n = [sag / 32 / len, 0, 1 / len];
    const cut = [n[0] ?? 0, 0, n[2] ?? 0, ((n[0] ?? 0) * 32 + (n[2] ?? 0) * 64) / 1];
    const brush = expectMatchesOracle(withPlanes(boxPlanes([0, 0, 0], [64, 64, 64]), cut));
    expect(brush.faceSource.length).toBe(7);
    expect(brush.vertices.length / 3).toBe(10);
  });
});

describe("polygonize: degenerate brushes throw", () => {
  /** Pyramid on a rhombus whose left and right base corners are `gap` u apart. */
  function needlePyramid(gap: number): Float64Array {
    const a = [0, 0, 0];
    const b = [gap / 2, 100, 0];
    const c = [gap, 0, 0];
    const d = [gap / 2, -100, 0];
    const apex = [gap / 2, 0, 100];
    const inside = [gap / 2, 0, 10];
    const dot = (n: number[], p: number[]): number =>
      (n[0] ?? 0) * (p[0] ?? 0) + (n[1] ?? 0) * (p[1] ?? 0) + (n[2] ?? 0) * (p[2] ?? 0);
    const planeThrough = (p: number[], q: number[], r: number[]): number[] => {
      const [ux = 0, uy = 0, uz = 0] = [0, 1, 2].map((k) => (q[k] ?? 0) - (p[k] ?? 0));
      const [vx = 0, vy = 0, vz = 0] = [0, 1, 2].map((k) => (r[k] ?? 0) - (p[k] ?? 0));
      const cr = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const len = Math.sqrt(dot(cr, cr));
      // Outward: the inside point must be behind the plane.
      const sign = dot(cr, inside) > dot(cr, p) ? -1 : 1;
      const n = cr.map((x) => (sign * x) / len);
      return [...n, dot(n, p)];
    };
    return Float64Array.from([
      ...planeThrough(a, b, c),
      ...planeThrough(a, b, apex),
      ...planeThrough(b, c, apex),
      ...planeThrough(c, d, apex),
      ...planeThrough(d, a, apex),
    ]);
  }

  it("rejects two vertices closer than the weld distance that share no edge", () => {
    // Every edge is about 100 u long, but the base corners 0.01 u apart would weld into one.
    expectBrushError(needlePyramid(0.01), "vertex", /closer than the 0\.015625 u weld distance/);
    expect(expectMatchesOracle(needlePyramid(0.04)).vertices.length / 3).toBe(5);
  });

  it("rejects planes that leave only 3 faces", () => {
    // Three sides of an endless triangular prism plus a redundant plane far along +x.
    const prism = Float64Array.from([
      ...[0, -1, 0, 0],
      ...[-1, 0, 0, 0],
      ...[SQRT2 / 2, SQRT2 / 2, 0, 10 / SQRT2],
      ...[1, 0, 0, 10000],
    ]);
    expectBrushError(prism, "faces", /only 3 non-redundant faces/);
  });

  it("rejects an open brush (no top)", () => {
    expectBrushError(boxPlanes([0, 0, 0], [64, 64, 64]).subarray(0, 20), "open", /open/);
  });

  it("rejects a zero-thickness brush", () => {
    const flat = withPlanes(
      boxPlanes([0, 0, 0], [64, 64, 64]).subarray(0, 16),
      [0, 0, -1, 0],
      [0, 0, 1, 0],
    );
    expectBrushError(flat, "faces", /enclose no volume/);
  });

  it("rejects contradictory planes", () => {
    const empty = withPlanes(boxPlanes([0, 0, 0], [64, 64, 64]), [1, 0, 0, -1]);
    expectBrushError(empty, "faces", /enclose no volume/);
  });

  it("rejects a brush of 1 u³ or less", () => {
    expectBrushError(boxPlanes([0, 0, 0], [1.5, 1.5, 0.25]), "volume", /volume 0\.5625 u³/);
  });

  it("rejects a sliver edge under 1/8 u", () => {
    const t = 0.0707;
    const cut = withPlanes(boxPlanes([0, 0, 0], [64, 64, 64]), [
      1 / SQRT3,
      1 / SQRT3,
      1 / SQRT3,
      (192 - t) / SQRT3,
    ]);
    expectBrushError(cut, "edge", /shorter than the 0\.125 u minimum/);
    // The same cut at 1/4 u is fine.
    const ok = withPlanes(boxPlanes([0, 0, 0], [64, 64, 64]), [
      1 / SQRT3,
      1 / SQRT3,
      1 / SQRT3,
      (192 - 0.25) / SQRT3,
    ]);
    expect(expectMatchesOracle(ok).vertices.length / 3).toBe(10);
  });

  it("rejects a brush of exactly 1 u³", () => {
    expectBrushError(boxPlanes([0, 0, 0], [1, 1, 1]), "volume", /volume 1 u³/);
  });

  it.each([
    ["just past", [16000, 0, 0], [16400, 64, 64], /vertex .* outside the ±16384 u world limit/],
    ["beyond the starting squares", [1e5, 1e5, 1e5], [1e5 + 10, 1e5 + 10, 1e5 + 10], /plane 0/],
    ["far along one axis", [0, 0, 0], [1e30, 10, 10], /plane 1 .* too far/],
  ] as const)("rejects a brush %s the ±16384 u world limit", (_name, min, max, text) => {
    expectBrushError(boxPlanes(min, max), "limit", text);
  });

  it("accepts a brush that touches the world limit", () => {
    const min: Triple = [16320, -16384, 0];
    const max: Triple = [16384, -16320, 64];
    expectSameVertices(polygonize(boxPlanes(min, max)), boxCorners(min, max), 0);
  });

  it.each([
    ["fewer than 4 planes", boxPlanes([0, 0, 0], [1, 1, 1]).subarray(0, 12), /3 planes/],
    ["a ragged plane array", boxPlanes([0, 0, 0], [8, 8, 8]).subarray(0, 23), /not 4·n/],
    [
      "a non-finite value",
      withPlanes(boxPlanes([0, 0, 0], [8, 8, 8]), [0, 0, 1, Number.NaN]),
      /plane 6 has a non-finite value/,
    ],
    [
      "a non-unit normal",
      withPlanes(boxPlanes([0, 0, 0], [8, 8, 8]), [0, 0, 2, 8]),
      /plane 6 normal is not unit length/,
    ],
  ])("rejects %s", (_name, planes, text) => {
    expectBrushError(planes, "input", text);
  });
});

describe("polygonize: f32 rounding comes first", () => {
  it("returns the f32-rounded kept planes", () => {
    const planes = rotatedBoxPlanes(
      [10.1, -3.7, 5],
      [8, 4, 2],
      ANGLES[0]?.[1] ?? 0,
      ANGLES[0]?.[2] ?? 0,
    );
    const brush = polygonize(planes);
    expect([...brush.planes]).toEqual([...planes].map((v) => Math.fround(v)));
    expect([...brush.planes]).not.toEqual([...planes]);
  });

  it("derives vertices from the rounded planes, bit for bit", () => {
    const planes = rotatedBoxPlanes([10.1, -3.7, 5], [8, 4, 2], ANGLES[1]?.[1] ?? 0, 0.5);
    const a = polygonize(planes);
    const b = polygonize(roundPlanesF32(planes));
    expect([...a.vertices].map(f64ToHex)).toEqual([...b.vertices].map(f64ToHex));
  });

  it("moves a vertex to the rounded distance", () => {
    const brush = polygonize(boxPlanes([0, 0, 0], [0.3, 8, 64 + 1e-9]));
    const xs = new Set<number>();
    for (let i = 0; i < brush.vertices.length; i += 3) {
      xs.add(brush.vertices[i] ?? 0);
      expect([0, 64]).toContain(brush.vertices[i + 2]);
    }
    const maxX = Math.max(...xs);
    expect(Math.abs(maxX - Math.fround(0.3))).toBeLessThan(1e-12);
    expect(Math.abs(maxX - 0.3)).toBeGreaterThan(1e-9);
  });

  it("turns −0 plane components into +0", () => {
    const planes = boxPlanes([0, 0, 0], [8, 8, 8]);
    for (const i of [1, 2, 4 + 1, 4 + 2]) planes[i] = -0;
    const brush = polygonize(planes);
    for (const v of brush.planes) expect(Object.is(v, -0)).toBe(false);
    for (const v of brush.vertices) expect(Object.is(v, -0)).toBe(false);
  });

  it("puts vertices exactly on axial faces listed after oblique ones", () => {
    // The oblique planes come first, so the weld keeps their interpolated copies of the vertices
    // on the axial faces; those must still land exactly on the axial planes.
    const rng = new Mulberry32(0xa11a);
    for (let i = 0; i < 200; i++) {
      const c: Triple = [
        (rng.nextFloat() - 0.5) * 20000,
        (rng.nextFloat() - 0.5) * 20000,
        (rng.nextFloat() - 0.5) * 20000,
      ];
      const rx = rng.nextFloat() - 0.5;
      const ry = rng.nextFloat() - 0.5;
      const len = Math.sqrt(rx * rx + ry * ry);
      const half: Triple = [
        1 + rng.nextFloat() * 300,
        1 + rng.nextFloat() * 300,
        1 + rng.nextFloat() * 300,
      ];
      const brush = polygonize(rotatedBoxPlanes(c, half, rx / len, ry / len));
      const zs = new Set<number>();
      for (let k = 2; k < brush.vertices.length; k += 3) zs.add(brush.vertices[k] ?? 0);
      expect([...zs].sort((a, b) => a - b)).toEqual([
        -(brush.planes[19] ?? 0) + 0,
        brush.planes[23],
      ]);
    }
  });

  it("is deterministic", () => {
    const planes = wedgePlanes([3.3, -7.1, 0], [300, 64, riseFor(296.7, 0.71)], "+x");
    const a = polygonize(planes);
    const b = polygonize(planes);
    expect([...a.vertices].map(f64ToHex)).toEqual([...b.vertices].map(f64ToHex));
    expect(a.polygons.map((p) => [...p])).toEqual(b.polygons.map((p) => [...p]));
  });
});
