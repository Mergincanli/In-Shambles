import {
  copyPlayerState,
  PlayerState,
  playerStateEquals,
  quantizePlayerState,
  type SnapshotHeader,
  slotToPlayerState,
  type WorldFrame,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  BASELINE_BACK_MAX,
  BASELINE_BACK_MIN,
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
import { PMOVE_PLAYERS } from "../../bench/pmove.bench";
import {
  BUILD_FRAMES,
  BUILD_PLAYERS_64,
  Build64World,
  type BuildBenchResult,
  BuildBenchState,
  build64StrictFailure,
  buildSnapshotBuildWorkload,
  buildStrictFailure,
  formatSnapshotBuild64Bench,
  formatSnapshotBuildBench,
  runSnapshotBuild,
  runSnapshotBuild64,
} from "../../bench/snapshotBuild.bench";

// Keeps the codec and snapshot build parts of `pnpm bench` compiling and their workloads honest
// (docs/10 §4.4; the snapshot build since M3 increment 9); timings are not asserted (machine
// variance), only the cases, the round trips and the verdict logic.

const workload = buildCodecWorkload();

function fakeResult(nsPerSnapshot: number, gcs: number, failures = 0): CodecBenchResult {
  return {
    calls: 1,
    nsPerSnapshot,
    nsPerInput: 1,
    snapshotBytes: 221,
    inputBytes: 55,
    failures,
    gcs,
    sink: 0,
  };
}

describe("codec bench workload", () => {
  it("holds 16-player frames of quantized, moving players, a delta per receiver", () => {
    expect(workload.headers.length).toBe(CODEC_CASES);
    expect(workload.inputs.length).toBe(CODEC_CASES);
    expect(workload.frames.length).toBe(BASELINE_BACK_MAX + CODEC_CASES / 16);
    const backs = new Set<number>();
    for (let c = 0; c < CODEC_CASES; c++) {
      const back = (workload.headers[c] as SnapshotHeader).baseBack;
      backs.add(back);
      expect((workload.frameOf[c] as number) - (workload.baseOf[c] as number)).toBe(back);
    }
    expect([...backs].sort((a, b) => a - b)).toEqual(
      Array.from(
        { length: BASELINE_BACK_MAX - BASELINE_BACK_MIN + 1 },
        (_, i) => i + BASELINE_BACK_MIN,
      ),
    );
    let moving = 0;
    const origins = new Set<number>();
    const ps = new PlayerState();
    for (let c = 0; c < CODEC_CASES; c++) {
      const f = workload.frames[workload.frameOf[c] as number] as WorldFrame;
      expect(f.presentCount).toBe(16);
      slotToPlayerState(f, workload.receiver[c] as number, ps);
      const q = quantizePlayerState(copyPlayerState(new PlayerState(), ps));
      expect(playerStateEquals(q, ps)).toBe(true);
      if (Math.abs(ps.velocity[0] as number) + Math.abs(ps.velocity[1] as number) > 100) moving++;
      origins.add(ps.origin[0] as number);
    }
    expect(new Set(workload.receiver).size).toBe(16);
    expect(moving / CODEC_CASES).toBeGreaterThan(0.5);
    expect(origins.size).toBeGreaterThan(CODEC_CASES / 2);
  });

  it("round-trips every case as a delta well under the 436 B full snapshot, and 55 B inputs", () => {
    const s = new CodecBenchState();
    runSnapshotCodec(workload, s, CODEC_CASES);
    runInputCodec(workload, s, CODEC_CASES);
    expect(s.failures).toBe(0);
    // A full one is 86 + 199 + 7 + 15 × 213 bits (436 B); the deltas of moving players at a
    // 6–10 tick baseline age come to about a third of that.
    const mean = s.snapshotBytes / CODEC_CASES;
    console.log(`codec bench: mean 16-player delta ${mean.toFixed(1)} B`);
    expect(mean).toBeGreaterThan(37);
    expect(mean).toBeLessThan(436 * 0.7);
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
        `SNAPSHOT, v2 delta of 16 players (221 B) encode+decode: ${ns.toFixed(1)} ns, budget 30000 ns: ${verdict}`,
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

const buildWorkload = buildSnapshotBuildWorkload();

describe("snapshot build bench workload", () => {
  it("builds every client's snapshot as a delta 6–10 ticks back once the acks flow", () => {
    expect(buildWorkload.frames).toHaveLength(BUILD_FRAMES);
    const s = new BuildBenchState();
    runSnapshotBuild(buildWorkload, s, 20);
    expect(s.failures).toBe(0);
    expect(s.snapshots).toBe(20 * PMOVE_PLAYERS);
    // The first ack arrives on the 7th tick (6 back from the newest sent).
    expect(s.deltas).toBeGreaterThan(10 * PMOVE_PLAYERS);
    const before = s.bytes / s.snapshots;
    const deltas = s.deltas;
    runSnapshotBuild(buildWorkload, s, 600);
    expect(s.failures).toBe(0);
    expect(s.deltas - deltas).toBe(600 * PMOVE_PLAYERS);
    for (const c of s.clients) {
      const back = s.tick - 1 - c.ackTick;
      expect(back).toBeGreaterThanOrEqual(6);
      expect(back).toBeLessThanOrEqual(11);
    }
    // Deltas of 16 moving players: well under a full snapshot (436 B), more than the first ticks'.
    const mean = s.bytes / s.snapshots;
    expect(mean).toBeLessThan(436);
    expect(mean).toBeLessThan(before);
  });
});

describe("64-player snapshot build bench workload (D-046)", () => {
  it("runs the scheduler for most snapshots: all within 1100 B, nobody left out twice in a row", () => {
    const s = new BuildBenchState(BUILD_PLAYERS_64);
    expect(s.clients.every((c) => c.mirror !== null)).toBe(true);
    runSnapshotBuild64(new Build64World(), s, 50, 0);
    expect(s.failures).toBe(0);
    // Ticks 1000–1049; slot 63 is away for ticks 1024–1031 (0–7 of every 128) and gets none.
    expect(s.snapshots).toBe(50 * BUILD_PLAYERS_64 - 8);
    expect(s.deferredSnapshots).toBeGreaterThan(s.snapshots / 2);
    expect(s.maxStaleness).toBe(2);
    expect(s.maxBytes).toBeLessThanOrEqual(1100);
  });
});

describe("snapshot build bench verdict", () => {
  const buildResult = (ns: number, gcs: number, failures = 0): BuildBenchResult => ({
    ticks: 1,
    nsPerBuild: ns,
    bytes: 230.4,
    deltaShare: 1,
    failures,
    gcs,
  });

  it("reports per client against the 50 µs budget; --strict fails on a miss, a GC or a failure", () => {
    expect(formatSnapshotBuildBench(buildResult(5896.21, 0))).toContain(
      "per client (230 B, 100.0% deltas): 5896.2 ns, budget 50000 ns: PASS (estimate 10000 ns)",
    );
    expect(formatSnapshotBuildBench(buildResult(60000, 0))).toContain("budget 50000 ns: FAIL");
    expect(buildStrictFailure(buildResult(5000, 0))).toBe(false);
    expect(buildStrictFailure(buildResult(60000, 0))).toBe(true);
    expect(buildStrictFailure(buildResult(5000, 1))).toBe(true);
    expect(buildStrictFailure(buildResult(5000, 0, 1))).toBe(true);
  });

  it("reports the 64-player case without a budget; --strict fails on a GC, a failure or staleness past 2", () => {
    const r = {
      ticks: 1,
      nsPerBuild: 38000.04,
      bytes: 1077.4,
      sizePassShare: 1,
      deferredShare: 0.9312,
      deferredPerSnapshot: 19.08,
      maxStaleness: 2,
      maxBytes: 1099,
      failures: 0,
      gcs: 0,
    };
    expect(formatSnapshotBuild64Bench(r)).toContain(
      "per client (1077 B, largest 1099 B): 38000.0 ns (reported); 100.0% size passes, 93.1% leaving players out (19.1 each), max staleness 2 (expect ≤ 2)",
    );
    expect(build64StrictFailure(r)).toBe(false);
    expect(build64StrictFailure({ ...r, gcs: 1 })).toBe(true);
    expect(build64StrictFailure({ ...r, failures: 1 })).toBe(true);
    expect(build64StrictFailure({ ...r, maxStaleness: 3 })).toBe(true);
  });
});
