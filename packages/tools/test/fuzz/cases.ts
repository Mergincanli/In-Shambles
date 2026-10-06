import {
  CONTENTS_KNOWN,
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  MASK_WATER,
  Mulberry32,
  quantizeOrigin,
  TRACE_EPSILON,
  type Vec3,
  vec3,
} from "@game/shared";
import type { OracleBrush } from "./oracle";
import { type FuzzWorld, thinFace } from "./worlds";

/**
 * Fuzz case sampling (M1 design G): starts on or near a chosen face at the distances where the
 * trace rules change, moves into it, along it, at tiny angles and at its vertices and edges, with
 * the hulls and masks the game uses plus lopsided boxes and rays.
 */

export interface FuzzCase {
  readonly world: string;
  readonly hull: string;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly mins: Vec3;
  readonly maxs: Vec3;
  readonly mask: number;
}

const EPS = TRACE_EPSILON;

/** Start distances from the chosen face, along its normal, measured on the box-expanded plane. */
const DISTANCES = [0, 1 / 64, EPS - 1e-9, EPS, EPS + 1e-9, 2 * EPS] as const;

/** How far inside the extreme vertex nearBevel starts: just past τ, and up to an f32 step. */
const INSIDE_VERTEX = [2e-5, 1e-4, 1e-3] as const;

/** Powers of ten for log-uniform tiny angles, without Math.pow. */
const TINY_SCALE = [1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3] as const;

export class CaseSampler {
  private readonly rng: Mulberry32;
  private readonly courses: readonly FuzzWorld[];
  private readonly synthetic: readonly FuzzWorld[];
  private readonly slabWorlds: readonly FuzzWorld[];

  constructor(seed: number, courses: readonly FuzzWorld[], synthetic: readonly FuzzWorld[]) {
    this.rng = new Mulberry32(seed);
    this.courses = courses;
    this.synthetic = synthetic;
    this.slabWorlds = [...courses, ...synthetic].filter((w) => w.thin.length > 0);
  }

  private f(): number {
    return this.rng.nextFloat();
  }

  private pick<T>(list: readonly T[]): T {
    return list[this.rng.nextInt(list.length)] as T;
  }

  /** A value in [lo, hi): an integer, on the 1/32 grid, or arbitrary. */
  private coord(lo: number, hi: number): number {
    const r = this.f();
    const x = lo + this.f() * (hi - lo);
    if (r < 0.4) return Math.round(x);
    if (r < 0.7) return Math.round(x * 32) / 32;
    return x;
  }

  private unit(out: Vec3): Vec3 {
    for (;;) {
      const x = this.f() * 2 - 1;
      const y = this.f() * 2 - 1;
      const z = this.f() * 2 - 1;
      const l = x * x + y * y + z * z;
      if (l > 1e-4 && l <= 1) {
        const s = Math.sqrt(l);
        out[0] = x / s;
        out[1] = y / s;
        out[2] = z / s;
        return out;
      }
    }
  }

  next(): FuzzCase {
    const r = this.f();
    if (r < 0.15 && this.slabWorlds.length > 0) return this.slabShot(this.pick(this.slabWorlds));
    const world = r < 0.5 ? this.pick(this.courses) : this.pick(this.synthetic);
    return this.nearFace(world);
  }

  private mask(): number {
    const r = this.f();
    if (r < 0.8) return MASK_PLAYERSOLID;
    if (r < 0.88) return MASK_WATER;
    return 1 + this.rng.nextInt(CONTENTS_KNOWN);
  }

  private hull(mins: Vec3, maxs: Vec3): string {
    const r = this.f();
    if (r < 0.3) {
      mins.set(HULL_MINS);
      maxs.set(HULL_STANDING_MAXS);
      return "standing";
    }
    if (r < 0.5) {
      mins.set(HULL_MINS);
      maxs.set(HULL_CROUCHED_MAXS);
      return "crouched";
    }
    if (r < 0.7) return "ray";
    for (let k = 0; k < 3; k++) {
      mins[k] = -this.coord(0, 40) + 0;
      maxs[k] = this.coord(0, 48);
    }
    return "lopsided";
  }

  private targetBrush(w: FuzzWorld, mask: number): OracleBrush {
    if (this.f() < 0.75) {
      for (let i = 0; i < 8; i++) {
        const b = this.pick(w.brushes);
        if ((b.contents & mask) !== 0) return b;
      }
    }
    return this.pick(w.brushes);
  }

  /** A point on face f of b: inside, on an edge or at a vertex. */
  private facePoint(b: OracleBrush, f: number, out: Vec3): Vec3 {
    const poly = b.polygons[f] as Uint32Array;
    const v = b.vertices;
    const r = this.f();
    if (r < 0.25) {
      const i = 3 * (this.pick([...poly]) as number);
      out[0] = v[i] as number;
      out[1] = v[i + 1] as number;
      out[2] = v[i + 2] as number;
      return out;
    }
    if (r < 0.5) {
      const k = this.rng.nextInt(poly.length);
      const a = 3 * (poly[k] as number);
      const c = 3 * (poly[(k + 1) % poly.length] as number);
      const t = this.f() < 0.3 ? 0.5 : this.f();
      for (let j = 0; j < 3; j++) {
        out[j] = (v[a + j] as number) + t * ((v[c + j] as number) - (v[a + j] as number));
      }
      return out;
    }
    const k = 1 + this.rng.nextInt(poly.length - 2);
    const a = 3 * (poly[0] as number);
    const p = 3 * (poly[k] as number);
    const q = 3 * (poly[k + 1] as number);
    let u = this.f();
    let w = this.f();
    if (u + w > 1) {
      u = 1 - u;
      w = 1 - w;
    }
    for (let j = 0; j < 3; j++) {
      const o = v[a + j] as number;
      out[j] = o + u * ((v[p + j] as number) - o) + w * ((v[q + j] as number) - o);
    }
    return out;
  }

  private distance(): number {
    const r = this.f();
    if (r < 0.6) return this.pick(DISTANCES);
    if (r < 0.85) return this.f() * 64;
    if (r < 0.92) return -1 / 64;
    return -this.f() * 16;
  }

  /** Places the box so its expanded distance to plane n is `dist` with q on the plane. */
  private place(q: Vec3, n: Vec3, dist: number, mins: Vec3, maxs: Vec3, out: Vec3): void {
    let ext = 0;
    for (let k = 0; k < 3; k++) ext += Math.abs(n[k] as number) * ((maxs[k] - mins[k]) * 0.5);
    for (let k = 0; k < 3; k++) {
      out[k] = (q[k] as number) + (n[k] as number) * (dist + ext) - (mins[k] + maxs[k]) * 0.5;
    }
  }

  private gridMaybe(p: Vec3, share: number): void {
    if (this.f() >= share) return;
    for (let k = 0; k < 3; k++) p[k] = quantizeOrigin(p[k] as number);
  }

  private nearFace(w: FuzzWorld): FuzzCase {
    const mins = vec3();
    const maxs = vec3();
    const hull = this.hull(mins, maxs);
    const mask = this.mask();
    const start = vec3();
    const n = vec3();
    const q = vec3();
    const b = this.targetBrush(w, mask);
    const mode = this.f();
    if (mode < 0.1) {
      for (let k = 0; k < 3; k++) {
        const lo = (w.lo[k] as number) - 64;
        start[k] = lo + this.f() * ((w.hi[k] as number) + 64 - lo);
      }
      this.unit(n);
      this.gridMaybe(start, 0.7);
    } else if (mode < 0.2) {
      this.nearBevel(w, b, mins, maxs, n, start);
    } else {
      const f = this.rng.nextInt(b.polygons.length);
      n[0] = b.faces[4 * f] as number;
      n[1] = b.faces[4 * f + 1] as number;
      n[2] = b.faces[4 * f + 2] as number;
      this.facePoint(b, f, q);
      this.place(q, n, this.distance(), mins, maxs, start);
      this.gridMaybe(start, 0.7);
    }

    const dir = vec3();
    const tmp = vec3();
    let length = -1;
    const r = this.f();
    if (r < 0.25) {
      // Into the face, with jitter.
      const jitter = this.f() < 0.3 ? 0 : this.f() * 0.8;
      this.unit(tmp);
      for (let k = 0; k < 3; k++) dir[k] = -(n[k] as number) + jitter * (tmp[k] as number);
    } else if (r < 0.37) {
      this.tangent(n, dir);
    } else if (r < 0.5) {
      // A tiny angle off parallel, mostly into the face.
      this.tangent(n, dir);
      const theta = this.pick(TINY_SCALE) * (1 + 9 * this.f()) * (this.f() < 0.8 ? -1 : 1);
      for (let k = 0; k < 3; k++) dir[k] = (dir[k] as number) + theta * (n[k] as number);
    } else if (r < 0.7) {
      length = this.aim(b, start, mins, maxs, dir);
    } else if (r < 0.82) {
      dir[2] = this.f() < 0.5 ? 1 : -1;
      if (this.f() < 0.7) length = 18;
    } else {
      this.unit(dir);
    }
    normalize(dir);
    if (length < 0) length = this.length();
    const end = vec3();
    for (let k = 0; k < 3; k++) end[k] = (start[k] as number) + (dir[k] as number) * length;
    return { world: w.name, hull, start, end, mins, maxs, mask };
  }

  /**
   * At the brush's extreme vertex along an axis, measured from the runtime's axial plane (its
   * bounds) or from the vertex itself. Where that plane is a bevel it lies up to one f32 step
   * outside the vertex: starts measured from the plane land in that sliver, which the
   * box-expanded test calls solid and the oracle does not, and starts just inside the vertex
   * catch a bevel that cuts into the brush instead.
   */
  private nearBevel(
    w: FuzzWorld,
    b: OracleBrush,
    mins: Vec3,
    maxs: Vec3,
    n: Vec3,
    out: Vec3,
  ): void {
    const axis = this.rng.nextInt(3);
    const sign = this.f() < 0.5 ? -1 : 1;
    const v = b.vertices;
    let best = 0;
    for (let i = 3; i < v.length; i += 3) {
      if (sign * (v[i + axis] as number) > sign * (v[best + axis] as number)) best = i;
    }
    const plane = w.world.brushBounds[6 * b.index + axis + (sign > 0 ? 3 : 0)] as number;
    const gap = sign * plane - sign * (v[best + axis] as number);
    const q = vec3(v[best] as number, v[best + 1] as number, v[best + 2] as number);
    q[axis] = plane;
    n.fill(0);
    n[axis] = sign;
    const r = this.f();
    let dist: number;
    if (r < 0.25) dist = -gap / 2;
    else if (r < 0.4) dist = -gap;
    else if (r < 0.65) dist = -gap - this.pick(INSIDE_VERTEX);
    else if (r < 0.75) dist = 0;
    else dist = this.distance();
    this.place(q, n, dist, mins, maxs, out);
    this.gridMaybe(out, 0.2);
  }

  private tangent(n: Vec3, out: Vec3): void {
    const r = vec3();
    for (;;) {
      this.unit(r);
      out[0] = (n[1] as number) * r[2] - (n[2] as number) * r[1];
      out[1] = (n[2] as number) * r[0] - (n[0] as number) * r[2];
      out[2] = (n[0] as number) * r[1] - (n[1] as number) * r[0];
      if (normalize(out) > 1e-3) return;
    }
  }

  /**
   * Aims at a vertex or a point on an edge of b: with the box's leading corner, so the sweep
   * grazes it, or with the center. Returns the length to the target (sometimes beyond it).
   */
  private aim(b: OracleBrush, start: Vec3, mins: Vec3, maxs: Vec3, dir: Vec3): number {
    const v = b.vertices;
    const t = vec3();
    if (this.f() < 0.5) {
      const i = 3 * this.rng.nextInt(v.length / 3);
      t.set(v.subarray(i, i + 3));
    } else {
      const e = this.rng.nextInt(b.edgeEnds.length / 2);
      const a = 3 * (b.edgeEnds[2 * e] as number);
      const c = 3 * (b.edgeEnds[2 * e + 1] as number);
      const s = this.f();
      for (let k = 0; k < 3; k++)
        t[k] = (v[a + k] as number) + s * ((v[c + k] as number) - (v[a + k] as number));
    }
    const corner = this.f() < 0.7;
    for (let k = 0; k < 3; k++) {
      const o = (mins[k] + maxs[k]) * 0.5;
      const h = (maxs[k] - mins[k]) * 0.5;
      const sign = (t[k] as number) >= (start[k] as number) + o ? 1 : -1;
      // Target origin: the box's leading corner (or its center) at the point.
      t[k] = (t[k] as number) - o - (corner ? sign * h : 0);
    }
    const jr = this.f();
    const jitter = jr < 0.4 ? 0 : jr < 0.55 ? 1e-9 : jr < 0.7 ? 1 / 64 : jr < 0.85 ? EPS : this.f();
    if (jitter > 0) {
      const u = vec3();
      this.unit(u);
      for (let k = 0; k < 3; k++) t[k] = (t[k] as number) + jitter * (u[k] as number);
    }
    for (let k = 0; k < 3; k++) dir[k] = (t[k] as number) - (start[k] as number);
    const dist = normalize(dir);
    if (dist === 0) dir[2] = -1;
    const k = this.f();
    return dist * (k < 0.5 ? 1 : k < 0.7 ? 1 + 1e-9 : k < 0.85 ? 2 : 0.5 + 2.5 * this.f());
  }

  private length(): number {
    const r = this.f();
    if (r < 0.05) return 0;
    if (r < 0.15) return 0.25;
    if (r < 0.6) return 1 + this.f() * 19;
    if (r < 0.7) return 18;
    if (r < 0.8) return 20 + this.f() * 80;
    return 100 + this.f() * 3996;
  }

  /** A long trace aimed through a thin slab (1–4 u), from just in front of it or farther back. */
  private slabShot(w: FuzzWorld): FuzzCase {
    const mins = vec3();
    const maxs = vec3();
    const hull = this.hull(mins, maxs);
    const mask = this.f() < 0.9 ? MASK_PLAYERSOLID : this.mask();
    const b = w.brushes[this.pick(w.thin)] as OracleBrush;
    let f = thinFace(b);
    const n = vec3(
      b.faces[4 * f] as number,
      b.faces[4 * f + 1] as number,
      b.faces[4 * f + 2] as number,
    );
    if (this.f() < 0.5) {
      // The opposite face: shoot from the other side.
      for (let i = 0; i < b.faces.length / 4; i++) {
        if (
          b.faces[4 * i] === -n[0] &&
          b.faces[4 * i + 1] === -n[1] &&
          b.faces[4 * i + 2] === -n[2]
        ) {
          f = i;
          n[0] = -n[0] + 0;
          n[1] = -n[1] + 0;
          n[2] = -n[2] + 0;
          break;
        }
      }
    }
    const q = vec3();
    this.facePoint(b, f, q);
    const back = this.f() < 0.5 ? this.pick(DISTANCES) : this.f() * 1024;
    const start = vec3();
    this.place(q, n, back, mins, maxs, start);
    this.gridMaybe(start, 0.7);
    const dir = vec3();
    const tmp = vec3();
    this.unit(tmp);
    const jitter = this.f() < 0.3 ? 0 : this.f() * 0.5;
    for (let k = 0; k < 3; k++) dir[k] = -(n[k] as number) + jitter * (tmp[k] as number);
    normalize(dir);
    const length = 100 + this.f() * 3996;
    const end = vec3();
    for (let k = 0; k < 3; k++) end[k] = (start[k] as number) + (dir[k] as number) * length;
    return { world: w.name, hull, start, end, mins, maxs, mask };
  }
}

/** Normalizes v in place and returns its former length (0 leaves it alone). */
export function normalize(v: Vec3): number {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (l > 0) {
    v[0] = v[0] / l + 0;
    v[1] = v[1] / l + 0;
    v[2] = v[2] / l + 0;
  }
  return l;
}
