import type { Vec3 } from "../../src/math/vec3";
import { buildBrush } from "../../src/world/brushBuild";
import {
  type CollisionBrushSource,
  CollisionWorld,
  createCollisionWorld,
} from "../../src/world/collisionWorld";
import { CONTENTS_SOLID } from "../../src/world/contents";
import type { TraceResult } from "../../src/world/trace";
import { f64ToHex } from "./f64";

/** Small hand-built worlds for trace tests: shapes → buildBrush → createCollisionWorld. */

export function brush(
  facePlanes: Float64Array,
  contents = CONTENTS_SOLID,
  surfaceFlags?: (face: number) => number,
): CollisionBrushSource {
  const b = buildBrush(facePlanes);
  const planeCount = b.planes.length / 4;
  const surf =
    surfaceFlags === undefined
      ? undefined
      : Array.from({ length: planeCount }, (_, p) => (p < b.faceCount ? surfaceFlags(p) : 0));
  return {
    planes: b.planes,
    faceCount: b.faceCount,
    bounds: b.bounds,
    contents,
    ...(surf === undefined ? {} : { surfaceFlags: surf }),
  };
}

/** The same brush with its bevels dropped: what traces would see without them. */
export function withoutBevels(b: CollisionBrushSource): CollisionBrushSource {
  return { ...b, planes: b.planes.slice(0, 4 * b.faceCount), surfaceFlags: undefined };
}

export function worldOf(...brushes: CollisionBrushSource[]): CollisionWorld {
  return createCollisionWorld(brushes);
}

/**
 * Packs brushes without createCollisionWorld's checks, for brushes it refuses, such as ones
 * stripped of their bevels. Only traceBoxBrute is meaningful on such a world: the BVH culls by
 * bounds the brushes no longer respect.
 */
export function uncheckedWorldOf(...brushes: CollisionBrushSource[]): CollisionWorld {
  let planeCount = 0;
  const bounds = new Float64Array(6 * brushes.length);
  brushes.forEach((b, i) => {
    planeCount += b.planes.length / 4;
    bounds.set(b.bounds, 6 * i);
  });
  const world = new CollisionWorld(brushes.length, planeCount, bounds);
  let start = 0;
  brushes.forEach((b, i) => {
    const count = b.planes.length / 4;
    world.brushPlaneStart[i] = start;
    world.brushPlaneCount[i] = count;
    world.brushFaceCount[i] = b.faceCount;
    world.brushContents[i] = b.contents;
    world.planes.set(b.planes, 4 * start);
    if (b.surfaceFlags !== undefined) world.planeSurf.set(Array.from(b.surfaceFlags), start);
    start += count;
  });
  return world;
}

/**
 * The box-expanded distance n·(p + o) − d − Σ|n_k|·h_k of world plane `plane` for the box
 * [mins, maxs] at origin p (M1 design A.2): 0 means touching, ε is a trace's resting distance.
 */
export function expandedDistance(
  world: CollisionWorld,
  plane: number,
  p: Vec3,
  mins: Vec3,
  maxs: Vec3,
): number {
  let f = -(world.planes[4 * plane + 3] as number);
  for (let k = 0; k < 3; k++) {
    const n = world.planes[4 * plane + k] as number;
    const o = ((mins[k] as number) + (maxs[k] as number)) * 0.5;
    const h = ((maxs[k] as number) - (mins[k] as number)) * 0.5;
    f += n * ((p[k] as number) + o) - Math.abs(n) * h;
  }
  return f;
}

/** Every TraceResult field, with doubles as bits, for exact comparisons. */
export function traceBits(r: TraceResult): string[] {
  return [
    f64ToHex(r.fraction),
    ...[...r.endpos, ...r.normal, r.planeDist].map(f64ToHex),
    `${r.plane} ${r.brush} ${r.contents} ${r.surfaceFlags} ${r.entity}`,
    `${r.startSolid} ${r.allSolid}`,
  ];
}
