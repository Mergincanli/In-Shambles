import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../src/paths";
import { logMeasured } from "../src/scenarios/metrics";

// The pmove primer's guards (D-040, M3 design §2.11), in `pnpm test:long`.
//
// 1. No-retry multi-process guard (child: test/perf/primerAllocation.ts). The transient the primer
//    removes happens once per process, so each child runs a flat phase, then a flat window, one
//    first-stairs window and one first-ladder window, with no warm-up of the measured input and no
//    retry; the verdict is across processes. Primed (`primerServer`: a real Match and a loopback
//    client; `primerClient`: the ClientSim side, its match unprimed): at least 2 of 3 processes
//    with every window at 0 GCs and under 64 KB. Primer-off control: in every one of 3 processes
//    both late-branch windows grow the heap by more than 256 KB or run a GC, so the guard can see
//    what it guards against.
// 2. Coverage guard (child: test/perf/pmoveCoverage.ts): V8's precise block coverage of
//    `shared/src/sim/pmove/*`; the primer must reach every block the MV scenario mix reaches,
//    except the reviewed COVERAGE_ALLOWLIST below. It is the evidence that the primer covers the
//    late branches.

interface Window {
  gcs: number;
  growth: number;
}

interface GuardResult {
  mode: string;
  primer: boolean;
  /** pmovePrimed() once the rig was built. */
  primed: boolean;
  /** Flat, stairs, ladder. */
  windows: Window[];
  /** Per phase (flat, stairs, ladder): ticks on the ladder, rises of 8 u or more, peak z. */
  ladderTicks: number[];
  climbs: number[];
  peakZ: number[];
}

interface CoverageFunction {
  name: string;
  /** [start, end, count] per range, outermost first. */
  ranges: [number, number, number][];
}

interface CoverageResult {
  run: string;
  files: Record<string, { source: string; functions: CoverageFunction[] }>;
}

const CLEAN_BYTES = 64 * 1024;
const CONTROL_BYTES = 256 * 1024;
const PROCESSES = 3;

/**
 * Blocks the MV mix reaches that the primer need not: each entry is a pmove file and a function,
 * with the reason it is no late branch of a tick. Reviewed with D-040; the test fails when an
 * entry is no longer needed, so the list cannot rot.
 */
const COVERAGE_ALLOWLIST: readonly { file: string; fn: string; why: string }[] = [
  {
    file: "pmove",
    fn: "lastPmoveSnap",
    why: "an observer the tools' scenario runner and MV-19 probe read after a tick; no match or client calls it",
  },
];

const CHILDREN_AT_ONCE = 2;
const run = promisify(execFile);
let running = 0;
const waiting: (() => void)[] = [];

async function runChild<T>(args: readonly string[]): Promise<T> {
  if (running >= CHILDREN_AT_ONCE) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    const out = await run(process.execPath, args, {
      cwd: fromRoot("packages", "tools"),
      encoding: "utf8",
      maxBuffer: 16 << 20,
    });
    return JSON.parse(out.stdout) as T;
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function guard(mode: "server" | "client", primer: boolean): Promise<GuardResult> {
  const flag = primer ? "on" : "off";
  return runChild(["--expose-gc", "--import", "tsx", "test/perf/primerAllocation.ts", mode, flag]);
}

function clean(w: Window): boolean {
  return w.gcs === 0 && w.growth < CLEAN_BYTES;
}

/**
 * The control's window showed the transient: it grew the heap past CONTROL_BYTES, or it ran a GC.
 * Growth is measured after any GC in the window, which reclaims what the window allocated (the
 * first ladder's window always scavenges once, and its growth then ranged down to 88 KB), and a
 * young-generation GC needs a full semi-space of garbage, far more than CONTROL_BYTES: the mirror
 * of the primed bar, which already fails on any GC.
 */
function transient(w: Window): boolean {
  return w.gcs > 0 || w.growth > CONTROL_BYTES;
}

function describeRun(r: GuardResult): string {
  const w = r.windows.map((x) => `${x.gcs} GCs ${x.growth} B`).join(" / ");
  return `${r.mode} primer ${r.primer ? "on" : "off"}: flat / stairs / ladder ${w}`;
}

/** The windows met what they claim: the flat phase never the stairs or ladder; they did. */
function checkCourse(r: GuardResult): void {
  expect(r.ladderTicks[0]).toBe(0);
  expect(r.climbs[0]).toBe(0);
  expect(r.climbs[1]).toBeGreaterThan(100);
  expect(r.peakZ[1]).toBeGreaterThanOrEqual(128);
  expect(r.ladderTicks[2]).toBeGreaterThan(1000);
  expect(r.peakZ[2]).toBeGreaterThanOrEqual(384);
}

async function guardRuns(mode: "server" | "client") {
  const jobs: Promise<GuardResult>[] = [];
  for (let i = 0; i < PROCESSES; i++) jobs.push(guard(mode, true), guard(mode, false));
  const all = await Promise.all(jobs);
  return { primed: all.filter((r) => r.primer), control: all.filter((r) => !r.primer) };
}

function kb(rs: readonly GuardResult[], w: number): string {
  const v = rs.map((r) => (r.windows[w] as Window).growth / 1024);
  const gcs = rs.reduce((n, r) => n + (r.windows[w] as Window).gcs, 0);
  return `${Math.min(...v).toFixed(0)}–${Math.max(...v).toFixed(0)} KB, ${gcs} GCs`;
}

function judge(mode: string, runs: { primed: GuardResult[]; control: GuardResult[] }): void {
  const log = [...runs.primed, ...runs.control].map(describeRun).join("\n");
  logMeasured(
    "D-040",
    `${mode} flat / first stairs / first ladder windows, ${PROCESSES} processes each`,
    `primed ${kb(runs.primed, 0)} / ${kb(runs.primed, 1)} / ${kb(runs.primed, 2)}; primer off ${kb(runs.control, 0)} / ${kb(runs.control, 1)} / ${kb(runs.control, 2)}`,
    "primed under 64 KB and 0 GCs in ≥ 2 of 3; primer off above 256 KB or a GC in every one",
  );
  for (const r of [...runs.primed, ...runs.control]) checkCourse(r);
  for (const r of runs.primed) expect(r.primed, log).toBe(true);
  for (const r of runs.control) expect(r.primed, log).toBe(false);
  const passing = runs.primed.filter((r) => r.windows.every(clean)).length;
  expect(passing, log).toBeGreaterThanOrEqual(2);
  for (const r of runs.control) {
    expect(transient(r.windows[1] as Window), log).toBe(true);
    expect(transient(r.windows[2] as Window), log).toBe(true);
  }
  // The harness itself is clean: the control's flat windows too.
  expect(runs.control.filter((r) => clean(r.windows[0] as Window)).length, log).toBeGreaterThan(1);
}

/** The count V8 gives position `pos`: that of the innermost range holding it (0 outside all). */
function countAt(functions: readonly CoverageFunction[], pos: number): number {
  let best: [number, number, number] | null = null;
  for (const f of functions) {
    for (const r of f.ranges) {
      if (r[0] <= pos && pos < r[1] && (best === null || r[1] - r[0] < best[1] - best[0])) best = r;
    }
  }
  return best === null ? 0 : best[2];
}

/** The innermost function of `functions` whose outermost range holds `pos`, or null. */
function functionAt(functions: readonly CoverageFunction[], pos: number): CoverageFunction | null {
  let best: CoverageFunction | null = null;
  let size = Number.POSITIVE_INFINITY;
  for (const f of functions) {
    const r = f.ranges[0];
    if (r !== undefined && r[0] <= pos && pos < r[1] && r[1] - r[0] < size) {
      best = f;
      size = r[1] - r[0];
    }
  }
  return best;
}

interface CoverageCheck {
  /** "file.ts fn @pos: text" per block the mix reaches and the primer does not. */
  missed: string[];
  /** Blocks (range starts) the mix reaches. */
  reached: number;
  /** "file/fn" of the allowlist entries that excused a miss, sorted. */
  allowed: string[];
}

/**
 * Every block the mix reaches that the primer does not, outside the allowlist. The blocks are the
 * start positions of every range in either run: V8 leaves out a nested range whose count equals
 * its parent's, so a block the mix runs on every call of its function has no range of its own in
 * the mix, only (count 0) in a run that skips it.
 */
function coverageMisses(
  primer: CoverageResult,
  mix: CoverageResult,
  allowlist: readonly { file: string; fn: string }[],
): CoverageCheck {
  const missed: string[] = [];
  const allowed = new Set<string>();
  let reached = 0;
  for (const [file, m] of Object.entries(mix.files)) {
    // The primer's own module, and the scratch module's load-time initialisers.
    if (file === "primer" || file === "scratch") continue;
    const p = primer.files[file];
    if (p === undefined) continue;
    const starts = new Set<number>();
    for (const f of m.functions) for (const r of f.ranges) starts.add(r[0]);
    for (const f of p.functions) for (const r of f.ranges) starts.add(r[0]);
    for (const pos of [...starts].sort((a, b) => a - b)) {
      if (countAt(m.functions, pos) === 0) continue;
      reached++;
      if (countAt(p.functions, pos) > 0) continue;
      const name = functionAt(m.functions, pos)?.name ?? "?";
      const entry = allowlist.find((a) => a.file === file && a.fn === name);
      if (entry !== undefined) {
        allowed.add(`${entry.file}/${entry.fn}`);
        continue;
      }
      const text = m.source
        .slice(pos, pos + 72)
        .replace(/\s+/g, " ")
        .trim();
      missed.push(`${file}.ts ${name} @${pos}${text === "" ? "" : `: ${text}`}`);
    }
  }
  return { missed, reached, allowed: [...allowed].sort() };
}

describe("pmove primer (D-040): the late-branch guards", () => {
  it("primerServer: a primed Match meets the first stairs and ladder without GCs or garbage; the primer-off control does not", async () => {
    judge("primerServer", await guardRuns("server"));
  }, 180_000);

  it("primerClient: primed prediction meets the first stairs and ladder without GCs or garbage; the primer-off control does not", async () => {
    judge("primerClient", await guardRuns("client"));
  }, 180_000);

  it("the primer reaches every pmove block the MV scenario mix reaches (block coverage)", async () => {
    const args = ["--import", "tsx", "test/perf/pmoveCoverage.ts"];
    const [primer, mix] = await Promise.all([
      runChild<CoverageResult>([...args, "primer"]),
      runChild<CoverageResult>([...args, "mix"]),
    ]);
    for (const file of Object.keys(mix.files)) {
      if (file === "primer" || file === "scratch") continue;
      const p = primer.files[file];
      expect(p, `${file}.ts in the primer's run`).toBeDefined();
      // Both runs load the same transformed text, so the offsets compare.
      expect(
        p?.source === mix.files[file]?.source,
        `${file}.ts: the same source in both runs`,
      ).toBe(true);
    }
    const c = coverageMisses(primer, mix, COVERAGE_ALLOWLIST);
    logMeasured(
      "D-040",
      "pmove blocks the MV mix reaches that the primer misses",
      `${c.missed.length} of ${c.reached} (${c.allowed.length} allowlisted functions)`,
      "0, beside the allowlist",
    );
    // Not vacuous: the mix reaches pmove's blocks in every file.
    expect(c.reached).toBeGreaterThan(150);
    expect(c.missed, c.missed.join("\n")).toEqual([]);
    // Every allowlist entry is still needed.
    expect(c.allowed).toEqual(COVERAGE_ALLOWLIST.map((a) => `${a.file}/${a.fn}`).sort());
  }, 120_000);

  it("the coverage comparison sees a block the mix runs on every call and the primer skips", () => {
    // V8 leaves out a nested range whose count equals its parent's: in `function f(x) { if (x)
    // { … } }` called 10 times, the mix (x true every call) reports only [7, 88, 10], while the
    // primer (x false) reports the block's own range as [45, 74, 0]. Walking the mix's ranges
    // alone would pass; the primer's zero ranges show the miss.
    const run = (ranges: [number, number, number][]): CoverageResult => ({
      run: "",
      files: { walk: { source: " ".repeat(100), functions: [{ name: "f", ranges }] } },
    });
    const mixRun = run([[7, 88, 10]]);
    const primerRun = run([
      [7, 88, 10],
      [45, 74, 0],
    ]);
    expect(coverageMisses(primerRun, mixRun, []).missed).toEqual(["walk.ts f @45"]);
    expect(coverageMisses(mixRun, primerRun, []).missed).toEqual([]);
    expect(coverageMisses(primerRun, mixRun, [{ file: "walk", fn: "f" }])).toEqual({
      missed: [],
      reached: 2,
      allowed: ["walk/f"],
    });
  });
});
