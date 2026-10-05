import { ORIGIN_LIMIT } from "../math/quant";
import {
  at,
  BRUSH_NORMAL_EPSILON,
  BRUSH_WELD_EPSILON,
  BrushError,
  distSq,
  fmt,
  VERTEX_PLANE_EPSILON,
  validatePolygons,
} from "./brushValidate";

export {
  BRUSH_MIN_EDGE,
  BRUSH_MIN_VOLUME,
  BRUSH_NORMAL_EPSILON,
  BRUSH_WELD_EPSILON,
  BrushError,
  type BrushErrorCode,
} from "./brushValidate";

/**
 * Turns a brush's face planes (half-spaces n·x ≤ d, outward unit normals, 4 numbers per plane)
 * into welded, validated face polygons (M1 design F). Load and compile time only: it allocates
 * freely, but uses only exact operations plus Math.sqrt (D-016), so every engine produces the
 * same bits.
 *
 * Everything is derived from the planes rounded to f32, the precision cmap stores and the runtime
 * traces against, so polygons, bevels, bounds and render vertices all agree with collision.
 */

/** Half-size of the starting square on each plane: well past the ±16384 u world limit. */
const BASE_HALF_SIZE = 65536;
/** Clip classification band: a vertex this close to a plane counts as on it. */
const CLIP_PLANE_EPSILON = 1e-5;
/** A face smaller than this (u²) means its plane only touches the brush: redundant. */
const MIN_FACE_AREA = 1e-3;
/** Consecutive polygon vertices this close merge; a vertex this close to its neighbours' line goes. */
const MERGE_EPSILON = 1e-4;
/**
 * The largest |d| a face of a brush inside ±ORIGIN_LIMIT can have (the cube corner's distance,
 * plus slack for f32 normals). A plane further out belongs to an out-of-bounds brush whose faces
 * the starting squares may not even reach, so it is reported as that before anything else.
 */
const PLANE_DISTANCE_LIMIT = ORIGIN_LIMIT * Math.sqrt(3) + 1;

export interface PolygonizedBrush {
  /** The non-redundant face planes, f32-rounded, 4 per plane, in input order. */
  readonly planes: Float64Array;
  /** Input plane index of each kept face. */
  readonly faceSource: Int32Array;
  /** Welded vertices, xyz each. */
  readonly vertices: Float64Array;
  /**
   * Vertex indices per kept face: counter-clockwise seen from outside, starting at the face's
   * lexicographically smallest (x, y, z) vertex.
   */
  readonly polygons: readonly Uint32Array[];
}

/** Each value rounded to f32 (nearest-even), with −0 turned into +0. */
export function roundPlanesF32(planes: Float64Array): Float64Array {
  const out = new Float64Array(planes.length);
  for (let i = 0; i < planes.length; i++) out[i] = Math.fround(planes[i] as number) + 0;
  return out;
}

function validateInput(planes: Float64Array, label: string): void {
  if (planes.length % 4 !== 0) {
    throw new BrushError("input", `${label}: plane array length ${planes.length} is not 4·n`);
  }
  const count = planes.length / 4;
  if (count < 4) {
    throw new BrushError("input", `${label}: ${count} planes; a brush needs at least 4`);
  }
  for (let i = 0; i < count; i++) {
    const o = 4 * i;
    const nx = at(planes, o);
    const ny = at(planes, o + 1);
    const nz = at(planes, o + 2);
    const d = at(planes, o + 3);
    if (
      !Number.isFinite(nx) ||
      !Number.isFinite(ny) ||
      !Number.isFinite(nz) ||
      !Number.isFinite(d)
    ) {
      throw new BrushError("input", `${label}: plane ${i} has a non-finite value`);
    }
    const lenSq = nx * nx + ny * ny + nz * nz;
    if (Math.abs(lenSq - 1) > BRUSH_NORMAL_EPSILON) {
      throw new BrushError(
        "input",
        `${label}: plane ${i} normal is not unit length (|n|² = ${lenSq})`,
      );
    }
    if (Math.abs(d) > PLANE_DISTANCE_LIMIT) {
      throw new BrushError(
        "limit",
        `${label}: plane ${i} is ${fmt(Math.abs(d))} u from the origin, too far for a brush inside the ±${ORIGIN_LIMIT} u world limit`,
      );
    }
  }
}

/**
 * A square of half-size BASE_HALF_SIZE centred on the plane. The helper axis is the one with the
 * smallest |n_k|; u = normalize(axis × n) and v = n × u give u × v = n, so the corner order is
 * counter-clockwise seen from outside.
 */
function baseQuad(nx: number, ny: number, nz: number, d: number): number[] {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  let hx = 0;
  let hy = 0;
  let hz = 0;
  if (ax <= ay && ax <= az) hx = 1;
  else if (ay <= az) hy = 1;
  else hz = 1;
  let ux = hy * nz - hz * ny;
  let uy = hz * nx - hx * nz;
  let uz = hx * ny - hy * nx;
  const len = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= len;
  uy /= len;
  uz /= len;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  // The point of the plane nearest the origin. f32 normals are not exactly unit, and at
  // d ≈ 16384 the plain n·d would sit (|n|² − 1)·d ≈ 1e-3 u off the plane.
  const s = d / (nx * nx + ny * ny + nz * nz);
  const cx = nx * s;
  const cy = ny * s;
  const cz = nz * s;
  const h = BASE_HALF_SIZE;
  return [
    cx + h * (ux - vx),
    cy + h * (uy - vy),
    cz + h * (uz - vz),
    cx + h * (ux + vx),
    cy + h * (uy + vy),
    cz + h * (uz + vz),
    cx + h * (-ux + vx),
    cy + h * (-uy + vy),
    cz + h * (-uz + vz),
    cx + h * (-ux - vx),
    cy + h * (-uy - vy),
    cz + h * (-uz - vz),
  ];
}

/**
 * Keeps the part behind or on the plane whose per-vertex distances are `dist`. A crossing point
 * is always interpolated from the edge's first vertex in winding order.
 */
function clipPolygon(poly: number[], dist: number[]): number[] {
  const out: number[] = [];
  const n = dist.length;
  for (let k = 0; k < n; k++) {
    const k2 = k + 1 === n ? 0 : k + 1;
    const dp = at(dist, k);
    const dq = at(dist, k2);
    const p = 3 * k;
    const q = 3 * k2;
    if (dp <= CLIP_PLANE_EPSILON) out.push(at(poly, p), at(poly, p + 1), at(poly, p + 2));
    if (
      (dp > CLIP_PLANE_EPSILON && dq < -CLIP_PLANE_EPSILON) ||
      (dp < -CLIP_PLANE_EPSILON && dq > CLIP_PLANE_EPSILON)
    ) {
      const t = dp / (dp - dq);
      out.push(
        at(poly, p) + (at(poly, q) - at(poly, p)) * t,
        at(poly, p + 1) + (at(poly, q + 1) - at(poly, p + 1)) * t,
        at(poly, p + 2) + (at(poly, q + 2) - at(poly, p + 2)) * t,
      );
    }
  }
  return out;
}

/** Merges near-duplicate consecutive vertices (including last → first). */
function mergeClose(poly: number[]): number[] {
  const out: number[] = [];
  const limit = MERGE_EPSILON * MERGE_EPSILON;
  for (let i = 0; i < poly.length; i += 3) {
    if (out.length > 0 && distSq(poly, i, out, out.length - 3) <= limit) continue;
    out.push(at(poly, i), at(poly, i + 1), at(poly, i + 2));
  }
  while (out.length >= 6 && distSq(out, out.length - 3, out, 0) <= limit) out.length -= 3;
  return out;
}

/** How many kept face planes the polygon vertex at `i` lies on, within VERTEX_PLANE_EPSILON. */
function keptPlanesThrough(
  planes: Float64Array,
  kept: number[],
  poly: number[],
  i: number,
): number {
  let on = 0;
  for (let f = 0; f < kept.length; f++) {
    const o = 4 * at(kept, f);
    const s =
      at(planes, o) * at(poly, i) +
      at(planes, o + 1) * at(poly, i + 1) +
      at(planes, o + 2) * at(poly, i + 2) -
      at(planes, o + 3);
    if (Math.abs(s) <= VERTEX_PLANE_EPSILON) on++;
  }
  return on;
}

/**
 * Removes vertices within MERGE_EPSILON of the line through their neighbours, until none are.
 * Only vertices on fewer than 3 kept faces go: those are leftovers of a redundant plane on an
 * edge. A real corner can look collinear in one face where two faces meet almost flat, and
 * dropping it there alone would leave the faces' edges unmatched.
 */
function removeCollinear(poly: number[], planes: Float64Array, kept: number[]): number[] {
  const out = poly.slice();
  let changed = true;
  while (changed && out.length >= 9) {
    changed = false;
    const n = out.length / 3;
    for (let k = 0; k < n; k++) {
      const a = 3 * (k === 0 ? n - 1 : k - 1);
      const b = 3 * k;
      const c = 3 * (k + 1 === n ? 0 : k + 1);
      const acx = at(out, c) - at(out, a);
      const acy = at(out, c + 1) - at(out, a + 1);
      const acz = at(out, c + 2) - at(out, a + 2);
      const abx = at(out, b) - at(out, a);
      const aby = at(out, b + 1) - at(out, a + 1);
      const abz = at(out, b + 2) - at(out, a + 2);
      const cx = aby * acz - abz * acy;
      const cy = abz * acx - abx * acz;
      const cz = abx * acy - aby * acx;
      const acLenSq = acx * acx + acy * acy + acz * acz;
      // Distance of b from line ac is |ab × ac| / |ac|; compare squares to stay in exact ops.
      if (
        cx * cx + cy * cy + cz * cz <= MERGE_EPSILON * MERGE_EPSILON * acLenSq &&
        keptPlanesThrough(planes, kept, out, b) < 3
      ) {
        out.splice(b, 3);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Signed area along the plane normal: positive for counter-clockwise seen from outside. */
function signedArea(poly: number[], nx: number, ny: number, nz: number): number {
  let sum = 0;
  const x0 = at(poly, 0);
  const y0 = at(poly, 1);
  const z0 = at(poly, 2);
  for (let i = 3; i + 3 < poly.length; i += 3) {
    const ax = at(poly, i) - x0;
    const ay = at(poly, i + 1) - y0;
    const az = at(poly, i + 2) - z0;
    const bx = at(poly, i + 3) - x0;
    const by = at(poly, i + 4) - y0;
    const bz = at(poly, i + 5) - z0;
    sum += nx * (ay * bz - az * by) + ny * (az * bx - ax * bz) + nz * (ax * by - ay * bx);
  }
  return sum * 0.5;
}

/** The face polygon of plane j, or null when j is redundant (outside, touching, or a duplicate). */
function facePolygon(planes: Float64Array, count: number, j: number): number[] | null {
  const oj = 4 * j;
  const nx = at(planes, oj);
  const ny = at(planes, oj + 1);
  const nz = at(planes, oj + 2);
  let poly = baseQuad(nx, ny, nz, at(planes, oj + 3));
  const dist: number[] = [];
  for (let i = 0; i < count; i++) {
    if (i === j) continue;
    const oi = 4 * i;
    const mx = at(planes, oi);
    const my = at(planes, oi + 1);
    const mz = at(planes, oi + 2);
    const md = at(planes, oi + 3);
    dist.length = 0;
    let front = 0;
    let back = 0;
    for (let k = 0; k < poly.length; k += 3) {
      const s = mx * at(poly, k) + my * at(poly, k + 1) + mz * at(poly, k + 2) - md;
      dist.push(s);
      if (s > CLIP_PLANE_EPSILON) front++;
      else if (s < -CLIP_PLANE_EPSILON) back++;
    }
    if (front === 0 && back === 0) {
      // Coplanar. Facing away, the brush has no thickness here; facing the same way, the copies
      // leave each other alone and the later one is dropped in polygonize().
      if (mx * nx + my * ny + mz * nz < 0) return null;
      continue;
    }
    if (front === 0) continue;
    poly = clipPolygon(poly, dist);
    if (poly.length < 9) return null;
  }
  poly = mergeClose(poly);
  if (poly.length < 9 || signedArea(poly, nx, ny, nz) < MIN_FACE_AREA) return null;
  return poly;
}

/** True when an earlier kept face faces the same way and `poly` (of plane j) lies on its plane. */
function duplicatesKeptFace(
  planes: Float64Array,
  kept: number[],
  poly: number[],
  j: number,
): boolean {
  const oj = 4 * j;
  for (let f = 0; f < kept.length; f++) {
    const oi = 4 * at(kept, f);
    const mx = at(planes, oi);
    const my = at(planes, oi + 1);
    const mz = at(planes, oi + 2);
    const md = at(planes, oi + 3);
    if (mx * at(planes, oj) + my * at(planes, oj + 1) + mz * at(planes, oj + 2) <= 0) continue;
    let on = true;
    for (let k = 0; k < poly.length && on; k += 3) {
      const s = mx * at(poly, k) + my * at(poly, k + 1) + mz * at(poly, k + 2) - md;
      on = Math.abs(s) <= CLIP_PLANE_EPSILON;
    }
    if (on) return true;
  }
  return false;
}

/**
 * Puts every vertex on or just outside an exactly axial face onto it. Faces listed before an
 * axial face reach its vertices by interpolating across the starting square, a few ulps off, and
 * the weld keeps those first copies; snapping makes the face distance an exact bound and
 * axis-aligned output exact. Vertices further than VERTEX_PLANE_EPSILON outside are left for
 * validation to reject.
 */
function snapToAxialFaces(planes: Float64Array, verts: number[]): void {
  for (let f = 0; f < planes.length; f += 4) {
    let axis = -1;
    for (let k = 0; k < 3; k++) {
      const n = at(planes, f + k);
      if ((n === 1 || n === -1) && axis < 0) axis = k;
      else if (n !== 0) axis = 3;
    }
    if (axis < 0 || axis > 2) continue;
    const sign = at(planes, f + axis);
    const d = at(planes, f + 3);
    for (let v = axis; v < verts.length; v += 3) {
      const s = sign * at(verts, v) - d;
      if (s >= -CLIP_PLANE_EPSILON && s <= VERTEX_PLANE_EPSILON) verts[v] = sign * d + 0;
    }
  }
}

function lexLess(v: number[], a: number, b: number): boolean {
  const ax = at(v, 3 * a);
  const bx = at(v, 3 * b);
  if (ax !== bx) return ax < bx;
  const ay = at(v, 3 * a + 1);
  const by = at(v, 3 * b + 1);
  if (ay !== by) return ay < by;
  return at(v, 3 * a + 2) < at(v, 3 * b + 2);
}

export function polygonize(facePlanes: Float64Array, label = "brush"): PolygonizedBrush {
  const rounded = roundPlanesF32(facePlanes);
  validateInput(rounded, label);
  const count = rounded.length / 4;

  const faceSource: number[] = [];
  const raw: number[][] = [];
  for (let j = 0; j < count; j++) {
    const poly = facePolygon(rounded, count, j);
    if (poly === null || duplicatesKeptFace(rounded, faceSource, poly, j)) continue;
    faceSource.push(j);
    raw.push(poly);
  }
  const faceCount = faceSource.length;
  // Collinear cleanup needs the final face set, so it runs once every face is known.
  for (let f = 0; f < faceCount; f++) {
    raw[f] = removeCollinear(raw[f] as number[], rounded, faceSource);
  }

  const planes = new Float64Array(4 * faceCount);
  for (let f = 0; f < faceCount; f++) {
    planes.set(rounded.subarray(4 * at(faceSource, f), 4 * at(faceSource, f) + 4), 4 * f);
  }

  // Weld across the brush: the first earlier vertex within BRUSH_WELD_EPSILON wins.
  const verts: number[] = [];
  const weldSq = BRUSH_WELD_EPSILON * BRUSH_WELD_EPSILON;
  const welded: Uint32Array[] = [];
  for (let f = 0; f < faceCount; f++) {
    const poly = raw[f] as number[];
    const n = poly.length / 3;
    const idx = new Uint32Array(n);
    for (let k = 0; k < n; k++) {
      let found = -1;
      for (let v = 0; v < verts.length; v += 3) {
        if (distSq(poly, 3 * k, verts, v) <= weldSq) {
          found = v / 3;
          break;
        }
      }
      if (found < 0) {
        found = verts.length / 3;
        verts.push(at(poly, 3 * k), at(poly, 3 * k + 1), at(poly, 3 * k + 2));
      }
      idx[k] = found;
    }
    welded.push(idx);
  }
  snapToAxialFaces(planes, verts);

  // Canonical start: the lexicographically smallest vertex; rotation keeps the winding.
  const polygons: Uint32Array[] = [];
  for (let f = 0; f < faceCount; f++) {
    const idx = welded[f] as Uint32Array;
    const n = idx.length;
    let start = 0;
    for (let k = 1; k < n; k++) if (lexLess(verts, at(idx, k), at(idx, start))) start = k;
    const rotated = new Uint32Array(n);
    for (let k = 0; k < n; k++) rotated[k] = at(idx, (start + k) % n);
    polygons.push(rotated);
  }

  validatePolygons(label, rounded, planes, faceSource, verts, polygons);
  return {
    planes,
    faceSource: Int32Array.from(faceSource),
    vertices: Float64Array.from(verts),
    polygons,
  };
}
