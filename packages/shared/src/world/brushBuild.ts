import { type Aabb, aabb } from "../math/aabb";
import { polygonize } from "./polygonize";

/**
 * Builds a collision brush from face planes (M1 design B, F): f32-round, polygonize and validate,
 * then add the axial bevels. Build time only (tools compiler, tests); it allocates.
 */

export interface BuiltBrush {
  /** Faces first (input order, redundant planes dropped), then axial bevels; f32 values. */
  readonly planes: Float64Array;
  readonly faceCount: number;
  /** Input plane index of each face. */
  readonly faceSource: Int32Array;
  /** The bevel extents: every vertex lies inside, and every value is an f32. */
  readonly bounds: Aabb;
  /** Welded vertices, xyz each. */
  readonly vertices: Float64Array;
  /** Vertex indices per face, counter-clockwise from outside, canonical start vertex. */
  readonly polygons: readonly Uint32Array[];
}

const f32 = new Float32Array(1);
const f32Bits = new Uint32Array(f32.buffer);

/** The smallest f32 ≥ x (x finite), stepping through the bit pattern when rounding went down. */
export function f32RoundUp(x: number): number {
  const r = Math.fround(x);
  if (r >= x) return r + 0;
  f32[0] = r;
  if (r > 0) f32Bits[0] = (f32Bits[0] as number) + 1;
  else if (r < 0) f32Bits[0] = (f32Bits[0] as number) - 1;
  else f32Bits[0] = 1;
  return (f32[0] as number) + 0;
}

/**
 * Axial bevels are the brush's bounding-box planes, ordered −x, +x, −y, +y, −z, +z. They make the
 * box-expanded plane test exact for every M1 shape. Each goes in after polygonization (a bevel
 * only touches an edge, so it would get an empty polygon) and is skipped when a face already has
 * that exact normal. Bevel distances round outward so the bevel never cuts the brush.
 */
export function buildBrush(facePlanes: Float64Array, label = "brush"): BuiltBrush {
  const poly = polygonize(facePlanes, label);
  const faceCount = poly.planes.length / 4;
  const verts = poly.vertices;
  const bevels: number[] = [];
  const bounds = aabb();
  for (let axis = 0; axis < 3; axis++) {
    for (let sign = -1; sign <= 1; sign += 2) {
      let face = -1;
      for (let f = 0; f < faceCount && face < 0; f++) {
        let exact = true;
        for (let k = 0; k < 3; k++) {
          if (poly.planes[4 * f + k] !== (k === axis ? sign : 0)) exact = false;
        }
        if (exact) face = f;
      }
      let d: number;
      if (face >= 0) {
        d = poly.planes[4 * face + 3] as number;
      } else {
        let extent = Number.NEGATIVE_INFINITY;
        for (let v = axis; v < verts.length; v += 3) {
          const e = sign * (verts[v] as number);
          if (e > extent) extent = e;
        }
        d = f32RoundUp(extent);
        bevels.push(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0, d);
      }
      if (sign < 0) bounds[axis] = -d + 0;
      else bounds[axis + 3] = d;
    }
  }
  const planes = new Float64Array(poly.planes.length + bevels.length);
  planes.set(poly.planes);
  planes.set(bevels, poly.planes.length);
  return {
    planes,
    faceCount,
    faceSource: poly.faceSource,
    bounds,
    vertices: verts,
    polygons: poly.polygons,
  };
}
