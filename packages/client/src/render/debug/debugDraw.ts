import {
  type CollisionWorld,
  MASK_PLAYERSOLID,
  PMOVE_TRACE_LOG_CAPACITY,
  type PmoveParams,
  type PmoveTraceLog,
  PmoveTraceRecord,
  TraceResult,
  traceBox,
  type Vec3,
  vec3,
} from "@game/shared";
import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments } from "three";
import { positionsToThree } from "../space";

/**
 * Debug draw (M2 design §2): `r_debugHull` (the hull box), `r_debugTraces` (pmove's traces from
 * the PmoveTraceLog: green when clear, red when they hit, with a tick along the hit normal) and
 * `r_debugGround` (the normal of the ground under the player). `DebugLines` builds the segments in
 * sim space without three.js or the DOM, so the frame's allocation test covers it; `DebugDraw`
 * draws them as one LineSegments with preallocated buffers, converted through space.ts.
 */

/** Length of the tick drawn along a hit normal, u. */
const NORMAL_TICK = 8;
/** Length of the ground normal, u. */
const GROUND_NORMAL = 32;
/** How far below the hull the ground probe looks, u (pm_groundTraceDist is 0.25). */
const GROUND_PROBE = 2;

/** A fixed-capacity list of coloured segments: 6 floats of position and of colour per segment. */
export class SegmentBuffer {
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  count = 0;

  constructor(readonly capacity: number) {
    this.positions = new Float32Array(capacity * 6);
    this.colors = new Float32Array(capacity * 6);
  }

  clear(): void {
    this.count = 0;
  }

  /** Appends a→b in (r, g, b); dropped when full. */
  push(a: Readonly<Vec3>, b: Readonly<Vec3>, r: number, g: number, bl: number): void {
    if (this.count === this.capacity) return;
    const o = this.count * 6;
    const p = this.positions;
    p[o] = a[0] as number;
    p[o + 1] = a[1] as number;
    p[o + 2] = a[2] as number;
    p[o + 3] = b[0] as number;
    p[o + 4] = b[1] as number;
    p[o + 5] = b[2] as number;
    const c = this.colors;
    c[o] = r;
    c[o + 1] = g;
    c[o + 2] = bl;
    c[o + 3] = r;
    c[o + 4] = g;
    c[o + 5] = bl;
    this.count++;
  }
}

/** Segments of one box's 12 edges. */
const BOX_SEGMENTS = 12;
export const DEBUG_TRACE_SEGMENTS = PMOVE_TRACE_LOG_CAPACITY * 2;
export const DEBUG_SHAPE_SEGMENTS = BOX_SEGMENTS + 1;

export class DebugLines {
  /** The newest frame's traces; kept while frames predict no tick, so they don't flicker. */
  readonly traces = new SegmentBuffer(DEBUG_TRACE_SEGMENTS);
  /** The hull and ground normal, rebuilt every frame. */
  readonly shapes = new SegmentBuffer(DEBUG_SHAPE_SEGMENTS);
  private readonly record = new PmoveTraceRecord();
  private readonly tr = new TraceResult();
  private readonly a = vec3();
  private readonly b = vec3();
  private readonly lo = vec3();
  private readonly hi = vec3();

  /** Replaces the traces with `log`'s, unless it is empty (no tick predicted this frame). */
  takeTraces(log: PmoveTraceLog): void {
    if (log.count === 0) return;
    const t = this.traces;
    t.clear();
    const rec = this.record;
    const a = this.a;
    for (let i = 0; i < log.count; i++) {
      log.read(i, rec);
      const hit = rec.fraction < 1;
      t.push(rec.start, rec.endpos, hit ? 1 : 0.15, hit ? 0.2 : 0.9, 0.2);
      if (hit) {
        const e = rec.endpos;
        const n = rec.normal;
        a[0] = (e[0] as number) + (n[0] as number) * NORMAL_TICK;
        a[1] = (e[1] as number) + (n[1] as number) * NORMAL_TICK;
        a[2] = (e[2] as number) + (n[2] as number) * NORMAL_TICK;
        t.push(e, a, 1, 0.85, 0.2);
      }
    }
  }

  clearTraces(): void {
    this.traces.clear();
  }

  /** Starts the frame's shapes. */
  beginShapes(): void {
    this.shapes.clear();
  }

  /** The hull at `origin` (sim u), white. */
  hull(origin: Readonly<Vec3>, mins: Readonly<Vec3>, maxs: Readonly<Vec3>): void {
    const lo = this.lo;
    const hi = this.hi;
    for (let k = 0; k < 3; k++) {
      lo[k] = (origin[k] as number) + (mins[k] as number);
      hi[k] = (origin[k] as number) + (maxs[k] as number);
    }
    // Each edge runs along one axis k, at one of the 4 corners of the other two.
    const a = this.a;
    const b = this.b;
    for (let k = 0; k < 3; k++) {
      const u = (k + 1) % 3;
      const v = (k + 2) % 3;
      for (let c = 0; c < 4; c++) {
        a[k] = lo[k] as number;
        b[k] = hi[k] as number;
        a[u] = (c & 1) === 0 ? (lo[u] as number) : (hi[u] as number);
        b[u] = a[u] as number;
        a[v] = (c & 2) === 0 ? (lo[v] as number) : (hi[v] as number);
        b[v] = a[v] as number;
        this.shapes.push(a, b, 0.95, 0.95, 0.95);
      }
    }
  }

  /**
   * The normal of the ground the hull at `origin` stands on (a short sweep down, like pmove's
   * ground trace): yellow when walkable at pm_minWalkNormal, magenta when steep; nothing in the
   * air. Drawn under `drawAt` (the interpolated origin the hull is drawn at), so it does not
   * lead the hull while `origin` is the latest prediction. A query outside pmove, so it never
   * touches pmove's scratch.
   */
  ground(
    world: CollisionWorld,
    origin: Vec3,
    mins: Vec3,
    maxs: Vec3,
    params: Readonly<PmoveParams>,
    drawAt: Readonly<Vec3> = origin,
  ): void {
    const end = this.a;
    end[0] = origin[0] as number;
    end[1] = origin[1] as number;
    end[2] = (origin[2] as number) - GROUND_PROBE;
    const tr = this.tr;
    traceBox(world, origin, end, mins, maxs, MASK_PLAYERSOLID, tr);
    if (tr.fraction === 1 || tr.allSolid) return;
    const p = this.lo;
    p[0] = (tr.endpos[0] as number) - (origin[0] as number) + (drawAt[0] as number);
    p[1] = (tr.endpos[1] as number) - (origin[1] as number) + (drawAt[1] as number);
    p[2] =
      (tr.endpos[2] as number) -
      (origin[2] as number) +
      (drawAt[2] as number) +
      (mins[2] as number);
    const n = tr.normal;
    const q = this.hi;
    q[0] = (p[0] as number) + (n[0] as number) * GROUND_NORMAL;
    q[1] = (p[1] as number) + (n[1] as number) * GROUND_NORMAL;
    q[2] = (p[2] as number) + (n[2] as number) * GROUND_NORMAL;
    if ((n[2] as number) < params.minWalkNormal) this.shapes.push(p, q, 1, 0.2, 1);
    else this.shapes.push(p, q, 1, 0.9, 0.1);
  }
}

/** `count` floats of `src` into `out` from `at` (`set` would need a subarray view per call). */
function copyFloats(src: Float32Array, count: number, out: Float32Array, at: number): void {
  for (let i = 0; i < count; i++) out[at + i] = src[i] as number;
}

/** Draws DebugLines: one LineSegments, its buffers sized once for every segment it can hold. */
export class DebugDraw {
  readonly object: LineSegments;
  private readonly position: BufferAttribute;
  private readonly color: BufferAttribute;
  private readonly geometry = new BufferGeometry();
  private readonly material = new LineBasicMaterial({ vertexColors: true, depthTest: false });

  constructor() {
    const max = DEBUG_TRACE_SEGMENTS + DEBUG_SHAPE_SEGMENTS;
    this.position = new BufferAttribute(new Float32Array(max * 6), 3);
    this.color = new BufferAttribute(new Float32Array(max * 6), 3);
    this.geometry.setAttribute("position", this.position);
    this.geometry.setAttribute("color", this.color);
    this.object = new LineSegments(this.geometry, this.material);
    // The buffers change every frame and their bounds with them: never cull.
    this.object.frustumCulled = false;
    this.object.renderOrder = 1;
    this.object.visible = false;
  }

  /** Copies `lines` into the buffers (shapes after traces), or hides the object when empty. */
  update(lines: DebugLines, showTraces: boolean): void {
    const t = showTraces ? lines.traces.count : 0;
    const s = lines.shapes.count;
    const pos = this.position.array as Float32Array;
    const col = this.color.array as Float32Array;
    positionsToThree(lines.traces.positions, t * 2, pos, 0);
    copyFloats(lines.traces.colors, t * 6, col, 0);
    positionsToThree(lines.shapes.positions, s * 2, pos, t * 6);
    copyFloats(lines.shapes.colors, s * 6, col, t * 6);
    this.geometry.setDrawRange(0, (t + s) * 2);
    this.position.needsUpdate = true;
    this.color.needsUpdate = true;
    this.object.visible = t + s > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
