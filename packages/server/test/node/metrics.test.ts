import { describe, expect, it } from "vitest";
import { LoopStats } from "../../src/match/loop";
import { type Match, MatchMetrics } from "../../src/match/match";
import { TickHistogram } from "../../src/match/tickStats";
import { type PassClock, type ServerMatch, TimedPass } from "../../src/node/host";
import type { JsonLog, LogFields } from "../../src/node/log";
import { GcTracker, ServerMetrics } from "../../src/node/metrics";
import { WireTraffic } from "../../src/transport/wsTransport";

// The server's metrics (D-029, D-036, M3 design §2.14) on fake matches and clocks: the run window
// (since construction or resetRun: `--metrics-discard`, the console's `metrics reset`) for
// /metrics and --metrics-out, the interval window for the metrics lines, GC pauses, traffic as
// KB/s with KB = 1000 B.

interface FakeMatch {
  readonly metrics: MatchMetrics;
  mapName: string;
  sessionCount: number;
  serverTick: number;
  tick(): void;
}

function setup() {
  const clock = { ms: 0, cpuUs: 0 };
  const mem = { heapUsed: 10 * MB, external: 1 * MB, rss: 50 * MB };
  const passClock: PassClock = { now: () => clock.ms, cpuMicros: () => clock.ms * 500 };
  const fake: FakeMatch = {
    metrics: new MatchMetrics(),
    mapName: "arena_greybox",
    sessionCount: 3,
    serverTick: 0,
    tick() {
      this.serverTick++;
    },
  };
  const m: ServerMatch = {
    name: "main",
    match: fake as unknown as Match,
    ticks: new TickHistogram(),
    traffic: new WireTraffic(),
  };
  const pass = new TimedPass([m], () => {}, passClock);
  const loop = new LoopStats();
  pass.loopStats = loop;
  const lines: [string, LogFields | undefined][] = [];
  const log: JsonLog = (_lvl, ev, fields) => lines.push([ev, fields]);
  const metrics = new ServerMetrics(
    {
      matches: [m],
      pass,
      loop: () => loop,
      connections: () => 3,
      now: () => clock.ms,
      memory: () => ({ ...mem }),
      cpuMicros: () => clock.cpuUs,
    },
    log,
  );
  return { clock, mem, fake, m, pass, loop, lines, metrics };
}

const MB = 1024 * 1024;

/** Every counter a window subtracts, set to `k` times a distinct base. */
function setCounters(s: ReturnType<typeof setup>, k: number): void {
  const c = s.fake.metrics;
  c.starved = 2 * k;
  c.strikes = 3 * k;
  c.snapshots = 5 * k;
  c.fullSnapshots = 7 * k;
  c.kicks = 11 * k;
  s.loop.dropped = 13 * k;
  s.loop.yields = 17 * k;
  s.m.traffic.bytesIn = 1000 * k;
  s.m.traffic.bytesOut = 3000 * k;
}

describe("ServerMetrics", () => {
  it("reports the run window: tick times, counters, GC, memory and traffic in KB/s", () => {
    const { clock, fake, m, pass, loop, metrics } = setup();
    fake.metrics.starved = 2;
    m.traffic.bytesOut = 5000;
    metrics.resetRun();
    for (let i = 0; i < 120; i++) pass.tick();
    clock.ms = 2000;
    fake.metrics.starved = 7;
    fake.metrics.snapshots = 360;
    fake.metrics.fullSnapshots = 360;
    fake.metrics.kicks = 1;
    m.traffic.bytesOut = 5000 + 60_000;
    m.traffic.bytesIn = 8000;
    loop.dropped = 4;
    metrics.gc.record(1.25);
    metrics.gc.record(3.5);
    const j = metrics.json();
    expect(j.process).toMatchObject({
      uptimeS: 2,
      runS: 2,
      passes: 120,
      droppedTicks: 4,
      tickUs: { count: 120 },
      gc: { count: 2, maxMs: 3.5, totalMs: 4.75 },
      memoryMB: { heapUsed: 10, external: 1, rss: 50, peakHeapExternal: 11, peakRss: 50 },
      connections: 3,
      traffic: { bytesIn: 8000, bytesOut: 60_000, kbInPerS: 4, kbOutPerS: 30 },
    });
    expect(j.matches.main).toMatchObject({
      map: "arena_greybox",
      players: 3,
      serverTick: 120,
      tickUs: { count: 120 },
      starved: 5,
      snapshots: 360,
      fullSnapshots: 360,
      kicks: 1,
      traffic: { bytesIn: 8000, bytesOut: 60_000, kbInPerS: 4, kbOutPerS: 30 },
    });
  });

  it("counts every counter from its own window's start, in the run window and each interval", () => {
    const s = setup();
    const { clock, pass, lines, metrics } = s;
    // The interval starts at 1× every base, the run window at 2×; both end at 4×.
    setCounters(s, 1);
    for (let i = 0; i < 60; i++) pass.tick();
    clock.ms = 1000;
    metrics.logInterval();
    setCounters(s, 2);
    for (let i = 0; i < 60; i++) pass.tick();
    clock.ms = 2000;
    metrics.resetRun();
    setCounters(s, 4);
    for (let i = 0; i < 30; i++) pass.tick();
    clock.ms = 3000;
    const j = metrics.json();
    expect(j.process).toMatchObject({
      passes: 30,
      droppedTicks: 26,
      loopYields: 34,
      traffic: { bytesIn: 2000, bytesOut: 6000 },
    });
    expect(j.matches.main).toMatchObject({
      starved: 4,
      strikes: 6,
      snapshots: 10,
      fullSnapshots: 14,
      kicks: 22,
      traffic: { bytesIn: 2000, bytesOut: 6000 },
    });
    // The second interval line (2 s from 1×), match then process.
    metrics.logInterval();
    expect(lines[2]?.[1]).toMatchObject({
      s: 2,
      starved: 6,
      strikes: 9,
      fullSnapshots: 21,
      kicks: 33,
      kbInPerS: 1.5,
      kbOutPerS: 4.5,
    });
    expect(lines[3]?.[1]).toMatchObject({ droppedTicks: 39, kbInPerS: 1.5, kbOutPerS: 4.5 });
  });

  it("reports CPU per wall second over each window, not the last second", () => {
    const { clock, pass, lines, metrics } = setup();
    // 9 s at 900 CPU-ms per wall second, then an idle second.
    for (let i = 1; i <= 10; i++) {
      for (let k = 0; k < 60; k++) pass.tick();
      clock.ms = i * 1000;
      if (i <= 9) clock.cpuUs += 900_000;
    }
    expect(metrics.json().process.cpuMsPerWallS).toBe(810);
    metrics.logInterval();
    expect(lines[1]?.[1]).toMatchObject({ cpuMsPerWallS: 810 });
    clock.ms = 12_000;
    clock.cpuUs += 500_000;
    metrics.logInterval();
    expect(lines[3]?.[1]).toMatchObject({ cpuMsPerWallS: 250 });
    metrics.resetRun();
    clock.ms = 14_000;
    clock.cpuUs += 200_000;
    expect(metrics.json().process.cpuMsPerWallS).toBe(100);
  });

  it("keeps each window's memory peak from the 1 s samples, beside the current sample", () => {
    const { mem, lines, metrics } = setup();
    mem.heapUsed = 120 * MB;
    mem.rss = 200 * MB;
    metrics.sampleMemory();
    mem.heapUsed = 20 * MB;
    mem.rss = 60 * MB;
    metrics.logInterval();
    expect(lines[1]?.[1]).toMatchObject({
      memoryMB: { heapUsed: 20, rss: 60, peakHeapExternal: 121, peakRss: 200 },
    });
    // The interval's peak starts again; the run window's stays.
    metrics.logInterval();
    expect(lines[3]?.[1]).toMatchObject({ memoryMB: { peakHeapExternal: 21, peakRss: 60 } });
    expect(metrics.json().process.memoryMB).toMatchObject({
      heapUsed: 20,
      peakHeapExternal: 121,
      peakRss: 200,
    });
    metrics.resetRun();
    expect(metrics.json().process.memoryMB).toMatchObject({ peakHeapExternal: 21, peakRss: 60 });
  });

  it("starts the run window again on resetRun, for the process and every match", () => {
    const { clock, fake, m, pass, loop, metrics } = setup();
    for (let i = 0; i < 60; i++) pass.tick();
    fake.metrics.strikes = 3;
    loop.dropped = 2;
    metrics.gc.record(9);
    clock.ms = 10_000;
    metrics.resetRun();
    clock.ms = 11_000;
    pass.tick();
    const j = metrics.json();
    expect(j.process).toMatchObject({ runS: 1, uptimeS: 11, droppedTicks: 0, passes: 1 });
    expect(j.process.tickUs.count).toBe(1);
    expect(j.process.gc).toEqual({ count: 0, maxMs: 0, totalMs: 0 });
    expect(j.matches.main).toMatchObject({ strikes: 0, tickUs: { count: 1 } });
    expect(m.ticks.run.count).toBe(1);
  });

  it("logs one metrics line per match and one for the process per interval, then starts the next", () => {
    const { clock, fake, m, pass, lines, metrics } = setup();
    for (let i = 0; i < 600; i++) pass.tick();
    clock.ms = 10_000;
    fake.metrics.fullSnapshots = 30;
    m.traffic.bytesIn = 30_000;
    m.traffic.bytesOut = 270_000;
    metrics.gc.record(2);
    metrics.logInterval();
    expect(lines.map(([ev, f]) => [ev, f?.match])).toEqual([
      ["metrics", "main"],
      ["metrics", undefined],
    ]);
    expect(lines[0]?.[1]).toMatchObject({
      s: 10,
      players: 3,
      tickUs: { count: 600 },
      fullSnapshots: 30,
      kbInPerS: 3,
      kbOutPerS: 27,
    });
    expect(lines[1]?.[1]).toMatchObject({
      s: 10,
      tickUs: { count: 600 },
      gc: { count: 1, maxMs: 2 },
      memoryMB: { heapUsed: 10, external: 1, rss: 50 },
      connections: 3,
      kbInPerS: 3,
      kbOutPerS: 27,
    });
    // The next interval counts from here; the run window goes on.
    clock.ms = 20_000;
    pass.tick();
    metrics.logInterval();
    expect(lines[2]?.[1]).toMatchObject({ s: 10, tickUs: { count: 1 }, kbOutPerS: 0 });
    expect(lines[3]?.[1]).toMatchObject({ gc: { count: 0, maxMs: 0 } });
    expect(metrics.json().process.tickUs.count).toBe(601);
  });
});

describe("GcTracker", () => {
  it("observes the process's GC pauses", async () => {
    const gc = new GcTracker();
    gc.start();
    try {
      // Enough short-lived garbage for a young-generation GC or two.
      let keep = 0;
      for (let i = 0; i < 2e5; i++) keep += new Array(16).fill(i).length;
      expect(keep).toBeGreaterThan(0);
      for (let i = 0; i < 20 && gc.run.count === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(gc.run.count).toBeGreaterThan(0);
      expect(gc.run.maxMs).toBeGreaterThan(0);
      expect(gc.interval.count).toBe(gc.run.count);
    } finally {
      gc.stop();
    }
  });
});
