import { spawnSync } from "node:child_process";
import { copyPlayerState, PlayerState, playerStateEquals, quantizePlayerState } from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  buildCodecWorkload,
  CODEC_CASES,
  type CodecBenchResult,
  CodecBenchState,
  codecStrictFailure,
  formatCodecBench,
  meetsCodecBudget,
  runCodecBench,
  runInputCodec,
  runSnapshotCodec,
} from "../../bench/codec.bench";
import { fromRoot } from "../../src/paths";

// Keeps the codec part of `pnpm bench` compiling and its workload honest; timings are not
// asserted (machine variance), only the cases, the round trips and the verdict logic.

const workload = buildCodecWorkload();

function fakeResult(nsPerSnapshot: number, gcs: number, failures = 0): CodecBenchResult {
  return {
    calls: 1,
    nsPerSnapshot,
    nsPerInput: 1,
    snapshotBytes: 42,
    inputBytes: 55,
    failures,
    gcs,
    sink: 0,
  };
}

describe("codec bench workload", () => {
  it("holds quantized states of moving players, as the match sends them", () => {
    expect(workload.snapshots.length).toBe(CODEC_CASES);
    expect(workload.inputs.length).toBe(CODEC_CASES);
    let moving = 0;
    const origins = new Set<number>();
    for (const m of workload.snapshots) {
      const s = m.state;
      const q = quantizePlayerState(copyPlayerState(new PlayerState(), s));
      expect(playerStateEquals(q, s)).toBe(true);
      if (Math.abs(s.velocity[0] as number) + Math.abs(s.velocity[1] as number) > 100) moving++;
      origins.add(s.origin[0] as number);
    }
    expect(moving / CODEC_CASES).toBeGreaterThan(0.5);
    expect(origins.size).toBeGreaterThan(CODEC_CASES / 2);
  });

  it("round-trips every case in 42 B snapshots and 55 B inputs", () => {
    const s = new CodecBenchState();
    runSnapshotCodec(workload, s, CODEC_CASES);
    runInputCodec(workload, s, CODEC_CASES);
    expect(s.failures).toBe(0);
    expect(s.snapshotBytes).toBe(42 * CODEC_CASES);
    expect(s.inputBytes).toBe(55 * CODEC_CASES);
  });

  it("times both loops and reports per round trip", async () => {
    const result = await runCodecBench(workload, 2000, 1000);
    expect(result.calls).toBe(2000);
    expect(result.failures).toBe(0);
    expect(result.nsPerSnapshot).toBeGreaterThan(0);
    expect(result.nsPerInput).toBeGreaterThan(0);
    expect(Number.isFinite(result.sink)).toBe(true);
  });
});

describe("codec bench verdict", () => {
  it("passes at the 30 µs budget and fails above it", () => {
    for (const [ns, verdict] of [
      [29_999, "PASS"],
      [30_000, "PASS"],
      [30_001, "FAIL"],
    ] as const) {
      expect(meetsCodecBudget(ns)).toBe(verdict === "PASS");
      const report = formatCodecBench(fakeResult(ns, 2));
      expect(report).toContain(
        `SNAPSHOT (42 B) encode+decode: ${ns.toFixed(1)} ns, budget 30000 ns: ${verdict}`,
      );
      expect(report).toContain("GCs during the codec loops: 2 (expect 0)");
    }
  });

  it("--strict fails on a missed budget, any GC or a failed round trip", () => {
    expect(codecStrictFailure(fakeResult(700, 0))).toBe(false);
    expect(codecStrictFailure(fakeResult(30_001, 0))).toBe(true);
    expect(codecStrictFailure(fakeResult(700, 1))).toBe(true);
    expect(codecStrictFailure(fakeResult(700, 0, 1))).toBe(true);
  });
});

describe("pnpm bench entry, codec part", () => {
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "bench/run.ts",
        "--calls",
        "1000",
        "--warmup",
        "0",
        "--pmove-ticks",
        "20",
        "--pmove-warmup",
        "0",
        ...args,
      ],
      { cwd: fromRoot("packages", "tools"), encoding: "utf8" },
    );

  it("prints the codec report after the pmove report, and exits 0", () => {
    const out = run("--codec-calls", "2000", "--codec-warmup", "1000");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/budget 5000 ns: (PASS|FAIL)[\s\S]*budget 30000 ns: (PASS|FAIL)/);
    expect(out.stdout).toMatch(/INPUT, 4 cmds \(55 B\) encode\+decode: [\d.]+ ns/);
    expect(out.stdout).toMatch(/failed round trips: 0/);
  }, 30_000);

  it("rejects bad codec counts with exit code 2", () => {
    expect(run("--codec-calls", "0").status).toBe(2);
    expect(run("--codec-warmup", "1.5").status).toBe(2);
  }, 30_000);
});
