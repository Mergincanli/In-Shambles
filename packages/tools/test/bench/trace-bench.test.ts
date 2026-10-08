import { spawnSync } from "node:child_process";
import {
  type CollisionWorld,
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  MASK_SOLID,
  pointContents,
  positionTest,
  quantizeOrigin,
  TraceResult,
  traceBox,
  traceRay,
  vec3,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  BENCH_CATEGORIES,
  type BenchCategory,
  buildTraceWorkload,
  type CaseSet,
  type CategoryResult,
  countIn,
  DEFAULT_CASES,
  DEFAULT_SEED,
  formatTraceBench,
  GROUND_PROBE,
  loadMovementLab,
  MOVE_MAX,
  meetsBudget,
  RAY_MAX,
  RAY_MIN,
  runCases,
  runTraceBench,
  STEP,
  strictFailure,
  type TraceBenchResult,
  type TraceWorkload,
  WARMUP_ROUNDS,
  warmupCalls,
  weightedAverageNs,
} from "../../bench/trace.bench";
import { fromRoot } from "../../src/paths";

// Keeps `pnpm bench` compiling and its workload honest; timings are not asserted (machine
// variance), only the workload's shape, what the loops compute, and the verdict logic.

const world = loadMovementLab();
const small = buildTraceWorkload(world, DEFAULT_SEED, 256);
const full = buildTraceWorkload(world);

function set(w: TraceWorkload, name: string): CaseSet {
  const s = w.sets.find((c) => c.category.name === name);
  if (s === undefined) throw new Error(`no ${name} cases`);
  return s;
}

function maxsOf(s: CaseSet, i: number) {
  return s.hull[i] === 0 ? HULL_STANDING_MAXS : HULL_CROUCHED_MAXS;
}

function startOf(s: CaseSet, i: number) {
  return vec3(s.start[3 * i] as number, s.start[3 * i + 1] as number, s.start[3 * i + 2] as number);
}

function endOf(s: CaseSet, i: number) {
  return vec3(s.end[3 * i] as number, s.end[3 * i + 1] as number, s.end[3 * i + 2] as number);
}

/** Horizontal length and signed vertical change of case i. */
function delta(s: CaseSet, i: number): [number, number] {
  const a = startOf(s, i);
  const b = endOf(s, i);
  return [
    Math.hypot((b[0] as number) - (a[0] as number), (b[1] as number) - (a[1] as number)),
    (b[2] as number) - (a[2] as number),
  ];
}

function startsClear(s: CaseSet, i: number): boolean {
  if (s.category.query === "ray") return (pointContents(world, startOf(s, i)) & MASK_SOLID) === 0;
  return positionTest(world, startOf(s, i), HULL_MINS, maxsOf(s, i), MASK_PLAYERSOLID);
}

/** The sink a timed loop must return, from the queries called directly. */
function referenceSink(w: CollisionWorld, s: CaseSet, calls: number): number {
  const tr = new TraceResult();
  let sink = 0;
  for (let n = 0; n < calls; n++) {
    const i = n % s.hull.length;
    if (s.category.query === "position") {
      if (positionTest(w, startOf(s, i), HULL_MINS, maxsOf(s, i), MASK_PLAYERSOLID)) sink++;
    } else if (s.category.query === "ray") {
      traceRay(w, startOf(s, i), endOf(s, i), MASK_SOLID, tr);
      sink += tr.fraction;
    } else {
      traceBox(w, startOf(s, i), endOf(s, i), HULL_MINS, maxsOf(s, i), MASK_PLAYERSOLID, tr);
      sink += tr.fraction + (tr.endpos[2] as number) + (tr.startSolid ? 1 : 0);
    }
  }
  return sink;
}

function blockedShare(s: CaseSet, pick: (i: number) => boolean): number {
  const tr = new TraceResult();
  let picked = 0;
  let blocked = 0;
  for (let i = 0; i < s.hull.length; i++) {
    if (!pick(i)) continue;
    picked++;
    traceBox(world, startOf(s, i), endOf(s, i), HULL_MINS, maxsOf(s, i), MASK_PLAYERSOLID, tr);
    if (tr.fraction < 1) blocked++;
  }
  return blocked / picked;
}

function category(name: string): BenchCategory {
  const c = BENCH_CATEGORIES.find((k) => k.name === name);
  if (c === undefined) throw new Error(`no ${name} category`);
  return c;
}

function fakeResult(boxAverageNs: number, gcs: number): TraceBenchResult {
  return { categories: [], boxAverageNs, gcs, sink: 0 };
}

describe("trace bench workload", () => {
  it("has every category, with the box-trace weights on the box queries only", () => {
    expect(small.sets.map((s) => s.category.name)).toEqual(BENCH_CATEGORIES.map((c) => c.name));
    for (const c of BENCH_CATEGORIES) {
      expect(c.weight > 0, c.name).toBe(c.query !== "ray");
    }
  });

  it("is a pure function of world, seed and size", () => {
    const again = buildTraceWorkload(world, DEFAULT_SEED, 256);
    for (let k = 0; k < small.sets.length; k++) {
      const a = small.sets[k] as CaseSet;
      const b = again.sets[k] as CaseSet;
      expect(b.start).toEqual(a.start);
      expect(b.end).toEqual(a.end);
      expect(b.hull).toEqual(a.hull);
    }
    expect(buildTraceWorkload(world, 1, 256).sets[0]?.start).not.toEqual(small.sets[0]?.start);
  });

  it.each([DEFAULT_SEED, 1, 2])("starts every trace clear (seed %i, full size)", (seed) => {
    const w = seed === DEFAULT_SEED ? full : buildTraceWorkload(world, seed);
    for (const name of ["move", "ground", "step", "ray"]) {
      const s = set(w, name);
      let solid = 0;
      for (let i = 0; i < w.size; i++) if (!startsClear(s, i)) solid++;
      expect(solid, name).toBe(0);
    }
  });

  it("keeps pmove-sized moves, probes and steps", () => {
    const n = full.size;
    expect(n).toBe(DEFAULT_CASES);
    const move = set(full, "move");
    const ground = set(full, "ground");
    const step = set(full, "step");
    let longMoves = 0;
    let stepDowns = 0;
    for (let i = 0; i < n; i++) {
      const [moveXY, moveZ] = delta(move, i);
      expect(moveXY).toBeLessThanOrEqual(MOVE_MAX);
      expect(moveZ).toBeGreaterThanOrEqual(-6);
      expect(moveZ).toBeLessThanOrEqual(3);
      if (moveXY > MOVE_MAX / 2) longMoves++;
      expect(delta(ground, i)).toEqual([0, -GROUND_PROBE]);
      const [stepXY, stepZ] = delta(step, i);
      expect(stepXY).toBe(0);
      // Even cases step up by the full height, odd ones back down by what the step-up raised.
      if ((i & 1) === 0) expect(stepZ).toBe(STEP);
      else {
        expect(stepZ).toBeLessThanOrEqual(0);
        expect(stepZ).toBeGreaterThanOrEqual(-STEP);
        if (stepZ < 0) stepDowns++;
      }
      for (let k = 0; k < 3; k++) {
        const x = move.start[3 * i + k] as number;
        expect(quantizeOrigin(x)).toBe(x);
      }
    }
    expect(longMoves / n).toBeGreaterThan(0.3);
    expect(stepDowns / (n / 2)).toBeGreaterThan(0.9);
    expect(new Set(move.hull).size).toBe(2);
    expect(new Set(ground.hull).size).toBe(2);
  });

  it("starts moves against walls and some ground probes in the air", () => {
    // 60% of moves start at wall spots and are swept into or along the wall; open-ground level
    // moves are rarely blocked.
    const move = set(full, "move");
    expect(blockedShare(move, (i) => delta(move, i)[1] === 0)).toBeGreaterThan(0.35);
    // A fifth of the probes start above the ground and miss it.
    const ground = set(full, "ground");
    const onGround = blockedShare(ground, () => true);
    expect(onGround).toBeGreaterThan(0.6);
    expect(onGround).toBeLessThan(0.95);
  });

  it("casts long rays from the eye", () => {
    const rays = set(full, "ray");
    for (let i = 0; i < full.size; i++) {
      const a = startOf(rays, i);
      const b = endOf(rays, i);
      const len = Math.hypot(
        (b[0] as number) - (a[0] as number),
        (b[1] as number) - (a[1] as number),
        (b[2] as number) - (a[2] as number),
      );
      expect(len).toBeGreaterThanOrEqual(RAY_MIN - 1e-6);
      expect(len).toBeLessThanOrEqual(RAY_MAX + 1e-6);
    }
  });

  it("tests snap candidates beside surfaces: some touch or sink in, most are clear", () => {
    const s = set(small, "position");
    let solid = 0;
    for (let i = 0; i < small.size; i++) if (!startsClear(s, i)) solid++;
    expect(solid / small.size).toBeGreaterThan(0.05);
    expect(solid / small.size).toBeLessThan(0.6);
  });
});

describe("trace bench loops", () => {
  it.each(BENCH_CATEGORIES.map((c) => [c.name]))(
    "%s cycles every case with its hull and honours the call count",
    (name) => {
      const s = set(small, name);
      expect(runCases(world, s, small.size)).toBe(referenceSink(world, s, small.size));
      expect(runCases(world, s, 2 * small.size + 3)).toBe(
        referenceSink(world, s, 2 * small.size + 3),
      );
    },
  );

  it("times every category and averages only the weighted ones", async () => {
    const calls = 1000;
    const result = await runTraceBench(small, calls, 1000);
    expect(result.categories.map((c) => c.category.name)).toEqual(
      BENCH_CATEGORIES.map((c) => c.name),
    );
    let weighted = 0;
    let weights = 0;
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (const c of result.categories) {
      expect(c.calls).toBe(calls);
      // Per call, not per loop: a 1000-call loop takes far more than 50 µs.
      expect(c.nsPerOp).toBeGreaterThan(0);
      expect(c.nsPerOp).toBeLessThan(50_000);
      expect(c.nodes).toBeGreaterThan(0);
      if (c.category.weight > 0) {
        weighted += c.category.weight * c.nsPerOp;
        weights += c.category.weight;
        lo = Math.min(lo, c.nsPerOp);
        hi = Math.max(hi, c.nsPerOp);
      }
    }
    expect(result.boxAverageNs).toBeCloseTo(weighted / weights, 9);
    expect(result.boxAverageNs).toBeGreaterThanOrEqual(lo);
    expect(result.boxAverageNs).toBeLessThanOrEqual(hi);
    expect(result.categories[0]?.blocked).toBeGreaterThan(0.1);
    expect(Number.isFinite(result.sink)).toBe(true);
  });
});

describe("trace bench verdict", () => {
  it("weights the average and leaves rays out", () => {
    const row = (name: string, nsPerOp: number): CategoryResult => ({
      category: category(name),
      calls: 1,
      nsPerOp,
      gcs: 0,
      nodes: 0,
      brushes: 0,
      blocked: 0,
    });
    const rows = [row("move", 100), row("ground", 200), row("step", 300), row("position", 800)];
    expect(weightedAverageNs(rows)).toBe((3 * 100 + 2 * 200 + 2 * 300 + 800) / 8);
    expect(weightedAverageNs([...rows, row("ray", 1e9)])).toBe(weightedAverageNs(rows));
  });

  it("passes at the 1 µs budget and fails above it", () => {
    for (const [ns, verdict] of [
      [999, "PASS"],
      [1000, "PASS"],
      [1001, "FAIL"],
    ] as const) {
      expect(meetsBudget(ns)).toBe(verdict === "PASS");
      const report = formatTraceBench(fakeResult(ns, 3), world);
      expect(report).toContain(
        `box-trace average (weighted): ${ns.toFixed(1)} ns/op, budget 1000 ns: ${verdict}`,
      );
      expect(report).toContain("GCs during timed loops: 3 (expect 0)");
    }
  });

  it("--strict fails on a missed budget or any GC", () => {
    expect(strictFailure(fakeResult(500, 0))).toBe(false);
    expect(strictFailure(fakeResult(1000, 0))).toBe(false);
    expect(strictFailure(fakeResult(1001, 0))).toBe(true);
    expect(strictFailure(fakeResult(500, 1))).toBe(true);
  });

  it("counts only GCs inside the timed window", () => {
    const times = [0.5, 1, 1.5, 2, 2.5];
    expect(countIn(times, 1, 2)).toBe(3);
    expect(countIn(times, 2.6, 3)).toBe(0);
    expect(countIn([], 0, 1)).toBe(0);
  });

  it.each([0, 1, 99, 100, 150, 100_000, 100_037])("warms up with exactly %i calls", (warmup) => {
    let total = 0;
    for (let r = 0; r < WARMUP_ROUNDS; r++) total += warmupCalls(warmup, r);
    expect(total).toBe(warmup);
  });
});

describe("pnpm bench entry", () => {
  // Short pmove and codec parts: pmove-bench.test.ts and codec-bench.test.ts cover them.
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "bench/run.ts",
        "--pmove-ticks",
        "20",
        "--pmove-warmup",
        "0",
        "--codec-calls",
        "1000",
        "--codec-warmup",
        "0",
        ...args,
      ],
      { cwd: fromRoot("packages", "tools"), encoding: "utf8" },
    );

  it("prints the machine, the table and the verdict, and exits 0", () => {
    const out = run("--calls", "1000", "--warmup", "1000");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/^node v\d+\.\d+\.\d+, \S/);
    expect(out.stdout).toMatch(/budget 1000 ns: (PASS|FAIL)/);
    expect(out.stdout).toMatch(/GCs during timed loops: \d+/);
  }, 30_000);

  it("rejects bad counts with exit code 2", () => {
    expect(run("--calls", "0").status).toBe(2);
    expect(run("--warmup", "1.5").status).toBe(2);
  }, 30_000);
});
