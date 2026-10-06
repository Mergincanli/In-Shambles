import { ORIGIN_LIMIT } from "../math/quant";
import { BRUSH_NORMAL_EPSILON } from "./brushValidate";
import { type Bvh, buildBvh } from "./bvh";
import { CONTENTS_KNOWN, FOOTSTEP_COUNT, SURF_KNOWN, surfaceFootstep } from "./contents";

/** One brush as a loader hands it over: a cmap record, or buildBrush() output plus contents. */
export interface CollisionBrushSource {
  /** nx, ny, nz, d per plane: faces first, then bevels. Every value must be an f32. */
  readonly planes: Float32Array | Float64Array;
  readonly faceCount: number;
  /**
   * [minx, miny, minz, maxx, maxy, maxz], f32 values within ±ORIGIN_LIMIT: exactly the distances
   * of the brush's six axial planes (faces or bevels), as buildBrush emits them. The BVH culls by
   * these bounds, so a brush reaching past them would make traceBox and traceBoxBrute disagree;
   * createCollisionWorld refuses any other bounds.
   */
  readonly bounds: Float32Array | Float64Array;
  /** CONTENTS_* bits, at least one. */
  readonly contents: number;
  /** SURF_* bits, one per plane (bevels 0). Omitted means all 0. */
  readonly surfaceFlags?: ArrayLike<number>;
}

/** Most planes one brush may have (brushPlaneCount is a Uint16Array). */
export const MAX_BRUSH_PLANES = 0xffff;

/** Invalid input to createCollisionWorld: a broken map file or a compiler bug. */
export class CollisionWorldError extends Error {
  override name = "CollisionWorldError";
}

/**
 * The static brush world in flat typed arrays (M1 design C), the layout traces walk. Planes are
 * f32 values widened exactly to f64, so every engine traces against the same numbers (A.8).
 * Fields are assigned in declaration order so every world has one hidden class.
 */
export class CollisionWorld {
  readonly brushCount: number;
  readonly planeCount: number;
  /** 4 per plane: nx, ny, nz, d (n·x ≤ d is inside). Each brush's faces come before its bevels. */
  readonly planes: Float64Array;
  /** SURF_* bits per plane. */
  readonly planeSurf: Uint32Array;
  readonly brushPlaneStart: Uint32Array;
  readonly brushPlaneCount: Uint16Array;
  readonly brushFaceCount: Uint16Array;
  readonly brushContents: Uint32Array;
  /** 6 per brush: minx, miny, minz, maxx, maxy, maxz. */
  readonly brushBounds: Float64Array;
  /** Built over brushBounds in the constructor, so it always matches them. */
  readonly bvh: Bvh;

  /** `brushBounds` (6 per brush) is final: the BVH is built over it here. */
  constructor(brushCount: number, planeCount: number, brushBounds: Float64Array) {
    if (brushBounds.length !== 6 * brushCount) {
      throw new CollisionWorldError(
        `${brushBounds.length} bounds values for ${brushCount} brushes`,
      );
    }
    this.brushCount = brushCount;
    this.planeCount = planeCount;
    this.planes = new Float64Array(4 * planeCount);
    this.planeSurf = new Uint32Array(planeCount);
    this.brushPlaneStart = new Uint32Array(brushCount);
    this.brushPlaneCount = new Uint16Array(brushCount);
    this.brushFaceCount = new Uint16Array(brushCount);
    this.brushContents = new Uint32Array(brushCount);
    this.brushBounds = brushBounds;
    this.bvh = buildBvh(brushBounds, brushCount);
  }
}

function isF32(x: number): boolean {
  return Number.isFinite(x) && Math.fround(x) === x;
}

/**
 * Checks one brush against createCollisionWorld's rules and returns its plane count; throws
 * CollisionWorldError naming brush `i`. Loaders call it to reject a file before building anything.
 */
export function validateCollisionBrush(b: CollisionBrushSource, i: number): number {
  const fail = (what: string): never => {
    throw new CollisionWorldError(`brush ${i}: ${what}`);
  };
  if (b.planes.length % 4 !== 0) fail(`plane array length ${b.planes.length} is not 4·n`);
  const planeCount = b.planes.length / 4;
  if (planeCount > MAX_BRUSH_PLANES) fail(`${planeCount} planes, more than ${MAX_BRUSH_PLANES}`);
  if (!Number.isInteger(b.faceCount) || b.faceCount < 4 || b.faceCount > planeCount) {
    fail(`faceCount ${b.faceCount} must be an integer in 4…${planeCount} (the plane count)`);
  }
  for (let p = 0; p < planeCount; p++) {
    const o = 4 * p;
    const nx = b.planes[o] as number;
    const ny = b.planes[o + 1] as number;
    const nz = b.planes[o + 2] as number;
    if (!isF32(nx) || !isF32(ny) || !isF32(nz) || !isF32(b.planes[o + 3] as number)) {
      fail(`plane ${p} has a value that is not a finite f32`);
    }
    if (Math.abs(nx * nx + ny * ny + nz * nz - 1) > BRUSH_NORMAL_EPSILON) {
      fail(`plane ${p} normal is not unit length`);
    }
  }
  if (b.bounds.length !== 6) fail(`bounds has ${b.bounds.length} values, not 6`);
  for (let k = 0; k < 6; k++) {
    const v = b.bounds[k] as number;
    if (!isF32(v) || Math.abs(v) > ORIGIN_LIMIT) {
      fail(`bounds value ${k} is not an f32 within ±${ORIGIN_LIMIT}`);
    }
  }
  for (let k = 0; k < 3; k++) {
    if (!((b.bounds[k] as number) <= (b.bounds[k + 3] as number)))
      fail(`bounds min > max on axis ${k}`);
  }
  // The BVH contract: every axial side of the bounds is a plane of the brush.
  for (let k = 0; k < 6; k++) {
    const axis = k % 3;
    const sign = k < 3 ? -1 : 1;
    const d = sign * (b.bounds[k] as number);
    let found = false;
    for (let p = 0; p < planeCount && !found; p++) {
      const o = 4 * p;
      found =
        b.planes[o + axis] === sign &&
        b.planes[o + ((axis + 1) % 3)] === 0 &&
        b.planes[o + ((axis + 2) % 3)] === 0 &&
        b.planes[o + 3] === d;
    }
    if (!found)
      fail(
        `bounds value ${k} is not the distance of a ${sign < 0 ? "−" : "+"}${"xyz"[axis]} plane`,
      );
  }
  const c = b.contents;
  if (!Number.isInteger(c) || c <= 0 || c > 0xffffffff || (c & ~CONTENTS_KNOWN) !== 0) {
    fail(`contents ${c} must be a non-zero set of known CONTENTS_* bits`);
  }
  const surf = b.surfaceFlags;
  if (surf !== undefined) {
    if (surf.length !== planeCount) fail(`${surf.length} surface flags for ${planeCount} planes`);
    for (let p = 0; p < planeCount; p++) {
      const s = surf[p] as number;
      if (!Number.isInteger(s) || s < 0 || s > 0xffffffff || (s & ~SURF_KNOWN) !== 0) {
        fail(`plane ${p} surface flags ${s} have unknown bits`);
      }
      if (surfaceFootstep(s) >= FOOTSTEP_COUNT) fail(`plane ${p} has unknown footstep material`);
      if (p >= b.faceCount && s !== 0) fail(`bevel plane ${p} has surface flags ${s}, not 0`);
    }
  }
  return planeCount;
}

/**
 * Packs validated brushes into a CollisionWorld, keeping their order (brush index = input index,
 * which traces use to break ties), and builds the BVH. Throws CollisionWorldError on invalid
 * input: this runs at map load, never per tick.
 */
export function createCollisionWorld(brushes: readonly CollisionBrushSource[]): CollisionWorld {
  let planeCount = 0;
  for (let i = 0; i < brushes.length; i++) {
    planeCount += validateCollisionBrush(brushes[i] as CollisionBrushSource, i);
  }
  if (planeCount > 0xffffffff) throw new CollisionWorldError(`${planeCount} planes in total`);
  const bounds = new Float64Array(6 * brushes.length);
  for (let i = 0; i < brushes.length; i++) {
    const b = brushes[i] as CollisionBrushSource;
    for (let k = 0; k < 6; k++) bounds[6 * i + k] = (b.bounds[k] as number) + 0;
  }
  const world = new CollisionWorld(brushes.length, planeCount, bounds);
  let start = 0;
  for (let i = 0; i < brushes.length; i++) {
    const b = brushes[i] as CollisionBrushSource;
    const count = b.planes.length / 4;
    world.brushPlaneStart[i] = start;
    world.brushPlaneCount[i] = count;
    world.brushFaceCount[i] = b.faceCount;
    world.brushContents[i] = b.contents;
    for (let k = 0; k < 4 * count; k++) world.planes[4 * start + k] = (b.planes[k] as number) + 0;
    const surf = b.surfaceFlags;
    if (surf !== undefined) {
      for (let p = 0; p < count; p++) world.planeSurf[start + p] = surf[p] as number;
    }
    start += count;
  }
  return world;
}
