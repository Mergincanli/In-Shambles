/**
 * 3-vectors are Float64Arrays updated through out-params (D-016): no allocation after setup, and
 * every value stays a binary64 (never route sim vectors through a Float32Array). Modules keep
 * named scratch vectors instead of sharing a pool.
 *
 * The explicit 0/1/2 members make `v[0]` a plain `number` under noUncheckedIndexedAccess, and the
 * one alias absorbs TS's typed-array buffer generic.
 */
export type Vec3 = Float64Array & { 0: number; 1: number; 2: number };

/** Allocates: setup-time only (struct fields, module scratch, tests). */
export function vec3(x = 0, y = 0, z = 0): Vec3 {
  const v = new Float64Array(3) as Vec3;
  v[0] = x;
  v[1] = y;
  v[2] = z;
  return v;
}

export function vec3Set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function vec3Copy(out: Vec3, a: Vec3): Vec3 {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

export function vec3Add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  return out;
}

export function vec3Sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

export function vec3Scale(out: Vec3, a: Vec3, s: number): Vec3 {
  out[0] = a[0] * s;
  out[1] = a[1] * s;
  out[2] = a[2] * s;
  return out;
}

/** out = a + b·s, rounded as a multiply then an add (engines never fuse them). */
export function vec3Madd(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  out[2] = a[2] + b[2] * s;
  return out;
}

export function vec3Dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** `out` may alias `a` or `b`: inputs are read before anything is written. */
export function vec3Cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  return out;
}

export function vec3LengthSq(a: Vec3): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

export function vec3Length(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

/** Writes a / |a| and returns |a|. A zero vector stays zero (and returns 0). */
export function vec3Normalize(out: Vec3, a: Vec3): number {
  const len = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  if (len === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return 0;
  }
  out[0] = a[0] / len;
  out[1] = a[1] / len;
  out[2] = a[2] / len;
  return len;
}

export function vec3DistanceSq(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/** Component-wise `===` (so +0 equals −0 and NaN never equals anything). */
export function vec3ExactEquals(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function vec3IsFinite(a: Vec3): boolean {
  return Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
}
