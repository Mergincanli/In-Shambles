import {
  type BuiltBrush,
  buildBrush,
  CMAP_VERTEX_FLOATS,
  type CmapBounds,
  type CmapBrushes,
  type CmapSurfaces,
  CONTENTS_KNOWN,
  CONTENTS_NODRAW,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  CONTENTS_TRIGGER,
  CONTENTS_WATER,
  FOOTSTEP_COUNT,
  SURF_KNOWN,
  surfaceFootstep,
} from "@game/shared";

/**
 * The greybox brush compiler (M1 design B, F; docs/07 §2): builder brushes in, the brush, plane
 * and render-surface parts of a cmap out. Compile time only: it allocates freely, but uses only
 * exact operations plus Math.sqrt (D-016), so every machine writes the same bytes.
 */

export const GREYBOX_COMPILER_NAME = "greybox";
/**
 * Bumped whenever the output changes on purpose, which explains a changed committed .cmap.
 * 2: ladder() emits no LADDER volume and puts the rung material on its face (D-024).
 */
export const GREYBOX_COMPILER_VERSION = 2;

/**
 * World units per uv unit. Every face is projected onto the plane of its normal's dominant axis
 * in world coordinates: z-dominant faces get (u, v) = (x, y) / 64, x-dominant (y, z) / 64 and
 * y-dominant (x, z) / 64. A texture tile then covers 64 u and lines up across brushes, which
 * M2's grid texture relies on. Ties between axes go to z, then x, so a 45° ramp maps like floor.
 */
export const GREYBOX_UV_UNITS = 64;

/**
 * Sine of the largest angle at which an edge-bevel candidate still counts as parallel to an axis
 * or a face normal. Candidates from the welded vertices of f32 planes match within about 1e-13;
 * a real new direction is much further off (a ramp turned by sin 1e-5 gives 3e-5).
 */
export const EDGE_BEVEL_TOLERANCE = 1e-6;

/** Contents that never render: clip, triggers and nodraw volumes. */
const HIDDEN_CONTENTS = CONTENTS_PLAYERCLIP | CONTENTS_TRIGGER | CONTENTS_NODRAW;

/** A brush as the MapBuilder hands it over. */
export interface GreyboxBrush {
  /** Names the brush in every error. */
  readonly label: string;
  /** Face planes n·x ≤ d with outward unit normals, 4 numbers each (world/shapes.ts). */
  readonly planes: Float64Array;
  /** CONTENTS_* bits, at least one. */
  readonly contents: number;
  /** Material name per input plane. */
  readonly materials: readonly string[];
  /** SURF_* bits per input plane. */
  readonly surfaceFlags: readonly number[];
}

/** A built and checked brush, with its per-face data following the faces buildBrush kept. */
export interface CompiledBrush {
  readonly label: string;
  readonly contents: number;
  readonly built: BuiltBrush;
  readonly faceMaterials: readonly string[];
  readonly faceSurfaceFlags: readonly number[];
}

/** Everything of a cmap except its name, entities and fixed fields. */
export interface CompiledGeometry {
  readonly bounds: CmapBounds;
  /** In order of first use: brush by brush, face by face. */
  readonly materials: readonly string[];
  readonly planes: Float32Array;
  readonly planeSurfaceFlags: Uint32Array;
  readonly planeMaterial: Int32Array;
  readonly brushes: CmapBrushes;
  readonly surfaces: CmapSurfaces;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

/** A map the greybox builder or compiler refuses. Messages name the map or brush. */
export class GreyboxError extends Error {
  override name = "GreyboxError";
}

/** Material names are stable ids: snake_case segments separated by "/". */
const MATERIAL_NAME = /^[a-z0-9_]+(\/[a-z0-9_]+)*$/;

/**
 * Whether a brush with these contents gets render surfaces. Solid brushes and water volumes do;
 * clip, trigger and nodraw brushes don't, and neither does a volume that is neither solid nor
 * water (a LADDER volume, say), which only marks space.
 */
export function isRenderedContents(contents: number): boolean {
  return (contents & HIDDEN_CONTENTS) === 0 && (contents & (CONTENTS_SOLID | CONTENTS_WATER)) !== 0;
}

function fmt(x: number): string {
  return String(Math.round(x * 1e6) / 1e6 + 0);
}

function fmtVec(v: ArrayLike<number>, i: number): string {
  return `(${fmt(v[i] as number)}, ${fmt(v[i + 1] as number)}, ${fmt(v[i + 2] as number)})`;
}

/** |u × n|² ≤ tolerance², for unit u and a normal n that is normalised here. */
function parallel(ux: number, uy: number, uz: number, nx: number, ny: number, nz: number) {
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const ax = nx / len;
  const ay = ny / len;
  const az = nz / len;
  const cx = uy * az - uz * ay;
  const cy = uz * ax - ux * az;
  const cz = ux * ay - uy * ax;
  return cx * cx + cy * cy + cz * cz <= EDGE_BEVEL_TOLERANCE * EDGE_BEVEL_TOLERANCE;
}

/** The face whose polygon runs b → a: the other face on the edge a → b of face f. */
function otherFace(built: BuiltBrush, f: number, a: number, b: number): number {
  for (let g = 0; g < built.faceCount; g++) {
    if (g === f) continue;
    const poly = built.polygons[g] as Uint32Array;
    const n = poly.length;
    for (let k = 0; k < n; k++) {
      if (poly[k] === b && poly[k + 1 === n ? 0 : k + 1] === a) return g;
    }
  }
  return -1;
}

/**
 * Throws unless axial bevels make the box-expanded plane test exact for this brush (M1 design B).
 * The expanded brush's faces come from its face normals, the axes, and e × axis for each edge e,
 * taken with the sign that points out of the edge, between the normals n1 and n2 of its two
 * faces (u·(n1 + n2) ≥ 0). When each such direction is an axis (both signs are bevels or faces)
 * or points the same way as a face normal, no edge bevel is missing; a face normal pointing the
 * opposite way covers nothing. True for boxes, boxes rotated about Z and axis-aligned wedges; an
 * off-axis ramp fails. mapc adds edge bevels in M5.
 */
export function checkNoEdgeBevelsNeeded(built: BuiltBrush, label: string): void {
  const v = built.vertices;
  const p = built.planes;
  for (let f = 0; f < built.faceCount; f++) {
    const poly = built.polygons[f] as Uint32Array;
    const n = poly.length;
    for (let k = 0; k < n; k++) {
      const a = poly[k] as number;
      const b = poly[k + 1 === n ? 0 : k + 1] as number;
      // Each edge is on two faces, once in each direction: check it once.
      if (a > b) continue;
      const g = otherFace(built, f, a, b);
      if (g < 0) throw new GreyboxError(`${label}: edge ${fmtVec(v, 3 * a)} has one face`);
      const sx = (p[4 * f] as number) + (p[4 * g] as number);
      const sy = (p[4 * f + 1] as number) + (p[4 * g + 1] as number);
      const sz = (p[4 * f + 2] as number) + (p[4 * g + 2] as number);
      let ex = (v[3 * b] as number) - (v[3 * a] as number);
      let ey = (v[3 * b + 1] as number) - (v[3 * a + 1] as number);
      let ez = (v[3 * b + 2] as number) - (v[3 * a + 2] as number);
      const elen = Math.sqrt(ex * ex + ey * ey + ez * ez);
      ex /= elen;
      ey /= elen;
      ez /= elen;
      for (let axis = 0; axis < 3; axis++) {
        // e × axis_k, written out per axis.
        let ux = axis === 0 ? 0 : axis === 1 ? -ez : ey;
        let uy = axis === 0 ? ez : axis === 1 ? 0 : -ex;
        let uz = axis === 0 ? -ey : axis === 1 ? ex : 0;
        const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
        // The edge runs along this axis: no candidate direction.
        if (ulen < EDGE_BEVEL_TOLERANCE) continue;
        const sign = ux * sx + uy * sy + uz * sz < 0 ? -1 : 1;
        ux = (sign * ux) / ulen;
        uy = (sign * uy) / ulen;
        uz = (sign * uz) / ulen;
        let covered =
          parallel(ux, uy, uz, 1, 0, 0) ||
          parallel(ux, uy, uz, 0, 1, 0) ||
          parallel(ux, uy, uz, 0, 0, 1);
        for (let h = 0; h < built.faceCount && !covered; h++) {
          const nx = p[4 * h] as number;
          const ny = p[4 * h + 1] as number;
          const nz = p[4 * h + 2] as number;
          covered = ux * nx + uy * ny + uz * nz > 0 && parallel(ux, uy, uz, nx, ny, nz);
        }
        if (!covered) {
          throw new GreyboxError(
            `${label}: needs edge bevels (M5): edge ${fmtVec(v, 3 * a)} → ${fmtVec(v, 3 * b)} × ${
              "xyz"[axis]
            } gives the outward direction (${fmt(ux)}, ${fmt(uy)}, ${fmt(uz)}), which is neither an axis nor a face normal. Axial bevels only make boxes, boxes rotated about Z and axis-aligned wedges exact; ramps must be aligned to an axis until mapc adds edge bevels`,
          );
        }
      }
    }
  }
}

/**
 * Builds one brush (f32-rounded faces, then outward-rounded axial bevels), checks that it needs no
 * edge bevels and that its contents, flags and materials are valid, and keeps the per-face data
 * of the faces buildBrush kept. BrushError from buildBrush names the brush through its label.
 */
export function compileBrush(brush: GreyboxBrush): CompiledBrush {
  const label = brush.label;
  const inputCount = brush.planes.length / 4;
  if (brush.materials.length !== inputCount || brush.surfaceFlags.length !== inputCount) {
    throw new GreyboxError(
      `${label}: ${brush.materials.length} materials and ${brush.surfaceFlags.length} surface flags for ${inputCount} planes`,
    );
  }
  const contents = brush.contents;
  if (!Number.isInteger(contents) || contents <= 0 || (contents & ~CONTENTS_KNOWN) !== 0) {
    throw new GreyboxError(`${label}: contents ${contents} must be non-zero known CONTENTS_* bits`);
  }
  for (let i = 0; i < inputCount; i++) {
    const material = brush.materials[i] as string;
    if (!MATERIAL_NAME.test(material)) {
      throw new GreyboxError(
        `${label}: material ${JSON.stringify(material)} is not a snake_case path such as "grey/floor"`,
      );
    }
    const flags = brush.surfaceFlags[i] as number;
    if (
      !Number.isInteger(flags) ||
      flags < 0 ||
      (flags & ~SURF_KNOWN) !== 0 ||
      surfaceFootstep(flags) >= FOOTSTEP_COUNT
    ) {
      throw new GreyboxError(
        `${label}: plane ${i} surface flags ${flags} are not known SURF_* bits`,
      );
    }
  }
  const built = buildBrush(brush.planes, label);
  checkNoEdgeBevelsNeeded(built, label);
  const faceMaterials: string[] = [];
  const faceSurfaceFlags: number[] = [];
  for (let f = 0; f < built.faceCount; f++) {
    const source = built.faceSource[f] as number;
    faceMaterials.push(brush.materials[source] as string);
    faceSurfaceFlags.push(brush.surfaceFlags[source] as number);
  }
  return { label, contents, built, faceMaterials, faceSurfaceFlags };
}

/** 0, 1 or 2: the axis the face is projected along for uv0 (GREYBOX_UV_UNITS). */
export function uvProjectionAxis(nx: number, ny: number, nz: number): number {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  if (az >= ax && az >= ay) return 2;
  return ax >= ay ? 0 : 1;
}

/**
 * Lays compiled brushes out as cmap parts. Planes go brush by brush, faces then bevels; the bounds
 * are buildBrush's bevel extents and the map bounds their union. Render surfaces: one per material
 * that any rendered face uses, in material order. Each face polygon becomes its own vertices
 * (f32 positions, the face normal, planar uv0) and a fan of triangles from its canonical start
 * vertex, counter-clockwise seen from outside like the polygon.
 */
export function assembleBrushes(compiled: readonly CompiledBrush[]): CompiledGeometry {
  if (compiled.length === 0) throw new GreyboxError("a map needs at least one brush");
  const materials: string[] = [];
  const materialIndex = new Map<string, number>();
  let planeTotal = 0;
  for (let i = 0; i < compiled.length; i++) {
    const c = compiled[i] as CompiledBrush;
    planeTotal += c.built.planes.length / 4;
    for (let f = 0; f < c.faceMaterials.length; f++) {
      const name = c.faceMaterials[f] as string;
      if (!materialIndex.has(name)) {
        materialIndex.set(name, materials.length);
        materials.push(name);
      }
    }
  }

  const brushCount = compiled.length;
  const planes = new Float32Array(4 * planeTotal);
  const planeSurfaceFlags = new Uint32Array(planeTotal);
  const planeMaterial = new Int32Array(planeTotal);
  const brushes: CmapBrushes = {
    firstPlane: new Uint32Array(brushCount),
    planeCount: new Uint32Array(brushCount),
    faceCount: new Uint32Array(brushCount),
    contents: new Uint32Array(brushCount),
    bounds: new Float32Array(6 * brushCount),
  };
  const mins = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maxs = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  // Rendered faces per material, as [brush, face] pairs in brush and face order.
  const faces: number[][] = materials.map(() => []);
  let plane = 0;
  for (let i = 0; i < brushCount; i++) {
    const c = compiled[i] as CompiledBrush;
    const built = c.built;
    const count = built.planes.length / 4;
    brushes.firstPlane[i] = plane;
    brushes.planeCount[i] = count;
    brushes.faceCount[i] = built.faceCount;
    brushes.contents[i] = c.contents;
    planes.set(built.planes, 4 * plane);
    brushes.bounds.set(built.bounds, 6 * i);
    for (let k = 0; k < 3; k++) {
      mins[k] = Math.min(mins[k] as number, built.bounds[k] as number);
      maxs[k] = Math.max(maxs[k] as number, built.bounds[k + 3] as number);
    }
    const rendered = isRenderedContents(c.contents);
    for (let p = 0; p < count; p++) {
      const face = p < built.faceCount;
      planeSurfaceFlags[plane + p] = face ? (c.faceSurfaceFlags[p] as number) : 0;
      const m = face ? (materialIndex.get(c.faceMaterials[p] as string) as number) : -1;
      planeMaterial[plane + p] = m;
      if (face && rendered) (faces[m] as number[]).push(i, p);
    }
    plane += count;
  }

  let vertexTotal = 0;
  let indexTotal = 0;
  let surfaceCount = 0;
  for (let m = 0; m < materials.length; m++) {
    const list = faces[m] as number[];
    if (list.length > 0) surfaceCount++;
    for (let j = 0; j < list.length; j += 2) {
      const c = compiled[list[j] as number] as CompiledBrush;
      const n = (c.built.polygons[list[j + 1] as number] as Uint32Array).length;
      vertexTotal += n;
      indexTotal += 3 * (n - 2);
    }
  }
  const surfaces: CmapSurfaces = {
    material: new Uint32Array(surfaceCount),
    firstVertex: new Uint32Array(surfaceCount),
    vertexCount: new Uint32Array(surfaceCount),
    firstIndex: new Uint32Array(surfaceCount),
    indexCount: new Uint32Array(surfaceCount),
  };
  const vertices = new Float32Array(CMAP_VERTEX_FLOATS * vertexTotal);
  const indices = new Uint32Array(indexTotal);
  let s = 0;
  let vertex = 0;
  let index = 0;
  for (let m = 0; m < materials.length; m++) {
    const list = faces[m] as number[];
    if (list.length === 0) continue;
    const firstVertex = vertex;
    const firstIndex = index;
    for (let j = 0; j < list.length; j += 2) {
      const built = (compiled[list[j] as number] as CompiledBrush).built;
      const f = list[j + 1] as number;
      const poly = built.polygons[f] as Uint32Array;
      const nx = built.planes[4 * f] as number;
      const ny = built.planes[4 * f + 1] as number;
      const nz = built.planes[4 * f + 2] as number;
      const uvAxis = uvProjectionAxis(nx, ny, nz);
      const base = vertex - firstVertex;
      for (let k = 0; k < poly.length; k++) {
        const src = 3 * (poly[k] as number);
        const o = CMAP_VERTEX_FLOATS * vertex;
        const x = Math.fround(built.vertices[src] as number);
        const y = Math.fround(built.vertices[src + 1] as number);
        const z = Math.fround(built.vertices[src + 2] as number);
        vertices[o] = x;
        vertices[o + 1] = y;
        vertices[o + 2] = z;
        vertices[o + 3] = nx;
        vertices[o + 4] = ny;
        vertices[o + 5] = nz;
        // Scaling an f32 by a power of two is exact, so uv0 is exactly position / 64.
        vertices[o + 6] = (uvAxis === 0 ? y : x) / GREYBOX_UV_UNITS;
        vertices[o + 7] = (uvAxis === 2 ? y : z) / GREYBOX_UV_UNITS;
        vertex++;
      }
      for (let k = 1; k + 1 < poly.length; k++) {
        indices[index] = base;
        indices[index + 1] = base + k;
        indices[index + 2] = base + k + 1;
        index += 3;
      }
    }
    surfaces.material[s] = m;
    surfaces.firstVertex[s] = firstVertex;
    surfaces.vertexCount[s] = vertex - firstVertex;
    surfaces.firstIndex[s] = firstIndex;
    surfaces.indexCount[s] = index - firstIndex;
    s++;
  }

  return {
    bounds: {
      mins: [(mins[0] as number) + 0, (mins[1] as number) + 0, (mins[2] as number) + 0],
      maxs: [(maxs[0] as number) + 0, (maxs[1] as number) + 0, (maxs[2] as number) + 0],
    },
    materials,
    planes,
    planeSurfaceFlags,
    planeMaterial,
    brushes,
    surfaces,
    vertices,
    indices,
  };
}

/** compileBrush on each brush, then assembleBrushes. */
export function compileBrushes(brushes: readonly GreyboxBrush[]): CompiledGeometry {
  const compiled: CompiledBrush[] = [];
  for (let i = 0; i < brushes.length; i++) compiled.push(compileBrush(brushes[i] as GreyboxBrush));
  return assembleBrushes(compiled);
}
