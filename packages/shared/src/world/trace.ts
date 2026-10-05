import { DEV_ASSERT } from "../debug/assert";
import { ORIGIN_LIMIT, ORIGIN_SCALE, quantizeOrigin } from "../math/quant";
import { type Vec3, vec3 } from "../math/vec3";
import { ENTITY_NONE, ENTITY_WORLD } from "../sim/entity";
import type { CollisionWorld } from "./collisionWorld";

/**
 * Box traces against the brush world (M1 design A). A brush is inside where n·x < d holds for
 * every plane; touching (= d) is outside. Each plane is pushed out by the box's reach along its
 * normal, so the box becomes a point; entering times stop ε short of the expanded plane and
 * leaving times are exact, which in exact math lets a box touch a brush but never enter one
 * (A.7). Queries walk the world's BVH to find candidate brushes (C). Nothing here allocates:
 * results go into caller-owned TraceResults, the module keeps one scratch `work` record and each
 * world one traversal stack, so these functions are synchronous and non-reentrant.
 */

/**
 * The skin a trace keeps from every surface (D-017): a design constant, not a cvar, because
 * client and server must trace identically and ε is no feel knob. 1/32 u is exact in binary and
 * one origin grid step, so a stop survives end-of-tick rounding (A.9).
 */
export const TRACE_EPSILON = 1 / 32;

/**
 * The largest coordinate (and hull extent) traces and position queries accept: room for long rays
 * past the ±16384 u world, while f64 rounding (2^-32 u at 2^20) stays far below ε. Farther out
 * rounding first eats the skin and then whole brushes, so such input is rejected like NaN.
 */
export const TRACE_COORD_LIMIT = 1048576;

/**
 * How far BVH node and brush bounds are grown before culling: ε, where a trace can stop outside
 * a brush's bounds, plus 1/32 u of slack for rounding in the culling tests (C).
 */
const BVH_MARGIN = 1 / 16;

/** Traces moving farther than this along some axis also clip their path against node bounds. */
const SLAB_MIN_DELTA = 64;

/**
 * Axes the center moves less than this along are slab-tested as standing still: the error stays
 * far inside BVH_MARGIN's slack, and 1/Δ stays finite.
 */
const SLAB_STILL = 1 / 1024;

/** What a trace found. Fields are assigned in declaration order so every result has one shape. */
export class TraceResult {
  /** Fraction of start → end completed, in [0, 1]. */
  fraction = 1;
  /** Origin at `fraction`: exactly `end` at 1 and exactly `start` at 0. */
  readonly endpos: Vec3 = vec3();
  /** The hit plane as stored (not box-expanded); zero when nothing was hit. */
  readonly normal: Vec3 = vec3();
  planeDist = 0;
  /** Index of the hit plane in world.planes / planeSurf, or −1. */
  plane = -1;
  brush = -1;
  /** CONTENTS_* of the hit brush plus every brush the trace started inside. */
  contents = 0;
  /** SURF_* of the hit plane (0 for bevels). */
  surfaceFlags = 0;
  /** ENTITY_WORLD on a hit or a solid start, else ENTITY_NONE. */
  entity = ENTITY_NONE;
  /** The box started inside a brush. The trace still runs, so a box can move out of one. */
  startSolid = false;
  /** The box is inside one brush for the whole move; fraction is then 0. */
  allSolid = false;

  reset(): void {
    this.fraction = 1;
    this.endpos[0] = 0;
    this.endpos[1] = 0;
    this.endpos[2] = 0;
    this.normal[0] = 0;
    this.normal[1] = 0;
    this.normal[2] = 0;
    this.planeDist = 0;
    this.plane = -1;
    this.brush = -1;
    this.contents = 0;
    this.surfaceFlags = 0;
    this.entity = ENTITY_NONE;
    this.startSolid = false;
    this.allSolid = false;
  }
}

/**
 * The trace in progress. Values live in fields rather than arguments or return values so the
 * per-brush call passes no doubles, which V8 would box when the call is not inlined.
 */
class TraceWork {
  // Center-space start and end (S′ = S + o, E′ = E + o) and the box half extents (A.2).
  sx = 0;
  sy = 0;
  sz = 0;
  ex = 0;
  ey = 0;
  ez = 0;
  hx = 0;
  hy = 0;
  hz = 0;
  // Nearest hit so far (A.5) and what the start is inside of.
  fraction = 1;
  brush = -1;
  plane = -1;
  startContents = 0;
  startSolid = false;
  allSolid = false;
  // BVH query box in origin space, grown by BVH_MARGIN (C, node test 1).
  qx0 = 0;
  qy0 = 0;
  qz0 = 0;
  qx1 = 0;
  qy1 = 0;
  qz1 = 0;
  // Long traces: 1/Δ of the center path per axis, 0 for axes slab-tested as still (node test 2).
  slab = false;
  ix = 0;
  iy = 0;
  iz = 0;
  /** Bit k set when the path runs toward −k, so traversal visits right (high) children first. */
  negMask = 0;
  // Work done by the last BVH query: nodes tested and brushes handed to the per-brush test.
  walkNodes = 0;
  walkBrushes = 0;
}

const work = new TraceWork();
const ZERO: Vec3 = vec3();

/** Every contents bit: pointContents and boxContents see all brushes. */
const ALL_CONTENTS = -1;

/** |x| ≤ TRACE_COORD_LIMIT; false for NaN. */
function inRange(x: number): boolean {
  return x >= -TRACE_COORD_LIMIT && x <= TRACE_COORD_LIMIT;
}

function validBox(mins: Vec3, maxs: Vec3): boolean {
  return (
    inRange(mins[0]) &&
    inRange(mins[1]) &&
    inRange(mins[2]) &&
    inRange(maxs[0]) &&
    inRange(maxs[1]) &&
    inRange(maxs[2]) &&
    mins[0] <= maxs[0] &&
    mins[1] <= maxs[1] &&
    mins[2] <= maxs[2]
  );
}

function validPoint(p: Vec3): boolean {
  return inRange(p[0]) && inRange(p[1]) && inRange(p[2]);
}

/** A.2 setup. Returns false (after asserting) on out-of-range or NaN input, or mins > maxs. */
function beginTrace(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3): boolean {
  const ok = validPoint(start) && validPoint(end) && validBox(mins, maxs);
  DEV_ASSERT(ok, "trace needs start, end and box within TRACE_COORD_LIMIT with mins <= maxs");
  const w = work;
  const ox = (mins[0] + maxs[0]) * 0.5;
  const oy = (mins[1] + maxs[1]) * 0.5;
  const oz = (mins[2] + maxs[2]) * 0.5;
  w.sx = start[0] + ox;
  w.sy = start[1] + oy;
  w.sz = start[2] + oz;
  w.ex = end[0] + ox;
  w.ey = end[1] + oy;
  w.ez = end[2] + oz;
  w.hx = (maxs[0] - mins[0]) * 0.5;
  w.hy = (maxs[1] - mins[1]) * 0.5;
  w.hz = (maxs[2] - mins[2]) * 0.5;
  w.fraction = 1;
  w.brush = -1;
  w.plane = -1;
  w.startContents = 0;
  w.startSolid = false;
  w.allSolid = false;
  return ok;
}

/**
 * The one per-brush clip (A.3, A.4), folded into `work` (A.5). Brute force and the BVH both call
 * it, so both produce the same bits. Per plane, first match wins:
 * - separating: sd ≥ 0 and (ed ≥ sd or ed ≥ ε). The brush can neither be hit nor hold the start.
 * - entering: sd ≥ 0. t = (sd − ε)/(sd − ed); the latest wins, a strict > keeps the first plane.
 * - leaving: sd < 0 < ed. t = sd/(sd − ed), the exact touch time; the earliest wins.
 * - otherwise inside throughout: no constraint.
 * Divisions only happen where sd ≠ ed, so parallel motion never divides by zero.
 */
function clipBrush(world: CollisionWorld, b: number): void {
  const planes = world.planes;
  const first = world.brushPlaneStart[b] as number;
  const last = first + (world.brushPlaneCount[b] as number);
  const w = work;
  const sx = w.sx;
  const sy = w.sy;
  const sz = w.sz;
  const ex = w.ex;
  const ey = w.ey;
  const ez = w.ez;
  const hx = w.hx;
  const hy = w.hy;
  const hz = w.hz;
  let tEnter = Number.NEGATIVE_INFINITY;
  let tLeave = 1;
  let enterPlane = -1;
  let endsOutside = false;
  for (let p = first; p < last; p++) {
    const o = 4 * p;
    const nx = planes[o] as number;
    const ny = planes[o + 1] as number;
    const nz = planes[o + 2] as number;
    const d = planes[o + 3] as number;
    const ext = Math.abs(nx) * hx + Math.abs(ny) * hy + Math.abs(nz) * hz;
    const sd = nx * sx + ny * sy + nz * sz - d - ext;
    const ed = nx * ex + ny * ey + nz * ez - d - ext;
    if (sd >= 0) {
      if (ed >= sd || ed >= TRACE_EPSILON) return;
      const t = (sd - TRACE_EPSILON) / (sd - ed);
      // The first entering plane always counts, even when a subnormal sd − ed makes t −∞.
      if (enterPlane < 0 || t > tEnter) {
        tEnter = t;
        enterPlane = p;
      }
    } else if (ed >= 0) {
      endsOutside = true;
      if (ed > 0) {
        const t = sd / (sd - ed);
        if (t < tLeave) tLeave = t;
      }
    }
  }
  if (enterPlane < 0) {
    w.startSolid = true;
    w.startContents |= world.brushContents[b] as number;
    if (!endsOutside) w.allSolid = true;
    return;
  }
  if (!(tEnter < tLeave)) return;
  const t = tEnter > 0 ? tEnter : 0;
  // Ties go to the lower brush index, so the result never depends on visiting order.
  if (t < w.fraction || (t === w.fraction && b < w.brush)) {
    w.fraction = t;
    w.brush = b;
    w.plane = enterPlane;
  }
}

/** A.5: writes the combined result. */
function finishTrace(world: CollisionWorld, start: Vec3, end: Vec3, out: TraceResult): void {
  const w = work;
  const f = w.allSolid ? 0 : w.fraction;
  out.fraction = f;
  const pos = out.endpos;
  if (f === 1) {
    pos[0] = end[0];
    pos[1] = end[1];
    pos[2] = end[2];
  } else if (f === 0) {
    pos[0] = start[0];
    pos[1] = start[1];
    pos[2] = start[2];
  } else {
    // Origin space, so the center offset never touches the result.
    pos[0] = start[0] + f * (end[0] - start[0]);
    pos[1] = start[1] + f * (end[1] - start[1]);
    pos[2] = start[2] + f * (end[2] - start[2]);
  }
  const b = w.brush;
  const n = out.normal;
  if (b >= 0) {
    const p = w.plane;
    const planes = world.planes;
    n[0] = planes[4 * p] as number;
    n[1] = planes[4 * p + 1] as number;
    n[2] = planes[4 * p + 2] as number;
    out.planeDist = planes[4 * p + 3] as number;
    out.plane = p;
    out.brush = b;
    out.contents = (world.brushContents[b] as number) | w.startContents;
    out.surfaceFlags = world.planeSurf[p] as number;
  } else {
    n[0] = 0;
    n[1] = 0;
    n[2] = 0;
    out.planeDist = 0;
    out.plane = -1;
    out.brush = -1;
    out.contents = w.startContents;
    out.surfaceFlags = 0;
  }
  out.entity = b >= 0 || w.startSolid ? ENTITY_WORLD : ENTITY_NONE;
  out.startSolid = w.startSolid;
  out.allSolid = w.allSolid;
}

/** Bad input in a prod build: report the start as stuck so callers keep their origin. */
function rejectTrace(start: Vec3, out: TraceResult): void {
  out.reset();
  out.fraction = 0;
  out.endpos[0] = start[0];
  out.endpos[1] = start[1];
  out.endpos[2] = start[2];
  out.entity = ENTITY_WORLD;
  out.startSolid = true;
  out.allSolid = true;
}

/**
 * Sweeps the box [mins, maxs] (relative to the origin) from start to end against every brush
 * whose contents intersect `mask`: the reference implementation the BVH path must match bit for
 * bit. If the trace starts inside brushes it still reports the first brush it would enter, so a
 * box can move out; `allSolid` means it cannot.
 */
export function traceBoxBrute(
  world: CollisionWorld,
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
  mask: number,
  out: TraceResult,
): void {
  if (!beginTrace(start, end, mins, maxs)) {
    rejectTrace(start, out);
    return;
  }
  const contents = world.brushContents;
  const count = world.brushCount;
  for (let b = 0; b < count; b++) {
    if (((contents[b] as number) & mask) !== 0) clipBrush(world, b);
  }
  finishTrace(world, start, end, out);
}

/** BVH query kinds: what walkBvh does with each candidate brush. */
const WALK_TRACE = 0;
const WALK_POSITION_ANY = 1;
const WALK_POSITION_ALL = 2;
const WALK_BOX = 3;

/** Node test 1 and the per-brush cull use this box: [min(S, E) + mins − m, max(S, E) + maxs + m]. */
function setQueryBox(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3): void {
  const w = work;
  w.qx0 = (start[0] < end[0] ? start[0] : end[0]) + mins[0] - BVH_MARGIN;
  w.qy0 = (start[1] < end[1] ? start[1] : end[1]) + mins[1] - BVH_MARGIN;
  w.qz0 = (start[2] < end[2] ? start[2] : end[2]) + mins[2] - BVH_MARGIN;
  w.qx1 = (start[0] > end[0] ? start[0] : end[0]) + maxs[0] + BVH_MARGIN;
  w.qy1 = (start[1] > end[1] ? start[1] : end[1]) + maxs[1] + BVH_MARGIN;
  w.qz1 = (start[2] > end[2] ? start[2] : end[2]) + maxs[2] + BVH_MARGIN;
  w.slab = false;
  w.ix = 0;
  w.iy = 0;
  w.iz = 0;
  w.negMask = 0;
}

/** Traversal order for every trace, and node test 2 for long ones (C). Call after beginTrace. */
function setTracePath(start: Vec3, end: Vec3): void {
  const w = work;
  const dx = w.ex - w.sx;
  const dy = w.ey - w.sy;
  const dz = w.ez - w.sz;
  w.negMask = (dx < 0 ? 1 : 0) | (dy < 0 ? 2 : 0) | (dz < 0 ? 4 : 0);
  const mx = end[0] - start[0];
  const my = end[1] - start[1];
  const mz = end[2] - start[2];
  if (
    mx > SLAB_MIN_DELTA ||
    mx < -SLAB_MIN_DELTA ||
    my > SLAB_MIN_DELTA ||
    my < -SLAB_MIN_DELTA ||
    mz > SLAB_MIN_DELTA ||
    mz < -SLAB_MIN_DELTA
  ) {
    // Inline rather than a helper: a double returned from a call that is not inlined gets boxed.
    w.slab = true;
    w.ix = dx < SLAB_STILL && dx > -SLAB_STILL ? 0 : 1 / dx;
    w.iy = dy < SLAB_STILL && dy > -SLAB_STILL ? 0 : 1 / dy;
    w.iz = dz < SLAB_STILL && dz > -SLAB_STILL ? 0 : 1 / dz;
  }
}

/**
 * Node test 2: whether the center path S′ → E′ enters node bounds grown by h + m (offset o in
 * nodeBounds) no later than the nearest hit so far. A brush's hit point lies inside its bounds
 * grown by h + ε, so a node entered only after the best hit cannot beat it; strictly later is
 * pruned, which keeps equal-time hits for the brush-index tie break.
 */
function slabReaches(nb: Float64Array, o: number): boolean {
  const w = work;
  let t0 = 0;
  let t1 = w.fraction;
  let lo = (nb[o] as number) - w.hx - BVH_MARGIN;
  let hi = (nb[o + 3] as number) + w.hx + BVH_MARGIN;
  let inv = w.ix;
  if (inv === 0) {
    if (w.sx < lo || w.sx > hi) return false;
  } else {
    const ta = (lo - w.sx) * inv;
    const tb = (hi - w.sx) * inv;
    if (inv > 0) {
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    } else {
      if (tb > t0) t0 = tb;
      if (ta < t1) t1 = ta;
    }
    if (t0 > t1) return false;
  }
  lo = (nb[o + 1] as number) - w.hy - BVH_MARGIN;
  hi = (nb[o + 4] as number) + w.hy + BVH_MARGIN;
  inv = w.iy;
  if (inv === 0) {
    if (w.sy < lo || w.sy > hi) return false;
  } else {
    const ta = (lo - w.sy) * inv;
    const tb = (hi - w.sy) * inv;
    if (inv > 0) {
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    } else {
      if (tb > t0) t0 = tb;
      if (ta < t1) t1 = ta;
    }
    if (t0 > t1) return false;
  }
  lo = (nb[o + 2] as number) - w.hz - BVH_MARGIN;
  hi = (nb[o + 5] as number) + w.hz + BVH_MARGIN;
  inv = w.iz;
  if (inv === 0) return w.sz >= lo && w.sz <= hi;
  const ta = (lo - w.sz) * inv;
  const tb = (hi - w.sz) * inv;
  if (inv > 0) {
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  } else {
    if (tb > t0) t0 = tb;
    if (ta < t1) t1 = ta;
  }
  return t0 <= t1;
}

/**
 * Walks the BVH and hands every masked brush whose bounds meet the query box to the query `kind`
 * (C). Iterative: the far child goes on the world's stack and the near one is visited next, so the
 * stack never holds more than one entry per level (BVH_MAX_DEPTH < BVH_STACK_SIZE). Returns the
 * OR of matching contents for the position and box kinds; traces fold into `work` instead.
 */
function walkBvh(
  world: CollisionWorld,
  mask: number,
  kind: number,
  absMins: Vec3,
  absMaxs: Vec3,
): number {
  const bvh = world.bvh;
  const nodeCount = bvh.nodeCount;
  const w = work;
  w.walkNodes = 0;
  w.walkBrushes = 0;
  if (nodeCount.length === 0) return 0;
  const nb = bvh.nodeBounds;
  const nodeFirst = bvh.nodeFirst;
  const nodeAxis = bvh.nodeAxis;
  const refs = bvh.leafRefs;
  const stack = bvh.stack;
  const bb = world.brushBounds;
  const contents = world.brushContents;
  const qx0 = w.qx0;
  const qy0 = w.qy0;
  const qz0 = w.qz0;
  const qx1 = w.qx1;
  const qy1 = w.qy1;
  const qz1 = w.qz1;
  const slab = kind === WALK_TRACE && w.slab;
  const negMask = w.negMask;
  let found = 0;
  let sp = 0;
  let node = 0;
  let nodes = 0;
  let brushes = 0;
  for (;;) {
    nodes++;
    const o = 6 * node;
    if (
      (nb[o] as number) <= qx1 &&
      (nb[o + 3] as number) >= qx0 &&
      (nb[o + 1] as number) <= qy1 &&
      (nb[o + 4] as number) >= qy0 &&
      (nb[o + 2] as number) <= qz1 &&
      (nb[o + 5] as number) >= qz0 &&
      (!slab || slabReaches(nb, o))
    ) {
      const count = nodeCount[node] as number;
      if (count === 0) {
        if (((negMask >> (nodeAxis[node] as number)) & 1) !== 0) {
          stack[sp++] = node + 1;
          node = nodeFirst[node] as number;
        } else {
          stack[sp++] = nodeFirst[node] as number;
          node = node + 1;
        }
        continue;
      }
      const first = nodeFirst[node] as number;
      const last = first + count;
      for (let i = first; i < last; i++) {
        const b = refs[i] as number;
        const c = contents[b] as number;
        if ((c & mask) === 0) continue;
        const p = 6 * b;
        if (
          (bb[p] as number) > qx1 ||
          (bb[p + 3] as number) < qx0 ||
          (bb[p + 1] as number) > qy1 ||
          (bb[p + 4] as number) < qy0 ||
          (bb[p + 2] as number) > qz1 ||
          (bb[p + 5] as number) < qz0
        ) {
          continue;
        }
        brushes++;
        if (kind === WALK_TRACE) {
          clipBrush(world, b);
        } else if (kind === WALK_BOX) {
          if (brushOverlapsBox(world, b, absMins, absMaxs)) found |= c;
        } else if (brushContainsBox(world, b)) {
          found |= c;
          if (kind === WALK_POSITION_ANY) {
            // One holding brush settles the test: drop the rest of the walk.
            sp = 0;
            break;
          }
        }
      }
    }
    if (sp === 0) {
      w.walkNodes = nodes;
      w.walkBrushes = brushes;
      return found;
    }
    node = stack[--sp] as number;
  }
}

/**
 * Nodes tested by the last BVH walk (traceBox, positionTest, positionContents, pointContents or
 * boxContents; rejected inputs do not walk): what culling saves, for tests and benchmarks.
 */
export function lastQueryNodes(): number {
  return work.walkNodes;
}

/** Brushes the last BVH walk passed through its culling tests to the per-brush test. */
export function lastQueryBrushes(): number {
  return work.walkBrushes;
}

/**
 * The trace pmove and hit tests call: traceBoxBrute's result bit for bit, with the BVH choosing
 * which brushes to clip (C). Every brush that could start the box solid or be hit passes the
 * culling tests, and the per-brush clip and tie break are traceBoxBrute's own, so visiting order
 * and skipped brushes never show in the result.
 */
export function traceBox(
  world: CollisionWorld,
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
  mask: number,
  out: TraceResult,
): void {
  if (!beginTrace(start, end, mins, maxs)) {
    rejectTrace(start, out);
    return;
  }
  setQueryBox(start, end, mins, maxs);
  setTracePath(start, end);
  walkBvh(world, mask, WALK_TRACE, ZERO, ZERO);
  finishTrace(world, start, end, out);
}

/** traceBox with a point: the same code with zero extents, so the bits match exactly. */
export function traceRay(
  world: CollisionWorld,
  start: Vec3,
  end: Vec3,
  mask: number,
  out: TraceResult,
): void {
  traceBox(world, start, end, ZERO, ZERO, mask, out);
}

/**
 * Whether masked brush b strictly contains the box set up in `work`: sd < 0 on every plane,
 * with the same expression clipBrush uses, so this agrees with a zero-length trace (A.6).
 */
function brushContainsBox(world: CollisionWorld, b: number): boolean {
  const planes = world.planes;
  const first = world.brushPlaneStart[b] as number;
  const last = first + (world.brushPlaneCount[b] as number);
  const w = work;
  const sx = w.sx;
  const sy = w.sy;
  const sz = w.sz;
  const hx = w.hx;
  const hy = w.hy;
  const hz = w.hz;
  for (let p = first; p < last; p++) {
    const o = 4 * p;
    const nx = planes[o] as number;
    const ny = planes[o + 1] as number;
    const nz = planes[o + 2] as number;
    const d = planes[o + 3] as number;
    const ext = Math.abs(nx) * hx + Math.abs(ny) * hy + Math.abs(nz) * hz;
    if (nx * sx + ny * sy + nz * sz - d - ext >= 0) return false;
  }
  return true;
}

/** Brute-force reference for the position queries: every masked brush holding the box. */
function scanPosition(world: CollisionWorld, mask: number): number {
  const contents = world.brushContents;
  const count = world.brushCount;
  let found = 0;
  for (let b = 0; b < count; b++) {
    const c = contents[b] as number;
    if ((c & mask) !== 0 && brushContainsBox(world, b)) found |= c;
  }
  return found;
}

/**
 * Sets `work` up for a position query. Out-of-range or NaN input asserts and reports false, which
 * the callers treat as "inside" so a NaN position is never accepted.
 */
function beginPosition(origin: Vec3, mins: Vec3, maxs: Vec3): boolean {
  const ok = validPoint(origin) && validBox(mins, maxs);
  DEV_ASSERT(ok, "position test needs origin and box within TRACE_COORD_LIMIT, mins <= maxs");
  const w = work;
  w.sx = origin[0] + (mins[0] + maxs[0]) * 0.5;
  w.sy = origin[1] + (mins[1] + maxs[1]) * 0.5;
  w.sz = origin[2] + (mins[2] + maxs[2]) * 0.5;
  w.hx = (maxs[0] - mins[0]) * 0.5;
  w.hy = (maxs[1] - mins[1]) * 0.5;
  w.hz = (maxs[2] - mins[2]) * 0.5;
  if (ok) setQueryBox(origin, origin, mins, maxs);
  return ok;
}

/**
 * True when the box at `origin` is clear of every masked brush: a zero-length trace that does not
 * start solid. Touching a brush is clear (A.1). It shares the trace's center/half-extent
 * arithmetic, so touching is exact for grid origins and hulls (what pmove and snapOrigin pass);
 * off-grid values can round a touching box either way.
 */
export function positionTest(
  world: CollisionWorld,
  origin: Vec3,
  mins: Vec3,
  maxs: Vec3,
  mask: number,
): boolean {
  if (!beginPosition(origin, mins, maxs)) return false;
  return walkBvh(world, mask, WALK_POSITION_ANY, ZERO, ZERO) === 0;
}

/**
 * positionTest that reports what holds the box: the OR of the contents of every masked brush the
 * box is inside, 0 when clear. Bad input asserts and returns `mask`, so it never reads as clear.
 */
export function positionContents(
  world: CollisionWorld,
  origin: Vec3,
  mins: Vec3,
  maxs: Vec3,
  mask: number,
): number {
  if (!beginPosition(origin, mins, maxs)) return mask >>> 0;
  return walkBvh(world, mask, WALK_POSITION_ALL, ZERO, ZERO);
}

/** positionContents without the BVH: the reference the BVH queries must match. */
export function positionContentsBrute(
  world: CollisionWorld,
  origin: Vec3,
  mins: Vec3,
  maxs: Vec3,
  mask: number,
): number {
  if (!beginPosition(origin, mins, maxs)) return mask >>> 0;
  return scanPosition(world, mask);
}

/** OR of the contents of every brush strictly containing p (water level samples, docs/03 §4.13). */
export function pointContents(world: CollisionWorld, p: Vec3): number {
  if (!beginPosition(p, ZERO, ZERO)) return 0;
  return walkBvh(world, ALL_CONTENTS, WALK_POSITION_ALL, ZERO, ZERO);
}

/**
 * Whether brush b's interior overlaps the box: per plane, the box corner furthest behind it is
 * strictly behind. Testing the corner itself (not center ± half extents, which rounds) keeps a
 * touching box outside exactly on axis-aligned planes, whatever the bounds.
 */
function brushOverlapsBox(world: CollisionWorld, b: number, absMins: Vec3, absMaxs: Vec3): boolean {
  const planes = world.planes;
  const first = world.brushPlaneStart[b] as number;
  const last = first + (world.brushPlaneCount[b] as number);
  for (let p = first; p < last; p++) {
    const o = 4 * p;
    const nx = planes[o] as number;
    const ny = planes[o + 1] as number;
    const nz = planes[o + 2] as number;
    const cx = nx >= 0 ? absMins[0] : absMaxs[0];
    const cy = ny >= 0 ? absMins[1] : absMaxs[1];
    const cz = nz >= 0 ? absMins[2] : absMaxs[2];
    if (nx * cx + ny * cy + nz * cz - (planes[o + 3] as number) >= 0) return false;
  }
  return true;
}

function validContentsBox(absMins: Vec3, absMaxs: Vec3): boolean {
  const ok = validBox(absMins, absMaxs);
  DEV_ASSERT(ok, "boxContents needs bounds within TRACE_COORD_LIMIT with mins <= maxs");
  return ok;
}

/**
 * OR of the contents of every brush whose interior overlaps the open box (absMins, absMaxs), in
 * world coordinates (ladder and trigger volumes). Boxes that only touch do not overlap.
 */
export function boxContents(world: CollisionWorld, absMins: Vec3, absMaxs: Vec3): number {
  if (!validContentsBox(absMins, absMaxs)) return 0;
  // A query box at the origin with the absolute bounds as its extents.
  setQueryBox(ZERO, ZERO, absMins, absMaxs);
  return walkBvh(world, ALL_CONTENTS, WALK_BOX, absMins, absMaxs);
}

/** boxContents without the BVH: the reference the BVH query must match. */
export function boxContentsBrute(world: CollisionWorld, absMins: Vec3, absMaxs: Vec3): number {
  if (!validContentsBox(absMins, absMaxs)) return 0;
  const contents = world.brushContents;
  const count = world.brushCount;
  let found = 0;
  for (let b = 0; b < count; b++) {
    const c = contents[b] as number;
    if (brushOverlapsBox(world, b, absMins, absMaxs)) found |= c;
  }
  return found;
}

/** snapOrigin outcomes (D-017), returned for tests and debug counters. */
export const SNAP_ROUNDED = 0;
export const SNAP_CORNER = 1;
export const SNAP_PREVIOUS = 2;

const snapPoint: Vec3 = vec3();
const cornerDistSq = new Float64Array(8);

function clampOrigin(x: number): number {
  return x < -ORIGIN_LIMIT ? -ORIGIN_LIMIT : x > ORIGIN_LIMIT ? ORIGIN_LIMIT : x;
}

/**
 * End-of-tick origin snap (D-017): the nearest clear 1/32 u grid point. Plain rounding moves a
 * box resting in the ε skin of a slope or rotated wall by up to √3/64 along the normal, and over
 * repeated slides that wanders into solid (A.9). In order:
 * 1. the rounded point, if clear (SNAP_ROUNDED);
 * 2. the corners of the grid cell holding `exact`, nearest first, ties by corner bits (bit 0 = x
 *    rounded up, bit 1 = y, bit 2 = z) (SNAP_CORNER);
 * 3. `prevOrigin`, last tick's clear grid point (SNAP_PREVIOUS).
 * Pass a world-only mask: snapping against other players would make prediction depend on them.
 * `out` may alias `exact` or `prevOrigin`.
 */
export function snapOrigin(
  world: CollisionWorld,
  exact: Vec3,
  mins: Vec3,
  maxs: Vec3,
  mask: number,
  prevOrigin: Vec3,
  out: Vec3,
): number {
  const x = exact[0];
  const y = exact[1];
  const z = exact[2];
  const valid = validPoint(exact);
  DEV_ASSERT(valid, "snapOrigin needs a position within TRACE_COORD_LIMIT");
  if (valid) {
    const p = snapPoint;
    p[0] = quantizeOrigin(x);
    p[1] = quantizeOrigin(y);
    p[2] = quantizeOrigin(z);
    if (positionTest(world, p, mins, maxs, mask)) {
      out[0] = p[0];
      out[1] = p[1];
      out[2] = p[2];
      return SNAP_ROUNDED;
    }
    const rx = p[0];
    const ry = p[1];
    const rz = p[2];
    const cx = clampOrigin(x);
    const cy = clampOrigin(y);
    const cz = clampOrigin(z);
    const x0 = (Math.floor(cx * ORIGIN_SCALE) + 0) / ORIGIN_SCALE;
    const x1 = (Math.ceil(cx * ORIGIN_SCALE) + 0) / ORIGIN_SCALE;
    const y0 = (Math.floor(cy * ORIGIN_SCALE) + 0) / ORIGIN_SCALE;
    const y1 = (Math.ceil(cy * ORIGIN_SCALE) + 0) / ORIGIN_SCALE;
    const z0 = (Math.floor(cz * ORIGIN_SCALE) + 0) / ORIGIN_SCALE;
    const z1 = (Math.ceil(cz * ORIGIN_SCALE) + 0) / ORIGIN_SCALE;
    const dx0 = (cx - x0) * (cx - x0);
    const dx1 = (x1 - cx) * (x1 - cx);
    const dy0 = (cy - y0) * (cy - y0);
    const dy1 = (y1 - cy) * (y1 - cy);
    const dz0 = (cz - z0) * (cz - z0);
    const dz1 = (z1 - cz) * (z1 - cz);
    // Corners that repeat (an axis already on the grid) are skipped.
    let skip = 0;
    for (let c = 0; c < 8; c++) {
      const dxy = ((c & 1) !== 0 ? dx1 : dx0) + ((c & 2) !== 0 ? dy1 : dy0);
      cornerDistSq[c] = dxy + ((c & 4) !== 0 ? dz1 : dz0);
      if (
        ((c & 1) !== 0 && x0 === x1) ||
        ((c & 2) !== 0 && y0 === y1) ||
        ((c & 4) !== 0 && z0 === z1)
      ) {
        skip |= 1 << c;
      }
    }
    for (let n = 0; n < 8; n++) {
      let best = -1;
      let bestDist = 0;
      for (let c = 0; c < 8; c++) {
        if ((skip & (1 << c)) !== 0) continue;
        const dist = cornerDistSq[c] as number;
        if (best < 0 || dist < bestDist) {
          best = c;
          bestDist = dist;
        }
      }
      if (best < 0) break;
      skip |= 1 << best;
      p[0] = (best & 1) !== 0 ? x1 : x0;
      p[1] = (best & 2) !== 0 ? y1 : y0;
      p[2] = (best & 4) !== 0 ? z1 : z0;
      // The rounded point is one of the corners and already failed.
      if (p[0] === rx && p[1] === ry && p[2] === rz) continue;
      if (positionTest(world, p, mins, maxs, mask)) {
        out[0] = p[0];
        out[1] = p[1];
        out[2] = p[2];
        return SNAP_CORNER;
      }
    }
  }
  out[0] = prevOrigin[0];
  out[1] = prevOrigin[1];
  out[2] = prevOrigin[2];
  return SNAP_PREVIOUS;
}
