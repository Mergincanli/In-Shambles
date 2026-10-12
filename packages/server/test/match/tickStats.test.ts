import { Mulberry32 } from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  TICK_HIST_BUCKET_US,
  TICK_HIST_BUCKETS,
  TickHistogram,
  TickWindow,
} from "../../src/match/tickStats";

/** Nearest-rank percentile of `sorted` (ascending). */
function reference(sorted: number[], percent: number): number {
  const rank = Math.max(1, Math.ceil((sorted.length * percent) / 100));
  return sorted[rank - 1] as number;
}

describe("TickWindow", () => {
  it.each([1, 2, 3])("matches a reference sort within one bucket (seed %i)", (seed) => {
    const rng = new Mulberry32(seed);
    const w = new TickWindow();
    const samples: number[] = [];
    for (let i = 0; i < 5000; i++) {
      // Mostly short ticks, a tail of long ones and a few past the 20.48 ms overflow edge.
      const r = rng.nextFloat();
      const us = Math.floor(r < 0.9 ? r * 200 : r < 0.995 ? r * 8000 : 20000 + r * 30000);
      samples.push(us);
      w.record(us);
    }
    samples.sort((a, b) => a - b);
    expect(w.count).toBe(5000);
    expect(w.maxUs).toBe(samples.at(-1));
    for (const p of [1, 50, 90, 95, 99, 100]) {
      const exact = reference(samples, p);
      const got = w.percentileUs(p);
      expect(got, `p${p}`).toBeGreaterThanOrEqual(exact);
      expect(got, `p${p}`).toBeLessThanOrEqual(exact + TICK_HIST_BUCKET_US);
      expect(got, `p${p}`).toBeLessThanOrEqual(w.maxUs);
    }
  });

  it("reports the exact maximum for a percentile in the overflow bucket", () => {
    const w = new TickWindow();
    const overflow = TICK_HIST_BUCKETS * TICK_HIST_BUCKET_US;
    w.record(5);
    w.record(overflow + 1234);
    w.record(overflow + 99);
    expect(w.percentileUs(50)).toBe(overflow + 1234);
    expect(w.percentileUs(34)).toBe(overflow + 1234);
    // Below it, the bucket's upper edge.
    expect(w.percentileUs(33)).toBe(TICK_HIST_BUCKET_US);
  });

  it("is 0 when empty; truncates, clamps and ignores NaN", () => {
    const w = new TickWindow();
    expect(w.percentileUs(99)).toBe(0);
    w.record(12.9);
    expect(w.maxUs).toBe(12);
    w.record(-5);
    w.record(Number.NaN);
    w.record(1e12);
    expect(w.count).toBe(4);
    expect(w.maxUs).toBe(0x7fffffff);
    expect(w.percentileUs(50)).toBe(TICK_HIST_BUCKET_US);
    w.reset();
    expect([w.count, w.maxUs, w.percentileUs(50)]).toEqual([0, 0, 0]);
  });
});

describe("TickHistogram", () => {
  it("keeps the last closed second and a run window until reset", () => {
    const h = new TickHistogram();
    for (let i = 0; i < 60; i++) h.record(100 + i);
    h.endSecond();
    expect([h.lastP50Us, h.lastP99Us, h.lastMaxUs]).toEqual([130, 159, 159]);
    expect(h.second.count).toBe(0);
    h.record(7);
    h.endSecond();
    expect([h.lastP50Us, h.lastP99Us, h.lastMaxUs]).toEqual([7, 7, 7]);
    expect(h.run.count).toBe(61);
    expect(h.run.maxUs).toBe(159);
    h.resetRun();
    expect(h.run.count).toBe(0);
  });

  it("keeps the metrics line's interval window apart from the run window", () => {
    const h = new TickHistogram();
    for (let i = 0; i < 10; i++) h.record(50);
    h.resetInterval();
    h.record(400);
    expect([h.interval.count, h.interval.maxUs]).toEqual([1, 400]);
    expect([h.run.count, h.run.maxUs]).toEqual([11, 400]);
    h.resetRun();
    expect(h.interval.count).toBe(1);
  });

  it("keeps p50, p99 and max apart, each from its own rank", () => {
    const h = new TickHistogram();
    // 94 short ticks, 5 at 500 µs and one at 900 µs: p50 100, p95 500, p99 500, max 900.
    for (let i = 0; i < 94; i++) h.record(100);
    for (let i = 0; i < 5; i++) h.record(500);
    h.record(900);
    h.endSecond();
    expect([h.lastP50Us, h.lastP99Us, h.lastMaxUs]).toEqual([110, 510, 900]);
    // p95 lies in a lower bucket than p99 here, so neither stands in for the other.
    for (let i = 0; i < 94; i++) h.record(100);
    for (let i = 0; i < 4; i++) h.record(300);
    h.record(500);
    h.record(900);
    expect(h.second.percentileUs(95)).toBe(310);
    h.endSecond();
    expect([h.lastP50Us, h.lastP99Us, h.lastMaxUs]).toEqual([110, 510, 900]);
  });
});
