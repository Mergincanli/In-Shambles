import {
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  Mulberry32,
  positionTest,
  quantizeOrigin,
  SNAP_CORNER,
  SNAP_PREVIOUS,
  SNAP_ROUNDED,
  snapOrigin,
  TICK_DT,
  TraceResult,
  traceBox,
  type Vec3,
  vec3,
} from "@game/shared";
import { normalize } from "./cases";
import { f64Hex } from "./properties";
import type { FuzzWorld } from "./worlds";

/**
 * P7 (M1 design A.9, G): a box pressed against or sliding along a sloped or rotated plane, traced
 * and snapped every tick for 200 ticks, never starts a trace solid. Plain rounding fails this
 * within tens of ticks; the D-017 snap must not. Every snap is also compared with the rules
 * written out independently (expectedSnap). The chains almost never reach rule 2 (a clear trace
 * stop always has a clear corner unless the free space is narrower than a grid cell), so direct
 * probes at exact points on both sides of each face, deep inside included, cover it.
 */

export const CHAIN_STEPS = 200;

/** Direct snapOrigin probes per face and hull, at exact points on both sides of the face. */
export const SNAP_PROBES = 8;

export interface ChainStats {
  /** The run seed, for failure reports. */
  readonly seed: number;
  chains: number;
  /** Face and hull pairs without a clear start (the face is buried under other brushes). */
  skipped: number;
  steps: number;
  /** snapOrigin outcomes in the chains: SNAP_ROUNDED, SNAP_CORNER, SNAP_PREVIOUS. */
  readonly rules: [number, number, number];
  /** The same for the direct probes, which also reach SNAP_PREVIOUS. */
  readonly probeRules: [number, number, number];
  readonly failures: string[];
}

export function newChainStats(seed: number): ChainStats {
  return {
    seed,
    chains: 0,
    skipped: 0,
    steps: 0,
    rules: [0, 0, 0],
    probeRules: [0, 0, 0],
    failures: [],
  };
}

const HULLS: readonly (readonly [string, Vec3, Vec3])[] = [
  ["standing", HULL_MINS, HULL_STANDING_MAXS],
  ["crouched", HULL_MINS, HULL_CROUCHED_MAXS],
];

const tr = new TraceResult();
const expected = vec3();
const corner = vec3();
const cornerDist = new Float64Array(8);

function isAxial(nx: number, ny: number, nz: number): boolean {
  return Math.abs(nx) === 1 || Math.abs(ny) === 1 || Math.abs(nz) === 1;
}

/** Every non-axis-aligned face plane of the world, as [brush, face]. */
export function slopedFaces(fw: FuzzWorld): [number, number][] {
  const out: [number, number][] = [];
  for (const b of fw.brushes) {
    if ((b.contents & MASK_PLAYERSOLID) === 0) continue;
    for (let f = 0; f < b.faces.length / 4; f++) {
      const o = 4 * f;
      if (!isAxial(b.faces[o] as number, b.faces[o + 1] as number, b.faces[o + 2] as number)) {
        out.push([b.index, f]);
      }
    }
  }
  return out;
}

/**
 * D-017's rules written out again, independently of snapOrigin: the rounded point if clear, else
 * the clear cell corners nearest first (ties by corner bits, repeats skipped), else prevOrigin.
 * Writes the expected origin to `out` and returns the rule. Fuzz worlds stay inside ORIGIN_LIMIT,
 * so snapOrigin's clamp never applies here.
 */
export function expectedSnap(
  world: FuzzWorld["world"],
  exact: Vec3,
  mins: Vec3,
  maxs: Vec3,
  prev: Vec3,
  out: Vec3,
): number {
  for (let k = 0; k < 3; k++) out[k] = quantizeOrigin(exact[k] as number);
  if (positionTest(world, out, mins, maxs, MASK_PLAYERSOLID)) return SNAP_ROUNDED;
  const rx = out[0];
  const ry = out[1];
  const rz = out[2];
  const order: number[] = [];
  for (let c = 0; c < 8; c++) {
    let d = 0;
    let repeat = false;
    for (let k = 0; k < 3; k++) {
      const x = exact[k] as number;
      const lo = Math.floor(x * 32) / 32 + 0;
      const hi = Math.ceil(x * 32) / 32 + 0;
      const up = (c & (1 << k)) !== 0;
      if (up && lo === hi) repeat = true;
      d += up ? (hi - x) * (hi - x) : (x - lo) * (x - lo);
    }
    cornerDist[c] = d;
    if (!repeat) order.push(c);
  }
  order.sort((a, b) => (cornerDist[a] as number) - (cornerDist[b] as number) || a - b);
  for (const c of order) {
    for (let k = 0; k < 3; k++) {
      const x = exact[k] as number;
      corner[k] = (c & (1 << k)) !== 0 ? Math.ceil(x * 32) / 32 + 0 : Math.floor(x * 32) / 32 + 0;
    }
    if (corner[0] === rx && corner[1] === ry && corner[2] === rz) continue;
    if (positionTest(world, corner, mins, maxs, MASK_PLAYERSOLID)) {
      out.set(corner);
      return SNAP_CORNER;
    }
  }
  out.set(prev);
  return SNAP_PREVIOUS;
}

function vecText(v: Vec3): string {
  return `["${f64Hex(v[0])}", "${f64Hex(v[1])}", "${f64Hex(v[2])}"], // ${v[0]}, ${v[1]}, ${v[2]}`;
}

/** A P7 failure with every input needed to replay it: snapOrigin(exact, prev), then the trace. */
function chainFailure(
  stats: ChainStats,
  detail: string,
  fw: FuzzWorld,
  chainSeed: number,
  hull: string,
  step: number,
  vectors: readonly (readonly [string, Vec3])[],
): string {
  const lines = [
    "{",
    `  property: "P7", // ${detail}`,
    `  seed: 0x${(stats.seed >>> 0).toString(16)},`,
    `  chainSeed: 0x${(chainSeed >>> 0).toString(16)},`,
    `  world: "${fw.name}",`,
    `  hull: "${hull}",`,
    `  step: ${step},`,
  ];
  for (const [name, v] of vectors) lines.push(`  ${name}: ${vecText(v)}`);
  lines.push("},");
  return lines.join("\n");
}

/**
 * Runs one chain per hull on face f of brush b, folding outcomes into `stats`. Every snap is also
 * checked against expectedSnap, so a wrong rule shows even where it stays clear.
 */
export function runChains(
  fw: FuzzWorld,
  brush: number,
  face: number,
  seed: number,
  stats: ChainStats,
): void {
  const rng = new Mulberry32(seed);
  const b = fw.brushes[brush];
  if (b === undefined) return;
  const n = vec3(
    b.faces[4 * face] as number,
    b.faces[4 * face + 1] as number,
    b.faces[4 * face + 2] as number,
  );
  const poly = b.polygons[face] as Uint32Array;
  const v = b.vertices;
  const world = fw.world;
  const cur = vec3();
  const next = vec3();
  const vel = vec3();
  const tmp = vec3();
  const exact = vec3();
  const prev = vec3();
  for (const [hull, mins, maxs] of HULLS) {
    let ext = 0;
    for (let k = 0; k < 3; k++) ext += Math.abs(n[k] as number) * ((maxs[k] - mins[k]) * 0.5);
    // A random point of the face (or its centroid) at expanded distance `dist`.
    const facePoint = (centroid: boolean, dist: number, out: Vec3): void => {
      tmp.fill(0);
      let total = 0;
      for (let i = 0; i < poly.length; i++) {
        const w = centroid ? 1 : rng.nextFloat();
        total += w;
        for (let k = 0; k < 3; k++)
          tmp[k] = (tmp[k] as number) + w * (v[3 * (poly[i] as number) + k] as number);
      }
      for (let k = 0; k < 3; k++) {
        out[k] =
          (tmp[k] as number) / total + (n[k] as number) * (ext + dist) - (mins[k] + maxs[k]) * 0.5;
      }
    };
    const checkSnap = (rule: number, step: number, probe: boolean): boolean => {
      const want = expectedSnap(world, exact, mins, maxs, prev, expected);
      if (
        rule === want &&
        cur[0] === expected[0] &&
        cur[1] === expected[1] &&
        cur[2] === expected[2]
      )
        return true;
      stats.failures.push(
        chainFailure(
          stats,
          `snapOrigin rule ${rule}, expected rule ${want}${probe ? " (probe)" : ""}`,
          fw,
          seed,
          hull,
          step,
          [
            ["exact", exact],
            ["prev", prev],
            ["origin", cur],
            ["expected", expected],
          ],
        ),
      );
      return false;
    };

    // Direct probes on both sides of the face, deep inside included, so every rule fires.
    for (let i = 0; i < SNAP_PROBES; i++) {
      facePoint(false, (rng.nextFloat() * 2 - 1) * 0.125, exact);
      for (let k = 0; k < 3; k++) {
        prev[k] = quantizeOrigin((exact[k] as number) + (rng.nextFloat() * 2 - 1) * 4);
      }
      const rule = snapOrigin(world, exact, mins, maxs, MASK_PLAYERSOLID, prev, cur);
      stats.probeRules[rule as 0 | 1 | 2]++;
      if (!checkSnap(rule, -1 - i, true)) break;
    }

    // A clear start 4 u off a random point of the face, then pressed onto it.
    let found = false;
    for (let attempt = 0; attempt < 12 && !found; attempt++) {
      facePoint(attempt === 0, 4, cur);
      for (let k = 0; k < 3; k++) cur[k] = quantizeOrigin(cur[k] as number);
      found = positionTest(world, cur, mins, maxs, MASK_PLAYERSOLID);
    }
    if (!found) {
      stats.skipped++;
      continue;
    }
    for (let k = 0; k < 3; k++) next[k] = (cur[k] as number) - 8 * (n[k] as number);
    traceBox(world, cur, next, mins, maxs, MASK_PLAYERSOLID, tr);
    exact.set(tr.endpos);
    prev.set(cur);
    snapOrigin(world, exact, mins, maxs, MASK_PLAYERSOLID, prev, cur);
    stats.chains++;
    const press = rng.nextFloat() < 0.5 ? 10 + 50 * rng.nextFloat() : 0;
    for (let step = 0; step < CHAIN_STEPS; step++) {
      if (step % 25 === 0 || tr.fraction < 1) {
        // A new tangential velocity, 0–400 u/s, plus an optional press into the plane.
        let len = 0;
        while (len < 1e-3) {
          const rx = rng.nextFloat() * 2 - 1;
          const ry = rng.nextFloat() * 2 - 1;
          const rz = rng.nextFloat() * 2 - 1;
          vel[0] = (n[1] as number) * rz - (n[2] as number) * ry;
          vel[1] = (n[2] as number) * rx - (n[0] as number) * rz;
          vel[2] = (n[0] as number) * ry - (n[1] as number) * rx;
          len = normalize(vel);
        }
        const speed = 400 * rng.nextFloat();
        for (let k = 0; k < 3; k++) vel[k] = (vel[k] as number) * speed - press * (n[k] as number);
      }
      for (let k = 0; k < 3; k++) next[k] = (cur[k] as number) + (vel[k] as number) * TICK_DT;
      traceBox(world, cur, next, mins, maxs, MASK_PLAYERSOLID, tr);
      stats.steps++;
      if (tr.startSolid) {
        stats.failures.push(
          chainFailure(stats, "the trace from origin starts solid", fw, seed, hull, step, [
            ["exact", exact],
            ["prev", prev],
            ["origin", cur],
            ["velocity", vel],
          ]),
        );
        break;
      }
      exact.set(tr.endpos);
      prev.set(cur);
      const rule = snapOrigin(world, exact, mins, maxs, MASK_PLAYERSOLID, prev, cur);
      stats.rules[rule as 0 | 1 | 2]++;
      if (!checkSnap(rule, step, false)) break;
    }
  }
}
