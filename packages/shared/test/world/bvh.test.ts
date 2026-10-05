import { describe, expect, it } from "vitest";
import { type Vec3, vec3 } from "../../src/math/vec3";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { HULL_CROUCHED_MAXS, HULL_MINS, HULL_STANDING_MAXS } from "../../src/sim/hull";
import {
  BVH_LEAF_SIZE,
  BVH_MAX_DEPTH,
  BVH_STACK_SIZE,
  type Bvh,
  buildBvh,
} from "../../src/world/bvh";
import {
  type CollisionBrushSource,
  type CollisionWorld,
  createCollisionWorld,
} from "../../src/world/collisionWorld";
import {
  CONTENTS_LADDER,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  FOOTSTEP_METAL,
  MASK_PLAYERSOLID,
  MASK_SOLID,
  SURF_LADDER,
  SURF_SLICK,
  surfaceWithFootstep,
} from "../../src/world/contents";
import { boxPlanes, rotatedBoxPlanes, type WedgeRise, wedgePlanes } from "../../src/world/shapes";
import {
  boxContents,
  boxContentsBrute,
  lastQueryBrushes,
  lastQueryNodes,
  pointContents,
  positionContents,
  positionContentsBrute,
  positionTest,
  TraceResult,
  traceBox,
  traceBoxBrute,
} from "../../src/world/trace";
import { brush, traceBits, worldOf } from "../helpers/traceWorld";

// M1 design C: the BVH must build deterministically and change only speed, never results, so
// every query is compared bit for bit against its brute-force reference on synthetic worlds.

const v = vec3;
const ZERO = vec3();
const RISES: readonly WedgeRise[] = ["+x", "-x", "+y", "-y"];
const CONTENTS_CHOICES = [
  CONTENTS_SOLID,
  CONTENTS_SOLID,
  CONTENTS_SOLID,
  CONTENTS_PLAYERCLIP,
  CONTENTS_WATER,
  CONTENTS_LADDER,
  CONTENTS_SOLID | CONTENTS_LADDER,
];
const FACE_FLAGS = [0, SURF_SLICK, SURF_LADDER, surfaceWithFootstep(0, FOOTSTEP_METAL)];

/** Random multiple of 1/8 in [lo, hi). */
function eighths(rng: Mulberry32, lo: number, hi: number): number {
  return lo + rng.nextInt(Math.max(1, Math.floor((hi - lo) * 8))) / 8;
}

function pick<T>(rng: Mulberry32, items: readonly T[]): T {
  return items[rng.nextInt(items.length)] as T;
}

function flagged(rng: Mulberry32, planes: Float64Array): CollisionBrushSource {
  const flags = FACE_FLAGS.map(() => pick(rng, FACE_FLAGS));
  return brush(planes, pick(rng, CONTENTS_CHOICES), (face) => flags[face % flags.length] ?? 0);
}

function randomBox(rng: Mulberry32, range: number, maxSize: number): CollisionBrushSource {
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const lo = eighths(rng, -range, range);
    min[k] = lo;
    max[k] = lo + eighths(rng, 1, maxSize);
  }
  return flagged(rng, boxPlanes(min, max));
}

function randomRotatedBox(rng: Mulberry32, range: number, maxHalf: number): CollisionBrushSource {
  let c = 0;
  let s = 0;
  do {
    c = rng.nextFloat() * 2 - 1;
    s = rng.nextFloat() * 2 - 1;
  } while (c * c + s * s < 0.01);
  const len = Math.sqrt(c * c + s * s);
  const center: [number, number, number] = [
    eighths(rng, -range, range),
    eighths(rng, -range, range),
    eighths(rng, -range, range),
  ];
  const half: [number, number, number] = [
    eighths(rng, 2, maxHalf),
    eighths(rng, 2, maxHalf),
    eighths(rng, 2, maxHalf),
  ];
  return flagged(rng, rotatedBoxPlanes(center, half, c / len, s / len));
}

function randomWedge(rng: Mulberry32, range: number, maxSize: number): CollisionBrushSource {
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const lo = eighths(rng, -range, range);
    min[k] = lo;
    max[k] = lo + eighths(rng, 4, maxSize);
  }
  return flagged(rng, wedgePlanes(min, max, pick(rng, RISES)));
}

/** A raw axis-aligned box source that skips buildBrush, for sizes its validation refuses. */
function rawBox(lo: number, hi: number, contents = CONTENTS_SOLID): CollisionBrushSource {
  return {
    planes: boxPlanes([lo, lo, lo], [hi, hi, hi]),
    faceCount: 6,
    bounds: Float64Array.of(lo, lo, lo, hi, hi, hi),
    contents,
  };
}

interface TestWorld {
  readonly name: string;
  readonly world: CollisionWorld;
  /** Query points come from [lo, hi] per axis, at one of these scales around the origin. */
  readonly lo: readonly number[];
  readonly hi: readonly number[];
  readonly multiScale: boolean;
}

function regionOf(world: CollisionWorld, pad: number): { lo: number[]; hi: number[] } {
  if (world.brushCount === 0) return { lo: [-500, -500, -500], hi: [500, 500, 500] };
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let b = 0; b < world.brushCount; b++) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k] ?? 0, world.brushBounds[6 * b + k] ?? 0);
      hi[k] = Math.max(hi[k] ?? 0, world.brushBounds[6 * b + k + 3] ?? 0);
    }
  }
  return { lo: lo.map((x) => x - pad), hi: hi.map((x) => x + pad) };
}

function testWorld(name: string, sources: CollisionBrushSource[], multiScale = false): TestWorld {
  const world = createCollisionWorld(sources);
  return { name, world, ...regionOf(world, 96), multiScale };
}

/** Brushes shrinking by half toward the origin: a chain SAH peels apart until the depth cap. */
function deepChain(count: number): CollisionBrushSource[] {
  const out: CollisionBrushSource[] = [];
  let a = 8192;
  for (let i = 0; i < count; i++) {
    out.push(rawBox(Math.fround(a), Math.fround(a * 1.25), i % 5 === 4 ? CONTENTS_WATER : 1));
    a *= 0.5;
  }
  return out;
}

function makeWorlds(): TestWorld[] {
  const rng = new Mulberry32(0x5a4b);
  const worlds: TestWorld[] = [];
  worlds.push(testWorld("empty", []));
  worlds.push(testWorld("one brush", [randomBox(rng, 64, 128)]));
  worlds.push(testWorld("two brushes", [randomBox(rng, 64, 128), randomRotatedBox(rng, 64, 64)]));
  worlds.push(
    testWorld(
      "random boxes",
      Array.from({ length: 70 }, () => randomBox(rng, 600, 200)),
    ),
  );
  worlds.push(
    testWorld(
      "Z-rotated boxes",
      Array.from({ length: 50 }, () => randomRotatedBox(rng, 500, 120)),
    ),
  );
  worlds.push(
    testWorld(
      "wedges",
      Array.from({ length: 40 }, () => randomWedge(rng, 500, 200)),
    ),
  );
  const pairs: CollisionBrushSource[] = [];
  for (let i = 0; i < 20; i++) {
    const x0 = eighths(rng, -500, 500);
    const y0 = eighths(rng, -500, 500);
    const z0 = eighths(rng, -200, 200);
    const x1 = x0 + eighths(rng, 8, 96);
    const x2 = x1 + eighths(rng, 8, 96);
    const h = eighths(rng, 8, 128);
    const shift = i % 2 === 0 ? 0 : eighths(rng, -16, 16);
    pairs.push(flagged(rng, boxPlanes([x0, y0, z0], [x1, y0 + h, z0 + h])));
    pairs.push(flagged(rng, boxPlanes([x1, y0 + shift, z0], [x2, y0 + h + shift, z0 + h])));
    // A ramp leaning on the pair's top.
    pairs.push(flagged(rng, wedgePlanes([x0, y0, z0 + h], [x2, y0 + h, z0 + h + 32], "+x")));
  }
  worlds.push(testWorld("abutting pairs", pairs));
  const tiles: CollisionBrushSource[] = [];
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const x = -512 + 128 * i;
      const y = -512 + 128 * j;
      tiles.push(brush(boxPlanes([x, y, -16], [x + 128, y + 128, 0]), CONTENTS_SOLID, (f) => f));
    }
  }
  for (let i = 0; i < 6; i++) tiles.push(randomBox(rng, 400, 64));
  worlds.push(testWorld("coplanar floor tiles", tiles));
  const huge: CollisionBrushSource[] = [brush(boxPlanes([-8192, -8192, -64], [8192, 8192, 0]))];
  for (let i = 0; i < 60; i++) huge.push(randomBox(rng, 2000, 96));
  for (let i = 0; i < 20; i++) huge.push(randomRotatedBox(rng, 2000, 64));
  worlds.push(testWorld("one huge brush plus many small", huge));
  // Exact f32 bounds around one center: every centroid is identical (median fallback).
  const nested: CollisionBrushSource[] = [];
  for (let k = 1; k <= 9; k++) {
    const c = [100.5, 50.25, 30];
    const h = [8 * k, 6 * k + 1, 4 * k];
    nested.push(
      flagged(
        rng,
        boxPlanes(
          [(c[0] ?? 0) - (h[0] ?? 0), (c[1] ?? 0) - (h[1] ?? 0), (c[2] ?? 0) - (h[2] ?? 0)],
          [(c[0] ?? 0) + (h[0] ?? 0), (c[1] ?? 0) + (h[1] ?? 0), (c[2] ?? 0) + (h[2] ?? 0)],
        ),
      ),
    );
  }
  worlds.push(testWorld("identical centroids", nested));
  const spun: CollisionBrushSource[] = [];
  for (let k = 0; k < 10; k++) {
    const c = Math.sqrt(1 - (k / 10) * (k / 10));
    spun.push(flagged(rng, rotatedBoxPlanes([0, 0, 0], [40 + 4 * k, 12, 30], c, k / 10)));
  }
  worlds.push(testWorld("rotated boxes sharing a center", spun));
  const mixed: CollisionBrushSource[] = [];
  for (let i = 0; i < 120; i++) {
    const kind = rng.nextInt(3);
    if (kind === 0) mixed.push(randomBox(rng, 1500, 300));
    else if (kind === 1) mixed.push(randomRotatedBox(rng, 1500, 150));
    else mixed.push(randomWedge(rng, 1500, 300));
  }
  worlds.push(testWorld("mixed shapes", mixed));
  worlds.push(testWorld("depth cap", deepChain(150), true));
  return worlds;
}

const WORLDS = makeWorlds();

function depthOf(bvh: Bvh): number {
  let max = 0;
  const pending: [number, number][] = bvh.nodeCount.length > 0 ? [[0, 0]] : [];
  while (pending.length > 0) {
    const [node, depth] = pending.pop() ?? [0, 0];
    max = Math.max(max, depth);
    if (bvh.nodeCount[node] === 0) {
      pending.push([node + 1, depth + 1], [bvh.nodeFirst[node] ?? 0, depth + 1]);
    }
  }
  return max;
}

/** Leaves as [node, depth], in node order. */
function leavesOf(bvh: Bvh): [number, number][] {
  const out: [number, number][] = [];
  const pending: [number, number][] = bvh.nodeCount.length > 0 ? [[0, 0]] : [];
  while (pending.length > 0) {
    const [node, depth] = pending.pop() ?? [0, 0];
    if (bvh.nodeCount[node] === 0) {
      pending.push([bvh.nodeFirst[node] ?? 0, depth + 1], [node + 1, depth + 1]);
    } else {
      out.push([node, depth]);
    }
  }
  return out;
}

/** Recomputes node bounds from the leaves up and checks the layout invariants. */
function checkStructure(world: CollisionWorld): void {
  const bvh = world.bvh;
  const n = bvh.nodeCount.length;
  const b = world.brushCount;
  expect(n).toBeLessThanOrEqual(Math.max(0, 2 * b - 1));
  expect(bvh.nodeFirst.length).toBe(n);
  expect(bvh.nodeAxis.length).toBe(n);
  expect(bvh.nodeBounds.length).toBe(6 * n);
  expect(bvh.leafRefs.length).toBe(b);
  expect(bvh.stack.length).toBe(BVH_STACK_SIZE);
  const seen = new Array<number>(b).fill(0);
  const bounds = (node: number): number[] => {
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const add = (src: ArrayLike<number>, o: number) => {
      for (let k = 0; k < 3; k++) {
        box[k] = Math.min(box[k] ?? 0, src[o + k] ?? 0);
        box[k + 3] = Math.max(box[k + 3] ?? 0, src[o + k + 3] ?? 0);
      }
    };
    const count = bvh.nodeCount[node] ?? 0;
    const first = bvh.nodeFirst[node] ?? 0;
    if (count === 0) {
      expect(first).toBeGreaterThan(node + 1);
      expect(first).toBeLessThan(n);
      expect(bvh.nodeAxis[node]).toBeLessThan(3);
      add(bounds(node + 1), 0);
      add(bounds(first), 0);
    } else {
      expect(bvh.nodeAxis[node]).toBe(0);
      for (let i = first; i < first + count; i++) {
        const ref = bvh.leafRefs[i] ?? 0;
        if (i > first) expect(ref).toBeGreaterThan(bvh.leafRefs[i - 1] ?? 0);
        seen[ref] = (seen[ref] ?? 0) + 1;
        add(world.brushBounds, 6 * ref);
      }
    }
    expect([...bvh.nodeBounds.subarray(6 * node, 6 * node + 6)]).toEqual(box);
    return box;
  };
  if (n > 0) bounds(0);
  expect(seen.every((s) => s === 1)).toBe(true);
  // The stack holds at most one entry per level below the root.
  expect(depthOf(bvh)).toBeLessThanOrEqual(BVH_MAX_DEPTH);
  expect(BVH_MAX_DEPTH).toBeLessThan(BVH_STACK_SIZE);
}

function arrays(bvh: Bvh): number[][] {
  return [
    [...bvh.nodeBounds],
    [...bvh.nodeFirst],
    [...bvh.nodeCount],
    [...bvh.nodeAxis],
    [...bvh.leafRefs],
  ];
}

describe("BVH build", () => {
  it.each(WORLDS.map((w) => [w.name, w] as const))("%s: valid layout", (_name, w) => {
    checkStructure(w.world);
  });

  it("is identical for identical input, array by array", () => {
    const again = makeWorlds();
    for (let i = 0; i < WORLDS.length; i++) {
      const a = WORLDS[i]?.world.bvh as Bvh;
      const b = again[i]?.world.bvh as Bvh;
      expect(arrays(b)).toEqual(arrays(a));
      const w = WORLDS[i]?.world as CollisionWorld;
      expect(arrays(buildBvh(w.brushBounds.slice(), w.brushCount))).toEqual(arrays(a));
    }
  });

  it("builds an empty BVH for an empty world, and queries on it find nothing", () => {
    const world = createCollisionWorld([]);
    expect(world.bvh.nodeCount.length).toBe(0);
    const out = new TraceResult();
    traceBox(world, v(0, 0, 0), v(100, 0, 0), HULL_MINS, HULL_STANDING_MAXS, -1, out);
    expect(out.fraction).toBe(1);
    expect(positionTest(world, v(0, 0, 0), HULL_MINS, HULL_STANDING_MAXS, -1)).toBe(true);
    expect(pointContents(world, v(0, 0, 0))).toBe(0);
    expect(boxContents(world, v(-1, -1, -1), v(1, 1, 1))).toBe(0);
  });

  it("puts one brush in a single leaf", () => {
    const bvh = (WORLDS[1] as TestWorld).world.bvh;
    expect([...bvh.nodeCount]).toEqual([1]);
    expect([...bvh.nodeFirst]).toEqual([0]);
  });

  it("falls back to a median split by brush index when centroids coincide", () => {
    const bvh = (WORLDS.find((w) => w.name === "identical centroids") as TestWorld).world.bvh;
    const leaves = leavesOf(bvh);
    // Sorted by (centroid, index) with equal centroids: the leaves read 0…8 in order.
    expect(
      leaves.flatMap(([node]) => {
        const first = bvh.nodeFirst[node] ?? 0;
        return [...bvh.leafRefs.subarray(first, first + (bvh.nodeCount[node] ?? 0))];
      }),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Math.max(...leaves.map(([node]) => bvh.nodeCount[node] ?? 0))).toBeLessThanOrEqual(
      BVH_LEAF_SIZE,
    );
    // 9 → 4 + 5 → 2 + 2, 2 + 3 → … 1 + 2.
    expect(depthOf(bvh)).toBe(3);
  });

  it("caps the depth at BVH_MAX_DEPTH, leaving bigger leaves there", () => {
    const bvh = (WORLDS.find((w) => w.name === "depth cap") as TestWorld).world.bvh;
    expect(depthOf(bvh)).toBe(BVH_MAX_DEPTH);
    const capped = leavesOf(bvh).filter(([, depth]) => depth === BVH_MAX_DEPTH);
    expect(capped.some(([node]) => (bvh.nodeCount[node] ?? 0) > BVH_LEAF_SIZE)).toBe(true);
  });

  it("makes a leaf when no split is cheaper", () => {
    // Collinear zero-area bounds: every split costs as much as the leaf.
    const bounds = Float64Array.of(0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5, 0, 0);
    const bvh = buildBvh(bounds, 3);
    expect([...bvh.nodeCount]).toEqual([3]);
    expect([...bvh.leafRefs]).toEqual([0, 1, 2]);
  });

  // Golden trees, worked out by hand from the SAH formula. A unit cube spanning length L along x
  // has area 4L + 2; a 101 × 101 slab spanning L has area 2(202L + 10201). Leaf cost is n × area.
  const layout = (bvh: Bvh) => ({
    nodeBounds: [...bvh.nodeBounds],
    nodeFirst: [...bvh.nodeFirst],
    nodeCount: [...bvh.nodeCount],
    nodeAxis: [...bvh.nodeAxis],
    leafRefs: [...bvh.leafRefs],
  });
  const slab = (x0: number, x1: number) => [x0, -50, -50, x1, 51, 51];
  const cube = (x0: number, x1: number) => [x0, 0, 0, x1, 1, 1];

  it("bins finely enough to split a big slab off a cube next to it (16 bins, not 8)", () => {
    // Centroids 0.5, 1.5, 16.5: 16 bins put them in bins 0, 1, 15; 8 bins lump the first two.
    // {0} | {1, 2} costs 20806 + 66·2 = 20938; {0, 1} | {2} costs 21210·2 + 6 = 42426.
    const bvh = buildBvh(Float64Array.from([...slab(0, 1), ...cube(1, 2), ...cube(16, 17)]), 3);
    expect(layout(bvh)).toEqual({
      nodeBounds: [0, -50, -50, 17, 51, 51, ...slab(0, 1), 1, 0, 0, 17, 1, 1],
      nodeFirst: [2, 0, 1],
      nodeCount: [0, 1, 2],
      nodeAxis: [0, 0, 0],
      leafRefs: [0, 1, 2],
    });
  });

  it("does not bin finer than 16 (32 bins would split the slab off here)", () => {
    // Centroids 0.5, 1, 16.5: 16 bins lump the first two (bin 0), so only {0, 1} | {2} is a
    // candidate (21008·2 + 6 = 42022), although {0} | {1, 2} would cost 20942.
    const bvh = buildBvh(Float64Array.from([...slab(0, 1), ...cube(0.5, 1.5), ...cube(16, 17)]), 3);
    expect(layout(bvh)).toEqual({
      nodeBounds: [0, -50, -50, 17, 51, 51, 0, -50, -50, 1.5, 51, 51, ...cube(16, 17)],
      nodeFirst: [2, 0, 2],
      nodeCount: [0, 2, 1],
      nodeAxis: [0, 0, 0],
      leafRefs: [0, 1, 2],
    });
  });

  it("breaks equal split costs toward the lowest split", () => {
    // Cubes at x = 0, 2, 4: {0} | {1, 2} and {0, 1} | {2} both cost 6 + 14·2 = 34 (< 22·3).
    const bvh = buildBvh(Float64Array.from([...cube(0, 1), ...cube(2, 3), ...cube(4, 5)]), 3);
    expect(layout(bvh)).toEqual({
      nodeBounds: [0, 0, 0, 5, 1, 1, ...cube(0, 1), 2, 0, 0, 5, 1, 1],
      nodeFirst: [2, 0, 1],
      nodeCount: [0, 1, 2],
      nodeAxis: [0, 0, 0],
      leafRefs: [0, 1, 2],
    });
  });

  it("splits along the longest centroid axis, ties going x before y before z", () => {
    const cube = (x: number, y: number, z: number) => [x, y, z, x + 1, y + 1, z + 1];
    const along = (dx: number, dy: number, dz: number) =>
      buildBvh(
        Float64Array.from([...cube(0, 0, 0), ...cube(dx, dy, dz), ...cube(2 * dx, 2 * dy, 2 * dz)]),
        3,
      ).nodeAxis[0];
    expect(along(0, 0, 10)).toBe(2);
    expect(along(0, 10, 0)).toBe(1);
    expect(along(10, 10, 10)).toBe(0);
    expect(along(0, 10, 10)).toBe(1);
  });
});

interface Hull {
  readonly mins: Vec3;
  readonly maxs: Vec3;
}

const HULLS: readonly Hull[] = [
  { mins: HULL_MINS, maxs: HULL_STANDING_MAXS },
  { mins: HULL_MINS, maxs: HULL_CROUCHED_MAXS },
  { mins: ZERO, maxs: ZERO },
  { mins: v(-4, -4, -4), maxs: v(4, 4, 4) },
  { mins: v(-0.5, -3, -40), maxs: v(7, 0.25, 2) },
  { mins: v(-100, -100, -10), maxs: v(100, 100, 10) },
];
const MASKS = [MASK_PLAYERSOLID, MASK_PLAYERSOLID, MASK_SOLID, -1, CONTENTS_WATER, 0];
const TINY = [5e-324, 1e-300, 1e-9, 1 / 2048, 1 / 1024, 0.01];

/** Seeded queries over one world; points snap to a grid half the time so touching happens. */
class QueryGen {
  readonly rng: Mulberry32;
  readonly w: TestWorld;
  scale = 1;

  constructor(w: TestWorld, seed: number) {
    this.rng = new Mulberry32(seed);
    this.w = w;
  }

  next(): void {
    // Multi-scale worlds zoom toward the origin, where their small brushes sit.
    this.scale = this.w.multiScale ? 2 ** -this.rng.nextInt(60) : 1;
  }

  coord(k: number): number {
    const lo = (this.w.lo[k] ?? 0) * this.scale;
    const hi = (this.w.hi[k] ?? 0) * this.scale;
    return this.snap(lo + this.rng.nextFloat() * (hi - lo));
  }

  snap(x: number): number {
    const grid = this.rng.nextInt(4);
    if (grid === 0 && this.scale === 1) return Math.round(x * 32) / 32;
    if (grid === 1 && this.scale === 1) return Math.round(x);
    return x;
  }

  /** Half the points land near a random brush, so hits, touches and solid starts are common. */
  point(out: Vec3): Vec3 {
    const world = this.w.world;
    if (world.brushCount > 0 && this.rng.nextInt(2) === 0) {
      const o = 6 * this.rng.nextInt(world.brushCount);
      for (let k = 0; k < 3; k++) {
        const lo = (world.brushBounds[o + k] ?? 0) - 48 * this.scale;
        const hi = (world.brushBounds[o + k + 3] ?? 0) + 48 * this.scale;
        out[k] = this.snap(lo + this.rng.nextFloat() * (hi - lo));
      }
      return out;
    }
    out[0] = this.coord(0);
    out[1] = this.coord(1);
    out[2] = this.coord(2);
    return out;
  }

  offset(range: number): number {
    return (this.rng.nextFloat() * 2 - 1) * range * this.scale;
  }
}

/** Fills start and end with one of several trace shapes. */
function makeTrace(g: QueryGen, kind: number, prevEnd: Vec3, start: Vec3, end: Vec3): void {
  const rng = g.rng;
  g.next();
  g.point(start);
  switch (kind) {
    case 0: // Short move, the common pmove case.
      for (let k = 0; k < 3; k++) end[k] = (start[k] ?? 0) + g.offset(12);
      break;
    case 1: // Up to 64 per axis: still the short path.
      for (let k = 0; k < 3; k++) end[k] = (start[k] ?? 0) + g.offset(64);
      break;
    case 2: // Long: anywhere in the region (slab path).
      g.point(end);
      break;
    case 3: {
      // Long and axis-aligned: the other axes take the slab's standing-still branch.
      end.set(start);
      const k = rng.nextInt(3);
      end[k] = (start[k] ?? 0) + (rng.nextInt(2) === 0 ? 1 : -1) * (65 + rng.nextFloat() * 2000);
      break;
    }
    case 4: {
      // Long with tiny moves on the other axes, around the standing-still threshold.
      end.set(start);
      const k = rng.nextInt(3);
      end[k] = (start[k] ?? 0) + (rng.nextInt(2) === 0 ? 1 : -1) * (65 + rng.nextFloat() * 1500);
      for (let j = 0; j < 3; j++) {
        if (j !== k) end[j] = (start[j] ?? 0) + (rng.nextInt(2) === 0 ? 1 : -1) * pick(rng, TINY);
      }
      break;
    }
    case 5: // Zero length: a position test through traceBox.
      end.set(start);
      break;
    case 6: // Continue from the last result: starts in the skin, touching, sliding.
      start.set(prevEnd);
      if (rng.nextInt(2) === 0) {
        for (let k = 0; k < 3; k++) end[k] = (start[k] ?? 0) + g.offset(80);
      } else {
        end.set(start);
        const k = rng.nextInt(3);
        end[k] = (start[k] ?? 0) + g.offset(200);
      }
      break;
    case 7: // Straight down onto whatever is below: ground probes and landings.
      end.set(start);
      end[2] = (start[2] ?? 0) - rng.nextFloat() * 300 * g.scale;
      break;
    default: {
      // Long past a brush, drifting toward its face on a minor axis by 1/2048 … 16 from just
      // outside it: the slab test's moving branch, right where a node bound is.
      const world = g.w.world;
      if (world.brushCount === 0) {
        g.point(end);
        break;
      }
      const o = 6 * rng.nextInt(world.brushCount);
      const k = rng.nextInt(3);
      const j = (k + 1 + rng.nextInt(2)) % 3;
      const lo = world.brushBounds[o + j] ?? 0;
      const hi = world.brushBounds[o + j + 3] ?? 0;
      const below = rng.nextInt(2) === 0;
      const gap = rng.nextFloat() * 16 * g.scale;
      const drift = 2 ** (-11 + rng.nextFloat() * 15) * g.scale;
      start[j] = below ? lo - gap : hi + gap;
      end.set(start);
      end[j] = start[j] + (below ? drift : -drift);
      const span = (world.brushBounds[o + k + 3] ?? 0) - (world.brushBounds[o + k] ?? 0);
      const dir = rng.nextInt(2) === 0 ? 1 : -1;
      start[k] =
        (dir > 0 ? (world.brushBounds[o + k] ?? 0) : (world.brushBounds[o + k + 3] ?? 0)) -
        dir * 40;
      end[k] = start[k] + dir * Math.max(65 + rng.nextFloat() * 300, span + 80);
    }
  }
}

describe("BVH queries match brute force bit for bit", () => {
  it.each(WORLDS.map((w, i) => [w.name, w, i] as const))("%s: traceBox", (_name, w, i) => {
    const g = new QueryGen(w, 0x7000 + i);
    const a = new TraceResult();
    const b = new TraceResult();
    const start = v();
    const end = v();
    const prevEnd = v();
    let hits = 0;
    let long = 0;
    const traces = 900;
    for (let n = 0; n < traces; n++) {
      makeTrace(g, g.rng.nextInt(9), prevEnd, start, end);
      const hull = pick(g.rng, HULLS);
      const mask = pick(g.rng, MASKS);
      traceBox(w.world, start, end, hull.mins, hull.maxs, mask, a);
      traceBoxBrute(w.world, start, end, hull.mins, hull.maxs, mask, b);
      const same = traceBits(a).join() === traceBits(b).join();
      if (!same) {
        // Print the failing case before the comparison fails.
        expect({ n, start: [...start], end: [...end], hull, mask, bvh: traceBits(a) }).toEqual({
          n,
          start: [...start],
          end: [...end],
          hull,
          mask,
          bvh: traceBits(b),
        });
      }
      prevEnd.set(b.endpos);
      if (b.fraction < 1 || b.startSolid) hits++;
      for (let k = 0; k < 3; k++) if (Math.abs((end[k] ?? 0) - (start[k] ?? 0)) > 64) long++;
    }
    // The cases exercise both hits and misses, and both traversal paths.
    if (w.world.brushCount > 0) expect(hits).toBeGreaterThan(traces / 10);
    expect(hits).toBeLessThan(traces);
    expect(long).toBeGreaterThan(traces / 10);
  });

  it.each(WORLDS.map((w, i) => [w.name, w, i] as const))(
    "%s: positionTest, positionContents, pointContents, boxContents",
    (_name, w, i) => {
      const g = new QueryGen(w, 0x9000 + i);
      const p = v();
      const q = v();
      const lo = v();
      const hi = v();
      let inside = 0;
      for (let n = 0; n < 400; n++) {
        g.next();
        g.point(p);
        const hull = pick(g.rng, HULLS);
        const mask = pick(g.rng, MASKS);
        const brute = positionContentsBrute(w.world, p, hull.mins, hull.maxs, mask);
        expect(positionContents(w.world, p, hull.mins, hull.maxs, mask)).toBe(brute);
        expect(positionTest(w.world, p, hull.mins, hull.maxs, mask)).toBe(brute === 0);
        expect(pointContents(w.world, p)).toBe(positionContentsBrute(w.world, p, ZERO, ZERO, -1));
        g.point(q);
        for (let k = 0; k < 3; k++) {
          const a = p[k] ?? 0;
          const b = g.rng.nextInt(2) === 0 ? a + g.offset(64) : (q[k] ?? 0);
          lo[k] = Math.min(a, b);
          hi[k] = Math.max(a, b);
        }
        expect(boxContents(w.world, lo, hi)).toBe(boxContentsBrute(w.world, lo, hi));
        if (brute !== 0) inside++;
      }
      if (w.world.brushCount > 0) expect(inside).toBeGreaterThan(0);
    },
  );
});

describe("BVH slab test edge cases", () => {
  // A ray (h = 0) beside box A, whose bounds start at y = 1/16, meets A's grown bound at y = 0
  // exactly, where a subnormal sideways move would make (lo − S′)·(1/Δ) = 0·∞. The cluster far
  // along x gives A a leaf of its own, so the slab test sees A's bounds and not just the root's.
  const world = worldOf(
    brush(boxPlanes([100, 1 / 16, -32], [164, 64, 32])),
    brush(boxPlanes([3000, -64, -32], [3064, 64, 32])),
    brush(boxPlanes([3100, -64, -32], [3164, 64, 32])),
    brush(boxPlanes([3200, -64, -32], [3264, 64, 32])),
  );
  const a = new TraceResult();
  const b = new TraceResult();

  it("gives box A a leaf of its own", () => {
    const bvh = world.bvh;
    expect(bvh.nodeCount[0]).toBe(0);
    expect(bvh.nodeCount[1]).toBe(1);
    expect(bvh.leafRefs[bvh.nodeFirst[1] ?? -1]).toBe(0);
  });

  it.each([5e-324, -5e-324, 1e-310, -1e-310, 1 / 4096, -1 / 4096])(
    "long traces with a sideways move of %s match brute force",
    (dy) => {
      for (const hull of HULLS) {
        for (const y of [0, -1 / 16, 1 / 16, -15, 15]) {
          for (const dir of [1, -1]) {
            const start = v(dir > 0 ? -200 : 700, y, 0);
            const end = v(dir > 0 ? 700 : -200, y + dy, 0);
            traceBox(world, start, end, hull.mins, hull.maxs, -1, a);
            traceBoxBrute(world, start, end, hull.mins, hull.maxs, -1, b);
            expect(traceBits(a)).toEqual(traceBits(b));
          }
        }
      }
    },
  );

  // A path that starts beside A's grown bound and drifts into it: treating that axis as standing
  // still (or pruning A's leaf any other way) would miss the hit.
  it.each([1 / 2048, 1 / 512, 1 / 64, 0.45, 2, 8, 15.5])(
    "long rays drifting %s toward A from just outside its bound hit it",
    (drift) => {
      // A's x range is about a third of the way along: a gap of drift/4 is crossed before it.
      for (const gap of [drift / 16, drift / 4]) {
        for (const dir of [1, -1]) {
          const start = v(dir > 0 ? -200 : 700, 1 / 16 - gap, 0);
          const end = v(dir > 0 ? 700 : -200, 1 / 16 - gap + drift, 0);
          traceBox(world, start, end, ZERO, ZERO, -1, a);
          traceBoxBrute(world, start, end, ZERO, ZERO, -1, b);
          expect(b.brush).toBe(0);
          expect(traceBits(a)).toEqual(traceBits(b));
        }
      }
    },
  );
});

describe("BVH culling", () => {
  // Equal results cannot show culling, so these count the work done (lastQueryNodes/Brushes).
  const a = new TraceResult();

  it.each(["random boxes", "Z-rotated boxes", "mixed shapes", "one huge brush plus many small"])(
    "%s: short queries test few nodes and fewer brushes",
    (name) => {
      const w = WORLDS.find((x) => x.name === name) as TestWorld;
      const g = new QueryGen(w, 0x1234);
      const start = v();
      const end = v();
      let nodes = 0;
      let brushes = 0;
      let posNodes = 0;
      let posBrushes = 0;
      const n = 500;
      for (let i = 0; i < n; i++) {
        makeTrace(g, 0, start, start, end);
        traceBox(w.world, start, end, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID, a);
        nodes += lastQueryNodes();
        brushes += lastQueryBrushes();
        positionContents(w.world, start, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID);
        posNodes += lastQueryNodes();
        posBrushes += lastQueryBrushes();
      }
      // About 9–12 of 59–141 nodes and 0.1–0.3 brushes on average today.
      const totalNodes = w.world.bvh.nodeCount.length;
      expect(nodes / n).toBeLessThan(totalNodes / 4);
      expect(posNodes / n).toBeLessThan(totalNodes / 4);
      expect(brushes / n).toBeLessThan(1);
      expect(posBrushes / n).toBeLessThan(1);
    },
  );

  it("tests each brush of a leaf against the query box before clipping it", () => {
    // Two brushes make one leaf; a query near one of them must not reach the other.
    const world = worldOf(
      brush(boxPlanes([0, 0, 0], [64, 64, 64])),
      brush(boxPlanes([1000, 0, 0], [1064, 64, 64])),
    );
    expect([...world.bvh.nodeCount]).toEqual([2]);
    traceBox(world, v(32, 32, 200), v(32, 32, 60), HULL_MINS, HULL_STANDING_MAXS, -1, a);
    expect([lastQueryNodes(), lastQueryBrushes()]).toEqual([1, 1]);
    expect(positionTest(world, v(1032, 32, 32), ZERO, ZERO, -1)).toBe(false);
    expect([lastQueryNodes(), lastQueryBrushes()]).toEqual([1, 1]);
    expect(boxContents(world, v(500, 0, 0), v(600, 64, 64))).toBe(0);
    expect([lastQueryNodes(), lastQueryBrushes()]).toEqual([1, 0]);
  });

  // A corridor of 32 boxes along x: a long ray down it hits the first box it meets.
  const corridor = worldOf(
    ...Array.from({ length: 32 }, (_, i) =>
      brush(boxPlanes([128 * i, 0, 0], [128 * i + 64, 64, 64])),
    ),
  );

  it.each([1, -1])(
    "a long trace toward %s visits the near side first and prunes what lies behind its hit",
    (dir) => {
      const start = v(dir > 0 ? -100 : 4200, 32, 32);
      const end = v(dir > 0 ? 4200 : -100, 32, 32);
      traceBox(corridor, start, end, ZERO, ZERO, -1, a);
      expect(a.brush).toBe(dir > 0 ? 0 : 31);
      const hitNodes = lastQueryNodes();
      // Only the hit brush's leaf (up to BVH_LEAF_SIZE brushes) is clipped.
      expect(lastQueryBrushes()).toBeLessThanOrEqual(BVH_LEAF_SIZE);
      // The same path with nothing to hit tests every node.
      traceBox(corridor, start, end, ZERO, ZERO, 0, a);
      expect(lastQueryNodes()).toBe(corridor.bvh.nodeCount.length);
      // Root-to-leaf on the near side plus the far siblings it prunes: about 2 per level.
      expect(hitNodes).toBeLessThanOrEqual(2 * depthOf(corridor.bvh) + 1);
    },
  );
});
