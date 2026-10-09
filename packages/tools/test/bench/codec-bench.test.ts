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

// Keeps the codec part of `pnpm bench` compiling and its workload honest; timings are not
// asserted (machine variance), only the cases, the round trips and the verdict logic.

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
