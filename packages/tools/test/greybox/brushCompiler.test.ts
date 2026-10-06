import {
  boxPlanes,
  buildBrush,
  CMAP_VERTEX_FLOATS,
  CONTENTS_LADDER,
  CONTENTS_NODRAW,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  CONTENTS_TRIGGER,
  CONTENTS_WATER,
  FOOTSTEP_METAL,
  rotatedBoxPlanes,
  SURF_LADDER,
  surfaceWithFootstep,
  type Triple,
  type WedgeRise,
  wedgePlanes,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  assembleBrushes,
  type CompiledGeometry,
  checkNoEdgeBevelsNeeded,
  compileBrush,
  compileBrushes,
  GREYBOX_UV_UNITS,
  type GreyboxBrush,
  GreyboxError,
  isRenderedContents,
  uvProjectionAxis,
} from "../../src/greybox/brushCompiler";

// M1 design B and F: the greybox compiler builds brushes, refuses shapes that would need edge
// bevels, and emits render surfaces that agree with the collision planes.

const SQRT2 = Math.sqrt(2);
const SQRT3 = Math.sqrt(3);
const SQRT6 = Math.sqrt(6);
/** [cos, sin] of 15°, 30°, 45°, 60°, in closed form (D-016: no Math.cos). */
const ANGLES: readonly (readonly [string, number, number])[] = [
  ["15°", (SQRT6 + SQRT2) / 4, (SQRT6 - SQRT2) / 4],
  ["30°", SQRT3 / 2, 0.5],
  ["45°", SQRT2 / 2, SQRT2 / 2],
  ["60°", 0.5, SQRT3 / 2],
  ["-30°", SQRT3 / 2, -0.5],
];

function brush(
  planes: Float64Array,
  contents = CONTENTS_SOLID,
  material = "grey/floor",
  surfaceFlags = 0,
  label = "test brush",
): GreyboxBrush {
  const count = planes.length / 4;
  return {
    label,
    planes,
    contents,
    materials: Array.from({ length: count }, () => material),
    surfaceFlags: Array.from({ length: count }, () => surfaceFlags),
  };
}

/** Wedge planes turned about +Z through the origin: an off-axis ramp. */
function rotatedWedge(min: Triple, max: Triple, rise: WedgeRise, c: number, s: number) {
  const planes = wedgePlanes(min, max, rise);
  for (let i = 0; i < planes.length; i += 4) {
    const nx = planes[i] ?? 0;
    const ny = planes[i + 1] ?? 0;
    planes[i] = c * nx - s * ny;
    planes[i + 1] = s * nx + c * ny;
  }
  return planes;
}

const EXACT_SHAPES: [string, Float64Array][] = [
  ["box", boxPlanes([-64, -32, 0], [64, 32, 128])],
  ["thin floor", boxPlanes([-3072, -3072, -16], [3072, 3072, 0])],
  ...ANGLES.map(([name, c, s]): [string, Float64Array] => [
    `box rotated ${name} about Z`,
    rotatedBoxPlanes([100, -40, 128], [256, 8, 128], c, s),
  ]),
  ...(["+x", "-x", "+y", "-y"] as const).map((rise): [string, Float64Array] => [
    `wedge rising ${rise}`,
    wedgePlanes([0, 0, 0], [256, 128, 96], rise),
  ]),
  ["steep wedge", wedgePlanes([-16, -16, 0], [16, 16, 300], "+y")],
  ["shallow wedge", wedgePlanes([0, 0, 0], [1024, 64, 3], "-x")],
];

describe("edge-bevel exactness check", () => {
  it.each(EXACT_SHAPES)("accepts a %s", (_name, planes) => {
    expect(() => checkNoEdgeBevelsNeeded(buildBrush(planes), "ok")).not.toThrow();
    expect(() => compileBrush(brush(planes))).not.toThrow();
  });

  it.each([
    ["ramp turned 30° about Z", rotatedWedge([0, -64, 0], [256, 64, 96], "+x", SQRT3 / 2, 0.5)],
    [
      "ramp turned 45° about Z",
      rotatedWedge([0, -64, 0], [256, 64, 96], "+y", SQRT2 / 2, SQRT2 / 2),
    ],
    [
      "tetrahedron",
      Float64Array.of(
        0,
        0,
        -1,
        0,
        -1,
        0,
        0,
        0,
        0,
        -1,
        0,
        0,
        1 / SQRT3,
        1 / SQRT3,
        1 / SQRT3,
        64 / SQRT3,
      ),
    ],
    // A cube cut by three diagonal planes. One edge × y gives (−√½, 0, −√½), and only the face
    // (√½, 0, √½) is parallel to it: pointing the other way, it does not cover the direction.
    [
      "cut cube whose only parallel face points the wrong way",
      (() => {
        const h = Math.SQRT1_2;
        const planes = new Float64Array(36);
        planes.set(boxPlanes([-64, -64, -64], [64, 64, 64]));
        planes.set([-h, h, 0, 54, h, 0, h, 62, 0, -h, -h, 32], 24);
        return planes;
      })(),
    ],
    // Barely off-axis: the stray component is about 3e-5, well past the 1e-6 tolerance.
    [
      "ramp turned by sin 1e-5 about Z",
      rotatedWedge([0, -64, 0], [256, 64, 96], "+x", Math.sqrt(1 - 1e-10), 1e-5),
    ],
  ])("rejects a %s, naming the brush", (_name, planes) => {
    expect(() => checkNoEdgeBevelsNeeded(buildBrush(planes), "lab brush 7")).toThrow(
      /^lab brush 7: needs edge bevels \(M5\)/,
    );
    let error: unknown;
    try {
      compileBrush(brush(planes, CONTENTS_SOLID, "grey/floor", 0, "lab brush 9 (ramp)"));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GreyboxError);
    expect(String(error)).toContain("lab brush 9 (ramp): needs edge bevels (M5)");
  });
});

describe("compileBrush", () => {
  it("keeps per-face data of the faces buildBrush keeps", () => {
    // A seventh plane outside the box is redundant and dropped with its material.
    const planes = new Float64Array(28);
    planes.set(boxPlanes([0, 0, 0], [64, 64, 64]));
    planes.set([1, 0, 0, 512], 24);
    const materials = ["m/a", "m/b", "m/c", "m/d", "m/e", "m/f", "m/unused"];
    const flags = [0, SURF_LADDER, 0, 0, 0, surfaceWithFootstep(0, FOOTSTEP_METAL), SURF_LADDER];
    const c = compileBrush({
      label: "b",
      planes,
      contents: CONTENTS_SOLID,
      materials,
      surfaceFlags: flags,
    });
    expect(c.built.faceCount).toBe(6);
    expect(c.faceMaterials).toEqual(materials.slice(0, 6));
    expect(c.faceSurfaceFlags).toEqual(flags.slice(0, 6));
  });

  it.each<[{ contents?: number; material?: string; surfaceFlags?: number }, RegExp]>([
    [{ contents: 0 }, /contents 0 must be/],
    [{ contents: 0x100 }, /contents 256 must be/],
    [{ contents: 1.5 }, /contents 1.5 must be/],
    [{ surfaceFlags: -1 }, /surface flags -1 are not known/],
    [{ surfaceFlags: 0.5 }, /surface flags 0.5 are not known/],
    [{ material: "Grey Floor" }, /material "Grey Floor" is not a snake_case path/],
    [{ material: "" }, /material "" is not/],
    [{ surfaceFlags: 1 << 20 }, /surface flags 1048576 are not known/],
    [{ surfaceFlags: surfaceWithFootstep(0, 15) }, /surface flags 3840 are not known/],
  ])("refuses %j", (bad, message) => {
    const b = brush(
      boxPlanes([0, 0, 0], [8, 8, 8]),
      bad.contents ?? CONTENTS_SOLID,
      bad.material ?? "grey/floor",
      bad.surfaceFlags ?? 0,
      "bad brush",
    );
    expect(() => compileBrush(b)).toThrow(GreyboxError);
    expect(() => compileBrush(b)).toThrow(message);
  });

  it("refuses per-plane lists of the wrong length", () => {
    const b = { ...brush(boxPlanes([0, 0, 0], [8, 8, 8])), materials: ["grey/floor"] };
    expect(() => compileBrush(b)).toThrow(/1 materials and 6 surface flags for 6 planes/);
  });

  it("lets buildBrush errors name the brush", () => {
    const b = brush(
      boxPlanes([0, 0, 0], [20000, 8, 8]),
      CONTENTS_SOLID,
      "grey/floor",
      0,
      "far brush",
    );
    expect(() => compileBrush(b)).toThrow(/^far brush: /);
  });
});

describe("rendered contents", () => {
  it.each([
    [CONTENTS_SOLID, true],
    [CONTENTS_SOLID | CONTENTS_LADDER, true],
    [CONTENTS_WATER, true],
    [CONTENTS_LADDER, false],
    [CONTENTS_PLAYERCLIP, false],
    [CONTENTS_SOLID | CONTENTS_PLAYERCLIP, false],
    [CONTENTS_TRIGGER, false],
    [CONTENTS_NODRAW, false],
    [CONTENTS_SOLID | CONTENTS_NODRAW, false],
  ])("contents %i renders: %s", (contents, rendered) => {
    expect(isRenderedContents(contents)).toBe(rendered);
  });
});

/** A mixed scene: floor, rotated wall, wedge, water, clip, ladder volume, trigger. */
function scene(): GreyboxBrush[] {
  return [
    brush(boxPlanes([-512, -512, -16], [512, 512, 0]), CONTENTS_SOLID, "grey/floor"),
    brush(
      rotatedBoxPlanes([0, 200, 128], [256, 8, 128], SQRT3 / 2, 0.5),
      CONTENTS_SOLID,
      "grey/wall",
    ),
    brush(wedgePlanes([64, -128, 0], [320, 0, 96], "+x"), CONTENTS_SOLID, "grey/floor"),
    brush(boxPlanes([-400, -400, -128], [-200, -200, 0]), CONTENTS_WATER, "grey/water"),
    brush(boxPlanes([400, 400, 0], [512, 512, 256]), CONTENTS_PLAYERCLIP, "tool/clip"),
    brush(boxPlanes([-64, 300, 0], [64, 316, 256]), CONTENTS_LADDER, "tool/ladder"),
    brush(boxPlanes([-32, -32, 0], [32, 32, 64]), CONTENTS_TRIGGER, "tool/trigger"),
    brush(wedgePlanes([-300, 64, 0], [-100, 128, 64], "-y"), CONTENTS_SOLID, "grey/wall"),
  ];
}

function vertexAt(g: CompiledGeometry, v: number, k: number): number {
  return g.vertices[CMAP_VERTEX_FLOATS * v + k] ?? Number.NaN;
}

describe("assembleBrushes", () => {
  const brushes = scene();
  const compiled = brushes.map(compileBrush);
  const g = assembleBrushes(compiled);

  it("lists materials in order of first use", () => {
    expect(g.materials).toEqual([
      "grey/floor",
      "grey/wall",
      "grey/water",
      "tool/clip",
      "tool/ladder",
      "tool/trigger",
    ]);
    expect(compileBrushes([...brushes].reverse()).materials).toEqual([
      "grey/wall",
      "tool/trigger",
      "tool/ladder",
      "tool/clip",
      "grey/water",
      "grey/floor",
    ]);
  });

  it("lays planes out brush by brush, faces then bevels, with bevel extents as bounds", () => {
    let plane = 0;
    compiled.forEach((c, i) => {
      const count = c.built.planes.length / 4;
      expect(g.brushes.firstPlane[i]).toBe(plane);
      expect(g.brushes.planeCount[i]).toBe(count);
      expect(g.brushes.faceCount[i]).toBe(c.built.faceCount);
      expect(g.brushes.contents[i]).toBe(brushes[i]?.contents);
      expect([...g.planes.subarray(4 * plane, 4 * (plane + count))]).toEqual([...c.built.planes]);
      expect([...g.brushes.bounds.subarray(6 * i, 6 * i + 6)]).toEqual([...c.built.bounds]);
      for (let p = 0; p < count; p++) {
        const face = p < c.built.faceCount;
        expect(g.planeMaterial[plane + p]).toBe(
          face ? g.materials.indexOf(c.faceMaterials[p] ?? "") : -1,
        );
      }
      plane += count;
    });
    expect(g.planes.length / 4).toBe(plane);
    // The rotated wall's half-diagonal pokes past the floor in y; the water goes deepest.
    expect(g.bounds.mins[2]).toBe(-128);
    expect(g.bounds.maxs[2]).toBe(256);
    expect(g.bounds.mins[0]).toBe(-512);
  });

  it("renders solid and water faces only, one surface per material in material order", () => {
    expect([...g.surfaces.material].map((m) => g.materials[m])).toEqual([
      "grey/floor",
      "grey/wall",
      "grey/water",
    ]);
    // Floor box (6 quads) + wedge (2 triangles, 3 quads); rotated box (6 quads) + wedge (5 faces).
    expect([...g.surfaces.vertexCount]).toEqual([6 * 4 + 2 * 3 + 3 * 4, 6 * 4 + 2 * 3 + 3 * 4, 24]);
    expect([...g.surfaces.indexCount]).toEqual([3 * (12 + 2 + 6), 3 * (12 + 2 + 6), 36]);
    expect([...g.surfaces.firstVertex]).toEqual([0, 42, 84]);
    expect([...g.surfaces.firstIndex]).toEqual([0, 60, 120]);
    expect(g.vertices.length).toBe(CMAP_VERTEX_FLOATS * 108);
    expect(g.indices.length).toBe(156);
  });

  it("fans each face counter-clockwise from outside, on its plane, with unit normals", () => {
    for (let s = 0; s < g.surfaces.material.length; s++) {
      const fv = g.surfaces.firstVertex[s] ?? 0;
      const fi = g.surfaces.firstIndex[s] ?? 0;
      const count = g.surfaces.indexCount[s] ?? 0;
      for (let t = fi; t < fi + count; t += 3) {
        const [a = 0, b = 0, c = 0] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]].map(
          (i) => fv + (i ?? 0),
        );
        const n = [0, 1, 2].map((k) => vertexAt(g, a, 3 + k));
        for (const v of [b, c]) {
          expect([0, 1, 2].map((k) => vertexAt(g, v, 3 + k))).toEqual(n);
        }
        const [nx = 0, ny = 0, nz = 0] = n;
        expect(Math.abs(Math.sqrt(nx * nx + ny * ny + nz * nz) - 1)).toBeLessThan(2e-7);
        const e1 = [0, 1, 2].map((k) => vertexAt(g, b, k) - vertexAt(g, a, k));
        const e2 = [0, 1, 2].map((k) => vertexAt(g, c, k) - vertexAt(g, a, k));
        const [x1 = 0, y1 = 0, z1 = 0] = e1;
        const [x2 = 0, y2 = 0, z2 = 0] = e2;
        const cross = [y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2];
        expect(nx * (cross[0] ?? 0) + ny * (cross[1] ?? 0) + nz * (cross[2] ?? 0)).toBeGreaterThan(
          0,
        );
      }
    }
    // Every vertex lies on the plane of the brush face whose normal it carries.
    let checked = 0;
    for (let v = 0; v < g.vertices.length / CMAP_VERTEX_FLOATS; v++) {
      const p = [0, 1, 2].map((k) => vertexAt(g, v, k));
      const n = [3, 4, 5].map((k) => vertexAt(g, v, k));
      let best = Number.POSITIVE_INFINITY;
      for (let q = 0; q < g.planes.length; q += 4) {
        if (g.planes[q] !== n[0] || g.planes[q + 1] !== n[1] || g.planes[q + 2] !== n[2]) continue;
        const dist =
          (n[0] ?? 0) * (p[0] ?? 0) + (n[1] ?? 0) * (p[1] ?? 0) + (n[2] ?? 0) * (p[2] ?? 0);
        best = Math.min(best, Math.abs(dist - (g.planes[q + 3] ?? 0)));
      }
      expect(best).toBeLessThan(1e-4);
      checked++;
    }
    expect(checked).toBe(108);
  });

  it("stores f32 positions and projects uv0 on the dominant axis at 1 uv per 64 u", () => {
    expect(GREYBOX_UV_UNITS).toBe(64);
    for (let v = 0; v < g.vertices.length / CMAP_VERTEX_FLOATS; v++) {
      const [x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0, u = 0, w = 0] = g.vertices.subarray(
        CMAP_VERTEX_FLOATS * v,
        CMAP_VERTEX_FLOATS * (v + 1),
      );
      const axis = uvProjectionAxis(nx, ny, nz);
      const expected =
        axis === 2 ? [x / 64, y / 64] : axis === 0 ? [y / 64, z / 64] : [x / 64, z / 64];
      expect([u, w]).toEqual(expected);
    }
  });

  it("picks the projection axis by the largest normal component, ties to z then x", () => {
    expect(uvProjectionAxis(0, 0, 1)).toBe(2);
    expect(uvProjectionAxis(0, 0, -1)).toBe(2);
    expect(uvProjectionAxis(-1, 0, 0)).toBe(0);
    expect(uvProjectionAxis(0, 1, 0)).toBe(1);
    expect(uvProjectionAxis(0.6, 0, 0.8)).toBe(2);
    expect(uvProjectionAxis(0, -0.8, 0.6)).toBe(1);
    expect(uvProjectionAxis(SQRT2 / 2, 0, SQRT2 / 2)).toBe(2);
    expect(uvProjectionAxis(SQRT2 / 2, -SQRT2 / 2, 0)).toBe(0);
  });

  it("writes an axis-aligned floor exactly", () => {
    const floor = compileBrushes([brush(boxPlanes([-128, -64, -16], [128, 64, 0]))]);
    // The +z face (plane 5) is a quad from the polygon's smallest vertex, counter-clockwise.
    const top: number[][] = [];
    for (let v = 0; v < floor.vertices.length / CMAP_VERTEX_FLOATS; v++) {
      if (vertexAt(floor, v, 5) === 1) {
        top.push([0, 1, 2, 6, 7].map((k) => vertexAt(floor, v, k)));
      }
    }
    expect(top).toEqual([
      [-128, -64, 0, -2, -1],
      [128, -64, 0, 2, -1],
      [128, 64, 0, 2, 1],
      [-128, 64, 0, -2, 1],
    ]);
  });

  it("is deterministic", () => {
    const again = compileBrushes(scene());
    expect(again).toEqual(g);
  });

  it("refuses an empty map", () => {
    expect(() => assembleBrushes([])).toThrow(/at least one brush/);
  });
});
