import {
  boxContents,
  boxContentsBrute,
  type CollisionWorld,
  pointContents,
  positionContents,
  positionContentsBrute,
  TRACE_EPSILON,
  TraceResult,
  traceBox,
  traceBoxBrute,
  traceRay,
  type Vec3,
  vec3,
} from "@game/shared";
import type { FuzzCase } from "./cases";
import { type OracleBrush, separation } from "./oracle";
import type { FuzzWorld } from "./worlds";

/**
 * The trace properties P1–P6 (M1 design G) for one case, checked against the SAT oracle. τ
 * absorbs f64 rounding in the trace and the oracle (≈1e-12 at these coordinates). Bevels round
 * outward to an f32, so the runtime brush reaches up to one f32 step of the coordinate past its
 * vertices (OracleBrush.slop, ≈1e-4 u at 1000 u) and box-expanded planes call a box in that
 * sliver solid. Where the runtime may report contact beyond the true brush (P2, P3, P4) the bound
 * allows that brush's slop. P1 inherits it too: it excuses the brushes the runtime puts the start
 * inside, and by A.4 such a box may move straight through them, so a start in the sliver is not
 * checked against that brush. That start is unreachable in play (traces stop ε short of every
 * plane and snapOrigin only accepts positionTest-clear points), which is why it is allowed; P2
 * bounds the excused set to τ + slop and the run counts these starts.
 */

export const TAU = 1e-5;

/**
 * P4's stop window. On a hit every box-expanded plane of the hit brush is at most ε from the box
 * (A.3), but the oracle measures every axis on both sides, and a wedge's reversed slope normal is
 * not one of its faces: beyond the right-angle edge behind the slope it reads up to √2·ε where
 * the expanded planes read ε (a 1M-case run met 1.10·ε there). Design G's 2√3·ε + τ covers every
 * corner of three faces with room to spare. When the trace moved at all, the entering plane is
 * exactly ε away and is one of the oracle's axes, so the stop is also at least ε: a trace that
 * stops short of the skin or inside it fails.
 */
export const STOP_MAX = 2 * Math.sqrt(3) * TRACE_EPSILON + TAU;
export const STOP_MIN = TRACE_EPSILON - 1e-6;

export type TraceFn = (
  world: CollisionWorld,
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
  mask: number,
  out: TraceResult,
) => void;

export type Property = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7";

export interface CaseResult {
  /** [property, detail] per violation. */
  readonly failures: [Property, string][];
  /** Every result bit, for P6. */
  readonly digest: string;
  readonly startSolid: boolean;
  readonly allSolid: boolean;
  /** P4's precondition held: a hit without a solid start. */
  readonly hit: boolean;
  /** The runtime puts the start inside a brush the oracle does not (the bevel sliver, or 0). */
  readonly sliverStart: boolean;
}

export interface CheckOptions {
  /** The trace under test (default traceBox). */
  readonly trace?: TraceFn;
  /** Compare against the brute-force queries (P5). Off for mutated worlds without a valid BVH. */
  readonly bvh?: boolean;
}

const result = new TraceResult();
const brute = new TraceResult();
const ray = new TraceResult();
const again = new TraceResult();
const ZERO = vec3();
const qMin = vec3();
const qMax = vec3();

const view = new DataView(new ArrayBuffer(8));

/** The 16 hex digits of x's binary64 bits. */
export function f64Hex(x: number): string {
  view.setFloat64(0, x);
  return (
    view.getUint32(0).toString(16).padStart(8, "0") +
    view.getUint32(4).toString(16).padStart(8, "0")
  );
}

export function hexF64(hex: string): number {
  view.setUint32(0, Number.parseInt(hex.slice(0, 8), 16));
  view.setUint32(4, Number.parseInt(hex.slice(8, 16), 16));
  return view.getFloat64(0);
}

/** Every TraceResult field, doubles as bits. */
export function traceDigest(r: TraceResult): string {
  return [
    f64Hex(r.fraction),
    f64Hex(r.endpos[0]),
    f64Hex(r.endpos[1]),
    f64Hex(r.endpos[2]),
    f64Hex(r.normal[0]),
    f64Hex(r.normal[1]),
    f64Hex(r.normal[2]),
    f64Hex(r.planeDist),
    r.plane,
    r.brush,
    r.contents,
    r.surfaceFlags,
    r.entity,
    r.startSolid,
    r.allSolid,
  ].join(" ");
}

/**
 * Whether the trace treats the box at `s` as inside brush b: every box-expanded distance < 0,
 * the same expression clipBrush and positionTest use (M1 design A.2).
 */
export function runtimeInside(
  world: CollisionWorld,
  b: number,
  s: Vec3,
  mins: Vec3,
  maxs: Vec3,
): boolean {
  const sx = s[0] + (mins[0] + maxs[0]) * 0.5;
  const sy = s[1] + (mins[1] + maxs[1]) * 0.5;
  const sz = s[2] + (mins[2] + maxs[2]) * 0.5;
  const hx = (maxs[0] - mins[0]) * 0.5;
  const hy = (maxs[1] - mins[1]) * 0.5;
  const hz = (maxs[2] - mins[2]) * 0.5;
  const pl = world.planes;
  const first = world.brushPlaneStart[b] as number;
  const last = first + (world.brushPlaneCount[b] as number);
  for (let p = first; p < last; p++) {
    const o = 4 * p;
    const nx = pl[o] as number;
    const ny = pl[o + 1] as number;
    const nz = pl[o + 2] as number;
    const ext = Math.abs(nx) * hx + Math.abs(ny) * hy + Math.abs(nz) * hz;
    if (nx * sx + ny * sy + nz * sz - (pl[o + 3] as number) - ext >= 0) return false;
  }
  return true;
}

/** Whether brush b's runtime bounds come within 1 u of the query box (else every sep > 1). */
function near(world: CollisionWorld, b: number): boolean {
  const bb = world.brushBounds;
  for (let k = 0; k < 3; k++) {
    if ((bb[6 * b + k] as number) > qMax[k] + 1 || (bb[6 * b + k + 3] as number) < qMin[k] - 1) {
      return false;
    }
  }
  return true;
}

function fmt(x: number): string {
  return x.toPrecision(6);
}

export function checkCase(fw: FuzzWorld, c: FuzzCase, options: CheckOptions = {}): CaseResult {
  const trace = options.trace ?? traceBox;
  const bvh = options.bvh !== false;
  const failures: [Property, string][] = [];
  const fail = (p: Property, detail: string): void => {
    failures.push([p, detail]);
  };
  const world = fw.world;
  const { start, end, mins, maxs, mask } = c;
  trace(world, start, end, mins, maxs, mask, result);
  const r = result;
  const endpos = r.endpos;

  for (let k = 0; k < 3; k++) {
    qMin[k] = Math.min(start[k] as number, end[k] as number) + mins[k];
    qMax[k] = Math.max(start[k] as number, end[k] as number) + maxs[k];
  }
  let anyInside = false;
  let insideContents = 0;
  let sliverStart = false;
  let allSolidWitness = false;
  // Contents the oracle says pointContents / boxContents must and may report.
  let pointMust = 0;
  let pointMay = 0;
  let boxMust = 0;
  let boxMay = 0;
  for (let i = 0; i < fw.brushes.length; i++) {
    const b = fw.brushes[i] as OracleBrush;
    if (!near(world, i)) continue;
    const slack = TAU + b.slop;
    const sepPoint = separation(b, start, start, ZERO, ZERO);
    if (sepPoint < -TAU) pointMust |= b.contents;
    if (sepPoint < slack) pointMay |= b.contents;
    if (b.isBox) {
      // Exact for boxes: boxContents tests corners against axial planes, which does not round.
      if (overlapsExtent(b, qMin, qMax)) {
        boxMust |= b.contents;
        boxMay |= b.contents;
      }
    } else {
      const sepBox = separation(b, ZERO, ZERO, qMin, qMax);
      if (sepBox < -TAU) boxMust |= b.contents;
      if (sepBox < slack) boxMay |= b.contents;
    }
    if ((b.contents & mask) === 0) continue;
    const inside = runtimeInside(world, i, start, mins, maxs);
    const sepS = separation(b, start, start, mins, maxs);
    // P2, per brush in both directions; the aggregate is checked below.
    if (inside && !(sepS < slack)) fail("P2", `runtime inside brush ${i}, oracle sep ${fmt(sepS)}`);
    if (!inside && sepS < -TAU)
      fail("P2", `oracle inside brush ${i} by ${fmt(-sepS)}, runtime not`);
    if (inside) {
      anyInside = true;
      insideContents |= b.contents;
      if (sepS >= -TAU) sliverStart = true;
    }
    // P1: the swept part never enters a brush the start was not inside.
    if (!inside) {
      const sep = separation(b, start, endpos, mins, maxs);
      if (sep < -TAU) fail("P1", `sweep to endpos enters brush ${i} by ${fmt(-sep)}`);
    }
    // P3: allSolid needs one brush holding the box at both ends, and such a brush forces it.
    if (inside || sepS < -TAU) {
      const sepE = separation(b, end, end, mins, maxs);
      if (inside && sepE < slack) allSolidWitness = true;
      if (sepS < -TAU && sepE < -TAU && !r.allSolid) {
        fail("P3", `brush ${i} holds both ends (sep ${fmt(sepS)}, ${fmt(sepE)}), not allSolid`);
      }
    }
  }
  if (r.startSolid !== anyInside)
    fail("P2", `startSolid ${r.startSolid}, brushes inside ${anyInside}`);
  if (r.allSolid && r.fraction !== 0) fail("P3", `allSolid with fraction ${r.fraction}`);
  if (r.allSolid && !allSolidWitness) fail("P3", "allSolid, but no brush holds both ends");
  // Contents: the hit brush plus every brush the start is inside (A.5).
  const hitContents = r.brush >= 0 ? (world.brushContents[r.brush] as number) : 0;
  if (r.contents !== (insideContents | hitContents)) {
    fail("P2", `contents ${r.contents}, start brushes ${insideContents} + hit ${hitContents}`);
  }

  if (r.brush >= 0) {
    // A reported hit is one of the brush's planes and an entering one (A.3): sd ≥ 0, ed < sd, ed < ε.
    const first = world.brushPlaneStart[r.brush] as number;
    const p = r.plane;
    if (p < first || p >= first + (world.brushPlaneCount[r.brush] as number)) {
      fail("P4", `hit plane ${p} is not a plane of brush ${r.brush}`);
    } else {
      const sd = expandedDistance(world, p, start, mins, maxs);
      const ed = expandedDistance(world, p, end, mins, maxs);
      if (!(sd >= 0 && ed < sd && ed < TRACE_EPSILON)) {
        fail("P4", `hit plane ${p} is not entering: sd ${fmt(sd)}, ed ${fmt(ed)}`);
      }
    }
  }
  const hit = r.fraction < 1 && !r.startSolid;
  if (hit) {
    const b = fw.brushes[r.brush];
    if (b === undefined || (b.contents & mask) === 0) {
      fail("P4", `fraction ${r.fraction} without a masked hit brush (brush ${r.brush})`);
    } else {
      const sep = separation(b, endpos, endpos, mins, maxs);
      if (sep > STOP_MAX + b.slop) {
        fail("P4", `stopped ${fmt(sep)} from hit brush ${r.brush} (plane ${r.plane})`);
      }
      if (r.fraction > 0 && sep < STOP_MIN) {
        fail("P4", `stopped ${fmt(sep)} from hit brush ${r.brush}, inside the ε skin`);
      }
    }
  }

  // P6 also covers what makes bits differ between engines: no NaN, and no −0 from +0 inputs.
  const plusZeroInputs = !hasNegativeZero(start, end, mins, maxs);
  if (!cleanDouble(r.fraction, plusZeroInputs) || !cleanDouble(r.planeDist, plusZeroInputs)) {
    fail("P6", `fraction ${f64Hex(r.fraction)} or planeDist ${f64Hex(r.planeDist)} is NaN or −0`);
  }
  for (let k = 0; k < 3; k++) {
    if (!cleanDouble(endpos[k] as number, plusZeroInputs) || !cleanDouble(r.normal[k], true)) {
      fail("P6", `endpos or normal component ${k} is NaN or −0`);
    }
  }

  let digest = traceDigest(r);
  const pc = bvh
    ? positionContents(world, start, mins, maxs, mask)
    : positionContentsBrute(world, start, mins, maxs, mask);
  if (pc !== insideContents) fail("P2", `positionContents ${pc}, start brushes ${insideContents}`);
  const pt = bvh
    ? pointContents(world, start)
    : positionContentsBrute(world, start, ZERO, ZERO, -1);
  if ((pt & pointMust) !== pointMust || (pt & ~pointMay) !== 0) {
    fail("P2", `pointContents ${pt}, oracle needs ${pointMust} and allows ${pointMay}`);
  }
  const bc = bvh ? boxContents(world, qMin, qMax) : boxContentsBrute(world, qMin, qMax);
  if ((bc & boxMust) !== boxMust || (bc & ~boxMay) !== 0) {
    fail("P2", `boxContents ${bc}, oracle needs ${boxMust} and allows ${boxMay}`);
  }
  if (bvh) {
    traceBoxBrute(world, start, end, mins, maxs, mask, brute);
    const bruteDigest = traceDigest(brute);
    if (bruteDigest !== digest) fail("P5", `traceBox ${digest} ≠ traceBoxBrute ${bruteDigest}`);
    if (isRay(mins, maxs)) {
      traceRay(world, start, end, mask, ray);
      const rayDigest = traceDigest(ray);
      if (rayDigest !== digest) fail("P5", `traceRay ${rayDigest} ≠ traceBox ${digest}`);
    }
    const pcb = positionContentsBrute(world, start, mins, maxs, mask);
    if (pc !== pcb) fail("P5", `positionContents ${pc} ≠ brute ${pcb} at start`);
    const pe = positionContents(world, endpos, mins, maxs, mask);
    const peb = positionContentsBrute(world, endpos, mins, maxs, mask);
    if (pe !== peb) fail("P5", `positionContents ${pe} ≠ brute ${peb} at endpos`);
    const ptb = positionContentsBrute(world, start, ZERO, ZERO, -1);
    if (pt !== ptb) fail("P5", `pointContents ${pt} ≠ brute ${ptb}`);
    const bcb = boxContentsBrute(world, qMin, qMax);
    if (bc !== bcb) fail("P5", `boxContents ${bc} ≠ brute ${bcb}`);
    digest += ` ${pc} ${pe} ${pt} ${bc}`;
  }
  return {
    failures,
    digest,
    startSolid: r.startSolid,
    allSolid: r.allSolid,
    hit,
    sliverStart,
  };
}

/**
 * checkCase's digest for the default options (traceBox and the BVH queries) without the oracle,
 * for P6 replays: the same calls in the same order, into separate scratch.
 */
export function replayDigest(fw: FuzzWorld, c: FuzzCase): string {
  const world = fw.world;
  const { start, end, mins, maxs, mask } = c;
  traceBox(world, start, end, mins, maxs, mask, again);
  for (let k = 0; k < 3; k++) {
    qMin[k] = Math.min(start[k] as number, end[k] as number) + mins[k];
    qMax[k] = Math.max(start[k] as number, end[k] as number) + maxs[k];
  }
  const pc = positionContents(world, start, mins, maxs, mask);
  const pe = positionContents(world, again.endpos, mins, maxs, mask);
  const pt = pointContents(world, start);
  const bc = boxContents(world, qMin, qMax);
  return `${traceDigest(again)} ${pc} ${pe} ${pt} ${bc}`;
}

/** Whether the open box (lo, hi) overlaps the interior of b's vertex extent. */
function overlapsExtent(b: OracleBrush, lo: Vec3, hi: Vec3): boolean {
  const e = b.extent;
  for (let k = 0; k < 3; k++) {
    if (!((lo[k] as number) < (e[k + 3] as number) && (hi[k] as number) > (e[k] as number))) {
      return false;
    }
  }
  return true;
}

function isRay(mins: Vec3, maxs: Vec3): boolean {
  return (
    mins[0] === 0 &&
    mins[1] === 0 &&
    mins[2] === 0 &&
    maxs[0] === 0 &&
    maxs[1] === 0 &&
    maxs[2] === 0
  );
}

/** Plane p's box-expanded distance at origin s, as clipBrush computes it (A.2). */
function expandedDistance(
  world: CollisionWorld,
  p: number,
  s: Vec3,
  mins: Vec3,
  maxs: Vec3,
): number {
  const pl = world.planes;
  const o = 4 * p;
  const nx = pl[o] as number;
  const ny = pl[o + 1] as number;
  const nz = pl[o + 2] as number;
  const ext =
    Math.abs(nx) * ((maxs[0] - mins[0]) * 0.5) +
    Math.abs(ny) * ((maxs[1] - mins[1]) * 0.5) +
    Math.abs(nz) * ((maxs[2] - mins[2]) * 0.5);
  return (
    nx * (s[0] + (mins[0] + maxs[0]) * 0.5) +
    ny * (s[1] + (mins[1] + maxs[1]) * 0.5) +
    nz * (s[2] + (mins[2] + maxs[2]) * 0.5) -
    (pl[o + 3] as number) -
    ext
  );
}

function hasNegativeZero(...vs: Vec3[]): boolean {
  for (const v of vs) for (const x of v) if (Object.is(x, -0)) return true;
  return false;
}

function cleanDouble(x: number, noNegativeZero: boolean): boolean {
  return !Number.isNaN(x) && !(noNegativeZero && Object.is(x, -0));
}

function vecSource(v: Vec3): string {
  return `["${f64Hex(v[0])}", "${f64Hex(v[1])}", "${f64Hex(v[2])}"], // ${v[0]}, ${v[1]}, ${v[2]}`;
}

/** A failing case as a FuzzRegression literal for regressions.test.ts. */
export function formatFailure(
  property: Property,
  detail: string,
  seed: number,
  index: number,
  c: FuzzCase,
): string {
  return [
    "{",
    `  property: "${property}", // ${detail}`,
    `  seed: 0x${(seed >>> 0).toString(16)},`,
    `  caseIndex: ${index},`,
    `  world: "${c.world}",`,
    `  hull: "${c.hull}",`,
    `  start: ${vecSource(c.start)}`,
    `  end: ${vecSource(c.end)}`,
    `  mins: ${vecSource(c.mins)}`,
    `  maxs: ${vecSource(c.maxs)}`,
    `  mask: ${c.mask},`,
    "},",
  ].join("\n");
}

/** A regression case as formatFailure prints it. */
export interface FuzzRegression {
  readonly property: Property;
  readonly seed: number;
  readonly caseIndex: number;
  readonly world: string;
  readonly hull: string;
  readonly start: readonly [string, string, string];
  readonly end: readonly [string, string, string];
  readonly mins: readonly [string, string, string];
  readonly maxs: readonly [string, string, string];
  readonly mask: number;
}

function hexVec(v: readonly [string, string, string]): Vec3 {
  return vec3(hexF64(v[0]), hexF64(v[1]), hexF64(v[2]));
}

export function regressionCase(r: FuzzRegression): FuzzCase {
  return {
    world: r.world,
    hull: r.hull,
    start: hexVec(r.start),
    end: hexVec(r.end),
    mins: hexVec(r.mins),
    maxs: hexVec(r.maxs),
    mask: r.mask,
  };
}
