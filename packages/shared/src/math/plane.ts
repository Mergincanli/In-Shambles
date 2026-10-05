import type { Vec3 } from "./vec3";

/**
 * Planes are 4 consecutive Float64Array entries [nx, ny, nz, d] describing n·x = d, with the
 * normal pointing out of the solid side (docs/07). The collision world packs every plane into
 * one array, so helpers take the array plus the plane's offset; a lone plane is offset 0 of a
 * Float64Array(4).
 */
export const PLANE_STRIDE = 4;

export function planeSet(
  planes: Float64Array,
  offset: number,
  nx: number,
  ny: number,
  nz: number,
  d: number,
): void {
  planes[offset] = nx;
  planes[offset + 1] = ny;
  planes[offset + 2] = nz;
  planes[offset + 3] = d;
}

/** Signed distance n·p − d: positive in front (outside), negative behind. */
export function planeDistance(planes: Float64Array, offset: number, p: Vec3): number {
  return (
    (planes[offset] as number) * p[0] +
    (planes[offset + 1] as number) * p[1] +
    (planes[offset + 2] as number) * p[2] -
    (planes[offset + 3] as number)
  );
}

/**
 * How far a box with half extents (hx, hy, hz) reaches along the normal: Σ|n_k|·h_k. Moving the
 * plane out by this much turns a box test into a point test.
 */
export function planeBoxExtent(
  planes: Float64Array,
  offset: number,
  hx: number,
  hy: number,
  hz: number,
): number {
  return (
    Math.abs(planes[offset] as number) * hx +
    Math.abs(planes[offset + 1] as number) * hy +
    Math.abs(planes[offset + 2] as number) * hz
  );
}
