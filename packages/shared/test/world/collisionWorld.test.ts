import { describe, expect, it } from "vitest";
import { buildBrush } from "../../src/world/brushBuild";
import {
  type CollisionBrushSource,
  CollisionWorld,
  CollisionWorldError,
  createCollisionWorld,
} from "../../src/world/collisionWorld";
import {
  CONTENTS_LADDER,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  FOOTSTEP_COUNT,
  FOOTSTEP_METAL,
  SURF_LADDER,
  SURF_SLICK,
  surfaceWithFootstep,
} from "../../src/world/contents";
import { boxPlanes, rotatedBoxPlanes, wedgePlanes } from "../../src/world/shapes";

const floor = buildBrush(boxPlanes([-512, -512, -16], [512, 512, 0]));
const lane = buildBrush(rotatedBoxPlanes([100, 40, 112], [256, 8, 128], Math.sqrt(3) / 2, 0.5));
const ramp = buildBrush(wedgePlanes([0, -64, 0], [128, 64, 96], "+y"));

function solid(b: typeof floor, contents = CONTENTS_SOLID): CollisionBrushSource {
  return { ...b, contents };
}

describe("createCollisionWorld", () => {
  it("lays brushes and planes out in input order", () => {
    const world = createCollisionWorld([
      solid(floor),
      solid(lane, CONTENTS_SOLID | CONTENTS_LADDER),
      solid(ramp, CONTENTS_PLAYERCLIP),
    ]);
    const counts = [floor, lane, ramp].map((b) => b.planes.length / 4);
    const [c0 = 0, c1 = 0, c2 = 0] = counts;
    expect(world.brushCount).toBe(3);
    expect(world.planeCount).toBe(c0 + c1 + c2);
    expect([...world.brushPlaneStart]).toEqual([0, c0, c0 + c1]);
    expect([...world.brushPlaneCount]).toEqual(counts);
    expect([...world.brushFaceCount]).toEqual([6, 6, 5]);
    expect([...world.brushContents]).toEqual([
      CONTENTS_SOLID,
      CONTENTS_SOLID | CONTENTS_LADDER,
      CONTENTS_PLAYERCLIP,
    ]);
    expect([...world.planes]).toEqual([...floor.planes, ...lane.planes, ...ramp.planes]);
    expect([...world.brushBounds]).toEqual([...floor.bounds, ...lane.bounds, ...ramp.bounds]);
    expect([...world.planeSurf]).toEqual(new Array(world.planeCount).fill(0));
  });

  it("widens f32 planes exactly and normalises −0", () => {
    const planes = Float32Array.from(lane.planes);
    planes[2] = -0;
    const world = createCollisionWorld([
      { ...solid(lane), planes, bounds: Float32Array.from(lane.bounds) },
    ]);
    expect(world.planes).toBeInstanceOf(Float64Array);
    expect([...world.planes]).toEqual([...lane.planes].map((v, i) => (i === 2 ? 0 : v)));
    expect(Object.is(world.planes[2], -0)).toBe(false);
    // The ramp starts at y = −64 and x = 0: a −0 min bound must come out as +0.
    const bounds = Float32Array.from(ramp.bounds);
    expect(bounds[0]).toBe(0);
    bounds[0] = -0;
    const rampWorld = createCollisionWorld([{ ...solid(ramp), bounds }]);
    expect(Object.is(rampWorld.brushBounds[0], -0)).toBe(false);
    expect([...rampWorld.brushBounds]).toEqual([...ramp.bounds]);
  });

  it("copies per-plane surface flags", () => {
    const flags = new Uint32Array(floor.planes.length / 4);
    flags[5] = surfaceWithFootstep(SURF_LADDER, FOOTSTEP_METAL);
    const world = createCollisionWorld([solid(ramp), { ...solid(floor), surfaceFlags: flags }]);
    const start = world.brushPlaneStart[1] ?? 0;
    expect([...world.planeSurf.subarray(start)]).toEqual([...flags]);
    expect([...world.planeSurf.subarray(0, start)].every((s) => s === 0)).toBe(true);
  });

  it("accepts the last footstep material", () => {
    const flags = [0, 0, 0, 0, 0, surfaceWithFootstep(0, FOOTSTEP_COUNT - 1)];
    const world = createCollisionWorld([{ ...solid(floor), surfaceFlags: flags }]);
    expect(world.planeSurf[5]).toBe(flags[5]);
  });

  it("rejects surface flags on a bevel plane", () => {
    const flags = new Array<number>(lane.planes.length / 4).fill(0);
    flags[lane.faceCount] = SURF_SLICK;
    expect(() => createCollisionWorld([{ ...solid(lane), surfaceFlags: flags }])).toThrow(
      /^brush 0: bevel plane 6 has surface flags 2, not 0/,
    );
  });

  it("accepts an empty world", () => {
    const world = createCollisionWorld([]);
    expect(world.brushCount).toBe(0);
    expect(world.planeCount).toBe(0);
  });

  it("assigns its fields in one fixed order", () => {
    expect(Object.keys(createCollisionWorld([solid(floor)]))).toEqual([
      "brushCount",
      "planeCount",
      "planes",
      "planeSurf",
      "brushPlaneStart",
      "brushPlaneCount",
      "brushFaceCount",
      "brushContents",
      "brushBounds",
      "bvh",
    ]);
    expect(createCollisionWorld([])).toBeInstanceOf(CollisionWorld);
  });

  it("builds the BVH over the bounds it is given, which must cover every brush", () => {
    const world = new CollisionWorld(1, 6, Float64Array.from(floor.bounds));
    expect([...world.bvh.nodeBounds]).toEqual([...floor.bounds]);
    expect(() => new CollisionWorld(2, 12, new Float64Array(6))).toThrow(
      /^6 bounds values for 2 brushes$/,
    );
  });

  const withPlane = (i: number, v: number): Float64Array => {
    const p = floor.planes.slice();
    p[i] = v;
    return p;
  };
  const withBound = (i: number, v: number): Float64Array => {
    const b = floor.bounds.slice();
    b[i] = v;
    return b;
  };

  it.each([
    ["a ragged plane array", { planes: floor.planes.subarray(0, 23) }, /not 4·n/],
    ["too many planes", { planes: new Float64Array(4 * 65536) }, /more than 65535/],
    ["fewer than 4 faces", { faceCount: 3 }, /faceCount 3/],
    ["more faces than planes", { faceCount: 7 }, /faceCount 7/],
    ["a fractional face count", { faceCount: 4.5 }, /faceCount 4.5/],
    ["a NaN plane value", { planes: withPlane(3, Number.NaN) }, /plane 0 .*finite f32/],
    ["an infinite plane value", { planes: withPlane(7, Number.POSITIVE_INFINITY) }, /plane 1/],
    ["a plane value that is not an f32", { planes: withPlane(11, 0.1) }, /plane 2 .*f32/],
    ["a non-unit normal", { planes: withPlane(0, 0.5) }, /plane 0 normal is not unit/],
    ["short bounds", { bounds: floor.bounds.subarray(0, 5) }, /bounds has 5 values/],
    ["inverted bounds", { bounds: withBound(0, 1024) }, /min > max on axis 0/],
    ["bounds past the world limit", { bounds: withBound(3, 16400) }, /within ±16384/],
    ["non-f32 bounds", { bounds: withBound(4, 0.1) }, /bounds value 4/],
    ["bounds inside the brush", { bounds: withBound(3, 256) }, /value 3 is not .* a \+x plane/],
    ["bounds outside the brush", { bounds: withBound(2, -32) }, /value 2 is not .* a −z plane/],
    ["bounds one f32 step off", { bounds: withBound(5, 2 ** -149) }, /value 5 is not .* a \+z/],
    ["zero contents", { contents: 0 }, /non-zero set of known/],
    ["unknown contents bits", { contents: CONTENTS_WATER | 0x100 }, /contents 260/],
    ["fractional contents", { contents: 1.5 }, /contents 1.5/],
    ["surface flags of the wrong length", { surfaceFlags: [0, 0] }, /2 surface flags for 6 planes/],
    ["unknown surface bits", { surfaceFlags: [0, 0, 0, 0, 0, 1 << 20] }, /plane 5 surface flags/],
    ["negative surface flags", { surfaceFlags: [-1, 0, 0, 0, 0, 0] }, /plane 0 surface flags/],
    [
      "an unknown footstep material",
      { surfaceFlags: [0, 0, surfaceWithFootstep(0, 9), 0, 0, 0] },
      /plane 2 has unknown footstep/,
    ],
    [
      "the first footstep past the last material",
      { surfaceFlags: [0, 0, surfaceWithFootstep(0, FOOTSTEP_COUNT), 0, 0, 0] },
      /plane 2 has unknown footstep/,
    ],
    ["contents of 2^32", { contents: 2 ** 32 }, /contents 4294967296/],
    ["contents of 2^32 + 1", { contents: 2 ** 32 + 1 }, /contents 4294967297/],
    ["surface flags of 2^32", { surfaceFlags: [0, 0, 0, 0, 0, 2 ** 32] }, /plane 5 surface flags/],
    ["a missing axial plane", { planes: floor.planes.subarray(0, 20), faceCount: 5 }, /value 5/],
  ] as const)("rejects %s", (_name, patch, text) => {
    const bad = { ...solid(floor), ...patch } as CollisionBrushSource;
    expect(() => createCollisionWorld([solid(ramp), bad])).toThrow(CollisionWorldError);
    expect(() => createCollisionWorld([solid(ramp), bad])).toThrow(
      new RegExp(`^brush 1: .*${text.source}`),
    );
  });

  // The BVH culls by bounds, so a brush reaching past them would hide hits from traceBox.
  it.each([
    ["a rotated box", lane],
    ["a wedge", ramp],
  ])("rejects %s stripped of its axial bevels", (_name, b) => {
    const stripped = { ...solid(b), planes: b.planes.slice(0, 4 * b.faceCount) };
    expect(b.planes.length).toBeGreaterThan(4 * b.faceCount);
    expect(() => createCollisionWorld([stripped])).toThrow(/^brush 0: bounds value \d is not/);
  });
});
