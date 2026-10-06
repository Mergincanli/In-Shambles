import { readFileSync } from "node:fs";
import {
  boxPlanes,
  buildBrush,
  buildCollisionWorld,
  CONTENTS_LADDER,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  type CollisionBrushSource,
  CollisionWorld,
  createCollisionWorld,
  decodeCmap,
  hash32,
  Mulberry32,
  rotatedBoxPlanes,
  type WedgeRise,
  wedgePlanes,
} from "@game/shared";
import { COURSE_MAP_DIR, COURSES, courseFileName } from "../../src/greybox/courses";
import { fromRoot } from "../../src/paths";
import { type OracleBrush, oracleBrushes } from "./oracle";

/**
 * Worlds the fuzz test runs in: the committed courses as the game loads them, and synthetic
 * piles of the M1 shapes built through buildBrush + createCollisionWorld. A synthetic world is
 * a pure function of its seed, so a failure names it as "synthetic:<seed>" and a regression test
 * rebuilds it.
 */

export interface FuzzWorld {
  readonly name: string;
  readonly world: CollisionWorld;
  readonly brushes: readonly OracleBrush[];
  /** Union of the brush extents, for random starts. */
  readonly lo: readonly [number, number, number];
  readonly hi: readonly [number, number, number];
  /** Brushes with two opposite faces at most 4 u apart: slabs for long traces to aim through. */
  readonly thin: readonly number[];
}

export const COURSE_NAMES: readonly string[] = COURSES.map((c) => c.name);

function fuzzWorld(name: string, world: CollisionWorld): FuzzWorld {
  const brushes = oracleBrushes(world);
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of brushes) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k] as number, b.extent[k] as number);
      hi[k] = Math.max(hi[k] as number, b.extent[k + 3] as number);
    }
  }
  const thin: number[] = [];
  for (const b of brushes) if (thinFace(b) >= 0) thin.push(b.index);
  return { name, world, brushes, lo, hi, thin };
}

/** A face whose opposite face (normal −n) lies at most 4 u behind it, or −1. */
export function thinFace(b: OracleBrush): number {
  const f = b.faces;
  for (let i = 0; i < f.length; i += 4) {
    for (let j = 0; j < f.length; j += 4) {
      if (
        f[j] === -(f[i] as number) &&
        f[j + 1] === -(f[i + 1] as number) &&
        f[j + 2] === -(f[i + 2] as number) &&
        (f[i + 3] as number) + (f[j + 3] as number) <= 4.001
      ) {
        return i / 4;
      }
    }
  }
  return -1;
}

const cache = new Map<string, FuzzWorld>();

/** A course from content/maps, or "synthetic:<seed>" (decimal or 0x hex). */
export function loadFuzzWorld(name: string): FuzzWorld {
  let w = cache.get(name);
  if (w !== undefined) return w;
  if (name.startsWith("synthetic:")) {
    w = fuzzWorld(name, createCollisionWorld(syntheticBrushes(Number(name.slice(10)))));
  } else {
    const bytes = readFileSync(fromRoot(...COURSE_MAP_DIR, courseFileName(name)));
    w = fuzzWorld(name, buildCollisionWorld(decodeCmap(new Uint8Array(bytes))));
  }
  cache.set(name, w);
  return w;
}

export function syntheticName(seed: number): string {
  return `synthetic:0x${(seed >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * The names of the `count` synthetic worlds a fuzz run with `seed` uses. Every fifth is one placed
 * far out, so each run has coordinates whose f32 steps exceed τ (where a mis-rounded bevel shows).
 */
export function syntheticWorldNames(seed: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = hash32(seed, 0x3d, i, 0);
    for (let j = 1; i % 5 === 0 && !isFarSeed(s); j++) s = hash32(seed, 0x3d, i, j);
    out.push(syntheticName(s));
  }
  return out;
}

/** Whether synthetic world `seed` sits far from the origin (Gen's first draw). */
function isFarSeed(seed: number): boolean {
  return new Mulberry32(seed).nextFloat() < FAR_SHARE;
}

/** Share of synthetic seeds placed up to ±12000 u out. */
const FAR_SHARE = 0.2;

/** The synthetic world kinds, chosen by seed. */
export const SYNTHETIC_KINDS = ["pile", "abutting", "tiles", "slabs", "rotated"] as const;

const RISES: readonly WedgeRise[] = ["+x", "-x", "+y", "-y"];

class Gen {
  readonly rng: Mulberry32;
  /** Added to every coordinate: most worlds sit near the origin, some far out (f32 coarse). */
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly out: CollisionBrushSource[] = [];

  constructor(seed: number) {
    this.rng = new Mulberry32(seed);
    const far = this.rng.nextFloat() < FAR_SHARE;
    this.ox = far ? this.int(-12000, 12000) : 0;
    this.oy = far ? this.int(-12000, 12000) : 0;
    this.oz = far ? this.int(-4000, 4000) : 0;
  }

  f(): number {
    return this.rng.nextFloat();
  }

  int(lo: number, hi: number): number {
    return lo + this.rng.nextInt(hi - lo + 1);
  }

  /** A coordinate in [lo, hi): an integer, a 1/32 grid value or an arbitrary double. */
  coord(lo: number, hi: number): number {
    const r = this.f();
    const x = lo + this.f() * (hi - lo);
    if (r < 0.5) return Math.round(x);
    if (r < 0.8) return Math.round(x * 32) / 32;
    return x;
  }

  contents(): number {
    const r = this.f();
    if (r < 0.85) return CONTENTS_SOLID;
    if (r < 0.9) return CONTENTS_PLAYERCLIP;
    if (r < 0.95) return CONTENTS_WATER;
    if (r < 0.98) return CONTENTS_LADDER;
    return CONTENTS_SOLID | CONTENTS_LADDER;
  }

  add(planes: Float64Array, contents = this.contents()): void {
    const b = buildBrush(planes, `synthetic brush ${this.out.length}`);
    this.out.push({ planes: b.planes, faceCount: b.faceCount, bounds: b.bounds, contents });
  }

  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, c?: number): void {
    const min = [this.ox + x, this.oy + y, this.oz + z] as const;
    this.add(boxPlanes(min, [min[0] + sx, min[1] + sy, min[2] + sz]), c);
  }

  /** A unit (cos, sin): random, or one of the course-style closed forms. */
  angle(): [number, number] {
    const r = this.f();
    if (r < 0.15) return [0.8, 0.6];
    if (r < 0.3) return [(Math.sqrt(6) + Math.sqrt(2)) / 4, (Math.sqrt(6) - Math.sqrt(2)) / 4];
    if (r < 0.4) return [Math.SQRT1_2, Math.SQRT1_2];
    const a = this.f() * 2 - 1;
    const b = this.f() * 2 - 1;
    const len = Math.sqrt(a * a + b * b);
    return len < 0.1 ? [0.6, -0.8] : [a / len, b / len];
  }

  rotated(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
    const [c, s] = this.angle();
    this.add(rotatedBoxPlanes([this.ox + cx, this.oy + cy, this.oz + cz], [hx, hy, hz], c, s));
  }

  wedge(x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
    const min = [this.ox + x, this.oy + y, this.oz + z] as const;
    const rise = RISES[this.rng.nextInt(4)] as WedgeRise;
    this.add(wedgePlanes(min, [min[0] + sx, min[1] + sy, min[2] + sz], rise));
  }

  randomShape(): void {
    const r = this.f();
    const x = this.coord(-256, 256);
    const y = this.coord(-256, 256);
    const z = this.coord(-32, 128);
    if (r < 0.4) {
      this.box(x, y, z, this.coord(1, 192), this.coord(1, 192), this.coord(1, 128));
    } else if (r < 0.7) {
      this.rotated(x, y, z, this.coord(1, 96), this.coord(1, 96), this.coord(1, 64));
    } else {
      this.wedge(x, y, z, this.coord(8, 256), this.coord(8, 256), this.coord(4, 160));
    }
  }

  floor(): void {
    this.box(-512, -512, -64, 1024, 1024, 64, CONTENTS_SOLID);
  }
}

/** The brushes of synthetic world `seed`. Deterministic: the same seed gives the same bits. */
export function syntheticBrushes(seed: number): CollisionBrushSource[] {
  const g = new Gen(seed);
  const kind = SYNTHETIC_KINDS[g.rng.nextInt(SYNTHETIC_KINDS.length)];
  if (kind === "pile") {
    g.floor();
    const n = g.int(3, 12);
    for (let i = 0; i < n; i++) g.randomShape();
  } else if (kind === "abutting") {
    // Pairs sharing a face exactly, and one stacked on the other.
    const n = g.int(2, 5);
    for (let i = 0; i < n; i++) {
      const x = g.coord(-256, 256);
      const y = g.coord(-256, 256);
      const z = g.coord(-32, 64);
      const sx = g.coord(1, 128);
      const sy = g.coord(1, 128);
      const sz = g.coord(1, 96);
      g.box(x, y, z, sx, sy, sz);
      const axis = g.rng.nextInt(3);
      const tx = g.coord(1, 128);
      if (axis === 0) g.box(x + sx, y + g.coord(-32, 32), z, tx, sy, sz);
      else if (axis === 1) g.box(x, y + sy, z + g.coord(-16, 16), sx, tx, sz);
      else g.box(x + g.coord(-16, 16), y, z + sz, sx, sy, tx);
    }
    if (g.f() < 0.5) g.floor();
  } else if (kind === "tiles") {
    // Coplanar floor tiles, some with a wall or step on them.
    const size = [16, 32, 64, 128][g.rng.nextInt(4)] as number;
    const nx = g.int(2, 6);
    const ny = g.int(2, 6);
    const top = g.coord(-16, 16);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) g.box(i * size - 192, j * size - 192, top - 16, size, size, 16);
    }
    const extra = g.int(0, 3);
    for (let i = 0; i < extra; i++) g.randomShape();
  } else if (kind === "slabs") {
    // Thin slabs (1–4 u) for long traces to try to pass through.
    g.floor();
    const n = g.int(2, 8);
    for (let i = 0; i < n; i++) {
      const t = g.f() < 0.5 ? g.int(1, 4) : 1 + g.f() * 3;
      const axis = g.rng.nextInt(4);
      const x = g.coord(-384, 384);
      const y = g.coord(-384, 384);
      const z = g.coord(0, 128);
      if (axis === 0) g.box(x, y, z, t, g.coord(32, 512), g.coord(32, 256));
      else if (axis === 1) g.box(x, y, z, g.coord(32, 512), t, g.coord(32, 256));
      else if (axis === 2) g.box(x, y, z, g.coord(32, 512), g.coord(32, 512), t);
      else g.rotated(x, y, z + 64, g.coord(32, 256), t / 2, g.coord(32, 128));
    }
  } else {
    // Rotated walls and slopes only: the planes snapping can drift into (M1 design A.9).
    g.floor();
    const n = g.int(2, 8);
    for (let i = 0; i < n; i++) {
      const x = g.coord(-384, 384);
      const y = g.coord(-384, 384);
      if (g.f() < 0.5) g.rotated(x, y, 64, g.coord(16, 256), g.coord(4, 32), g.coord(64, 128));
      else g.wedge(x, y, 0, g.coord(32, 512), g.coord(32, 512), g.coord(16, 256));
    }
  }
  return g.out;
}

/**
 * The same world with every bevel moved `delta` outward, bounds included: the "misplaced bevel"
 * mutation P2 and P4 must catch, with the oracle rebuilt from the mutated planes the way the
 * fuzz test builds it.
 */
export function withBevelsPushed(w: FuzzWorld, delta: number): FuzzWorld {
  const src = w.world;
  const planes = src.planes.slice();
  const bounds = src.brushBounds.slice();
  for (let b = 0; b < src.brushCount; b++) {
    const first = src.brushPlaneStart[b] as number;
    const last = first + (src.brushPlaneCount[b] as number);
    for (let p = first + (src.brushFaceCount[b] as number); p < last; p++) {
      const d = (planes[4 * p + 3] as number) + delta;
      planes[4 * p + 3] = d;
      for (let k = 0; k < 3; k++) {
        if (planes[4 * p + k] === 1) bounds[6 * b + k + 3] = d;
        if (planes[4 * p + k] === -1) bounds[6 * b + k] = -d;
      }
    }
  }
  const world = new CollisionWorld(src.brushCount, src.planeCount, bounds);
  world.planes.set(planes);
  world.planeSurf.set(src.planeSurf);
  world.brushPlaneStart.set(src.brushPlaneStart);
  world.brushPlaneCount.set(src.brushPlaneCount);
  world.brushFaceCount.set(src.brushFaceCount);
  world.brushContents.set(src.brushContents);
  return { ...w, name: `${w.name} with bevels pushed`, world, brushes: oracleBrushes(world) };
}

/**
 * The same world with every bevel dropped: the "drop a bevel" mutation the no-phantom-hit
 * property must catch. Only traceBoxBrute is meaningful on it: the BVH culls by bounds the
 * brushes no longer guarantee.
 */
export function withoutBevels(w: FuzzWorld): FuzzWorld {
  const src = w.world;
  let planeCount = 0;
  for (let b = 0; b < src.brushCount; b++) planeCount += src.brushFaceCount[b] as number;
  const world = new CollisionWorld(src.brushCount, planeCount, src.brushBounds.slice());
  let start = 0;
  for (let b = 0; b < src.brushCount; b++) {
    const first = src.brushPlaneStart[b] as number;
    const faces = src.brushFaceCount[b] as number;
    world.brushPlaneStart[b] = start;
    world.brushPlaneCount[b] = faces;
    world.brushFaceCount[b] = faces;
    world.brushContents[b] = src.brushContents[b] as number;
    world.planes.set(src.planes.subarray(4 * first, 4 * (first + faces)), 4 * start);
    world.planeSurf.set(src.planeSurf.subarray(first, first + faces), start);
    start += faces;
  }
  return { ...w, name: `${w.name} without bevels`, world };
}
