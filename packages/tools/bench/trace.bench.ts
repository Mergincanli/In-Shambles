import { readFileSync } from "node:fs";
import { PerformanceObserver, performance } from "node:perf_hooks";
import {
  buildCollisionWorld,
  type CollisionWorld,
  decodeCmap,
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  lastQueryBrushes,
  lastQueryNodes,
  MASK_PLAYERSOLID,
  MASK_SOLID,
  Mulberry32,
  positionTest,
  quantizeOrigin,
  SNAP_PREVIOUS,
  snapOrigin,
  TraceResult,
  traceBox,
  traceRay,
  type Vec3,
  vec3,
} from "@game/shared";
import { COURSE_MAP_DIR, courseFileName } from "../src/greybox/courses";
import { fromRoot } from "../src/paths";

/**
 * The traceBox microbenchmark (docs/10 §4.4: ≤ 1 µs average on movement_lab). The cases model one
 * player-tick of pmove (docs/03 §3, §4.8–§4.10) on the lab map: short hull sweeps from clear grid
 * spots on floors and against walls, steps and slopes, 0.25 u ground probes, 18 u step-up and
 * step-down sweeps, and snap position tests. Long rays are timed but kept out of the average.
 * Cases are drawn once from a seeded Mulberry32 into typed arrays, so the timed loops only copy
 * inputs and call the query.
 */

export type BenchQuery = "box" | "position" | "ray";

export interface BenchCategory {
  readonly name: string;
  readonly query: BenchQuery;
  /**
   * Calls per player-tick in the box-trace average; 0 keeps the category out of it. ESTIMATE
   * (design, docs/03 §3): two ground traces, about three slide-move sweeps over the plain and
   * stepped paths, the step up and down, and one snapOrigin position test.
   */
  readonly weight: number;
  readonly what: string;
}

export const BENCH_CATEGORIES: readonly BenchCategory[] = [
  { name: "move", query: "box", weight: 3, what: "hull sweep <= 12 u from floors and walls" },
  { name: "ground", query: "box", weight: 2, what: "0.25 u ground probe" },
  { name: "step", query: "box", weight: 2, what: "18 u step up / step down" },
  { name: "position", query: "position", weight: 1, what: "positionTest near surfaces" },
  { name: "ray", query: "ray", weight: 0, what: "1024-8192 u ray (not averaged)" },
];

/** One category's cases: origins (3 per case), ends for traces, and the hull (0 standing). */
export interface CaseSet {
  readonly category: BenchCategory;
  readonly start: Float64Array;
  readonly end: Float64Array;
  readonly hull: Uint8Array;
}

export interface TraceWorkload {
  readonly world: CollisionWorld;
  readonly sets: readonly CaseSet[];
  /** Cases per category; a power of two, so loops cycle with a mask. */
  readonly size: number;
}

/**
 * The longest horizontal hull sweep in the mix: one tick at 720 u/s, above the circle-jump band
 * (docs/03 MV-09) and about twice pm_sprintSpeed (docs/03 §2.2).
 */
export const MOVE_MAX = 12;
/** pm_groundTraceDist, FACT for Q3 (docs/03 §2.1, §4.10). */
export const GROUND_PROBE = 0.25;
/** pm_stepSize, FACT for Q3 (docs/03 §2.1, §4.9). */
export const STEP = 18;
/**
 * Eye height above the origin, standing and crouched (docs/03 §2 hull table, FACT for Q3). Rays
 * start here, inside the hull, so they start clear.
 */
const EYE_STANDING = 26;
const EYE_CROUCHED = 12;
/** Long rays: shots and line-of-sight checks across the lab. */
export const RAY_MIN = 1024;
export const RAY_MAX = 8192;

export const DEFAULT_SEED = 0x7ace;
export const DEFAULT_CASES = 4096;

export function loadMovementLab(): CollisionWorld {
  const bytes = readFileSync(fromRoot(...COURSE_MAP_DIR, courseFileName("movement_lab")));
  return buildCollisionWorld(decodeCmap(new Uint8Array(bytes)));
}

function maxsOf(hull: number): Vec3 {
  return hull === 0 ? HULL_STANDING_MAXS : HULL_CROUCHED_MAXS;
}

/** Draws clear grid spots like the ones pmove leaves a player on. */
class SpotSampler {
  private readonly rng: Mulberry32;
  private readonly world: CollisionWorld;
  private readonly tr = new TraceResult();
  private readonly a = vec3();
  private readonly b = vec3();
  /** The last spot, its hull, and for wall spots the unit direction that reached the wall. */
  readonly spot = vec3();
  hull = 0;
  readonly dir = vec3();
  wall = false;

  constructor(world: CollisionWorld, seed: number) {
    this.world = world;
    this.rng = new Mulberry32(seed);
  }

  f(): number {
    return this.rng.nextFloat();
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return this.rng.nextInt(n);
  }

  between(lo: number, hi: number): number {
    return lo + this.f() * (hi - lo);
  }

  /** A random horizontal unit vector. */
  yaw(out: Vec3): Vec3 {
    for (;;) {
      const x = this.f() * 2 - 1;
      const y = this.f() * 2 - 1;
      const l = x * x + y * y;
      if (l > 1e-4 && l <= 1) {
        const s = Math.sqrt(l);
        out[0] = x / s;
        out[1] = y / s;
        out[2] = 0;
        return out;
      }
    }
  }

  /** Snaps `p` like pmove's end of tick; false when no clear grid point is near. */
  private settle(p: Vec3, maxs: Vec3): boolean {
    return (
      snapOrigin(this.world, p, HULL_MINS, maxs, MASK_PLAYERSOLID, p, this.spot) !== SNAP_PREVIOUS
    );
  }

  /**
   * A standing spot on the ground next to a random brush (so small features weigh as much as the
   * big floor strips); with `wallShare`, swept sideways into the nearest wall instead. The choice
   * is made once, so sweeps that miss are redrawn as wall spots and the share holds.
   */
  next(wallShare: number): void {
    const w = this.world;
    const bb = w.brushBounds;
    const tr = this.tr;
    const wantWall = this.f() < wallShare;
    for (;;) {
      const brush = this.rng.nextInt(w.brushCount);
      if (((w.brushContents[brush] as number) & MASK_PLAYERSOLID) === 0) continue;
      const o = 6 * brush;
      this.hull = this.f() < 0.5 ? 0 : 1;
      const maxs = maxsOf(this.hull);
      const a = this.a;
      a[0] = this.between((bb[o] as number) - 48, (bb[o + 3] as number) + 48);
      a[1] = this.between((bb[o + 1] as number) - 48, (bb[o + 4] as number) + 48);
      a[2] = (bb[o + 5] as number) + this.between(32, 96);
      if (!positionTest(w, a, HULL_MINS, maxs, MASK_PLAYERSOLID)) continue;
      const b = this.b;
      b[0] = a[0];
      b[1] = a[1];
      b[2] = a[2] - 512;
      traceBox(w, a, b, HULL_MINS, maxs, MASK_PLAYERSOLID, tr);
      if (tr.startSolid || tr.fraction === 1 || !this.settle(tr.endpos, maxs)) continue;
      this.wall = false;
      if (!wantWall) return;
      // Sweep sideways until something blocks: the stop is a spot against a wall or step face.
      const d = this.yaw(this.dir);
      a.set(this.spot);
      const reach = this.between(16, 384);
      b[0] = a[0] + d[0] * reach;
      b[1] = a[1] + d[1] * reach;
      b[2] = a[2];
      traceBox(w, a, b, HULL_MINS, maxs, MASK_PLAYERSOLID, tr);
      if (tr.fraction === 1 || tr.startSolid || !this.settle(tr.endpos, maxs)) continue;
      this.wall = true;
      return;
    }
  }

  /** A sweep direction from the last spot: into or along its wall, or anywhere on open ground. */
  moveDir(out: Vec3): Vec3 {
    if (this.wall) {
      const d = this.dir;
      const k = this.between(-2, 2);
      const x = d[0] - d[1] * k;
      const y = d[1] + d[0] * k;
      const s = Math.sqrt(x * x + y * y);
      out[0] = x / s;
      out[1] = y / s;
      out[2] = 0;
      return out;
    }
    return this.yaw(out);
  }

  /** Raises the last spot by up to STEP like the step-up sweep, then sweeps `len` along `d`. */
  stepped(d: Vec3, len: number, out: Vec3): number {
    const w = this.world;
    const tr = this.tr;
    const maxs = maxsOf(this.hull);
    const a = this.a;
    const b = this.b;
    a.set(this.spot);
    b[0] = a[0];
    b[1] = a[1];
    b[2] = a[2] + STEP;
    traceBox(w, a, b, HULL_MINS, maxs, MASK_PLAYERSOLID, tr);
    const raised = tr.endpos[2] - a[2];
    a.set(tr.endpos);
    b[0] = a[0] + d[0] * len;
    b[1] = a[1] + d[1] * len;
    b[2] = a[2];
    traceBox(w, a, b, HULL_MINS, maxs, MASK_PLAYERSOLID, tr);
    out.set(tr.endpos);
    return raised;
  }
}

function put(arr: Float64Array, i: number, x: number, y: number, z: number): void {
  arr[3 * i] = x;
  arr[3 * i + 1] = y;
  arr[3 * i + 2] = z;
}

/** The seeded case mix; deterministic for a given world, seed and size. */
export function buildTraceWorkload(
  world: CollisionWorld,
  seed = DEFAULT_SEED,
  size = DEFAULT_CASES,
): TraceWorkload {
  if (size < 1 || (size & (size - 1)) !== 0) throw new Error(`case count ${size} is not 2^k`);
  const sampler = new SpotSampler(world, seed);
  const d = vec3();
  const p = vec3();
  const sets: CaseSet[] = [];
  for (const category of BENCH_CATEGORIES) {
    const start = new Float64Array(3 * size);
    const end = new Float64Array(3 * size);
    const hull = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      const s = sampler.spot;
      switch (category.name) {
        case "move": {
          sampler.next(0.6);
          sampler.moveDir(d);
          const len = sampler.between(0.5, MOVE_MAX);
          // Most sweeps are grounded and level; the rest climb or fall like air moves.
          const dz = sampler.f() < 0.7 ? 0 : sampler.between(-6, 3);
          put(start, i, s[0], s[1], s[2]);
          put(end, i, s[0] + d[0] * len, s[1] + d[1] * len, s[2] + dz);
          break;
        }
        case "ground": {
          sampler.next(0.4);
          // A fifth probe from the air, as in the airborne ticks of a jump; under a low ceiling the
          // raised start can be solid, and then the probe stays on the ground.
          p.set(s);
          if (sampler.f() < 0.2) {
            p[2] = quantizeOrigin(s[2] + sampler.between(1, 48));
            if (!positionTest(world, p, HULL_MINS, maxsOf(sampler.hull), MASK_PLAYERSOLID)) {
              p[2] = s[2];
            }
          }
          const z = p[2];
          put(start, i, s[0], s[1], z);
          put(end, i, s[0], s[1], z - GROUND_PROBE);
          break;
        }
        case "step": {
          sampler.next(0.6);
          if ((i & 1) === 0) {
            put(start, i, s[0], s[1], s[2]);
            put(end, i, s[0], s[1], s[2] + STEP);
          } else {
            sampler.moveDir(d);
            const raised = sampler.stepped(d, sampler.between(0.5, MOVE_MAX), p);
            put(start, i, p[0], p[1], p[2]);
            put(end, i, p[0], p[1], p[2] - raised);
          }
          break;
        }
        case "position": {
          sampler.next(0.6);
          // snapOrigin's candidates: grid points within two steps of a clear spot, some of them
          // touching or inside the surface next to it.
          put(
            start,
            i,
            quantizeOrigin(s[0] + (sampler.int(5) - 2) / 32),
            quantizeOrigin(s[1] + (sampler.int(5) - 2) / 32),
            quantizeOrigin(s[2] + (sampler.int(5) - 2) / 32),
          );
          break;
        }
        default: {
          sampler.next(0);
          const len = sampler.between(RAY_MIN, RAY_MAX);
          const eye = sampler.hull === 0 ? EYE_STANDING : EYE_CROUCHED;
          for (;;) {
            d[0] = sampler.f() * 2 - 1;
            d[1] = sampler.f() * 2 - 1;
            d[2] = sampler.f() - 0.5;
            const l = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
            if (l > 1e-4 && l <= 1) {
              const k = len / Math.sqrt(l);
              put(start, i, s[0], s[1], s[2] + eye);
              put(end, i, s[0] + d[0] * k, s[1] + d[1] * k, s[2] + eye + d[2] * k);
              break;
            }
          }
        }
      }
      hull[i] = sampler.hull;
    }
    sets.push({ category, start, end, hull });
  }
  return { world, sets, size };
}

// Timed loops. One function per query kind keeps each call site monomorphic; inputs are copied
// into module scratch vectors, and every result feeds the returned sink.
const tr = new TraceResult();
const s0 = vec3();
const e0 = vec3();

export function runBoxCases(world: CollisionWorld, set: CaseSet, calls: number): number {
  const start = set.start;
  const end = set.end;
  const hull = set.hull;
  const mask = set.hull.length - 1;
  let sink = 0;
  for (let n = 0; n < calls; n++) {
    const i = n & mask;
    const o = 3 * i;
    s0[0] = start[o] as number;
    s0[1] = start[o + 1] as number;
    s0[2] = start[o + 2] as number;
    e0[0] = end[o] as number;
    e0[1] = end[o + 1] as number;
    e0[2] = end[o + 2] as number;
    const maxs = hull[i] === 0 ? HULL_STANDING_MAXS : HULL_CROUCHED_MAXS;
    traceBox(world, s0, e0, HULL_MINS, maxs, MASK_PLAYERSOLID, tr);
    sink += tr.fraction + tr.endpos[2] + (tr.startSolid ? 1 : 0);
  }
  return sink;
}

export function runPositionCases(world: CollisionWorld, set: CaseSet, calls: number): number {
  const start = set.start;
  const hull = set.hull;
  const mask = set.hull.length - 1;
  let sink = 0;
  for (let n = 0; n < calls; n++) {
    const i = n & mask;
    const o = 3 * i;
    s0[0] = start[o] as number;
    s0[1] = start[o + 1] as number;
    s0[2] = start[o + 2] as number;
    const maxs = hull[i] === 0 ? HULL_STANDING_MAXS : HULL_CROUCHED_MAXS;
    if (positionTest(world, s0, HULL_MINS, maxs, MASK_PLAYERSOLID)) sink++;
  }
  return sink;
}

export function runRayCases(world: CollisionWorld, set: CaseSet, calls: number): number {
  const start = set.start;
  const end = set.end;
  const mask = set.hull.length - 1;
  let sink = 0;
  for (let n = 0; n < calls; n++) {
    const o = 3 * (n & mask);
    s0[0] = start[o] as number;
    s0[1] = start[o + 1] as number;
    s0[2] = start[o + 2] as number;
    e0[0] = end[o] as number;
    e0[1] = end[o + 1] as number;
    e0[2] = end[o + 2] as number;
    traceRay(world, s0, e0, MASK_SOLID, tr);
    sink += tr.fraction;
  }
  return sink;
}

export function runCases(world: CollisionWorld, set: CaseSet, calls: number): number {
  const q = set.category.query;
  if (q === "box") return runBoxCases(world, set, calls);
  if (q === "position") return runPositionCases(world, set, calls);
  return runRayCases(world, set, calls);
}

export interface CategoryResult {
  readonly category: BenchCategory;
  readonly calls: number;
  readonly nsPerOp: number;
  /** GC events that started inside this category's timed loop. */
  readonly gcs: number;
  /** BVH nodes and brushes tested per call, and the share of traces that hit or found solid. */
  readonly nodes: number;
  readonly brushes: number;
  readonly blocked: number;
}

export interface TraceBenchResult {
  readonly categories: readonly CategoryResult[];
  /** Weighted ns per box query over the categories with a weight (docs/10 §4.4). */
  readonly boxAverageNs: number;
  readonly gcs: number;
  readonly sink: number;
}

/** docs/10 §4.4: traceBox on movement_lab ≤ 1 µs average. */
export const TRACE_BUDGET_NS = 1000;

/** Untimed pass: what each case costs the BVH and how often it is blocked. */
function profile(world: CollisionWorld, set: CaseSet): [number, number, number] {
  let nodes = 0;
  let brushes = 0;
  let blocked = 0;
  const n = set.hull.length;
  for (let i = 0; i < n; i++) {
    s0.set(set.start.subarray(3 * i, 3 * i + 3));
    e0.set(set.end.subarray(3 * i, 3 * i + 3));
    const maxs = maxsOf(set.hull[i] as number);
    if (set.category.query === "position") {
      if (!positionTest(world, s0, HULL_MINS, maxs, MASK_PLAYERSOLID)) blocked++;
    } else {
      if (set.category.query === "ray") traceRay(world, s0, e0, MASK_SOLID, tr);
      else traceBox(world, s0, e0, HULL_MINS, maxs, MASK_PLAYERSOLID, tr);
      if (tr.fraction < 1 || tr.startSolid) blocked++;
    }
    nodes += lastQueryNodes();
    brushes += lastQueryBrushes();
  }
  return [nodes / n, brushes / n, blocked / n];
}

/** Warm-up runs in this many short rounds per category (see runTraceBench). */
export const WARMUP_ROUNDS = 100;

/** Calls per category in warm-up round `round`; the rounds add up to exactly `warmup`. */
export function warmupCalls(warmup: number, round: number): number {
  const chunk = Math.floor(warmup / WARMUP_ROUNDS);
  return chunk + (round < warmup - chunk * WARMUP_ROUNDS ? 1 : 0);
}

/** How many of the event `times` fall inside [t0, t1]. */
export function countIn(times: readonly number[], t0: number, t1: number): number {
  let n = 0;
  for (const t of times) if (t >= t0 && t <= t1) n++;
  return n;
}

/** ns per query over the weighted categories: the docs/10 §4.4 average. */
export function weightedAverageNs(categories: readonly CategoryResult[]): number {
  let weighted = 0;
  let weights = 0;
  for (const c of categories) {
    weighted += c.category.weight * c.nsPerOp;
    weights += c.category.weight;
  }
  return weighted / weights;
}

export function meetsBudget(averageNs: number): boolean {
  return averageNs <= TRACE_BUDGET_NS;
}

/** What `--strict` fails on: a missed budget, or any GC in the timed loops. */
export function strictFailure(result: TraceBenchResult): boolean {
  return !meetsBudget(result.boxAverageNs) || result.gcs > 0;
}

/**
 * Warms every category up with `warmup` calls, then times `calls` per category. The warm-up is
 * many short calls round robin, so the JIT has seen every category and has optimized the loops
 * as whole functions before the clock runs: a loop only ever optimized on-stack (OSR) can keep
 * its doubles boxed and allocate per call, which the queries themselves never do. A GC during a
 * timed loop means the queries allocate (docs/10: none in hot paths).
 */
export async function runTraceBench(
  workload: TraceWorkload,
  calls = 1_000_000,
  warmup = 100_000,
): Promise<TraceBenchResult> {
  const world = workload.world;
  const gcTimes: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) gcTimes.push(entry.startTime);
  });
  observer.observe({ entryTypes: ["gc"] });
  let sink = 0;
  const windows: [number, number][] = [];
  const nanos: bigint[] = [];
  try {
    for (let r = 0; r < WARMUP_ROUNDS; r++) {
      const n = warmupCalls(warmup, r);
      for (const set of workload.sets) sink += runCases(world, set, n);
    }
    // Let a collection the setup and warm-up started finish before the clock runs.
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const set of workload.sets) {
      const t0 = performance.now();
      const h0 = process.hrtime.bigint();
      sink += runCases(world, set, calls);
      const h1 = process.hrtime.bigint();
      windows.push([t0, performance.now()]);
      nanos.push(h1 - h0);
    }
    // GC entries are delivered asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    observer.disconnect();
  }
  const categories: CategoryResult[] = [];
  let gcs = 0;
  for (let k = 0; k < workload.sets.length; k++) {
    const set = workload.sets[k] as CaseSet;
    const [t0, t1] = windows[k] as [number, number];
    const gcCount = countIn(gcTimes, t0, t1);
    gcs += gcCount;
    const nsPerOp = Number(nanos[k] as bigint) / calls;
    const [nodes, brushes, blocked] = profile(world, set);
    categories.push({
      category: set.category,
      calls,
      nsPerOp,
      gcs: gcCount,
      nodes,
      brushes,
      blocked,
    });
  }
  return { categories, boxAverageNs: weightedAverageNs(categories), gcs, sink };
}

function pad(text: string, width: number, right = false): string {
  return right ? text.padStart(width) : text.padEnd(width);
}

/** The report `pnpm bench` prints. */
export function formatTraceBench(result: TraceBenchResult, world: CollisionWorld): string {
  const lines = [
    `traceBox on movement_lab: ${world.brushCount} brushes, ${world.planeCount} planes, ${world.bvh.nodeCount.length} BVH nodes`,
    "",
    `${pad("category", 10)}${pad("query", 10)}${pad("calls", 10, true)}${pad("ns/op", 10, true)}${pad("weight", 8, true)}${pad("nodes", 8, true)}${pad("brushes", 9, true)}${pad("blocked", 9, true)}${pad("GCs", 5, true)}  cases`,
  ];
  for (const c of result.categories) {
    lines.push(
      `${pad(c.category.name, 10)}${pad(c.category.query, 10)}${pad(String(c.calls), 10, true)}${pad(c.nsPerOp.toFixed(1), 10, true)}${pad(String(c.category.weight), 8, true)}${pad(c.nodes.toFixed(1), 8, true)}${pad(c.brushes.toFixed(1), 9, true)}${pad(`${(100 * c.blocked).toFixed(0)}%`, 9, true)}${pad(String(c.gcs), 5, true)}  ${c.category.what}`,
    );
  }
  const pass = meetsBudget(result.boxAverageNs);
  lines.push(
    "",
    `box-trace average (weighted): ${result.boxAverageNs.toFixed(1)} ns/op, budget ${TRACE_BUDGET_NS} ns: ${pass ? "PASS" : "FAIL"}`,
    `GCs during timed loops: ${result.gcs} (expect 0)`,
    `sink: ${result.sink}`,
  );
  return lines.join("\n");
}
