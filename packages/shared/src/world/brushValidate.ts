import { ORIGIN_LIMIT } from "../math/quant";

/**
 * Brush build errors, thresholds and the final validation pass (M1 design F.5). Build time only.
 * polygonize.ts re-exports the public names; validatePolygons stays out of the package index and
 * is exported only so tests can feed it broken topology that polygonize never produces.
 */

/** Vertices of different faces this close are one vertex (docs/07 §4.3). */
export const BRUSH_WELD_EPSILON = 1 / 64;
/** Shortest legal edge: 8× the weld distance, so welding never merges the two ends of an edge. */
export const BRUSH_MIN_EDGE = 1 / 8;
/** Smallest legal brush volume in u³; the brush must be strictly larger. */
export const BRUSH_MIN_VOLUME = 1;
/** A vertex must lie this close to its planes and no further outside any other plane. */
export const VERTEX_PLANE_EPSILON = 1e-4;
/** f32 rounding moves |n|² by about 1e-7; anything further off is not a unit normal. */
export const BRUSH_NORMAL_EPSILON = 1e-5;

export type BrushErrorCode = "input" | "faces" | "edge" | "open" | "vertex" | "limit" | "volume";

/** A brush that cannot be built. `code` names the failed check; the message says what and where. */
export class BrushError extends Error {
  override name = "BrushError";
  readonly code: BrushErrorCode;

  constructor(code: BrushErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function at(a: ArrayLike<number>, i: number): number {
  return a[i] as number;
}

export function fmt(x: number): string {
  return String(Math.round(x * 1e6) / 1e6);
}

export function fmtPoint(v: ArrayLike<number>, i: number): string {
  return `(${fmt(at(v, i))}, ${fmt(at(v, i + 1))}, ${fmt(at(v, i + 2))})`;
}

export function distSq(a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number): number {
  const dx = at(a, i) - at(b, j);
  const dy = at(a, i + 1) - at(b, j + 1);
  const dz = at(a, i + 2) - at(b, j + 2);
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Checks welded polygons: edge lengths, closure (every edge once in each direction), Euler,
 * vertices on ≥ 3 faces and inside every input plane, the world limit and the volume.
 * `allPlanes` are all f32-rounded input planes, `planes` the kept faces (one per polygon).
 */
export function validatePolygons(
  label: string,
  allPlanes: Float64Array,
  planes: Float64Array,
  faceSource: ArrayLike<number>,
  verts: ArrayLike<number>,
  polygons: readonly Uint32Array[],
): void {
  const vertexCount = verts.length / 3;
  const minEdgeSq = BRUSH_MIN_EDGE * BRUSH_MIN_EDGE;

  if (polygons.length < 4) {
    throw new BrushError(
      "faces",
      `${label}: only ${polygons.length} non-redundant faces; the planes enclose no volume`,
    );
  }

  for (let f = 0; f < polygons.length; f++) {
    const poly = polygons[f] as Uint32Array;
    for (let k = 0; k < poly.length; k++) {
      const a = at(poly, k);
      const b = at(poly, (k + 1) % poly.length);
      if (a === b) {
        throw new BrushError(
          "edge",
          `${label}: face ${at(faceSource, f)} has an edge at ${fmtPoint(verts, 3 * a)} under the ${BRUSH_WELD_EPSILON} u weld distance, shorter than the ${BRUSH_MIN_EDGE} u minimum`,
        );
      }
      if (distSq(verts, 3 * a, verts, 3 * b) < minEdgeSq) {
        throw new BrushError(
          "edge",
          `${label}: face ${at(faceSource, f)} has an edge of ${fmt(Math.sqrt(distSq(verts, 3 * a, verts, 3 * b)))} u from ${fmtPoint(verts, 3 * a)}, shorter than the ${BRUSH_MIN_EDGE} u minimum`,
        );
      }
      for (let m = k + 2; m < poly.length; m++) {
        if (at(poly, m) === a && !(k === 0 && m === poly.length - 1)) {
          throw new BrushError(
            "vertex",
            `${label}: face ${at(faceSource, f)} has two vertices near ${fmtPoint(verts, 3 * a)} closer than the ${BRUSH_WELD_EPSILON} u weld distance but not joined by an edge`,
          );
        }
      }
    }
  }

  // Closed and consistently wound: every edge appears once in each direction.
  const directed = new Map<number, number>();
  for (let f = 0; f < polygons.length; f++) {
    const poly = polygons[f] as Uint32Array;
    for (let k = 0; k < poly.length; k++) {
      const a = at(poly, k);
      const b = at(poly, (k + 1) % poly.length);
      const key = a * vertexCount + b;
      if (directed.has(key)) {
        throw new BrushError(
          "open",
          `${label}: edge ${fmtPoint(verts, 3 * a)} → ${fmtPoint(verts, 3 * b)} is used twice in the same direction (overlapping faces?)`,
        );
      }
      directed.set(key, f);
    }
  }
  for (const key of directed.keys()) {
    const a = Math.floor(key / vertexCount);
    const b = key % vertexCount;
    if (!directed.has(b * vertexCount + a)) {
      throw new BrushError(
        "open",
        `${label}: edge ${fmtPoint(verts, 3 * a)} → ${fmtPoint(verts, 3 * b)} belongs to face ${at(faceSource, directed.get(key) as number)} only; the brush is open`,
      );
    }
  }
  const edgeCount = directed.size / 2;
  const euler = vertexCount - edgeCount + polygons.length;
  if (euler !== 2) {
    throw new BrushError(
      "open",
      `${label}: V − E + F = ${vertexCount} − ${edgeCount} + ${polygons.length} = ${euler}, not 2`,
    );
  }

  for (let v = 0; v < vertexCount; v++) {
    const x = at(verts, 3 * v);
    const y = at(verts, 3 * v + 1);
    const z = at(verts, 3 * v + 2);
    let on = 0;
    for (let f = 0; f < planes.length; f += 4) {
      const s =
        at(planes, f) * x + at(planes, f + 1) * y + at(planes, f + 2) * z - at(planes, f + 3);
      if (Math.abs(s) <= VERTEX_PLANE_EPSILON) on++;
    }
    if (on < 3) {
      throw new BrushError(
        "vertex",
        `${label}: vertex ${fmtPoint(verts, 3 * v)} lies on ${on} face planes, fewer than 3`,
      );
    }
    for (let p = 0; p < allPlanes.length; p += 4) {
      const s =
        at(allPlanes, p) * x +
        at(allPlanes, p + 1) * y +
        at(allPlanes, p + 2) * z -
        at(allPlanes, p + 3);
      if (s > VERTEX_PLANE_EPSILON) {
        throw new BrushError(
          "vertex",
          `${label}: vertex ${fmtPoint(verts, 3 * v)} is ${fmt(s)} u outside plane ${p / 4}`,
        );
      }
    }
    if (Math.abs(x) > ORIGIN_LIMIT || Math.abs(y) > ORIGIN_LIMIT || Math.abs(z) > ORIGIN_LIMIT) {
      throw new BrushError(
        "limit",
        `${label}: vertex ${fmtPoint(verts, 3 * v)} is outside the ±${ORIGIN_LIMIT} u world limit`,
      );
    }
  }

  // Divergence theorem over fan triangles, relative to vertex 0 to keep the terms small.
  const rx = at(verts, 0);
  const ry = at(verts, 1);
  const rz = at(verts, 2);
  let six = 0;
  for (let f = 0; f < polygons.length; f++) {
    const poly = polygons[f] as Uint32Array;
    const a = 3 * at(poly, 0);
    const ax = at(verts, a) - rx;
    const ay = at(verts, a + 1) - ry;
    const az = at(verts, a + 2) - rz;
    for (let k = 1; k + 1 < poly.length; k++) {
      const b = 3 * at(poly, k);
      const c = 3 * at(poly, k + 1);
      const bx = at(verts, b) - rx;
      const by = at(verts, b + 1) - ry;
      const bz = at(verts, b + 2) - rz;
      const cx = at(verts, c) - rx;
      const cy = at(verts, c + 1) - ry;
      const cz = at(verts, c + 2) - rz;
      six += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }
  }
  const volume = six / 6;
  if (!(volume > BRUSH_MIN_VOLUME)) {
    throw new BrushError(
      "volume",
      `${label}: volume ${fmt(volume)} u³ is not above the ${BRUSH_MIN_VOLUME} u³ minimum`,
    );
  }
}
