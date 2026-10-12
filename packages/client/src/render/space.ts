import { CMAP_VERTEX_FLOATS, type Vec3 } from "@game/shared";
import type { Object3D } from "three";

/**
 * The one place the simulation's space becomes the renderer's (CLAUDE.md, docs/06 §7): the sim is
 * Z-up in inches, Three.js is Y-up in metres. Nothing else in the client swaps axes or scales.
 *
 *   three.x = sim.x × k,  three.y = sim.z × k,  three.z = −sim.y × k   (k = METERS_PER_UNIT)
 *
 * The mapping is a proper rotation (determinant +1) times a scale, so handedness and triangle
 * winding survive it: a face counter-clockwise from outside in the map is counter-clockwise from
 * outside in the scene, and Three's default front faces stay the map's outsides.
 */

/** 1 u = 1 inch = 0.0254 m (CLAUDE.md conventions). */
export const METERS_PER_UNIT = 0.0254;

const DEG_TO_RAD = Math.PI / 180;

/** Anything with writable x, y, z (Three's Vector3). */
export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** A sim position (u) as a scene position (m), into `out`. */
export function toThree<T extends XYZ>(x: number, y: number, z: number, out: T): T {
  out.x = x * METERS_PER_UNIT;
  out.y = z * METERS_PER_UNIT;
  out.z = -y * METERS_PER_UNIT;
  return out;
}

/** A sim position vector as a scene position, into `out`. */
export function vecToThree<T extends XYZ>(v: Readonly<Vec3>, out: T): T {
  return toThree(v[0] as number, v[1] as number, v[2] as number, out);
}

/** A sim direction (normal, axis) as a scene direction: rotated, not scaled. */
export function toThreeDir<T extends XYZ>(x: number, y: number, z: number, out: T): T {
  out.x = x;
  out.y = z;
  out.z = -y;
  return out;
}

/** A scene position (m) as a sim position (u), into `out`. */
export function toSim(p: Readonly<XYZ>, out: Vec3): Vec3 {
  out[0] = p.x / METERS_PER_UNIT;
  out[1] = -p.z / METERS_PER_UNIT;
  out[2] = p.y / METERS_PER_UNIT;
  return out;
}

/**
 * Points a camera (which looks down its local −Z, up +Y) along sim view angles in degrees: yaw
 * about +Z with 0 facing +X, positive pitch looking down (docs/03 §2). Euler order YXZ applies the
 * yaw about the scene's up axis first and the pitch about the turned camera's own X axis, as a
 * first-person view does; yaw 0 must face scene +X, a quarter turn from Three's −Z, hence −90°.
 */
export function setViewAngles(cam: Object3D, yawDeg: number, pitchDeg: number): void {
  cam.rotation.set(-pitchDeg * DEG_TO_RAD, (yawDeg - 90) * DEG_TO_RAD, 0, "YXZ");
}

/** `uprightToThree` pose slots. */
export const UPRIGHT_X = 0;
export const UPRIGHT_Y = 1;
export const UPRIGHT_Z = 2;
/** Sim yaw, degrees about +Z (0 faces +X). */
export const UPRIGHT_YAW = 3;
/** Scale along sim +Z (a crouch squashes the body). */
export const UPRIGHT_HEIGHT = 4;
export const UPRIGHT_SLOTS = 5;

/**
 * An upright body's model matrix (column-major, Three's `Matrix4.elements` layout) into `out` from
 * float `offset`: a mesh modelled in scene axes and metres around its feet, turned by the sim yaw
 * about the up axis, scaled along it by `pose[UPRIGHT_HEIGHT]`, placed at the sim position
 * `pose[UPRIGHT_X..Z]` (u). Sim yaw θ about +Z is a turn by θ about scene +Y (sim +X stays scene
 * +X and sim +Y is scene −Z), so a mesh's local +X is its facing. The pose comes in a Float64Array
 * and the matrix goes straight into an instance buffer, so per-frame callers pass no doubles and
 * allocate nothing.
 */
export function uprightToThree(pose: Float64Array, out: Float32Array, offset: number): void {
  const yaw = (pose[UPRIGHT_YAW] as number) * DEG_TO_RAD;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const k = METERS_PER_UNIT;
  out[offset] = c;
  out[offset + 1] = 0;
  out[offset + 2] = -s;
  out[offset + 3] = 0;
  out[offset + 4] = 0;
  out[offset + 5] = pose[UPRIGHT_HEIGHT] as number;
  out[offset + 6] = 0;
  out[offset + 7] = 0;
  out[offset + 8] = s;
  out[offset + 9] = 0;
  out[offset + 10] = c;
  out[offset + 11] = 0;
  out[offset + 12] = (pose[UPRIGHT_X] as number) * k;
  out[offset + 13] = (pose[UPRIGHT_Z] as number) * k;
  out[offset + 14] = -(pose[UPRIGHT_Y] as number) * k;
  out[offset + 15] = 1;
}

/** A length in u as metres (a mesh's size), for geometry built once. */
export function unitsToMeters(u: number): number {
  return u * METERS_PER_UNIT;
}

/**
 * The cmap's vertices (`CMAP_VERTEX_FLOATS` per vertex: position, normal, uv0; docs/07 §2) for
 * `count` vertices from `first`, converted at load time into a new interleaved array of the same
 * layout: positions to metres in scene axes, normals rotated, uvs untouched (the grid textures
 * keep 1 uv per 64 u, docs/07 §3).
 */
export function convertVertices(src: Float32Array, first = 0, count?: number): Float32Array {
  const n = count ?? src.length / CMAP_VERTEX_FLOATS - first;
  const out = new Float32Array(n * CMAP_VERTEX_FLOATS);
  const k = METERS_PER_UNIT;
  for (let i = 0; i < n; i++) {
    const s = (first + i) * CMAP_VERTEX_FLOATS;
    const d = i * CMAP_VERTEX_FLOATS;
    out[d] = (src[s] as number) * k;
    out[d + 1] = (src[s + 2] as number) * k;
    out[d + 2] = -(src[s + 1] as number) * k;
    out[d + 3] = src[s + 3] as number;
    out[d + 4] = src[s + 5] as number;
    out[d + 5] = -(src[s + 4] as number);
    out[d + 6] = src[s + 6] as number;
    out[d + 7] = src[s + 7] as number;
  }
  return out;
}

/**
 * `count` xyz positions (sim u) from `src` as scene positions (m) into `out` from float
 * `outOffset`, per frame: the debug lines. Writes in place, so it allocates nothing.
 */
export function positionsToThree(
  src: Float32Array,
  count: number,
  out: Float32Array,
  outOffset: number,
): void {
  const k = METERS_PER_UNIT;
  for (let i = 0; i < count; i++) {
    const s = i * 3;
    const d = outOffset + s;
    out[d] = (src[s] as number) * k;
    out[d + 1] = (src[s + 2] as number) * k;
    out[d + 2] = -(src[s + 1] as number) * k;
  }
}
