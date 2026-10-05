import { hash32, type TraceResult, traceBox, traceBoxBrute, type Vec3 } from "@game/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { CaseSampler, type FuzzCase } from "./cases";
import { checkCase, formatFailure, type Property, replayDigest } from "./properties";
import { CHAIN_STEPS, newChainStats, runChains, slopedFaces } from "./snapChains";
import {
  COURSE_NAMES,
  type FuzzWorld,
  loadFuzzWorld,
  syntheticWorldNames,
  withBevelsPushed,
  withoutBevels,
} from "./worlds";

// M1 acceptance (docs/09): random box sweeps never tunnel through brushes. M1 design G: seeded
// cases over the committed courses and synthetic worlds, every trace checked against the SAT
// oracle (P1–P4), the brute-force queries (P5) and a replay (P6), plus 200-tick snap chains on
// every sloped or rotated plane (P7). FUZZ_SEED and FUZZ_CASES override the defaults for long
// local runs; a failure prints the case as a FuzzRegression literal for regressions.test.ts.

const DEFAULT_SEED = 0x5eed0009;
const DEFAULT_CASES = 20000;

function envInt(name: string, fallback: number, min: number): number {
  const text = process.env[name];
  if (text === undefined || text === "") return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name}=${text} is not an integer >= ${min}`);
  }
  return value;
}

const SEED = envInt("FUZZ_SEED", DEFAULT_SEED, 0) >>> 0;
/** At least enough cases for the coverage shares to mean something. */
const CASES = envInt("FUZZ_CASES", DEFAULT_CASES, 1000);
/** More cases also get more synthetic worlds, and with them more snap chains. */
const SCALE = Math.max(1, CASES / DEFAULT_CASES);
const SYNTHETIC_WORLDS = Math.min(1000, Math.round(48 * SCALE));
/** At most this many failures per property are printed in full. */
const PRINT_LIMIT = 3;

const PROPERTIES: readonly Property[] = ["P1", "P2", "P3", "P4", "P5", "P6", "P7"];

interface Run {
  readonly courses: readonly FuzzWorld[];
  readonly synthetic: readonly FuzzWorld[];
  readonly failures: Map<Property, string[]>;
  readonly counts: Map<Property, number>;
  cases: number;
  startSolid: number;
  allSolid: number;
  hits: number;
  /** Starts the runtime puts inside a brush the oracle does not: P1 excuses that brush. */
  sliverStarts: number;
}

function newRun(courses: readonly FuzzWorld[], synthetic: readonly FuzzWorld[]): Run {
  return {
    courses,
    synthetic,
    failures: new Map(PROPERTIES.map((p) => [p, []])),
    counts: new Map(PROPERTIES.map((p) => [p, 0])),
    cases: 0,
    startSolid: 0,
    allSolid: 0,
    hits: 0,
    sliverStarts: 0,
  };
}

function record(run: Run, p: Property, text: string): void {
  const n = (run.counts.get(p) ?? 0) + 1;
  run.counts.set(p, n);
  if (n <= PRINT_LIMIT) {
    run.failures.get(p)?.push(text);
    process.stderr.write(`trace fuzz ${p} failure (seed 0x${SEED.toString(16)}):\n${text}\n`);
  }
}

function syntheticWorlds(seed: number, count: number): FuzzWorld[] {
  return syntheticWorldNames(seed, count).map(loadFuzzWorld);
}

function runCases(): Run {
  const courses = COURSE_NAMES.map(loadFuzzWorld);
  const run = newRun(courses, syntheticWorlds(SEED, SYNTHETIC_WORLDS));
  const sampler = new CaseSampler(SEED, courses, run.synthetic);
  // P6 replays every case right after the next one (the last one at the end), so the module
  // scratch and the BVH stack hold another case's state in between.
  let previous: FuzzCase | null = null;
  let previousDigest = "";
  const replay = (i: number): void => {
    if (previous === null) return;
    const again = replayDigest(loadFuzzWorld(previous.world), previous);
    if (again !== previousDigest) {
      record(run, "P6", formatFailure("P6", `${previousDigest} then ${again}`, SEED, i, previous));
    }
  };
  for (let i = 0; i < CASES; i++) {
    const c = sampler.next();
    const fw = loadFuzzWorld(c.world);
    const res = checkCase(fw, c);
    run.cases++;
    if (res.startSolid) run.startSolid++;
    if (res.allSolid) run.allSolid++;
    if (res.hit) run.hits++;
    if (res.sliverStart) run.sliverStarts++;
    for (const [p, detail] of res.failures) record(run, p, formatFailure(p, detail, SEED, i, c));
    replay(i - 1);
    previous = c;
    previousDigest = res.digest;
  }
  replay(CASES - 1);
  return run;
}

let run: Run;

describe("trace fuzz (M1 design G)", () => {
  beforeAll(
    () => {
      run = runCases();
      // Written past Vitest's console capture so the summary shows on passing runs too.
      process.stdout.write(
        `trace fuzz: seed 0x${SEED.toString(16)}, ${run.cases} cases over ` +
          `${run.courses.length} courses + ${run.synthetic.length} synthetic worlds; ` +
          `startSolid ${run.startSolid}, allSolid ${run.allSolid}, hits ${run.hits}, ` +
          `sliver starts ${run.sliverStarts}\n`,
      );
    },
    Math.max(60_000, CASES * 2),
  );

  const describeFailures = (p: Property): string =>
    `${run.counts.get(p)} ${p} failures; first ones:\n${(run.failures.get(p) ?? []).join("\n")}`;

  it.each([
    ["P1", "no sweep enters a brush its start was not inside"],
    ["P2", "startSolid, contents and the position queries agree with the oracle"],
    ["P3", "allSolid exactly when one brush holds both ends, and then fraction 0"],
    ["P4", "every hit is an entering plane, ε to 2√3·ε from the hit brush (no phantom hits)"],
    ["P5", "the BVH queries equal brute force bit for bit"],
    ["P6", "the same case gives the same bits"],
  ] as const)("%s: %s", (p, _what) => {
    expect(run.counts.get(p), describeFailures(p)).toBe(0);
  });

  it("the cases reach every rule: hits, solid starts and stuck boxes", () => {
    // P4's precondition must hold often or it proves little; P2 and P3 need solid starts.
    expect(run.hits / run.cases).toBeGreaterThan(0.2);
    expect(run.startSolid / run.cases).toBeGreaterThan(0.05);
    expect(run.allSolid / run.cases).toBeGreaterThan(0.02);
  });

  it(
    "P7: 200-tick trace + snap chains on sloped and rotated planes never start solid",
    () => {
      const stats = newChainStats(SEED);
      const worlds = [...run.courses, ...run.synthetic];
      for (let w = 0; w < worlds.length; w++) {
        const fw = worlds[w] as FuzzWorld;
        for (const [brush, face] of slopedFaces(fw)) {
          runChains(fw, brush, face, hash32(SEED, 0x77, w, brush * 64 + face), stats);
        }
      }
      const [rounded, corner, previous] = stats.rules;
      const [probeRounded, probeCorner, probePrevious] = stats.probeRules;
      process.stdout.write(
        `P7 snap chains: ${stats.chains} chains × ${CHAIN_STEPS} ticks (${stats.skipped} ` +
          `skipped without a clear start), snap rule 0 (rounded) ${rounded}, 1 (corner) ` +
          `${corner}, 2 (previous) ${previous}, startSolid or wrong rule ` +
          `${stats.failures.length}; direct probes: rules ${probeRounded} / ${probeCorner} / ` +
          `${probePrevious}\n`,
      );
      for (const f of stats.failures.slice(0, PRINT_LIMIT)) {
        process.stderr.write(`trace fuzz P7 failure (seed 0x${SEED.toString(16)}):\n${f}\n`);
      }
      expect(stats.failures, stats.failures.slice(0, PRINT_LIMIT).join("\n")).toEqual([]);
      // Every course plane and the synthetic ones together give a real sample, and the direct
      // probes reach every snap rule.
      expect(stats.chains).toBeGreaterThan(100);
      expect(stats.steps).toBe(stats.chains * CHAIN_STEPS);
      expect(stats.rules[1]).toBeGreaterThan(0);
      for (const n of stats.probeRules) expect(n).toBeGreaterThan(0);
    },
    Math.max(30_000, CASES),
  );
});

/** Runs `cases` cases of the default sampler with a mutated trace or world. */
function mutantFailures(
  cases: number,
  worldFor: (fw: FuzzWorld) => FuzzWorld,
  trace: (
    world: FuzzWorld["world"],
    start: Vec3,
    end: Vec3,
    mins: Vec3,
    maxs: Vec3,
    mask: number,
    out: TraceResult,
  ) => void,
): Map<Property, number> {
  const courses = COURSE_NAMES.map(loadFuzzWorld);
  const sampler = new CaseSampler(0xbad5eed, courses, syntheticWorlds(0xbad5eed, 24));
  const counts = new Map<Property, number>();
  for (let i = 0; i < cases; i++) {
    const c = sampler.next();
    const res = checkCase(worldFor(loadFuzzWorld(c.world)), c, { trace, bvh: false });
    for (const [p] of res.failures) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return counts;
}

describe("the fuzz properties catch broken traces", () => {
  it("P1 and P2 catch a trace that ignores every brush", () => {
    const counts = mutantFailures(
      2000,
      (fw) => fw,
      (_w, _s, end, _mi, _ma, _m, out) => {
        out.reset();
        out.endpos.set(end);
      },
    );
    expect(counts.get("P1") ?? 0).toBeGreaterThan(0);
    expect(counts.get("P2") ?? 0).toBeGreaterThan(0);
  });

  it("P1 catches a trace that stops ε past the surface instead of short of it", () => {
    const counts = mutantFailures(
      4000,
      (fw) => fw,
      (w, s, e, mi, ma, m, out) => {
        traceBox(w, s, e, mi, ma, m, out);
        if (out.fraction <= 0 || out.fraction >= 1 || out.startSolid) return;
        // Overshoot by 2ε along the motion.
        const dx = e[0] - s[0];
        const dy = e[1] - s[1];
        const dz = e[2] - s[2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const f = Math.min(1, out.fraction + (2 * 0.03125) / len);
        out.endpos[0] = s[0] + f * dx;
        out.endpos[1] = s[1] + f * dy;
        out.endpos[2] = s[2] + f * dz;
      },
    );
    expect(counts.get("P1") ?? 0).toBeGreaterThan(0);
  });

  it("P4 catches a trace that stops ε/2 short of the surface instead of ε", () => {
    const counts = mutantFailures(
      4000,
      (fw) => fw,
      (w, s, e, mi, ma, m, out) => {
        traceBox(w, s, e, mi, ma, m, out);
        if (out.fraction <= 0 || out.fraction >= 1 || out.startSolid) return;
        const dx = e[0] - s[0];
        const dy = e[1] - s[1];
        const dz = e[2] - s[2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const f = Math.min(1, out.fraction + (0.5 * 0.03125) / len);
        out.endpos[0] = s[0] + f * dx;
        out.endpos[1] = s[1] + f * dy;
        out.endpos[2] = s[2] + f * dz;
      },
    );
    expect(counts.get("P4") ?? 0).toBeGreaterThan(0);
  });

  it("P4 catches a world without bevels (phantom hits at sloped and rotated edges)", () => {
    const counts = mutantFailures(4000, withoutBevels, traceBoxBrute);
    expect(counts.get("P4") ?? 0).toBeGreaterThan(0);
  });

  it("P2 and P4 catch bevels 1/8 u too far out: the slop allowance does not follow them", () => {
    const pushed = new Map<string, FuzzWorld>();
    const counts = mutantFailures(
      4000,
      (fw) => {
        let m = pushed.get(fw.name);
        if (m === undefined) {
          m = withBevelsPushed(fw, 1 / 8);
          pushed.set(fw.name, m);
        }
        return m;
      },
      traceBoxBrute,
    );
    expect(counts.get("P2") ?? 0).toBeGreaterThan(0);
    expect(counts.get("P4") ?? 0).toBeGreaterThan(0);
  });
});
