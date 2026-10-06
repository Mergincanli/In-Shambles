import {
  boxPlanes,
  buildCollisionWorld,
  type Cmap,
  CONTENTS_LADDER,
  CONTENTS_NODRAW,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  CONTENTS_TRIGGER,
  CONTENTS_WATER,
  decodeCmap,
  FOOTSTEP_WOOD,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  pointContents,
  positionTest,
  rotatedBoxPlanes,
  roundPlanesF32,
  SURF_LADDER,
  SURF_SLICK,
  surfaceWithFootstep,
  TRACE_EPSILON,
  TraceResult,
  traceBox,
  traceRay,
  vec3,
  wedgePlanes,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  GREYBOX_COMPILER_NAME,
  GREYBOX_COMPILER_VERSION,
  GreyboxError,
} from "../../src/greybox/brushCompiler";
import { encodeCmap } from "../../src/greybox/cmapEncode";
import {
  MATERIAL_CLIP,
  MATERIAL_FLOOR,
  MATERIAL_LADDER,
  MATERIAL_LADDER_FACE,
  MATERIAL_TRIGGER,
  MATERIAL_WALL,
  MATERIAL_WATER,
  MapBuilder,
} from "../../src/greybox/MapBuilder";

// docs/07 §3 and M1 design I: each primitive makes the planes it promises, compiles are
// deterministic, and a compiled map traces as built.

/** Brush i's face planes, as f64 numbers. */
function faces(cmap: Cmap, i: number): number[] {
  const first = cmap.brushes.firstPlane[i] ?? 0;
  const count = cmap.brushes.faceCount[i] ?? 0;
  return [...cmap.planes.subarray(4 * first, 4 * (first + count))];
}

function bounds(cmap: Cmap, i: number): number[] {
  return [...cmap.brushes.bounds.subarray(6 * i, 6 * i + 6)];
}

function faceMaterials(cmap: Cmap, i: number): string[] {
  const first = cmap.brushes.firstPlane[i] ?? 0;
  const count = cmap.brushes.faceCount[i] ?? 0;
  return [...cmap.planeMaterial.subarray(first, first + count)].map(
    (m) => cmap.materials[m] ?? "?",
  );
}

function faceFlags(cmap: Cmap, i: number): number[] {
  const first = cmap.brushes.firstPlane[i] ?? 0;
  const count = cmap.brushes.faceCount[i] ?? 0;
  return [...cmap.planeSurfaceFlags.subarray(first, first + count)];
}

/** A map whose first brush is a floor, so compile() has something to bound. */
function lab(): MapBuilder {
  return new MapBuilder("unit_lab");
}

describe("MapBuilder primitives", () => {
  it("box: six axis planes, its own bounds, floor grey by default", () => {
    const m = lab();
    expect(m.box({ min: [-1024, -1024, -16], max: [1024, 1024, 0] })).toBe(0);
    expect(
      m.box({ min: [0, 0, 0], max: [8, 8, 8], material: "grey/crate", surfaceFlags: SURF_SLICK }),
    ).toBe(1);
    const cmap = m.compile();
    expect(faces(cmap, 0)).toEqual([...boxPlanes([-1024, -1024, -16], [1024, 1024, 0])]);
    expect(cmap.brushes.planeCount[0]).toBe(6);
    expect(bounds(cmap, 0)).toEqual([-1024, -1024, -16, 1024, 1024, 0]);
    expect(cmap.brushes.contents[0]).toBe(CONTENTS_SOLID);
    expect(faceMaterials(cmap, 0)).toEqual(Array(6).fill(MATERIAL_FLOOR));
    expect(faceMaterials(cmap, 1)).toEqual(Array(6).fill("grey/crate"));
    expect(faceFlags(cmap, 1)).toEqual(Array(6).fill(SURF_SLICK));
    expect(cmap.bounds).toEqual({ mins: [-1024, -1024, -16], maxs: [1024, 1024, 8] });
  });

  it("box: contents choose the default material", () => {
    const m = lab();
    m.box({ min: [0, 0, 0], max: [8, 8, 8], contents: CONTENTS_PLAYERCLIP });
    m.box({ min: [0, 0, 0], max: [8, 8, 8], contents: CONTENTS_NODRAW | CONTENTS_SOLID });
    const cmap = m.compile();
    expect(cmap.materials).toEqual([MATERIAL_CLIP, "tool/nodraw"]);
    expect(cmap.surfaces.material.length).toBe(0);
  });

  it("stairs: one column per step, climbing the chosen way", () => {
    const m = lab();
    const top = m.stairs({
      origin: [256, 0, 0],
      steps: 6,
      stepHeight: 16,
      stepDepth: 24,
      width: 128,
    });
    expect(top).toBe(96);
    const cmap = m.compile();
    expect(cmap.brushes.firstPlane.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      expect(bounds(cmap, i)).toEqual([256 + 24 * i, -64, 0, 256 + 24 * (i + 1), 64, 16 * (i + 1)]);
    }
    const down = lab();
    expect(
      down.stairs({
        origin: [0, 0, 32],
        steps: 3,
        stepHeight: 18,
        stepDepth: 32,
        width: 64,
        direction: "-y",
      }),
    ).toBe(86);
    const d = down.compile();
    expect(bounds(d, 0)).toEqual([-32, -32, 32, 32, 0, 50]);
    expect(bounds(d, 2)).toEqual([-32, -96, 32, 32, -64, 86]);
    expect(faceMaterials(d, 1)).toEqual(Array(6).fill(MATERIAL_FLOOR));
  });

  it("stairs that fail part-way, and ladders that fail, add none of their brushes", () => {
    const m = lab();
    m.box({ min: [0, 0, -16], max: [64, 64, 0] });
    // Step 3 reaches past the world limit.
    expect(() =>
      m.stairs({
        origin: [16300, 0, 0],
        steps: 6,
        stepHeight: 16,
        stepDepth: 24,
        width: 64,
      }),
    ).toThrow(/^unit_lab brush 4 \(stairs step 3\): .*world limit/);
    expect(m.brushCount).toBe(1);
    expect(() =>
      m.ladder({ wallMin: [16000, 0, 0], wallMax: [16390, 64, 64], face: "+x" }),
    ).toThrow(/^unit_lab brush 1 \(ladder wall\): /);
    expect(m.brushCount).toBe(1);
    expect(m.compile().brushes.contents.length).toBe(1);
  });

  it("ramp: an axis-aligned wedge rising toward the higher end", () => {
    const m = lab();
    expect(m.ramp({ from: [512, -128, 0], to: [768, -128, 96], width: 128 })).toBe(96);
    // Reversed and along y: it rises toward `from`.
    expect(m.ramp({ from: [0, 300, 64], to: [0, 100, 0], width: 32 })).toBe(64);
    const cmap = m.compile();
    expect(faces(cmap, 0)).toEqual([
      ...roundPlanesF32(wedgePlanes([512, -192, 0], [768, -64, 96], "+x")),
    ]);
    // The +z bevel sits over the f32 slope's crest, rounded outward: within an f32 step of 96.
    const b = bounds(cmap, 0);
    expect(b.slice(0, 5)).toEqual([512, -192, 0, 768, -64]);
    expect(b[5]).toBeGreaterThanOrEqual(96);
    expect(b[5]).toBeLessThan(96 + 1e-5);
    expect(faces(cmap, 1)).toEqual([
      ...roundPlanesF32(wedgePlanes([-16, 100, 0], [16, 300, 64], "+y")),
    ]);
    // The slope normal points up and away from the high side.
    const slope = faces(cmap, 1).slice(16, 20);
    expect(slope[1]).toBeLessThan(0);
    expect(slope[2]).toBeGreaterThan(0);
    expect(faceMaterials(cmap, 0)).toEqual(Array(5).fill(MATERIAL_FLOOR));
  });

  it.each([
    ["-x", [768, 0, 0], [512, 0, 96], [512, -64, 0], [768, 64, 96], 0, 1],
    ["-y", [0, 400, 0], [0, 100, 96], [-64, 100, 0], [64, 400, 96], 1, 1],
    ["+y, given high end first", [0, 400, 96], [0, 100, 0], [-64, 100, 0], [64, 400, 96], 1, -1],
  ] as const)("ramp climbing %s", (rise, from, to, min, max, axis, sign) => {
    const m = lab();
    expect(m.ramp({ from, to, width: 128 })).toBe(96);
    const planes = faces(m.compile(), 0);
    const expected = wedgePlanes(min, max, rise.slice(0, 2) as "-x" | "-y" | "+y");
    expect(planes).toEqual([...roundPlanesF32(expected)]);
    // Up and away from the high side, which is on the `sign` side along `axis`.
    expect(Math.sign(planes[16 + axis] ?? 0)).toBe(sign);
  });

  it.each([
    [
      { from: [0, 0, 0], to: [256, 64, 96] },
      /not aligned to an axis; off-axis ramps need edge bevels \(M5\)/,
    ],
    [{ from: [0, 0, 0], to: [0, 0, 96] }, /need a horizontal run/],
    [{ from: [0, 0, 0], to: [256, 0, 0] }, /level; use box/],
  ] as const)("ramp refuses %j", (ends, message) => {
    expect(() => lab().ramp({ ...ends, width: 64 })).toThrow(GreyboxError);
    expect(() => lab().ramp({ ...ends, width: 64 })).toThrow(message);
  });

  it.each([0.69, 0.71, 0.8])("slope: normal z %f is exact after f32 rounding", (target) => {
    for (const direction of ["+x", "-x", "+y", "-y"] as const) {
      const m = lab();
      const topZ = m.slope({ from: [0, 0, 16], run: 256, normalZ: target, width: 128, direction });
      const cmap = m.compile();
      const planes = faces(cmap, 0);
      const nz = planes[planes.length - 2] ?? 0;
      expect(nz).toBe(Math.fround(target));
      expect(nz > 0.7).toBe(target > 0.7);
      // The slope climbs `direction`: its normal leans the other way.
      const axis = direction[1] === "x" ? 0 : 1;
      const horizontal = planes[planes.length - 4 + axis] ?? 0;
      expect(Math.sign(horizontal)).toBe(direction[0] === "+" ? -1 : 1);
      expect(planes[planes.length - 3 - axis]).toBe(0);
      // topZ is the compiled top, within f32 rounding of from z + rise.
      const b = bounds(cmap, 0);
      expect(topZ).toBe(b[5]);
      expect(Math.abs(topZ - (16 + (256 * Math.sqrt(1 - target * target)) / target))).toBeLessThan(
        1e-4,
      );
      const low = direction[0] === "+" ? 0 : -256;
      const expectedMin = axis === 0 ? [low, -64, 16] : [-64, low, 16];
      const expectedMax = axis === 0 ? [low + 256, 64] : [64, low + 256];
      expect(b.slice(0, 5)).toEqual([...expectedMin, ...expectedMax]);
      expect(faceMaterials(cmap, 0)).toEqual(Array(5).fill(MATERIAL_FLOOR));
    }
    // 0.8 is a 3-4-5 triangle: rise = 3/4 run, to f32 precision (0.8² isn't exact in binary).
    const top = lab().slope({ from: [0, 0, 0], run: 256, normalZ: 0.8, width: 64 });
    expect(Math.abs(top - 192)).toBeLessThanOrEqual(2 ** -16);
  });

  it.each([
    ["+x", [0, 0, 0], 300, 0.71],
    ["-x", [0, 0, 0], 300, 0.71],
    ["+y", [0, 0, 0], 300, 0.71],
    ["-y", [0, 0, 0], 300, 0.71],
    // Far from the origin, from z + rise sits f32 steps below the compiled crest.
    ["+x", [8000, 0, 0], 3000, 0.71],
    ["-y", [0, -2000, 1000], 2400, 0.55],
  ] as const)(
    "slope %s from %j: a platform at topZ meets the crest",
    (direction, from, run, nz) => {
      const m = lab();
      const topZ = m.slope({ from, run, normalZ: nz, width: 128, direction });
      const axis = direction[1] === "x" ? 0 : 1;
      const sign = direction[0] === "+" ? 1 : -1;
      const crest = from[axis] + sign * run;
      const min: [number, number, number] = [from[0] - 64, from[1] - 64, from[2]];
      const max: [number, number, number] = [from[0] + 64, from[1] + 64, topZ];
      min[axis] = sign > 0 ? crest : crest - 300;
      max[axis] = sign > 0 ? crest + 300 : crest;
      m.box({ min, max });
      const cmap = m.compile();
      // The platform shares the slope's top exactly.
      expect(bounds(cmap, 1)[5]).toBe(bounds(cmap, 0)[5]);
      const world = buildCollisionWorld(cmap);
      const tr = new TraceResult();
      const hitZ = (along: number) => {
        const p: number[] = [from[0], from[1]];
        p[axis] = along;
        traceRay(
          world,
          vec3(p[0] ?? 0, p[1] ?? 0, topZ + 100),
          vec3(p[0] ?? 0, p[1] ?? 0, from[2] - 100),
          MASK_PLAYERSOLID,
          tr,
        );
        return tr.endpos[2] - TRACE_EPSILON;
      };
      // Rays just either side of the crest edge land on the slope's top bevel and on the
      // platform: the same plane distance, so no lip at all.
      const platformSide = hitZ(crest + sign * 0.001);
      expect(platformSide).toBe(topZ);
      expect(hitZ(crest - sign * 0.001)).toBe(platformSide);
      // Further down the slope, the surface is below the crest by the run times tan θ.
      const down = hitZ(crest - sign * 64);
      expect(down).toBeLessThan(topZ);
      expect(down).toBeCloseTo(topZ - (64 * Math.sqrt(1 - nz * nz)) / nz, 0);
      // A standing hull walks across the crest: a horizontal trace just above it is clear.
      const a: number[] = [from[0], from[1]];
      const b: number[] = [from[0], from[1]];
      a[axis] = crest - sign * 50;
      b[axis] = crest + sign * 100;
      traceBox(
        world,
        vec3(a[0] ?? 0, a[1] ?? 0, topZ + 25),
        vec3(b[0] ?? 0, b[1] ?? 0, topZ + 25),
        HULL_MINS,
        HULL_STANDING_MAXS,
        MASK_PLAYERSOLID,
        tr,
      );
      expect(tr.fraction).toBe(1);
    },
  );

  it.each([
    [{ normalZ: 0 }, /normalZ 0 must be in \(0, 1\)/],
    [{ normalZ: 1 }, /normalZ 1 must be/],
    [{ run: 0 }, /slope run must be positive/],
    [{ width: Number.NaN }, /slope width must be a finite number/],
    [{ direction: "+z" as "+x" }, /slope direction "\+z" is not one of/],
  ])("slope refuses %j", (bad, message) => {
    expect(() =>
      lab().slope({ from: [0, 0, 0], run: 64, normalZ: 0.8, width: 64, ...bad }),
    ).toThrow(message);
  });

  it("wall: a box in wall grey", () => {
    const m = lab();
    m.wall({ min: [0, 300, 0], max: [512, 316, 256] });
    const cmap = m.compile();
    expect(faces(cmap, 0)).toEqual([...boxPlanes([0, 300, 0], [512, 316, 256])]);
    expect(faceMaterials(cmap, 0)).toEqual(Array(6).fill(MATERIAL_WALL));
  });

  it("rotatedBox: the rotated planes, f32-rounded, with axial bevels", () => {
    const c = Math.sqrt(3) / 2;
    const m = lab();
    m.rotatedBox({ center: [0, 0, 112], halfExtents: [256, 8, 128], cos: c, sin: 0.5 });
    const cmap = m.compile();
    expect(faces(cmap, 0)).toEqual([
      ...roundPlanesF32(rotatedBoxPlanes([0, 0, 112], [256, 8, 128], c, 0.5)),
    ]);
    // Four horizontal bevels; the ±z faces are axial already.
    expect(cmap.brushes.planeCount[0]).toBe(10);
    const b = bounds(cmap, 0);
    expect(b[2]).toBe(-16);
    expect(b[5]).toBe(240);
    expect(b[3]).toBeCloseTo(256 * c + 8 * 0.5, 4);
    expect(faceMaterials(cmap, 0)).toEqual(Array(6).fill(MATERIAL_WALL));
    const clip = lab();
    clip.rotatedBox({
      center: [0, 0, 112],
      halfExtents: [256, 8, 128],
      cos: c,
      sin: 0.5,
      contents: CONTENTS_PLAYERCLIP,
    });
    const clipMap = clip.compile();
    expect(clipMap.brushes.contents[0]).toBe(CONTENTS_PLAYERCLIP);
    expect(clipMap.materials).toEqual([MATERIAL_CLIP]);
  });

  it("names the brush when a shape constructor refuses its input", () => {
    const m = lab();
    m.box({ min: [0, 0, -16], max: [64, 64, 0] });
    expect(() => m.box({ min: [64, 0, 0], max: [0, 64, 64] })).toThrow(
      /^unit_lab brush 1 \(box\): .*min < max/,
    );
    expect(() => m.wall({ min: [0, 0, 0], max: [0, 64, 64] })).toThrow(
      /^unit_lab brush 1 \(wall\): .*min < max/,
    );
    expect(() => m.volume("WATER", { min: [0, 0, 0], max: [64, 0, 64] })).toThrow(
      /^unit_lab brush 1 \(WATER volume\): .*min < max/,
    );
    expect(() => m.timer("start", { min: [0, 0, 64], max: [64, 64, 0] })).toThrow(
      /^unit_lab brush 1 \(timer start\): .*min < max/,
    );
    expect(() =>
      m.rotatedBox({ center: [0, 0, 0], halfExtents: [8, 8, 8], cos: 1, sin: 1 }),
    ).toThrow(/^unit_lab brush 1 \(rotatedBox\): rotated box: \(cos, sin\) has length/);
    expect(() =>
      m.stairs({
        origin: [0, 0, 0],
        steps: 2,
        stepHeight: 8,
        stepDepth: 8,
        width: 8,
        direction: "z" as "+x",
      }),
    ).toThrow(/^unit_lab: stairs direction "z" is not one of/);
    expect(() =>
      m.ladder({ wallMin: [0, 0, 0], wallMax: [16, 64, 128], face: "x" as "+x" }),
    ).toThrow(/^unit_lab: ladder face "x" is not one of/);
    for (const kind of ["LAVA", "toString"]) {
      expect(() => m.volume(kind as "WATER", { min: [0, 0, 0], max: [64, 64, 64] })).toThrow(
        /^unit_lab: volume: unknown kind/,
      );
    }
    expect(m.brushCount).toBe(1);
  });

  it("volume: non-solid contents, water rendered, the others not", () => {
    const m = lab();
    m.volume("WATER", { min: [-600, -600, -128], max: [-300, -300, 0] });
    m.volume("LADDER", { min: [900, 0, 0], max: [916, 64, 256] });
    m.volume("PLAYERCLIP", { min: [0, 0, 0], max: [64, 64, 64] });
    m.volume("TRIGGER", { min: [0, 0, 0], max: [64, 64, 64] });
    m.volume("NODRAW", { min: [0, 0, 0], max: [64, 64, 64] });
    const cmap = m.compile();
    expect([...cmap.brushes.contents]).toEqual([
      CONTENTS_WATER,
      CONTENTS_LADDER,
      CONTENTS_PLAYERCLIP,
      CONTENTS_TRIGGER,
      CONTENTS_NODRAW,
    ]);
    expect(cmap.materials).toEqual([
      MATERIAL_WATER,
      MATERIAL_LADDER,
      MATERIAL_CLIP,
      MATERIAL_TRIGGER,
      "tool/nodraw",
    ]);
    expect([...cmap.surfaces.material]).toEqual([0]);
    expect(cmap.surfaces.indexCount[0]).toBe(36);
    const glass = lab();
    glass.volume("WATER", { min: [0, 0, 0], max: [64, 64, 64], material: "grey/glass" });
    expect(glass.compile().materials).toEqual(["grey/glass"]);
  });

  it("ladder: SURF_LADDER and the rung texture on the wall face, no LADDER volume (D-024)", () => {
    const m = lab();
    m.ladder({ wallMin: [900, 0, 0], wallMax: [916, 64, 256], face: "-x" });
    m.ladder({ wallMin: [0, 500, 0], wallMax: [64, 516, 128], face: "+y", material: "grey/brick" });
    const cmap = m.compile();
    expect([...cmap.brushes.contents]).toEqual([CONTENTS_SOLID, CONTENTS_SOLID]);
    expect(faceFlags(cmap, 0)).toEqual([SURF_LADDER, 0, 0, 0, 0, 0]);
    expect(faceMaterials(cmap, 0)).toEqual([MATERIAL_LADDER_FACE, ...Array(5).fill(MATERIAL_WALL)]);
    expect(faceFlags(cmap, 1)).toEqual([0, 0, 0, SURF_LADDER, 0, 0]);
    expect(faceMaterials(cmap, 1)).toEqual([
      "grey/brick",
      "grey/brick",
      "grey/brick",
      MATERIAL_LADDER_FACE,
      "grey/brick",
      "grey/brick",
    ]);
    // Every face renders, the rung face with its own material.
    expect([...cmap.surfaces.material].map((i) => cmap.materials[i])).toEqual([
      MATERIAL_LADDER_FACE,
      MATERIAL_WALL,
      "grey/brick",
    ]);
  });

  it.each([
    ["-x", 0, [884, 32, 128], [1, 0, 0]],
    ["+x", 1, [932, 32, 128], [-1, 0, 0]],
    ["-y", 2, [908, -16, 128], [0, 1, 0]],
    ["+y", 3, [908, 80, 128], [0, -1, 0]],
  ] as const)("ladder on the %s face", (face, plane, outside, inward) => {
    const m = lab();
    m.ladder({ wallMin: [900, 0, 0], wallMax: [916, 64, 256], face });
    const cmap = m.compile();
    const flags = [0, 0, 0, 0, 0, 0];
    flags[plane] = SURF_LADDER;
    expect(faceFlags(cmap, 0)).toEqual(flags);
    expect(faceMaterials(cmap, 0)[plane]).toBe(MATERIAL_LADDER_FACE);
    expect(cmap.brushes.contents.length).toBe(1);
    // A ray from 16 u in front of the face into the wall hits the flagged face, through empty
    // space: no LADDER volume (D-024).
    const world = buildCollisionWorld(cmap);
    const tr = new TraceResult();
    const start = vec3(outside[0], outside[1], outside[2]);
    const end = vec3(
      outside[0] + 64 * inward[0],
      outside[1] + 64 * inward[1],
      outside[2] + 64 * inward[2],
    );
    traceRay(world, start, end, MASK_PLAYERSOLID, tr);
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.surfaceFlags).toBe(SURF_LADDER);
    expect(pointContents(world, start)).toBe(0);
  });
});

describe("MapBuilder entities", () => {
  function entityMap(): MapBuilder {
    const m = lab();
    m.box({ min: [-512, -512, -16], max: [512, 512, 0] });
    m.spawn("info_player_start", [0, 0, 24], 90);
    m.spawn("info_spawn_red", [64, 0, 24], -0, { group: "a" });
    m.spawn("info_spawn_blue", [-64, 0, 24], 180);
    m.timer("start", { min: [-32, -32, 0], max: [32, 32, 64] });
    m.timer("stop", { min: [200, -32, 0], max: [264, 32, 64] });
    m.anchor("gap_96_takeoff", [128, 0, 0]);
    m.anchor("ladder_base", [256, 0, 0], 270);
    return m;
  }

  it("emits docs/07 §4.2 classnames in call order, yaw in angles", () => {
    const cmap = entityMap().compile();
    expect(cmap.entities).toEqual([
      { classname: "info_player_start", origin: [0, 0, 24], angles: [0, 90, 0], props: {} },
      {
        classname: "info_spawn_red",
        origin: [64, 0, 24],
        angles: [0, 0, 0],
        props: { group: "a" },
      },
      { classname: "info_spawn_blue", origin: [-64, 0, 24], angles: [0, 180, 0], props: {} },
      { classname: "info_timer_start", props: {}, brushes: [1] },
      { classname: "info_timer_stop", props: {}, brushes: [2] },
      { classname: "info_target", origin: [128, 0, 0], props: { targetname: "gap_96_takeoff" } },
      {
        classname: "info_target",
        origin: [256, 0, 0],
        angles: [0, 270, 0],
        props: { targetname: "ladder_base" },
      },
    ]);
    expect(Object.is(cmap.entities[1]?.angles?.[1], 0)).toBe(true);
    expect([...cmap.brushes.contents]).toEqual([
      CONTENTS_SOLID,
      CONTENTS_TRIGGER,
      CONTENTS_TRIGGER,
    ]);
    expect(cmap.materials).toEqual([MATERIAL_FLOOR, MATERIAL_TRIGGER]);
  });

  it("refuses duplicate or malformed names and bad spawns", () => {
    const m = entityMap();
    expect(() => m.anchor("ladder_base", [0, 0, 0])).toThrow(/anchor "ladder_base" exists already/);
    expect(() => m.anchor("Ladder Base", [0, 0, 0])).toThrow(/not snake_case/);
    expect(() => m.spawn("info_player_deathmatch" as "info_player_start", [0, 0, 0], 0)).toThrow(
      /not a spawn class/,
    );
    expect(() => m.spawn("info_player_start", [0, Number.NaN, 0], 0)).toThrow(/finite/);
    expect(() => m.spawn("info_player_start", [0, 0, 0], Number.POSITIVE_INFINITY)).toThrow(/yaw/);
    expect(() => new MapBuilder("Movement Lab")).toThrow(/not snake_case/);
    expect(() => m.anchor("far_away", [0, 16385, 0])).toThrow(/outside the ±16384 u world limit/);
    expect(() => m.spawn("info_player_start", [-1e21, 0, 0], 0)).toThrow(/world limit/);
    // A refused anchor does not take its name.
    m.anchor("far_away", [0, 16384, 0]);
    expect(m.compile().entities.length).toBe(8);
  });

  it("copies spawn props and checks their keys and values", () => {
    const m = lab();
    m.box({ min: [0, 0, -16], max: [64, 64, 0] });
    const props: Record<string, string> = { group: "a" };
    m.spawn("info_spawn_red", [0, 0, 24], 0, props);
    props.group = "b";
    props.extra = "c";
    expect(m.compile().entities[0]?.props).toEqual({ group: "a" });
    expect(() =>
      m.spawn("info_spawn_red", [0, 0, 24], 0, { group: 7 } as unknown as Record<string, string>),
    ).toThrow(/entity prop "group" must be a string/);
    expect(() =>
      m.spawn("info_spawn_red", [0, 0, 24], 0, JSON.parse('{"__proto__":"x","k":"v"}')),
    ).toThrow(/entity prop key "__proto__" is not snake_case/);
    expect(() => m.spawn("info_spawn_red", [0, 0, 24], 0, { "Team Name": "x" })).toThrow(
      /not snake_case/,
    );
    expect(m.compile().entities.length).toBe(1);
  });
});

/** A small course: floor, wall, stairs, ramp, slope + platform, kick lane, water, ladder. */
function sampleMap(): MapBuilder {
  const m = new MapBuilder("sample_course");
  m.box({
    min: [-1024, -1024, -16],
    max: [1024, 1024, 0],
    surfaceFlags: surfaceWithFootstep(0, FOOTSTEP_WOOD),
  });
  m.wall({ min: [0, 300, 0], max: [512, 316, 256] });
  m.stairs({ origin: [256, 0, 0], steps: 6, stepHeight: 16, stepDepth: 24, width: 128 });
  m.ramp({ from: [512, -256, 0], to: [768, -256, 96], width: 128 });
  const top = m.slope({
    from: [-512, -256, 0],
    run: 200,
    normalZ: 0.69,
    width: 128,
    direction: "-x",
  });
  m.box({ min: [-900, -320, 0], max: [-712, -192, top] });
  m.rotatedBox({
    center: [-400, 400, 112],
    halfExtents: [256, 8, 128],
    cos: Math.sqrt(3) / 2,
    sin: 0.5,
  });
  m.volume("WATER", { min: [-600, -600, 0], max: [-300, -300, 36] });
  m.ladder({ wallMin: [900, 0, 0], wallMax: [916, 64, 256], face: "-x" });
  m.spawn("info_player_start", [0, 0, 24], 0);
  m.timer("start", { min: [-32, -32, 0], max: [32, 32, 64] });
  m.anchor("ladder_base", [884, 32, 0], 0);
  return m;
}

describe("MapBuilder.compile", () => {
  it("names the compiler and version", () => {
    const cmap = sampleMap().compile();
    expect(cmap.compiler).toEqual({
      name: GREYBOX_COMPILER_NAME,
      version: GREYBOX_COMPILER_VERSION,
    });
    // 2: ladders lost their LADDER volume and gained the rung material (D-024).
    expect(GREYBOX_COMPILER_VERSION).toBe(2);
    expect(cmap.name).toBe("sample_course");
    expect(cmap.units).toBe("inch");
    expect(cmap.up).toBe("z");
  });

  it("is byte-identical when compiled twice and across builders", () => {
    const m = sampleMap();
    const a = encodeCmap(m.compile());
    const b = encodeCmap(m.compile());
    const c = encodeCmap(sampleMap().compile());
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
    expect(Buffer.from(c).equals(Buffer.from(a))).toBe(true);
    expect(m.compile().contentHash).toBe(decodeCmap(a).contentHash);
  });

  it("throws at the call that makes a bad brush, naming the map and brush", () => {
    const m = sampleMap();
    expect(() => m.box({ min: [0, 0, 0], max: [20000, 8, 8] })).toThrow(
      /^sample_course brush 15 \(box\): /,
    );
    expect(() => m.box({ min: [0, 0, 0], max: [0, 8, 8] })).toThrow(
      /^sample_course brush 15 \(box\): .*min < max/,
    );
    // Failed calls add nothing.
    expect(m.brushCount).toBe(15);
  });

  it("refuses a map without brushes", () => {
    expect(() => lab().compile()).toThrow(/^unit_lab: a map needs at least one brush$/);
  });

  it("round-trips through the file and traces as built", () => {
    const bytes = encodeCmap(sampleMap().compile());
    const cmap = decodeCmap(bytes);
    const world = buildCollisionWorld(cmap);
    const tr = new TraceResult();

    // The spawn hull touches the floor, which counts as clear (D-017); dropped from above, a hull
    // rests one skin above the wooden floor.
    const spawn = cmap.entities[0]?.origin ?? [0, 0, 0];
    const origin = vec3(spawn[0], spawn[1], spawn[2]);
    expect(positionTest(world, origin, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID)).toBe(true);
    traceBox(
      world,
      vec3(0, 0, 64),
      vec3(0, 0, -100),
      HULL_MINS,
      HULL_STANDING_MAXS,
      MASK_PLAYERSOLID,
      tr,
    );
    expect(tr.endpos[2]).toBe(24 + TRACE_EPSILON);
    expect([...tr.normal]).toEqual([0, 0, 1]);
    expect(tr.surfaceFlags).toBe(surfaceWithFootstep(0, FOOTSTEP_WOOD));

    // Walking into the wall stops one skin short of its −y face.
    traceBox(
      world,
      vec3(100, 200, 24),
      vec3(100, 400, 24),
      HULL_MINS,
      HULL_STANDING_MAXS,
      MASK_PLAYERSOLID,
      tr,
    );
    expect(tr.endpos[1]).toBe(300 - 15 - TRACE_EPSILON);
    expect([...tr.normal]).toEqual([0, -1, 0]);

    // A ray down onto the third stair lands on its top.
    traceRay(world, vec3(256 + 60, 0, 500), vec3(256 + 60, 0, -50), MASK_PLAYERSOLID, tr);
    expect(tr.endpos[2]).toBe(48 + TRACE_EPSILON);

    // The water volume doesn't block, but pointContents sees it; the ladder face carries its flag.
    traceRay(world, vec3(-450, -450, 100), vec3(-450, -450, -100), MASK_PLAYERSOLID, tr);
    expect(tr.endpos[2]).toBe(TRACE_EPSILON);
    expect(pointContents(world, vec3(-450, -450, 20))).toBe(CONTENTS_WATER);
    traceRay(world, vec3(800, 32, 128), vec3(1000, 32, 128), MASK_PLAYERSOLID, tr);
    expect(tr.surfaceFlags).toBe(SURF_LADDER);
    expect(tr.endpos[0]).toBe(900 - TRACE_EPSILON);
    expect(pointContents(world, vec3(890, 32, 128))).toBe(0);

    // The ramp's slope stops a ray at its surface: halfway up, 48 u high.
    traceRay(world, vec3(640, -256, 500), vec3(640, -256, -50), MASK_PLAYERSOLID, tr);
    expect(tr.endpos[2]).toBeCloseTo(48 + TRACE_EPSILON * Math.sqrt(1 + (96 / 256) ** 2), 3);
    expect(tr.normal[2]).toBeGreaterThan(0.9);

    // The −x slope climbs to its crest at x = −712, where the platform continues it.
    const down = (x: number) => {
      traceRay(world, vec3(x, -256, 500), vec3(x, -256, -50), MASK_PLAYERSOLID, tr);
      return tr.endpos[2];
    };
    const crest = cmap.brushes.bounds[6 * 9 + 5] ?? 0;
    expect(down(-712.001)).toBe(crest + TRACE_EPSILON);
    expect(Math.abs(down(-711.999) - down(-712.001))).toBeLessThan(1e-3);
    expect(down(-612)).toBeCloseTo(crest / 2 + TRACE_EPSILON / 0.69, 2);

    // The trigger brush neither blocks players nor renders.
    expect(pointContents(world, vec3(0, 0, 32)) & CONTENTS_TRIGGER).toBe(CONTENTS_TRIGGER);
  });
});
