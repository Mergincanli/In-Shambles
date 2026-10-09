import { describe, expect, it } from "vitest";
import {
  formatInterpBench,
  INTERP_REMOTES,
  type InterpBenchResult,
  InterpBenchState,
  interpStrictFailure,
  loadArena,
  runInterpFrames,
} from "../../bench/interp.bench";

// Keeps the interp part of `pnpm bench` compiling and its workload honest (M3 design §5 "interp
// frame"); timings are not asserted (machine variance), only the workload and the verdict logic.

const world = loadArena();

describe("interp bench workload", () => {
  it("draws 16 moving remotes on a clean stream, never past the newest snapshot", () => {
    const s = new InterpBenchState(world, 0);
    runInterpFrames(s, 2000);
    const v = s.interp.view;
    expect(v.count).toBe(INTERP_REMOTES);
    const xs = new Set<number>();
    for (let k = 1; k <= INTERP_REMOTES; k++) xs.add(Math.round(v.x[k * 3] as number));
    expect(xs.size).toBeGreaterThan(INTERP_REMOTES / 2);
    expect(s.stats.totals.some((x) => Number.isNaN(x))).toBe(false);
    expect(s.interp.mode.filter((m) => m >= 2).length).toBe(0);
  });

  it("extrapolates and holds every remote through the lossy case's gaps", () => {
    const s = new InterpBenchState(world, 12);
    let past = 0;
    for (let i = 0; i < 2000; i++) {
      runInterpFrames(s, 1);
      if (s.interp.mode[3] === 3) past++;
    }
    expect(past).toBeGreaterThan(0);
    expect(s.interp.view.count).toBe(INTERP_REMOTES);
  });
});

describe("interp bench verdict", () => {
  const result = (gcs: number): InterpBenchResult => ({
    frames: 1,
    cases: [{ name: "clean stream", nsPerFrame: 4321.25, drawn: 16, pastNewest: 0.0195, gcs }],
    sink: 0,
  });

  it("reports the frame time against the estimate; --strict fails only on a GC", () => {
    expect(formatInterpBench(result(0))).toContain(
      "clean stream: 4321.3 ns per frame (estimate 20000 ns, reported), 16.00 drawn, 1.95% extrapolated or held, 0 GCs (expect 0)",
    );
    expect(interpStrictFailure(result(0))).toBe(false);
    expect(interpStrictFailure(result(1))).toBe(true);
  });
});
