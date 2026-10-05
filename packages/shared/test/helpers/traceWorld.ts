import type { Vec3 } from "../../src/math/vec3";
import { buildBrush } from "../../src/world/brushBuild";
import {
  type CollisionBrushSource,
  type CollisionWorld,
  createCollisionWorld,
} from "../../src/world/collisionWorld";
import { CONTENTS_SOLID } from "../../src/world/contents";

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
