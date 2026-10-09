import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aggregate,
  type BotNumbers,
  type BotsSummary,
  evaluateChecks,
  reportStamp,
  type SummaryConfig,
  type SummaryServer,
  summaryMarkdown,
  summaryPasses,
} from "../../src/bots/summary";

// The bots summary (M3 design §2.15, §6 increment 6 "summary golden"): the aggregate over the bots
// that joined, PASS/FAIL against docs/10 §4, the prediction's health (D-036) and smooth remotes
// (NET-05 violations, D-037), and the markdown, pinned by a golden file.

const config: SummaryConfig = {
  count: 2,
  profile: "wan-100-loss1",
  minutes: 2,
  map: "arena_greybox",
  match: "main",
  server: "child (dist)",
  seed: 1,
  human: false,
  buildHash: "abc1234",
  maxClients: 32,
};

const server: SummaryServer = {
  source: "--metrics-out",
  runS: 112.5,
  beforeBotsS: 0,
  players: 2,
  tickUs: { p50: 410, p95: 700, p99: 1210, max: 3300 },
  gc: { count: 40, maxMs: 2.5 },
  memoryMB: { heapUsed: 14.25, external: 4.5, rss: 95, peakHeapExternal: 21.5, peakRss: 101 },
  cpuMsPerWallS: 120,
  droppedTicks: 0,
  starved: 3,
  fullSnapshots: 13500,
  snapshots: 13650,
  deferredSnapshots: 120,
  deferredEntities: 2900,
  maxStaleness: 2,
  snapshotOverflow: 0,
  strikes: 0,
  kicks: 0,
  kbOutPerS: 6.1,
  kbInPerS: 7.3,
};

function bot(id: number, over: Partial<BotNumbers> = {}): BotNumbers {
  return {
    id,
    behaviour: id % 5 < 3 ? "route" : "walk",
    joined: true,
    closed: null,
    seconds: 120,
    snapshots: 7150,
    snapshotsLost: 70,
    correctionsPerS: 0.025,
    meanCorrection: 0.4,
    maxCorrection: 1.2,
    mispredictions: 0,
    starved: 2,
    hardResyncs: 0,
    teleports: 1,
    strikes: 0,
    bufferMean: 1.8,
    bufferLow: 0,
    kbDownPerS: 3.05,
    kbDownPeak: 3.2,
    kbUpPerS: 3.65,
    snapshotBytes: { p50: 63, p95: 63, max: 63 },
    deltaShare: 0,
    interpDelay: { mean: 3.5, max: 4 },
    extrapolatedShare: 0.0025,
    remoteJumps: 0,
    remoteJudged: 7000,
    laps: id % 5 < 3 ? 6 : null,
    stuckShare: id % 5 < 3 ? 0.01 : null,
    ...over,
  };
}

function summary(bots: BotNumbers[], srv: SummaryServer | null = server): BotsSummary {
  const agg = aggregate(bots);
  const checks = evaluateChecks(config, srv, agg);
  return {
    startedAt: "2026-10-09T01:02:03.456Z",
    config,
    host: {
      cpus: 4,
      loadAvg1Start: 0.25,
      loadAvg1End: 1.5,
      node: "22.22.0",
      platform: "linux-x64",
    },
    server: srv,
    aggregate: agg,
    bots,
    checks,
    pass: summaryPasses(checks),
  };
}

describe("bots summary", () => {
  it("aggregates means and worsts over the bots that joined", () => {
    const agg = aggregate([
      bot(0, { meanCorrection: 1.5, snapshotBytes: { p50: 70, p95: 90, max: 95 } }),
      bot(1, {
        correctionsPerS: 0.1,
        kbDownPerS: 4,
        kbDownPeak: 5,
        bufferLow: -1,
        maxCorrection: 3.5,
        mispredictions: 2,
        snapshotBytes: { p50: 80, p95: 85, max: 99 },
        interpDelay: { mean: 4.5, max: 6 },
        extrapolatedShare: 0.01,
        remoteJumps: 3,
        remoteJudged: 6000,
      }),
      bot(2, { joined: false, closed: "kicked: server full", kbDownPerS: 99, maxCorrection: 50 }),
    ]);
    expect(agg).toMatchObject({
      joined: 2,
      closed: 1,
      correctionsPerS: { mean: 0.063, max: 0.1 },
      // The worst bot's, not the mean.
      meanCorrection: 1.5,
      maxCorrection: 3.5,
      snapshotBytes: { p50: 80, p95: 90, max: 99 },
      kbDownPerS: { mean: 3.525, max: 4 },
      kbDownPeak: 5,
      bufferLow: -1,
      starved: 4,
      mispredictions: 2,
      interpDelay: { mean: 4, max: 6 },
      extrapolatedShare: 0.01,
      remoteJumps: 3,
      remoteJudged: 13000,
    });
  });

  const failing = (bots: BotNumbers[], srv: SummaryServer | null = server) =>
    summary(bots, srv)
      .checks.filter((c) => !c.pass)
      .map((c) => c.name);

  it("passes the docs/10 §4 budgets, and fails each one it misses", () => {
    expect(summary([bot(0), bot(1)]).pass).toBe(true);
    expect(failing([bot(0)])).toEqual(["bots joined and stayed"]);
    expect(failing([bot(0), bot(1, { closed: "timed out" })])).toEqual(["bots joined and stayed"]);
    expect(
      failing([bot(0), bot(1)], { ...server, tickUs: { ...server.tickUs, p50: 1501 } }),
    ).toEqual(["server tick p50"]);
    expect(
      failing([bot(0), bot(1)], { ...server, tickUs: { ...server.tickUs, p99: 4001 } }),
    ).toEqual(["server tick p99"]);
    expect(failing([bot(0), bot(1)], { ...server, gc: { count: 1, maxMs: 8.001 } })).toEqual([
      "server GC pause max",
    ]);
    // The window's peak is judged, not the sample at the end.
    expect(
      failing([bot(0), bot(1)], {
        ...server,
        memoryMB: { ...server.memoryMB, peakHeapExternal: 150.1 },
      }),
    ).toEqual(["server memory (peak heapUsed + external)"]);
    expect(
      failing([bot(0), bot(1)], {
        ...server,
        memoryMB: { ...server.memoryMB, heapUsed: 140, external: 11 },
      }),
    ).toEqual([]);
    expect(
      failing([bot(0), bot(1, { kbDownPerS: 32.5, kbDownPeak: 48.5, kbUpPerS: 8.1 })]),
    ).toEqual(["down per client (average)", "down per client (peak 1 s)", "up per client"]);
    expect(
      failing([bot(0), bot(1, { snapshotBytes: { p50: 900, p95: 1000, max: 1101 } })]),
    ).toEqual(["snapshot size"]);
    expect(failing([bot(0), bot(1)], null)).toEqual(["server metrics"]);
  });

  it("passes each budget at its boundary", () => {
    const edge: SummaryServer = {
      ...server,
      tickUs: { p50: 1500, p95: 3000, p99: 4000, max: 9000 },
      gc: { count: 1, maxMs: 8 },
      memoryMB: { ...server.memoryMB, peakHeapExternal: 150 },
    };
    const bots = [
      bot(0, { kbDownPerS: 32, kbDownPeak: 48, kbUpPerS: 8 }),
      bot(1, { snapshotBytes: { p50: 900, p95: 1000, max: 1100 } }),
    ];
    expect(failing(bots, edge)).toEqual([]);
  });

  it("fails a strike on either side, a correction the server's starve does not explain, and a remote jump", () => {
    expect(failing([bot(0), bot(1)], { ...server, strikes: 1 })).toEqual(["server strikes"]);
    expect(failing([bot(0), bot(1, { strikes: 2 })])).toEqual(["bot strikes"]);
    expect(failing([bot(0), bot(1, { mispredictions: 1 })])).toEqual([
      "mispredictions (corrections not on a starved snapshot)",
    ]);
    expect(failing([bot(0), bot(1, { remoteJumps: 1 })])).toEqual([
      "remote jumps (NET-05 violations)",
    ]);
  });

  it("reports, but does not judge, the server numbers of a window that began before the bots", () => {
    const early: SummaryServer = {
      ...server,
      beforeBotsS: 600,
      tickUs: { ...server.tickUs, p99: 9000 },
      strikes: 0,
    };
    const s = summary([bot(0), bot(1)], early);
    const p99 = s.checks.find((c) => c.name === "server tick p99");
    expect(p99).toMatchObject({ pass: false, judged: false });
    expect(s.pass).toBe(true);
    expect(s.checks.filter((c) => !c.judged).map((c) => c.name)).toEqual([
      "server tick p50",
      "server tick p99",
      "server GC pause max",
      "server memory (peak heapUsed + external)",
    ]);
    expect(summaryMarkdown(s)).toContain(
      "| server tick p99 | ≤ 4 ms | 9.000 ms | FAIL (not judged) |",
    );
    // Server strikes count the bots' window (end minus start), so they stay judged.
    expect(summary([bot(0), bot(1)], { ...early, strikes: 1 }).pass).toBe(false);
  });

  it("names why the server numbers are missing", () => {
    const agg = aggregate([bot(0), bot(1)]);
    const why = "the server child exited (code 1) during the run";
    expect(evaluateChecks(config, null, agg, why)[1]).toEqual({
      name: "server metrics",
      target: "read",
      value: why,
      pass: false,
      judged: true,
    });
  });

  it("renders the markdown the golden file pins", () => {
    const md = summaryMarkdown(summary([bot(0), bot(3, { closed: "timed out" })]));
    const golden = readFileSync(new URL("./fixtures/summary.golden.md", import.meta.url), "utf8");
    expect(md).toBe(golden);
  });

  it("names its files by a stamp every file system takes", () => {
    expect(reportStamp("2026-10-09T01:02:03.456Z")).toBe("2026-10-09T01-02-03Z");
  });
});
