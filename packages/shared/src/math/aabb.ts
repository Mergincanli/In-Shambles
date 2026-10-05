import type { Vec3 } from "./vec3";

/** Axis-aligned box as Float64Array(6): [minx, miny, minz, maxx, maxy, maxz]. */
export type Aabb = Float64Array & {
  0: number;
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
};

/** Allocates an empty box: setup-time only. */
export function aabb(): Aabb {
  return aabbMakeEmpty(new Float64Array(6) as Aabb);
}

/** Min +Infinity and max −Infinity, so the first addPoint or union sets the box exactly. */
export function aabbMakeEmpty(out: Aabb): Aabb {
  out[0] = Number.POSITIVE_INFINITY;
  out[1] = Number.POSITIVE_INFINITY;
  out[2] = Number.POSITIVE_INFINITY;
  out[3] = Number.NEGATIVE_INFINITY;
  out[4] = Number.NEGATIVE_INFINITY;
  out[5] = Number.NEGATIVE_INFINITY;
  return out;
}

export function aabbIsEmpty(a: Aabb): boolean {
  return !(a[0] <= a[3] && a[1] <= a[4] && a[2] <= a[5]);
}

export function aabbCopy(out: Aabb, a: Aabb): Aabb {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  out[3] = a[3];
  out[4] = a[4];
  out[5] = a[5];
  return out;
}

export function aabbAddPoint(out: Aabb, p: Vec3): Aabb {
  if (p[0] < out[0]) out[0] = p[0];
  if (p[1] < out[1]) out[1] = p[1];
  if (p[2] < out[2]) out[2] = p[2];
  if (p[0] > out[3]) out[3] = p[0];
  if (p[1] > out[4]) out[4] = p[1];
  if (p[2] > out[5]) out[5] = p[2];
  return out;
}

/** `out` may alias `a` or `b`. */
export function aabbUnion(out: Aabb, a: Aabb, b: Aabb): Aabb {
  out[0] = a[0] < b[0] ? a[0] : b[0];
  out[1] = a[1] < b[1] ? a[1] : b[1];
  out[2] = a[2] < b[2] ? a[2] : b[2];
  out[3] = a[3] > b[3] ? a[3] : b[3];
  out[4] = a[4] > b[4] ? a[4] : b[4];
  out[5] = a[5] > b[5] ? a[5] : b[5];
  return out;
}

/** Closed intervals: boxes that only share a face, edge or corner overlap. */
export function aabbOverlaps(a: Aabb, b: Aabb): boolean {
  return (
    a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2]
  );
}

/** Grows every side by `margin` (shrinks for a negative one). `out` may alias `a`. */
export function aabbExpand(out: Aabb, a: Aabb, margin: number): Aabb {
  out[0] = a[0] - margin;
  out[1] = a[1] - margin;
  out[2] = a[2] - margin;
  out[3] = a[3] + margin;
  out[4] = a[4] + margin;
  out[5] = a[5] + margin;
  return out;
}

/** 2·(dx·dy + dy·dz + dz·dx), the SAH cost weight; 0 for an empty box. */
export function aabbSurfaceArea(a: Aabb): number {
  if (aabbIsEmpty(a)) return 0;
  const dx = a[3] - a[0];
  const dy = a[4] - a[1];
  const dz = a[5] - a[2];
  return 2 * (dx * dy + dy * dz + dz * dx);
}

/** Box center along `axis` (0 = x, 1 = y, 2 = z). */
export function aabbCentroid(a: Aabb, axis: number): number {
  return ((a[axis] as number) + (a[axis + 3] as number)) * 0.5;
}
