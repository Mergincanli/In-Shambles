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
