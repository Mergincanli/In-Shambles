import { type CollisionWorld, polygonize } from "@game/shared";

/**
 * The fuzz oracle (M1 design G): exact separation between a swept box and a brush by the
 * separating axis theorem, computed from the brush's polygonized vertices rather than from the
 * box-expanded planes the trace uses, so it shares no reasoning with the code under test. The
 * vertices come from polygonize() on the same f32 planes the runtime traces against; the
 * triple-plane cross-check (vertexSetMismatch) guards that source.
 *
 * The axis set is complete for a box swept along d against a convex brush, the face normals of
 * their Minkowski difference: the brush faces; x, y, z; d × x, d × y, d × z; and e × x, e × y,
 * e × z, e × d for every brush edge e. The largest gap over those axes is the signed distance
 * when the shapes overlap or touch (> 0 separated, 0 touching, −depth when penetrating). When
 * they are apart it is the largest face-plane gap of that difference, a lower bound of the
 * Euclidean distance: that only makes "≥ −τ" checks stricter, and for the static box it is
 * exactly the largest box-expanded plane distance the trace sees, which is what P4 bounds. Any
 * unit axis gives a valid lower bound, so rounding in an axis direction can only lower the
 * result, never invent a separation.
 */

/** Axes shorter than this (cross products of unit vectors, so sines) are skipped. */
const AXIS_MIN = 1e-9;

export class OracleBrush {
  readonly index: number;
  readonly contents: number;
  /** 3 per vertex. */
  readonly vertices: Float64Array;
  /** Vertex indices per face polygon, counter-clockwise from outside. */
  readonly polygons: readonly Uint32Array[];
  /** nx, ny, nz, d per face (the runtime's face planes). */
  readonly faces: Float64Array;
  /** Unit direction per unique edge, 3 each. */
  readonly edges: Float64Array;
  /** Endpoint vertex indices per unique edge, 2 each. */
  readonly edgeEnds: Uint32Array;
  /** Vertex extents: minx, miny, minz, maxx, maxy, maxz. */
  readonly extent: Float64Array;
  /**
   * How far the runtime brush reaches past its vertices along its own planes, as measured: the
   * bevels round outward to an f32 (M1 design B). Box-expanded planes see that sliver as solid,
   * so "the runtime says inside" may hold up to this far outside.
   */
  readonly reach: number;
  /**
   * The most `reach` may be, from the vertices alone: one f32 step at the brush's largest
   * coordinate (plus 1e-9 for polygonizer rounding). It does not come from the planes under test,
   * so a bevel placed too far out cannot widen its own tolerance.
   */
  readonly reachBound: number;
  /** The sliver the properties allow: `reach`, capped at `reachBound`. */
  readonly slop: number;
  /** Six axial faces: the brush is exactly its vertex extent, so overlap tests need no τ. */
  readonly isBox: boolean;
  /** The case-independent axes (faces, x, y, z, e × axis), 3 each, and the brush's interval. */
  readonly staticAxes: Float64Array;
  readonly staticMin: Float64Array;
  readonly staticMax: Float64Array;

  constructor(
    index: number,
    contents: number,
    vertices: Float64Array,
    polygons: readonly Uint32Array[],
    faces: Float64Array,
    runtimePlanes: Float64Array,
  ) {
    this.index = index;
    this.contents = contents;
    this.vertices = vertices;
    this.polygons = polygons;
    this.faces = faces;
    const ends: number[] = [];
    const seen = new Set<number>();
    const vCount = vertices.length / 3;
    for (const poly of polygons) {
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k] as number;
        const b = poly[(k + 1) % poly.length] as number;
        const key = a < b ? a * vCount + b : b * vCount + a;
        if (seen.has(key)) continue;
        seen.add(key);
        ends.push(a, b);
      }
    }
    this.edgeEnds = Uint32Array.from(ends);
    this.edges = new Float64Array((3 * ends.length) / 2);
    for (let e = 0; e < ends.length / 2; e++) {
      const a = 3 * (ends[2 * e] as number);
      const b = 3 * (ends[2 * e + 1] as number);
      const x = (vertices[b] as number) - (vertices[a] as number);
      const y = (vertices[b + 1] as number) - (vertices[a + 1] as number);
      const z = (vertices[b + 2] as number) - (vertices[a + 2] as number);
      const len = Math.sqrt(x * x + y * y + z * z);
      this.edges[3 * e] = x / len;
      this.edges[3 * e + 1] = y / len;
      this.edges[3 * e + 2] = z / len;
    }
    this.extent = new Float64Array(6);
    for (let k = 0; k < 3; k++) {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (let v = k; v < vertices.length; v += 3) {
        const x = vertices[v] as number;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      this.extent[k] = lo;
      this.extent[k + 3] = hi;
    }
    let slop = 0;
    for (let p = 0; p < runtimePlanes.length; p += 4) {
      const reach =
        (runtimePlanes[p + 3] as number) -
        project(
          vertices,
          runtimePlanes[p] as number,
          runtimePlanes[p + 1] as number,
          runtimePlanes[p + 2] as number,
          1,
        );
      if (reach > slop) slop = reach;
    }
    let largest = 0;
    for (let v = 0; v < vertices.length; v++) {
      const x = Math.abs(vertices[v] as number);
      if (x > largest) largest = x;
    }
    this.reach = slop;
    this.reachBound = f32Step(largest) + 1e-9;
    this.slop = slop < this.reachBound ? slop : this.reachBound;
    let axial = faces.length === 24;
    for (let f = 0; f < faces.length && axial; f += 4) {
      axial =
        Math.abs(faces[f] as number) +
          Math.abs(faces[f + 1] as number) +
          Math.abs(faces[f + 2] as number) ===
        1;
    }
    this.isBox = axial;

    const axes: number[] = [];
    for (let f = 0; f < faces.length; f += 4) {
      axes.push(faces[f] as number, faces[f + 1] as number, faces[f + 2] as number);
    }
    axes.push(1, 0, 0, 0, 1, 0, 0, 0, 1);
    for (let e = 0; e < this.edges.length; e += 3) {
      for (let k = 0; k < 3; k++) {
        pushCross(
          axes,
          this.edges[e] as number,
          this.edges[e + 1] as number,
          this.edges[e + 2] as number,
          k === 0 ? 1 : 0,
          k === 1 ? 1 : 0,
          k === 2 ? 1 : 0,
        );
      }
    }
    this.staticAxes = Float64Array.from(axes);
    const n = axes.length / 3;
    this.staticMin = new Float64Array(n);
    this.staticMax = new Float64Array(n);
    for (let a = 0; a < n; a++) {
      const ux = axes[3 * a] as number;
      const uy = axes[3 * a + 1] as number;
      const uz = axes[3 * a + 2] as number;
      this.staticMin[a] = -project(vertices, ux, uy, uz, -1);
      this.staticMax[a] = project(vertices, ux, uy, uz, 1);
    }
  }
}

const f32 = new Float32Array(1);
const f32Bits = new Uint32Array(f32.buffer);

/** The gap from fround(x) (x ≥ 0) to the next larger f32. */
export function f32Step(x: number): number {
  const r = Math.fround(x);
  f32[0] = r;
  f32Bits[0] = (f32Bits[0] as number) + 1;
  return (f32[0] as number) - r;
}

/** max over vertices of sign·(u·v). */
function project(v: Float64Array, ux: number, uy: number, uz: number, sign: number): number {
  let best = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < v.length; i += 3) {
    const x =
      sign * (ux * (v[i] as number) + uy * (v[i + 1] as number) + uz * (v[i + 2] as number));
    if (x > best) best = x;
  }
  return best;
}

/** Appends normalize(a × b) unless it is shorter than AXIS_MIN. */
function pushCross(
  out: number[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): void {
  const x = ay * bz - az * by;
  const y = az * bx - ax * bz;
  const z = ax * by - ay * bx;
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len < AXIS_MIN) return;
  out.push(x / len, y / len, z / len);
}

/** The gap between the swept box and the brush along unit axis u, given the brush interval. */
function gap(
  ux: number,
  uy: number,
  uz: number,
  bMin: number,
  bMax: number,
  s: Float64Array,
  h: Float64Array,
): number {
  const a = ux * (s[0] as number) + uy * (s[1] as number) + uz * (s[2] as number);
  const c = ux * (s[3] as number) + uy * (s[4] as number) + uz * (s[5] as number);
  const r =
    Math.abs(ux) * (h[0] as number) +
    Math.abs(uy) * (h[1] as number) +
    Math.abs(uz) * (h[2] as number);
  const lo = (a < c ? a : c) - r;
  const hi = (a > c ? a : c) + r;
  const g1 = bMin - hi;
  const g2 = lo - bMax;
  return g1 > g2 ? g1 : g2;
}

const sweep = new Float64Array(6);
const half = new Float64Array(3);
const dyn: number[] = [];

/**
 * Signed separation between brush b and the convex hull of the box [mins, maxs] at origins s and
 * p (pass p = s for a static box). Works in center space like the trace (S′ = S + o).
 */
export function separation(
  b: OracleBrush,
  s: ArrayLike<number>,
  p: ArrayLike<number>,
  mins: ArrayLike<number>,
  maxs: ArrayLike<number>,
): number {
  for (let k = 0; k < 3; k++) {
    const o = ((mins[k] as number) + (maxs[k] as number)) * 0.5;
    sweep[k] = (s[k] as number) + o;
    sweep[k + 3] = (p[k] as number) + o;
    half[k] = ((maxs[k] as number) - (mins[k] as number)) * 0.5;
  }
  let sep = Number.NEGATIVE_INFINITY;
  const axes = b.staticAxes;
  for (let a = 0; a < b.staticMin.length; a++) {
    const g = gap(
      axes[3 * a] as number,
      axes[3 * a + 1] as number,
      axes[3 * a + 2] as number,
      b.staticMin[a] as number,
      b.staticMax[a] as number,
      sweep,
      half,
    );
    if (g > sep) sep = g;
  }
  let dx = (sweep[3] as number) - (sweep[0] as number);
  let dy = (sweep[4] as number) - (sweep[1] as number);
  let dz = (sweep[5] as number) - (sweep[2] as number);
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len === 0) return sep;
  dx /= len;
  dy /= len;
  dz /= len;
  dyn.length = 0;
  pushCross(dyn, dx, dy, dz, 1, 0, 0);
  pushCross(dyn, dx, dy, dz, 0, 1, 0);
  pushCross(dyn, dx, dy, dz, 0, 0, 1);
  const edges = b.edges;
  for (let e = 0; e < edges.length; e += 3) {
    pushCross(dyn, edges[e] as number, edges[e + 1] as number, edges[e + 2] as number, dx, dy, dz);
  }
  for (let a = 0; a < dyn.length; a += 3) {
    const ux = dyn[a] as number;
    const uy = dyn[a + 1] as number;
    const uz = dyn[a + 2] as number;
    const g = gap(
      ux,
      uy,
      uz,
      -project(b.vertices, ux, uy, uz, -1),
      project(b.vertices, ux, uy, uz, 1),
      sweep,
      half,
    );
    if (g > sep) sep = g;
  }
  return sep;
}

/** Oracle brushes for every brush of a world, polygonized from the world's own face planes. */
export function oracleBrushes(world: CollisionWorld): OracleBrush[] {
  const out: OracleBrush[] = [];
  for (let b = 0; b < world.brushCount; b++) {
    const first = world.brushPlaneStart[b] as number;
    const faces = world.planes.slice(4 * first, 4 * (first + (world.brushFaceCount[b] as number)));
    const runtime = world.planes.slice(
      4 * first,
      4 * (first + (world.brushPlaneCount[b] as number)),
    );
    const poly = polygonize(faces, `brush ${b}`);
    out.push(
      new OracleBrush(
        b,
        world.brushContents[b] as number,
        poly.vertices,
        poly.polygons,
        poly.planes,
        runtime,
      ),
    );
  }
  return out;
}

/**
 * Independent vertex set (M1 design F.7): every triple of face planes intersected by Cramer's
 * rule, kept when inside all planes within `inside`, deduplicated at 1/64 u. Null when it matches
 * `b.vertices` one to one within `tol`, else a description of the mismatch.
 */
export function vertexSetMismatch(b: OracleBrush, tol = 1e-6, inside = 1e-6): string | null {
  const pl = b.faces;
  const n = pl.length / 4;
  const found: number[][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const p = triple(pl, i, j, k);
        if (p === null) continue;
        let ok = true;
        for (let q = 0; q < n && ok; q++) {
          const f =
            (pl[4 * q] as number) * (p[0] as number) +
            (pl[4 * q + 1] as number) * (p[1] as number) +
            (pl[4 * q + 2] as number) * (p[2] as number) -
            (pl[4 * q + 3] as number);
          ok = f <= inside;
        }
        if (ok && !found.some((v) => maxDiff(v, p) <= 1 / 64)) found.push(p);
      }
    }
  }
  const actual: number[][] = [];
  for (let v = 0; v < b.vertices.length; v += 3) actual.push([...b.vertices.subarray(v, v + 3)]);
  if (actual.length !== found.length) {
    return `brush ${b.index}: polygonize has ${actual.length} vertices, triples give ${found.length}`;
  }
  for (const f of found) {
    if (!actual.some((a) => maxDiff(a, f) <= tol)) {
      return `brush ${b.index}: no polygonized vertex within ${tol} of ${f.join(", ")}`;
    }
  }
  return null;
}

function triple(pl: Float64Array, i: number, j: number, k: number): number[] | null {
  const a = (q: number, c: number): number => pl[4 * q + c] as number;
  const bc = [
    a(j, 1) * a(k, 2) - a(j, 2) * a(k, 1),
    a(j, 2) * a(k, 0) - a(j, 0) * a(k, 2),
    a(j, 0) * a(k, 1) - a(j, 1) * a(k, 0),
  ];
  const ca = [
    a(k, 1) * a(i, 2) - a(k, 2) * a(i, 1),
    a(k, 2) * a(i, 0) - a(k, 0) * a(i, 2),
    a(k, 0) * a(i, 1) - a(k, 1) * a(i, 0),
  ];
  const ab = [
    a(i, 1) * a(j, 2) - a(i, 2) * a(j, 1),
    a(i, 2) * a(j, 0) - a(i, 0) * a(j, 2),
    a(i, 0) * a(j, 1) - a(i, 1) * a(j, 0),
  ];
  const det =
    a(i, 0) * (bc[0] as number) + a(i, 1) * (bc[1] as number) + a(i, 2) * (bc[2] as number);
  if (Math.abs(det) < 1e-9) return null;
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    out.push(
      (a(i, 3) * (bc[c] as number) + a(j, 3) * (ca[c] as number) + a(k, 3) * (ab[c] as number)) /
        det,
    );
  }
  return out;
}

function maxDiff(a: readonly number[], b: readonly number[]): number {
  let m = 0;
  for (let k = 0; k < 3; k++) {
    const d = Math.abs((a[k] as number) - (b[k] as number));
    if (d > m) m = d;
  }
  return m;
}
